'use strict';

// W2 step-4 telemetry bridge — DARK phase (CLODEX_WIRE_SHADOW only).
//
// Shapes the in-process wire's turn.completed receipts into the same payload
// shapeProxyRecord (proxy-util.js) builds from a /_status poll, and diffs the
// two every time ProxyPoller emits — ProxyPoller stays the LIVE source; this
// module renders nothing. The diff stream is the evidence for the reviewer's
// cutover condition (CLODEUX-PLAN.md): est cost within 1%, warmth verdicts
// exact. Once live-shadow validation passes, the cutover commit points the
// renderer at payload() and the 9 poll-era guards die (w2-glue-inventory.md).
//
// Contract with the wire (fable's, wire/proxy.js header):
//   - consume events only; NOTHING here may touch the client byte path.
//   - every public method swallows its own errors (a telemetry bug must
//     degrade to a missing diff line, never to a broken wire listener).
//
// Field parity notes (docs/w2-telemetry-flow.md):
//   - cost/turns/refusals/requests: sessionTotals snapshot off ANY
//     turn.completed for the agent (side-calls and subagents bill into the
//     same session key, matching the poll record's per-session totals).
//     count_tokens spend accumulates wire-side without an event, so between
//     turns the wire totals can trail the poll's by in-flight probes —
//     the diff is only meaningful at turn boundaries, which is when both
//     sides move anyway.
//   - sessionId/model/inputTokens: MAIN-LINE turns only (subagent/title
//     traffic must not rotate the session identity or the last-turn tokens).
//   - inputTokens = uncached input + cache read + cache write of the last
//     main-line turn — same formula wirescope uses for context.input_tokens.
//   - warmth: WarmthStore.query({session}) at diff time; two-state verdict
//     (warm / not-warm) is what the reviewer condition compares. The poll
//     side's state string is compared raw.
//   - context window SIZE stays off-wire (CLI statusline side-channel +
//     MODEL_WINDOWS override in main.js) — not this module's field.

const { isSubagentRole } = require('./wire/role');

class WireTelemetry {
  constructor({ warmth = null, log = () => {} } = {}) {
    this._warmth = warmth;
    this._log = log;
    this._agents = new Map();   // name -> { sessionId, model, totals, inputTokens, ts }
    this._lastDiff = new Map(); // name -> JSON of last logged diff (dedupe)
  }

  // Wire listener body. Never throws.
  noteTurn(t) {
    try {
      if (!t || typeof t.agent !== 'string') return;
      let a = this._agents.get(t.agent);
      if (!a) {
        a = { sessionId: null, model: null, totals: null, inputTokens: null, ts: 0 };
        this._agents.set(t.agent, a);
      }
      a.ts = Date.now();
      // Totals snapshot: latest wins, whatever line it rode in on.
      if (t.sessionTotals) a.totals = t.sessionTotals;
      if (t.sideCall || isSubagentRole(t.role)) return;
      if (t.sessionId) a.sessionId = t.sessionId;
      if (t.model) a.model = t.model;
      const tok = t.billing && t.billing.tokens;
      if (tok) {
        const w = (tok.cache_write_5m_tokens != null || tok.cache_write_1h_tokens != null)
          ? (tok.cache_write_5m_tokens || 0) + (tok.cache_write_1h_tokens || 0)
          : (tok.cache_write_flat_tokens || 0);
        const used = (tok.input_tokens || 0) + (tok.cache_read_input_tokens || 0) + w;
        if (used > 0) a.inputTokens = used; // error receipts (all-null usage) keep the last real value
      }
    } catch { /* consume-only: a bad receipt is a missing sample, not a crash */ }
  }

  // shapeProxyRecord-parity subset (the fields the validation compares and
  // the cutover will render). null = wire hasn't seen this agent yet.
  payload(name) {
    try {
      const a = this._agents.get(name);
      if (!a) return null;
      const t = a.totals || {};
      let warmth = null;
      if (this._warmth && a.sessionId) {
        // Own try: a broken warmth store costs the warmth field, not the
        // whole payload (cost/turns samples must keep flowing).
        try {
          const q = this._warmth.query({ session: a.sessionId });
          if (q && q.found) {
            warmth = { state: q.warm ? 'warm' : 'cold', remaining_s: q.remaining_s ?? null, ttl_s: q.ttl_s ?? null };
          }
        } catch { /* warmth degrades alone */ }
      }
      return {
        linked: true,
        sessionId: a.sessionId,
        model: a.model,
        cost: { usd: t.est_usd ?? null, requests: t.requests ?? null },
        turns: t.turns ?? null,
        refusals: t.refusals || 0,
        context: { inputTokens: a.inputTokens },
        warmth,
      };
    } catch { return null; }
  }

  // Called by ProxyPoller right after it emits the live payload. Logs one
  // wire-telemetry-diff record per material change (consecutive identical
  // diffs are deduped — the poller ticks every 5s, the log shouldn't).
  diffPoll(name, poll) {
    try {
      if (!poll || !poll.linked) return; // nothing to compare against
      const wire = this.payload(name);
      const rec = { type: 'wire-telemetry-diff', agent: name, wire_seen: !!wire };
      if (wire) {
        rec.session_match = !!poll.sessionId && poll.sessionId === wire.sessionId;
        const pUsd = poll.cost && typeof poll.cost.usd === 'number' ? poll.cost.usd : null;
        const wUsd = wire.cost && typeof wire.cost.usd === 'number' ? wire.cost.usd : null;
        rec.cost = { poll: pUsd, wire: wUsd };
        if (pUsd != null && wUsd != null && pUsd > 0) {
          rec.cost.delta_pct = Math.round(Math.abs(wUsd - pUsd) / pUsd * 10000) / 100;
        }
        rec.requests = { poll: poll.cost ? poll.cost.requests : null, wire: wire.cost.requests };
        rec.turns = { poll: poll.turns, wire: wire.turns };
        rec.refusals = { poll: poll.refusals, wire: wire.refusals };
        rec.input_tokens = {
          poll: poll.context ? poll.context.inputTokens : null,
          wire: wire.context.inputTokens,
        };
        const pWarm = poll.warmth ? poll.warmth.state : null;
        const wWarm = wire.warmth ? wire.warmth.state : null;
        rec.warmth = { poll: pWarm, wire: wWarm, match: pWarm === wWarm };
      }
      const key = JSON.stringify(rec);
      if (this._lastDiff.get(name) === key) return;
      this._lastDiff.set(name, key);
      this._log(rec);
    } catch { /* diffing must never break the poller tick */ }
  }

  // Mirror ProxyPoller's telemetry pruning so dead sessions don't accrete.
  prune(liveNames) {
    try {
      for (const name of this._agents.keys()) {
        if (!liveNames.has(name)) { this._agents.delete(name); this._lastDiff.delete(name); }
      }
    } catch { /* never breaks the tick */ }
  }
}

module.exports = { WireTelemetry };
