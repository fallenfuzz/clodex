// Run: node --test
// Touched-files feed: the wire-side SSE collector (streamed input_json_delta
// reassembly, hot-path gating, give-up cap) and the pure jsonl extraction +
// ring semantics (dedupe-by-path, newest-first, cap, subagent badge).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { FileToolCollector } = require('../wire/sse');
const { extractFileTouches, noteFileTouches, TOUCH_RING_CAP } = require('../file-touch');

// --- wire/sse.js FileToolCollector -----------------------------------------

const ev = (type, obj) => [type, JSON.stringify({ type, ...obj })];

function feedToolUse(c, index, name, jsonChunks) {
  c.onEvent(...ev('content_block_start', { index, content_block: { type: 'tool_use', name, input: {} } }));
  for (const chunk of jsonChunks) {
    c.onEvent(...ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: chunk } }));
  }
  c.onEvent(...ev('content_block_stop', { index }));
}

test('collector: reassembles file_path split across deltas', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Edit', ['{"file_pa', 'th": "/tmp/a', '.js", "old_string": "x"']);
  assert.deepStrictEqual(c.files, [{ tool: 'Edit', path: '/tmp/a.js' }]);
});

test('collector: path key not first (real Edit streams replace_all ahead)', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Edit', ['{"replace_all": false, ', '"file_path": "/w/b.py"', ', "old_string": "y"']);
  assert.deepStrictEqual(c.files, [{ tool: 'Edit', path: '/w/b.py' }]);
});

test('collector: notebook_path, escaped characters unescaped', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 2, 'NotebookEdit', ['{"notebook_path": "/tmp/sp ace\\\\n.ipynb"}']);
  assert.strictEqual(c.files[0].path, '/tmp/sp ace\\n.ipynb');
});

test('collector: non-file tools and text blocks ignored', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Bash', ['{"command": "rm -rf /tmp/x"}']);
  c.onEvent(...ev('content_block_start', { index: 1, content_block: { type: 'text' } }));
  c.onEvent(...ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'hi' } }));
  assert.deepStrictEqual(c.files, []);
});

test('collector: two file tools in one stream, order kept', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Write', ['{"file_path": "/a", "content": "1"}']);
  feedToolUse(c, 1, 'Edit', ['{"file_path": "/b", "old_string": "1"}']);
  assert.deepStrictEqual(c.files.map((f) => f.path), ['/a', '/b']);
});

test('collector: stops accumulating after the path is found', () => {
  const c = new FileToolCollector();
  c.onEvent(...ev('content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'Write', input: {} } }));
  c.onEvent(...ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/done"' } }));
  // path already extracted — a later huge delta must not grow anything
  const big = 'x'.repeat(200000);
  c.onEvent(...ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: big } }));
  c.onEvent(...ev('content_block_stop', { index: 0 }));
  assert.deepStrictEqual(c.files, [{ tool: 'Write', path: '/done' }]);
});

test('collector: gives up past the cap when no path key ever arrives', () => {
  const c = new FileToolCollector();
  const chunks = [];
  for (let i = 0; i < 80; i++) chunks.push('"pad": "' + 'z'.repeat(1000) + '", ');
  feedToolUse(c, 0, 'Edit', ['{'].concat(chunks));
  assert.deepStrictEqual(c.files, []);
});

test('collector: garbage data and unrelated events are inert', () => {
  const c = new FileToolCollector();
  c.onEvent('content_block_delta', 'not json');
  c.onEvent('message_start', JSON.stringify({ type: 'message_start', message: {} }));
  c.onEvent(null, JSON.stringify({ type: 'content_block_stop', index: 9 }));
  assert.deepStrictEqual(c.files, []);
  assert.deepStrictEqual(c.reads, []);
});

// --- Read channel (boiling pot tier 1) --------------------------------------

test('collector: a Read is captured into reads with offset/limit, never files', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_path": "/tmp/big.js", "offset": 100, "limit": 50}']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/tmp/big.js', offset: 100, limit: 50 }]);
  assert.deepStrictEqual(c.files, []); // a Read is not a mutation
});

test('collector: a Read without offset/limit omits those keys', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_path": "/a/b.py"}']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/a/b.py' }]);
});

test('collector: Read input split across deltas parses at stop', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_pa', 'th": "/split', '/x.js", "limit"', ': 20}']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/split/x.js', limit: 20 }]);
});

