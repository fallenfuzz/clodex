'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseAgentPath, inferProvider } = require('../wire/route');

test('agent path is mandatory', () => {
  assert.equal(parseAgentPath('/v1/messages'), null);
  assert.equal(parseAgentPath('/agent//v1/messages'), null);
  assert.equal(parseAgentPath('/agent/-bad/v1/messages'), null);
});

test('agent name extraction', () => {
  assert.deepEqual(parseAgentPath('/agent/clodex/v1/messages'),
    { agent: 'clodex', rest: '/v1/messages' });
  assert.deepEqual(parseAgentPath('/agent/a.b-c_d'),
    { agent: 'a.b-c_d', rest: '/' });
});

test('provider: anthropic default', () => {
  assert.deepEqual(inferProvider('/v1/messages'),
    { provider: 'anthropic', upstreamPath: '/v1/messages' });
  assert.deepEqual(inferProvider('/v1/messages/count_tokens'),
    { provider: 'anthropic', upstreamPath: '/v1/messages/count_tokens' });
});

test('provider: openai by suffix', () => {
  assert.deepEqual(inferProvider('/v1/chat/completions'),
    { provider: 'openai', upstreamPath: '/v1/chat/completions' });
  assert.deepEqual(inferProvider('/v1/responses'),
    { provider: 'openai', upstreamPath: '/v1/responses' });
});

test('provider: explicit segment wins', () => {
  assert.deepEqual(inferProvider('/openai/v1/models'),
    { provider: 'openai', upstreamPath: '/v1/models' });
  assert.deepEqual(inferProvider('/anthropic/v1/messages'),
    { provider: 'anthropic', upstreamPath: '/v1/messages' });
  assert.deepEqual(inferProvider('/anthropic'),
    { provider: 'anthropic', upstreamPath: '/' });
});
