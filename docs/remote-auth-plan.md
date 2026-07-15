# Remote-wire operator auth — plan

Status: SPEC. Implementer: clodex-hand, chunks reviewed + committed by clodex.

## Problem

RemoteServer (remote.js) has no operator authentication. Its trust model is
"trust is the tunnel" (remote.js:533): every `/api/*` endpoint — including
mutating ones (`/api/send`, `/api/kill/`, `/api/restart`) — and the SSE
transcript stream serve anyone who can reach the port. That was sound when
the only reachable path was loopback + an SSH tunnel. It is no longer true:

- The container image sets `CLODEX_REMOTE_HOST=0.0.0.0` (remote-wiring.js:62),
  so inside a container the wire binds all interfaces. Any process that can
  route to the container port — another container via the Docker host
  gateway, any pod in the same cluster — reaches the API directly.
- Edge auth (an authenticating reverse proxy in front of the port) only
  guards the proxy's own path. A direct port hit skips it. This was
  demonstrated in practice (authorized red-team, 2026-07): an unauthenticated
  cross-container `POST /api/send` injected a message impersonating the
  operator.

The web frontend (web-host.js) already has an optional token gate
(`CLODEX_WEB_TOKEN`). remote.js has token machinery only for per-session
control LEASES (`/api/control/` mints single-holder tokens) — that arbitrates
concurrency among already-trusted callers and is NOT an identity gate.

## Design

### 1. Shared primitive: `auth-token.js` (new pure leaf)

Extract web-host's predicate into one module both hosts use:

- `makeTokenGate(token)` → `{ check(provided), fromReq(req) }`.
- `check`: no token configured → behavior decided by the caller (web-host
  keeps localhost-trust; remote applies the fail-closed rule below).
  Comparison via `crypto.timingSafeEqual` over equal-length buffers
  (length mismatch → false, no early-exit compare). Fixes web-host's
  current `===` compare too.
- `fromReq`: `?token=` query param, else `Authorization: Bearer`, else a
  `clodex_remote_token` cookie (see §3). Same precedence for both hosts;
  the cookie branch is only *set* by remote.js.
- Not an extraction from a coordinator — do NOT add to the leak-scanner
  lists.

### 2. remote.js gate

- New config input: `CLODEX_REMOTE_TOKEN` env (mirrors `CLODEX_WEB_TOKEN`),
  read in remote-wiring.js alongside `CLODEX_REMOTE_HOST` /
  `CLODEX_REMOTE_ENABLE`, threaded into RemoteServer.
- Gate EVERYTHING: viewer page, all `/api/*`, SSE. The viewer and SSE expose
  transcripts — read-only is not harmless here. 401 + `WWW-Authenticate:
  Bearer` on failure.
- **Fail-closed rule**: if the bind host is non-loopback AND no token is
  configured, refuse to serve (503 with a one-line explanation naming
  `CLODEX_REMOTE_TOKEN`) instead of silently localhost-trusting. This turns
  the exact breach condition into a hard, observable error at first request.
  Loopback bind with no token keeps today's localhost-trust (SSH-tunnel
  peers unaffected).
- **Migration escape hatch**: `CLODEX_REMOTE_INSECURE=1` restores the old
  behavior explicitly (non-loopback, no token, serve anyway). Logged loudly
  at startup. Exists so a fleet upgrade can't hard-brick a node the operator
  hasn't re-provisioned yet; the flag name says what it does.

### 3. Browser viewer path (the phone)

- First hit arrives as `GET /?token=X` (bookmarkable). Server validates,
  then sets `clodex_remote_token` as an HttpOnly, SameSite=Strict cookie
  (Secure when behind TLS — trust `x-forwarded-proto`), so the viewer's
  subsequent XHR + EventSource requests authenticate without the page JS
  ever handling the token. EventSource cannot set headers — the cookie is
  the mechanism, not a convenience.
- Edge basic-auth in front (where deployed) stays as defense-in-depth;
  this gate is about the paths that never touch the edge.

### 4. Peer-client side (desktop → container/remote peers)

- Peer entry gains optional `token` (string, trimmed, cap 256).
  `sanitizePeers` (stores.js:138) passes it through OR carries it forward on
  omit: it takes the current peers array as a second arg and, when an incoming
  entry omits `token`, reuses the stored value by id (an explicit `''` clears;
  a dropped row drops its token). This is required because the Peers dialog
  saves the whole array back knowing only `hasToken` — without carry-forward a
  plain label edit would wipe every token. Peers dialog gains a write-only
  field like the sandbox OAuth one; `getSettings`/`peer:list`-style IPC results
  and the peers UI must return only `hasToken`, never the value.
- peer-client.js presents `Authorization: Bearer <token>` on BOTH request
  paths: `_request` (:449) and the SSE attach (:479). No cookie logic on
  this side.
- peer-deploy / peer-wiring: no change to tunnels — tunneled peers hit
  loopback on the far side and keep localhost-trust unless that node sets
  a token.

### 5. Sandbox integration

- sandbox.js generates a random token at first Start (crypto.randomBytes
  hex), stores it ONLY in the existing 0600 `auth.env` mechanism
  (`CLODEX_REMOTE_TOKEN=...` line) — never in compose bytes, ui-settings,
  logs, or IPC results (same invariants as the M4 OAuth token, same tests
  pattern).
- The auto-registered `sandbox` peer entry carries the same token so the
  desktop's peer client authenticates transparently. This closes the
  container walk-in end-to-end with zero operator steps.

### 6. Operator deployments (k8s / compose, outside this repo)

Not code: set `CLODEX_REMOTE_TOKEN` on each exposed node, append `?token=`
to the phone bookmark once (cookie carries it after), keep edge auth.
Release notes must state the fail-closed change and the escape hatch.

## Chunks (each: suite green, review, commit)

1. auth-token.js leaf + web-host.js adoption (timingSafeEqual upgrade;
   behavior otherwise pinned by existing web-host tests) + tests.
2. remote.js gate + fail-closed + insecure flag + cookie path + tests
   (401/200 matrix, fail-closed 503, escape hatch, cookie set/replay,
   SSE gated).
3. Peer entry token + sanitizer + dialog field + peer-client Bearer on
   both paths + tests (hasToken-only exposure pinned).
4. sandbox.js token gen + auth.env line + peer entry wiring + tests
   (compose-bytes-clean pinned).

## Non-goals

- Multi-user identity, roles, token rotation UX — this is one shared
  operator secret per node, same stance as CLODEX_WEB_TOKEN.
- Replacing control leases — they keep arbitrating concurrent control
  among authenticated callers.
- TLS on the wire itself — transport security remains the tunnel /
  edge / loopback, as today.
