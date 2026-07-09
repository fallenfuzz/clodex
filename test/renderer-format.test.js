// Run: node --test
// Covers renderer/lib/format.js — the pure value->string formatters. `esc` is
// excluded (it needs the global `document`, absent under node --test); every
// other formatter is pure and exercised here.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const F = require('../renderer/lib/format');

test('fmtTokens: k/M compaction', () => {
  assert.strictEqual(F.fmtTokens(500), '500');
  assert.strictEqual(F.fmtTokens(201234), '201k');
  assert.strictEqual(F.fmtTokens(1000000), '1M');
  assert.strictEqual(F.fmtTokens(1500000), '1.5M');
});

test('fmtCountdown: mm:ss, floored at 0', () => {
  assert.strictEqual(F.fmtCountdown(0), '0:00');
  assert.strictEqual(F.fmtCountdown(9), '0:09');
  assert.strictEqual(F.fmtCountdown(75), '1:15');
  assert.strictEqual(F.fmtCountdown(-5), '0:00');
});

test('fmtUsd: tiered precision', () => {
  assert.strictEqual(F.fmtUsd(NaN), '$0');
  assert.strictEqual(F.fmtUsd(0.05), '$0.0500');
  assert.strictEqual(F.fmtUsd(0.5), '$0.500');
  assert.strictEqual(F.fmtUsd(3.14159), '$3.14');
  assert.strictEqual(F.fmtUsd(250), '$250');
});

test('fmtDur: s/m/h', () => {
  assert.strictEqual(F.fmtDur(0), '');
  assert.strictEqual(F.fmtDur(45), '45s');
  assert.strictEqual(F.fmtDur(150), '3m');
  assert.strictEqual(F.fmtDur(7200), '2.0h');
});

test('fmtBytes: unit ladder', () => {
  assert.strictEqual(F.fmtBytes(0), '0 B');
  assert.strictEqual(F.fmtBytes(512), '512 B');
  assert.strictEqual(F.fmtBytes(2048), '2.0 KB');
  assert.strictEqual(F.fmtBytes(1024 * 150), '150 KB'); // >=100 rounds
  assert.strictEqual(F.fmtBytes(1024 * 1024 * 3), '3.0 MB');
});

test('fmtBustTokens: k compaction with 0 special-case', () => {
  assert.strictEqual(F.fmtBustTokens(0), '0');
  assert.strictEqual(F.fmtBustTokens(500), '500');
  assert.strictEqual(F.fmtBustTokens(1500), '1.5k');
  assert.strictEqual(F.fmtBustTokens(25000), '25k');
});

test('fmtAgo: relative buckets', () => {
  const now = Date.now();
  assert.strictEqual(F.fmtAgo(now), 'now');
  assert.strictEqual(F.fmtAgo(now - 5 * 60 * 1000), '5m ago');
  assert.strictEqual(F.fmtAgo(now - 3 * 3600 * 1000), '3h ago');
  assert.strictEqual(F.fmtAgo(now - 2 * 86400 * 1000), '2d ago');
});

test('shortTs: ISO -> "Mon D HH:MM", passthrough on junk', () => {
  assert.strictEqual(F.shortTs('2026-07-04T13:05:22Z'), 'Jul 4 13:05');
  assert.strictEqual(F.shortTs('not-a-date'), 'not-a-date');
  assert.strictEqual(F.shortTs(''), '');
});

test('shortPath: ~-collapses home and elides to last 2 segments', () => {
  const home = os.homedir();
  assert.strictEqual(F.shortPath(''), '');
  // home collapses to ~; ≤2 segments pass through
  assert.strictEqual(F.shortPath(path.join(home, 'projects')), '~/projects');
  // >2 segments elide to …/last2 (the ~ counts as a segment, so it drops out)
  assert.strictEqual(F.shortPath(path.join(home, 'projects', 'clodex')), '…/projects/clodex');
  // more than 2 segments under an absolute path keeps the leading /
  assert.strictEqual(F.shortPath('/var/log/app/sub/deep'), '/…/sub/deep');
  // two-or-fewer segments pass through
  assert.strictEqual(F.shortPath('/etc/hosts'), '/etc/hosts');
});
