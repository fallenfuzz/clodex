# Telemetry, wirescope & maintenance

How proxy telemetry reaches the UI, when autocompact fires, and the
maintenance layers (statusline, ctx reminders, update checks, ops log).
Companion to [architecture.md](architecture.md); the ctxwarn/acks/pending
drain hooks are detailed in [messaging.md](messaging.md) §7.

Reading guide for a change: **proxy client/poller** → wirescope-proxy.js ·
**managed instance** → wirescope-supervisor.js · **decision logic** →
proxy-util.js · **UI** → renderProxyBar (renderer.js) + renderer/popovers/ ·
**side-channels** → statusline.js + ctx-reminder.js.

## 1. Wirescope client (wirescope-proxy.js `ProxyClient`)

Convention for every action endpoint: **HTTP status = request validity;
the outcome is in the JSON body** — always branch on the body.

- `hold` (keep-warm), `stripThinking` (one mechanism, levels 0/1/2 —
  in-memory proxy write, idempotent), `compact` — the **bake** op: a
  permanent source rewrite of the safe-to-drop set, keyed by transcript
  PATH so it works on a cold session; wirescope backs up and
  integrity-gates, and on any `!ok` the caller MUST resume the original
  transcript untouched.
- `probe` (identity + capabilities, 60s cache), `status` (the poll),
  `subagentDetail`/`bustSeries` (on-demand only — heavy bodies, never
  polled), `prune` (machine-wide log cleanup, capability-gated).

## 2. The poller (`createProxyPoller` → `ProxyPoller`)

One poller per process; one `/_status` fetch per distinct proxy base per
5s tick, fanned out to routed sessions; pauses when nothing is
proxy-routed. The factory takes a deps object because a free-identifier
ReferenceError inside the tick was once swallowed by its `catch(()=>{})`
and the status bar silently vanished — the leak-gate test now pins every
injected name.

Per tick: probe (cached) → status → group records by agent → shape +
annotate (`base`, `stripLevel`, `autoCompact`) → emit `session-proxy` →
mirror to attached peers via `pushTelemetry({proxy: peerProxyView(...)})`.
Wrinkles that are load-bearing:

- **Link hysteresis** (`PROXY_LINK_GRACE` ≈ 4 polls): a briefly-unlinked
  session keeps its last-good payload so affordances don't blink.
- **Strip cap latched permanently per base** — it's a static deployment
  property; a failed probe may read it but never retract it (stops the 🧠
  button vanishing).
- **Strip reconcile every tick, not fire-once**: the poller re-POSTs when
  the proxy's configured level disagrees with persisted intent (debounced).
  The old fire-once latch left Clodex shipping full thinking while
  believing L2 was active.

## 3. Autocompact (proxy-util.js `autoCompactDecision`)

Returns `{fire, reason, band, remaining_s}`; suppression reasons in
priority order (disabled / not-at-prompt / no-payload / unlinked /
keep-warm-hold / cache-not-warm / warmth-headroom / no-context-tokens /
below-min-tokens / recent-user-input / cooldown). Key facts:

- The warmth headroom band is **TTL-relative**: `headroomBand(ttl_s)` =
  clamp(0.15·ttl_s, 60s, 900s). The historical fixed 60s band was tuned
  for a ~300s TTL; when production moved to ttl_s=3600 it became the last
  1.6% — unreachable by a 5s poll, so autocompact had never fired.
- `atPrompt` is **wire-stamped** (`lastMainStop.isTurn && !needsAttention`).
  No wire → never stamped → never fires, deliberately: without it we can't
  rule out a permission dialog, and the injected Enter would answer it.
  A once-per-session WARN flags heavy non-wire-routed sessions.
- On fire: inject the `/compact` slash command with `bypassHold` (a bare
  slash command must never sit in the turn-batch queue). The in-flight
  guard + 5min valve (`COMPACT_INFLIGHT_TIMEOUT`) bound the window;
  suppressions are ops-logged only on reason *transitions* (never
  per-poll).
- Default ON; sessions.json stores only `autoCompact: false` to opt out.

## 4. Managed wirescope (wirescope-supervisor.js)

- **Detect-first adoption**: if a wirescope already answers on the port,
  adopt it — never spawn a second (keeps a shared :7800 a single warmth
  ledger). Ours-vs-external is decided by pidfile.
- The managed instance is spawned **detached + unref'd** — it deliberately
  outlives the GUI so warmth/prefix caches survive app restarts. `killAll`
  never touches it.
