import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_AI_PROVIDER_READINESS_TTL_MS } from './ai_provider_readiness_evidence.mjs';
import { providerTransportCounters } from './provider_transport_counters.mjs';
import { readCapabilityEvidence } from './sop10_recovery_evidence.mjs';

export const AI_GENERATION_RECOVERY_VERSION = 'AI_GENERATION_RECOVERY_V1';
export const AI_PROVIDER_RESULT_CONTRACT_VERSION = 'AI_PROVIDER_RESULT_CONTRACT_V1';
export const AI_GENERATION_CAPABILITY_PROBE_VERSION = 'AI_GENERATION_CAPABILITY_PROBE_V2';
export const AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION = 'AI_GENERATION_CAPABILITY_PROBE_CONTRACT_V4';
export const AI_GENERATION_CAPABILITY_EVIDENCE_VERSION = 'AI_GENERATION_CAPABILITY_EVIDENCE_V4';
export const QWEN_SOP10_CAPABILITY_PROBE_CONTRACT_VERSION = 'QWEN_SOP10_JSON_SCHEMA_LOW_THINKING_CAPABILITY_V2';
export const AI_GENERATION_PROBE_MAX_TOKENS = 4096;
export const AI_SOP10_DEEPSEEK_MAX_TOKENS = 4096;
export const LISTING_AI_PROMPT_CONTRACT_VERSION = 'LISTING_SOP10_17_PROMPT_CONTRACT_V1';
export const AI_GENERATION_DEFAULT_TIMEOUT_MS = 30_000; // Matches the currently registered adapter default; no timeout change.
export const AI_READINESS_DEFAULT_TIMEOUT_MS = 15_000; // Separate control-plane probe timeout.
const DEEPSEEK_LISTING_STEP_RECOVERY_PROBE_VERSIONS = new Set([
  'DEEPSEEK_LISTING_STEP_RESPONSES_JSON_SCHEMA_RECOVERY_V1',
  'DEEPSEEK_LISTING_STEP_RESPONSES_JSON_SCHEMA_RECOVERY_V2',
]);

const PARTIAL_STATES = new Set(['NOT_STARTED', 'RUNNING', 'SUCCESS', 'CACHED_SUCCESS', 'TIMEOUT', 'FAILED', 'STALE']);
export const AI_PROVIDER_PARTIAL_RESULT_STATES = Object.freeze([...PARTIAL_STATES]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const iso = value => (value instanceof Date ? value : new Date(value ?? Date.now())).toISOString();
const normalizeProvider = value => String(value || '').toLowerCase() === 'qwen' ? 'Qwen' : String(value || '').toLowerCase() === 'deepseek' ? 'DeepSeek' : null;

function safeWhitespaceTelemetry(attempt, content) {
  const value = typeof content === 'string' ? content : null;
  const count = key => attempt?.[key] === null || attempt?.[key] === undefined || attempt?.[key] === ''
    ? null : (Number.isFinite(Number(attempt[key])) ? Number(attempt[key]) : null);
  return {
    raw_content_length: count('raw_content_length') ?? (value === null ? null : value.length),
    trimmed_content_length: count('trimmed_content_length') ?? (value === null ? null : value.trim().length),
    non_whitespace_length: count('non_whitespace_length') ?? (value === null ? null : value.replace(/\s/gu, '').length),
    whitespace_only: typeof attempt?.whitespace_only === 'boolean'
      ? attempt.whitespace_only : (value === null ? false : value.length > 0 && value.replace(/\s/gu, '').length === 0),
  };
}

function safeTransportAttemptTelemetry(item = {}) {
  const numeric = value => value === null || value === undefined || value === ''
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const safeCode = value => /^[A-Z0-9][A-Z0-9_.:-]{0,95}$/i.test(String(value || '')) ? String(value) : null;
  const schemaValidationErrors = Array.isArray(item.schema_validation_errors)
    ? item.schema_validation_errors.slice(0, 32).filter(value => typeof value === 'string'
      && /^\$(?:[A-Za-z0-9_.\[\]-]{1,180}):(TYPE|ENUM|ANY_OF|REQUIRED|MIN_LENGTH|MAX_LENGTH|MIN_ITEMS|MAX_ITEMS|MIN_PROPERTIES)$/.test(value))
    : [];
  const schemaValidationDetails = Array.isArray(item.schema_validation_details)
    ? item.schema_validation_details.slice(0, 32).flatMap(detail => {
      if (!detail || typeof detail !== 'object') return [];
      const safePath = typeof detail.path === 'string'
        && /^\$(?:[A-Za-z0-9_.\[\]-]{1,180})$/.test(detail.path) ? detail.path : null;
      const keyword = ['minLength', 'maxLength'].includes(String(detail.keyword)) ? String(detail.keyword) : null;
      const actual = Number(detail.actual);
      const expected = Number(detail.expected);
      if (!safePath || !keyword || !Number.isInteger(actual) || actual < 0 || actual > 1_000_000
          || !Number.isInteger(expected) || expected < 0 || expected > 1_000_000) return [];
      return [{ path: safePath, keyword, actual, expected }];
    })
    : [];
  return {
    attempt_index: Number(item.attempt_index) || 0,
    started_at: item.started_at || null,
    finished_at: item.finished_at || null,
    elapsed_ms: numeric(item.elapsed_ms),
    generation_timeout_ms: numeric(item.generation_timeout_ms),
    transport_retry: item.transport_retry === true,
    outbound_transport_started: item.outbound_transport_started === true,
    secure_connected: item.secure_connected === true || item.connected === true,
    secure_connect_elapsed_ms: numeric(item.secure_connect_elapsed_ms),
    secure_connect_observation: safeCode(item.secure_connect_observation) || 'NOT_OBSERVED',
    secure_connect_observed_elapsed_ms: numeric(item.secure_connect_observed_elapsed_ms),
    request_body_sent: item.request_body_sent === true,
    request_body_sent_elapsed_ms: numeric(item.request_body_sent_elapsed_ms),
    response_headers_received: item.response_headers_received === true || item.response_received === true,
    response_headers_elapsed_ms: numeric(item.response_headers_elapsed_ms),
    response_first_byte_elapsed_ms: numeric(item.response_first_byte_elapsed_ms),
    response_received: item.response_received === true,
    http_status: numeric(item.http_status),
    api_protocol: ['CHAT_COMPLETIONS', 'RESPONSES'].includes(String(item.api_protocol || '').toUpperCase()) ? String(item.api_protocol).toUpperCase() : null,
    structured_output: ['json_schema', 'json_object'].includes(String(item.structured_output || '').toLowerCase()) ? String(item.structured_output).toLowerCase() : null,
    reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(item.reasoning_effort || '').toLowerCase()) ? String(item.reasoning_effort).toLowerCase() : null,
    thinking_mode: item.thinking_mode === 'disabled' ? 'disabled' : null,
    preserve_thinking: typeof item.preserve_thinking === 'boolean' ? item.preserve_thinking : null,
    max_tokens_requested: numeric(item.max_tokens_requested),
    max_completion_tokens_requested: numeric(item.max_completion_tokens_requested),
    max_output_tokens_requested: numeric(item.max_output_tokens_requested),
    failure_stage: safeCode(item.failure_stage),
    failure_code: safeCode(item.failure_code),
    schema_validation_errors: schemaValidationErrors,
    schema_validation_details: schemaValidationDetails,
    transport_timeout_layer: String(item.failure_stage || '').startsWith('TIMEOUT')
      ? classifyTransportTimeoutLayer(item) : null,
  };
}

export function classifyTransportTimeoutLayer(attempt = {}) {
  if (attempt?.response_headers_received === true || attempt?.response_received === true || Number(attempt?.http_status) > 0) {
    return 'TIMEOUT_AFTER_HTTP_RESPONSE_STARTED';
  }
  if (attempt?.secure_connected === true || attempt?.connected === true) {
    return attempt?.request_body_sent === true ? 'REQUEST_SENT_WAITING_FOR_HTTP_RESPONSE' : 'TLS_CONNECTED_REQUEST_SEND_UNCONFIRMED';
  }
  if (attempt?.outbound_transport_started === true) return 'CONNECT_OR_TLS_NOT_CONFIRMED';
  return 'TRANSPORT_START_NOT_CONFIRMED';
}

const writeQueues = new Map();
function enqueue(file, operation) {
  const prior = writeQueues.get(file) || Promise.resolve();
  const current = prior.then(operation);
  let tracked;
  tracked = current.then(() => undefined, () => undefined).finally(() => {
    if (writeQueues.get(file) === tracked) writeQueues.delete(file);
  });
  // Keep the serialization chain fulfilled after a rejected operation while
  // returning the original rejection to its caller. This avoids an orphaned
  // unhandled rejection from a .finally()-derived promise.
  writeQueues.set(file, tracked);
  return current;
}

export function generationStorePath(dataRoot) {
  return path.join(dataRoot, 'integrations', 'ai-generation-recovery', 'state.json');
}

function emptyState() {
  return { schema_version: 1, contract_version: AI_GENERATION_RECOVERY_VERSION, partial_results: {}, circuits: {}, capability_probes: [], updated_at: iso() };
}

