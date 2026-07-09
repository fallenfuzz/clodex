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
  'app-menus.js',
  'ipc-handlers.js',
  'remote-wiring.js',
  'peer-wiring.js',
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

// The same guard for renderer.js extractions — these modules were carved out of
// renderer/renderer.js, so they leak against ITS module scope, not main.js's.
// findLeaks is parameterized by scope file; this list is scanned against
// renderer/renderer.js. Populated retroactively with every R1/R2 island (the M5
// review proved this bug class ships green — renderer had no guard at all until
// R3) plus every new R3 popover module.
const RENDERER_SCOPE = 'renderer/renderer.js';
const RENDERER_SCANNED_MODULES = [
  'renderer/lib/constants.js',
  'renderer/lib/format.js',
  'renderer/lib/render-html.js',
  'renderer/lib/checklists.js',
  'renderer/ipc-log.js',
  'renderer/term-search.js',
  'renderer/banners.js',
  'renderer/themes.js',
  'renderer/library-drawers.js',
  'renderer/subagent-popover.js',
  'renderer/popovers/report-panel.js',
  'renderer/popovers/cost-popover.js',
  'renderer/popovers/bust-popover.js',
  'renderer/popovers/files-popover.js',
  'renderer/popovers/checklist-popovers.js',
  'renderer/popovers/context-popover.js',
  'renderer/popovers/session-menus.js',
];

// Justified survivors of imperfect stripping. Format: module -> Set of names.
const WHITELIST = {};

function moduleScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) names.add(m[1]);
  // Declaration lists, possibly multi-line: `let a, b,\n  c;` and `const x = …`.
  // The single-`\w+` form this replaced missed continuation lines — that is how
  // the seven stores declared as `let persistence, templates,\n …, uiSettings;`
  // stayed invisible and let ipc-handlers.js leak them all.
  for (const m of src.matchAll(/^(?:const|let) ([\w\s,]+?)(?:;|=)/gm)) {
    for (const n of m[1].split(',')) {
      const t = n.trim();
      if (/^\w+$/.test(t)) names.add(t);
    }
  }
  // Destructures, possibly multi-line — `const { a, b } =`, `let { a } =`, and
  // the whenReady reassignment `({ persistence, … } = initStores(...))`.
  for (const m of src.matchAll(/^(?:const|let)? ?\(?\{([\s\S]*?)\}\s*=/gm)) {
    for (const p of m[1].split(',')) {
      const t = p.split(':')[0].trim();
      if (/^\w+$/.test(t)) names.add(t);
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
  // detection for same-named locals; it cannot create false alarms — BUT a
  // control-flow head like `if (name === activeSession) {` also matches
  // `word ( … ) {`, and absorbing its condition into own-defs silently HID a
  // real missing injection (files-popover.js needed activeSession; the scan
  // stayed green). So the leading token is captured and control keywords are
  // excluded — a `\w+(` head that is if/for/while/switch/catch/return/do/…/an
  // operator keyword is a statement, not a call/definition, and its parens hold
  // an expression, never a parameter list. `function(` (anonymous) still counts.
  const CONTROL_KW = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else',
    'typeof', 'await', 'new', 'in', 'of', 'instanceof', 'void', 'delete', 'yield',
  ]);
  for (const m of src.matchAll(/(?:\bfunction\s*\w*|(\w+))\s*\(([^()]*)\)\s*(?:\{|=>)/gs)) {
    if (m[1] && CONTROL_KW.has(m[1])) continue;
    for (const p of m[2].split(',')) {
      const cleaned = p.replace(/[{}[\]]/g, ' ');
      for (const word of cleaned.split(/[\s=:,]+/)) {
        if (/^[a-zA-Z_$][\w$]*$/.test(word)) defs.add(word);
      }
    }
  }
  return defs;
}

// Single left-to-right pass replacing strings, comments, and regex literals
// with blanks — but template literals are lexed structurally, not blanked
// wholesale. A `${…}` interpolation recurses back into code mode with brace-
// depth tracking, so (a) nested backticks inside an interpolation (e.g.
// `shellEsc(`…`)`) no longer flip the lexer state and silently drop the rest of
// the file from the scan, and (b) the interpolation EXPRESSION itself is kept as
// code — a `${diagSummary(...)}` reference is a real use and must be seen.
// Regex ordering can't do this correctly — `'http://x'` defeats comments-first
// (the // inside the string is eaten, unbalancing every quote after it),
// apostrophes in comments defeat strings-first. A regex literal is assumed when
// `/` follows a token that cannot end an expression (so `a / b` division
// survives).
function stripCommentsStringsAndKeys(src) {
  let out = '';
  let i = 0;
  let lastSig = ''; // last significant (non-space) char emitted
  const isRegexPos = () => lastSig === '' || '=(,:;!&|?{}[+-*%<>~^'.includes(lastSig);
  // Consume code until the matching close of the current `${…}` (end === '}')
  // or end of source (end === null). Braces balance so object/block braces
  // inside an interpolation don't terminate it early.
  function code(end) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (end === '}' && c === '}' && depth === 0) return;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (c === "'" || c === '"') { str(c); continue; }
      if (c === '`') { tpl(); continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '/' && isRegexPos()) { rex(); continue; }
      out += c; if (!/\s/.test(c)) lastSig = c; i++;
    }
  }
  function str(q) { i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; i++; out += q + q; lastSig = q; }
  function tpl() {
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; out += '('; lastSig = '('; code('}'); i++; out += ')'; lastSig = ')'; continue; }
      i++;
    }
    i++; out += '``'; lastSig = '`';
  }
  function rex() {
    i++;
    let inClass = false;
    while (i < src.length && (inClass || src[i] !== '/')) {
      if (src[i] === '\\') i += 2;
      else { if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; i++; }
    }
    i++;
    while (i < src.length && /[gimsuy]/.test(src[i])) i++;
    out += '""'; lastSig = '"';
  }
  code(null);
  return out
    // Property accesses (`intent.path`, `pty.spawn`) never resolve against
    // module scope — drop the `.name` part, keep the receiver.
    .replace(/\.\s*[a-zA-Z_$][\w$]*/g, '.')
    // Object-literal keys (`Notification: [...]` in the hooks config) are
    // identifier tokens but not variable references — drop `key:` after an
    // opening brace or comma. Ternary `?:` colons don't match (no {, before).
    .replace(/([{,]\s*)\w+\s*:/g, '$1');
}