test('collector: Reads and mutations stay in strictly separate channels', () => {
  const c = new FileToolCollector();
  feedToolUse(c, 0, 'Read', ['{"file_path": "/r1"}']);
  feedToolUse(c, 1, 'Edit', ['{"file_path": "/e1", "old_string": "x"}']);
  feedToolUse(c, 2, 'Write', ['{"file_path": "/w1", "content": "y"}']);
  feedToolUse(c, 3, 'Read', ['{"file_path": "/r2", "offset": 5}']);
  // No cross-contamination: files = mutations only, reads = Reads only.
  assert.deepStrictEqual(c.files, [{ tool: 'Edit', path: '/e1' }, { tool: 'Write', path: '/w1' }]);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/r1' }, { tool: 'Read', path: '/r2', offset: 5 }]);
});

test('collector: a malformed Read input still yields the path via regex fallback', () => {
  const c = new FileToolCollector();
  // trailing garbage → JSON.parse fails; the path regex still matches, and
  // offset/limit are simply absent (best-effort, no partial number guessing).
  feedToolUse(c, 0, 'Read', ['{"file_path": "/frag.js", "offset": 10 NOPE']);
  assert.deepStrictEqual(c.reads, [{ tool: 'Read', path: '/frag.js' }]);
});

test('collector: an oversized Read input is dropped (memory bound)', () => {
  const c = new FileToolCollector();
  const chunks = [];
  for (let i = 0; i < 80; i++) chunks.push('"pad": "' + 'z'.repeat(1000) + '", ');
  feedToolUse(c, 0, 'Read', ['{'].concat(chunks).concat(['"file_path": "/late"}']));
  assert.deepStrictEqual(c.reads, []); // exceeded the cap before stop — dropped
});

// --- file-touch.js ----------------------------------------------------------

const asst = (blocks, extra = {}) => ({ type: 'assistant', message: { content: blocks }, ...extra });

test('extractFileTouches: pulls file tools from a Claude assistant entry', () => {
  const got = extractFileTouches(asst([
    { type: 'text', text: 'editing' },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/n.ipynb' } },
  ]));
  assert.deepStrictEqual(got, [
    { tool: 'Edit', path: '/a', sub: false },
    { tool: 'NotebookEdit', path: '/n.ipynb', sub: false },
  ]);
});

test('extractFileTouches: sidechain entries flagged sub', () => {
  const got = extractFileTouches(asst(
    [{ type: 'tool_use', name: 'Write', input: { file_path: '/s' } }],
    { isSidechain: true },
  ));
  assert.strictEqual(got[0].sub, true);
});

test('extractFileTouches: non-assistant / malformed → []', () => {
  assert.deepStrictEqual(extractFileTouches({ type: 'user' }), []);
  assert.deepStrictEqual(extractFileTouches(null), []);
  assert.deepStrictEqual(extractFileTouches(asst('not-an-array')), []);
  assert.deepStrictEqual(extractFileTouches(asst([{ type: 'tool_use', name: 'Edit', input: {} }])), []);
});

test('noteFileTouches: dedupe by path, newest first, count accumulates', () => {
  const ring = [];
  noteFileTouches(ring, [{ tool: 'Write', path: '/a' }], { ts: 1, resolve: path.resolve });
  noteFileTouches(ring, [{ tool: 'Edit', path: '/b' }], { ts: 2, resolve: path.resolve });
  noteFileTouches(ring, [{ tool: 'Edit', path: '/a' }], { ts: 3, resolve: path.resolve });
  assert.strictEqual(ring.length, 2);
  assert.deepStrictEqual(ring[0], { path: '/a', tool: 'Edit', ts: 3, count: 2, sub: false });
  assert.strictEqual(ring[1].path, '/b');
});

test('noteFileTouches: relative paths resolve against cwd; sub badge sticks', () => {
  const ring = [];
  noteFileTouches(ring, [{ tool: 'Edit', path: 'src/x.js' }], { cwd: '/proj', ts: 1, sub: true, resolve: path.resolve });
  noteFileTouches(ring, [{ tool: 'Edit', path: '/proj/src/x.js' }], { cwd: '/proj', ts: 2, resolve: path.resolve });
  assert.strictEqual(ring.length, 1);
  assert.strictEqual(ring[0].path, '/proj/src/x.js');
  assert.strictEqual(ring[0].sub, true); // once via subagent, badge stays
});

