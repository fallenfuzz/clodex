# W2 Glue Inventory — poll-era guards vs. in-process wire

**Purpose (reviewer condition: inventory before deletion).** Catalogs every
compensating guard the HTTP-polling ProxyPoller stack carries, the historical
bug each was born from, and whether spawn-bound identity + in-process wire
events (`wire/`, `CLODEX_WIRE_SHADOW`) make the guard obsolete — or which wire
event must exist first before it can be deleted.

Scope: `main.js` ProxyPoller + `ProxyClient.probe`, `proxy-util.js`, and the
renderer consumers. Inventory only — no code changes proposed here.

Context that governs the whole table: today telemetry is **pull** — one
`GET /_status` per proxy base every `PROXY_POLL_INTERVAL` (5s, `main.js:1536`),
diffed into per-session payloads. Every guard below exists because polling is
(a) lossy (a session can be absent from any single snapshot), (b) rate-limited
(you can't probe identity every tick), and (c) ambiguous (one agent id maps to
many records). An **in-process wire** that emits `turn.completed` (carrying
`billing`/`stop`/`sessionTotals` — see `wire/proxy.js` header) removes all three
properties at once: events are pushed per-turn, bound to the live session at
emission, sourced from the real wirescope in-process. The guards are
compensations for polling; most die with polling.

---

## Guard-by-guard