function findLeaks(moduleFile, scopeFile = 'main.js') {
  const scopeSrc = fs.readFileSync(path.join(ROOT, scopeFile), 'utf8');
  const modSrc = fs.readFileSync(path.join(ROOT, moduleFile), 'utf8');
  const scopeNames = moduleScopeNames(scopeSrc);
  const defs = ownDefinitions(modSrc);
  const wl = WHITELIST[moduleFile] || new Set();
  const used = new Set(stripCommentsStringsAndKeys(modSrc).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => scopeNames.has(n) && !defs.has(n) && !wl.has(n)).sort();
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

for (const mod of RENDERER_SCANNED_MODULES) {
  test(`${mod} references no renderer.js-only identifiers`, () => {
    const leaks = findLeaks(mod, RENDERER_SCOPE);
    assert.deepStrictEqual(
      leaks, [],
      `free identifiers leaked from renderer.js scope (add to init params + destructure): ${leaks.join(', ')}`,
    );
  });
}

// Scanner self-tests — lock in the two defects whose fix caught the M5 escape.
// Each reproduces the exact shape that let a real leak hide: without the fix the
// asserted token is absent and the module scan silently passes over the leak.
const tokensOf = (s) =>
  new Set(stripCommentsStringsAndKeys(s).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);

test('stripper keeps interpolation expressions as code', () => {
  // `${diagSummary(d)}` is a real reference — blanking template interiors is how
  // diagSummary leaked from session-manager.js unseen for a whole phase.
  const toks = tokensOf('const s = `cwd=${cwd} ${diagSummary(d)}`;');
  assert.ok(toks.has('diagSummary'), 'reference inside ${…} was dropped');
  assert.ok(toks.has('cwd'), 'reference inside ${…} was dropped');
});

test('stripper survives a nested backtick inside an interpolation', () => {
  // The shellEsc shape from ipc-handlers.js — a template within a ${…} within a
  // template. Whole-literal blanking flipped the lexer on the inner backtick and
  // dropped the rest of the file (that is how the `workspaces` use hid).
  const toks = tokensOf('const a = `x${shellEsc(`y`)}z`; afterMarker;');
  assert.ok(toks.has('shellEsc'), 'token inside a nested template was dropped');
  assert.ok(toks.has('afterMarker'), 'code after a nested template was dropped');
});

test('moduleScopeNames collects a multi-line declaration list', () => {
  // `let persistence, templates,\n  …, uiSettings;` — the seven-store shape.
  const names = moduleScopeNames('let persistence, templates,\n  agentLibrary, uiSettings;');
  for (const n of ['persistence', 'templates', 'agentLibrary', 'uiSettings']) {
    assert.ok(names.has(n), `multi-line let list missed ${n}`);
  }
});

test('moduleScopeNames collects a multi-line destructure', () => {
  // The whenReady store reassignment shape `({ a, b,\n c } = initStores(x))`.
  const names = moduleScopeNames('({ persistence, templates,\n  skillLibrary, uiSettings } = initStores(x));');
  for (const n of ['persistence', 'templates', 'skillLibrary', 'uiSettings']) {
    assert.ok(names.has(n), `multi-line destructure missed ${n}`);
  }
});

test('ownDefinitions does not absorb a control-flow condition as a parameter', () => {
  // `if (name === activeSession) {` matches the `word ( … ) {` param shape, so the
  // pre-hardening matcher pulled activeSession into own-defs and silently HID the
  // missing injection (files-popover.js's R3 escape). A control keyword before
  // `(` is a statement, not a definition — its condition holds no parameters.
  const defs = ownDefinitions('function f(a) {\n  if (a === leakedName) {\n    return;\n  }\n}');
  assert.ok(defs.has('a'), 'real parameter a was dropped');
  assert.ok(!defs.has('leakedName'), 'if-condition token was absorbed as a param');
  // The other control heads share the shape — none may absorb their condition.
  for (const kw of ['for', 'while', 'switch', 'catch', 'return']) {
    const d = ownDefinitions(`${kw} (x === sneaky) {}`);
    assert.ok(!d.has('sneaky'), `${kw}-condition token was absorbed as a param`);
  }
});
