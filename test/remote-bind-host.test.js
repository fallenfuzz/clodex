'use strict';
// remote-bind-host.test.js — the peer wire (RemoteServer) bind host. Loopback by
// default; the web-frontend container passes host:'0.0.0.0' (from
// CLODEX_REMOTE_HOST, threaded in remote-wiring) so the wire can be published on a
// loopback-mapped host port for desktop→container peering. Desktop passes nothing
// and stays 127.0.0.1-bound.

const { test } = require('node:test');
const assert = require('node:assert');
const { RemoteServer } = require('../remote');

const minimal = (extra) => new RemoteServer({
  port: 0, pagePath: '/nonexistent',
  getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
  ...extra,
});

test('bind host defaults to loopback and honors an explicit host', () => {
  assert.equal(minimal()._host, '127.0.0.1', 'default is loopback');
  assert.equal(minimal({ host: '0.0.0.0' })._host, '0.0.0.0', 'explicit host is stored');
});

test('start() binds on the configured host and reflects the assigned port', async () => {
  const server = minimal({ host: '127.0.0.1' });
  await server.start();
  try {
    assert.equal(server.running, true, 'server came up');
    assert.ok(server.port > 0, 'reflects the OS-assigned port');
  } finally { server.stop(); }
});
