import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const AI_PROVIDER_READINESS_EVIDENCE_SCHEMA = 'bol.ai-provider-readiness.v1';
export const DEFAULT_AI_PROVIDER_READINESS_TTL_MS = 30 * 60 * 1000;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceFile = dataRoot => path.join(dataRoot, 'integrations', 'ai-provider-readiness', 'evidence.json');
const adapterSourceFile = path.join(projectRoot, 'app', 'ai_provider_adapters.mjs');
const proxyConfigFile = path.join(projectRoot, 'infra', 'bol-network-proxy.json');
const queues = new Map();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const iso = value => (value instanceof Date ? value : new Date(value ?? Date.now())).toISOString();
const normalizeProvider = value => String(value || '').toLowerCase() === 'qwen' ? 'Qwen' : String(value || '').toLowerCase() === 'deepseek' ? 'DeepSeek' : null;

function enqueue(file, operation) {
  const prior = queues.get(file) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  const queued = current.finally(() => { if (queues.get(file) === queued) queues.delete(file); });
  queues.set(file, queued);
  return current;
}

function normalizeRuntimeEnvironment(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'ACCEPTANCE' || raw === 'ACCEPTANCE_4181') return 'ACCEPTANCE';
  if (raw === 'PRODUCTION' || raw === 'PRODUCTION_4180') return 'PRODUCTION';
  return 'UNKNOWN';
}

function canonicalEndpointIdentity(endpoint) {
  const url = new URL(String(endpoint || ''));
  if (url.protocol !== 'https:' || !url.hostname) throw Object.assign(new Error('AI_PROVIDER_ENDPOINT_INVALID'), { code: 'AI_PROVIDER_ENDPOINT_INVALID' });
  // Persist only a one-way fingerprint; never persist endpoint query/userinfo values.
  return sha256(url.toString());
}

function safeConfigIdentity(provider, config, metadata, endpointHash) {
  return {
    provider,
    endpoint_identity_hash: endpointHash,
    requested_model: String(metadata?.requested_model || config?.requestedModel || config?.requested_model || config?.model || ''),
    effective_model: String(metadata?.effective_request_model || config?.effective_request_model || config?.model || ''),
    credential_env_name: String(config?.credentialEnv || config?.credential_env || ''),
    authentication_scheme: String(config?.authentication || ''),
  };
}

export async function buildProviderReadinessIdentity({ provider, providerConfig, adapterMetadata } = {}) {
  const normalized = normalizeProvider(provider || providerConfig?.name);
  if (!normalized || !providerConfig || String(providerConfig.name || '').toLowerCase() !== normalized.toLowerCase()) {
    throw Object.assign(new Error('AI_PROVIDER_IDENTITY_CONFIG_INVALID'), { code: 'AI_PROVIDER_IDENTITY_CONFIG_INVALID' });
  }
  const endpointIdentityHash = canonicalEndpointIdentity(providerConfig.endpoint);
  const safeConfig = safeConfigIdentity(normalized, providerConfig, adapterMetadata, endpointIdentityHash);
  const adapterBytes = await fs.readFile(adapterSourceFile);
  const adapterSourceHash = sha256(adapterBytes);
  const adapterContractVersion = String(adapterMetadata?.adapter_contract_version || 'NOT_REPORTED');
  const adapterContractHash = sha256(`${adapterContractVersion}\n${adapterSourceHash}`);
  let networkConfigHash = null;
  try { networkConfigHash = sha256(await fs.readFile(proxyConfigFile)); } catch { /* Missing network config makes evidence non-matching below. */ }
  return {
    provider: normalized,
    endpoint_identity_hash: endpointIdentityHash,
    provider_config_hash: sha256(JSON.stringify(safeConfig)),
    requested_model: safeConfig.requested_model,
    effective_model: safeConfig.effective_model,
    adapter_version: String(adapterMetadata?.adapter_version || 'NOT_REPORTED'),
    adapter_contract_version: adapterContractVersion,
    adapter_contract_hash: adapterContractHash,
    network_config_hash: networkConfigHash,
  };
}

export async function readProviderReadinessEvidence(dataRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(evidenceFile(dataRoot), 'utf8'));
    if (parsed?.schema !== AI_PROVIDER_READINESS_EVIDENCE_SCHEMA || !Array.isArray(parsed.evidence)) {
      throw Object.assign(new Error('AI_PROVIDER_READINESS_EVIDENCE_INVALID'), { code: 'AI_PROVIDER_READINESS_EVIDENCE_INVALID' });
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schema: AI_PROVIDER_READINESS_EVIDENCE_SCHEMA, evidence: [], updated_at: null };
    throw error;
  }
}

