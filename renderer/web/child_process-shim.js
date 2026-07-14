'use strict';
// child_process-shim.js — browser stand-in for node's `child_process`, aliased
// by esbuild. ssh-run.js (pulled into the graph transitively via peer-deploy.js,
// which the renderer imports for parseDeployLine/classifyDeployFolder/
// classifyPeerDest) does a top-level `const { spawn } = require('child_process')`.
// The browser never spawns anything — peer deploy runs entirely host-side through
// the peer:deploy invoke — so spawn only needs to exist and to fail loudly if a
// code path ever reaches it in the browser.
module.exports = {
  spawn: () => { throw new Error('child_process.spawn is not available in the browser frontend'); },
};
