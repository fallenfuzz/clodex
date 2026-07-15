'use strict';
// Unit tests for renderer/lib/turn-stat.js — the shared "which turn number do
// we show" decision. The statusbar reshape (live count front, cumulative in
// the tooltip) is pinned here.

const test = require('node:test');
const assert = require('node:assert');
const { turnStat, turnSeg, turnLine } = require('../renderer/lib/turn-stat');

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
