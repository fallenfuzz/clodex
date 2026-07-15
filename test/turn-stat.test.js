'use strict';
// Unit tests for renderer/lib/turn-stat.js — the shared "which turn number do
// we show" decision. The statusbar reshape (live count front, cumulative in
// the tooltip) is pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { turnStat, turnSeg, turnLine, reqSeg, reqLine } = require('../renderer/lib/turn-stat');

const full = { turns: 143, context: { turns: 12 } };

test('turnStat: both counts present', () => {
  assert.deepStrictEqual(turnStat(full), { now: 12, total: 143 });
});

test('turnStat: nulls for missing halves, null when neither exists', () => {
  assert.deepStrictEqual(turnStat({ turns: 143 }), { now: null, total: 143 });
  assert.deepStrictEqual(turnStat({ context: { turns: 3 } }), { now: 3, total: null });
  assert.strictEqual(turnStat({}), null);
  assert.strictEqual(turnStat(null), null);
});

test('turnSeg: live count leads, cumulative rides the tip', () => {
  assert.deepStrictEqual(turnSeg(full), {
    text: 'turn 12',
    tip: 'Turns in the live context (resets at compact) — 143 completed since session start',
  });
});

test('turnSeg: degrades to cumulative with a tip that says so', () => {
  const seg = turnSeg({ turns: 143 });
  assert.strictEqual(seg.text, 'turn 143');
  assert.match(seg.tip, /since session start/);
});

test('turnSeg: zero live turns (fresh post-compact poll) still renders live', () => {
  assert.strictEqual(turnSeg({ turns: 143, context: { turns: 0 } }).text, 'turn 0');
});

test('turnLine: hovercard shows both inline', () => {
  assert.strictEqual(turnLine(full), 'turn 12 (143 total)');
  assert.strictEqual(turnLine({ context: { turns: 3 } }), 'turn 3');
  assert.strictEqual(turnLine({ turns: 143 }), 'turn 143 total');
  assert.strictEqual(turnLine({}), null);
});

const scPayload = {
  cost: { requests: 1008 },
  sinceCompact: { turns: 12, requests: 61, estUsd: 0.4, boundaryTs: 1e9, compacted: true },
};

test('reqSeg: since-compact leads when the rollup is present, total in tip', () => {
  const seg = reqSeg(scPayload);
  assert.strictEqual(seg.text, 'req 61');
  assert.match(seg.tip, /since the last compact/);
  assert.match(seg.tip, /1008 total/);
});

test('reqSeg: never-compacted rollup says since-start honestly, no redundant total', () => {
  const seg = reqSeg({ cost: { requests: 61 }, sinceCompact: { ...scPayload.sinceCompact, requests: 61, compacted: false } });
  assert.strictEqual(seg.text, 'req 61');
  assert.match(seg.tip, /never compacted/);
  assert.ok(!seg.tip.includes('total'));
});

test('reqSeg: older proxy (no sinceCompact) degrades to cumulative with spans-compacts tip', () => {
  const seg = reqSeg({ cost: { requests: 1008 }, sinceCompact: null });
  assert.strictEqual(seg.text, 'req 1008');
  assert.match(seg.tip, /spans compacts/);
});

test('reqSeg: no counts at all → null', () => {
  assert.strictEqual(reqSeg({}), null);
  assert.strictEqual(reqSeg(null), null);
});

test('reqLine: both inline post-compact, plain otherwise', () => {
  assert.strictEqual(reqLine(scPayload), 'req 61 (1008 total)');
  assert.strictEqual(reqLine({ cost: { requests: 61 }, sinceCompact: { requests: 61, compacted: false } }), 'req 61');
  assert.strictEqual(reqLine({ cost: { requests: 1008 } }), 'req 1008');
  assert.strictEqual(reqLine({}), null);
});
