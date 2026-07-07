'use strict';

// Pure helpers for the touched-files feed: which files a session's agent aimed
// its file-mutating tools at. Two taps feed this (same split as intents):
//   wire    — wire/sse.js FileToolCollector, riding turn.completed `files`
//   jsonl   — extractFileTouches() below, for the legacy JsonlWatcher path
//             (wire-failed spawns, CLODEX_WIRE_INTENTS=0)
// Kept out of main.js so ring + extraction semantics are unit-testable without
// booting Electron (proxy-util.js precedent).
//
// FACTS ONLY: a touch records tool + path + when. created-vs-modified is NOT
// decided here — the peek/diff UI asks git, which is ground truth. A recorded
// touch may also over-report (a denied/failed tool call still streamed its
// input); the diff view shows what actually happened.

// Mirrors wire/sse.js FILE_TOOLS — keep in sync (MultiEdit is legacy-CLI).
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const TOUCH_RING_CAP = 50;

// Claude transcript entry → [{ tool, path, sub }]. Assistant entries carry
// complete tool_use inputs (no streaming reassembly needed). Subagent turns
// land in the same transcript flagged isSidechain. Codex entries: not yet
// handled (different event shape; wire-routed sessions are the priority).
function extractFileTouches(obj) {
  if (!obj || obj.type !== 'assistant') return [];
  const content = (obj.message || {}).content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || block.type !== 'tool_use' || !FILE_TOOLS.has(block.name)) continue;
    const input = block.input || {};
    const p = typeof input.file_path === 'string' ? input.file_path
      : (typeof input.notebook_path === 'string' ? input.notebook_path : null);
    if (p) out.push({ tool: block.name, path: p, sub: obj.isSidechain === true });
  }
  return out;
}

// Fold new touches into a session's ring (newest first, deduped by path —
// latest tool/ts wins, count accumulates). Mutates and returns `ring`.
// `files` entries: { tool, path } (+ optional sub); relative paths resolve
// against `cwd` via the injected `resolve` (path.resolve — injected so tests
// stay platform-pure).
function noteFileTouches(ring, files, { cwd, ts, sub = false, resolve }) {
  for (const f of files || []) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    const abs = resolve && cwd ? resolve(cwd, f.path) : f.path;
    const entrySub = f.sub === true || sub;
    const i = ring.findIndex((e) => e.path === abs);
    if (i >= 0) {
      const e = ring.splice(i, 1)[0];
      e.tool = f.tool;
      e.ts = ts;
      e.count += 1;
      // once any touch came through a subagent, keep the badge — the row is
      // per-path, and "a subagent was in here" stays true
      e.sub = e.sub || entrySub;
      ring.unshift(e);
    } else {
      ring.unshift({ path: abs, tool: f.tool, ts, count: 1, sub: entrySub });
    }
  }
  if (ring.length > TOUCH_RING_CAP) ring.length = TOUCH_RING_CAP;
  return ring;
}

// --- [agent:file view|open <path>] vetting -----------------------------------
// First intent whose effect reaches the OPERATOR'S SCREEN (view = Clodex's
// peek modal, open = the default local app), so every clause is a guard:
//   - resolve against the session's cwd, then realpath — the file the checks
//     approve is the file that opens (no symlink bait-and-switch)
//   - regular files only (directories, sockets, /dev nodes all refused)
//   - `open` refuses anything launchable: extension denylist for types macOS
//     `open` EXECUTES rather than displays (.command runs in Terminal, .jar
//     runs under Java, .pkg/.dmg reach the installer...) plus any exec-bit
//     file. "Agent text can launch programs" is a line we don't cross —
//     `view` still works on those, it only ever renders bytes in our modal.
// fs access (realpath/stat) is injected so the policy stays unit-testable.
const FILE_INTENT_DENY_EXT = new Set([
  'app', 'command', 'tool', 'terminal', 'workflow', 'action', 'scpt', 'scptd',
  'jar', 'pkg', 'mpkg', 'dmg', 'osax', 'service',
]);

function vetFileIntent({ sub, rawPath, cwd, resolve, extname, realpath, stat }) {
  if (sub !== 'view' && sub !== 'open') {
    return { ok: false, error: `unknown sub-command "${sub}" (use view|open)` };
  }
  const trimmed = (rawPath || '').trim();
  if (!trimmed) return { ok: false, error: 'missing path — usage: [agent:file view|open <path>]' };
  const wanted = resolve(cwd || '/', trimmed);
  let real, st;
  try { real = realpath(wanted); st = stat(real); }
  catch { return { ok: false, error: `no such file: ${wanted}` }; }
  if (!st.isFile()) return { ok: false, error: `not a regular file: ${real}` };
  if (sub === 'open') {
    const ext = extname(real).slice(1).toLowerCase();
    if (FILE_INTENT_DENY_EXT.has(ext)) {
      return { ok: false, error: `refusing to open a .${ext} (launchable file type) — use [agent:file view] instead` };
    }
    if (st.mode & 0o111) {
      return { ok: false, error: 'refusing to open an executable file — use [agent:file view] instead' };
    }
  }
  return { ok: true, path: real };
}

module.exports = { FILE_TOOLS, TOUCH_RING_CAP, extractFileTouches, noteFileTouches, vetFileIntent, FILE_INTENT_DENY_EXT };
