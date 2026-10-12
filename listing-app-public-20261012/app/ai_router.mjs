import { acceptanceCloseoutWindow, readAcceptanceCloseout, acceptanceControlledRetry, acceptanceFailureResult, claimAcceptanceCall, finishAcceptanceCall } from './listing_acceptance_closeout.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AiWorkerPool } from './ai_worker_pool.mjs';
import { ACCEPTANCE_HOLD, ACCEPTANCE_MODE, READINESS_ONLY, assertBusinessDispatchEnabled } from './runtime_mode.mjs';
import { AI_GENERATION_PROBE_MAX_TOKENS, AI_GENERATION_CAPABILITY_PROBE_CONTRACT_VERSION, AI_GENERATION_CAPABILITY_PROBE_VERSION, evaluateGenerationRecoveryRoute, generationReadinessForProvider, recordGenerationCapabilityProbe, resolveAiTimeoutConfiguration, runSyntheticCapabilityProbe } from './ai_generation_recovery.mjs';
import { buildProviderReadinessIdentity, evaluateProviderReadinessHydration } from './ai_provider_readiness_evidence.mjs';
import { providerTransportCounters } from './provider_transport_counters.mjs';
import { resolveAiProviderConfigPath } from './ai_provider_config_path.mjs';

const DEFAULTS = Object.freeze({
  schema_version: 1,
  primary_providers: ['Qwen', 'DeepSeek'],
  providers: {
    Qwen: { enabled: true, concurrency: 3 },
    DeepSeek: { enabled: true, concurrency: 3 },
    GPT: { enabled: true, automatic_fallback: true, manual_call: true, concurrency: 3, model: '' },
  },
  triggers: {
    low_confidence: { enabled: true, threshold: null },
    conflicting_results: { enabled: true },
    complex_question: { enabled: true, minimum_score: null },
    qa_failures: { enabled: true, minimum_count: null },
    random_quality_sample: { enabled: false, rate: null },
  },
  max_active_skus: 10,
  updated_at: null,
});

const adapters = new Map();
const workerPool = new AiWorkerPool();
const providerConfigPath = resolveAiProviderConfigPath();

function settingsFile(dataRoot) { return path.join(dataRoot, 'integrations', 'ai-routing-settings.json'); }

function safeTransportAttemptSummary(item = {}) {
  return Object.fromEntries([
    'attempt_index', 'started_at', 'finished_at', 'elapsed_ms', 'generation_timeout_ms', 'transport_retry',
    'outbound_transport_started', 'secure_connected', 'secure_connect_elapsed_ms', 'secure_connect_observation',
    'secure_connect_observed_elapsed_ms', 'request_body_sent', 'request_body_sent_elapsed_ms',
    'response_headers_received', 'response_headers_elapsed_ms', 'response_first_byte_elapsed_ms',
    'response_received', 'http_status', 'failure_stage', 'failure_code',
  ].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
}

function numericOrNull(value, label) {
  if (value === null || value === '' || value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw Object.assign(new Error(`${label} 必须是数字或留空。`), { code: 'AI_SETTING_INVALID' });
  return result;
}

function positiveInt(value, label, max = 32) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw Object.assign(new Error(`${label} 必须是 1–${max} 的整数。`), { code: 'AI_SETTING_INVALID' });
  return result;
}

export function normalizeAiRoutingSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const providers = source.providers || {};
  const triggers = source.triggers || {};
  const qaCount = numericOrNull(triggers.qa_failures?.minimum_count, 'QA 重试次数');
  if (qaCount !== null && (!Number.isInteger(qaCount) || qaCount < 1)) throw Object.assign(new Error('QA 重试次数必须是正整数或留空。'), { code: 'AI_SETTING_INVALID' });
  const sampleRate = numericOrNull(triggers.random_quality_sample?.rate, '随机抽样比例');
  if (sampleRate !== null && (sampleRate < 0 || sampleRate > 1)) throw Object.assign(new Error('随机抽样比例必须在 0–1 之间。'), { code: 'AI_SETTING_INVALID' });
        return {
    schema_version: 1,
    primary_providers: [...DEFAULTS.primary_providers],
    providers: {
      Qwen: { enabled: providers.Qwen?.enabled !== false, concurrency: positiveInt(providers.Qwen?.concurrency ?? DEFAULTS.providers.Qwen.concurrency, 'Qwen 并发数') },
      DeepSeek: { enabled: providers.DeepSeek?.enabled !== false, concurrency: positiveInt(providers.DeepSeek?.concurrency ?? DEFAULTS.providers.DeepSeek.concurrency, 'DeepSeek 并发数') },
      GPT: {
        enabled: providers.GPT?.enabled !== false,
        automatic_fallback: providers.GPT?.automatic_fallback !== false,
        manual_call: providers.GPT?.manual_call !== false,
        concurrency: positiveInt(providers.GPT?.concurrency ?? DEFAULTS.providers.GPT.concurrency, 'GPT 并发数'),
        model: String(providers.GPT?.model ?? '').trim(),
      },
    },
    triggers: {
      low_confidence: { enabled: triggers.low_confidence?.enabled !== false, threshold: numericOrNull(triggers.low_confidence?.threshold, '低置信度阈值') },
      conflicting_results: { enabled: triggers.conflicting_results?.enabled !== false },
      complex_question: { enabled: triggers.complex_question?.enabled !== false, minimum_score: numericOrNull(triggers.complex_question?.minimum_score, '复杂问题阈值') },
      qa_failures: { enabled: triggers.qa_failures?.enabled !== false, minimum_count: qaCount },
      random_quality_sample: { enabled: triggers.random_quality_sample?.enabled === true, rate: sampleRate },
    },
    max_active_skus: positiveInt(source.max_active_skus ?? DEFAULTS.max_active_skus, '同时激活 SKU 数', 500),
    updated_at: new Date().toISOString(),
  };
}