export async function readAiGenerationState(dataRoot) {
  try {
    const state = JSON.parse(await fs.readFile(generationStorePath(dataRoot), 'utf8'));
    if (!state || state.schema_version !== 1 || typeof state.partial_results !== 'object' || typeof state.circuits !== 'object') {
      throw Object.assign(new Error('AI generation recovery state schema is invalid.'), { code: 'AI_GENERATION_STATE_INVALID' });
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function updateState(dataRoot, updater) {
  const file = generationStorePath(dataRoot);
  return enqueue(file, async () => {
    const state = await readAiGenerationState(dataRoot);
    const result = await updater(state);
    state.updated_at = iso();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
    return clone(result ?? state);
  });
}

export function createAiGenerationIdentity({
  sku, step, inputVersionRefs, promptContractVersion = LISTING_AI_PROMPT_CONTRACT_VERSION,
  prompt, provider, effectiveModel, adapterContractVersion = AI_PROVIDER_RESULT_CONTRACT_VERSION,
  adapterVersion = 'NOT_REPORTED', executionContract = null,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!sku || !/^LISTING_SOP_1[0-7]$/.test(String(step || '')) || !normalizedProvider || !String(effectiveModel || '').trim()) {
    throw Object.assign(new Error('Generation identity requires SKU, SOP step, provider, and effective model.'), { code: 'AI_GENERATION_IDENTITY_INVALID' });
  }
  const inputVersionHash = sha256(JSON.stringify(inputVersionRefs || []));
  const promptHash = sha256(String(prompt ?? ''));
  const identity = {
    sku: String(sku), step: String(step), input_version_hash: inputVersionHash,
    input_version_refs: clone(inputVersionRefs || []), prompt_contract_version: String(promptContractVersion),
    prompt_hash: promptHash, provider: normalizedProvider, effective_model: String(effectiveModel),
    adapter_contract_version: String(adapterContractVersion), adapter_version: String(adapterVersion || 'NOT_REPORTED'),
  };
  // Optional so unchanged providers retain their existing partial cache keys.
  if (executionContract) identity.execution_contract = clone(executionContract);
  identity.generation_key = sha256(JSON.stringify(identity));
  return identity;
}

export function resolveAiTimeoutConfiguration(env = process.env) {
  const bounded = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  return {
    provider_readiness_timeout_ms: bounded(env.BOL_AI_PROVIDER_READINESS_TIMEOUT_MS, AI_READINESS_DEFAULT_TIMEOUT_MS, 1000, 120000),
    provider_generation_timeout_ms: bounded(env.BOL_AI_PROVIDER_GENERATION_TIMEOUT_MS, AI_GENERATION_DEFAULT_TIMEOUT_MS, 1000, 120000),
    provider_generation_timeout_source: env.BOL_AI_PROVIDER_GENERATION_TIMEOUT_MS ? 'ENV' : 'CURRENT_ADAPTER_DEFAULT_MIRROR',
    adapter_transport_retry_limit: 1,
    adapter_transport_retry_limit_source: 'CURRENT_ADAPTER_DEFAULT_OBSERVED; adapter owner controls retry behavior',
  };
}

export function resolveProviderGenerationAttemptPolicy({ provider, acceptancePolicy = false, acceptanceRuntime = false, recoveryTimeoutMs = null,
  defaultTimeoutMs = AI_GENERATION_DEFAULT_TIMEOUT_MS, defaultRetryLimit = 1 } = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized) throw Object.assign(new Error('Provider generation policy requires a known provider.'), { code: 'AI_PROVIDER_INVALID' });
  if (acceptancePolicy === true) return {
    timeout_ms: normalized === 'Qwen' ? 120000 : Math.max(1000, Math.min(120000, Number(defaultTimeoutMs) || AI_GENERATION_DEFAULT_TIMEOUT_MS)),
    max_retries: 0, source: 'ACCEPTANCE_SINGLE_ATTEMPT',
  };
  const recoveredTimeout = Number(recoveryTimeoutMs);
  if (Number.isInteger(recoveredTimeout) && recoveredTimeout >= 1000 && recoveredTimeout <= 120000) {
    return { timeout_ms: recoveredTimeout, max_retries: 0, source: 'FRESH_GENERATION_RECOVERY_PROBE' };
  }
  // Acceptance runtime generations are long-form listing work. Keep the
  // request bounded, but never retransmit a generation whose body may already
  // have reached the provider; that can create a second billable completion.
  // This is deliberately scoped to ACCEPTANCE_4181 by the caller and does not
  // change production runtime defaults.
  if (acceptanceRuntime === true) return {
    timeout_ms: 120000, max_retries: 0, source: 'ACCEPTANCE_RUNTIME_SINGLE_ATTEMPT',
  };
  const timeout = Number(defaultTimeoutMs);
  const retries = Number(defaultRetryLimit);
  return {
    timeout_ms: Number.isInteger(timeout) ? Math.max(1000, Math.min(120000, timeout)) : AI_GENERATION_DEFAULT_TIMEOUT_MS,
    max_retries: Number.isInteger(retries) ? Math.max(0, Math.min(1, retries)) : 1,
    source: 'RUNTIME_DEFAULT',
  };
}

function circuitFor(state, identity) {
  return state.circuits[identity.generation_key] || {
    generation_key: identity.generation_key, identity: clone(identity), failure_count: 0, state: 'CLOSED',
    last_generation_failed_at: null, last_failure_type: null, last_probe_ref: null, updated_at: iso(),
  };
}

function reconcileLegacyCircuit(state, identity) {
  const record = state.partial_results?.[identity.generation_key];
  const prior = state.circuits?.[identity.generation_key] || null;
  const unrepresented = (record?.attempts || []).filter(attempt => {
    const failed = ['FAILED', 'TIMEOUT'].includes(String(attempt?.status || '').toUpperCase())
      || Boolean(attempt?.failure_type);
    return failed && !Number.isFinite(Number(attempt?.complete_generation_failure_count));
  });
  if (!unrepresented.length && prior) return prior;
  let count = Number(prior?.failure_count || 0);
  for (const attempt of unrepresented) {
    count += 1;
    const failedAt = attempt.generation_failed_at || attempt.request_finished_at || null;
    attempt.complete_generation_failure_count = count;
    attempt.circuit_state = count >= 2 ? 'OPEN' : (prior?.state || 'CLOSED');
    if (failedAt) {
      attempt.generation_failed_at = failedAt;
      attempt.required_generation_readiness_after = failedAt;
    }
  }
  if (!count) return circuitFor(state, identity);
  const latest = unrepresented.map(item => ({
    at: Date.parse(String(item.generation_failed_at || item.request_finished_at || '')),
    type: item.failure_type || 'PROVIDER_GENERATION_FAILED',
  })).filter(item => Number.isFinite(item.at)).sort((a, b) => b.at - a.at)[0];
  const circuit = {
    ...(prior || circuitFor(state, identity)),
    generation_key: identity.generation_key,
    identity: clone(identity),
    failure_count: count,
    state: count >= 2 ? 'OPEN' : (prior?.state || 'CLOSED'),
    last_generation_failed_at: latest ? new Date(latest.at).toISOString() : (prior?.last_generation_failed_at || null),
    last_failure_type: latest?.type || prior?.last_failure_type || null,
    updated_at: iso(),
    migration: unrepresented.length ? 'LEGACY_PARTIAL_FAILURES_RECONCILED' : (prior?.migration || null),
  };
  state.circuits[identity.generation_key] = circuit;
  return circuit;
}

const GENERATION_FAILURE_TYPES = new Set([
  'PROVIDER_TIMEOUT', 'PROVIDER_EMPTY_CONTENT', 'OUTPUT_TRUNCATED',
  'PROVIDER_JSON_INVALID', 'PROVIDER_SCHEMA_INVALID', 'TRANSPORT_FAILURE',
]);

export function classifyGenerationFailure(result, metadata = {}) {
  const raw = String(result?.reason_code || result?.failure_type || metadata?.failure_code || '').toUpperCase();
  const http=Number(metadata?.http_status ?? result?.http_status);
  if(http>=400 && http<500 && http!==408 && http!==429)return 'PROVIDER_INVALID_REQUEST';
  if(http===429)return 'PROVIDER_RATE_LIMITED';
  if(http>=500)return 'PROVIDER_UPSTREAM_ERROR';
  if (/TIMEOUT/.test(raw)) return 'PROVIDER_TIMEOUT';
  if (/EMPTY_CONTENT|NO_CONTENT/.test(raw) || metadata?.content_state === 'EMPTY') return 'PROVIDER_EMPTY_CONTENT';
  if (/TRUNCAT|MAX_TOKEN|LENGTH/.test(raw) || metadata?.finish_reason === 'length') return 'OUTPUT_TRUNCATED';
  if (/SCHEMA/.test(raw) || metadata?.schema_validation === 'FAIL') return 'PROVIDER_SCHEMA_INVALID';
  if (/JSON|PARSE|STRUCTURED_RESPONSE_INVALID/.test(raw) || metadata?.json_parse === 'FAIL') return 'PROVIDER_JSON_INVALID';
  if (/ECONN|DNS|TLS|NETWORK|SOCKET|CONNECT|TRANSPORT|FETCH_FAILED/.test(raw)
      || (metadata?.response_received === false && metadata?.http_status == null)) return 'TRANSPORT_FAILURE';
  return GENERATION_FAILURE_TYPES.has(raw) ? raw : 'PROVIDER_GENERATION_FAILED';
}

function validateStructuredGenerationResult(result, { requiresJsonSchema = false } = {}) {
  const content = typeof result?.content === 'string' ? result.content.trim() : '';
  if (!content) return { success: false, failure_type: 'PROVIDER_EMPTY_CONTENT', parsed: null };
  const finishReason = String(result?.finish_reason || result?.attempt_metadata?.finish_reason || '').toLowerCase();
  if (finishReason === 'length' || finishReason === 'max_tokens') return { success: false, failure_type: 'OUTPUT_TRUNCATED', parsed: null };
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { return { success: false, failure_type: 'PROVIDER_JSON_INVALID', parsed: null }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { success: false, failure_type: 'PROVIDER_SCHEMA_INVALID', parsed: null };
  }
  const suppliedStructured = result?.structured_response;
  if (suppliedStructured != null && (!suppliedStructured || typeof suppliedStructured !== 'object' || Array.isArray(suppliedStructured))) {
    return { success: false, failure_type: 'PROVIDER_SCHEMA_INVALID', parsed: null };
  }
  if (result?.json_parse_success === false || result?.structured_parse === false || result?.schema_validation_success === false || result?.schema_validation === 'FAIL') {
    return { success: false, failure_type: result?.schema_validation_success === false || result?.schema_validation === 'FAIL' ? 'PROVIDER_SCHEMA_INVALID' : 'PROVIDER_JSON_INVALID', parsed: null };
  }
  if (requiresJsonSchema) {
    const attempts = Array.isArray(result?.attempt_telemetry) ? result.attempt_telemetry : [];
    const schemaStatus = String(attempts.at(-1)?.schema_validation || '').toUpperCase();
    if (schemaStatus !== 'PASS') return { success: false, failure_type: 'PROVIDER_SCHEMA_INVALID', parsed: null };
  }
  return { success: true, failure_type: null, parsed };
}

export async function beginProviderGenerationAttempt(dataRoot, identity, { requestTraceId, clientTimeoutMs, transportRetryLimit, executionId } = {}) {
  if (!identity?.generation_key || !PARTIAL_STATES.has('RUNNING')) throw new TypeError('A complete generation identity is required.');
  return updateState(dataRoot, state => {
    const previous = state.partial_results[identity.generation_key] || { identity: clone(identity), attempts: [] };
    const attemptNumber = previous.attempts.length + 1;
    const attempt = {
      execution_id: executionId || null, generation_attempt_number: attemptNumber,
      provider: identity.provider, effective_model: identity.effective_model,
      request_trace_id: requestTraceId || null, request_started_at: iso(), request_finished_at: null,
      elapsed_ms: null, client_timeout_ms: clientTimeoutMs ?? null,
      adapter_transport_retry_limit: transportRetryLimit ?? null,
      adapter_transport_attempt_count: null, adapter_transport_retry_count: null,
      http_connected: 'NOT_REPORTED', response_received: null, http_status: null,
      response_started: 'NOT_REPORTED', finish_reason: 'NOT_REPORTED',
      failure_type: null, status: 'RUNNING',
    };
    previous.status = 'RUNNING'; previous.identity = clone(identity); previous.current_attempt = attemptNumber;
    previous.attempts.push(attempt); previous.updated_at = iso(); state.partial_results[identity.generation_key] = previous;
    return { identity: clone(identity), attempt_number: attemptNumber, attempt: clone(attempt) };
  });
}

/** Reconcile only attempts proven to have been blocked before adapter dispatch. */
export async function recordProviderGenerationNotDispatched(dataRoot, identity, {
  attemptNumbers, reason = 'AI_WORKER_POOL_SCOPE_BLOCKED_BEFORE_PROVIDER_DISPATCH',
} = {}) {
  if (!identity?.generation_key || !Array.isArray(attemptNumbers) || !attemptNumbers.length
    || attemptNumbers.some(value => !Number.isInteger(value) || value < 1)
    || reason !== 'AI_WORKER_POOL_SCOPE_BLOCKED_BEFORE_PROVIDER_DISPATCH') {
    throw Object.assign(new Error('A narrowly scoped not-dispatched reconciliation is required.'), { code: 'AI_NOT_DISPATCHED_RECONCILIATION_INVALID' });
  }
  const numbers = [...new Set(attemptNumbers)].sort((a, b) => a - b);
  if (numbers.length !== attemptNumbers.length) throw Object.assign(new Error('Duplicate attempt numbers are not allowed.'), { code: 'AI_NOT_DISPATCHED_RECONCILIATION_INVALID' });
  return updateState(dataRoot, state => {
    const record = state.partial_results[identity.generation_key];
    if (!record || JSON.stringify(record.identity) !== JSON.stringify(identity)) {
      throw Object.assign(new Error('Generation identity does not match the persisted partial record.'), { code: 'AI_GENERATION_IDENTITY_MISMATCH' });
    }
    const selected = numbers.map(number => {
      const attempt = record.attempts?.[number - 1];
      if (!attempt || Number(attempt.generation_attempt_number) !== number) {
        throw Object.assign(new Error('Generation attempt does not exist.'), { code: 'AI_GENERATION_ATTEMPT_NOT_FOUND' });
      }
      if (attempt.status === 'NOT_DISPATCHED' && attempt.dispatch_reached_adapter === false) return { number, attempt, already: true };
      const hasTransportCount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
      const hasRequestEvidence = Boolean(attempt.request_trace_id || attempt.provider_request_id
        || attempt.http_status !== null && attempt.http_status !== undefined
        || attempt.response_received === true
        || hasTransportCount(attempt.adapter_transport_attempt_count)
        || hasTransportCount(attempt.adapter_transport_retry_count)
        || attempt.dispatch_reached_adapter === true || attempt.provider_dispatch_attempted === true
        || attempt.request_finished_at || attempt.elapsed_ms !== null && attempt.elapsed_ms !== undefined
        || attempt.status !== 'RUNNING');
      if (hasRequestEvidence) {
        throw Object.assign(new Error('Attempt contains evidence that may have reached the provider adapter.'), { code: 'AI_ATTEMPT_NOT_PROVEN_PRE_DISPATCH' });
      }
      return { number, attempt, already: false };
    });
    const fresh = selected.filter(item => !item.already);
    const existing = Array.isArray(state.dispatch_reconciliations) ? state.dispatch_reconciliations : [];
    const auditKey = `${identity.generation_key}:${numbers.join(',')}:${reason}`;
    const priorAudit = existing.find(item => item.audit_key === auditKey);
    if (!fresh.length && priorAudit) {
      // Older reconciliation code may have populated a request lifecycle field
      // for an attempt that never reached the adapter. Keep the audit timestamp
      // solely in reconciled_at and restore request telemetry to NOT_REPORTED.
      for (const { attempt } of selected) {
        attempt.request_finished_at = null;
        attempt.elapsed_ms = null;
      }
      record.updated_at = iso();
      return { status: 'ALREADY_RECONCILED', audit: clone(priorAudit), partial_status: record.status };
    }
    if (!fresh.length) throw Object.assign(new Error('Attempt reconciliation state has no matching audit record.'), { code: 'AI_NOT_DISPATCHED_AUDIT_MISSING' });
    const reconciledAt = iso();
    for (const { attempt } of fresh) {
      attempt.request_finished_at = null;
      attempt.elapsed_ms = null;
      attempt.failure_type = null;
      attempt.status = 'NOT_DISPATCHED';
      attempt.provider_dispatch_attempted = false;
      attempt.dispatch_reached_adapter = false;
      attempt.reconciled_reason = reason;
      attempt.reconciled_at = reconciledAt;
    }
    const stillRunning = record.attempts.some(attempt => attempt.status === 'RUNNING');
    if (!stillRunning && record.status === 'RUNNING' && !record.content) record.status = 'NOT_STARTED';
    record.updated_at = reconciledAt;
    state.dispatch_reconciliations = existing;
    const audit = { audit_key: auditKey, generation_key: identity.generation_key,
      sku: identity.sku, step: identity.step, provider: identity.provider,
      attempt_numbers: numbers, reason, provider_dispatch_attempted: false,
      dispatch_reached_adapter: false, reconciled_at: reconciledAt };
    existing.push(audit);
    return { status: 'RECONCILED_NOT_DISPATCHED', audit: clone(audit), partial_status: record.status };
  });
}

export async function recordCachedProviderResult(dataRoot, identity, result) {
  if (!result || result.status !== 'CACHED_SUCCESS' || typeof result.content !== 'string') throw new TypeError('Only an exact-key cached provider success can be recorded.');
  return updateState(dataRoot, state => {
    const record = state.partial_results[identity.generation_key];
    if (!record || record.status !== 'SUCCESS' || !record.content) throw Object.assign(new Error('Cached AI provider result is missing.'), { code: 'AI_PARTIAL_RESULT_NOT_FOUND' });
    record.consumed_at = iso();
    record.cache_status = 'CACHED_SUCCESS';
    return { generation_key: identity.generation_key, status: 'CACHED_SUCCESS', consumed_at: record.consumed_at };
  });
}

export async function recordProviderGenerationResult(dataRoot, identity, result, { attemptNumber, executionId } = {}) {
  return updateState(dataRoot, state => {
    const record = state.partial_results[identity.generation_key] || { identity: clone(identity), attempts: [], current_attempt: attemptNumber || 1 };
    const index = Math.max(0, Number(attemptNumber || record.current_attempt || record.attempts.length) - 1);
    if (!record.attempts[index]) record.attempts[index] = { generation_attempt_number: index + 1, request_started_at: iso(), status: 'RUNNING' };
    const attempt = record.attempts[index];
    // Legacy records may contain completed generation failures without a circuit write.
    // Reconcile them before counting this attempt so failures cannot be reset by an old runtime.
    reconcileLegacyCircuit(state, identity);
    const completedAt = result?.attempt_metadata?.request_finished_at || iso();
    const metadata = result?.attempt_metadata || {};
    const telemetry = Array.isArray(result?.attempt_telemetry) ? result.attempt_telemetry.at(-1) || {} : {};
    const transportAttempts = Array.isArray(result?.attempt_telemetry)
      ? result.attempt_telemetry.slice(0, 4).map(safeTransportAttemptTelemetry) : [];
    const requiresJsonSchema = identity?.execution_contract?.structured_output === 'json_schema';
    const validation = result?.status === 'PASS'
      ? validateStructuredGenerationResult(result, { requiresJsonSchema })
      : { success: false, failure_type: null, parsed: null };
    const success = result?.status === 'PASS' && validation.success;
    const failureType = success ? null : result?.status === 'PASS'
      ? (validation.failure_type || classifyGenerationFailure(result, { ...telemetry, ...metadata }))
      : classifyGenerationFailure(result, { ...telemetry, ...metadata });
    const isTimeout = failureType === 'PROVIDER_TIMEOUT';
    Object.assign(attempt, {
      execution_id: executionId || attempt.execution_id || null,
      requested_model: result?.requested_model || metadata.requested_model || attempt.requested_model || 'NOT_REPORTED',
      effective_request_model: result?.effective_request_model || metadata.effective_request_model || identity.effective_model,
      returned_model: result?.returned_model || metadata.returned_model || attempt.returned_model || 'NOT_REPORTED',
      adapter_version: result?.adapter_version || metadata.adapter_version || identity.adapter_version || 'NOT_REPORTED',
      request_trace_id: result?.request_id || attempt.request_trace_id || null,
      request_finished_at: completedAt,
      elapsed_ms: Number.isFinite(Number(metadata.elapsed_ms)) ? Number(metadata.elapsed_ms) : null,
      client_timeout_ms: metadata.client_timeout_ms ?? attempt.client_timeout_ms ?? null,
      adapter_transport_retry_limit: metadata.adapter_transport_retry_limit ?? attempt.adapter_transport_retry_limit ?? null,
      adapter_transport_attempt_count: metadata.adapter_transport_attempt_count ?? null,
      adapter_transport_retry_count: metadata.adapter_transport_retry_count ?? null,
      api_protocol: result?.api_protocol || metadata.api_protocol || null,
      structured_output: result?.structured_output || metadata.structured_output || null,
      reasoning_effort: result?.reasoning_effort || metadata.reasoning_effort || null,
      thinking_mode: result?.thinking_mode || metadata.thinking_mode || null,
      preserve_thinking: typeof result?.preserve_thinking === 'boolean' ? result.preserve_thinking : (typeof metadata.preserve_thinking === 'boolean' ? metadata.preserve_thinking : null),
      max_tokens_requested: metadata.max_tokens_requested ?? result?.max_tokens ?? null,
      max_completion_tokens_requested: metadata.max_completion_tokens_requested ?? telemetry.max_completion_tokens_requested ?? result?.max_completion_tokens ?? null,
      http_connected: typeof metadata.http_connected === 'boolean' ? metadata.http_connected
        : typeof telemetry.secure_connected === 'boolean' ? telemetry.secure_connected
          : typeof telemetry.connected === 'boolean' ? telemetry.connected : 'NOT_REPORTED',
      secure_connect_elapsed_ms: metadata.secure_connect_elapsed_ms ?? telemetry.secure_connect_elapsed_ms ?? null,
      outbound_transport_started: metadata.outbound_transport_started ?? telemetry.outbound_transport_started ?? false,
      request_body_sent: metadata.request_body_sent ?? telemetry.request_body_sent ?? false,
      request_body_sent_elapsed_ms: metadata.request_body_sent_elapsed_ms ?? telemetry.request_body_sent_elapsed_ms ?? null,
      response_headers_received: metadata.response_headers_received ?? telemetry.response_headers_received ?? telemetry.response_received ?? false,
      response_headers_elapsed_ms: metadata.response_headers_elapsed_ms ?? telemetry.response_headers_elapsed_ms ?? null,
      response_first_byte_elapsed_ms: metadata.response_first_byte_elapsed_ms ?? telemetry.response_first_byte_elapsed_ms ?? null,
      response_received: typeof metadata.response_received === 'boolean' ? metadata.response_received
        : typeof telemetry.response_received === 'boolean' ? telemetry.response_received : null,
      http_status: metadata.http_status ?? null,
      failure_stage: safeTransportAttemptTelemetry(telemetry).failure_stage,
      failure_code: safeTransportAttemptTelemetry(telemetry).failure_code,
      json_parse: ['PASS', 'FAIL', 'NOT_RUN'].includes(telemetry.json_parse) ? telemetry.json_parse : 'NOT_RUN',
      schema_validation: ['PASS', 'FAIL', 'NOT_RUN'].includes(telemetry.schema_validation) ? telemetry.schema_validation : 'NOT_RUN',
      schema_validation_errors: safeTransportAttemptTelemetry(telemetry).schema_validation_errors,
      schema_validation_details: safeTransportAttemptTelemetry(telemetry).schema_validation_details,
      api_protocol: safeTransportAttemptTelemetry(telemetry).api_protocol,
      structured_output: safeTransportAttemptTelemetry(telemetry).structured_output,
      reasoning_effort: safeTransportAttemptTelemetry(telemetry).reasoning_effort,
      thinking_mode: safeTransportAttemptTelemetry(telemetry).thinking_mode,
      preserve_thinking: safeTransportAttemptTelemetry(telemetry).preserve_thinking,
      max_tokens_requested: safeTransportAttemptTelemetry(telemetry).max_tokens_requested,
      max_completion_tokens_requested: safeTransportAttemptTelemetry(telemetry).max_completion_tokens_requested,
      max_output_tokens_requested: safeTransportAttemptTelemetry(telemetry).max_output_tokens_requested,
      transport_timeout_layer: failureType === 'PROVIDER_TIMEOUT' ? classifyTransportTimeoutLayer(telemetry) : null,
      transport_attempts: transportAttempts,
      provider_request_id: metadata.provider_request_id ?? telemetry.provider_request_id ?? null,
      provider_error_code: metadata.provider_error_code ?? telemetry.provider_error_code ?? null,
      provider_error_message: typeof (metadata.provider_error_message ?? telemetry.provider_error_message) === 'string'
        ? String(metadata.provider_error_message ?? telemetry.provider_error_message).slice(0, 512) : null,
      response_started: metadata.response_started || 'NOT_REPORTED',
      finish_reason: metadata.finish_reason || telemetry.finish_reason || result?.finish_reason || 'NOT_REPORTED',
      content_length: Number.isFinite(Number(telemetry.content_length)) ? Number(telemetry.content_length) : (typeof result?.content === 'string' ? result.content.length : null),
      ...safeWhitespaceTelemetry(telemetry, result?.content),
      reasoning_content_exists: typeof telemetry.reasoning_content_exists === 'boolean' ? telemetry.reasoning_content_exists : null,
      reasoning_content_length: Number.isFinite(Number(telemetry.reasoning_content_length)) ? Number(telemetry.reasoning_content_length) : null,
      max_tokens_requested: metadata.max_tokens_requested ?? telemetry.max_tokens_requested ?? null,
      usage: result?.usage && typeof result.usage === 'object' ? clone(result.usage) : (metadata.usage && typeof metadata.usage === 'object' ? clone(metadata.usage) : null),
      structured_parse_status: success || telemetry.json_parse === 'PASS' ? 'PASS' : telemetry.json_parse === 'FAIL' || failureType === 'PROVIDER_JSON_INVALID' ? 'FAIL' : 'NOT_PASS',
      structured_schema_status: telemetry.schema_validation === 'PASS' ? 'PASS' : telemetry.schema_validation === 'FAIL' || failureType === 'PROVIDER_SCHEMA_INVALID' ? 'FAIL' : 'NOT_RUN',
      failure_type: failureType,
      status: success ? 'SUCCESS' : isTimeout ? 'TIMEOUT' : 'FAILED',
    });
    record.identity = clone(identity); record.status = success ? 'SUCCESS' : isTimeout ? 'TIMEOUT' : 'FAILED';
    record.updated_at = completedAt; record.last_attempt = attemptNumber || index + 1;
    if (success) {
      record.content = result.content;
      record.provider_metadata = {
        provider: result.provider || identity.provider,
        requested_model: result.requested_model || null,
        effective_request_model: result.effective_request_model || identity.effective_model,
        returned_model: result.returned_model || 'NOT_REPORTED',
        adapter_version: result.adapter_version || identity.adapter_version || 'NOT_REPORTED',
        request_trace_id: result.request_id || null,
        api_protocol: result.api_protocol || null,
        structured_output: result.structured_output || null,
        reasoning_effort: result.reasoning_effort || null,
        thinking_mode: result.thinking_mode || null,
        preserve_thinking: typeof result.preserve_thinking === 'boolean' ? result.preserve_thinking : null,
        max_tokens: result.max_tokens || null,
        max_completion_tokens: result.max_completion_tokens || null,
        max_output_tokens: result.max_output_tokens || null,
        response_status: result.response_status || null,
        incomplete_reason: result.incomplete_reason || null,
        usage: result.usage || null,
      };
      const circuit = circuitFor(state, identity);
      circuit.failure_count = 0; circuit.state = 'CLOSED'; circuit.last_generation_failed_at = null;
      circuit.last_failure_type = null; circuit.last_probe_ref = null; circuit.updated_at = completedAt;
      state.circuits[identity.generation_key] = circuit;
    } else {
      delete record.content;
      delete record.provider_metadata;
      const circuit = circuitFor(state, identity);
      circuit.failure_count += 1;
      circuit.state = circuit.state === 'HALF_OPEN' || circuit.failure_count >= 2 ? 'OPEN' : 'CLOSED';
      circuit.last_generation_failed_at = completedAt;
      circuit.last_failure_type = failureType;
      circuit.last_probe_ref = null;
      circuit.updated_at = completedAt;
      state.circuits[identity.generation_key] = circuit;
      attempt.circuit_state = circuit.state;
      attempt.complete_generation_failure_count = circuit.failure_count;
      attempt.generation_failed_at = completedAt;
      attempt.required_generation_readiness_after = completedAt;
    }
    state.partial_results[identity.generation_key] = record;
    return { identity: clone(identity), partial_status: record.status, attempt: clone(attempt), circuit: clone(state.circuits[identity.generation_key] || null), generation_failed_at: success ? null : completedAt, failure_type: failureType };
  });
}

export async function getProviderPartialResult(dataRoot, identity) {
  const state = await readAiGenerationState(dataRoot);
  const record = state.partial_results[identity.generation_key];
  if (!isProviderPartialReusable(record, identity)) return null;
  return {
    provider: identity.provider, status: 'CACHED_SUCCESS', content: record.content,
    ...clone(record.provider_metadata || {}),
    request_id: record.provider_metadata?.request_trace_id || null,
    generation_key: identity.generation_key, cache_status: 'CACHED_SUCCESS',
  };
}

export function isProviderPartialReusable(record, identity) {
  if (!identity?.generation_key || record?.status !== 'SUCCESS'
    || JSON.stringify(record.identity) !== JSON.stringify(identity)
    || typeof record.content !== 'string' || !record.content.trim()) return false;
  try { const value = JSON.parse(record.content); return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
  catch { return false; }
}

export async function getProviderPartialResultState(dataRoot, identity) {
  const state = await readAiGenerationState(dataRoot);
  const record = state.partial_results[identity.generation_key];
  return record ? { status: PARTIAL_STATES.has(record.status) ? record.status : 'FAILED', updated_at: record.updated_at || null } : { status: 'NOT_STARTED', updated_at: null };
}

export async function markStaleMismatchedPartials(dataRoot, identity) {
  return updateState(dataRoot, state => {
    const stale = [];
    for (const [key, record] of Object.entries(state.partial_results)) {
      const prior = record.identity || {};
      if (prior.sku === identity.sku && prior.step === identity.step && prior.provider === identity.provider
        && key !== identity.generation_key && record.status !== 'STALE') {
        record.status = 'STALE'; record.content = null; record.updated_at = iso(); stale.push(key);
      }
    }
    return stale;
  });
}

export async function getGenerationCircuit(dataRoot, identity) {
  return updateState(dataRoot, state => clone(reconcileLegacyCircuit(state, identity)));
}

export async function recordGenerationCapabilityProbe(dataRoot, probe) {
  const provider = normalizeProvider(probe?.provider);
  if (!provider || !String(probe?.effective_model || '').trim()) throw new TypeError('Capability probe requires a supported provider and effective model.');
  const record = {
    probe_version: AI_GENERATION_CAPABILITY_PROBE_VERSION,
    probe_id: String(probe.probe_id || crypto.randomUUID()), provider,
    configured_model: probe.configured_model || 'NOT_REPORTED',
    effective_model: String(probe.effective_model), returned_model: probe.returned_model || 'NOT_REPORTED',
    started_at: probe.started_at || null, finished_at: probe.finished_at || null,
    checked_at: probe.checked_at || probe.finished_at || iso(), elapsed_ms: Number.isFinite(Number(probe.elapsed_ms)) ? Number(probe.elapsed_ms) : null,
    http_status: probe.http_status === null || probe.http_status === undefined || probe.http_status === '' ? null : (Number.isFinite(Number(probe.http_status)) ? Number(probe.http_status) : null),
    finish_reason: probe.finish_reason || 'NOT_REPORTED', structured_parse: probe.structured_parse === true,
    schema_result: probe.schema_result === true, status: ['PASS', 'RUNNING'].includes(probe.status) ? probe.status : 'FAIL',
    adapter_version: probe.adapter_version || 'NOT_REPORTED', request_trace_id: probe.request_trace_id || null,
    evidence_version: AI_GENERATION_CAPABILITY_EVIDENCE_VERSION,
    probe_contract_version: probe.probe_contract_version || 'NOT_REPORTED',
    prompt_contract_version: probe.prompt_contract_version || null,
    prompt_hash: /^[a-f0-9]{64}$/i.test(String(probe.prompt_hash || '')) ? String(probe.prompt_hash).toLowerCase() : null,
    generation_key: /^[a-f0-9]{64}$/i.test(String(probe.generation_key || '')) ? String(probe.generation_key).toLowerCase() : null,
    input_version_hash: /^[a-f0-9]{64}$/i.test(String(probe.input_version_hash || '')) ? String(probe.input_version_hash).toLowerCase() : null,
    target_generation_key: /^[a-f0-9]{64}$/i.test(String(probe.target_generation_key || '')) ? String(probe.target_generation_key).toLowerCase() : null,
    target_step: /^LISTING_SOP_1[0-7]$/.test(String(probe.target_step || '')) ? String(probe.target_step) : null,
    target_input_version_hash: /^[a-f0-9]{64}$/i.test(String(probe.target_input_version_hash || '')) ? String(probe.target_input_version_hash).toLowerCase() : null,
    target_prompt_contract_version: typeof probe.target_prompt_contract_version === 'string' ? probe.target_prompt_contract_version : null,
    target_prompt_hash: /^[a-f0-9]{64}$/i.test(String(probe.target_prompt_hash || '')) ? String(probe.target_prompt_hash).toLowerCase() : null,
    target_execution_contract_sha256: /^[a-f0-9]{64}$/i.test(String(probe.target_execution_contract_sha256 || '')) ? String(probe.target_execution_contract_sha256).toLowerCase() : null,
    target_identity_migration_version: typeof probe.target_identity_migration_version === 'string' ? probe.target_identity_migration_version : null,
    synthetic_prompt_hash: /^[a-f0-9]{64}$/i.test(String(probe.synthetic_prompt_hash || '')) ? String(probe.synthetic_prompt_hash).toLowerCase() : null,
    synthetic_input_characters: Number.isInteger(Number(probe.synthetic_input_characters)) ? Number(probe.synthetic_input_characters) : null,
    schema_sha256: probe.schema_sha256 || null,
    api_protocol: probe.api_protocol || null,
    structured_output: probe.structured_output || null,
    reasoning_effort: probe.reasoning_effort || null,
    preserve_thinking: typeof probe.preserve_thinking === 'boolean' ? probe.preserve_thinking : null,
    max_tokens: Number.isInteger(Number(probe.max_tokens)) ? Number(probe.max_tokens) : null,
    max_completion_tokens: Number.isInteger(Number(probe.max_completion_tokens)) ? Number(probe.max_completion_tokens) : null,
    max_output_tokens: Number.isInteger(Number(probe.max_output_tokens)) ? Number(probe.max_output_tokens) : null,
    response_status: probe.response_status || null,
    incomplete_reason: probe.incomplete_reason || null,
    endpoint_identity_hash: /^[a-f0-9]{64}$/i.test(String(probe.endpoint_identity_hash || '')) ? String(probe.endpoint_identity_hash).toLowerCase() : null,
    provider_config_hash: /^[a-f0-9]{64}$/i.test(String(probe.provider_config_hash || '')) ? String(probe.provider_config_hash).toLowerCase() : null,
    adapter_contract_version: probe.adapter_contract_version || 'NOT_REPORTED',
    adapter_contract_hash: /^[a-f0-9]{64}$/i.test(String(probe.adapter_contract_hash || '')) ? String(probe.adapter_contract_hash).toLowerCase() : null,
    network_config_hash: /^[a-f0-9]{64}$/i.test(String(probe.network_config_hash || '')) ? String(probe.network_config_hash).toLowerCase() : null,
    max_tokens_requested: Number.isInteger(Number(probe.max_tokens_requested)) && Number(probe.max_tokens_requested) > 0 ? Number(probe.max_tokens_requested) : null,
    generation_timeout_ms: Number.isFinite(Number(probe.generation_timeout_ms)) ? Number(probe.generation_timeout_ms) : null,
    adapter_transport_retry_limit: Number.isInteger(Number(probe.adapter_transport_retry_limit)) ? Number(probe.adapter_transport_retry_limit) : null,
    attempt_count: Number.isInteger(Number(probe.attempt_count)) ? Number(probe.attempt_count) : 0,
    retry_count: Number.isInteger(Number(probe.retry_count)) ? Number(probe.retry_count) : 0,
    external_requests: Number.isInteger(Number(probe.external_requests)) ? Number(probe.external_requests) : 0,
    provider_dispatch_attempted: probe.provider_dispatch_attempted === true,
    outbound_transport_started: probe.outbound_transport_started === true,
    provider_http_response_received: probe.provider_http_response_received === true,
    thinking_mode: ['disabled', 'enabled', 'NOT_REPORTED'].includes(probe.thinking_mode) ? probe.thinking_mode : null,
    attempts: Array.isArray(probe.attempts) ? probe.attempts.map(attempt => ({
      attempt_index: Number(attempt.attempt_index) || 0,
      attempt_status: ['RUNNING', 'PASS', 'FAIL'].includes(attempt.attempt_status) ? attempt.attempt_status : (attempt.finished_at ? 'PASS' : 'RUNNING'),
      generation_attempt: Number(attempt.generation_attempt) || 1,
      thinking_mode: ['disabled', 'enabled', 'NOT_REPORTED'].includes(attempt.thinking_mode) ? attempt.thinking_mode : null,
      started_at: attempt.started_at || null,
      finished_at: attempt.finished_at || null,
      elapsed_ms: Number.isFinite(Number(attempt.elapsed_ms)) ? Number(attempt.elapsed_ms) : null,
      max_tokens_requested: Number.isInteger(Number(attempt.max_tokens_requested)) && Number(attempt.max_tokens_requested) > 0 ? Number(attempt.max_tokens_requested) : null,
      max_completion_tokens_requested: Number.isInteger(Number(attempt.max_completion_tokens_requested)) && Number(attempt.max_completion_tokens_requested) > 0 ? Number(attempt.max_completion_tokens_requested) : null,
      max_output_tokens: Number.isInteger(Number(attempt.max_output_tokens)) && Number(attempt.max_output_tokens) > 0 ? Number(attempt.max_output_tokens) : null,
      generation_timeout_ms: Number.isFinite(Number(attempt.generation_timeout_ms)) ? Number(attempt.generation_timeout_ms) : null,
      transport_retry: attempt.transport_retry === true,
      outbound_transport_started: attempt.outbound_transport_started === true,
      secure_connected: attempt.secure_connected === true || attempt.connected === true,
      secure_connect_elapsed_ms: Number.isFinite(Number(attempt.secure_connect_elapsed_ms)) ? Number(attempt.secure_connect_elapsed_ms) : null,
      secure_connect_observation: /^[A-Z0-9_]{1,64}$/i.test(String(attempt.secure_connect_observation || '')) ? String(attempt.secure_connect_observation) : null,
      secure_connect_observed_elapsed_ms: Number.isFinite(Number(attempt.secure_connect_observed_elapsed_ms)) ? Number(attempt.secure_connect_observed_elapsed_ms) : null,
      request_body_sent: attempt.request_body_sent === true,
      request_body_sent_elapsed_ms: Number.isFinite(Number(attempt.request_body_sent_elapsed_ms)) ? Number(attempt.request_body_sent_elapsed_ms) : null,
      response_headers_received: attempt.response_headers_received === true || attempt.response_received === true,
      response_headers_elapsed_ms: Number.isFinite(Number(attempt.response_headers_elapsed_ms)) ? Number(attempt.response_headers_elapsed_ms) : null,
      response_first_byte_elapsed_ms: Number.isFinite(Number(attempt.response_first_byte_elapsed_ms)) ? Number(attempt.response_first_byte_elapsed_ms) : null,
      connected: attempt.connected === true,
      response_received: attempt.response_received === true,
      http_status: attempt.http_status === null || attempt.http_status === undefined || attempt.http_status === '' ? null : (Number.isFinite(Number(attempt.http_status)) ? Number(attempt.http_status) : null),
      returned_model: attempt.returned_model || null,
      finish_reason: attempt.finish_reason || null,
      response_status: attempt.response_status || null,
      incomplete_reason: attempt.incomplete_reason || null,
      reasoning_effort: attempt.reasoning_effort || null,
      preserve_thinking: typeof attempt.preserve_thinking === 'boolean' ? attempt.preserve_thinking : null,
      api_protocol: attempt.api_protocol || null,
      structured_output: attempt.structured_output || null,
      input_tokens: Number.isFinite(Number(attempt.input_tokens)) ? Number(attempt.input_tokens) : null,
      output_tokens: Number.isFinite(Number(attempt.output_tokens)) ? Number(attempt.output_tokens) : null,
      reasoning_tokens: Number.isFinite(Number(attempt.reasoning_tokens)) ? Number(attempt.reasoning_tokens) : null,
      content_state: ['EMPTY', 'NON_EMPTY', 'NOT_AVAILABLE'].includes(attempt.content_state) ? attempt.content_state : 'NOT_AVAILABLE',
      content_length: attempt.content_length === null || attempt.content_length === undefined || attempt.content_length === '' ? null : (Number.isFinite(Number(attempt.content_length)) ? Number(attempt.content_length) : null),
      ...safeWhitespaceTelemetry(attempt),
      reasoning_content_exists: attempt.reasoning_content_exists === true,
      reasoning_content_length: Number.isFinite(Number(attempt.reasoning_content_length)) ? Number(attempt.reasoning_content_length) : 0,
      json_parse: ['PASS', 'FAIL', 'NOT_RUN'].includes(attempt.json_parse) ? attempt.json_parse : 'NOT_RUN',
      schema_validation: ['PASS', 'FAIL', 'NOT_RUN'].includes(attempt.schema_validation) ? attempt.schema_validation : 'NOT_RUN',
      schema_validation_errors: safeTransportAttemptTelemetry(attempt).schema_validation_errors,
      schema_validation_details: safeTransportAttemptTelemetry(attempt).schema_validation_details,
      api_protocol: safeTransportAttemptTelemetry(attempt).api_protocol,
      structured_output: safeTransportAttemptTelemetry(attempt).structured_output,
      reasoning_effort: safeTransportAttemptTelemetry(attempt).reasoning_effort,
      thinking_mode: safeTransportAttemptTelemetry(attempt).thinking_mode,
      preserve_thinking: safeTransportAttemptTelemetry(attempt).preserve_thinking,
      max_tokens_requested: safeTransportAttemptTelemetry(attempt).max_tokens_requested,
      max_completion_tokens_requested: safeTransportAttemptTelemetry(attempt).max_completion_tokens_requested,
      max_output_tokens_requested: safeTransportAttemptTelemetry(attempt).max_output_tokens_requested,
      failure_stage: attempt.failure_stage || null,
      failure_code: attempt.failure_code || null,
    })) : [],
    failure_stage: probe.failure_stage || null,
    failure_classification: probe.failure_classification || null,
    failure_code: /^[A-Z0-9_:-]{1,96}$/.test(String(probe.failure_code || '')) ? String(probe.failure_code) : null,
    instrumentation_valid: probe.instrumentation_valid !== false,
    attempt_telemetry_complete: probe.attempt_telemetry_complete !== false,
    external_request_count_known: probe.external_request_count_known !== false,
    failure_barrier_at: probe.failure_barrier_at || null,
    generation_failed_at: probe.generation_failed_at || probe.failure_barrier_at || null,
    barrier_satisfied: probe.barrier_satisfied === true,
    prompt_logged: false, response_logged: false, reasoning_logged: false,
    usage: probe.usage || null, synthetic_only: true,
  };
  Object.assign(record, providerTransportCounters({
    attempts: record.attempts,
    providerDispatchAttempted: record.provider_dispatch_attempted,
    fallbackHttpStatus: record.http_status,
  }));
  return updateState(dataRoot, state => {
    const index = state.capability_probes.findIndex(item => item.probe_id === record.probe_id);
    if (index >= 0) state.capability_probes[index] = { ...state.capability_probes[index], ...record };
    else state.capability_probes.push(record);
    return record;
  });
}

export async function recordGenerationCapabilityProbeAttempt(dataRoot, probeId, attempt) {
  if (!probeId || !Number.isInteger(Number(attempt?.attempt_index)) || Number(attempt.attempt_index) < 1) {
    throw new TypeError('Capability probe attempt requires a probe id and positive attempt index.');
  }
  return updateState(dataRoot, state => {
    const probe = state.capability_probes.find(item => item.probe_id === probeId);
    if (!probe) throw Object.assign(new Error('Capability probe lifecycle record is missing.'), { code: 'AI_PROBE_LIFECYCLE_NOT_FOUND' });
    const clean = {
      attempt_index: Number(attempt.attempt_index),
      attempt_status: ['RUNNING', 'PASS', 'FAIL'].includes(attempt.attempt_status) ? attempt.attempt_status : 'RUNNING',
      generation_attempt: Number(attempt.generation_attempt) || 1,
      thinking_mode: ['disabled', 'enabled', 'NOT_REPORTED'].includes(attempt.thinking_mode) ? attempt.thinking_mode : null,
      started_at: attempt.started_at || null, finished_at: attempt.finished_at || null,
      elapsed_ms: Number.isFinite(Number(attempt.elapsed_ms)) ? Number(attempt.elapsed_ms) : null,
      max_tokens_requested: Number.isInteger(Number(attempt.max_tokens_requested)) && Number(attempt.max_tokens_requested) > 0 ? Number(attempt.max_tokens_requested) : null,
      max_completion_tokens_requested: Number.isInteger(Number(attempt.max_completion_tokens_requested)) && Number(attempt.max_completion_tokens_requested) > 0 ? Number(attempt.max_completion_tokens_requested) : null,
      max_output_tokens: Number.isInteger(Number(attempt.max_output_tokens)) && Number(attempt.max_output_tokens) > 0 ? Number(attempt.max_output_tokens) : null,
      api_protocol: ['CHAT_COMPLETIONS', 'RESPONSES'].includes(String(attempt.api_protocol || '').toUpperCase()) ? String(attempt.api_protocol).toUpperCase() : null,
      structured_output: ['json_schema', 'json_object'].includes(String(attempt.structured_output || '').toLowerCase()) ? String(attempt.structured_output).toLowerCase() : null,
      reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(attempt.reasoning_effort || '').toLowerCase()) ? String(attempt.reasoning_effort).toLowerCase() : null,
      preserve_thinking: typeof attempt.preserve_thinking === 'boolean' ? attempt.preserve_thinking : null,
      generation_timeout_ms: Number.isFinite(Number(attempt.generation_timeout_ms)) ? Number(attempt.generation_timeout_ms) : null,
      transport_retry: attempt.transport_retry === true,
      outbound_transport_started: attempt.outbound_transport_started === true,
      secure_connected: attempt.secure_connected === true || attempt.connected === true,
      secure_connect_elapsed_ms: Number.isFinite(Number(attempt.secure_connect_elapsed_ms)) ? Number(attempt.secure_connect_elapsed_ms) : null,
      secure_connect_observation: /^[A-Z0-9_]{1,64}$/i.test(String(attempt.secure_connect_observation || '')) ? String(attempt.secure_connect_observation) : null,
      secure_connect_observed_elapsed_ms: Number.isFinite(Number(attempt.secure_connect_observed_elapsed_ms)) ? Number(attempt.secure_connect_observed_elapsed_ms) : null,
      request_body_sent: attempt.request_body_sent === true,
      request_body_sent_elapsed_ms: Number.isFinite(Number(attempt.request_body_sent_elapsed_ms)) ? Number(attempt.request_body_sent_elapsed_ms) : null,
      response_headers_received: attempt.response_headers_received === true || attempt.response_received === true,
      response_headers_elapsed_ms: Number.isFinite(Number(attempt.response_headers_elapsed_ms)) ? Number(attempt.response_headers_elapsed_ms) : null,
      response_first_byte_elapsed_ms: Number.isFinite(Number(attempt.response_first_byte_elapsed_ms)) ? Number(attempt.response_first_byte_elapsed_ms) : null,
      connected: attempt.connected === true, response_received: attempt.response_received === true,
      http_status: attempt.http_status === null || attempt.http_status === undefined || attempt.http_status === '' ? null : (Number.isFinite(Number(attempt.http_status)) ? Number(attempt.http_status) : null),
      returned_model: attempt.returned_model || null, finish_reason: attempt.finish_reason || null,
      response_status: attempt.response_status || null, incomplete_reason: attempt.incomplete_reason || null,
      input_tokens: Number.isFinite(Number(attempt.input_tokens)) ? Number(attempt.input_tokens) : null,
      output_tokens: Number.isFinite(Number(attempt.output_tokens)) ? Number(attempt.output_tokens) : null,
      reasoning_tokens: Number.isFinite(Number(attempt.reasoning_tokens)) ? Number(attempt.reasoning_tokens) : null,
      content_state: ['EMPTY', 'NON_EMPTY', 'NOT_AVAILABLE'].includes(attempt.content_state) ? attempt.content_state : 'NOT_AVAILABLE',
      content_length: attempt.content_length === null || attempt.content_length === undefined || attempt.content_length === '' ? null : (Number.isFinite(Number(attempt.content_length)) ? Number(attempt.content_length) : null),
      ...safeWhitespaceTelemetry(attempt),
      reasoning_content_exists: attempt.reasoning_content_exists === true,
      reasoning_content_length: Number.isFinite(Number(attempt.reasoning_content_length)) ? Number(attempt.reasoning_content_length) : 0,
      json_parse: ['PASS', 'FAIL', 'NOT_RUN'].includes(attempt.json_parse) ? attempt.json_parse : 'NOT_RUN',
      schema_validation: ['PASS', 'FAIL', 'NOT_RUN'].includes(attempt.schema_validation) ? attempt.schema_validation : 'NOT_RUN',
      schema_validation_errors: safeTransportAttemptTelemetry(attempt).schema_validation_errors,
      schema_validation_details: safeTransportAttemptTelemetry(attempt).schema_validation_details,
      api_protocol: safeTransportAttemptTelemetry(attempt).api_protocol,
      structured_output: safeTransportAttemptTelemetry(attempt).structured_output,
      reasoning_effort: safeTransportAttemptTelemetry(attempt).reasoning_effort,
      thinking_mode: safeTransportAttemptTelemetry(attempt).thinking_mode,
      preserve_thinking: safeTransportAttemptTelemetry(attempt).preserve_thinking,
      max_tokens_requested: safeTransportAttemptTelemetry(attempt).max_tokens_requested,
      max_completion_tokens_requested: safeTransportAttemptTelemetry(attempt).max_completion_tokens_requested,
      max_output_tokens_requested: safeTransportAttemptTelemetry(attempt).max_output_tokens_requested,
      failure_stage: attempt.failure_stage || null, failure_code: attempt.failure_code || null,
    };
    const attempts = Array.isArray(probe.attempts) ? probe.attempts : [];
    const index = attempts.findIndex(item => item.attempt_index === clean.attempt_index);
    if (index >= 0) attempts[index] = { ...attempts[index], ...clean };
    else attempts.push(clean);
    attempts.sort((a, b) => a.attempt_index - b.attempt_index);
    probe.attempts = attempts;
    probe.attempt_count = attempts.length;
    probe.retry_count = Math.max(0, attempts.length - 1);
    if (attempt.provider_dispatch_attempted === true) probe.provider_dispatch_attempted = true;
    const transportCounters = providerTransportCounters({ attempts, providerDispatchAttempted: probe.provider_dispatch_attempted === true });
    probe.external_requests = transportCounters.external_requests;
    probe.outbound_transport_started = transportCounters.outbound_transport_started;
    probe.provider_http_response_received = transportCounters.provider_http_response_received;
    probe.updated_at = iso();
    return clean;
  });
}

export async function markGenerationProbeInstrumentationFailure(dataRoot, probeId, failureCode = 'PROBE_INSTRUMENTATION_CRASH') {
  return updateState(dataRoot, state => {
    const probe = state.capability_probes.find(item => item.probe_id === probeId);
    if (!probe) throw Object.assign(new Error('Capability probe record was not found.'), { code: 'AI_GENERATION_PROBE_NOT_FOUND' });
    probe.status = 'FAIL';
    probe.failure_stage = 'PROBE_INSTRUMENTATION_CRASH';
    probe.failure_classification = 'LOCAL_PROBE_INSTRUMENTATION_FAILURE';
    probe.failure_code = /^[A-Z0-9_:-]{1,96}$/.test(String(failureCode)) ? String(failureCode) : 'PROBE_INSTRUMENTATION_CRASH';
    probe.instrumentation_valid = false;
    probe.attempt_telemetry_complete = false;
    probe.external_request_count_known = false;
    probe.updated_at = iso();
    return clone(probe);
  });
}

export function findQualifyingGenerationProbe(state, wait) {
  if (!wait || !normalizeProvider(wait.provider) || !wait.effective_model || !wait.generation_key) return null;
  const requiredAfter = Date.parse(String(wait.required_generation_readiness_after || wait.generation_failed_at || ''));
  if (!Number.isFinite(requiredAfter)) return null;
  const records = [...(state?.capability_probes || [])].reverse().filter(item => !wait.probe_id || item.probe_id === wait.probe_id);
  return records.find(item => {
    const qwenStepProbe = item.probe_contract_version === 'QWEN_LISTING_STEP_JSON_SCHEMA_LOW_THINKING_RECOVERY_V1';
    const deepSeekListingStepProbe = DEEPSEEK_LISTING_STEP_RECOVERY_PROBE_VERSIONS.has(item.probe_contract_version);
    const executionContractHash = sha256(JSON.stringify(wait.execution_contract ?? null));
    const common = item.status === 'PASS' && item.synthetic_only === true
      && item.probe_version === AI_GENERATION_CAPABILITY_PROBE_VERSION
      && item.evidence_version === AI_GENERATION_CAPABILITY_EVIDENCE_VERSION
      && [AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION, 'DEEPSEEK_RESPONSES_JSON_SCHEMA_CAPABILITY_V1',
        QWEN_SOP10_CAPABILITY_PROBE_CONTRACT_VERSION, 'QWEN_LISTING_STEP_JSON_SCHEMA_LOW_THINKING_RECOVERY_V1',
        ...DEEPSEEK_LISTING_STEP_RECOVERY_PROBE_VERSIONS].includes(item.probe_contract_version)
      && /^[a-f0-9]{64}$/i.test(String(item.endpoint_identity_hash || ''))
      && /^[a-f0-9]{64}$/i.test(String(item.provider_config_hash || ''))
      && /^[a-f0-9]{64}$/i.test(String(item.adapter_contract_hash || ''))
      && /^[a-f0-9]{64}$/i.test(String(item.network_config_hash || ''))
      && item.provider === normalizeProvider(wait.provider)
      && item.effective_model === wait.effective_model
      && Date.parse(String(item.failure_barrier_at || item.generation_failed_at || '')) === requiredAfter
      && Date.parse(String(item.checked_at || '')) > requiredAfter;
    if (!common) return false;
    if (item.probe_contract_version === 'DEEPSEEK_RESPONSES_JSON_SCHEMA_CAPABILITY_V1') {
      return item.provider === 'DeepSeek' && item.api_protocol === 'RESPONSES' && item.structured_output === 'json_schema'
        && item.reasoning_effort === 'none' && item.response_status === 'completed' && item.max_output_tokens >= 16384;
    }
    if (deepSeekListingStepProbe) {
      return item.provider === 'DeepSeek' && item.api_protocol === 'RESPONSES' && item.structured_output === 'json_schema'
        && item.reasoning_effort === 'none' && item.response_status === 'completed'
        && item.target_identity_migration_version === wait.identity_migration_version
        && item.target_generation_key === wait.generation_key && item.target_step === wait.step
        && item.target_input_version_hash === wait.input_version_hash && item.target_prompt_hash === wait.prompt_hash
        && item.target_prompt_contract_version === wait.prompt_contract_version
        && item.target_execution_contract_sha256 === executionContractHash
        && item.schema_sha256 === wait.execution_contract?.schema_sha256
        && Number(item.max_output_tokens) >= 16384
        && Number(item.attempt_count) === 1 && Number(item.retry_count) === 0 && Number(item.external_requests) === 1
        && Array.isArray(item.attempts) && item.attempts.length === 1;
    }
    if (item.probe_contract_version === QWEN_SOP10_CAPABILITY_PROBE_CONTRACT_VERSION) {
      return item.provider === 'Qwen' && item.api_protocol === 'CHAT_COMPLETIONS' && item.structured_output === 'json_schema'
        && item.reasoning_effort === 'none' && item.thinking_mode === 'disabled' && item.preserve_thinking === false
        && item.max_completion_tokens === 16384 && item.target_generation_key === wait.generation_key
        && item.target_input_version_hash === wait.input_version_hash && item.target_prompt_hash === wait.prompt_hash
        && item.target_prompt_contract_version === wait.prompt_contract_version
        && item.target_execution_contract_sha256 === sha256(JSON.stringify(wait.execution_contract ?? null))
        && /^[a-f0-9]{64}$/i.test(String(item.synthetic_prompt_hash || ''))
        && Number(item.synthetic_input_characters) >= 80000
        && item.schema_sha256 === wait.execution_contract?.schema_sha256;
    }
    if (qwenStepProbe) {
      return item.provider === 'Qwen' && item.api_protocol === 'CHAT_COMPLETIONS' && item.structured_output === 'json_schema'
        && item.reasoning_effort === 'none' && item.thinking_mode === 'disabled' && item.preserve_thinking === false
        && item.target_generation_key === wait.generation_key && item.target_step === wait.step
        && item.target_input_version_hash === wait.input_version_hash && item.target_prompt_hash === wait.prompt_hash
        && item.target_prompt_contract_version === wait.prompt_contract_version
        && item.target_execution_contract_sha256 === executionContractHash
        && /^[a-f0-9]{64}$/i.test(String(item.synthetic_prompt_hash || ''))
        && Number(item.synthetic_input_characters) >= 80000
        && /^[a-f0-9]{64}$/i.test(String(item.schema_sha256 || ''));
    }
    return true;
  }) || null;
}

/**
 * Current-state gate for SOP10 recovery binding. This deliberately has no
 * historical revision/status constants: the caller supplies the live task and
 * the caller's current, exact input identity.
 */
export function validateSop10RecoveryBinding({
  task, activeLeaseCount = 0, identity, wait, probe, currentProviderIdentity,
  circuit, qwenPartial, qwenIdentity, now = Date.now(), readinessTtlMs = DEFAULT_AI_PROVIDER_READINESS_TTL_MS,
} = {}) {
  const checks = {};
  const check = (name, passed) => { checks[name] = passed === true; };
  const same = (left, right) => String(left ?? '') === String(right ?? '');
  const stepOkay = task?.current_step === 'LISTING_SOP_10' && task?.resume_point === 'LISTING_SOP_10'
    && task?.last_success_step === 'LISTING_SOP_09';
  const statusOkay = task?.status === 'PAUSED'
    || (task?.status === 'WAITING_DEPENDENCY' && task?.waiting_dependency_key === 'DEEPSEEK');
  check('recovery_task_identity_matches_context', Boolean(task?.sku && identity?.sku === task.sku && wait?.sku === task.sku));
  check('current_sop10_resume_state', stepOkay);
  check('allowed_task_status', statusOkay);
  check('waiting_dependency_key', task?.status !== 'WAITING_DEPENDENCY' || task?.waiting_dependency_key === 'DEEPSEEK');
  check('no_open_business_errors', Number(task?.open_error_count || 0) === 0);
  check('no_active_lease', Number(activeLeaseCount) === 0);
  check('no_formal_sop10_pass', !task?.outputs?.buyer_insights?.version && task?.qa?.LISTING_SOP_10?.status !== 'PASS');

  const barrier = String(wait?.generation_failed_at || '');
  const barrierMs = Date.parse(barrier);
  check('current_wait_identity', Boolean(identity?.generation_key && wait?.generation_key === identity.generation_key
    && wait?.sku === identity.sku && wait?.step === identity.step && wait?.provider === identity.provider
    && wait?.effective_model === identity.effective_model
    && wait?.input_version_hash === identity.input_version_hash
    && wait?.prompt_contract_version === identity.prompt_contract_version
    && wait?.prompt_hash === identity.prompt_hash
    && wait?.adapter_contract_version === identity.adapter_contract_version
    && wait?.adapter_version === identity.adapter_version
    && JSON.stringify(wait?.execution_contract) === JSON.stringify(identity.execution_contract)));
  check('failure_barrier_matches_task', Number.isFinite(barrierMs)
    && Date.parse(String(wait?.required_generation_readiness_after || '')) === barrierMs
    && Date.parse(String(task?.dependency_failed_at || '')) === barrierMs
    && Date.parse(String(task?.required_readiness_after || '')) === barrierMs);

  const providerHashesMatch = Boolean(currentProviderIdentity
    && probe?.endpoint_identity_hash === currentProviderIdentity.endpoint_identity_hash
    && probe?.provider_config_hash === currentProviderIdentity.provider_config_hash
    && probe?.adapter_contract_hash === currentProviderIdentity.adapter_contract_hash
    && probe?.network_config_hash === currentProviderIdentity.network_config_hash
    && probe?.adapter_version === currentProviderIdentity.adapter_version
    && probe?.adapter_contract_version === currentProviderIdentity.adapter_contract_version);
  check('probe_exact_identity', Boolean(probe && probe.status === 'PASS' && probe.synthetic_only === true
    && probe.instrumentation_valid === true && probe.probe_version === AI_GENERATION_CAPABILITY_PROBE_VERSION
    && probe.evidence_version === AI_GENERATION_CAPABILITY_EVIDENCE_VERSION
    && [AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION, 'DEEPSEEK_RESPONSES_JSON_SCHEMA_CAPABILITY_V1'].includes(probe.probe_contract_version)
    && probe.provider === identity?.provider && probe.configured_model === 'deepseek-v4-flash'
    && probe.effective_model === identity?.effective_model && probe.returned_model === identity?.effective_model
    && probe.thinking_mode === 'disabled'
    && same(probe.failure_barrier_at || probe.generation_failed_at, barrier)
    && providerHashesMatch));
  const responseSchemaProbe = probe?.probe_contract_version === 'DEEPSEEK_RESPONSES_JSON_SCHEMA_CAPABILITY_V1';
  const attempt = Array.isArray(probe?.attempts) ? probe.attempts.find(item => item.attempt_status === 'PASS'
    && Number(item.http_status) === 200 && item.json_parse === 'PASS' && item.schema_validation === 'PASS'
    && (responseSchemaProbe ? item.response_status === 'completed' && item.reasoning_effort === 'none' && Number(item.max_output_tokens) >= 16384 : item.thinking_mode === 'disabled')) : null;
  check('probe_response_contract', Boolean(probe?.structured_parse === true && probe?.schema_result === true
    && Number(probe?.http_status) === 200 && attempt
    && (!responseSchemaProbe || (probe.api_protocol === 'RESPONSES' && probe.structured_output === 'json_schema'
      && probe.reasoning_effort === 'none' && probe.response_status === 'completed' && Number(probe.max_output_tokens) >= 16384))));
  if (identity?.execution_contract) check('current_execution_protocol', responseSchemaProbe
    && identity.execution_contract.api_protocol === probe?.api_protocol
    && identity.execution_contract.structured_output === probe?.structured_output
    && identity.execution_contract.reasoning_effort === probe?.reasoning_effort
    && identity.adapter_contract_version === currentProviderIdentity?.adapter_contract_version
    && identity.adapter_version === currentProviderIdentity?.adapter_version);
  if (identity?.execution_contract) check('current_schema_contract', probe?.schema_sha256 === identity.execution_contract.schema_sha256
    && probe?.prompt_contract_version === identity.prompt_contract_version);
  const checkedAt = Date.parse(String(probe?.checked_at || ''));
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ttlMs = Number(readinessTtlMs);
  check('probe_fresh_after_failure', Number.isFinite(barrierMs) && Number.isFinite(checkedAt)
    && checkedAt > barrierMs && Number.isFinite(nowMs) && checkedAt <= nowMs
    && Number.isFinite(ttlMs) && ttlMs > 0 && nowMs - checkedAt <= ttlMs);

  const circuitBarrier = Date.parse(String(circuit?.last_generation_failed_at || ''));
  const boundHalfOpenPermitMatches = circuit?.state === 'HALF_OPEN'
    && task?.generation_recovery?.status === 'RECOVERY_AUTHORIZED'
    && task?.generation_recovery?.generation_key === identity?.generation_key
    && task?.generation_recovery?.probe_id === probe?.probe_id
    && task?.generation_recovery?.circuit_state === 'HALF_OPEN'
    && Boolean(task?.generation_recovery?.binding_version)
    && circuit?.last_probe_ref === probe?.probe_id;
  check('circuit_current_key_recoverable', Boolean(circuit
    && circuit.generation_key === identity?.generation_key
    && (['OPEN', 'CLOSED'].includes(circuit.state) || boundHalfOpenPermitMatches)
    && (Number(circuit.failure_count) >= 1 || (Number(circuit.inherited_failure_count) >= 1
      && circuit.protocol_migration_version === wait?.protocol_migration_version))
    && circuitBarrier === barrierMs));
  check('qwen_cached_partial_reusable', Boolean(qwenIdentity?.provider === 'Qwen'
    && qwenIdentity.sku === identity?.sku && qwenIdentity.step === identity?.step
    && qwenIdentity.input_version_hash === identity?.input_version_hash
    && isProviderPartialReusable(qwenPartial, qwenIdentity)));
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    allowed: failures.length === 0, failures, checks,
    route_readiness_source: failures.length === 0 ? 'GENERATION_RECOVERY' : null,
    generation_key: identity?.generation_key || null,
    probe_id: probe?.probe_id || null,
    circuit_state: circuit?.state || null,
    external_requests: 0,
  };
}

/** Dynamic SOP10 Qwen recovery validation used for a request-contract migration.
 * It deliberately accepts the current SYNTHETIC_ACCEPTANCE_05-style WAITING_DEPENDENCY state and
 * never requires DeepSeek or Qwen control-plane probes when the corresponding
 * exact generation/cache route is already present. */
export function validateQwenSop10RecoveryBinding({
  task, activeLeaseCount = 0, identity, wait, probe, currentProviderIdentity,
  circuit, migration = null, now = Date.now(), readinessTtlMs = DEFAULT_AI_PROVIDER_READINESS_TTL_MS,
} = {}) {
  const checks = {};
  const add = (name, ok) => { checks[name] = ok === true; };
  const same = (left, right) => String(left ?? '') === String(right ?? '');
  const barrier = Date.parse(String(wait?.generation_failed_at || ''));
  const taskBarrier = Date.parse(String(task?.dependency_failed_at || ''));
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const checkedAt = Date.parse(String(probe?.checked_at || ''));
  const ttl = Number(readinessTtlMs);
  add('task_step_checkpoint', task?.current_step === 'LISTING_SOP_10' && task?.resume_point === 'LISTING_SOP_10'
    && task?.last_success_step === 'LISTING_SOP_09');
  add('task_status', task?.status === 'PAUSED'
    || (task?.status === 'WAITING_DEPENDENCY' && task?.waiting_dependency_key === 'QWEN'));
  add('no_open_errors', Number(task?.open_error_count || 0) === 0);
  add('no_sop10_success', !task?.outputs?.buyer_insights?.version && task?.qa?.LISTING_SOP_10?.status !== 'PASS');
  add('no_active_lease', Number(activeLeaseCount) === 0);
  add('identity_provider_step', identity?.provider === 'Qwen' && identity?.step === 'LISTING_SOP_10'
    && identity?.sku === task?.sku && wait?.provider === 'Qwen' && wait?.step === 'LISTING_SOP_10');
  add('wait_matches_current_identity', Boolean(identity?.generation_key && wait?.generation_key === identity.generation_key
    && wait?.sku === identity.sku && wait?.effective_model === identity.effective_model
    && wait?.input_version_hash === identity.input_version_hash && wait?.prompt_contract_version === identity.prompt_contract_version
    && wait?.prompt_hash === identity.prompt_hash && wait?.adapter_contract_version === identity.adapter_contract_version
    && wait?.adapter_version === identity.adapter_version
    && JSON.stringify(wait?.execution_contract) === JSON.stringify(identity.execution_contract)));
  add('wait_failure_barrier', Number.isFinite(barrier) && barrier === taskBarrier
    && Date.parse(String(wait?.required_generation_readiness_after || '')) === barrier
    && Date.parse(String(task?.required_readiness_after || '')) === barrier);
  add('provider_hashes_match', Boolean(currentProviderIdentity
    && probe?.endpoint_identity_hash === currentProviderIdentity.endpoint_identity_hash
    && probe?.provider_config_hash === currentProviderIdentity.provider_config_hash
    && probe?.adapter_contract_hash === currentProviderIdentity.adapter_contract_hash
    && probe?.network_config_hash === currentProviderIdentity.network_config_hash
    && probe?.adapter_version === currentProviderIdentity.adapter_version
    && probe?.adapter_contract_version === currentProviderIdentity.adapter_contract_version));
  add('probe_exact_qwen_contract', Boolean(probe?.status === 'PASS' && probe.synthetic_only === true
    && probe.probe_version === AI_GENERATION_CAPABILITY_PROBE_VERSION
    && probe.evidence_version === AI_GENERATION_CAPABILITY_EVIDENCE_VERSION
    && probe.probe_contract_version === QWEN_SOP10_CAPABILITY_PROBE_CONTRACT_VERSION
    && probe.provider === 'Qwen' && probe.configured_model && probe.effective_model === identity?.effective_model
    && probe.returned_model === identity?.effective_model && probe.target_generation_key === identity?.generation_key
    && probe.target_input_version_hash === identity?.input_version_hash
    && probe.target_prompt_hash === identity?.prompt_hash
    && probe.target_prompt_contract_version === identity?.prompt_contract_version
    && probe.target_execution_contract_sha256 === sha256(JSON.stringify(identity?.execution_contract))
    && /^[a-f0-9]{64}$/i.test(String(probe.synthetic_prompt_hash || ''))
    && Number(probe.synthetic_input_characters) >= 80000
    && probe.schema_sha256 === identity?.execution_contract?.schema_sha256
    && probe.api_protocol === 'CHAT_COMPLETIONS' && probe.structured_output === 'json_schema'
    && probe.reasoning_effort === 'none' && probe.thinking_mode === 'disabled' && probe.preserve_thinking === false
    && Number(probe.max_completion_tokens) === 16384 && Number(probe.http_status) === 200
    && probe.structured_parse === true && probe.schema_result === true
    && same(probe.failure_barrier_at || probe.generation_failed_at, wait?.generation_failed_at)));
  const attempt = Array.isArray(probe?.attempts) ? probe.attempts.find(item => item.attempt_status === 'PASS'
    && Number(item.http_status) === 200 && item.json_parse === 'PASS' && item.schema_validation === 'PASS'
    && item.api_protocol === 'CHAT_COMPLETIONS' && item.structured_output === 'json_schema'
    && item.reasoning_effort === 'none' && item.thinking_mode === 'disabled'
    && item.preserve_thinking === false && Number(item.max_completion_tokens_requested) === 16384) : null;
  add('probe_attempt_contract', Boolean(attempt));
  add('probe_fresh_after_barrier', Number.isFinite(checkedAt) && Number.isFinite(barrier)
    && checkedAt > barrier && Number.isFinite(nowMs) && checkedAt <= nowMs
    && Number.isFinite(ttl) && ttl > 0 && nowMs - checkedAt <= ttl);
  const protocolMigrationMatches = Boolean(migration && migration.version === wait?.protocol_migration_version
    && migration.new_protocol_identity?.generation_key === identity?.generation_key
    && migration.old_failure_barrier === wait?.generation_failed_at && migration.history_relabelled === false);
  const identityMigrationMatches = Boolean(migration && migration.version === wait?.identity_migration_version
    && migration.new_identity?.generation_key === identity?.generation_key
    && migration.old_failure_barrier === wait?.generation_failed_at && migration.history_relabelled === false);
  add('circuit_recovery_state', Boolean(circuit && circuit.generation_key === identity?.generation_key
    && circuit.state === 'OPEN' && circuit.last_generation_failed_at === wait?.generation_failed_at
    && Number(circuit.inherited_failure_count || circuit.failure_count) >= 1
    && (!wait?.protocol_migration_version || (protocolMigrationMatches && circuit.protocol_migration_version === migration.version))
    && (!wait?.identity_migration_version || (identityMigrationMatches && circuit.identity_migration_version === migration.version))));
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { allowed: failures.length === 0, failures, checks,
    route_readiness_source: failures.length === 0 ? 'GENERATION_RECOVERY' : null,
    generation_key: identity?.generation_key || null, probe_id: probe?.probe_id || null,
    circuit_state: circuit?.state || null, external_requests: 0 };
}

export function assertTaskRevisionCAS(expectedRevision, observedRevision) {
  if (Number(expectedRevision) !== Number(observedRevision)) {
    throw Object.assign(new Error('Task revision changed before compare-and-swap commit.'), {
      code: 'TASK_REVISION_CAS_CONFLICT', expected_revision: Number(expectedRevision), observed_revision: Number(observedRevision),
    });
  }
  return true;
}

export async function evaluateGenerationRecoveryGate(dataRoot, wait) {
  const state = await readAiGenerationState(dataRoot);
  const legacyIdentity = state.partial_results?.[wait?.generation_key]?.identity || null;
  const circuit = wait?.generation_key && legacyIdentity
    ? reconcileLegacyCircuit(state, legacyIdentity)
    : state.circuits?.[wait?.generation_key] || null;
  const probe = await exactRecoveryProbe(dataRoot, state, wait);
  return {
    allowed: Boolean(probe), probe,
    circuit_state: circuit?.state || 'CLOSED', failure_count: Number(circuit?.failure_count || 0),
    reason: probe ? 'FRESH_GENERATION_CAPABILITY_PROBE_PASS' : 'GENERATION_PROBE_REQUIRED_AFTER_FAILURE',
  };
}

async function exactRecoveryProbe(dataRoot, state, wait) {
  if (!wait?.capability_evidence_ref) return findQualifyingGenerationProbe(state, wait);
  try {
    const evidence = await readCapabilityEvidence(dataRoot, wait.capability_evidence_ref);
    if (wait.capability_evidence_sha256 && evidence.sha256 !== wait.capability_evidence_sha256) return null;
    return findQualifyingGenerationProbe({ capability_probes: [evidence.probe] }, wait);
  } catch { return null; }
}

export async function evaluateGenerationRecoveryRoute(dataRoot, { wait, identity, consumedProbeId, consumedCircuitState, now = Date.now(), readinessTtlMs = DEFAULT_AI_PROVIDER_READINESS_TTL_MS } = {}) {
  const denied = reason => ({ allowed: false, reason, route_readiness_source: 'CONTROL_PLANE' });
  if (!wait || !identity || !consumedProbeId || !['CLOSED', 'HALF_OPEN'].includes(consumedCircuitState)) return denied('GENERATION_RECOVERY_CONTEXT_MISSING');
  const same = (left, right) => String(left ?? '') === String(right ?? '');
  const identityPairs = [
    [wait.generation_key, identity.generation_key], [wait.provider, identity.provider],
    [wait.effective_model, identity.effective_model], [wait.sku, identity.sku], [wait.step, identity.step],
    [wait.input_version_hash, identity.input_version_hash], [wait.prompt_contract_version, identity.prompt_contract_version],
    [wait.prompt_hash, identity.prompt_hash], [wait.adapter_contract_version, identity.adapter_contract_version],
    [wait.adapter_version, identity.adapter_version],
  ];
  // Older persisted waits may not carry adapter_contract_version as a separate field.
  // Their generation_key hashes that contract version, so exact key equality still binds it.
  if (identityPairs.some(([left, right], index) => index === 8 && left == null ? false : !same(left, right))) return denied('GENERATION_RECOVERY_IDENTITY_MISMATCH');
  const failedAt = Date.parse(String(wait.generation_failed_at || ''));
  const requiredAfter = Date.parse(String(wait.required_generation_readiness_after || ''));
  if (!Number.isFinite(failedAt) || !Number.isFinite(requiredAfter) || failedAt !== requiredAfter) return denied('GENERATION_RECOVERY_BARRIER_INVALID');
  const gate = await evaluateGenerationRecoveryGate(dataRoot, wait);
  if (!gate.allowed || gate.circuit_state === 'OPEN') return denied(gate.circuit_state === 'OPEN' ? 'GENERATION_CIRCUIT_OPEN' : gate.reason);
  if (gate.circuit_state !== consumedCircuitState) return denied('GENERATION_CIRCUIT_STATE_CHANGED');
  const probe = gate.probe;
  const checkedAt = Date.parse(String(probe?.checked_at || ''));
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ttlMs = Number(readinessTtlMs);
  const qwenSop10Probe = probe?.probe_contract_version === QWEN_SOP10_CAPABILITY_PROBE_CONTRACT_VERSION;
  const qwenListingStepProbe = probe?.probe_contract_version === 'QWEN_LISTING_STEP_JSON_SCHEMA_LOW_THINKING_RECOVERY_V1';
  const deepSeekListingStepProbe = DEEPSEEK_LISTING_STEP_RECOVERY_PROBE_VERSIONS.has(probe?.probe_contract_version);
  const hasPassingHttpSchemaAttempt = Array.isArray(probe?.attempts) && probe.attempts.some(attempt => attempt.attempt_status === 'PASS'
    && Number(attempt.http_status) === 200 && attempt.json_parse === 'PASS'
    && (!(qwenSop10Probe || qwenListingStepProbe) || (attempt.schema_validation === 'PASS' && attempt.api_protocol === 'CHAT_COMPLETIONS'
      && attempt.structured_output === 'json_schema' && attempt.reasoning_effort === 'none'
      && attempt.preserve_thinking === false))
    && (!qwenSop10Probe || attempt.max_completion_tokens_requested === 16384)
    && (!qwenListingStepProbe || attempt.max_completion_tokens_requested == null)
    && (!deepSeekListingStepProbe || (attempt.response_status === 'completed' && attempt.api_protocol === 'RESPONSES'
      && attempt.structured_output === 'json_schema' && attempt.reasoning_effort === 'none'
      && Number(attempt.max_output_tokens) >= 16384)));
  const qwenListingStepContractMatches = !qwenListingStepProbe || (probe.provider === 'Qwen'
    && probe.api_protocol === 'CHAT_COMPLETIONS' && probe.structured_output === 'json_schema'
    && probe.reasoning_effort === 'none' && probe.thinking_mode === 'disabled' && probe.preserve_thinking === false
    && probe.target_generation_key === identity.generation_key && probe.target_step === identity.step
    && probe.target_input_version_hash === identity.input_version_hash && probe.target_prompt_hash === identity.prompt_hash
    && probe.target_prompt_contract_version === identity.prompt_contract_version
    && probe.target_execution_contract_sha256 === sha256(JSON.stringify(wait.execution_contract ?? null))
    && /^[a-f0-9]{64}$/i.test(String(probe.synthetic_prompt_hash || ''))
    && Number(probe.synthetic_input_characters) >= 80000
    && /^[a-f0-9]{64}$/i.test(String(probe.schema_sha256 || ''))
    && Number(probe.attempt_count) === 1 && Number(probe.retry_count) === 0 && Number(probe.external_requests) === 1
    && Array.isArray(probe.attempts) && probe.attempts.length === 1);
  const deepSeekListingStepContractMatches = !deepSeekListingStepProbe || (probe.provider === 'DeepSeek'
    && probe.api_protocol === 'RESPONSES' && probe.structured_output === 'json_schema'
    && probe.reasoning_effort === 'none' && probe.response_status === 'completed'
    && probe.target_generation_key === identity.generation_key && probe.target_step === identity.step
    && probe.target_input_version_hash === identity.input_version_hash && probe.target_prompt_hash === identity.prompt_hash
    && probe.target_prompt_contract_version === identity.prompt_contract_version
    && probe.target_execution_contract_sha256 === sha256(JSON.stringify(wait.execution_contract ?? null))
    && probe.schema_sha256 === identity.execution_contract?.schema_sha256
    && Number(probe.max_output_tokens) >= 16384
    && /^[a-f0-9]{64}$/i.test(String(probe.synthetic_prompt_hash || ''))
    && Number(probe.synthetic_input_characters) >= 1000
    && Number(probe.attempt_count) === 1 && Number(probe.retry_count) === 0 && Number(probe.external_requests) === 1
    && Array.isArray(probe.attempts) && probe.attempts.length === 1);
  if (!probe || probe.probe_id !== consumedProbeId || probe.provider !== identity.provider || probe.effective_model !== identity.effective_model
    || !Number.isFinite(checkedAt) || checkedAt <= failedAt || !Number.isFinite(nowMs) || checkedAt > nowMs
    || !Number.isFinite(ttlMs) || ttlMs <= 0 || nowMs - checkedAt > ttlMs
    || probe.status !== 'PASS' || probe.schema_result !== true || probe.structured_parse !== true
    || probe.returned_model !== identity.effective_model || !hasPassingHttpSchemaAttempt
    || !qwenListingStepContractMatches || !deepSeekListingStepContractMatches) return denied('GENERATION_RECOVERY_PROBE_INVALID_OR_STALE');
  return {
    allowed: true, reason: 'GENERATION_RECOVERY_PROBE_MATCHED', route_readiness_source: 'GENERATION_RECOVERY',
    provider: identity.provider, effective_model: identity.effective_model, generation_key: identity.generation_key,
    probe_id: probe.probe_id, checked_at: probe.checked_at, circuit_state: gate.circuit_state,
    generation_timeout_ms: Number.isInteger(Number(probe.generation_timeout_ms))
      ? Math.max(1000, Math.min(120000, Number(probe.generation_timeout_ms))) : null,
  };
}

export async function consumeGenerationRecoveryGate(dataRoot, wait, { probeId = null, expectedCircuitState = null, protocolMigration = null, identityMigration = null, now = Date.now() } = {}) {
  const explicitProbe = wait?.capability_evidence_ref ? await exactRecoveryProbe(dataRoot, null, wait) : null;
  return updateState(dataRoot, state => {
    const probe = wait?.capability_evidence_ref ? explicitProbe : findQualifyingGenerationProbe(state, wait);
    if (!probe) return { allowed: false, reason: 'GENERATION_PROBE_REQUIRED_AFTER_FAILURE' };
    if (Number(now) - Date.parse(probe.checked_at) > DEFAULT_AI_PROVIDER_READINESS_TTL_MS
      || Date.parse(probe.checked_at) > Number(now)) return { allowed: false, reason: 'GENERATION_PROBE_EXPIRED' };
    if (probeId && probe.probe_id !== probeId) return { allowed: false, reason: 'GENERATION_PROBE_ID_CHANGED' };
    if (protocolMigration && !state.circuits[wait.generation_key]) {
      const old = state.circuits[protocolMigration.old_protocol_identity.generation_key];
      if (sha256(JSON.stringify(old)) !== protocolMigration.old_circuit_sha256)
        return { allowed: false, reason: 'RECOVERY_MIGRATION_CONCURRENT_CHANGE' };
      state.circuits[wait.generation_key] = { generation_key: wait.generation_key,
        identity: clone(protocolMigration.new_protocol_identity), state: 'OPEN', failure_count: 0,
        inherited_failure_count: Number(old.failure_count), last_generation_failed_at: wait.generation_failed_at,
        last_failure_type: 'LEGACY_PROTOCOL_FAILURE_BARRIER', protocol_migration_version: protocolMigration.version,
        last_probe_ref: null };
      state.protocol_migrations ||= {};
      state.protocol_migrations[protocolMigration.version] = clone(protocolMigration);
    }
    if (identityMigration && !state.circuits[wait.generation_key]) {
      const old = state.circuits[identityMigration.old_identity?.generation_key];
      if (!old || sha256(JSON.stringify(old)) !== identityMigration.old_circuit_sha256
        || identityMigration.version !== wait.identity_migration_version
        || identityMigration.new_identity?.generation_key !== wait.generation_key
        || identityMigration.old_failure_barrier !== wait.generation_failed_at
        || identityMigration.history_relabelled !== false)
        return { allowed: false, reason: 'RECOVERY_IDENTITY_MIGRATION_CONCURRENT_CHANGE' };
      state.circuits[wait.generation_key] = { generation_key: wait.generation_key,
        identity: clone(identityMigration.new_identity), state: 'OPEN', failure_count: 0,
        inherited_failure_count: Number(old.failure_count || old.inherited_failure_count || 0),
        last_generation_failed_at: wait.generation_failed_at,
        last_failure_type: 'INHERITED_PROMPT_CONTRACT_FAILURE_BARRIER',
        identity_migration_version: identityMigration.version, last_probe_ref: null };
      state.identity_migrations ||= {};
      state.identity_migrations[identityMigration.version] = clone(identityMigration);
    }
    const legacyIdentity = state.partial_results?.[wait?.generation_key]?.identity || null;
    const circuit = legacyIdentity ? reconcileLegacyCircuit(state, legacyIdentity) : state.circuits?.[wait.generation_key];
    if (expectedCircuitState && circuit?.state !== expectedCircuitState) return { allowed: false, reason: 'GENERATION_CIRCUIT_STATE_CHANGED' };
    if (circuit && !['OPEN', 'CLOSED'].includes(circuit.state)) return { allowed: false, reason: 'GENERATION_RECOVERY_ALREADY_CONSUMED' };
    if (circuit) {
      circuit.state = 'HALF_OPEN'; circuit.last_probe_ref = probe.probe_id; circuit.updated_at = iso();
      state.circuits[wait.generation_key] = circuit;
    }
    return { allowed: true, probe_id: probe.probe_id, circuit_state: circuit?.state || 'CLOSED' };
  });
}

export async function rollbackGenerationRecoveryConsumption(dataRoot, { generationKey, probeId, priorState } = {}) {
  return updateState(dataRoot, state => {
    const circuit = state.circuits?.[generationKey];
    if (!circuit || circuit.state !== 'HALF_OPEN' || circuit.last_probe_ref !== probeId) return false;
    if (!['OPEN', 'CLOSED'].includes(priorState)) return false;
    circuit.state = priorState;
    circuit.last_probe_ref = null;
    circuit.updated_at = iso();
    return true;
  });
}

export async function generationReadinessForProvider(dataRoot, provider, effectiveModel) {
  const state = await readAiGenerationState(dataRoot);
  const latest = [...(state.capability_probes || [])].reverse().find(item => item.probe_version === AI_GENERATION_CAPABILITY_PROBE_VERSION
    && item.provider === normalizeProvider(provider) && item.effective_model === effectiveModel
    && item.instrumentation_valid !== false
    && item.failure_stage !== 'PROBE_INSTRUMENTATION_CRASH'
    && item.failure_classification !== 'LOCAL_PROBE_INSTRUMENTATION_FAILURE');
  return latest ? { status: latest.status === 'PASS' ? 'GENERATION_READY' : 'GENERATION_UNAVAILABLE', checked_at: latest.checked_at,
    probe_version: latest.probe_version, evidence_version: latest.evidence_version, probe_contract_version: latest.probe_contract_version,
    endpoint_identity_hash: latest.endpoint_identity_hash, provider_config_hash: latest.provider_config_hash,
    adapter_version: latest.adapter_version, adapter_contract_version: latest.adapter_contract_version,
    adapter_contract_hash: latest.adapter_contract_hash, network_config_hash: latest.network_config_hash,
    returned_model: latest.returned_model, probe_id: latest.probe_id,
    evidence_current_contract: latest.evidence_version === AI_GENERATION_CAPABILITY_EVIDENCE_VERSION
      && latest.probe_contract_version === AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION }
    : { status: 'NOT_PROBED', checked_at: null, probe_version: AI_GENERATION_CAPABILITY_PROBE_VERSION,
      evidence_version: AI_GENERATION_CAPABILITY_EVIDENCE_VERSION, probe_contract_version: AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION, probe_id: null };
}

export async function latestGenerationFailureBarrierForProvider(dataRoot, provider, effectiveModel) {
  const normalized = normalizeProvider(provider);
  if (!normalized || !effectiveModel) return null;
  const state = await readAiGenerationState(dataRoot);
  const values = [];
  for (const item of state.capability_probes || []) {
    if (item.provider !== normalized || item.effective_model !== effectiveModel) continue;
    const value = item.generation_failed_at || item.failure_barrier_at;
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  for (const circuit of Object.values(state.circuits || {})) {
    if (circuit.provider && normalizeProvider(circuit.provider) !== normalized) continue;
    if (circuit.effective_model && circuit.effective_model !== effectiveModel) continue;
    const parsed = Date.parse(String(circuit.last_generation_failed_at || ''));
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  // Migrate barriers from legacy attempts that predate failure classification/circuit writes.
  // This keeps a probe issued after an earlier attempt from authorizing a retry after a newer failure.
  for (const partial of Object.values(state.partial_results || {})) {
    const identity = partial?.identity || {};
    if (normalizeProvider(identity.provider) !== normalized || identity.effective_model !== effectiveModel) continue;
    for (const attempt of partial.attempts || []) {
      const failed = ['FAILED', 'TIMEOUT'].includes(String(attempt?.status || '').toUpperCase()) || Boolean(attempt?.failure_type);
      if (!failed) continue;
      const parsed = Date.parse(String(attempt.generation_failed_at || attempt.request_finished_at || ''));
      if (Number.isFinite(parsed)) values.push(parsed);
    }
  }
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
}

function probeSchemaIsValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'buying_reasons,pain_points,selling_points,summary') return false;
  if (typeof value.summary !== 'string' || !value.summary.trim()) return false;
  const evidence = new Set(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);
  const validPoints = (items, min, max) => Array.isArray(items) && items.length >= min && items.length <= max
    && items.every(item => item && typeof item === 'object' && Object.keys(item).sort().join(',') === 'evidence_ids,text'
      && typeof item.text === 'string' && item.text.trim().length >= 8
      && Array.isArray(item.evidence_ids) && item.evidence_ids.length > 0
      && item.evidence_ids.every(id => evidence.has(id)));
  return validPoints(value.selling_points, 3, 5)
    && validPoints(value.pain_points, 2, 4)
    && validPoints(value.buying_reasons, 2, 4);
}

function classifyProbeFailure({ attempts, timeoutMs, failureStage, failureCode, response } = {}) {
  if (failureCode === 'PROVIDER_OUTPUT_TRUNCATED') return 'OUTPUT_TRUNCATED';
  if (failureStage === 'JSON_PARSE') return 'PROVIDER_RESPONSE_INVALID';
  if (failureStage === 'SCHEMA_VALIDATION') return 'PROVIDER_RESPONSE_INVALID';
  if (failureStage === 'EMPTY_CONTENT') return 'PROVIDER_RESPONSE_INVALID';
  if (['TIMEOUT_BEFORE_RESPONSE', 'TIMEOUT_DURING_RESPONSE'].includes(failureStage)) {
    const timedOut = (attempts || []).filter(item => item.failure_stage?.startsWith('TIMEOUT'));
    if (timedOut.length && timedOut.every(item => item.connected && !item.response_received && item.elapsed_ms >= timeoutMs * 0.9)) {
      return response?.status === 'PASS' ? 'PROVIDER_LATENCY_UNSTABLE' : 'CLIENT_TIMEOUT_TOO_SHORT';
    }
    return 'TRANSPORT_TIMEOUT';
  }
  if (failureCode === 'PROVIDER_TIMEOUT') return 'TRANSPORT_TIMEOUT';
  return failureCode || 'PROVIDER_RESPONSE_INVALID';
}

function syntheticCapabilityProbeInput(provider, timeoutMs) {
  const normalized = normalizeProvider(provider);
  return {
    module: 'AI_GENERATION_CAPABILITY_PROBE', timeout_ms: Number(timeoutMs),
    structured_output: true, max_tokens: AI_GENERATION_PROBE_MAX_TOKENS, temperature: 0,
    ...(normalized === 'DeepSeek' ? { extra_body: { thinking: { type: 'disabled' } } } : {}),
    system: 'Use only the fictional evidence supplied. Do not infer facts beyond evidence_ids. Return one JSON object only with exactly four fields: selling_points, pain_points, buying_reasons, summary. Each point must contain only text and evidence_ids. Provide 3-5 selling points, 2-4 pain points, and 2-4 buying reasons; every point must cite one or more supplied evidence IDs. No markdown.',
    prompt: JSON.stringify({
      probe_version: AI_GENERATION_CAPABILITY_PROBE_VERSION,
      synthetic_input: {
        item: 'fictional modular desk organizer for a home office',
        evidence: [
          { id: 'E1', text: 'The removable tray keeps small stationery items separated.' },
          { id: 'E2', text: 'The low front edge makes pens easy to reach while seated.' },
          { id: 'E3', text: 'Rubber feet help the organizer stay in place on a smooth desk.' },
          { id: 'E4', text: 'The compartments are clearly sized for clips, notes, and markers.' },
          { id: 'E5', text: 'A user says the shallow side walls do not contain taller tools.' },
          { id: 'E6', text: 'The divider positions cannot be adjusted after assembly.' },
          { id: 'E7', text: 'One person found the illustrated assembly steps difficult to follow.' },
        ],
        task: 'Synthesize evidenced selling points, pain points, and buying reasons in the required JSON contract.',
      },
      output_contract: {
        selling_points: [{ text: 'string', evidence_ids: ['E1'] }],
        pain_points: [{ text: 'string', evidence_ids: ['E5'] }],
        buying_reasons: [{ text: 'string', evidence_ids: ['E2'] }],
        summary: 'string',
      },
    }),
  };
}

export function getSyntheticCapabilityProbeContractMetadata(provider, timeoutMs = AI_GENERATION_DEFAULT_TIMEOUT_MS) {
  const input = syntheticCapabilityProbeInput(provider, timeoutMs);
  const system = `${input.system}\nReturn a JSON object only.`;
  return {
    message_count: 2,
    system_prompt_chars: system.length,
    user_prompt_chars: input.prompt.length,
    response_format: 'json_object',
    max_tokens: input.max_tokens,
    thinking_mode: normalizeProvider(provider) === 'DeepSeek' ? 'disabled' : 'NOT_APPLICABLE',
    contains_json_literal: /json/i.test(`${system}\n${input.prompt}`),
    contains_json_only_instruction: input.system.includes('Return one JSON object only'),
    contains_exact_json_only_instruction: input.system.includes('Return JSON only. Do not output prose before or after the JSON.'),
    contains_json_output_example: input.prompt.includes('"output_contract"'),
    contains_target_schema: input.prompt.includes('selling_points') && input.prompt.includes('pain_points') && input.prompt.includes('buying_reasons'),
  };
}

export async function runSyntheticCapabilityProbe({ provider, configuredModel, effectiveModel, timeoutMs, retryLimit = 0, failureBarrierAt = null, evidenceIdentity = {}, invoke, dataRoot, now = () => new Date() } = {}) {
  const normalized = normalizeProvider(provider);
  if (!normalized || typeof invoke !== 'function' || !Number.isInteger(Number(timeoutMs)) || Number(timeoutMs) < 1000) {
    throw Object.assign(new Error('Capability probe requires provider, invoke adapter, and an explicit generation timeout.'), { code: 'AI_GENERATION_PROBE_CONFIG_REQUIRED' });
  }
  const started = now();
  const barrierMs = Date.parse(String(failureBarrierAt || ''));
  if (normalized === 'DeepSeek' && (!Number.isFinite(barrierMs) || started.getTime() <= barrierMs)) {
    throw Object.assign(new Error('DeepSeek generation probe requires a current failure barrier older than probe start.'), { code: 'AI_GENERATION_PROBE_BARRIER_INVALID' });
  }
  const requestTraceId = crypto.randomUUID();
  const probeId = crypto.randomUUID();
  const synthetic = {
    ...syntheticCapabilityProbeInput(normalized, timeoutMs), request_id: requestTraceId,
    // The capability probe is one bounded generation attempt. Persisting a
    // retry limit without passing it to the adapter would allow a hidden
    // transport retry and violate the single-request gate.
    max_retries: Math.max(0, Math.min(1, Number.isInteger(Number(retryLimit)) ? Number(retryLimit) : 0)),
  };
  if (dataRoot) await recordGenerationCapabilityProbe(dataRoot, {
    probe_id: probeId, provider: normalized, configured_model: configuredModel || 'NOT_REPORTED',
    effective_model: effectiveModel || 'NOT_REPORTED', returned_model: 'NOT_REPORTED',
    started_at: iso(started), checked_at: iso(started), finished_at: null, elapsed_ms: null,
    generation_timeout_ms: Number(timeoutMs), adapter_transport_retry_limit: Number(retryLimit),
    max_tokens_requested: AI_GENERATION_PROBE_MAX_TOKENS,
    attempt_count: 0, retry_count: 0, external_requests: 0, provider_dispatch_attempted: false,
    outbound_transport_started: false, provider_http_response_received: false, attempts: [], status: 'RUNNING',
    failure_stage: null, failure_classification: null, failure_barrier_at: failureBarrierAt || null,
    ...evidenceIdentity, probe_contract_version: AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION,
    generation_failed_at: failureBarrierAt || null, barrier_satisfied: normalized !== 'DeepSeek' || started.getTime() > barrierMs,
    request_trace_id: requestTraceId, synthetic_only: true,
  });
  synthetic.on_attempt_started = async attempt => {
    if (!dataRoot) return;
    await recordGenerationCapabilityProbeAttempt(dataRoot, probeId, {
      attempt_index: attempt.attempt_index, attempt_status: 'RUNNING', generation_attempt: 1,
      provider_dispatch_attempted: true,
      thinking_mode: normalized === 'DeepSeek' ? 'disabled' : null,
      started_at: attempt.started_at, generation_timeout_ms: Number(timeoutMs), transport_retry: attempt.transport_retry,
      max_tokens_requested: AI_GENERATION_PROBE_MAX_TOKENS,
      connected: false, response_received: false, http_status: null, content_state: 'NOT_AVAILABLE',
      json_parse: 'NOT_RUN', schema_validation: 'NOT_RUN', failure_stage: null, failure_code: null,
    });
  };
  synthetic.on_attempt_finished = async attempt => {
    if (!dataRoot) return;
    await recordGenerationCapabilityProbeAttempt(dataRoot, probeId, {
      ...attempt, attempt_status: attempt.failure_stage === 'SUCCESS' ? 'PASS' : 'FAIL',
      generation_attempt: 1, thinking_mode: normalized === 'DeepSeek' ? 'disabled' : null, generation_timeout_ms: Number(timeoutMs),
      transport_retry: Number(attempt.attempt_index) > 1,
    });
  };
  let response;
  let invokeError = null;
  let status = 'FAIL';
  let parsed = null;
  let failureStage = null;
  let failureCode = null;
  let providerDispatchAttempted = false;
  const finishedNow = () => now();
  try {
    providerDispatchAttempted = true;
    response = await invoke(synthetic);
    if (response?.status !== 'PASS') {
      failureStage = response?.reason_code === 'AI_PROBE_TELEMETRY_PERSIST_FAILED'
        ? 'PROBE_INSTRUMENTATION_CRASH' : (response?.attempt_telemetry?.at(-1)?.failure_stage || 'HTTP');
      failureCode = response?.reason_code || response?.attempt_telemetry?.at(-1)?.failure_code || 'PROVIDER_CALL_FAILED';
    } else if (response?.finish_reason === 'length') {
      failureStage = 'OUTPUT_TRUNCATED'; failureCode = 'PROVIDER_OUTPUT_TRUNCATED';
    } else if (response?.attempt_metadata?.http_status != null && !(Number(response.attempt_metadata.http_status) >= 200 && Number(response.attempt_metadata.http_status) < 300)) {
      failureStage = 'HTTP'; failureCode = `HTTP_${response.attempt_metadata.http_status}`;
    } else if (typeof response?.content !== 'string' || !response.content.trim()) {
      failureStage = 'EMPTY_CONTENT'; failureCode = 'PROVIDER_EMPTY_CONTENT';
    } else {
      try {
        parsed = response?.structured_response && typeof response.structured_response === 'object'
          ? response.structured_response : JSON.parse(response.content);
      } catch {
        failureStage = 'JSON_PARSE'; failureCode = 'PROVIDER_JSON_PARSE_FAILED';
      }
      if (!failureStage && !probeSchemaIsValid(parsed)) {
        failureStage = 'SCHEMA_VALIDATION'; failureCode = 'PROVIDER_SCHEMA_INVALID';
      }
      if (!failureStage && String(response?.returned_model || response?.model || '') !== String(effectiveModel)) {
        failureStage = 'SCHEMA_VALIDATION'; failureCode = 'PROVIDER_MODEL_MISMATCH';
      }
      if (!failureStage) status = 'PASS';
    }
  } catch (error) {
    invokeError = error;
    status = 'FAIL';
    failureStage = error?.code === 'AI_PROBE_TELEMETRY_PERSIST_FAILED' ? 'PROBE_INSTRUMENTATION_CRASH' : (error?.attempt_telemetry?.at(-1)?.failure_stage || 'CONNECT');
    failureCode = String(error?.code || 'PROVIDER_CALL_FAILED');
  }
  const finished = finishedNow();
  const attempts = Array.isArray(response?.attempt_telemetry) ? structuredClone(response.attempt_telemetry)
    : Array.isArray(invokeError?.attempt_telemetry) ? structuredClone(invokeError.attempt_telemetry) : [];
  for (const attempt of attempts) {
    attempt.max_tokens_requested = AI_GENERATION_PROBE_MAX_TOKENS;
    if (attempt.content_state === 'EMPTY' && attempt.content_length === 0 && attempt.json_parse === 'PASS') attempt.json_parse = 'NOT_RUN';
  }
  const finalAttempt = attempts.at(-1) || {};
  const transportCounters = providerTransportCounters({
    attempts, providerDispatchAttempted,
    fallbackHttpStatus: response?.attempt_metadata?.http_status ?? invokeError?.http_status ?? null,
  });
  if (finalAttempt.finish_reason === 'length') {
    status = 'FAIL'; failureStage = 'OUTPUT_TRUNCATED'; failureCode = 'PROVIDER_OUTPUT_TRUNCATED';
  }
  for (const attempt of attempts) {
    attempt.generation_attempt = 1;
    attempt.attempt_status = status === 'PASS' ? 'PASS' : 'FAIL';
    if (attempt.attempt_index > 1) attempt.transport_retry = true;
    if (failureStage && attempt.attempt_index === attempts.length && ['JSON_PARSE', 'SCHEMA_VALIDATION', 'OUTPUT_TRUNCATED', 'EMPTY_CONTENT'].includes(failureStage)) {
      attempt.failure_stage = failureStage;
      attempt.failure_code = failureCode;
    }
    if (status === 'PASS' && attempt.attempt_index === attempts.length) attempt.schema_validation = 'PASS';
    else if (failureStage === 'SCHEMA_VALIDATION' && attempt.attempt_index === attempts.length) attempt.schema_validation = 'FAIL';
    if (failureStage === 'JSON_PARSE' && attempt.attempt_index === attempts.length) attempt.json_parse = 'FAIL';
    if (dataRoot) await recordGenerationCapabilityProbeAttempt(dataRoot, probeId, {
      ...attempt,
      attempt_status: status === 'PASS' ? 'PASS' : 'FAIL',
    });
  }
  const totalElapsed = Math.max(0, finished.getTime() - started.getTime());
  const barrierSatisfied = normalized !== 'DeepSeek' || finished.getTime() > barrierMs;
  if (!barrierSatisfied && status === 'PASS') { status = 'FAIL'; failureStage = 'BARRIER'; failureCode = 'PROBE_NOT_AFTER_FAILURE_BARRIER'; }
  const failureClassification = status === 'PASS' ? 'SUCCESS' : classifyProbeFailure({ attempts, timeoutMs: Number(timeoutMs), failureStage, failureCode, response });
  const record = {
    probe_id: probeId, provider: normalized, configured_model: configuredModel || 'NOT_REPORTED', effective_model: effectiveModel || 'NOT_REPORTED',
    returned_model: response?.returned_model || response?.model || finalAttempt.returned_model || 'NOT_REPORTED', started_at: iso(started), finished_at: iso(finished),
    checked_at: iso(finished), elapsed_ms: totalElapsed, generation_timeout_ms: Number(timeoutMs),
    max_tokens_requested: AI_GENERATION_PROBE_MAX_TOKENS,
    adapter_transport_retry_limit: Number(retryLimit), attempt_count: attempts.length, retry_count: Math.max(0, attempts.length - 1), attempts,
    ...transportCounters,
    thinking_mode: response?.thinking_mode || finalAttempt.thinking_mode || (normalized === 'DeepSeek' ? 'disabled' : null),
    finish_reason: response?.finish_reason || finalAttempt.finish_reason || 'NOT_REPORTED', structured_parse: Boolean(parsed),
    schema_result: status === 'PASS', status, failure_stage: failureStage, failure_classification: failureClassification,
    adapter_version: response?.adapter_version || evidenceIdentity.adapter_version || 'NOT_REPORTED', request_trace_id: response?.request_id || requestTraceId,
    failure_barrier_at: failureBarrierAt || null, generation_failed_at: failureBarrierAt || null, barrier_satisfied: barrierSatisfied,
    ...evidenceIdentity, probe_contract_version: AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION,
    http_status: response?.attempt_metadata?.http_status ?? finalAttempt.http_status ?? null,
    usage: response?.usage || null, synthetic_only: true, prompt_logged: false, response_logged: false, reasoning_logged: false,
  };
  return dataRoot ? recordGenerationCapabilityProbe(dataRoot, record) : record;
}

export function sanitizeProviderAttemptMetadata({ startedAt, finishedAt, timeoutMs, retryLimit, result, error } = {}) {
  const httpStatus = Number(error?.http_status ?? result?.http_status) || null;
  const adapterAttempts = Number(error?.attempt_count ?? result?.attempt_count) || null;
  return {
    request_started_at: startedAt || null, request_finished_at: finishedAt || null,
    elapsed_ms: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    client_timeout_ms: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null,
    adapter_transport_retry_limit: Number.isInteger(Number(retryLimit)) ? Number(retryLimit) : null,
    adapter_transport_attempt_count: adapterAttempts,
    adapter_transport_retry_count: adapterAttempts === null ? null : Math.max(0, adapterAttempts - 1),
    http_connected: error?.http_connected ?? result?.http_connected ?? (httpStatus !== null ? true : 'NOT_REPORTED'),
    response_received: error?.response_received ?? result?.response_received ?? (httpStatus !== null ? true : null),
    http_status: httpStatus,
    response_started: error?.response_started ?? result?.response_started ?? 'NOT_REPORTED',
    finish_reason: result?.finish_reason || error?.finish_reason || 'NOT_REPORTED',
    transport_attempts: (error?.attempt_telemetry || result?.attempt_telemetry || []).map(safeTransportAttemptTelemetry),
  };
}
