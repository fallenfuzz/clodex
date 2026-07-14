'use strict';
// menubar.test.js — the in-page menu (browser frontend's stand-in for the native
// app menu) fires request-* events into the renderer's own subscribers. This
// guards that every menu item names a channel the renderer actually listens on
// (an `on` row in api-contract) — a typo or a renamed channel would otherwise
// leave a dead menu entry that fails only when a human clicks it.

const test = require('node:test');
const assert = require('node:assert');
const { API_CONTRACT } = require('../api-contract');
const { ITEMS } = require('../renderer/web/menubar');

test('every menu item targets a real request-* on-channel', () => {
  const onChannels = new Set(API_CONTRACT.filter((r) => r.kind === 'on').map((r) => r.channel));
  const entries = ITEMS.filter((it) => it !== '-');
  assert.ok(entries.length >= 8, 'the menu offers a meaningful set of actions');
  for (const [label, channel] of entries) {
    assert.equal(typeof label, 'string', 'item has a label');
    assert.ok(onChannels.has(channel), `menu channel "${channel}" (${label}) is a subscribed on-channel`);
    assert.ok(channel.startsWith('request-'), `menu channel "${channel}" is a request-* event`);
  }
});
