'use strict';
// build-web.js — produces the browser frontend bundle in web-dist/ (web-frontend
// Phase 3b). Run via `npm run build:web`. web-host.js serves this directory.
//
// Output is a SINGLE self-contained web-dist/index.html with the JS and CSS
// inlined. That is deliberate: the host token-gates every HTTP route, and a
// browser does NOT carry the page's ?token= query onto separate <script>/<link>
// requests — so a one-request page (the token rides its own URL) is the only
// shape that works uniformly for BOTH localhost-trust and tokened mode without
// touching the committed web-host.js. The WebSocket and /exports/ URLs carry the
// token in-query (the shim builds them). For localhost-trust there is no token
// and it works either way.
//
// The body markup is taken from renderer/index.html (the Electron page) so the
// two frontends never drift: we swap its two stylesheet <link>s for the inlined
// CSS and its <script src="renderer.js"> for the inlined bundle. Node builtins
// that the renderer graph touches are aliased to browser shims — os (homedir from
// the welcome frame), crypto (Web Crypto), child_process (throws; never reached).

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'renderer', 'web');
const OUT = path.join(ROOT, 'web-dist');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const alias = {
    os: path.join(WEB, 'os-shim.js'),
    crypto: path.join(WEB, 'crypto-shim.js'),
    child_process: path.join(WEB, 'child_process-shim.js'),
  };

  const js = await esbuild.build({
    entryPoints: [path.join(WEB, 'boot.js')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    alias,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });

  const css = await esbuild.build({
    entryPoints: [path.join(WEB, 'app.css')],
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    logLevel: 'info',
  });

  const jsText = js.outputFiles[0].text;
  const cssText = css.outputFiles[0].text;

  // Take the Electron page's markup and rewrite head/script for the browser build.
  // Each replacement must match exactly once, or the Electron page's markup moved
  // and the browser build would silently drift — so assert on the match, not on a
  // whole-document substring scan (the inlined bundle legitimately contains the
  // strings "renderer.js"/"styles.css" in esbuild's module-path comments).
  const html0 = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const subs = [
    [/[ \t]*<link rel="stylesheet" href="\.\.\/node_modules\/@xterm\/xterm\/css\/xterm\.css">\n?/, '', 'xterm css link'],
    [/[ \t]*<link rel="stylesheet" href="styles\.css">\n?/, `  <style>\n${cssText}\n  </style>\n`, 'styles.css link'],
    [/[ \t]*<script src="renderer\.js"><\/script>/, `  <script>\n${inlineSafe(jsText)}\n  </script>`, 'renderer.js script'],
  ];
  let html = html0;
  for (const [re, repl, label] of subs) {
    if (!re.test(html)) throw new Error(`build-web: could not find the ${label} in renderer/index.html — markup drifted`);
    html = html.replace(re, () => repl);
  }

  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`web-dist/index.html written (${(html.length / 1024).toFixed(0)} KB: ${(jsText.length / 1024).toFixed(0)} KB js + ${(cssText.length / 1024).toFixed(0)} KB css)`);
}

// Guard against a stray `</script>` inside string literals closing the inline tag.
function inlineSafe(s) { return s.replace(/<\/script>/gi, '<\\/script>'); }

main().catch((err) => { console.error(err); process.exit(1); });
