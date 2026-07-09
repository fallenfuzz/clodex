// Run: node --test
// Covers renderer/lib/constants.js — the static UI data tables. Pure data, so
// these are well-formedness smoke tests: shapes present, keys consistent, the
// legend color/label maps aligned. (PEER_UI_KINDS is intentionally NOT here —
// it closes over renderer functions and stays in renderer.js.)
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../renderer/lib/constants');

test('THEMES: three themes, each with a label + full xterm palette', () => {
  assert.deepStrictEqual(Object.keys(C.THEMES), ['midnight', 'claude', 'light']);
  for (const [key, t] of Object.entries(C.THEMES)) {
    assert.strictEqual(typeof t.label, 'string', `${key} label`);
    assert.ok(t.xterm && typeof t.xterm === 'object', `${key} xterm`);
    for (const slot of ['background', 'foreground', 'cursor', 'black', 'white', 'brightWhite']) {
      assert.match(t.xterm[slot], /^#[0-9a-f]{3}([0-9a-f]{3})?$/i, `${key}.${slot} is a hex color`);
    }
  }
});

test('STRIP_LEVELS: levels 0..2, each with name + desc', () => {
  assert.strictEqual(C.STRIP_LEVELS.length, 3);
  C.STRIP_LEVELS.forEach((s, i) => {
    assert.strictEqual(s.lvl, i);
    assert.strictEqual(typeof s.name, 'string');
    assert.strictEqual(typeof s.desc, 'string');
  });
});

test('SEV_LINE: covers every severity bucket', () => {
  for (const k of ['current', 'patch', 'minor', 'major', 'newer', 'unknown']) {
    assert.strictEqual(typeof C.SEV_LINE[k], 'string', `${k} present`);
  }
});

test('CTX_CAT_LABELS: known categories map to display strings', () => {
  assert.strictEqual(C.CTX_CAT_LABELS.tools, 'Tools');
  assert.strictEqual(C.CTX_CAT_LABELS.claudemd, 'CLAUDE.md');
  assert.strictEqual(C.CTX_CAT_LABELS.useremail, 'User email');
});

test('COST_SPINE / COST_CONTENT: keyed color defs', () => {
  assert.deepStrictEqual(C.COST_SPINE.map(d => d.key), ['read', 'write', 'generation']);
  assert.deepStrictEqual(C.COST_CONTENT.map(d => d.key), ['conversation', 'preamble', 'thinking']);
  for (const d of [...C.COST_SPINE, ...C.COST_CONTENT]) {
    assert.strictEqual(typeof d.label, 'string');
    assert.match(d.color, /^#[0-9a-f]{6}$/i);
  }
});

test('BUST_FAULT: content/environment/self each carry cls + label', () => {
  for (const k of ['content', 'environment', 'self']) {
    assert.strictEqual(typeof C.BUST_FAULT[k].cls, 'string');
    assert.strictEqual(typeof C.BUST_FAULT[k].label, 'string');
  }
});

test('REP_* maps: bucket color/label keys align', () => {
  assert.deepStrictEqual(
    Object.keys(C.REP_BUCKET_COLOR).sort(),
    Object.keys(C.REP_BUCKET_LABEL).sort(),
    'every colored bucket has a label and vice versa');
  for (const v of Object.values(C.REP_CAT_COLOR)) {
    assert.match(v, /^#[0-9a-f]{6}$/i);
  }
});
