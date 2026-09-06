import test from 'node:test';
import assert from 'node:assert/strict';
import { requestHarness, validateHarnessInput } from '../ai-harness.js';

const base = { consent: true, prompt: 'Change the heading', sessionNodeId: 12, context: '<h1>Old heading</h1>' };

test('requires explicit page-context consent', () => {
  assert.throws(() => validateHarnessInput({ ...base, consent: false }), /consent/);
});

test('returns only typed structured actions from the model', async () => {
  const result = await requestHarness(base, { apiKey: 'test-key', fetchImpl: async (_url, options) => {
    assert.match(options.headers.Authorization, /^Bearer test-key$/);
    return new Response(JSON.stringify({ output_text: JSON.stringify({ summary: 'Update heading', actions: [{ type: 'setText', nodeId: 12, value: 'New heading', reason: 'Matches the request' }] }) }), { status: 200 });
  } });
  assert.equal(result.actions[0].type, 'setText');
  assert.equal(result.actions[0].nodeId, 12);
});

test('fails closed when the key is unavailable or output is malformed', async () => {
  await assert.rejects(() => requestHarness(base, { apiKey: '' }), /not configured/);
  await assert.rejects(() => requestHarness(base, { apiKey: 'test-key', fetchImpl: async () => new Response(JSON.stringify({ output_text: 'not json' }), { status: 200 }) }), /invalid structured output/);
});
