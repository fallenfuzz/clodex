'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PRICES, PRICES_OPENAI, priceFor, round6, billing, billingOpenai, newTotals, bump, Ledger } = require('../wire/billing');

test('round6 matches Python round(): ties-to-even on the exact binary value', () => {
  // exact dyadic ties — toFixed would give ...63 / ...25; Python gives even.
  // Golden-gate regression: 203125 * 0.50 / 1e6 and 78125 * 0.50 / 1e6.
  assert.equal(round6(203125 * 0.50 / 1e6), 0.101562);
  assert.equal(round6(78125 * 0.50 / 1e6), 0.039062);
  assert.equal(round6(0.0000015), 0.000002); // 0.0000015 double is above the true tie
  // non-tie: the double for 1.0000005 sits slightly ABOVE the true tie
  assert.equal(round6(1.0000005), 1.000001);
  assert.equal(round6(0), 0);
  assert.equal(round6(-0.1015625), -0.101562);
  assert.equal(round6(0.026262), 0.026262);
});

test('priceFor: longest prefix wins (opus-4-8 must not hit legacy opus-4)', () => {
  assert.equal(priceFor('claude-opus-4-8-20260115').in, 5.0);
  assert.equal(priceFor('claude-opus-4-1-20250805').in, 15.0); // legacy pricing
  assert.equal(priceFor('claude-fable-5').in, 10.0);
  assert.equal(priceFor('unknown-model'), null);
  assert.equal(priceFor(null), null);
  assert.equal(priceFor('gpt-5.4-mini', PRICES_OPENAI).out, 4.5);
  assert.equal(priceFor('gpt-5.4-turbo', PRICES_OPENAI).out, 15.0); // prefix of 5.4
});

test('billing: TTL-correct pricing, asymmetric start/final fallbacks', () => {
  const b = billing('messages', {
    modelResolved: 'claude-sonnet-4-5-20250929',
    usageStart: {
      input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      service_tier: 'standard',
    },
    usageFinal: { output_tokens: 500 },
  });
  const t = b.tokens;
  assert.equal(t.input_tokens, 4);            // final absent → start
  assert.equal(t.output_tokens, 500);          // final ONLY
  assert.equal(t.cache_read_input_tokens, 10000);
  assert.equal(t.cache_write_5m_tokens, 1000);
  assert.equal(t.cache_write_1h_tokens, 2000);
  assert.equal(t.cache_write_flat_tokens, 3000);
  assert.equal(t.service_tier, 'standard');    // start ONLY
  // 4*3 + 500*15 + 10000*0.30 + 1000*3.75 + 2000*6.0, per 1M
  assert.equal(b.est_usd, 0.026262);
  assert.equal(b.unpriced, false);
});

test('billing: output_tokens never falls back to message_start', () => {
  const b = billing('messages', {
    modelResolved: 'claude-haiku-4-5-20251001',
    usageStart: { input_tokens: 10, output_tokens: 7 },
    usageFinal: { input_tokens: 10 },
  });
  assert.equal(b.tokens.output_tokens, null);
});

test('billing: flat cache_creation total priced at the 5m rate when split absent', () => {
  const b = billing('messages', {
    modelResolved: 'claude-haiku-4-5-20251001',
    usageFinal: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 800 },
  });
  assert.equal(b.tokens.cache_write_5m_tokens, null); // reported as absent
  assert.equal(b.tokens.cache_write_flat_tokens, 800);
  // 100*1 + 10*5 + 800*1.25 per 1M = 0.0001 + 0.00005 + 0.001
  assert.equal(b.est_usd, 0.00115);
  assert.match(b.price_basis, /flat total priced at 5m rate/);
});

test('billing: empty cache_creation in usage_final falls through to usage_start (py or-semantics)', () => {
  const b = billing('messages', {
    modelResolved: 'claude-opus-4-8',
    usageStart: { cache_creation: { ephemeral_5m_input_tokens: 400 } },
    usageFinal: { output_tokens: 1, cache_creation: {} },
  });
  assert.equal(b.tokens.cache_write_5m_tokens, 400);
});

test('billing: unpriced model is loud, not a silent zero', () => {
  const b = billing('messages', {
    modelResolved: 'claude-nova-9', usageFinal: { input_tokens: 5, output_tokens: 5 },
  });
  assert.equal(b.est_usd, null);
  assert.equal(b.unpriced, true);
});

