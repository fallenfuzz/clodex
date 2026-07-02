// Run: node --test
// W2 step-4 dark bridge: turn.completed receipts shaped into poll-payload
// parity + the diff stream the cutover validation reads. Covers the field
// rules from docs/w2-telemetry-flow.md: totals off any line, identity off
// the main line only, error receipts keeping the last real token count,
// warmth two-state verdict, diff dedupe, and the never-throws contract.
const { test } = require('node:test');
const assert = require('node:assert');
const { WireTelemetry } = require('../wire-telemetry');

const warmthStub = (rows) => ({
  query: ({ session }) => rows[session] || { found: false, warm: false },
});

function mainTurn(over = {}) {
  return {
    agent: 'alice', sessionId: 'sid-1', role: 'parent', sideCall: false,
    model: 'claude-sonnet-5', status: 200,
    billing: { tokens: { input_tokens: 100, cache_read_input_tokens: 40000, cache_write_5m_tokens: 500, cache_write_1h_tokens: null, cache_write_flat_tokens: null } },
    sessionTotals: { requests: 8, est_usd: 0.1234, turns: 2, refusals: 0 },
    ...over,
  };
}

test('payload: main-line receipt shapes to poll parity', () => {
  const wt = new WireTelemetry({ warmth: warmthStub({ 'sid-1': { found: true, warm: true, remaining_s: 240.5, ttl_s: 300 } }) });
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.strictEqual(p.sessionId, 'sid-1');
  assert.strictEqual(p.cost.usd, 0.1234);
  assert.strictEqual(p.cost.requests, 8);
  assert.strictEqual(p.turns, 2);
  // inputTokens = uncached + cache read + cache write (TTL-split branch)
  assert.strictEqual(p.context.inputTokens, 40600);
  assert.deepStrictEqual(p.warmth, { state: 'warm', remaining_s: 240.5, ttl_s: 300 });
});

test('subagent/side-call turns update totals but never identity or tokens', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  wt.noteTurn(mainTurn({
    role: 'general-purpose', sessionId: 'sid-other', model: 'claude-haiku-4-5',
    billing: { tokens: { input_tokens: 999999 } },
    sessionTotals: { requests: 9, est_usd: 0.13, turns: 2, refusals: 0 },
  }));
  wt.noteTurn(mainTurn({
    sideCall: true, sessionId: 'sid-title', model: 'title-model',
    sessionTotals: { requests: 10, est_usd: 0.14, turns: 2, refusals: 0 },
  }));
  const p = wt.payload('alice');
  assert.strictEqual(p.cost.requests, 10);      // totals: latest wins, any line
  assert.strictEqual(p.sessionId, 'sid-1');     // identity: main line only
  assert.strictEqual(p.model, 'claude-sonnet-5');
  assert.strictEqual(p.context.inputTokens, 40600);
});

test('error receipt (all-null usage) keeps the last real inputTokens', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  wt.noteTurn(mainTurn({
    status: 529,
    billing: { tokens: { input_tokens: null, cache_read_input_tokens: null, cache_write_flat_tokens: null } },
  }));
  assert.strictEqual(wt.payload('alice').context.inputTokens, 40600);
});

test('flat cache_creation total is used when the TTL split is absent', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn({
    billing: { tokens: { input_tokens: 10, cache_read_input_tokens: 20, cache_write_5m_tokens: null, cache_write_1h_tokens: null, cache_write_flat_tokens: 30 } },
  }));
  assert.strictEqual(wt.payload('alice').context.inputTokens, 60);
});

test('diffPoll: cost delta pct + warmth verdict, deduped across identical ticks', () => {
  const logs = [];
  const wt = new WireTelemetry({
    warmth: warmthStub({ 'sid-1': { found: true, warm: true, remaining_s: 200, ttl_s: 300 } }),
    log: (r) => logs.push(r),
  });
  wt.noteTurn(mainTurn({ sessionTotals: { requests: 10, est_usd: 0.13, turns: 2, refusals: 0 } }));
  const poll = { linked: true, sessionId: 'sid-1', cost: { usd: 0.1301, requests: 10 }, turns: 2, refusals: 0, context: { inputTokens: 40600 }, warmth: { state: 'warm' } };
  wt.diffPoll('alice', poll);
  wt.diffPoll('alice', poll); // identical → deduped
  assert.strictEqual(logs.length, 1);
  const d = logs[0];
  assert.strictEqual(d.type, 'wire-telemetry-diff');
  assert.ok(d.session_match);
  assert.ok(d.cost.delta_pct < 1);   // reviewer condition shape
  assert.ok(d.warmth.match);         // reviewer condition shape
  // a moved value logs again
  wt.noteTurn(mainTurn({ sessionTotals: { requests: 11, est_usd: 0.14, turns: 3, refusals: 0 } }));
  wt.diffPoll('alice', poll);
  assert.strictEqual(logs.length, 2);
});

test('diffPoll: unlinked/null poll is silent; unseen agent logs wire_seen:false', () => {
  const logs = [];
  const wt = new WireTelemetry({ log: (r) => logs.push(r) });
  wt.diffPoll('alice', null);
  wt.diffPoll('alice', { linked: false });
  assert.strictEqual(logs.length, 0);
  wt.diffPoll('bob', { linked: true, sessionId: 'x', cost: {}, context: {}, warmth: null });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].wire_seen, false);
});

test('never-throws contract: garbage inputs and a broken warmth store degrade silently', () => {
  const wt = new WireTelemetry({
    warmth: { query: () => { throw new Error('store dead'); } },
    log: () => { throw new Error('log dead'); },
  });
  wt.noteTurn(null);
  wt.noteTurn({ agent: 42 });
  wt.noteTurn(mainTurn());
  const p = wt.payload('alice');
  assert.ok(p, 'payload survives a broken warmth store');
  assert.strictEqual(p.warmth, null);           // warmth degrades alone
  assert.strictEqual(p.cost.usd, 0.1234);       // cost samples keep flowing
  wt.diffPoll('alice', { linked: true, cost: {}, context: {} });
  wt.prune(new Set());
  assert.strictEqual(wt.payload('alice'), null); // pruned
});

test('prune drops agents not in the live set', () => {
  const wt = new WireTelemetry({});
  wt.noteTurn(mainTurn());
  wt.noteTurn(mainTurn({ agent: 'bob' }));
  wt.prune(new Set(['bob']));
  assert.strictEqual(wt.payload('alice'), null);
  assert.ok(wt.payload('bob'));
});
