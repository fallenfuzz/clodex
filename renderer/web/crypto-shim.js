'use strict';
// crypto-shim.js — browser stand-in for node's `crypto`, aliased by esbuild.
// proxy-util.js does a top-level `const crypto = require('crypto')` for
// mintProxyAgent's default RNG; the renderer never calls mintProxyAgent (agent
// minting is host-side), but the module body still runs when proxy-util loads,
// so this only needs to exist. randomBytes is implemented over Web Crypto in case
// it is ever called, returning a Buffer-like with the same `.toString('hex')`.
module.exports = {
  randomBytes: (n) => {
    const u8 = new Uint8Array(n);
    (globalThis.crypto || {}).getRandomValues?.(u8);
    return {
      toString: (enc) => (enc === 'hex' || !enc)
        ? Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
        : String.fromCharCode(...u8),
    };
  },
};
