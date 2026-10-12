import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  classifyTransportTimeoutLayer, createAiGenerationIdentity, readAiGenerationState, recordProviderGenerationResult,
  resolveProviderGenerationAttemptPolicy, runSyntheticCapabilityProbe,
} from '../app/ai_generation_recovery.mjs';
import { promptFor, resolveQwenListingGenerationOptions } from '../app/listing_sop10_17_executor.mjs';
import { getListingSopJsonSchema, validateListingSopJsonSchema } from '../app/listing_sop_json_schemas.mjs';
import { createOpenAiCompatibleAdapter } from '../app/ai_provider_adapters.mjs';

test('acceptance-only Qwen listing calls explicitly disable default high thinking', () => {
  for (let step = 10; step <= 17; step += 1) {
    assert.deepEqual(resolveQwenListingGenerationOptions({
      acceptanceRuntime: true, effectiveModel: 'qwen3.8-flash', step: `LISTING_SOP_${step}`,
    }), { reasoning_effort: 'none', preserve_thinking: false });
  }
  assert.deepEqual(resolveQwenListingGenerationOptions({
    acceptanceRuntime: false, effectiveModel: 'qwen3.8-flash', step: 'LISTING_SOP_11',
  }), {});
  assert.deepEqual(resolveQwenListingGenerationOptions({
    acceptanceRuntime: true, effectiveModel: 'qwen3.8-plus', step: 'LISTING_SOP_11',
  }), {});
  assert.deepEqual(resolveQwenListingGenerationOptions({
    acceptanceRuntime: true, effectiveModel: 'qwen3.8-flash', step: 'LISTING_SOP_09',
  }), {});
});

test('timeout layer classification requires observed transport milestones', () => {
  assert.equal(classifyTransportTimeoutLayer({ outbound_transport_started: true }), 'CONNECT_OR_TLS_NOT_CONFIRMED');
  assert.equal(classifyTransportTimeoutLayer({ secure_connected: true, request_body_sent: false }), 'TLS_CONNECTED_REQUEST_SEND_UNCONFIRMED');
  assert.equal(classifyTransportTimeoutLayer({ secure_connected: true, request_body_sent: true }), 'REQUEST_SENT_WAITING_FOR_HTTP_RESPONSE');
  assert.equal(classifyTransportTimeoutLayer({ response_headers_received: true, http_status: 200 }), 'TIMEOUT_AFTER_HTTP_RESPONSE_STARTED');
  assert.equal(classifyTransportTimeoutLayer({}), 'TRANSPORT_START_NOT_CONFIRMED');
});

test('generation recovery uses the exact fresh probe timeout and suppresses internal retries', () => {
  assert.deepEqual(resolveProviderGenerationAttemptPolicy({ provider: 'Qwen', recoveryTimeoutMs: 120000, defaultTimeoutMs: 30000, defaultRetryLimit: 1 }), {
    timeout_ms: 120000, max_retries: 0, source: 'FRESH_GENERATION_RECOVERY_PROBE',
  });
  assert.deepEqual(resolveProviderGenerationAttemptPolicy({ provider: 'Qwen', defaultTimeoutMs: 30000, defaultRetryLimit: 1 }), {
    timeout_ms: 30000, max_retries: 1, source: 'RUNTIME_DEFAULT',
  });
  assert.deepEqual(resolveProviderGenerationAttemptPolicy({ provider: 'Qwen', acceptancePolicy: true, defaultTimeoutMs: 30000 }), {
    timeout_ms: 120000, max_retries: 0, source: 'ACCEPTANCE_SINGLE_ATTEMPT',
  });
  assert.deepEqual(resolveProviderGenerationAttemptPolicy({ provider: 'Qwen', acceptanceRuntime: true, defaultTimeoutMs: 30000, defaultRetryLimit: 1 }), {
    timeout_ms: 120000, max_retries: 0, source: 'ACCEPTANCE_RUNTIME_SINGLE_ATTEMPT',
  });
  assert.deepEqual(resolveProviderGenerationAttemptPolicy({ provider: 'DeepSeek', acceptanceRuntime: true, defaultTimeoutMs: 30000, defaultRetryLimit: 1 }), {
    timeout_ms: 120000, max_retries: 0, source: 'ACCEPTANCE_RUNTIME_SINGLE_ATTEMPT',
  });
  assert.deepEqual(resolveProviderGenerationAttemptPolicy({ provider: 'Qwen', recoveryTimeoutMs: 120001, defaultTimeoutMs: 30000, defaultRetryLimit: 1 }), {
    timeout_ms: 30000, max_retries: 1, source: 'RUNTIME_DEFAULT',
  });
});