function readinessResultMetadata(result = {}) {
  const diagnostics = result.diagnostics || {};
  const nullableNumber = value => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    http_status: nullableNumber(result.http_status ?? diagnostics.http_status),
    elapsed_ms: nullableNumber(result.elapsed_ms),
    finish_reason: typeof result.finish_reason === 'string' ? result.finish_reason : (typeof diagnostics.finish_reason === 'string' ? diagnostics.finish_reason : null),
    content_state: ['non-empty', 'empty', 'null'].includes(diagnostics.content_state) ? diagnostics.content_state : (['NON_EMPTY', 'EMPTY', 'NOT_AVAILABLE'].includes(result.content_state) ? result.content_state : null),
    content_length: nullableNumber(diagnostics.content_length ?? result.content_length),
    json_parse: (diagnostics.json_parse_success ?? result.json_parse_success) === true ? 'PASS' : (diagnostics.json_parse_success === false || result.json_parse_success === false ? 'FAIL' : 'NOT_REPORTED'),
    schema_validation: (diagnostics.schema_validation_success ?? result.schema_validation_success) === true ? 'PASS' : (diagnostics.schema_validation_success === false || result.schema_validation_success === false ? 'FAIL' : 'NOT_REPORTED'),
    failure_stage: typeof diagnostics.failure_stage === 'string' ? diagnostics.failure_stage : (typeof result.failure_stage === 'string' ? result.failure_stage : null),
    failure_code: typeof result.reason_code === 'string' ? result.reason_code : null,
    provider_error_code: typeof (result.provider_error_code ?? diagnostics.provider_error_code) === 'string' ? (result.provider_error_code ?? diagnostics.provider_error_code) : null,
    provider_error_message: typeof (result.provider_error_message ?? diagnostics.provider_error_message) === 'string' ? (result.provider_error_message ?? diagnostics.provider_error_message).slice(0, 512) : null,
    provider_request_id: typeof (result.provider_request_id ?? diagnostics.provider_request_id) === 'string' ? (result.provider_request_id ?? diagnostics.provider_request_id) : null,
    external_request_count: result.external_request_count === null || result.external_request_count === undefined || result.external_request_count === '' ? null : (Number.isInteger(Number(result.external_request_count)) ? Number(result.external_request_count) : null),
  };
}

export async function persistProviderReadinessEvidence({ dataRoot, provider, providerConfig, adapterMetadata, result, runtimeEnvironment, source = 'PROVIDER_PROBE', evidenceId = null } = {}) {
  const identity = await buildProviderReadinessIdentity({ provider, providerConfig, adapterMetadata });
  const checkedAt = iso(result?.checked_at || Date.now());
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedMs)) throw Object.assign(new Error('AI_PROVIDER_READINESS_CHECKED_AT_INVALID'), { code: 'AI_PROVIDER_READINESS_CHECKED_AT_INVALID' });
  const ttlValue = Number(process.env.BOL_AI_PROVIDER_READINESS_TTL_MS);
  const ttlMs = Number.isInteger(ttlValue) && ttlValue > 0 ? Math.min(ttlValue, 24 * 60 * 60 * 1000) : DEFAULT_AI_PROVIDER_READINESS_TTL_MS;
  const status = result?.ready === true || result?.status === 'READY' ? 'READY' : (result?.status === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'UNAVAILABLE');
  const record = {
    evidence_id: evidenceId || crypto.randomUUID(),
    provider: identity.provider,
    status,
    checked_at: checkedAt,
    expires_at: new Date(checkedMs + ttlMs).toISOString(),
    configured_model: identity.requested_model,
    requested_model: String(result?.requested_model || identity.requested_model),
    effective_model: String(result?.effective_request_model || result?.effective_model || identity.effective_model),
    returned_model: typeof result?.returned_model === 'string' ? result.returned_model : null,
    endpoint_identity_hash: identity.endpoint_identity_hash,
    provider_config_hash: identity.provider_config_hash,
    adapter_version: identity.adapter_version,
    adapter_contract_version: identity.adapter_contract_version,
    adapter_contract_hash: identity.adapter_contract_hash,
    network_config_hash: identity.network_config_hash,
    runtime_environment: normalizeRuntimeEnvironment(runtimeEnvironment),
    probe_type: 'CONTROL_PLANE',
    source: String(source),
    result_metadata: readinessResultMetadata(result),
    prompt_logged: false,
    response_logged: false,
    credential_logged: false,
  };
  return enqueue(evidenceFile(dataRoot), async () => {
    const file = evidenceFile(dataRoot);
    const state = await readProviderReadinessEvidence(dataRoot);
    if (!state.evidence.some(item => item.evidence_id === record.evidence_id)) state.evidence.push(record);
    state.updated_at = new Date().toISOString();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
    return structuredClone(record);
  });
}