async function readSettings(dataRoot) {
  const file = settingsFile(dataRoot);
  try { return normalizeAiRoutingSettings(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const initial = normalizeAiRoutingSettings(DEFAULTS);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, `${JSON.stringify(initial, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
    catch (writeError) { if (writeError?.code !== 'EEXIST') throw writeError; }
    return normalizeAiRoutingSettings(JSON.parse(await fs.readFile(file, 'utf8')));
  }
}

async function readSettingsReadOnly(dataRoot) {
  const file = settingsFile(dataRoot);
  try { return normalizeAiRoutingSettings(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if (error?.code === 'ENOENT') return normalizeAiRoutingSettings(DEFAULTS);
    throw Object.assign(new Error('AI routing settings are unreadable.'), { code: 'AI_ROUTING_SETTINGS_UNREADABLE' });
  }
}

function applyLimits(settings) {
  workerPool.configure(Object.fromEntries(Object.entries(settings.providers).map(([name, config]) => [name, config.concurrency])));
}

/** Provider owners register generation adapters here; the workbench never implements Provider HTTP/auth itself. */
export function registerAiProviderAdapter(name, adapter) {
  if (!['Qwen', 'DeepSeek', 'GPT'].includes(name) || typeof adapter?.invoke !== 'function') {
    throw Object.assign(new Error('AI Provider adapter must provide an invoke function for Qwen, DeepSeek, or GPT.'), { code: 'AI_ADAPTER_CONTRACT_INVALID' });
  }
  adapters.set(name, adapter);
  return () => { if (adapters.get(name) === adapter) adapters.delete(name); };
}

async function providerStatus(name, settings) {
  const adapter = adapters.get(name);
  if (!settings.providers[name]?.enabled) return { status: name === 'GPT' ? 'OPTIONAL_NOT_CONFIGURED' : 'UNAVAILABLE', enabled: false, ready: false, reason_code: 'PROVIDER_DISABLED', active_count: workerPool.activeCount?.(name) || 0, queue_count: workerPool.queueCount?.(name) || 0 };
  if (!adapter) return { status: name === 'GPT' ? 'OPTIONAL_NOT_CONFIGURED' : 'NOT_CONFIGURED', enabled: true, ready: false, reason_code: 'PROVIDER_ADAPTER_NOT_REGISTERED', reason: 'Provider generation adapter 尚未挂接。', active_count: workerPool.activeCount?.(name) || 0, queue_count: workerPool.queueCount?.(name) || 0 };
  let readiness = { ready: true, model: null };
  try { if (typeof adapter.readiness === 'function') readiness = await adapter.readiness(); }
  catch { readiness = { ready: false, status: 'UNAVAILABLE', reason_code: 'PROVIDER_READINESS_FAILED', reason: 'Provider readiness 查询失败。' }; }
  const accepted = name === 'GPT'
    ? new Set(['READY', 'OPTIONAL_NOT_CONFIGURED', 'AUTH_FAILED', 'UNAVAILABLE'])
    : new Set(['READY', 'NOT_CONFIGURED', 'AUTH_FAILED', 'UNAVAILABLE']);
  const reported = String(readiness?.status || (readiness?.ready ? 'READY' : 'UNAVAILABLE'));
  const status = readiness?.ready === true ? 'READY' : accepted.has(reported) ? reported : (name === 'GPT' ? 'UNAVAILABLE' : 'UNAVAILABLE');
  return { status, enabled: true, ready: readiness?.ready === true, reason_code: readiness?.reason_code || null, model: readiness?.model || null, reason: readiness?.reason || null, active_count: workerPool.activeCount?.(name) || 0, queue_count: workerPool.queueCount?.(name) || 0 };
}

export async function evaluatePrimaryProviderRouteReadiness(dataRoot, settings, generationRecoveryContext = {}, cachedPrimaryResults = {}, requestIdentity = {}) {
  const providers = {};
  for (const name of settings.primary_providers) {
    const cached = cachedPrimaryResults?.[name];
    const cachedIdentity = cached?.identity || {};
    const cachedSuccess = cached?.status === 'CACHED_SUCCESS' && cached?.cache_status === 'CACHED_SUCCESS'
      && typeof cached.content === 'string' && cached.content.trim().length > 0
      && cachedIdentity.provider === name
      && cachedIdentity.sku === requestIdentity.sku
      && cachedIdentity.step === requestIdentity.module
      && /^[a-f0-9]{64}$/i.test(String(cachedIdentity.generation_key || ''))
      && cachedIdentity.generation_key === cached?.generation_key;
    if (cachedSuccess) {
      providers[name] = {
        status: 'READY', ready: true, route_readiness_source: 'CACHED_SUCCESS',
        reason_code: null, cached_generation_key: cachedIdentity.generation_key,
      };
      continue;
    }
    const recovery = generationRecoveryContext?.[name];
    if (recovery) {
      const result = await evaluateGenerationRecoveryRoute(dataRoot, recovery);
      const matchesProvider = result.allowed && result.provider === name;
      providers[name] = {
        status: matchesProvider ? 'READY' : 'UNAVAILABLE', ready: matchesProvider,
        route_readiness_source: 'GENERATION_RECOVERY', reason_code: matchesProvider ? null : result.reason,
        recovery_probe_id: matchesProvider ? result.probe_id : null,
      };
      continue;
    }
    const snapshot = await getAiProviderReadiness(dataRoot, { providers: [name] });
    const result = snapshot.providers[name.toUpperCase()] || await providerStatus(name, settings);
    providers[name] = { ...result, route_readiness_source: 'CONTROL_PLANE', readiness_evidence_source:result.readiness_source || result.readiness_evidence_status || null };
  }
  return {
    ready: settings.primary_providers.every(name => providers[name]?.ready === true),
    providers,
    provider_route_readiness: Object.fromEntries(settings.primary_providers.map(name => [name, {
      ready: providers[name]?.ready === true,
      route_readiness_source: providers[name]?.route_readiness_source,
      reason_code: providers[name]?.reason_code || null,
      recovery_probe_id: providers[name]?.recovery_probe_id || null,
    }])),
  };
}

export async function getAiRoutingSettings(dataRoot) {
  const settings = await readSettings(dataRoot);
  applyLimits(settings);
  return { settings, providers: {
    Qwen: await providerStatus('Qwen', settings),
    DeepSeek: await providerStatus('DeepSeek', settings),
    GPT: await providerStatus('GPT', settings),
  } };
}

/** Read-only local readiness view; it never creates a settings file or performs a Provider request. */
export async function getAiProviderReadiness(dataRoot, { providers: requestedProviders = null } = {}) {
  const settings = await readSettingsReadOnly(dataRoot);
  const selectedProviders = requestedProviders === null
    ? new Set(['Qwen', 'DeepSeek', 'GPT'])
    : new Set((Array.isArray(requestedProviders) ? requestedProviders : [requestedProviders])
      .map(value => String(value || '').toLowerCase())
      .map(value => value === 'qwen' ? 'Qwen' : value === 'deepseek' ? 'DeepSeek' : value === 'gpt' ? 'GPT' : null)
      .filter(Boolean));
  let configuredProviders = [];
  try {
    const parsed = JSON.parse(await fs.readFile(providerConfigPath, 'utf8'));
    configuredProviders = Array.isArray(parsed.providers) ? parsed.providers : Object.entries(parsed.providers || {}).map(([name, value]) => ({ name, ...value }));
  } catch { configuredProviders = []; }
  const localStatus = async name => {
    const config = configuredProviders.find(item => String(item?.name || '').toLowerCase() === name.toLowerCase());
    const credentialName = String(config?.credentialEnv || '').trim();
    const hasStaticConfig = Boolean(String(config?.endpoint || '').trim() && String(config?.model || config?.requestedModel || '').trim() && credentialName);
    const credentialPresent = Boolean(credentialName && process.env[credentialName]);
    const adapter = adapters.get(name);
    const adapterMetadata = typeof adapter?.executionMetadata === 'function' ? adapter.executionMetadata() : {};
    let identityFields = {};
    if (config && adapter) {
      try {
        const identity = await buildProviderReadinessIdentity({ provider: name, providerConfig: config, adapterMetadata });
        let endpoint = null;
        try { const parsed = new URL(String(config.endpoint)); endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname}`; } catch { /* Keep malformed endpoint details absent. */ }
        identityFields = {
          endpoint, endpoint_identity_hash: identity.endpoint_identity_hash,
          provider_config_hash: identity.provider_config_hash, requested_model: identity.requested_model,
          effective_model: identity.effective_model, adapter_version: identity.adapter_version,
          adapter_contract_version: identity.adapter_contract_version,
          adapter_contract_hash: identity.adapter_contract_hash, network_config_hash: identity.network_config_hash,
        };
      } catch { identityFields = { identity_status: 'UNAVAILABLE' }; }
    }
    const configured = Boolean(hasStaticConfig && credentialPresent && adapter);
    const base = { configured, credential_present: credentialPresent, required_config_name: credentialName || null, ...identityFields };
    if (name === 'GPT' && !config) return { ...base, status: 'OPTIONAL_NOT_CONFIGURED', ready: false, reason_code: 'GPT_OPTIONAL_CONFIG_ABSENT' };
    if (!settings.providers[name]?.enabled) return { ...base, status: name === 'GPT' ? 'OPTIONAL_NOT_CONFIGURED' : 'UNAVAILABLE', ready: false, reason_code: 'PROVIDER_DISABLED' };
    if (!hasStaticConfig || !credentialPresent) return {
      ...base, status: name === 'GPT' ? 'OPTIONAL_NOT_CONFIGURED' : 'NOT_CONFIGURED', ready: false,
      reason_code: !hasStaticConfig ? 'PROVIDER_CONFIG_INCOMPLETE' : 'PROVIDER_CREDENTIAL_NOT_CONFIGURED',
    };
    if (!adapter) return { ...base, status: 'UNAVAILABLE', ready: false, reason_code: 'PROVIDER_ADAPTER_NOT_REGISTERED' };
    try {
      const readiness = typeof adapter.readiness === 'function' ? await adapter.readiness() : { status: 'UNAVAILABLE', ready: false, reason_code: 'PROVIDER_READINESS_UNSUPPORTED' };
      const normalizedReadiness = { ...readiness, status: readiness?.ready === true ? 'READY' : (readiness?.status || 'UNAVAILABLE'), ready: readiness?.ready === true };
      let hydrated = { status: 'NOT_AVAILABLE', readiness: normalizedReadiness };
      try {
        hydrated = await evaluateProviderReadinessHydration({
          dataRoot, provider: name, providerConfig: config,
          adapterMetadata: typeof adapter.executionMetadata === 'function' ? adapter.executionMetadata() : {},
          runtimeEnvironment: process.env.BOL_RUNTIME_ENVIRONMENT,
          runtimeReadiness: normalizedReadiness,
        });
      } catch {
        hydrated = { status: 'STALE', reason: 'EVIDENCE_STORE_UNREADABLE', mismatches: ['evidence_store_unreadable'], readiness: normalizedReadiness };
      }
      const evidenceStatus = hydrated.status === 'READY' ? 'HYDRATED_READY' : hydrated.status;
      return { ...base, ...hydrated.readiness, configured, credential_present: credentialPresent,
        readiness_evidence_status: evidenceStatus, readiness_evidence_reason: hydrated.reason || null,
        readiness_evidence_mismatches: hydrated.mismatches || [], required_config_name: credentialName };
    } catch { return { ...base, status: 'UNAVAILABLE', ready: false, reason_code: 'PROVIDER_READINESS_FAILED' }; }
  };
  const selectedStatus = name => selectedProviders.has(name)
    ? localStatus(name)
    : Promise.resolve({ status: 'NOT_PROBED', ready: false, configured: null, credential_present: null, reason_code: 'PROVIDER_STATUS_NOT_REQUESTED' });
  const [qwenStatus, deepSeekStatus, gptStatus] = await Promise.all([selectedStatus('Qwen'), selectedStatus('DeepSeek'), selectedStatus('GPT')]);
  const statuses = { QWEN: qwenStatus, DEEPSEEK: deepSeekStatus, GPT: gptStatus };
  const [qwenGeneration, deepSeekGeneration] = await Promise.all([
    generationReadinessForProvider(dataRoot, 'Qwen', qwenStatus.effective_request_model || qwenStatus.model || null),
    generationReadinessForProvider(dataRoot, 'DeepSeek', deepSeekStatus.effective_request_model || deepSeekStatus.model || null),
  ]);
  return {
    QWEN: statuses.QWEN.status,
    DEEPSEEK: statuses.DEEPSEEK.status,
    QWEN_CONFIGURED: statuses.QWEN.configured === true,
    DEEPSEEK_CONFIGURED: statuses.DEEPSEEK.configured === true,
    GPT: statuses.GPT.status,
    mock: 'DISABLED',
    providers: {
      ...statuses,
      QWEN: { ...statuses.QWEN, control_plane_status: statuses.QWEN.status, control_plane_ready: statuses.QWEN.ready === true, generation: qwenGeneration },
      DEEPSEEK: { ...statuses.DEEPSEEK, control_plane_status: statuses.DEEPSEEK.status, control_plane_ready: statuses.DEEPSEEK.ready === true, generation: deepSeekGeneration },
    },
    CONTROL_PLANE_READY: statuses.QWEN.ready === true && statuses.DEEPSEEK.ready === true,
    readiness_layers: {
      control_plane: {
        QWEN: statuses.QWEN.status, DEEPSEEK: statuses.DEEPSEEK.status,
        status: statuses.QWEN.ready === true && statuses.DEEPSEEK.ready === true ? 'READY' : 'WAITING_DEPENDENCY',
      },
      generation: { QWEN: qwenGeneration, DEEPSEEK: deepSeekGeneration },
    },
    primary_ready: statuses.QWEN.ready && statuses.DEEPSEEK.ready,
    readiness_kind: 'CONTROL_PLANE_CONFIG_AND_LAST_PROCESS_PROBE',
    timeout_configuration: resolveAiTimeoutConfiguration(),
    external_requests: 0,
  };
}

