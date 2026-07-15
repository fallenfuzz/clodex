// pot-bin.js — materializes the pot CLI closure into ~/.clodex/bin/ at launch.
//
// WHY copy at all: a running agent invokes `node "$HOME/.clodex/bin/pot-cli.js"`
// (the grok skill, docs/boiling-pot-plan.md treatment 1), but in the packaged
// app the source lives sealed inside app.asar — not a path an external `node`
// can require across. So we stamp the CLI + its require closure onto a stable,
// always-present path at every launch. Overwrite-always kills version drift: the
// bin/ copy can never lag the app that wrote it.
//
// THE CLOSURE is the single source of truth here and is PINNED by
// test/pot-cli-closure.test.js — it walks pot-cli.js's transitive local
// require()s and asserts every one is in this list, so a future require() added
// to file-heat.js (or its deps) that isn't materialized fails the test rather
// than silently stranding the CLI at runtime. Keep the two in lockstep.
//
// Electron-free leaf (fs/path only) so it's unit-testable and can run headless.
'use strict';

const fs = require('fs');
const path = require('path');

// pot-cli.js first (the entry point), then its transitive local requires.
const POT_CLI_CLOSURE = ['pot-cli.js', 'file-heat.js', 'fs-util.js'];

// Copy the closure from srcDir (the app's install dir) into <root>/bin/,
// overwriting every file every launch. Best-effort: a copy failure is logged and
// skipped, never thrown — the pot drawer still works without the CLI, and the
// skill degrades to "pot unavailable" rather than crashing a launch.
function materializePotCli({ root, srcDir = __dirname, log } = {}) {
  const binDir = path.join(root, 'bin');
  try { fs.mkdirSync(binDir, { recursive: true }); } catch {}
  let copied = 0;
  for (const f of POT_CLI_CLOSURE) {
    try {
      fs.copyFileSync(path.join(srcDir, f), path.join(binDir, f));
      // pot-cli.js is the invokable; the rest are plain requires.
      fs.chmodSync(path.join(binDir, f), f === 'pot-cli.js' ? 0o755 : 0o644);
      copied += 1;
    } catch (e) {
      if (log) log.info('pot', `materialize skipped ${f} (${e && e.message})`);
    }
  }
  return { binDir, copied };
}

module.exports = { POT_CLI_CLOSURE, materializePotCli };