test('synthetic generation probe passes its single-attempt policy into the adapter', async () => {
  let observed = null;
  const report = await runSyntheticCapabilityProbe({
    provider: 'Qwen', configuredModel: 'qwen3.8-flash', effectiveModel: 'qwen3.8-flash',
    timeoutMs: 120000, retryLimit: 0,
    invoke: async input => {
      observed = { timeout_ms: input.timeout_ms, max_retries: input.max_retries };
      return {
        status: 'PASS', returned_model: 'qwen3.8-flash', finish_reason: 'stop', http_status: 200,
        attempt_count: 1, request_id: input.request_id,
        content: JSON.stringify({
          selling_points: [1, 2, 3].map(n => ({ text: `Synthetic benefit ${n} supported by fixture evidence.`, evidence_ids: ['E1'] })),
          pain_points: [1, 2].map(n => ({ text: `Synthetic limitation ${n} supported by fixture evidence.`, evidence_ids: ['E5'] })),
          buying_reasons: [1, 2].map(n => ({ text: `Synthetic reason ${n} supported by fixture evidence.`, evidence_ids: ['E2'] })),
          summary: 'Synthetic schema-valid summary.',
        }),
        attempt_metadata: { http_status: 200 },
        attempt_telemetry: [{ attempt_index: 1, http_status: 200, connected: true, response_received: true, json_parse: 'PASS', schema_validation: 'PASS' }],
      };
    },
  });
  assert.deepEqual(observed, { timeout_ms: 120000, max_retries: 0 });
  assert.equal(report.status, 'PASS');
  assert.equal(report.external_requests, 1);
  assert.equal(report.retry_count, 0);
});