export async function saveAiRoutingSettings(dataRoot, input) {
  const settings = normalizeAiRoutingSettings(input);
  const file = settingsFile(dataRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, file);
  applyLimits(settings);
  return getAiRoutingSettings(dataRoot);
}

function escalationReasons(context, settings) {
  const reasons = [];
  const rules = settings.triggers;
  const confidence = Number(context.confidence);
  const complexity = Number(context.complexity_score);
  const qaFailures = Number(context.qa_failure_count);
  if (rules.low_confidence.enabled && (context.low_confidence === true || (rules.low_confidence.threshold !== null && Number.isFinite(confidence) && confidence < rules.low_confidence.threshold))) reasons.push('LOW_CONFIDENCE');
  if (rules.conflicting_results.enabled && context.results_conflict === true) reasons.push('RESULT_CONFLICT');
  if (rules.complex_question.enabled && (context.complex_question === true || (rules.complex_question.minimum_score !== null && Number.isFinite(complexity) && complexity >= rules.complex_question.minimum_score))) reasons.push('COMPLEX_QUESTION');
  if (rules.qa_failures.enabled && (context.qa_retries_exhausted === true || (rules.qa_failures.minimum_count !== null && Number.isFinite(qaFailures) && qaFailures >= rules.qa_failures.minimum_count))) reasons.push('QA_RETRIES_EXHAUSTED');
  if (rules.random_quality_sample.enabled && rules.random_quality_sample.rate !== null && Math.random() < rules.random_quality_sample.rate) reasons.push('QUALITY_SAMPLE');
  return reasons;
}

