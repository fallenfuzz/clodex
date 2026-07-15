'use strict';
// pot-cli-closure.test.js — pins the boiling-pot CLI's materialized closure
// (pot-bin.js POT_CLI_CLOSURE) against pot-cli.js's ACTUAL transitive local
// require()s. The CLI runs from ~/.clodex/bin/ where only the materialized files
// exist, so a local require() that isn't in the closure strands the CLI at
// runtime for the user. This test makes that a red test at dev time instead:
// add `require('./newdep')` to file-heat.js and forget to materialize it → fail.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { POT_CLI_CLOSURE, materializePotCli } = require('../pot-bin');

const ROOT = path.join(__dirname, '..');

// Walk the transitive closure of LOCAL requires (`require('./x')`) starting at
// pot-cli.js. Bare requires (node builtins, node_modules) are intentionally
// ignored — those resolve identically from ~/.clodex/bin/, only local files must
// be copied. Returns the set of basenames reachable, entry included.
function localClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  const RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let m;
    while ((m = RE.exec(src)) !== null) {
      let rel = m[1];
      if (!rel.endsWith('.js')) rel += '.js';
      const resolved = path.normalize(path.join(path.dirname(file), rel));
      stack.push(resolved);
    }
  }
  return seen;
}

test('POT_CLI_CLOSURE covers every transitive local require of pot-cli.js', () => {
  const reachable = localClosure('pot-cli.js');
  const listed = new Set(POT_CLI_CLOSURE);
  const missing = [...reachable].filter((f) => !listed.has(f));
  assert.deepStrictEqual(missing, [],
    `pot-cli.js reaches local files NOT materialized by pot-bin.js — the CLI would break from ~/.clodex/bin/: ${missing}`);
});

test('POT_CLI_CLOSURE has no dead entries (every listed file exists + is reached)', () => {
  const reachable = localClosure('pot-cli.js');
  for (const f of POT_CLI_CLOSURE) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `listed closure file missing on disk: ${f}`);
    assert.ok(reachable.has(f), `listed closure file not actually reached by pot-cli.js (dead entry): ${f}`);
  }
});

test('the entry point pot-cli.js is itself in the closure', () => {
  assert.ok(POT_CLI_CLOSURE.includes('pot-cli.js'), 'pot-cli.js must be materialized');
});

test('materializePotCli copies the whole closure into <root>/bin and marks pot-cli executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potbin-'));
  try {
    const { binDir, copied } = materializePotCli({ root, srcDir: ROOT });
    assert.strictEqual(copied, POT_CLI_CLOSURE.length, 'every closure file copied');
    for (const f of POT_CLI_CLOSURE) {
      assert.ok(fs.existsSync(path.join(binDir, f)), `materialized: ${f}`);
    }
    // pot-cli.js gets the executable bit; the plain requires do not.
    assert.ok(fs.statSync(path.join(binDir, 'pot-cli.js')).mode & 0o100, 'pot-cli.js is executable');
    // Overwrite-always: a second run doesn't throw and leaves the closure intact.
    const again = materializePotCli({ root, srcDir: ROOT });
    assert.strictEqual(again.copied, POT_CLI_CLOSURE.length, 'idempotent overwrite');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
