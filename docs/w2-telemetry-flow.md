# W2 Telemetry-Bar Data Flow — poll sources → wire-event fields

**Purpose.** Trace every field in the telemetry status bar (cost / warmth /
context / strip / subagents) from its current source through the IPC channel to
the renderer element, then map each to its new in-process wire-event field
(`turn.completed` now carries `billing`/`stop`/`sessionTotals` — see
`wire/proxy.js` header). Gaps flagged. Companion to `w2-glue-inventory.md`
(which covers the guards); this doc is the field ledger.

---

## Current path (two independent feeds)

The bar has **two** telemetry sources that the renderer merges, not one:

### Feed A — wirescope pull (cost/warmth/ctx-tokens/strip/subagents)

```
ProxyPoller._tick (main.js:1751)
  → ProxyClient.status(base)  GET /_status         (main.js:1664)
  → pickProxyRecord(...)                             (proxy-util.js:43)
  → shapeProxyRecord(record, probe)                  (proxy-util.js:90)
  → manager._sendToSession(name,'session-proxy',...) (main.js:1818)
  → preload onSessionProxy                           (preload.js:86)
  → renderer proxyState.set(name,{payload,at})       (renderer.js:1453)
  → renderProxyBar() / applyWarmBadge()              (renderer.js:1218 / 1426)
```

### Feed B — CLI statusline side-channel (ctx % + window SIZE)

```
generated statusline script (renderClaudeStatusScript, main.js:1443)
  jq reads .context_window.{used_percentage,total_input_tokens,context_window_size}
  → writes ~/.clodex/<name>-ctx  "<pct>\t<usedTok>\t<windowSize>"  (main.js:1475)
  → fs.watch on REGISTRY_DIR / readCtx()             (main.js:3087-3103)
  → parseCtxFile()                                    (main.js:1415)
  → _sendToSession(name,'session-ctx',pct,tok,size)  (main.js:3095)
  → preload onSessionCtx                              (preload.js:84)
  → renderer ctxPct / ctxTokens.set(name,{used,size})(renderer.js:1159)
  → renderProxyBar()                                  (renderer.js:1218)
```

Plus a **restore path** that seeds both feeds from persistence at launch:
`app:restore-sessions` packs `proxy:` (`main.js:5117`,`5152`), `ctx`/`ctxTok`/
`ctxSize` (`main.js:5094`-`5096` via `parseCtxFile`) into the restored entry;
renderer replays them (`renderer.js:4098`-`4102`).

### Where the renderer resolves the merge (the important bit for #7)

`renderProxyBar` (`renderer.js:1261`-`1294`) picks per field:
- **used tokens**: prefer Feed A `p.context.inputTokens` (updates while idle),
  fall back to Feed B `ctxTokens.used`.
- **window size (denominator)**: **Feed B only** — `ctxTokens.size`
  (`renderer.js:1271`). Feed A never carries it.
- **percent**: Feed A `used/size` if both present, else Feed B `ctxPct`.

---

## Field mapping: old source → new wire-event field