async function invoke(name, input, recoveryScope = null, acceptanceScope = null, controlDataRoot = null) {
  assertBusinessDispatchEnabled('AI Provider invocation', { sku: input?.sku, dataRoot: controlDataRoot });
  const adapter = adapters.get(name);
  if (!adapter) return { provider: name, status: 'WAITING_DEPENDENCY', reason_code: 'PROVIDER_ADAPTER_NOT_READY' };
  let ready = true;
  const recoveryReady = async () => {
    if (!recoveryScope) return false;
    const route = await evaluateGenerationRecoveryRoute(recoveryScope.dataRoot, recoveryScope.context);
    return route.allowed && route.provider === name && recoveryScope.context.identity.sku === input.sku
      && recoveryScope.context.identity.step === input.module;
  };
  const controlReady = async () => controlDataRoot ? (await getAiProviderReadiness(controlDataRoot)).providers[name.toUpperCase()]?.ready === true : typeof adapter.readiness === 'function' ? (await adapter.readiness())?.ready === true : true;
  try { ready = acceptanceScope?.controlled_retry ? await acceptanceControlledRetry(acceptanceScope.dataRoot, acceptanceScope.identity) : recoveryScope ? await recoveryReady() : await controlReady(); }
  catch { ready = false; }
  if (!ready) return { provider: name, status: 'WAITING_DEPENDENCY', reason_code: 'PROVIDER_NOT_READY' };
  return workerPool.run(name, async () => {
    if (recoveryScope && !await recoveryReady()) return { provider: name, status: 'WAITING_DEPENDENCY', reason_code: 'GENERATION_RECOVERY_GATE_CLOSED' };
    if (!recoveryScope && !acceptanceScope?.controlled_retry && !await controlReady()) return {provider:name,status:'WAITING_DEPENDENCY',reason_code:'PROVIDER_READINESS_EXPIRED_IN_QUEUE'};
    if (acceptanceScope && !await claimAcceptanceCall(acceptanceScope.dataRoot, acceptanceScope.identity)) return {provider:name,status:'WAITING_DEPENDENCY',reason_code:'ACCEPTANCE_AUTHORIZATION_EXPIRED'};
    const requestId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const timeoutMs = Number(input?.timeout_ms || resolveAiTimeoutConfiguration().provider_generation_timeout_ms);
    const retryLimit = Number(input?.max_retries ?? resolveAiTimeoutConfiguration().adapter_transport_retry_limit);
    try {
      const timeoutConfiguration = resolveAiTimeoutConfiguration();
      const result = await adapter.invoke({ ...input,
        timeout_ms: input?.timeout_ms ?? timeoutConfiguration.provider_generation_timeout_ms,
        request_id: requestId });
      const finishedAt = new Date().toISOString();
      const requestedOutputBudget = input?.max_output_tokens ?? input?.max_completion_tokens ?? input?.max_tokens;
      const maxTokensRequested = Number.isInteger(Number(requestedOutputBudget)) && Number(requestedOutputBudget) > 0 ? Number(requestedOutputBudget) : null;
      const maxCompletionTokensRequested = Number.isInteger(Number(input?.max_completion_tokens)) && Number(input.max_completion_tokens) > 0 ? Number(input.max_completion_tokens) : null;
      const modelMeta = getAiProviderExecutionConfig(name);
      const attemptTelemetry = Array.isArray(result.attempt_telemetry)
        ? result.attempt_telemetry.map(item => ({ ...item, max_tokens_requested: maxTokensRequested, max_completion_tokens_requested: maxCompletionTokensRequested })) : [];
      if (!result || typeof result !== 'object' || typeof result.content !== 'string' || !result.content.trim()) {
        const telemetry = Array.isArray(result?.attempt_telemetry)
          ? result.attempt_telemetry.map(item => ({ ...item, max_tokens_requested: maxTokensRequested, max_completion_tokens_requested: maxCompletionTokensRequested })) : [];
        const empty = typeof result?.content !== 'string' || !result.content.trim();
        return { provider: name, status: 'ERROR', reason_code: empty ? 'PROVIDER_EMPTY_CONTENT' : 'PROVIDER_SCHEMA_INVALID', request_id: result?.request_id || requestId,
          attempt_telemetry: telemetry,
          requested_model: result?.requested_model || modelMeta.requested_model || null,
          effective_request_model: result?.effective_request_model || modelMeta.effective_request_model || null,
        returned_model: result?.returned_model || 'NOT_REPORTED', adapter_version: result?.adapter_version || modelMeta.adapter_version || 'NOT_REPORTED',
          ...(result?.thinking_mode ? { thinking_mode: result.thinking_mode } : {}),
          ...(result?.reasoning_effort ? { reasoning_effort: result.reasoning_effort } : {}),
          ...(typeof result?.preserve_thinking === 'boolean' ? { preserve_thinking: result.preserve_thinking } : {}),
          ...(result?.api_protocol ? { api_protocol: result.api_protocol } : {}),
          ...(result?.structured_output ? { structured_output: result.structured_output } : {}),
          ...(Number.isInteger(Number(result?.max_tokens)) ? { max_tokens: Number(result.max_tokens) } : {}),
          ...(Number.isInteger(Number(result?.max_completion_tokens)) ? { max_completion_tokens: Number(result.max_completion_tokens) } : {}),
          ...(result?.response_status ? { response_status: result.response_status } : {}),
          ...(result?.incomplete_reason ? { incomplete_reason: result.incomplete_reason } : {}),
          usage: result?.usage || null,
          attempt_metadata: { request_started_at: startedAt, request_finished_at: finishedAt, elapsed_ms: Date.parse(finishedAt) - Date.parse(startedAt), client_timeout_ms: timeoutMs, adapter_transport_retry_limit: retryLimit, adapter_transport_attempt_count: Number(result?.attempt_count) || telemetry.length || null, adapter_transport_retry_count: Number(result?.attempt_count) > 0 ? Math.max(0, Number(result.attempt_count) - 1) : null,
            http_connected: telemetry.at(-1)?.secure_connected === true || telemetry.at(-1)?.connected === true ? true : telemetry.at(-1)?.secure_connected === false ? false : 'NOT_REPORTED',
            response_received: telemetry.at(-1)?.response_headers_received === true || result?.http_status != null, http_status: result?.http_status ?? telemetry.at(-1)?.http_status ?? null, response_started: telemetry.at(-1)?.response_started || 'NOT_REPORTED', finish_reason: result?.finish_reason || telemetry.at(-1)?.finish_reason || 'NOT_REPORTED', max_tokens_requested: maxTokensRequested, max_completion_tokens_requested: maxCompletionTokensRequested,
            transport_attempts: telemetry.map(safeTransportAttemptSummary),
            raw_content_length: telemetry.at(-1)?.raw_content_length ?? null, trimmed_content_length: telemetry.at(-1)?.trimmed_content_length ?? null,
            non_whitespace_length: telemetry.at(-1)?.non_whitespace_length ?? null, whitespace_only: telemetry.at(-1)?.whitespace_only ?? false,
            requested_model: result?.requested_model || modelMeta.requested_model || null, effective_request_model: result?.effective_request_model || modelMeta.effective_request_model || null,
            returned_model: result?.returned_model || 'NOT_REPORTED', adapter_version: result?.adapter_version || modelMeta.adapter_version || 'NOT_REPORTED',
            api_protocol: result?.api_protocol || input?.api_protocol || null, structured_output: result?.structured_output || null,
            reasoning_effort: result?.reasoning_effort || input?.reasoning_effort || null,
            thinking_mode: result?.thinking_mode || (input?.reasoning_effort === 'none' ? 'disabled' : null),
            preserve_thinking: typeof result?.preserve_thinking === 'boolean' ? result.preserve_thinking : input?.preserve_thinking ?? null,
            max_tokens: result?.max_tokens || input?.max_tokens || null,
            max_completion_tokens: result?.max_completion_tokens || input?.max_completion_tokens || null,
            max_output_tokens: result?.max_output_tokens || input?.max_output_tokens || null,
            response_status: result?.response_status || telemetry.at(-1)?.response_status || null,
            incomplete_reason: result?.incomplete_reason || telemetry.at(-1)?.incomplete_reason || null,
            input_tokens: result?.usage?.input_tokens ?? telemetry.at(-1)?.input_tokens ?? null,
            output_tokens: result?.usage?.output_tokens ?? telemetry.at(-1)?.output_tokens ?? null,
            reasoning_tokens: result?.usage?.reasoning_tokens ?? telemetry.at(-1)?.reasoning_tokens ?? null } };
      }
      const transportAttempts = Number.isInteger(Number(result.attempt_count)) && Number(result.attempt_count) > 0 ? Number(result.attempt_count) : null;
      return {
        provider: name,
        status: 'PASS',
        model: result.model || null,
        version: result.version || null,
        requested_model: result.requested_model || null,
        effective_request_model: result.effective_request_model || null,
        returned_model: result.returned_model || null,
        adapter_version: result.adapter_version || null,
        ...(result.thinking_mode ? { thinking_mode: result.thinking_mode } : {}),
        ...(result.reasoning_effort ? { reasoning_effort: result.reasoning_effort } : {}),
        ...(typeof result.preserve_thinking === 'boolean' ? { preserve_thinking: result.preserve_thinking } : {}),
        ...(result.thinking_mode ? { thinking_mode: result.thinking_mode } : {}),
        ...(result.api_protocol ? { api_protocol: result.api_protocol } : {}),
        ...(result.structured_output ? { structured_output: result.structured_output } : {}),
        ...(Number.isInteger(Number(result.max_tokens)) ? { max_tokens: Number(result.max_tokens) } : {}),
        ...(Number.isInteger(Number(result.max_completion_tokens)) ? { max_completion_tokens: Number(result.max_completion_tokens) } : {}),
        ...(result.max_output_tokens ? { max_output_tokens: result.max_output_tokens } : {}),
        ...(result.response_status ? { response_status: result.response_status } : {}),
        ...(result.incomplete_reason ? { incomplete_reason: result.incomplete_reason } : {}),
        request_id: result.request_id || requestId,
        content: result.content,
        structured_response: result.structured_response || null,
        evidence: result.evidence || null,
        usage: result.usage || null,
        finish_reason: result.finish_reason || 'NOT_REPORTED',
        attempt_telemetry: attemptTelemetry,
        attempt_metadata: { request_started_at: startedAt, request_finished_at: finishedAt,
          elapsed_ms: Date.parse(finishedAt) - Date.parse(startedAt), client_timeout_ms: timeoutMs,
          adapter_transport_retry_limit: retryLimit, adapter_transport_attempt_count: transportAttempts,
          adapter_transport_retry_count: transportAttempts === null ? null : Math.max(0, transportAttempts - 1),
          raw_content_length: attemptTelemetry.at(-1)?.raw_content_length ?? null,
          trimmed_content_length: attemptTelemetry.at(-1)?.trimmed_content_length ?? null,
          non_whitespace_length: attemptTelemetry.at(-1)?.non_whitespace_length ?? null,
          whitespace_only: attemptTelemetry.at(-1)?.whitespace_only ?? false,
          http_connected: attemptTelemetry.at(-1)?.secure_connected === true || attemptTelemetry.at(-1)?.connected === true ? true : attemptTelemetry.at(-1)?.secure_connected === false ? false : 'NOT_REPORTED',
          response_received: attemptTelemetry.at(-1)?.response_headers_received === true || result.http_status != null ? true : null, http_status: result.http_status ?? null,
          transport_attempts: attemptTelemetry.map(safeTransportAttemptSummary),
          response_started: 'NOT_REPORTED', finish_reason: result.finish_reason || 'NOT_REPORTED', max_tokens_requested: maxTokensRequested, max_completion_tokens_requested: maxCompletionTokensRequested,
          max_output_tokens_requested: input?.max_output_tokens ?? null,
          max_tokens_requested: input?.max_tokens ?? null,
          response_status: result.response_status || null, incomplete_reason: result.incomplete_reason || null,
          input_tokens: result.usage?.input_tokens ?? null, output_tokens: result.usage?.output_tokens ?? null,
          reasoning_tokens: result.usage?.reasoning_tokens ?? null },
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const modelMeta = getAiProviderExecutionConfig(name);
      const telemetry = Array.isArray(error?.attempt_telemetry)
        ? error.attempt_telemetry.map(item => ({ ...item,
          max_tokens_requested: Number.isInteger(Number(input?.max_output_tokens ?? input?.max_completion_tokens ?? input?.max_tokens)) && Number(input.max_output_tokens ?? input.max_completion_tokens ?? input.max_tokens) > 0 ? Number(input.max_output_tokens ?? input.max_completion_tokens ?? input.max_tokens) : null,
          max_completion_tokens_requested: Number.isInteger(Number(input?.max_completion_tokens)) && Number(input.max_completion_tokens) > 0 ? Number(input.max_completion_tokens) : null,
        })) : [];
      const lastTelemetry = telemetry.at(-1) || {};
      return { provider: name, status: 'ERROR', reason_code: String(error?.code || 'PROVIDER_CALL_FAILED'), request_id: requestId,
        provider_request_id: error?.provider_request_id || lastTelemetry.provider_request_id || null,
        provider_error_code: error?.provider_error_code || lastTelemetry.provider_error_code || null,
        provider_error_message: error?.provider_error_message || lastTelemetry.provider_error_message || null,
        error_message: 'Provider 调用失败；未记录认证信息。', attempt_telemetry: telemetry, requested_model: modelMeta.requested_model || null,
        effective_request_model: modelMeta.effective_request_model || null, returned_model: lastTelemetry.returned_model || 'NOT_REPORTED', adapter_version: modelMeta.adapter_version || 'NOT_REPORTED',
        api_protocol: input?.api_protocol || null, structured_output: input?.api_protocol === 'RESPONSES' ? 'json_schema' : null,
        reasoning_effort: input?.reasoning_effort || null, max_output_tokens: input?.max_output_tokens || null,
        response_status: error?.response_status || lastTelemetry.response_status || null,
        incomplete_reason: error?.incomplete_reason || lastTelemetry.incomplete_reason || null,
        usage: error?.usage || null, attempt_metadata: {
          request_started_at: startedAt, request_finished_at: finishedAt, elapsed_ms: Date.parse(finishedAt) - Date.parse(startedAt),
          client_timeout_ms: timeoutMs, adapter_transport_retry_limit: retryLimit,
          adapter_transport_attempt_count: Number(error?.attempt_count) || null,
          adapter_transport_retry_count: Number(error?.attempt_count) ? Math.max(0, Number(error.attempt_count) - 1) : null,
          http_connected: lastTelemetry.secure_connected === true || lastTelemetry.connected === true ? true : lastTelemetry.secure_connected === false ? false : 'NOT_REPORTED',
          response_received: lastTelemetry.response_headers_received === true || lastTelemetry.response_received === true,
          http_status: lastTelemetry.http_status ?? null,
          transport_attempts: telemetry.map(safeTransportAttemptSummary),
          raw_content_length: lastTelemetry.raw_content_length ?? null,
          trimmed_content_length: lastTelemetry.trimmed_content_length ?? null,
          non_whitespace_length: lastTelemetry.non_whitespace_length ?? null,
          whitespace_only: lastTelemetry.whitespace_only ?? false,
          http_connected: error?.http_status != null ? true : 'NOT_REPORTED', response_received: error?.http_status != null ? true : null, http_status: error?.http_status ?? null,
          provider_request_id: error?.provider_request_id || lastTelemetry.provider_request_id || null,
          provider_error_code: error?.provider_error_code || lastTelemetry.provider_error_code || null,
          provider_error_message: error?.provider_error_message || lastTelemetry.provider_error_message || null,
          response_started: lastTelemetry.response_started || 'NOT_REPORTED', finish_reason: lastTelemetry.finish_reason || 'NOT_REPORTED',
          max_tokens_requested: Number.isInteger(Number(input?.max_output_tokens ?? input?.max_tokens)) && Number(input.max_output_tokens ?? input.max_tokens) > 0 ? Number(input.max_output_tokens ?? input.max_tokens) : null,
          max_output_tokens_requested: input?.max_output_tokens ?? null,
          response_status: lastTelemetry.response_status || null, incomplete_reason: lastTelemetry.incomplete_reason || null,
          input_tokens: lastTelemetry.input_tokens ?? null, output_tokens: lastTelemetry.output_tokens ?? null,
          reasoning_tokens: lastTelemetry.reasoning_tokens ?? null,
          requested_model: modelMeta.requested_model || null, effective_request_model: modelMeta.effective_request_model || null,
          returned_model: 'NOT_REPORTED', adapter_version: modelMeta.adapter_version || 'NOT_REPORTED',
        } };
    }
  }, { sku: input?.sku, dataRoot: controlDataRoot });
}

/** Results are suggestions only; callers must create confirmation items and run the existing Stage QA. */
export async function routeAiRequest(dataRoot, { sku, module, system = '', prompt = '', provider_prompts = {}, context = {}, manual_gpt = false, cached_primary_results = {}, on_provider_result = null, generation_recovery_context = {}, max_tokens_by_provider = {}, max_output_tokens_by_provider = {}, request_options_by_provider = {}, acceptance_identities = {} } = {}) {
  assertBusinessDispatchEnabled('AI Router dispatch', { sku, dataRoot });
  const authorizationWindow=await acceptanceCloseoutWindow(dataRoot,sku,module);
  if(!['ACTIVE','NOT_APPLICABLE'].includes(authorizationWindow.status)) return {status:'PAUSED',reason_code:`ACCEPTANCE_AUTHORIZATION_${authorizationWindow.status}`,ai_request_count:0,requires_stage_qa:true};
  if(authorizationWindow.status==='ACTIVE'&&manual_gpt) return {status:'PAUSED',reason_code:'ACCEPTANCE_GPT_FORBIDDEN',ai_request_count:0,requires_stage_qa:true};
  if (typeof prompt !== 'string' || !prompt.trim()) throw Object.assign(new Error('AI Router 需要非空 prompt。'), { code: 'AI_PROMPT_REQUIRED' });
  const settings = await readSettings(dataRoot);
  applyLimits(settings);
  const requestId = crypto.randomUUID();
  const jobContext = { sku: sku || null, module: module || null, request_id: requestId, context };
  if (manual_gpt) {
    if (!settings.providers.GPT.enabled || !settings.providers.GPT.manual_call) return { status: 'WAITING_CONFIRMATION', reason_code: 'GPT_MANUAL_CALL_DISABLED', request_id: requestId };
    const gptStatus = await providerStatus('GPT', settings);
    if (!gptStatus.ready) return { status: 'WAITING_CONFIRMATION', reason_code: 'GPT_NOT_READY', request_id: requestId, provider_status: gptStatus.status };
    const result = await invoke('GPT', { sku, module, system, prompt, context, manual: true });
    return result.status === 'PASS' ? { status: 'ENHANCED', request_id: requestId, trigger_reasons: ['MANUAL_REVIEW'], gpt_result: result, ai_request_count: result.request_id ? 1 : 0, requires_stage_qa: true } : { status: 'WAITING_CONFIRMATION', reason_code: result.reason_code || result.status, request_id: requestId, gpt_result: result, ai_request_count: result.request_id ? 1 : 0, requires_stage_qa: true };
  }

  const enabledPrimary = settings.primary_providers.filter(name => settings.providers[name].enabled);
  if (enabledPrimary.length !== settings.primary_providers.length) return { status: 'WAITING_DEPENDENCY', reason_code: 'PRIMARY_PROVIDERS_DISABLED', request_id: requestId, ai_request_count: 0, requires_stage_qa: true };
  const acceptancePolicy = await readAcceptanceCloseout(dataRoot, sku, module);
  const acceptanceRoutes = {};
  if (acceptancePolicy) for (const name of enabledPrimary) {
    const identity = acceptance_identities[name];
    if (!identity || identity.provider !== name || identity.sku !== sku || identity.step !== module) throw Object.assign(new Error('Acceptance identity missing'), {code:'ACCEPTANCE_IDENTITY_REQUIRED'});
    acceptanceRoutes[name] = { retry: await acceptanceControlledRetry(dataRoot, identity), failure: await acceptanceFailureResult(dataRoot, identity) };
  }
  const routeReadiness = await evaluatePrimaryProviderRouteReadiness(dataRoot, settings, generation_recovery_context, cached_primary_results, { sku, module });
  for (const [name, route] of Object.entries(acceptanceRoutes)) if (route.retry || route.failure) {
    routeReadiness.providers[name] = {ready:true,status:'READY',route_readiness_source:route.retry?'ACCEPTANCE_CONTROLLED_RETRY':'ACCEPTANCE_FAILURE_CHECKPOINT'};
    routeReadiness.provider_route_readiness[name] = routeReadiness.providers[name];
  }
  routeReadiness.ready = settings.primary_providers.every(name=>routeReadiness.providers[name].ready);
  const readiness = settings.primary_providers.map(name => routeReadiness.providers[name]);
  const providerRouteReadiness = routeReadiness.provider_route_readiness;
  if (!routeReadiness.ready) return {
    status: 'WAITING_DEPENDENCY', dependency:settings.primary_providers.find(name=>!routeReadiness.providers[name]?.ready)?.toUpperCase() || 'AI_PROVIDER_ADAPTER', reason_code: 'PRIMARY_PROVIDERS_NOT_READY', request_id: requestId,
    provider_status: Object.fromEntries(settings.primary_providers.map((name, index) => [name, readiness[index].status])),
    provider_route_readiness: providerRouteReadiness, ai_request_count: 0, requires_stage_qa: true,
  };
  const primaryResults = await Promise.all(enabledPrimary.map(async name => {
    const cached = cached_primary_results?.[name];
    if (cached?.status === 'CACHED_SUCCESS' && typeof cached.content === 'string') {
      const result = { ...cached, provider: name, status: 'PASS', cache_status: 'CACHED_SUCCESS', route_readiness_source: providerRouteReadiness[name].route_readiness_source };
      await on_provider_result?.(result);
      return result;
    }
    if (acceptanceRoutes[name]?.failure) return acceptanceRoutes[name].failure;
    const maxTokens = Number(max_tokens_by_provider?.[name]);
    const providerOptions = request_options_by_provider?.[name] && typeof request_options_by_provider[name] === 'object'
      ? { ...request_options_by_provider[name] } : {};
    const providerPrompt = typeof provider_prompts?.[name] === 'string' ? provider_prompts[name] : prompt;
    const maxOutputTokens = Number(max_output_tokens_by_provider?.[name]);
    const recoveryScope = generation_recovery_context?.[name] ? { dataRoot, context: generation_recovery_context[name] } : null;
    const result = await invoke(name, { ...jobContext, system, prompt: providerPrompt, context, ...providerOptions,
      ...(recoveryScope ? { max_retries: 0 } : {}),
      ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      ...(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}) }, recoveryScope, acceptancePolicy ? {dataRoot,identity:acceptance_identities[name],controlled_retry:acceptanceRoutes[name]?.retry} : null, dataRoot);
    const routed = { ...result, route_readiness_source: providerRouteReadiness[name].route_readiness_source };
    await on_provider_result?.(routed);
    if (acceptancePolicy && result.request_id) await finishAcceptanceCall(dataRoot, acceptance_identities[name], routed);
    return routed;
  }));
  const primaryRequestCount = primaryResults.filter(result => result.request_id && result.cache_status !== 'CACHED_SUCCESS').length;
  if(primaryResults.some(result=>result.reason_code==='ACCEPTANCE_AUTHORIZATION_EXPIRED')) return {status:'PAUSED',reason_code:'ACCEPTANCE_AUTHORIZATION_EXPIRED',primary_results:primaryResults,ai_request_count:primaryRequestCount,requires_stage_qa:true};
  const successful = primaryResults.filter(result => result.status === 'PASS' || result.cache_status === 'CACHED_SUCCESS');
  if (!successful.length) {
    const waiting = primaryResults.some(result => result.status === 'WAITING_DEPENDENCY' || result.status === 'ERROR');
    return { status: waiting ? 'WAITING_DEPENDENCY' : 'ERROR', dependency: primaryResults.find(item => item.status !== 'PASS')?.provider?.toUpperCase() || 'AI_PROVIDER_ADAPTER', reason_code: waiting ? 'PRIMARY_PROVIDERS_NOT_READY_OR_FAILED' : 'PRIMARY_PROVIDERS_FAILED', request_id: requestId, primary_results: primaryResults, provider_route_readiness: providerRouteReadiness, ai_request_count: primaryRequestCount, requires_stage_qa: true };
  }

  const reasons = escalationReasons(context, settings);
  if (acceptancePolicy || !reasons.length || !settings.providers.GPT.automatic_fallback) return { status: 'ROUTED', request_id: requestId, primary_results: primaryResults, provider_route_readiness: providerRouteReadiness, gpt_result: null, ai_request_count: primaryRequestCount, requires_stage_qa: true };
  if (!settings.providers.GPT.enabled) return { status: 'WAITING_CONFIRMATION', reason_code: 'GPT_DISABLED', trigger_reasons: reasons, request_id: requestId, primary_results: primaryResults, ai_request_count: primaryRequestCount, requires_stage_qa: true };
  const gptStatus = await providerStatus('GPT', settings);
  if (!gptStatus.ready) return { status: 'ROUTED', request_id: requestId, trigger_reasons: reasons, primary_results: primaryResults, gpt_result: null, ai_request_count: primaryRequestCount, optional_gpt_status: gptStatus.status, optional_gpt_reason: 'GPT_OPTIONAL_PROVIDER_NOT_READY', requires_stage_qa: true };
  const gptInput = {
    ...jobContext, system, prompt,
    context: { ...context, primary_results: successful.map(({ provider, model, content }) => ({ provider, model, content })) },
    escalation_reasons: reasons,
  };
  const gptResult = await invoke('GPT', gptInput);
  const gptRequestCount = gptResult.request_id ? 1 : 0;
  if (gptResult.status !== 'PASS') return { status: 'ROUTED', request_id: requestId, trigger_reasons: reasons, primary_results: primaryResults, gpt_result: null, ai_request_count: primaryRequestCount + gptRequestCount, optional_gpt_status: 'UNAVAILABLE', optional_gpt_reason: gptResult.reason_code || 'GPT_OPTIONAL_CALL_FAILED', requires_stage_qa: true };
  return { status: 'ENHANCED', request_id: requestId, trigger_reasons: reasons, primary_results: primaryResults, gpt_result: gptResult, ai_request_count: primaryRequestCount + gptRequestCount, requires_stage_qa: true };
}

