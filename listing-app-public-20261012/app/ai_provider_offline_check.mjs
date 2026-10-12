import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyProviderFailure, createOpenAiCompatibleAdapter } from './ai_provider_adapters.mjs';
import { registerAiProviderAdapter, routeAiRequest } from './ai_router.mjs';
import { persistProviderReadinessEvidence, readProviderReadinessEvidence } from './ai_provider_readiness_evidence.mjs';
import { getListingSopJsonSchema } from './listing_sop_json_schemas.mjs';
import { resolveAiProviderConfigPath } from './ai_provider_config_path.mjs';

const codes = [
  [401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_PERMISSION_DENIED'], [404, 'PROVIDER_MODEL_OR_ENDPOINT_NOT_FOUND'],
  [429, 'PROVIDER_RATE_LIMITED'], [402, 'PROVIDER_QUOTA_EXCEEDED'], [408, 'PROVIDER_TIMEOUT'], [503, 'PROVIDER_UNAVAILABLE'],
  [null, 'PROVIDER_DNS_FAILED', 'ENOTFOUND'], [null, 'PROVIDER_TLS_FAILED', 'ERR_TLS_CERT_ALTNAME_INVALID'],
];
for (const [status, expected, errorCode] of codes) assert.equal(classifyProviderFailure({ status, errorCode }), expected);

let transportCount = 0;
const config = { name: 'Qwen', endpoint: 'https://provider.example/v1/chat/completions', model: 'test-model', credentialEnv: 'TEST_PROVIDER_KEY' };
const missing = createOpenAiCompatibleAdapter(config, { env: {}, transport: async () => { transportCount += 1; throw new Error('must not call'); } });
assert.equal((await missing.readiness()).status, 'NOT_CONFIGURED');
assert.equal((await missing.probeReadiness()).external_request_count, 0);
assert.equal(transportCount, 0);

const env = { TEST_PROVIDER_KEY: 'offline-secret-marker' };
const successful = createOpenAiCompatibleAdapter(config, {
  env,
  transport: async (_endpoint, _key, payload, options) => {
    transportCount += 1;
    assert.equal(payload.response_format.type, 'json_object');
    assert.equal(Object.hasOwn(payload, 'extra_body'), false, 'The ordinary Qwen readiness flow must not inherit DeepSeek Listing policy.');
    assert.ok(options.requestId);
    return { status: 200, headers: { 'x-request-id': 'offline-request-1' }, body: { model: 'test-model', choices: [{ message: { content: '{"ready":true}' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } };
  },
});
assert.equal((await successful.readiness()).status, 'UNAVAILABLE');
assert.equal((await successful.readiness()).ready, false);
const ready = await successful.probeReadiness();
assert.equal(ready.status, 'READY');
assert.equal(ready.external_request_count, 1);
assert.deepEqual(ready.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
assert.equal(JSON.stringify(ready).includes(env.TEST_PROVIDER_KEY), false);

let qwenSchemaPayload = null;
let qwenSchemaTransportCount = 0;
const qwenSchema = getListingSopJsonSchema('LISTING_SOP_10');
const qwenStructured = createOpenAiCompatibleAdapter(config, {
  env,
  transport: async (_endpoint, _key, payload) => {
    qwenSchemaTransportCount += 1;
    qwenSchemaPayload = payload;
    return { status: 200, headers: { 'x-request-id': 'offline-qwen-schema-1' }, body: {
      model: 'qwen-test-model',
      choices: [{ message: { content: JSON.stringify({
        observed_selling_points: [], pain_points: [], buying_reasons: [], why_competitor_appears_to_sell: [],
        evidence_refs: ['SYNTH-EVIDENCE'], low_competitor_pool_confidence: false,
      }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
    } };
  },
});
const qwenStructuredResult = await qwenStructured.invoke({
  module: 'LISTING_SOP_10',
  system: 'Synthetic SOP10 schema contract test. Return JSON only.',
  prompt: 'Synthetic-only data; no real SKU facts.',
  json_schema: qwenSchema,
  json_schema_name: 'listing_sop_10',
  max_retries: 0,
});
assert.equal(qwenSchemaPayload.response_format.type, 'json_schema');
assert.equal(qwenSchemaPayload.response_format.json_schema.strict, true);
assert.equal(qwenSchemaPayload.response_format.json_schema.name, 'listing_sop_10');
assert.deepEqual(qwenSchemaPayload.response_format.json_schema.schema, qwenSchema);
assert.equal(qwenStructuredResult.http_status, 200);
assert.equal(qwenStructuredResult.model, 'qwen-test-model');
assert.deepEqual(qwenStructuredResult.structured_response.low_competitor_pool_confidence, false);
assert.equal(qwenStructuredResult.attempt_telemetry.at(-1).json_parse, 'PASS');
assert.equal(qwenStructuredResult.attempt_telemetry.at(-1).schema_validation, 'PASS');
assert.equal(qwenStructuredResult.attempt_count, 1);
assert.equal(qwenSchemaTransportCount, 1, 'One local fake transport validates the SOP schema path.');

const authFailed = createOpenAiCompatibleAdapter(config, { env, transport: async () => ({ status: 401, headers: { 'x-request-id': 'offline-auth-401' }, body: { error: { code: 'InvalidApiKey', message: 'Authorization: Bearer x' } } }) });
const auth = await authFailed.probeReadiness();
assert.equal(auth.status, 'AUTH_FAILED');
assert.equal(auth.reason_code, 'PROVIDER_AUTH_FAILED');
assert.equal(auth.provider_error_code, 'InvalidApiKey');
assert.equal(auth.provider_request_id, 'offline-auth-401');
assert.match(auth.provider_error_message, /\[REDACTED\]/);
assert.equal(JSON.stringify(auth).includes('offline-sensitive-secret'), false);
assert.equal(JSON.stringify(auth).includes(env.TEST_PROVIDER_KEY), false);
const notFound = createOpenAiCompatibleAdapter(config, { env, transport: async () => ({
  status: 404,
  headers: { 'x-request-id': 'offline-qwen-404' },
  body: { code: 'Model.NotFound', message: 'The requested model is unavailable; api_key=offline-secret-marker' },
}) });
const notFoundProbe = await notFound.probeReadiness();
assert.equal(notFoundProbe.reason_code, 'PROVIDER_MODEL_OR_ENDPOINT_NOT_FOUND', 'Keep stable business classification while exposing the upstream code.');
assert.equal(notFoundProbe.provider_error_code, 'Model.NotFound');
assert.equal(notFoundProbe.diagnostics.provider_error_code, 'Model.NotFound');
assert.equal(notFoundProbe.provider_request_id, 'offline-qwen-404');
assert.match(notFoundProbe.provider_error_message, /api_key=\[REDACTED\]/i);
assert.equal(JSON.stringify(notFoundProbe).includes('offline-secret-marker'), false);
const invokeNotFound = createOpenAiCompatibleAdapter(config, { env, transport: async () => ({
  status: 404,
  headers: { 'x-dashscope-request-id': 'offline-qwen-invoke-404' },
  body: { error: { code: 'WorkspaceModelAccessDenied', message: 'model is unavailable' } },
}) });
await assert.rejects(() => invokeNotFound.invoke({ system: 'Return JSON only.', prompt: 'Synthetic diagnostic only.' }), error => {
  assert.equal(error.http_status, 404);
  assert.equal(error.provider_error_code, 'WorkspaceModelAccessDenied');
  assert.equal(error.provider_error_message, 'model is unavailable');
  assert.equal(error.provider_request_id, 'offline-qwen-invoke-404');
  return true;
});
const emptyStructured = createOpenAiCompatibleAdapter(config, { env, transport: async () => ({ status: 200, headers: {}, body: { model: 'test-model', choices: [{ message: { content: '' } }] } }) });
const empty = await emptyStructured.probeReadiness();
assert.equal(empty.status, 'UNAVAILABLE');
assert.equal(empty.reason_code, 'PROVIDER_EMPTY_CONTENT');
let capturedProbePayload = null;
const deepSeekConfig = { ...config, name: 'DeepSeek' };
const deepSeekProbe = createOpenAiCompatibleAdapter(deepSeekConfig, { env, transport: async (_endpoint, _key, payload) => {
  capturedProbePayload = payload;
  return { status: 200, headers: {}, body: { model: 'test-model', choices: [{ message: { content: '{"status":"ok"}', reasoning_content: 'private reasoning must not be returned' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } };
} });
const diagnosticPass = await deepSeekProbe.probeReadiness();
assert.equal(diagnosticPass.status, 'READY');
assert.equal(capturedProbePayload.response_format.type, 'json_object');
assert.equal(capturedProbePayload.stream, false);
assert.ok(capturedProbePayload.max_tokens >= 64);
assert.ok(capturedProbePayload.messages.some(message => /json/i.test(message.content)));
assert.ok(capturedProbePayload.messages.some(message => message.content.includes('{"status":"ok"}')));
assert.equal(diagnosticPass.diagnostics.schema_validation_success, true);
assert.equal(diagnosticPass.diagnostics.reasoning_content_present, true);
assert.equal(diagnosticPass.requested_model, 'test-model');
assert.equal(diagnosticPass.effective_request_model, 'test-model');
assert.equal(diagnosticPass.returned_model, 'test-model');
assert.equal(JSON.stringify(diagnosticPass).includes('private reasoning must not be returned'), false);
const deepSeekEmpty = createOpenAiCompatibleAdapter(deepSeekConfig, { env, transport: async () => ({ status: 200, headers: {}, body: { model: 'test-model', choices: [{ message: { content: '', reasoning_content: 'private' }, finish_reason: 'stop' }] } }) });
const emptyResult = await deepSeekEmpty.probeReadiness();
assert.equal(emptyResult.reason_code, 'PROVIDER_EMPTY_CONTENT');
assert.equal(emptyResult.diagnostics.failure_stage, 'EMPTY_CONTENT');
const truncatedDeepSeek = createOpenAiCompatibleAdapter(deepSeekConfig, { env, transport: async () => ({ status: 200, headers: {}, body: { model: 'test-model', choices: [{ message: { content: '', reasoning_content: 'reasoning only' }, finish_reason: 'length' }] } }) });
const truncated = await truncatedDeepSeek.probeReadiness();
assert.equal(truncated.reason_code, 'PROVIDER_OUTPUT_TRUNCATED');
assert.equal(truncated.diagnostics.secondary_reason_code, 'PROVIDER_EMPTY_CONTENT');

let listingPayload = null;
const deepSeekListing = createOpenAiCompatibleAdapter(deepSeekConfig, {
  env,
  transport: async (_endpoint, _key, payload) => {
    listingPayload = payload;
    return { status: 200, headers: {}, body: {
      model: 'test-model',
      choices: [{ message: { content: '{"ok":true}', reasoning_content: 'not business content' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    } };
  },
});
const listingResult = await deepSeekListing.invoke({
  system: 'Return JSON only.',
  prompt: 'Use schema {"ok":"boolean"}; exact prompt contract.',
  structured_output: true,
  max_tokens: 4096,
  extra_body: { thinking: { type: 'disabled' } },
});
assert.deepEqual(listingPayload.extra_body, { thinking: { type: 'disabled' } });
assert.equal(listingPayload.response_format.type, 'json_object');
assert.equal(listingPayload.stream, false);
assert.equal(listingPayload.max_tokens, 4096);
assert.equal(Object.hasOwn(listingPayload, 'reasoning_effort'), false, 'Do not send a conflicting second mode parameter.');
assert.ok(listingPayload.messages.some(message => message.content.includes('exact prompt contract')));
assert.equal(listingResult.thinking_mode, 'disabled');
assert.equal(listingResult.reasoning_effort, undefined);
assert.equal(listingResult.content, '{"ok":true}', 'Reasoning content is not a business-result source.');
assert.equal(listingResult.usage.total_tokens, 16);

const sop14Schema = getListingSopJsonSchema('LISTING_SOP_14');
const deepSeekSchemaFailure = createOpenAiCompatibleAdapter(deepSeekConfig, {
  env,
  transport: async () => ({ status: 200, headers: { 'x-request-id': 'offline-sop14-schema-fail' }, body: {
    id: 'resp-offline-sop14', model: 'deepseek-test', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      title_nl: 'Te korte titel', title_zh: 'synthetic', language: 'nl-NL', source_fact_version: 1,
      keyword_layout_refs: [], evidence_refs: ['SYNTH-EVIDENCE'],
    }) }] }], usage: { input_tokens: 5, output_tokens: 10, reasoning_tokens: 0 },
  } }),
});
await assert.rejects(() => deepSeekSchemaFailure.invoke({
  module: 'LISTING_SOP_14', api_protocol: 'RESPONSES', reasoning_effort: 'none',
  json_schema: sop14Schema, json_schema_name: 'listing_sop_14', max_output_tokens: 16384,
  system: 'Synthetic SOP14 contract only. Return JSON only.', prompt: 'Synthetic title schema failure test.',
}), error => {
  const attempt = error.attempt_telemetry?.at(-1);
  assert.equal(error.code, 'PROVIDER_JSON_SCHEMA_INVALID');
  assert.equal(error.http_status, 200);
  assert.equal(attempt?.json_parse, 'PASS');
  assert.equal(attempt?.schema_validation, 'FAIL');
  assert.ok(attempt?.schema_validation_errors?.includes('$.title_nl:MIN_LENGTH'));
  assert.equal(JSON.stringify(error.attempt_telemetry).includes('Te korte titel'), false, 'Failure telemetry contains schema paths only, never generated content.');
  return true;
});

const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bol-ai-provider-evidence-offline-'));
const persistedReadiness = await persistProviderReadinessEvidence({
  dataRoot: evidenceRoot, provider: 'Qwen', providerConfig: config,
  adapterMetadata: notFound.executionMetadata(), result: notFoundProbe, runtimeEnvironment: 'ACCEPTANCE_4181',
});
assert.equal(persistedReadiness.result_metadata.provider_error_code, 'Model.NotFound');
assert.equal(persistedReadiness.result_metadata.provider_request_id, 'offline-qwen-404');
assert.match(persistedReadiness.result_metadata.provider_error_message, /api_key=\[REDACTED\]/i);
const readinessEvidence = await readProviderReadinessEvidence(evidenceRoot);
assert.equal(readinessEvidence.evidence[0].result_metadata.provider_error_code, 'Model.NotFound');
assert.equal(JSON.stringify(readinessEvidence).includes('offline-secret-marker'), false);
await fs.rm(evidenceRoot, { recursive: true, force: true });
const providerConfigs = JSON.parse(await fs.readFile(resolveAiProviderConfigPath(), 'utf8')).providers || [];
const previousCredentialEnv = new Map();
for (const item of providerConfigs.filter(provider => ['Qwen', 'DeepSeek'].includes(provider.name))) {
  const key = String(item.credentialEnv || '').trim();
  if (!key) continue;
  previousCredentialEnv.set(key, process.env[key]);
  process.env[key] = 'offline-test-only-placeholder';
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bol-ai-provider-offline-'));
let invokeCount = 0;
const unregisterQwen = registerAiProviderAdapter('Qwen', { readiness: async () => ({ ready: true, status: 'READY' }), invoke: async () => { invokeCount += 1; return { content: 'ok' }; } });
const unregisterDeepSeek = registerAiProviderAdapter('DeepSeek', { readiness: async () => ({ ready: false, status: 'UNAVAILABLE' }), invoke: async () => { invokeCount += 1; return { content: 'ok' }; } });
try {
  const routed = await routeAiRequest(root, { sku: 'OFFLINE', module: 'probe', prompt: 'offline dispatch gate' });
  assert.equal(routed.status, 'WAITING_DEPENDENCY');
  assert.equal(routed.ai_request_count, 0);
  assert.equal(invokeCount, 0);
} finally {
  unregisterQwen(); unregisterDeepSeek();
}

let routedQwenInput = null;
let routedDeepSeekInput = null;
const unregisterQwenListing = registerAiProviderAdapter('Qwen', {
  readiness: async () => ({ ready: true, status: 'READY' }),
  invoke: async input => { routedQwenInput = input; return { content: '{"ok":true}', model: 'qwen-test', status: 'PASS' }; },
});
const unregisterDeepSeekListing = registerAiProviderAdapter('DeepSeek', {
  readiness: async () => ({ ready: true, status: 'READY' }),
  invoke: async input => { routedDeepSeekInput = input; return { content: '{"ok":true}', model: 'deepseek-test', status: 'PASS' }; },
});
try {
  const routedListing = await routeAiRequest(root, {
    sku: 'OFFLINE', module: 'LISTING_SOP_10', prompt: 'Return JSON object only.',
    request_options_by_provider: { DeepSeek: { extra_body: { thinking: { type: 'disabled' } } } },
  });
  assert.equal(routedListing.status, 'ROUTED', JSON.stringify(routedListing));
  assert.equal(routedQwenInput.extra_body, undefined, 'Qwen policy must remain unchanged.');
  assert.deepEqual(routedDeepSeekInput.extra_body, { thinking: { type: 'disabled' } });
} finally {
  unregisterQwenListing(); unregisterDeepSeekListing();
}

const unregisterQwenErrorRoute = registerAiProviderAdapter('Qwen', {
  readiness: async () => ({ ready: true, status: 'READY' }),
  invoke: input => invokeNotFound.invoke(input),
});
const unregisterDeepSeekErrorRoute = registerAiProviderAdapter('DeepSeek', {
  readiness: async () => ({ ready: true, status: 'READY' }),
  invoke: async () => ({ content: '{"ok":true}', model: 'deepseek-test', status: 'PASS' }),
});
try {
  const routedError = await routeAiRequest(root, { sku: 'OFFLINE', module: 'LISTING_SOP_10', prompt: 'Synthetic diagnostic only.' });
  const qwenResult = routedError.primary_results.find(item => item.provider === 'Qwen');
  assert.equal(qwenResult.status, 'ERROR');
  assert.equal(qwenResult.provider_error_code, 'WorkspaceModelAccessDenied');
  assert.equal(qwenResult.provider_request_id, 'offline-qwen-invoke-404');
  assert.equal(qwenResult.attempt_metadata.provider_error_code, 'WorkspaceModelAccessDenied');
  assert.equal(JSON.stringify(routedError).includes('offline-secret-marker'), false);
} finally {
  unregisterQwenErrorRoute(); unregisterDeepSeekErrorRoute();
  await fs.rm(root, { recursive: true, force: true });
  for (const [key, previous] of previousCredentialEnv) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

process.stdout.write(JSON.stringify({ status: 'PASS', checks: ['failure-classification', 'missing-key-no-request', 'structured-response-and-usage', 'qwen-listing-json-schema-request-and-validation', 'auth-redaction', 'upstream-error-diagnostics-and-redaction', 'readiness-evidence-persistence', 'router-error-diagnostic-persistence', 'dual-provider-dispatch-gate', 'deepseek-listing-non-thinking-request-policy', 'qwen-policy-unchanged'], real_requests: 0 }) + '\n');