test('provider failure persists bounded transport phases without response content', async () => {
  const base = path.join(process.cwd(), '_offline_tmp');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'bol-ai-attempt-telemetry-'));
  try {
    const identity = createAiGenerationIdentity({
      sku: 'SYNTHETIC-TRANSPORT', step: 'LISTING_SOP_10',
      inputVersionRefs: [{ artifact: 'synthetic-v1' }], prompt: 'non-sensitive synthetic prompt',
      provider: 'Qwen', effectiveModel: 'qwen3.8-flash', adapterVersion: 'test-adapter',
    });
    await recordProviderGenerationResult(root, identity, {
      provider: 'Qwen', status: 'ERROR', reason_code: 'PROVIDER_TIMEOUT', request_id: 'trace-test-1',
      attempt_metadata: {
        request_started_at: '2026-10-12T00:00:00.000Z', request_finished_at: '2026-10-12T00:00:30.000Z',
        elapsed_ms: 30000, client_timeout_ms: 30000, adapter_transport_retry_limit: 0,
        adapter_transport_attempt_count: 1, adapter_transport_retry_count: 0,
        http_connected: 'NOT_REPORTED', response_received: null, http_status: null,
      },
      attempt_telemetry: [{
        attempt_index: 1, started_at: '2026-10-12T00:00:00.000Z', finished_at: '2026-10-12T00:00:30.000Z',
        elapsed_ms: 30000, generation_timeout_ms: 30000, outbound_transport_started: true,
        secure_connected: true, connected: true, secure_connect_elapsed_ms: 83,
        request_body_sent: true, request_body_sent_elapsed_ms: 101,
        response_headers_received: false, response_received: false, http_status: null,
        failure_stage: 'TIMEOUT_BEFORE_RESPONSE', failure_code: 'ETIMEDOUT',
        prompt: 'must not persist', response_body: 'must not persist', authorization: 'must not persist',
      }],
    }, { attemptNumber: 1, executionId: 'synthetic-execution-1' });

    const state = await readAiGenerationState(root);
    const attempt = state.partial_results[identity.generation_key].attempts[0];
    assert.equal(attempt.http_connected, true);
    assert.equal(attempt.outbound_transport_started, true);
    assert.equal(attempt.secure_connect_elapsed_ms, 83);
    assert.equal(attempt.request_body_sent, true);
    assert.equal(attempt.request_body_sent_elapsed_ms, 101);
    assert.equal(attempt.response_headers_received, false);
    assert.equal(attempt.response_received, false);
    assert.equal(attempt.http_status, null);
    assert.equal(attempt.failure_stage, 'TIMEOUT_BEFORE_RESPONSE');
    assert.equal(attempt.failure_code, 'ETIMEDOUT');
    assert.deepEqual(attempt.transport_attempts, [{
      attempt_index: 1, started_at: '2026-10-12T00:00:00.000Z', finished_at: '2026-10-12T00:00:30.000Z',
      elapsed_ms: 30000, generation_timeout_ms: 30000, transport_retry: false,
      outbound_transport_started: true, secure_connected: true, secure_connect_elapsed_ms: 83,
      secure_connect_observation: 'NOT_OBSERVED', secure_connect_observed_elapsed_ms: null,
      request_body_sent: true, request_body_sent_elapsed_ms: 101,
      response_headers_received: false, response_headers_elapsed_ms: null,
      response_first_byte_elapsed_ms: null, response_received: false, http_status: null,
      api_protocol: null, structured_output: null, reasoning_effort: null, thinking_mode: null,
      preserve_thinking: null, max_tokens_requested: null, max_completion_tokens_requested: null,
      max_output_tokens_requested: null,
      failure_stage: 'TIMEOUT_BEFORE_RESPONSE', failure_code: 'ETIMEDOUT',
      schema_validation_errors: [],
      schema_validation_details: [],
      transport_timeout_layer: 'REQUEST_SENT_WAITING_FOR_HTTP_RESPONSE',
    }]);
    const serialized = JSON.stringify(attempt);
    assert.equal(serialized.includes('must not persist'), false);
    assert.equal(serialized.includes('authorization'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('schema-required listing generation cannot become reusable success without schema PASS', async () => {
  const base = path.join(process.cwd(), '_offline_tmp');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'bol-ai-schema-required-'));
  try {
    const schema = getListingSopJsonSchema('LISTING_SOP_14');
    const schemaHash = crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    const makeIdentity = suffix => createAiGenerationIdentity({
      sku: `SYNTHETIC-SCHEMA-${suffix}`, step: 'LISTING_SOP_14',
      inputVersionRefs: [{ artifact: 'synthetic-v1' }], promptContractVersion: 'SOP10_17_QWEN_JSON_SCHEMA_V1',
      prompt: 'synthetic prompt', provider: 'Qwen', effectiveModel: 'qwen3.8-flash',
      adapterContractVersion: 'CONTRACT_V2', adapterVersion: 'FAKE_ADAPTER_V2',
      executionContract: { api_protocol: 'CHAT_COMPLETIONS', structured_output: 'json_schema', schema_sha256: schemaHash },
    });
    const shortTitle = 'x'.repeat(151);
    const invalidOutput = {
      title_nl: shortTitle, title_zh: 'Synthetic', language: 'nl-NL', source_fact_version: 'v1',
      keyword_layout_refs: [], evidence_refs: ['SYNTH-E1'],
    };
    assert.equal(validateListingSopJsonSchema(invalidOutput, schema).valid, false);
    assert.deepEqual(validateListingSopJsonSchema({ ...invalidOutput, title_nl: 'x'.repeat(229) }, schema).details,
      [{ path: '$.title_nl', keyword: 'minLength', actual: 229, expected: 230 }]);

    const missingSchemaIdentity = makeIdentity('MISSING-TELEMETRY');
    await recordProviderGenerationResult(root, missingSchemaIdentity, {
      status: 'PASS', provider: 'Qwen', content: JSON.stringify(invalidOutput),
      attempt_metadata: { request_finished_at: '2026-10-12T00:00:01.000Z', http_status: 200 },
      attempt_telemetry: [{ json_parse: 'PASS', schema_validation: 'NOT_RUN' }],
    }, { attemptNumber: 1 });
    let state = await readAiGenerationState(root);
    let partial = state.partial_results[missingSchemaIdentity.generation_key];
    assert.equal(partial.status, 'FAILED');
    assert.equal(partial.attempts[0].failure_type, 'PROVIDER_SCHEMA_INVALID');
    assert.equal(partial.attempts[0].structured_schema_status, 'FAIL');
    assert.equal(Object.hasOwn(partial, 'content'), false, 'invalid structured output must not be cached');

    const invalidSchemaIdentity = makeIdentity('SCHEMA-FAIL');
    await recordProviderGenerationResult(root, invalidSchemaIdentity, {
      status: 'PASS', provider: 'Qwen', content: JSON.stringify(invalidOutput),
      attempt_metadata: { request_finished_at: '2026-10-12T00:00:02.000Z', http_status: 200 },
      attempt_telemetry: [{ json_parse: 'PASS', schema_validation: 'FAIL', schema_validation_errors: ['$.title_nl:MIN_LENGTH'],
        schema_validation_details: [{ path: '$.title_nl', keyword: 'minLength', actual: 151, expected: 230 },
          { path: '$.title_nl', keyword: 'minLength', actual: 'secret content', expected: 230 }] }],
    }, { attemptNumber: 1 });
    state = await readAiGenerationState(root);
    partial = state.partial_results[invalidSchemaIdentity.generation_key];
    assert.equal(partial.status, 'FAILED');
    assert.equal(partial.attempts[0].failure_type, 'PROVIDER_SCHEMA_INVALID');
    assert.deepEqual(partial.attempts[0].schema_validation_errors, ['$.title_nl:MIN_LENGTH']);
    assert.deepEqual(partial.attempts[0].schema_validation_details,
      [{ path: '$.title_nl', keyword: 'minLength', actual: 151, expected: 230 }]);
    assert.equal(Object.hasOwn(partial, 'content'), false);

    const validSchemaIdentity = makeIdentity('SCHEMA-PASS');
    const validOutput = { ...invalidOutput, title_nl: 'x'.repeat(240) };
    assert.equal(validateListingSopJsonSchema(validOutput, schema).valid, true);
    await recordProviderGenerationResult(root, validSchemaIdentity, {
      status: 'PASS', provider: 'Qwen', content: JSON.stringify(validOutput),
      attempt_metadata: { request_finished_at: '2026-10-12T00:00:03.000Z', http_status: 200 },
      attempt_telemetry: [{ json_parse: 'PASS', schema_validation: 'PASS' }],
    }, { attemptNumber: 1 });
    state = await readAiGenerationState(root);
    partial = state.partial_results[validSchemaIdentity.generation_key];
    assert.equal(partial.status, 'SUCCESS');
    assert.equal(partial.attempts[0].structured_schema_status, 'PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Qwen Chat Completions sends the formal per-step strict JSON Schema and rejects short SOP14 titles', async () => {
  const schema = getListingSopJsonSchema('LISTING_SOP_14');
  const payloads = [];
  const makeAdapter = title => createOpenAiCompatibleAdapter({
    name: 'Qwen', endpoint: 'https://synthetic.invalid/v1/chat/completions',
    requestedModel: 'qwen3.8-flash', model: 'qwen3.8-flash', credentialEnv: 'QWEN_OFFLINE_TEST_KEY',
  }, {
    env: { QWEN_OFFLINE_TEST_KEY: 'offline-only-placeholder' },
    transport: async (_endpoint, _key, payload) => {
      payloads.push(payload);
      const content = JSON.stringify({ title_nl: title, title_zh: '合成标题', language: 'nl-NL',
        source_fact_version: 'synthetic-v1', keyword_layout_refs: [], evidence_refs: ['SYNTH-E1'] });
      return { status: 200, headers: {}, body: { model: 'qwen3.8-flash', choices: [{ message: { content }, finish_reason: 'stop' }] },
        attempt_telemetry: { http_status: 200, response_received: true, connected: true, finish_reason: 'stop' } };
    },
  });
  const input = { sku: 'SYNTHETIC-SKU-ONLY', module: 'LISTING_SOP_14', system: 'Return JSON only.', prompt: 'synthetic input',
    json_schema: schema, json_schema_name: 'listing_sop_14', api_protocol: 'CHAT_COMPLETIONS',
    reasoning_effort: 'none', preserve_thinking: false, max_completion_tokens: 16384 };
  const valid = await makeAdapter('x'.repeat(240)).invoke(input);
  assert.deepEqual(payloads[0].response_format, { type: 'json_schema', json_schema: {
    name: 'listing_sop_14', strict: true, schema,
  } });
  assert.equal(valid.structured_response.title_nl.length, 240);
  assert.equal(valid.attempt_telemetry.at(-1).schema_validation, 'PASS');
  assert.equal(valid.attempt_telemetry.at(-1).api_protocol, 'CHAT_COMPLETIONS');
  assert.equal(valid.attempt_telemetry.at(-1).structured_output, 'json_schema');
  assert.equal(valid.attempt_telemetry.at(-1).max_completion_tokens_requested, 16384);
  assert.equal(valid.attempt_telemetry.at(-1).reasoning_effort, 'none');
  assert.equal(valid.attempt_telemetry.at(-1).preserve_thinking, false);

  await assert.rejects(makeAdapter('x'.repeat(151)).invoke(input), error => {
    assert.equal(error.code, 'PROVIDER_JSON_SCHEMA_INVALID');
    assert.deepEqual(error.attempt_telemetry.at(-1).schema_validation_errors, ['$.title_nl:MIN_LENGTH']);
    assert.deepEqual(error.attempt_telemetry.at(-1).schema_validation_details,
      [{ path: '$.title_nl', keyword: 'minLength', actual: 151, expected: 230 }]);
    return true;
  });
  assert.equal(payloads.length, 2);
});

test('SOP14 title-length instructions are explicit and shared by both providers', () => {
  const prompt = promptFor('LISTING_SOP_14', {
    input_version_refs: [],
    inputs: { LISTING_SOP_02: { fields: { brand_name: { status: 'CONFIRMED', value: { value: 'LIVTEK' } } } } },
  });
  assert.match(prompt, /230–260 characters, including spaces and punctuation/);
  assert.match(prompt, /target 240–250/);
  assert.match(prompt, /count title_nl/);
  assert.match(prompt, /Never pad, repeat a keyword, stack synonyms/);
  assert.match(prompt, /borrow competitor facts/);
  assert.match(prompt, /Never return a title outside the required character range/);
  assert.doesNotMatch(prompt, /return the closest fact-safe value/);
});