export function aiProviderAdapterSnapshot() { return [...adapters.keys()]; }
export { resolveAiTimeoutConfiguration };
export function getAiProviderExecutionConfig(name) {
  const adapter = adapters.get(name);
  const config = typeof adapter?.executionMetadata === 'function' ? adapter.executionMetadata() : null;
  return config && typeof config === 'object' ? { ...config } : { provider: name, requested_model: null, effective_request_model: null, adapter_version: 'NOT_REPORTED' };
}

/** Evaluate provider-level Responses success independently from an optional
 * wrapper `status` field. The Responses adapter returns structured_response
 * and validated telemetry, but does not synthesize `status: PASS`. */
export function assessDeepSeekResponsesCapabilityResult({ result, attempt, requestWasAttempted = false } = {}) {
  const passed = Boolean(result
    && result.api_protocol === 'RESPONSES'
    && result.structured_output === 'json_schema'
    && result.response_status === 'completed'
    && Number(result.http_status) === 200
    && result.structured_response && typeof result.structured_response === 'object'
    && !Array.isArray(result.structured_response)
    && attempt?.response_status === 'completed'
    && Number(attempt?.http_status) === 200
    && attempt?.json_parse === 'PASS'
    && attempt?.schema_validation === 'PASS'
    && attempt?.failure_stage === 'SUCCESS'
    && !attempt?.failure_code
    && attempt?.whitespace_only !== true
    && Number(attempt?.non_whitespace_length) > 0);
  return {
    status: passed ? 'PASS' : requestWasAttempted ? 'FAIL' : 'BLOCKED',
    provider_result_status: passed ? 'SUCCESS' : 'NOT_SUCCESS',
    status_mapping_discrepancy: passed && result?.status !== 'PASS',
    reason_code: passed ? null : 'RESPONSES_PROVIDER_RESULT_CONTRACT_NOT_SATISFIED',
  };
}