test('billing: count_tokens is not billed for tokens', () => {
  const b = billing('count_tokens', { countTokens: { input_tokens: 1234 } });
  assert.equal(b.billable, false);
  assert.equal(b.counted_input_tokens, 1234);
  assert.equal(b.est_usd, 0.0);
});

test('billingOpenai: cached portion split out of input_tokens, reasoning as thinking', () => {
  const b = billingOpenai('gpt-5.3-codex', {
    input_tokens: 10000, input_tokens_details: { cached_tokens: 8000 },
    output_tokens: 1000, output_tokens_details: { reasoning_tokens: 600 },
  });
  assert.equal(b.tokens.input_tokens, 2000);
  assert.equal(b.tokens.cache_read_input_tokens, 8000);
  assert.equal(b.tokens.thinking_tokens, 600);
  // 2000*1.75 + 8000*0.175 + 1000*14 per 1M
  assert.equal(b.est_usd, 0.0189);
});

test('billingOpenai: cached larger than input clamps to zero', () => {
  const b = billingOpenai('gpt-5.4', {
    input_tokens: 100, input_tokens_details: { cached_tokens: 150 }, output_tokens: 1,
  });
  assert.equal(b.tokens.input_tokens, 0);
  assert.equal(b.tokens.cache_read_input_tokens, 150);
});

test('bump: turns / refusals / unpriced / cache-write flat fallback in totals', () => {
  const totals = newTotals();
  const priced = billing('messages', {
    modelResolved: 'claude-haiku-4-5',
    usageFinal: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 800 },
  });
  bump(totals, priced, { stop_reason: 'end_turn', is_turn: true });
  assert.equal(totals.requests, 1);
  assert.equal(totals.billed_requests, 1);
  assert.equal(totals.turns, 1);
  assert.equal(totals.cache_write_tokens, 800); // flat fallback
  assert.equal(totals.est_usd, 0.00115);

  bump(totals, priced, { stop_reason: 'tool_use', is_turn: false });
  assert.equal(totals.turns, 1); // mid-turn hop doesn't count

  const unpriced = billing('messages', {
    modelResolved: 'claude-nova-9', usageFinal: { input_tokens: 1, output_tokens: 1 },
  });
  bump(totals, unpriced, null);
  assert.equal(totals.unpriced_requests, 1);
  assert.deepEqual(totals.unpriced_models, ['claude-nova-9']);
  assert.equal(totals.est_usd, 0.0023); // unchanged by unpriced traffic

  bump(totals, billing('count_tokens', { countTokens: { input_tokens: 9 } }), null);
  assert.equal(totals.count_tokens_requests, 1);
  assert.equal(totals.billed_requests, 3);
});

test('bump: refusal events keep full stop_details, capped at 20', () => {
  const totals = newTotals();
  const b = billing('messages', { modelResolved: 'claude-fable-5', usageFinal: { output_tokens: 0 } });
  for (let i = 0; i < 25; i++) {
    bump(totals, b, {
      stop_reason: 'refusal', is_turn: true,
      stop_details: { category: 'test', n: i }, request_id: `req_${i}`,
    });
  }
  assert.equal(totals.refusals, 25);
  assert.equal(totals.refusal_events.length, 20);
  assert.equal(totals.refusal_events[0].stop_details.n, 5); // oldest 5 dropped
  assert.equal(totals.refusal_events[19].request_id, 'req_24');
  assert.equal(totals.refusal_events[19].category, 'test');
});

test('Ledger: global and per-session totals accumulate independently', () => {
  const led = new Ledger();
  const b = billing('messages', {
    modelResolved: 'claude-haiku-4-5', usageFinal: { input_tokens: 10, output_tokens: 10 },
  });
  led.accumulate(b, 'sess-a', { stop_reason: 'end_turn', is_turn: true });
  led.accumulate(b, 'sess-b', { stop_reason: 'end_turn', is_turn: true });
  assert.equal(led.totals.requests, 2);
  assert.equal(led.session('sess-a').requests, 1);
  assert.equal(led.session('sess-b').turns, 1);
  led.forget('sess-a');
  assert.equal(led.session('sess-a').requests, 0); // fresh after forget
  assert.equal(led.totals.requests, 2);            // global untouched
});
