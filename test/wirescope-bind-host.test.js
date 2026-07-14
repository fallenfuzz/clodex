'use strict';
// wirescope-bind-host.test.js — the managed uvicorn's bind host. Loopback by
// default (the instance is in-process; _base()/probes stay 127.0.0.1); the
// web-frontend Docker image sets CLODEX_WIRESCOPE_HOST=0.0.0.0 so the full-
// dashboard links can be published on a loopback-mapped host port. The arg
// builder is pure (env passed in) so this needs no uvicorn spawn.

const { test } = require('node:test');
const assert = require('node:assert');
const { wirescopeBindHost, uvicornArgs } = require('../wirescope-supervisor');

test('bind host defaults to loopback and honors CLODEX_WIRESCOPE_HOST', () => {
  assert.equal(wirescopeBindHost({}), '127.0.0.1', 'default is loopback');
  assert.equal(wirescopeBindHost({ CLODEX_WIRESCOPE_HOST: '0.0.0.0' }), '0.0.0.0', 'env widens the bind');
});

test('uvicorn args carry the resolved --host and the port as a string', () => {
  assert.deepEqual(
    uvicornArgs(7800, {}),
    ['-m', 'uvicorn', 'logproxy:app', '--host', '127.0.0.1', '--port', '7800'],
    'default loopback bind',
  );
  assert.deepEqual(
    uvicornArgs(7800, { CLODEX_WIRESCOPE_HOST: '0.0.0.0' }),
    ['-m', 'uvicorn', 'logproxy:app', '--host', '0.0.0.0', '--port', '7800'],
    'container bind widened to 0.0.0.0',
  );
});