/** One-shot synthetic long-input test for the DeepSeek Responses JSON Schema contract. */
export async function runDeepSeekSop10ResponsesShapeTest(dataRoot, fixture, { failureBarrierAt = null } = {}) {
  if (!ACCEPTANCE_MODE || READINESS_ONLY || !ACCEPTANCE_HOLD) return { status: 'BLOCKED', reason_code: 'ACCEPTANCE_HOLD_REQUIRED', external_requests: 0 };
  const barrierMs = Date.parse(String(failureBarrierAt || ''));
  if (!Number.isFinite(barrierMs) || Date.now() <= barrierMs) return { status: 'BLOCKED', reason_code: 'CURRENT_FAILURE_BARRIER_REQUIRED', external_requests: 0 };
  const provider = 'DeepSeek';
  const adapter = adapters.get(provider);
  const metadata = getAiProviderExecutionConfig(provider);
  if (!adapter || !String(metadata.effective_request_model || '').trim()) return { status: 'BLOCKED', reason_code: 'DEEPSEEK_ADAPTER_NOT_READY', external_requests: 0 };
  if (!fixture || fixture.sku !== 'SYNTHETIC-SKU-ONLY' || typeof fixture.prompt !== 'string'
      || fixture.input_character_count < 80000 || fixture.input_character_count > 90000
      || fixture.schema?.type !== 'object') {
    return { status: 'BLOCKED', reason_code: 'SYNTHETIC_REQUEST_SHAPE_INVALID', external_requests: 0 };
  }
  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let result = null;
  let error = null;
  let providerDispatchAttempted = false;
  try {
    // This endpoint is a narrowly authorized, one-shot capability probe under
    // ACCEPTANCE_HOLD. The normal Worker Pool correctly rejects business work
    // while held, so this probe uses the registered adapter directly; the
    // server's per-runtime single-claim gate and max_retries=0 bound it to one call.
    providerDispatchAttempted = true;
    result = await adapter.invoke({
      sku: fixture.sku, module: 'SOP10_REQUEST_SHAPE_CAPABILITY', request_id: requestId,
      system: fixture.system, prompt: fixture.prompt, api_protocol: 'RESPONSES',
      reasoning_effort: 'none', json_schema: fixture.schema, json_schema_name: 'listing_sop_10',
      max_output_tokens: 16384, timeout_ms: 30000, max_retries: 0,
    });
  } catch (caught) { error = caught; }
  const finishedAt = new Date().toISOString();
  const attemptTelemetry = result?.attempt_telemetry || error?.attempt_telemetry || [];
  const attempt = attemptTelemetry.at(-1) || {};
  const attemptCount = Number(result?.attempt_count ?? error?.attempt_count ?? attempt.attempt_index) || 0;
  const transportCounters = providerTransportCounters({
    attempts: attemptTelemetry,
    providerDispatchAttempted,
    fallbackHttpStatus: result?.http_status ?? error?.http_status ?? null,
  });
  const requestWasAttempted = transportCounters.external_requests > 0;
  const usage = result?.usage || error?.usage || {};
  const report = {
    schema_version: 1, artifact_type: 'DEEPSEEK_SOP10_RESPONSES_REQUEST_SHAPE_TEST',
    test_id: crypto.randomUUID(), provider, api_protocol: 'RESPONSES', structured_output: 'json_schema',
    requested_model: metadata.requested_model || 'NOT_REPORTED', effective_request_model: metadata.effective_request_model || 'NOT_REPORTED',
    returned_model: result?.returned_model || attempt.returned_model || 'NOT_REPORTED',
    adapter_version: result?.adapter_version || metadata.adapter_version || 'NOT_REPORTED',
    adapter_contract_version: metadata.adapter_contract_version || 'NOT_REPORTED',
    prompt_contract_version: fixture.prompt_contract_version,
    request_trace_id: result?.request_id || error?.request_id || requestId,
    prompt_hash: crypto.createHash('sha256').update(fixture.prompt).digest('hex'),
    input_character_count: fixture.input_character_count, system_character_count: fixture.system.length,
    max_output_tokens: 16384, reasoning_effort: 'none', response_format_schema_name: 'listing_sop_10',
    probe_started_at: startedAt, probe_finished_at: finishedAt,
    request_started_at: attempt.started_at || null, request_finished_at: attempt.finished_at || null,
    elapsed_ms: attempt.elapsed_ms ?? 0,
    response_status: result?.response_status || error?.response_status || attempt.response_status || (error ? 'failed' : 'NOT_REPORTED'),
    incomplete_reason: result?.incomplete_reason || error?.incomplete_reason || attempt.incomplete_reason || null,
    http_status: result?.http_status ?? error?.http_status ?? attempt.http_status ?? null,
    input_tokens: usage.input_tokens ?? attempt.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? attempt.output_tokens ?? null,
    reasoning_tokens: usage.reasoning_tokens ?? attempt.reasoning_tokens ?? null,
    raw_content_length: attempt.raw_content_length ?? null,
    trimmed_content_length: attempt.trimmed_content_length ?? null,
    non_whitespace_length: attempt.non_whitespace_length ?? null,
    whitespace_only: attempt.whitespace_only ?? false,
    json_parse: attempt.json_parse || (result?.structured_response ? 'PASS' : 'FAIL'),
    schema_validation: attempt.schema_validation || (result?.structured_response && result?.response_status === 'completed' ? 'PASS' : 'FAIL'),
    ...assessDeepSeekResponsesCapabilityResult({ result, attempt, requestWasAttempted }),
    failure_code: error?.code || attempt.failure_code || null,
    attempt_count: attemptCount,
    ...transportCounters,
    attempts: attemptTelemetry.map(item => ({
      attempt_index: item.attempt_index ?? null, started_at: item.started_at || null, finished_at: item.finished_at || null,
      elapsed_ms: item.elapsed_ms ?? null, generation_timeout_ms: item.generation_timeout_ms ?? null,
      transport_retry: item.transport_retry === true, outbound_transport_started: item.outbound_transport_started === true,
      connected: item.connected === true, response_received: item.response_received === true, http_status: item.http_status ?? null,
      returned_model: item.returned_model || null, finish_reason: item.finish_reason || null,
      response_status: item.response_status || null, incomplete_reason: item.incomplete_reason || null,
      content_state: item.content_state || 'NOT_AVAILABLE', content_length: item.content_length ?? null,
      raw_content_length: item.raw_content_length ?? null, trimmed_content_length: item.trimmed_content_length ?? null,
      non_whitespace_length: item.non_whitespace_length ?? null, whitespace_only: item.whitespace_only === true,
      json_parse: item.json_parse || 'NOT_RUN', schema_validation: item.schema_validation || 'NOT_RUN',
      failure_stage: item.failure_stage || null, failure_code: item.failure_code || null,
      max_output_tokens_requested: item.max_output_tokens_requested ?? null,
      input_tokens: item.input_tokens ?? null, output_tokens: item.output_tokens ?? null, reasoning_tokens: item.reasoning_tokens ?? null,
    })),
    prompt_logged: false, response_body_logged: false, reasoning_logged: false,
    completed_at: finishedAt,
    failure_barrier_at: failureBarrierAt, generation_failed_at: failureBarrierAt,
    barrier_satisfied: Date.parse(finishedAt) > barrierMs,
  };
  const safeId = report.test_id.replace(/[^a-f0-9-]/gi, '');
  const evidenceDir = path.join(dataRoot, 'integrations', 'deepseek-responses-shape-tests');
  await fs.mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${safeId}.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  if (requestWasAttempted) {
  const configuredProviders = JSON.parse(await fs.readFile(providerConfigPath, 'utf8')).providers || [];
  const providerConfig = configuredProviders.find(item => String(item?.name || '').toLowerCase() === 'deepseek');
  if (providerConfig) {
    const providerIdentity = await buildProviderReadinessIdentity({ provider, providerConfig, adapterMetadata: metadata });
    await recordGenerationCapabilityProbe(dataRoot, {
      probe_id: report.test_id, provider, configured_model: report.requested_model, effective_model: report.effective_request_model,
      returned_model: report.returned_model, started_at: report.request_started_at, finished_at: report.request_finished_at,
      checked_at: finishedAt, elapsed_ms: report.elapsed_ms, http_status: report.http_status,
      finish_reason: report.response_status, structured_parse: report.json_parse === 'PASS', schema_result: report.schema_validation === 'PASS',
      status: report.status, adapter_version: report.adapter_version, request_trace_id: report.request_trace_id,
      probe_version: AI_GENERATION_CAPABILITY_PROBE_VERSION, probe_contract_version: 'DEEPSEEK_RESPONSES_JSON_SCHEMA_CAPABILITY_V1',
      prompt_contract_version: fixture.prompt_contract_version,
      schema_sha256: crypto.createHash('sha256').update(JSON.stringify(fixture.schema)).digest('hex'),
      endpoint_identity_hash: providerIdentity.endpoint_identity_hash, provider_config_hash: providerIdentity.provider_config_hash,
      adapter_contract_version: providerIdentity.adapter_contract_version, adapter_contract_hash: providerIdentity.adapter_contract_hash,
      network_config_hash: providerIdentity.network_config_hash, max_output_tokens: 16384, max_output_tokens_requested: 16384,
      thinking_mode: 'disabled', generation_timeout_ms: 30000,
      attempt_count: report.attempt_count, retry_count: 0, external_requests: report.external_requests,
      provider_dispatch_attempted: report.provider_dispatch_attempted,
      outbound_transport_started: report.outbound_transport_started,
      provider_http_response_received: report.provider_http_response_received,
      reasoning_effort: 'none',
      api_protocol: 'RESPONSES', structured_output: 'json_schema', response_status: report.response_status,
      incomplete_reason: report.incomplete_reason, usage: { input_tokens: report.input_tokens, output_tokens: report.output_tokens, reasoning_tokens: report.reasoning_tokens },
      failure_barrier_at: failureBarrierAt, generation_failed_at: failureBarrierAt, barrier_satisfied: report.barrier_satisfied,
      synthetic_only: true, prompt_logged: false, response_logged: false, reasoning_logged: false,
      instrumentation_valid: true, attempt_telemetry_complete: true, external_request_count_known: true,
      attempts: report.attempts.map(item => ({ ...item, attempt_status: report.status === 'PASS' ? 'PASS' : 'FAIL', generation_attempt: item.attempt_index,
        thinking_mode: 'disabled', reasoning_effort: 'none',
        max_output_tokens: item.max_output_tokens_requested || 16384 })),
    });
  }
  }
  return { ...report, evidence_ref: path.relative(dataRoot, evidencePath).replace(/\\/g, '/'),
    capability_evidence_ref: `integrations/ai-generation-recovery/state.json#capability_probes/${report.test_id}` };
}

