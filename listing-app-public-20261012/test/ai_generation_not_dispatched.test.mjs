import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  beginProviderGenerationAttempt, createAiGenerationIdentity,
  generationStorePath, readAiGenerationState, recordProviderGenerationNotDispatched,
} from '../app/ai_generation_recovery.mjs';

test('pre-adapter worker guard attempts reconcile without failures or circuit changes', async () => {
  const testTempRoot = path.join(process.cwd(), '_offline_tmp');
  await fs.mkdir(testTempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testTempRoot, 'bol-ai-not-dispatched-'));
  try {
    const identity = createAiGenerationIdentity({ sku: 'SYNTHETIC-SKU-LEGACY-05', step: 'LISTING_SOP_10',
      inputVersionRefs: [{ version: 'fixture-v1' }], prompt: 'synthetic prompt',
      provider: 'Qwen', effectiveModel: 'qwen3.8-flash', adapterVersion: 'fixture-adapter' });
    await beginProviderGenerationAttempt(root, identity, { clientTimeoutMs: 30_000, transportRetryLimit: 1 });
    const first = await recordProviderGenerationNotDispatched(root, identity, { attemptNumbers: [1] });
    assert.equal(first.status, 'RECONCILED_NOT_DISPATCHED');
    assert.equal(first.partial_status, 'NOT_STARTED');
    const state = await readAiGenerationState(root);
    const attempt = state.partial_results[identity.generation_key].attempts[0];
    assert.equal(attempt.status, 'NOT_DISPATCHED');
    assert.equal(attempt.request_finished_at, null);
    assert.ok(attempt.reconciled_at);
    assert.equal(attempt.provider_dispatch_attempted, false);
    assert.equal(attempt.dispatch_reached_adapter, false);
    assert.equal(state.circuits[identity.generation_key], undefined);
    assert.equal(state.dispatch_reconciliations.length, 1);
    assert.equal((await recordProviderGenerationNotDispatched(root, identity, { attemptNumbers: [1] })).status, 'ALREADY_RECONCILED');

    const unsafe = createAiGenerationIdentity({ sku: 'SYNTHETIC-SKU-LEGACY-05', step: 'LISTING_SOP_10',
      inputVersionRefs: [{ version: 'fixture-v2' }], prompt: 'synthetic prompt 2',
      provider: 'DeepSeek', effectiveModel: 'deepseek-flash', adapterVersion: 'fixture-adapter' });
    await beginProviderGenerationAttempt(root, unsafe, {});
    const file = generationStorePath(root);
    const edited = JSON.parse(await fs.readFile(file, 'utf8'));
    edited.partial_results[unsafe.generation_key].attempts[0].http_status = 200;
    await fs.writeFile(file, JSON.stringify(edited));
    let rejection = null;
    try { await recordProviderGenerationNotDispatched(root, unsafe, { attemptNumbers: [1] }); }
    catch (error) { rejection = error; }
    assert.equal(rejection?.code, 'AI_ATTEMPT_NOT_PROVEN_PRE_DISPATCH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