| # | Guard | file:line | What it feeds (UI / persistence) | Race/gap it guarded | Historical bug | Obsolete under in-process wire? | Wire event required before it can die |
|---|---|---|---|---|---|---|---|
| 1 | **ProxyPoller `_tick` poll loop** | `main.js:1751` (loop), `1723` (`start`), `4239`/`4378` (instantiate/start) | Emits `session-proxy` (`main.js:1818`) → renderer `proxyState` → `renderProxyBar` (whole telemetry bar: cost/warmth/ctx/turns/strip/subagents) | Nothing itself — it's the transport. Every guard below is scaffolding around its lossiness. | — (the mechanism the others compensate for) | **YES, wholesale** — replaced by `turn.completed` push. The per-tick reconcile work relocates (see #6). | `turn.completed` carrying the shaped record fields (`shapeProxyRecord` targets), pushed per-turn keyed by session_id. |
| 2 | **`probeCache` (60s TTL)** | `main.js:1695`, `1743`–`1748`; `PROXY_PROBE_TTL` `1542` | Caches `/_identity` result → `probe.capabilities` → gates strip button, ctx-breakdown button, warmth, subagent rows in the renderer | Can't hit `/_identity` every 5s tick (needless HTTP); so capabilities are cached and go **stale** for up to 60s | Directly enables bug #4 — a stale/foreign cached probe kept a wrong capability shape live for a full TTL | **YES** — in-process wire *is* the wirescope deployment; capabilities are a direct in-process read, never an HTTP round-trip, so there's nothing to cache or stale | In-process capability accessor (synchronous `wire.capabilities()` equivalent). No event needed — it's a call, not a poll. |
| 3 | **`logproxy` fallback shape** | `main.js:1642`–`1660` (`ProxyClient.probe` `/_status` fallback) | Synthesizes a `product:'logproxy'` capability object (`stats/hold/warmth/subscribers`, **no `strip_thinking` key**) when `/_identity` is absent (pre-rename deployments) | Pre-`/_identity` wirescope had no handshake; the fallback let the bar work against old proxies | **Root cause of the vanishing strip button** (commit `31cdb26`): this shape passes the `stats` gate but omits `strip_thinking` → renderer drops the strip button for up to the 60s cache TTL | **YES** — in-process wire is always the current wirescope in-process; there is no external pre-`/_identity` proxy to fall back to, so the degraded shape can never appear | None. Deletion is unblocked the moment probing is in-process (the fallback only ever matched a foreign/old external proxy). |
| 4 | **`stripCapBases` latch** | `main.js:1710`, `1764`–`1777`; renderer comment `renderer/renderer.js:1351`–`1352` | Latches the last *genuine* `strip_thinking` cap per base → re-imposes it on downgraded ticks → keeps the strip button present + L2 unlocked | A downgraded/foreign probe (guard #3's shape) would retract `strip_thinking` or drop `max_level`, making the button vanish or L2 relock to "coming soon" | Commit `31cdb26` (Set→Map<base,lastGenuineCap>); `strip_thinking.available` is a hardcoded `True` literal in wirescope (`status.py:88`), so "cap absent" only ever meant a failed/foreign probe | **YES** — it exists purely to defend against guard #3's degraded shape and probe-cache staleness (#2). With in-process capabilities that can't degrade to a foreign shape, there is nothing to latch against | None. Dies together with #2 + #3 (all three are one bug family). |
| 5 | **Link-grace hysteresis** | `main.js:1805`–`1816`; `PROXY_LINK_GRACE` = 20s / ~4 polls `1550`; renderer aging comment `1168`–`1172` | On a transient unlink, keeps last-good `session-proxy` payload in place (bar stays up, cost/ctx/wire links stay clickable) and **skips that tick's strip re-assert** | `/_status` doesn't list a session every tick (`main.js:1543`) — a single missed record would tear the bar down and desync strip | Bar-flicker / clickable-link loss on a one-tick miss; part of the `7a8e9da` proxy-bar-flicker + `31cdb26` work | **YES** — hysteresis exists only because *snapshots* can omit a live session. Push events (`turn.completed`) are emitted *because a turn happened*; there is no "absent from this snapshot" state to smooth over | `turn.completed` push replacing the `/_status` snapshot. Renderer keeps its own stale→dead aging (that's honest degradation, not a poll artifact). |
| 6 | **`pickProxyRecord` disambiguation** | `proxy-util.js:43`–`53`; called `main.js:1799`; policy notes `1782`–`1784` | Picks the live `/_status` record when several share one proxy agent id → the `session-proxy` payload's `sessionId` and everything shaped from `r` | `/clear` (and `/compact`) **keep the agent id but mint a new session_id** → `/_status` returns one ended record per past session + the live one, all under one `agent` | Last-writer-wins over `/_status` order bound the bar to a dead `clear`-ended record | **YES, if** the wire event is keyed to the live session_id at emission. Spawn-bound identity means clodex already knows the live session_id; a per-turn event carrying its own `session_id` is unambiguous by construction — no candidate set to disambiguate | `turn.completed` (and any per-session event) must carry `session_id`. Then binding is exact-equality at receive time; the multi-record reduction disappears. **Until that field is guaranteed on every event, this cannot die.** |
| 7 | **`stripAsserted` re-assert ledger** | `main.js:1700`, `1718`–`1721` (`noteStripAsserted`), `1819`–`1850` (reconcile) | Tracks which `{sessionId,level}` we've POSTed to `/_strip`; re-POSTs only on mismatch, debounced `PROXY_STRIP_REPOST_MS` (4s, `1551`) | Wire strip state drifts from persisted intent: proxy restart wipes in-memory overrides; a silent-200, id roll, or missed link left the override unset for the session's life | Observed: clodex believed L2 while proxy shipped L0 full thinking every turn (the fire-once-on-POST latch only retried on a rejected promise) | **PARTLY** — the *reconcile* need survives (persisted intent must reach the wire), but the mechanism changes: in-process you set strip config directly rather than POST-and-reconcile-against-poll. The ledger + debounce are poll-loop artifacts | In-process strip-config write API **+** `turn.completed` carrying strip truth (`configuredLevel`/`source`, i.e. today's `r.strip`) so clodex can confirm application without re-polling `/_status`. |
| 8 | **`_activeBases` / pause-when-idle** | `main.js:1733`–`1741`, `1757`–`1758` | Skips all HTTP when no session is proxy-routed | Don't poll a proxy nobody uses | — (optimization, not a bug fix) | **YES** — no poll loop means nothing to pause; in-process events only fire for routed sessions anyway | None. Trivially dies with #1. |
| 9 | **`last` map prune** | `main.js:1696`, `1753`–`1755` | Drops telemetry for sessions no longer in `manager.sessions` | Poll loop would otherwise retain payloads for dead sessions | — | Replaced by event-lifetime scoping (subscribe/unsubscribe per live session) | Session-scoped subscription teardown on the wire side (or clodex drops on session kill, which it already does elsewhere). |

---

## Deletion ordering (what unblocks what)

1. **In-process probe** (a `wire.capabilities()` call) → deletes #2, #3, #4
   together. This is the cleanest first cut: the whole vanishing-strip-button
   bug family (`31cdb26`) exists *only* because capabilities came over HTTP with
   a stale cache and a degraded fallback shape. In-process, capabilities are a
   fact of the running deployment.
2. **`turn.completed` push with `session_id`** → deletes #1, #5, #6, #8, #9.
   Guarantee `session_id` on the event *before* removing `pickProxyRecord` (#6)
   — that guard defends a real, still-live race (`/clear` keeps the agent id),
   and spawn-bound identity only helps if the event actually carries the id to
   match against.
3. **In-process strip write + strip truth on `turn.completed`** → deletes #7's
   poll-loop machinery. The *intent-must-reach-the-wire* invariant stays; only
   the POST-and-reconcile-against-poll implementation goes.

## Cross-cutting note for the wire integration (clodex-side eyes)

Two guards defend races that are **structural, not poll artifacts**, and must
not be dropped on the assumption that in-process = safe:

- **#6 `pickProxyRecord`**: `/clear` reusing the agent id is a wirescope-side
  fact independent of transport. The guard only becomes safe to delete once
  every per-session wire event is keyed by `session_id` (not just `agent`).
  Confirm `turn.completed`'s schema carries `session_id`.
- **#7 strip reconcile**: proxy-restart-wipes-overrides is also transport-
  independent. In-process, the equivalent is "wire module restart / re-init
  drops in-memory strip config." The re-assert-on-mismatch invariant needs a
  home even without polling.

Everything else (#1–#5, #8, #9) is genuinely poll-shaped scaffolding that the
event model dissolves.