export async function runAiGenerationCapabilityProbe(dataRoot, providerName, { failureBarrierAt = null, timeoutMs = null, retryLimit = null } = {}) {
  const provider = providerName === 'QWEN' ? 'Qwen' : providerName === 'DEEPSEEK' ? 'DeepSeek' : providerName;
  const adapter = adapters.get(provider);
  if (!adapter) return { status: 'NOT_CONFIGURED', provider, external_requests: 0 };
  const metadata = getAiProviderExecutionConfig(provider);
  const configuredProviders = JSON.parse(await fs.readFile(providerConfigPath, 'utf8')).providers || [];
  const providerConfig = configuredProviders.find(item => String(item?.name || '').toLowerCase() === provider.toLowerCase());
  if (!providerConfig) return { status: 'FAIL', provider, reason_code: 'PROVIDER_CONFIG_NOT_FOUND', external_requests: 0 };
  const identity = await buildProviderReadinessIdentity({ provider, providerConfig, adapterMetadata: metadata });
  for (const key of ['endpoint_identity_hash', 'provider_config_hash', 'adapter_contract_hash', 'network_config_hash']) {
    if (!/^[a-f0-9]{64}$/i.test(String(identity[key] || ''))) return { status: 'FAIL', provider, reason_code: 'PROBE_IDENTITY_INCOMPLETE', external_requests: 0 };
  }
  const timeout = resolveAiTimeoutConfiguration();
  const effectiveTimeoutMs = Number.isInteger(Number(timeoutMs))
    ? Math.max(1000, Math.min(120000, Number(timeoutMs))) : timeout.provider_generation_timeout_ms;
  const effectiveRetryLimit = Number.isInteger(Number(retryLimit))
    ? Math.max(0, Math.min(1, Number(retryLimit))) : timeout.adapter_transport_retry_limit;
  return runSyntheticCapabilityProbe({
    provider, configuredModel: metadata.requested_model, effectiveModel: metadata.effective_request_model,
    timeoutMs: effectiveTimeoutMs, retryLimit: effectiveRetryLimit, failureBarrierAt, dataRoot,
    evidenceIdentity: {
      endpoint_identity_hash: identity.endpoint_identity_hash,
      provider_config_hash: identity.provider_config_hash,
      adapter_version: identity.adapter_version,
      adapter_contract_version: identity.adapter_contract_version,
      adapter_contract_hash: identity.adapter_contract_hash,
      network_config_hash: identity.network_config_hash,
    },
    invoke: async input => {
      const startedAt = new Date().toISOString();
      try {
        const result = await adapter.invoke(input);
        const finishedAt = new Date().toISOString();
        const attempts = Array.isArray(result?.attempt_telemetry) ? result.attempt_telemetry : [];
        return {
          ...result,
          status: 'PASS',
          attempt_telemetry: attempts,
          attempt_metadata: {
            request_started_at: startedAt, request_finished_at: finishedAt,
            elapsed_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
            client_timeout_ms: effectiveTimeoutMs,
            adapter_transport_retry_limit: effectiveRetryLimit,
            max_tokens_requested: AI_GENERATION_PROBE_MAX_TOKENS,
            adapter_transport_attempt_count: Number(result?.attempt_count) || attempts.length,
            adapter_transport_retry_count: Math.max(0, (Number(result?.attempt_count) || attempts.length) - 1),
            http_status: result?.http_status ?? attempts.at(-1)?.http_status ?? null,
            response_received: (result?.http_status ?? attempts.at(-1)?.http_status) != null,
          },
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const attempts = Array.isArray(error?.attempt_telemetry) ? error.attempt_telemetry : [];
        return {
          status: 'ERROR', reason_code: String(error?.code || 'PROVIDER_CALL_FAILED'),
          request_id: String(error?.request_id || input.request_id),
          attempt_telemetry: attempts,
          attempt_metadata: {
            request_started_at: startedAt, request_finished_at: finishedAt,
            elapsed_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
            client_timeout_ms: effectiveTimeoutMs,
            adapter_transport_retry_limit: effectiveRetryLimit,
            max_tokens_requested: AI_GENERATION_PROBE_MAX_TOKENS,
            adapter_transport_attempt_count: Number(error?.attempt_count) || attempts.length,
            adapter_transport_retry_count: Math.max(0, (Number(error?.attempt_count) || attempts.length) - 1),
            http_status: error?.http_status ?? attempts.at(-1)?.http_status ?? null,
            response_received: (error?.http_status ?? attempts.at(-1)?.http_status) != null,
          },
        };
      }
    },
  });
}
export const AI_ROUTING_SETTINGS_FILE = settingsFile;
