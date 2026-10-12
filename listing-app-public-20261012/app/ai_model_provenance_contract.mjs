import fs from 'node:fs/promises';
import { ACCEPTANCE_MODE } from './runtime_mode.mjs';
import { resolveAiProviderConfigPath } from './ai_provider_config_path.mjs';

const CONFIG_PATH = resolveAiProviderConfigPath();
const LISTING_STEPS = new Set(Array.from({ length: 8 }, (_, index) => `LISTING_SOP_${String(index + 10).padStart(2, '0')}`));
const REQUIRED_PROVIDERS = ['Qwen', 'DeepSeek'];
const NOT_REPORTED = 'NOT_REPORTED';

async function readModelConfig() {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')); }
  catch { throw Object.assign(new Error('AI model provenance config is unreadable.'), { code: 'AI_MODEL_PROVENANCE_CONFIG_UNREADABLE' }); }
  const rows = Array.isArray(parsed.providers) ? parsed.providers : Object.entries(parsed.providers || {}).map(([name, value]) => ({ name, ...value }));
  return new Map(rows.map(row => [String(row?.name || '').toLowerCase(), {
    configured_model: String(row?.requestedModel || row?.model || '').trim(),
    requested_model: String(row?.requestedModel || row?.model || '').trim(),
    effective_request_model: String(row?.model || row?.requestedModel || '').trim(),
  }]));
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const output = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens']) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

/** Build trace metadata without inferring a model the Provider did not explicitly return. */
export async function buildAiModelProvenance({ step, providerResults = [], requestTraceId = null, executionKind = 'REAL_PROVIDER', acceptanceDegraded = null } = {}) {
  if (!LISTING_STEPS.has(step)) throw Object.assign(new Error(`Unsupported provenance step: ${step}`), { code: 'AI_MODEL_PROVENANCE_STEP_INVALID' });
  const configs = await readModelConfig();
  const results = new Map(providerResults.map(result => [String(result?.provider || '').toLowerCase(), result]));
  const requiredProviders = validDegraded(acceptanceDegraded) ? [acceptanceDegraded.active_provider] : REQUIRED_PROVIDERS;
  const providers = requiredProviders.map(provider => {
    const config = configs.get(provider.toLowerCase());
    const result = results.get(provider.toLowerCase());
    if (!config?.requested_model || !config?.effective_request_model || !result || result.status !== 'PASS') {
      throw Object.assign(new Error(`${provider} model provenance input is incomplete.`), { code: 'AI_MODEL_PROVENANCE_INPUT_INCOMPLETE', provider });
    }
    const returnedModel = typeof result.returned_model === 'string' && result.returned_model.trim()
      ? result.returned_model.trim() : NOT_REPORTED;
    const adapterVersion = typeof result.adapter_version === 'string' && result.adapter_version.trim()
      ? result.adapter_version.trim() : NOT_REPORTED;
    const record = {
      provider,
      configured_model: config.configured_model,
      requested_model: config.requested_model,
      effective_request_model: config.effective_request_model,
      returned_model: returnedModel,
      adapter_version: adapterVersion,
      request_trace_id: String(result.request_id || requestTraceId || NOT_REPORTED),
    };
    for (const key of ['api_protocol', 'structured_output', 'reasoning_effort', 'thinking_mode', 'preserve_thinking', 'max_tokens', 'max_completion_tokens']) {
      if (result[key] !== undefined && result[key] !== null) record[key] = result[key];
    }
    if (provider === 'DeepSeek') {
      if (typeof result.reasoning_effort === 'string' && result.reasoning_effort.trim()) {
        record.reasoning_effort = result.reasoning_effort.trim();
      }
      for (const key of ['api_protocol', 'structured_output', 'max_output_tokens', 'response_status', 'incomplete_reason']) {
        record[key] = result[key] ?? (key === 'incomplete_reason' ? null : NOT_REPORTED);
      }
      const usage = safeUsage(result.usage) || {};
      for (const key of ['input_tokens', 'output_tokens', 'reasoning_tokens']) {
        record[key] = Number.isFinite(Number(usage[key])) && usage[key] >= 0 ? usage[key] : NOT_REPORTED;
      }
    }
    if (config.requested_model !== config.effective_request_model) {
      record.model_mapping = {
        mapping_source: 'ai_provider_config.json',
        mapping_kind: 'CONFIGURED_EFFECTIVE_MODEL_OVERRIDE',
        requested_model: config.requested_model,
        effective_request_model: config.effective_request_model,
      };
    }
    const usage = safeUsage(result.usage);
    if (usage) record.usage = usage;
    return record;
  });
  return { schema_version: 1, sop_step_id: step, execution_kind: executionKind, providers, ...(acceptanceDegraded ? { acceptance_degraded_ai: acceptanceDegraded } : {}) };
}

export function qaAiModelProvenance(provenance, { requireReal = true, expectedStep = null, acceptanceDegraded = null } = {}) {
  const degraded = validDegraded(acceptanceDegraded) && JSON.stringify(provenance?.acceptance_degraded_ai) === JSON.stringify(acceptanceDegraded);
  const requiredProviders = degraded ? [acceptanceDegraded.active_provider] : REQUIRED_PROVIDERS;
  const failures = [];
  const checks = [];
  const rows = Array.isArray(provenance?.providers) ? provenance.providers : [];
  const byProvider = new Map(rows.map(row => [String(row?.provider || ''), row]));
  const add = (code, pass, message) => {
    const check = { code, message, pass: Boolean(pass) };
    checks.push(check);
    if (!check.pass) failures.push({ code, message });
  };
  add('AI_PROVENANCE_SCHEMA', provenance?.schema_version === 1, 'AI provenance schema version is supported.');
  add('AI_PROVENANCE_STEP', LISTING_STEPS.has(provenance?.sop_step_id) && (!expectedStep || provenance.sop_step_id === expectedStep), 'Provenance is bound to the current SOP step.');
  add('AI_PROVENANCE_REAL_EXECUTION', !requireReal || provenance?.execution_kind === 'REAL_PROVIDER', 'Formal real-AI provenance is not emitted by mock execution.');
  add('AI_PROVENANCE_PROVIDER_SET', requiredProviders.every(name => byProvider.has(name)) && rows.length === requiredProviders.length, degraded ? 'Explicit acceptance-only single-provider output retains failure evidence; not dual-provider production acceptance.' : 'Qwen and DeepSeek provenance records are present exactly once.');
  for (const name of requiredProviders) {
    const row = byProvider.get(name);
    const prefix = name.toUpperCase();
    add(`${prefix}_MODEL_FIELDS`, Boolean(row?.configured_model && row?.requested_model && row?.effective_request_model), `${name} configured/requested/effective model fields are present.`);
    add(`${prefix}_RETURNED_MODEL`, typeof row?.returned_model === 'string' && Boolean(row.returned_model.trim()), `${name} returned model is actual response metadata or NOT_REPORTED.`);
    add(`${prefix}_ADAPTER_VERSION`, typeof row?.adapter_version === 'string' && Boolean(row.adapter_version.trim()), `${name} adapter version is actual metadata or NOT_REPORTED.`);
    add(`${prefix}_TRACE_ID`, typeof row?.request_trace_id === 'string' && Boolean(row.request_trace_id.trim()), `${name} request trace ID is present.`);
    if (name === 'DeepSeek' && provenance?.execution_kind === 'REAL_PROVIDER') {
      add('DEEPSEEK_REASONING_EFFORT', row?.reasoning_effort === 'none', 'DeepSeek Responses generation records reasoning effort none.');
      add('DEEPSEEK_RESPONSES_SCHEMA', row?.api_protocol === 'RESPONSES' && row?.structured_output === 'json_schema', 'DeepSeek Listing uses Responses API JSON Schema output.');
      add('DEEPSEEK_RESPONSE_COMPLETED', row?.response_status === 'completed', 'DeepSeek Responses status is completed.');
      add('DEEPSEEK_OUTPUT_BUDGET', Number.isInteger(Number(row?.max_output_tokens)) && Number(row.max_output_tokens) >= 16384, 'DeepSeek Listing output token budget is recorded.');
      for (const key of ['input_tokens', 'output_tokens', 'reasoning_tokens']) {
        add(`DEEPSEEK_${key.toUpperCase()}`, (Number.isFinite(Number(row?.[key])) && Number(row[key]) >= 0) || row?.[key] === NOT_REPORTED, `DeepSeek ${key} usage is recorded or explicitly not reported.`);
      }
    }
    if (name === 'Qwen' && provenance?.sop_step_id === 'LISTING_SOP_10' && provenance?.execution_kind === 'REAL_PROVIDER'
      && String(row?.effective_request_model || '').toLowerCase() === 'qwen3.8-flash') {
      add('QWEN_SOP10_REASONING_EFFORT', row?.reasoning_effort === 'none', 'Qwen SOP10 records the explicit low-thinking setting.');
      add('QWEN_SOP10_THINKING_DISABLED', row?.thinking_mode === 'disabled', 'Qwen SOP10 records the effective disabled-thinking request mode.');
      add('QWEN_SOP10_PRESERVE_THINKING_DISABLED', row?.preserve_thinking === false, 'Qwen SOP10 does not include preserved reasoning history.');
      add('QWEN_SOP10_JSON_SCHEMA', row?.api_protocol === 'CHAT_COMPLETIONS' && row?.structured_output === 'json_schema', 'Qwen SOP10 uses its native strict JSON Schema mode.');
      add('QWEN_SOP10_OUTPUT_CAP', Number(row?.max_completion_tokens) === 16384 && row?.max_tokens == null, 'Qwen SOP10 completion cap is explicitly recorded using the supported field.');
    }
    if (row?.requested_model && row?.effective_request_model && row.requested_model !== row.effective_request_model) {
      add(`${prefix}_MODEL_MAPPING`, row.model_mapping?.requested_model === row.requested_model && row.model_mapping?.effective_request_model === row.effective_request_model, `${name} configured model mapping is preserved.`);
    }
  }
  return { status: failures.length ? 'QA_FAIL' : 'PASS', failures, checks };
}

export const AI_MODEL_PROVENANCE_NOT_REPORTED = NOT_REPORTED;

function validDegraded(d) { return ACCEPTANCE_MODE && d?.degraded_ai_mode===true && d.acceptance_only===true && d.sku==='SYNTHETIC-SKU-LEGACY-10' && d.runtime_instance==='ACCEPTANCE_4181' && d.dual_provider_production_pass===false && ['Qwen','DeepSeek'].includes(d.active_provider) && ['Qwen','DeepSeek'].includes(d.failed_provider) && d.active_provider!==d.failed_provider && Boolean(d.failure_evidence_ref && d.authorization_ref && d.run_id); }