- Source: explicit `wirescopeDir` wins (set-but-invalid is an error, not a
  silent fallback); otherwise the vendored snapshot (packaged outside asar
  — python can't run from an archive). Venv is stamped with the
  requirements hash; reinstall only on change.
- Vendor-bump pickup: a surviving instance older than the vendored release
  is restarted **once per launch** (latch — no restart loop). External
  instances are never touched.
- `autoStartWanted()` is true only when the proxy is enabled AND proxyUrl
  points at localhost on the managed port — a remote proxyUrl means the
  user runs their own.

## 5. Renderer consumption

`proxyState`/`ctxPct`/`ctxTokens`/`filesState`/`filesUnseen` maps in
renderer.js; peer telemetry merges **partial frames** (`{proxy}` on the
poll, `{ctx}` on the side-channel, `{files:{count}}` for the badge) into
the same maps under the peer key (peers-ui.js `onPeerTelemetry`).

`renderProxyBar` renders model · ctx · turn/req · warmth · cost ·
refusals · busts · wirescope-link segments, with staleness derived from
payload age (stale >2× poll, dead >4×). Control *presence* (keep-warm,
strip ladder) is a deployment property riding the payload; only *enabled*
tracks the live link. The 📄 files badge latches "unseen" only on an
increase over a known baseline (the attach seed is silent).

**`popoverApi(name)`** is the local-vs-peer data seam: local sessions call
the direct IPC (getProxyContext/Report/Bust, sessionFiles, filePeek,
fileDiff); peer sessions route the same kinds through `peerQuery`, with
identical response shapes so render code is shared. `peerProxyView`
(main.js) is the owner-side trim: no base/capabilities/sessionId crosses
the wire (no reach-back), plus a computed `queries[]` advertising which
popovers the owner will answer.

## 6. Side-channels

- **Statusline** (statusline.js): the generated per-session script always
  writes `{name}-ctx` (pct/used/size/model) even in `headless` mode
  (proxy-routed sessions suppress the visible line but the CLI is the sole
  source of the context-window SIZE). `rebuildAllStatusScripts` (main.js)
  re-renders on preference changes. The template is a bash heredoc —
  byte-sensitive, test-pinned.
- **Ctx reminders** (ctx-reminder.js): absolute thresholds (nudge 150k,
  escalate 250k — cost scales with absolute context size, not window %).
  The ctx tick writes/removes `{name}-ctxwarn`; the read-only drain hook
  re-delivers every submit while over (recurrence counters habituation).
- **Update checker** (update-checker.js, data layer only): startup + 6h;
  `updateInfo` drives the banner/tray/notification (side effects stay in
  main.js); `releasesCache` feeds the peer ⓘ popover's version-severity
  and "N releases behind" line (severity helpers live in proxy-util.js).
- **Ops log**: `initLog`/`log.{info,warn,error}` in main.js, injected into
  every factory. `~/.clodex/clodex.log`, one-generation 5MB rotation at
  startup, coarse low-frequency events only (lifecycle, state-mutating
  intents, autocompact decisions, peer transitions, crashes). Logging must
  never throw into callers — it wraps the PTY and the crash net.

## 7. Wirescope window & settings

`openWirescopeWindow` (main.js) hosts the proxy UI in a hardened
BrowserWindow (`contextIsolation:true, sandbox:true` — it loads external
content, unlike the main renderer). Settings: `proxyEnabled` (default on),
`proxyUrl`, `wirescopeDir`, `wirescopePort`; per-session persisted:
`stripLevel`, `autoCompact` (opt-out only), `proxyAgent`. The
`[wirescope:*]` spawn directives are **not handled in this repo** — they
are a proxy-side concept; the nearest in-repo trace is the supervisor's
`WS_OMIT_DEFAULT=useremail` env default.

## Invariants (do not break)

- Branch on the JSON body, not the HTTP status, for every action endpoint.
- `/_compact` is a bake: on `!ok`, resume the ORIGINAL transcript.
- Strip cap never retracts; strip intent reconciles every tick.
- Autocompact requires wire-stamped `atPrompt`; the headroom band must stay
  TTL-relative.
- The managed wirescope outlives the GUI; adopt, never double-spawn;
  vendor-bump restart at most once per launch.
- Nothing that reaches a peer carries base/capabilities/sessionId.
- Ops log stays coarse and never throws.
- Statusline heredoc bytes are pinned; headless still writes the
  side-channel.
