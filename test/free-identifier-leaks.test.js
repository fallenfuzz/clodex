// Regression guard for the M3/M4 class of bug: an extracted module referencing
// a main.js module-scope identifier that was never injected through its deps
// object / factory params. Those are free identifiers — a ReferenceError at
// runtime — and they only explode when the code path runs. Three real escapes
// motivated this: the five cli-hooks fns missing from SessionManager's deps
// (broke session restore), POLL_INTERVAL/TURN_COMPLETE_TIMEOUT left behind by
// the JsonlWatcher move (broke every non-wire agent spawn), and five
// identifiers missing from createProxyPoller (killed the status bar silently —
// the tick's .catch(() => {}) ate the ReferenceError). All shipped green
// through the unit suite because their paths need a PTY / live proxy.
//
// Heuristic static scan, not a parser: collect main.js's module-scope names,
// collect the module's own definitions (functions, classes, consts, deps
// destructures, function/factory params), strip comments/strings/object keys,
// and flag any identifier the module uses that only main.js defines.
// Imperfect stripping means a small per-module whitelist; every entry must be
// justified inline.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Every module extracted from main.js. New extraction phases MUST add their
// modules here (M5: ipc-handlers, remote-wiring, peer-wiring, app-menus).
const SCANNED_MODULES = [
  'session-manager.js',
  'jsonl-watcher.js',
  'wirescope-proxy.js',
  'wirescope-supervisor.js',
  'cli-hooks.js',
  'agent-transport.js',
  'update-checker.js',
  'ipc-prompt.js',
  'stores.js',
  'catalogs.js',
  'statusline.js',
  'intent-scanner.js',
  'argv-merge.js',
  'transcript.js',
  'fs-util.js',
];

// Justified survivors of imperfect stripping. Format: module -> Set of names.
const WHITELIST = {};

function moduleScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let) (\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let) \{([^}]+)\}/gm)) {
    for (const p of m[1].split(',')) {
      const n = p.split(':')[0].trim();
      if (/^\w+$/.test(n)) names.add(n);
    }
  }
  return names;
}

function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function ownDefinitions(rawSrc) {
  // Comments first — a paren inside a comment embedded in a multi-line
  // factory param list breaks the param matcher otherwise.
  const src = stripComments(rawSrc);
  const defs = new Set();
  for (const m of src.matchAll(/^\s*(?:async )?function (\w+)/gm)) defs.add(m[1]);
  for (const m of src.matchAll(/\bclass (\w+)/g)) defs.add(m[1]);
  for (const m of src.matchAll(/^\s*(?:const|let) (\w+)/gm)) defs.add(m[1]);
  // Destructured requires/assignments: const { a, b: c } = anything
  for (const m of src.matchAll(/(?:const|let) \{([\s\S]*?)\}\s*=/g)) {
    for (const p of m[1].split(',')) {
      const n = p.split(/[:/]/)[0].trim();
      if (/^\w+$/.test(n)) defs.add(n);
    }
  }
  // Function/method parameters, including destructured factory deps objects —
  // matches `function f(a, { b, c } = {})` across lines, method shorthand, and
  // arrows with parenthesized params. Over-collection here only weakens
  // detection for same-named locals; it cannot create false alarms.
  for (const m of src.matchAll(/(?:function\s*\w*|\w+)\s*\(([^()]*)\)\s*(?:\{|=>)/gs)) {
    for (const p of m[1].split(',')) {
      const cleaned = p.replace(/[{}[\]]/g, ' ');
      for (const word of cleaned.split(/[\s=:,]+/)) {
        if (/^[a-zA-Z_$][\w$]*$/.test(word)) defs.add(word);
      }
    }
  }
  return defs;
}

// Single left-to-right pass replacing strings, template literals, comments,
// and regex literals with blanks. Regex ordering can't do this correctly —
// `'http://x'` defeats comments-first (the // inside the string is eaten,
// unbalancing every quote after it), apostrophes in comments defeat
// strings-first. A regex literal is assumed when `/` follows a token that
// cannot end an expression (so `a / b` division survives).
function stripCommentsStringsAndKeys(src) {
  let out = '';
  let i = 0;
  let lastSig = ''; // last significant (non-space) char emitted
  const isRegexPos = () => lastSig === '' || '=(,:;!&|?{}[+-*%<>~^'.includes(lastSig);
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      i++;
      out += q === '`' ? '``' : "''";
      lastSig = q;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '/' && isRegexPos()) {
      i++;
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i += 2;
        else { if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; i++; }
      }
      i++;
      while (i < src.length && /[gimsuy]/.test(src[i])) i++;
      out += '""';
      lastSig = '"';
    } else {
      out += c;
      if (!/\s/.test(c)) lastSig = c;
      i++;
    }
  }
  return out
    // Property accesses (`intent.path`, `pty.spawn`) never resolve against
    // module scope — drop the `.name` part, keep the receiver.
    .replace(/\.\s*[a-zA-Z_$][\w$]*/g, '.')
    // Object-literal keys (`Notification: [...]` in the hooks config) are
    // identifier tokens but not variable references — drop `key:` after an
    // opening brace or comma. Ternary `?:` colons don't match (no {, before).
    .replace(/([{,]\s*)\w+\s*:/g, '$1');
}

function findLeaks(moduleFile) {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const modSrc = fs.readFileSync(path.join(ROOT, moduleFile), 'utf8');
  const mainNames = moduleScopeNames(mainSrc);
  const defs = ownDefinitions(modSrc);
  const wl = WHITELIST[moduleFile] || new Set();
  const used = new Set(stripCommentsStringsAndKeys(modSrc).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => mainNames.has(n) && !defs.has(n) && !wl.has(n)).sort();
}

for (const mod of SCANNED_MODULES) {
  test(`${mod} references no main.js-only identifiers`, () => {
    const leaks = findLeaks(mod);
    assert.deepStrictEqual(
      leaks, [],
      `free identifiers leaked from main.js scope (add to deps + destructure): ${leaks.join(', ')}`,
    );
  });
}