| Bar field | Current source (shaped in `shapeProxyRecord` unless noted) | Feed | New wire-event field | Status |
|---|---|---|---|---|
| **cost.usd** | `r.cost.est_usd` (`proxy-util.js:101`) | A | `turn.completed.billing` / `sessionTotals` cost | **Direct** — billing port is gate-verified (30,390/30,390). |
| **cost.requests** | `r.cost.requests` | A | `sessionTotals` request count | Direct. |
| **turns** | `r.turns_completed` (`proxy-util.js:102`) | A | `turn.completed.stop` / `sessionTotals` turn count | Direct. |
| **refusals** | `r.refusals` (`proxy-util.js:103`) | A | refusal push event (wire already tees refusals) | Direct — confirm refusal count is cumulative on the event. |
| **context.inputTokens** (used) | `r.context.input_tokens` (`proxy-util.js:113`) | A | `turn.completed.billing` input-token usage (cache_read+cache_write+uncached) | **Direct** — same number billing already computes. |
| **context.messages** | `r.context.n_messages` (`proxy-util.js:108`) | A | `turn.completed` context summary | Direct (Codex fallback display). |
| **context.turns** | `r.context.turns_in_context` | A | `turn.completed` context summary | Direct. |
| **context WINDOW SIZE** (denominator) | CLI statusline `.context_window.context_window_size` → `-ctx` file (`main.js:1468`) | **B** | **none today** | **★ GAP — see below.** |
| **context percent** | CLI `.context_window.used_percentage` (`main.js:1463`) OR derived `used/size` | B / derived | derivable from `used/size` if size lands on the wire | Gap-dependent on the size field. |
| **warmth.state / remaining_s / ttl_s** | `r.warmth` (`proxy-util.js:115`-`119`) | A | warmth event (fable's **#5 warmth.py port**) | **Pending #5** — confirm event shape once ported. |
| **pingable** | `r.pingable` (`proxy-util.js:106`) | A | warmth/hold event | Pending #5. |
| **hold** | `r.hold` (`proxy-util.js:131`) | A | hold event | Direct once hold is an event. |
| **strip.configuredLevel / source / globalDefaultLevel / ridersAvailable** | `r.strip` (`proxy-util.js:125`-`130`) | A | `turn.completed.stop` strip truth (`skipped_reason`/`stripped`) | **Direct-ish** — authoritative per-turn strip truth is request-capture, not the panel's `would_strip` (memory). Map to the per-turn `stop` fields. |
| **strip level (persisted intent)** | `stripLevelOf(persistence.get(name))` (`main.js:1803`) | local | n/a — clodex-owned persistence | Stays clodex-side; unaffected by wire. |
| **capabilities** (button gating) | `probe.capabilities` via `/_identity` (`main.js:1631`) | A | in-process `wire.capabilities()` call | **Direct** — becomes a call, not an event (see glue-inventory #2). |
| **subagents[]** | `r.sub_agents` → `shapeSubagent` (`proxy-util.js:65`,`135`) | A | per-subagent wire events (x-claude-code-agent-id header keys them) | Direct — wire sees the agent-id header per request. |
| **base / session-page link** | `payload.base = base` (`main.js:1800`) | A | poller context; becomes the wire endpoint's own identity | Trivial. |

---

## ★ The one real gap: context window SIZE

**Problem, live-confirmed today:** the bar's denominator (`sizeTok`,
`renderer.js:1271`) is sourced *only* from the CLI statusline side-channel
(Feed B), never from the wire. wirescope reports the token *count* but not the
window *size* (explicit in `proxy-util.js:112` and the `main.js:1438` comment:
"the context-window SIZE is off-wire… the CLI is the sole source of the bar's
denominator").

**Two symptoms this causes:**

1. **Idle sessions can't refresh the denominator.** Feed B only writes while the
   user is interacting (the statusline script runs on CLI status updates). An
   idle/unfocused session's `used` count updates from the wire (Feed A) but its
   `size` is frozen at the last statusline write.

2. **fable-5 shows 200k for a 1M model** (bogdan's report, 2026-07-02). The CLI
   is emitting `context_window_size: 200000` in its statusline JSON for
   `claude-fable-5` sessions, and clodex faithfully echoes it. Clodex has **no
   model→limit table** — the denominator is whatever the CLI reports. So the
   under-report is upstream (CLI), but clodex has no wire-sourced value to
   override it with.

**Fix candidate (wire-side, fable's call):** if `turn.completed` carried a
`context_window_size` (or the model's max context) field, it would:
- close the idle-refresh gap (Feed A gains the denominator, Feed B becomes a
  fallback instead of the sole source), and
- give clodex a wire-sourced value to prefer over a mis-reporting CLI, fixing
  the fable-5 1M display without a hardcoded model table.

The renderer merge already prefers Feed A for `used` (`renderer.js:1270`); the
symmetric change — prefer a wire-sourced `size` over the side-channel — is a
small renderer edit *once the field exists on the event*. Flagged to fable in
DM; schema ownership is wire-side.

**Note:** the two `200000` constants in `renderer.js:1140`
(`CTX_WARN_TOKENS`/`CTX_HEAVY_TOKENS`) are unrelated — absolute-token color
thresholds, deliberately not the denominator.

---

## Summary of gaps

- **context_window_size**: no wire event carries it (★ above). Blocks the
  fable-5 fix and the idle-denominator refresh. Candidate: add to
  `turn.completed`.
- **warmth event shape**: pending fable's #5 warmth.py port — map once landed.
- **strip per-turn truth**: confirm `turn.completed.stop` exposes the
  request-capture `stripped`/`skipped_reason` (authoritative), not just the
  panel-style `would_strip` (which memory flags as optimistic/non-authoritative).
- **refusals cumulative-vs-delta**: confirm whether the refusal event count is
  cumulative (matching today's `r.refusals`) or per-event.
