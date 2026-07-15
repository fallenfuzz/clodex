# Sandbox peers — one-button Docker sandbox from the desktop app

Goal: a desktop user clicks one button and gets the web-frontend container
running as a local peer; New Session then offers "on this Mac" vs "in the
sandbox" placement. Agents placed in the sandbox are containerized (their
Bash tool, file writes, and network live inside Docker) while keeping full
Clodex features through the existing peering surface.

Status: spec ruled 2026-07-15. Decisions that were open are now closed:

- **ONE sandbox in v1.** Multi-sandbox = port allocation per instance
  (7820+ per queued arc) — deferred until someone needs it.
- **Sandbox sessions appear in the sidebar's peer section**, exactly like
  any other peer's sessions. No special-cased "sandbox" UI region; the
  sandbox IS a peer (id `sandbox`), just one the app manages the lifecycle
  of.
- **No SSH for local container peers** (Bogdan, 07-15): compose publishes
  the container's peer wire to loopback and the peer entry is a direct
  `http://127.0.0.1:<port>` url. No sshd in the image, no tunnel UI.
- **Loopback publish is the v1 trust boundary** for all three ports (web,
  wirescope, peer wire) — same stance as docker/web/compose.yaml documents.

## Ground truth (explorer-verified, do not re-derive)

- The container side is DONE: docker/web/{Dockerfile,compose.yaml} already
  runs engine + web frontend + wirescope + peer wire. `CLODEX_REMOTE_ENABLE=1`
  + `CLODEX_REMOTE_HOST=0.0.0.0` bring the peer wire up at first boot
  (remote-wiring.js:60); `hostname: sandbox` pins SELF_LABEL (DM routing
  breaks without a stable hostname — learned live, 34dbe31).
- Create-on-peer EXISTS end-to-end: caps `create` remote.js:374,
  `POST /api/sessions {name,type,cwd}` remote.js:534, owner side
  remote-wiring.js:145 (manager.create with nulls for rich params),
  `peerCreateSession` ipc-handlers.js:872 + api-contract.js:146, peers-ui
  dialog gated on peerCanCreate.
- New Session funnels through ONE call site: `doCreate` renderer.js:1123.
- Peer entries are `{id,label,url|sshHost,remotePort,deployFolder,disabled,
  relayAllowed}` — no token field; added via plain `setSettings({peers})`.
- NO docker shell-out exists anywhere in app code yet; NO credential env
  path exists (CLAUDE_CODE_OAUTH_TOKEN appears nowhere).
- `claude setup-token` (host CLI, needs subscription) mints a long-lived
  OAuth token accepted via the CLAUDE_CODE_OAUTH_TOKEN env var — the auth
  answer for "same Claude auth as the host".

## Milestones

Each is a separate review+commit. Hand implements, clodex reviews/commits.

### M0 — publish the image to GHCR (operator/clodex task, not hand's)

DMG users have no repo checkout to `docker compose build` from. Publish
multi-arch (arm64 + amd64) to `ghcr.io/avirtual/clodex:<version>` via
`docker buildx`. Deliverable: `scripts/publish-image.sh <version>`
(preflights: gh authed, buildx present; builds from docker/web/Dockerfile
with repo-root context; pushes version tag + `latest`). Runs on the mac,
credentials via `gh auth token | docker login ghcr.io`. NOT in release.sh
v1 — run manually after a release until it proves stable.

### M1 — sandbox.js lifecycle module

New root module (electron-free, deps-injected like session-manager; ADD to
free-identifier-leak SCANNED_MODULES). Owns:

- **Detection**: `docker info` (spawn, timeout) → {present, running}.
  Distinguish "not installed" from "daemon not running" — the dialog copy
  differs (install Docker Desktop vs start it).
- **Config** (persisted in ui-settings under `sandbox`): workDir (host
  folder to bind-mount at /home/clodex/work; null = named volume),
  webPort/wirescopePort/wirePort (defaults 7810/7811/7820, collision-bumped
  at generation time by probing listeners), autoStart (bool), image
  override (null = default resolution).
- **Image resolution**: packaged app → `ghcr.io/avirtual/clodex:<appVersion>`;
  dev (`!isPackaged`) → `build:` from the repo checkout (compose build
  context, exactly today's docker/web/compose.yaml). This keeps the dev
  loop free of GHCR.
- **Compose generation**: write `<userData>/sandbox/compose.yaml` from the
  config. Content mirrors docker/web/compose.yaml (hostname sandbox, three
  loopback publishes, named vols data/dot/claude-auth, init, restart:always,
  healthcheck) with ports/volumes/image swapped in. Regenerated on every
  Start (config is authoritative, the file is derived output). The auth
  env_file line (M3) references a SEPARATE file, secrets never in compose
  bytes.
- **Lifecycle**: `up()` (compose up -d), `down()`, `status()` (compose ps
  --format json → running/exited/absent), `logsTail(n)`. All spawn-based,
  async, surfacing stderr on failure (peers-ui deploy toasts are the
  model).
- **Peer registration**: on first successful up, add peer
  `{id:'sandbox', label:'sandbox', url:'http://127.0.0.1:<wirePort>'}` via
  the settings write path (peer-wiring reconciles; 78f65bd guarantees the
  offline row shows immediately). Idempotent — update url if the port
  moved, never duplicate. Down does NOT remove the peer (it just goes
  offline; the row is the affordance to start it again later).

Tests: pure parts (compose generation bytes given a config, port bump
logic, image resolution) — spawn/docker mocked.

### M2 — setup dialog + menu entry

"Sandbox…" entry (File menu + a button in the Peers setup dialog). Dialog
shows: docker detection state, sandbox status (running/stopped/never
created), Start/Stop button, work-folder picker (native on desktop;
text field on web), port fields (prefilled, editable while stopped),
auto-start-with-app checkbox (honored in main.js whenReady after peer
wiring), Open-in-browser link (http://localhost:<webPort>) when running.
Status polls while the dialog is open (compose ps every 3s), not globally
— the peer row's online/offline dot is the global indicator.

### M3 — New Session placement selector

A "Run in" selector (Host / Sandbox) at the top of the New Session dialog,
shown only when the sandbox peer exists. Sandbox placement branches
`doCreate` (renderer.js:1123) to `peerCreateSession('sandbox', name, type,
cwd)`. The rich fields (skills/prompts/tools/proxy/intents) do NOT cross
the create-on-peer wire yet — grey them with a "not yet available in
sandbox sessions" hint when Sandbox is selected. cwd defaults to
/home/clodex/work for sandbox placement. (M5 extends the wire op with the
full param set and un-greys.)

### M4 — auth seeding (same Claude auth as host)

Paste field in the Sandbox dialog: "Claude auth token" with a hint to run
`claude setup-token` in a terminal. Stored at
`<userData>/sandbox/auth.env` (mode 0600, `CLAUDE_CODE_OAUTH_TOKEN=…`),
referenced from the generated compose via `env_file`. NEVER written into
compose.yaml bytes or logged. Clearing the field deletes the file.
Fallback documented in the dialog: leave empty and log in interactively
inside a sandbox bash session (`claude login` — works today, persists in
the claude-auth volume).

### M5 (later, unqueued) — full-param wire create

Extend POST /api/sessions + peerCreateSession + remote-wiring create with
the rich param set (skills/prompts/tools/intents/exec grants), then un-grey
the M3 fields. A spec of its own; touches the peer protocol version.

## Non-goals (v1)

- Multi-sandbox instances; LAN-exposed sandbox (token story first);
  auto-publishing images from release.sh; migrating existing host sessions
  into the sandbox; Codex auth seeding (Claude first, Codex once asked).