export async function evaluateProviderReadinessHydration({ dataRoot, provider, providerConfig, adapterMetadata, runtimeEnvironment, runtimeReadiness = {}, now = new Date(), failureBarrierAt = null } = {}) {
  const state = await readProviderReadinessEvidence(dataRoot);
  const normalized = normalizeProvider(provider);
  const rows = state.evidence.filter(item => item.provider === normalized && item.probe_type === 'CONTROL_PLANE')
    .sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
  if (!rows.length) return { status: 'NOT_AVAILABLE', reason: 'NO_PERSISTED_EVIDENCE', evidence: null, readiness: runtimeReadiness };
  const latest = rows.at(-1);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const checks = await buildProviderReadinessIdentity({ provider: normalized, providerConfig, adapterMetadata });
  const mismatches = [];
  for (const key of ['endpoint_identity_hash', 'provider_config_hash', 'requested_model', 'effective_model', 'adapter_version', 'adapter_contract_version', 'adapter_contract_hash', 'network_config_hash']) {
    if (latest[key] !== checks[key]) mismatches.push(key);
  }
  if (latest.runtime_environment !== normalizeRuntimeEnvironment(runtimeEnvironment)) mismatches.push('runtime_environment');
  const checkedMs = Date.parse(latest.checked_at);
  const expiresMs = Date.parse(latest.expires_at);
  const latestFailure = [...rows].reverse().find(item => item.status !== 'READY');
  const recordedBarrierMs = Date.parse(String(latestFailure?.checked_at || ''));
  const suppliedBarrierMs = Date.parse(String(failureBarrierAt || ''));
  const barrierMs = Math.max(Number.isFinite(recordedBarrierMs) ? recordedBarrierMs : Number.NEGATIVE_INFINITY,
    Number.isFinite(suppliedBarrierMs) ? suppliedBarrierMs : Number.NEGATIVE_INFINITY);
  if (latest.status !== 'READY') mismatches.push('evidence_status');
  if (!Number.isFinite(checkedMs) || checkedMs > nowMs || !Number.isFinite(expiresMs) || expiresMs <= nowMs) mismatches.push('evidence_expired');
  if (Number.isFinite(barrierMs) && checkedMs <= barrierMs) mismatches.push('provider_failure_barrier');
  const runtimeCheckedMs = Date.parse(String(runtimeReadiness?.checked_at || ''));
  if (Number.isFinite(runtimeCheckedMs) && runtimeCheckedMs > checkedMs) mismatches.push('newer_runtime_probe_exists');
  if (mismatches.length) return {
    status: 'STALE', reason: 'EVIDENCE_NOT_USABLE', mismatches: [...new Set(mismatches)],
    evidence: { evidence_id: latest.evidence_id, checked_at: latest.checked_at, expires_at: latest.expires_at, source: latest.source },
    readiness: runtimeReadiness,
  };
  const readiness = {
    ...runtimeReadiness,
    status: 'READY', ready: true, reason_code: null,
    model: latest.returned_model || latest.effective_model,
    requested_model: latest.requested_model, effective_request_model: latest.effective_model,
    returned_model: latest.returned_model, checked_at: latest.checked_at,
    http_status: latest.result_metadata.http_status,
    endpoint_identity_hash: latest.endpoint_identity_hash,
    provider_config_hash: latest.provider_config_hash,
    adapter_version: latest.adapter_version,
    adapter_contract_version: latest.adapter_contract_version,
    adapter_contract_hash: latest.adapter_contract_hash,
    probe_type: latest.probe_type, runtime_environment: latest.runtime_environment,
    readiness_evidence_status: 'HYDRATED_READY', readiness_evidence_id: latest.evidence_id,
    readiness_evidence_source: latest.source, readiness_evidence_expires_at: latest.expires_at,
    diagnostics: { http_status: latest.result_metadata.http_status, finish_reason: latest.result_metadata.finish_reason,
      content_state: latest.result_metadata.content_state, content_length: latest.result_metadata.content_length,
      json_parse_success: latest.result_metadata.json_parse === 'PASS', schema_validation_success: latest.result_metadata.schema_validation === 'PASS' },
  };
  return { status: 'READY', reason: null, mismatches: [], evidence: { evidence_id: latest.evidence_id, checked_at: latest.checked_at, expires_at: latest.expires_at, source: latest.source }, readiness };
}