test('noteFileTouches: ring capped', () => {
  const ring = [];
  for (let i = 0; i < TOUCH_RING_CAP + 10; i++) {
    noteFileTouches(ring, [{ tool: 'Write', path: `/f${i}` }], { ts: i, resolve: path.resolve });
  }
  assert.strictEqual(ring.length, TOUCH_RING_CAP);
  assert.strictEqual(ring[0].path, `/f${TOUCH_RING_CAP + 9}`); // newest kept
});

// --- [agent:file view|open] vetting -------------------------------------------
// The first intent whose effect reaches the operator's screen — every clause
// is a guard and each must independently refuse. fs is injected as a tiny
// fake: `world` maps realpath results to stat facts.
const { vetFileIntent } = require('../file-touch');

function fakeFs(world) {
  return {
    resolve: path.resolve,
    extname: path.extname,
    realpath: (p) => {
      const w = world[p];
      if (!w) throw new Error('ENOENT');
      return w.real || p;
    },
    stat: (p) => {
      const w = Object.values(world).find((e) => (e.real || null) === p) || world[p];
      if (!w) throw new Error('ENOENT');
      return { isFile: () => w.file !== false, mode: w.mode ?? 0o644 };
    },
  };
}

test('vetFileIntent: relative path resolves against cwd and opens', () => {
  const fs2 = fakeFs({ '/proj/report.md': {} });
  const r = vetFileIntent({ sub: 'open', rawPath: 'report.md', cwd: '/proj', ...fs2 });
  assert.deepStrictEqual(r, { ok: true, path: '/proj/report.md' });
});

test('vetFileIntent: unknown sub, missing path, missing file all refuse', () => {
  const fs2 = fakeFs({ '/proj/a.md': {} });
  assert.strictEqual(vetFileIntent({ sub: 'edit', rawPath: 'a.md', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: '   ', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'gone.md', cwd: '/proj', ...fs2 }).ok, false);
});

test('vetFileIntent: symlink is followed BEFORE the checks (no bait-and-switch)', () => {
  // innocent.md is a symlink to a script with the exec bit: the vet must judge
  // the TARGET, not the name the agent handed us.
  const fs2 = fakeFs({ '/proj/innocent.md': { real: '/proj/run.sh', mode: 0o755 } });
  const r = vetFileIntent({ sub: 'open', rawPath: 'innocent.md', cwd: '/proj', ...fs2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /executable/);
});

test('vetFileIntent: directories and non-files refuse', () => {
  const fs2 = fakeFs({ '/proj/dir': { file: false } });
  assert.strictEqual(vetFileIntent({ sub: 'view', rawPath: 'dir', cwd: '/proj', ...fs2 }).ok, false);
});

test('vetFileIntent: open refuses launchable extensions and exec bits; view allows them', () => {
  const fs2 = fakeFs({
    '/proj/run.command': {},
    '/proj/tool.jar': {},
    '/proj/script.py': { mode: 0o755 },
  });
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'run.command', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'tool.jar', cwd: '/proj', ...fs2 }).ok, false);
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'script.py', cwd: '/proj', ...fs2 }).ok, false);
  // view only renders bytes in our modal — never launches, so all three pass
  for (const p of ['run.command', 'tool.jar', 'script.py']) {
    assert.strictEqual(vetFileIntent({ sub: 'view', rawPath: p, cwd: '/proj', ...fs2 }).ok, true, p);
  }
});

test('vetFileIntent: extension casing does not dodge the denylist', () => {
  const fs2 = fakeFs({ '/proj/X.COMMAND': {} });
  assert.strictEqual(vetFileIntent({ sub: 'open', rawPath: 'X.COMMAND', cwd: '/proj', ...fs2 }).ok, false);
});

test('vetFileIntent: absolute paths outside cwd are allowed (cwd only anchors relatives)', () => {
  const fs2 = fakeFs({ '/elsewhere/notes.md': {} });
  const r = vetFileIntent({ sub: 'open', rawPath: '/elsewhere/notes.md', cwd: '/proj', ...fs2 });
  assert.deepStrictEqual(r, { ok: true, path: '/elsewhere/notes.md' });
});
