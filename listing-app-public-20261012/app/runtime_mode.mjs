import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const allowedModes = new Set(['NORMAL', 'READINESS_ONLY']);
const configuredMode = String(process.env.BOL_RUNTIME_MODE || 'NORMAL').trim().toUpperCase();

if (!allowedModes.has(configuredMode)) {
  throw Object.assign(new Error(`Unsupported BOL_RUNTIME_MODE: ${configuredMode}`), { code: 'BOL_RUNTIME_MODE_INVALID' });
}

export const RUNTIME_MODE = configuredMode;
export const READINESS_ONLY = RUNTIME_MODE === 'READINESS_ONLY';
function isAcceptanceRuntime(env) {
  const marker = String(env.BOL_RUNTIME_ENVIRONMENT || '');
  const port = Number(env.BOL_ACCEPTANCE_PORT || 4181);
  return env.BOL_ACCEPTANCE_MODE === '1' && marker === 'ACCEPTANCE_4181' && port === 4181;
}
export const ACCEPTANCE_MODE = isAcceptanceRuntime(process.env);
export const RUNTIME_POLICY_VERSION = 'BOL_EFFECTIVE_RUNTIME_POLICY_V1';
const executionFlags = Object.freeze(['business_dispatch_enabled', 'dependency_resume_enabled',
  'background_provider_probe_enabled', 'task_auto_mutation_enabled']);
// The hold is deliberately acceptance-only. An inherited flag in the production
// process is ignored so the 4180 runtime retains its established behavior.
export let ACCEPTANCE_HOLD = ACCEPTANCE_MODE && process.env.BOL_ACCEPTANCE_HOLD === '1';
export let TASK_AUTO_MUTATION_ENABLED = !READINESS_ONLY && !ACCEPTANCE_HOLD;
export let BUSINESS_DISPATCH_ENABLED = TASK_AUTO_MUTATION_ENABLED;
export let DEPENDENCY_RESUME_ENABLED = TASK_AUTO_MUTATION_ENABLED;
export let BACKGROUND_PROVIDER_PROBE_ENABLED = !READINESS_ONLY && !ACCEPTANCE_HOLD;
let MANUAL_CONTINUE_REQUIRED = false;
let MANUAL_CONTINUE_SKU = null;
let policyInvalidReason = null;
const acceptanceManualDispatchContext = new AsyncLocalStorage();

function isExactAcceptanceDataRoot(dataRoot) {
  const configured = String(process.env.BOL_ACCEPTANCE_DATA_ROOT || '').trim();
  if (!configured || !dataRoot) return false;
  return path.resolve(configured).toLowerCase() === path.resolve(String(dataRoot)).toLowerCase();
}

function resolveAcceptanceCachedFinalizeSku(env = process.env) {
  if (!isAcceptanceRuntime(env) || env.BOL_ACCEPTANCE_HOLD !== '1'
      || String(env.BOL_RUNTIME_MODE || 'NORMAL').trim().toUpperCase() !== 'NORMAL') return null;
  const sku = String(env.BOL_ACCEPTANCE_CACHED_FINALIZE_SKU || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sku) ? sku : null;
}

/** Narrow HOLD-scoped permission for cached-only QA finalization of one SKU. */
export function isAcceptanceCachedFinalizeScopeAllowed({ sku, dataRoot, action = 'finalize_cached_listing_step' } = {}) {
  const policy = getEffectiveRuntimePolicy();
  const normalizedSku = String(sku || '').trim();
  return action === 'finalize_cached_listing_step'
    && policy.runtime_policy_status === 'VALID'
    && policy.runtime_mode === 'NORMAL'
    && policy.acceptance_mode === true
    && policy.acceptance_hold === true
    && policy.acceptance_cached_finalize_sku === normalizedSku
    && isExactAcceptanceDataRoot(dataRoot);
}

/**
 * Carry the server-validated, one-SKU manual Continue authorization through
 * the asynchronous executor/Router call chain without enabling global
 * dispatch flags. This scope is only entered by bol_core after its HTTP
 * action, SKU, data-root, and current task checks have passed.
 */
export function withAcceptanceManualContinueDispatchScope({ sku, dataRoot, action }, operation) {
  const policy = getEffectiveRuntimePolicy();
  const normalizedSku = String(sku || '').trim();
  const exactRoot = isExactAcceptanceDataRoot(dataRoot);
  const supportedAction = ['continue', 'sop06-pane-resume'].includes(String(action || ''));
  const allowed = typeof operation === 'function' && exactRoot && supportedAction
    && isManualContinueScopeAllowed({ runtimePolicy: policy, env: process.env,
      action, sku: normalizedSku, manualContinueSku: policy.manual_continue_sku,
      acceptanceDataRoot: true });
  if (!allowed) {
    throw Object.assign(new Error('Acceptance manual dispatch scope rejected.'), {
      code: 'ACCEPTANCE_MANUAL_DISPATCH_SCOPE_REJECTED',
    });
  }
  return acceptanceManualDispatchContext.run({ sku: normalizedSku,
    data_root: path.resolve(String(dataRoot)), action: String(action) }, operation);
}

function isActiveAcceptanceManualDispatchScope({ sku = null, dataRoot = null } = {}) {
  const scope = acceptanceManualDispatchContext.getStore();
  const policy = getEffectiveRuntimePolicy();
  return Boolean(scope
    && policy.runtime_policy_status === 'VALID'
    && policy.runtime_mode === 'NORMAL'
    && policy.acceptance_mode === true
    && policy.acceptance_hold === false
    && policy.manual_continue_required === true
    && policy.manual_continue_sku === scope.sku
    && String(sku || '').trim() === scope.sku
    && isExactAcceptanceDataRoot(dataRoot)
    && path.resolve(String(dataRoot)).toLowerCase() === scope.data_root.toLowerCase());
}

function buildPolicy(mode, acceptanceMode, hold, manual) {
  // A manual-continue latch is a control-plane state, not permission for the
  // scheduler or background workers to mutate tasks. Explicitly authorized
  // request paths can still carry out their one scoped operator action.
  const enabled = mode === 'NORMAL' && !hold && !manual;
  return {
    runtime_mode: mode, acceptance_mode: acceptanceMode, acceptance_hold: hold,
    manual_continue_required: manual,
    business_dispatch_enabled: enabled, dependency_resume_enabled: enabled,
    background_provider_probe_enabled: enabled, task_auto_mutation_enabled: enabled,
    watcher_mode: hold || manual ? 'LOCAL_AGGREGATE_ONLY' : 'NORMAL',
  };
}

/** Validate policy observations without trusting a cached health/config flag. */
export function validateRuntimePolicy(policy) {
  const errors = [];
  if (!allowedModes.has(policy?.runtime_mode)) errors.push('RUNTIME_MODE_INVALID');
  for (const key of ['acceptance_mode', 'acceptance_hold', 'manual_continue_required', ...executionFlags]) {
    if (typeof policy?.[key] !== 'boolean') errors.push('RUNTIME_POLICY_FIELD_INVALID');
  }
  if (policy?.acceptance_hold && !policy?.acceptance_mode) errors.push('HOLD_OUTSIDE_ACCEPTANCE');
  if (policy?.manual_continue_required && !policy?.acceptance_mode) errors.push('MANUAL_CONTINUE_OUTSIDE_ACCEPTANCE');
  const expected = buildPolicy(policy?.runtime_mode, policy?.acceptance_mode,
    policy?.acceptance_hold, policy?.manual_continue_required);
  if (executionFlags.some(key => policy?.[key] !== expected[key]) || policy?.watcher_mode !== expected.watcher_mode) {
    errors.push('RUNTIME_POLICY_INVARIANT_VIOLATION');
  }
  if (policy?.runtime_policy_status === 'INVALID_CONFIG') errors.push('RUNTIME_POLICY_INVALID_LATCHED');
  const uniqueErrors = [...new Set(errors)];
  return Object.freeze({ ...policy,
    ...(uniqueErrors.length ? Object.fromEntries(executionFlags.map(key => [key, false])) : {}),
    ...(uniqueErrors.length ? { watcher_mode: 'LOCAL_AGGREGATE_ONLY' } : {}),
    runtime_policy_version: RUNTIME_POLICY_VERSION,
    runtime_policy_status: uniqueErrors.length ? 'INVALID_CONFIG' : 'VALID',
    runtime_policy_errors: uniqueErrors,
  });
}

function applyExecutionFlags(policy) {
  TASK_AUTO_MUTATION_ENABLED = policy.task_auto_mutation_enabled;
  BUSINESS_DISPATCH_ENABLED = policy.business_dispatch_enabled;
  DEPENDENCY_RESUME_ENABLED = policy.dependency_resume_enabled;
  BACKGROUND_PROVIDER_PROBE_ENABLED = policy.background_provider_probe_enabled;
}

/** One decision for live guards, Server health, preflight and Supervisor. */
export function getEffectiveRuntimePolicy({ env = process.env } = {}) {
  if (env !== process.env) {
    const mode = String(env.BOL_RUNTIME_MODE || 'NORMAL').trim().toUpperCase();
    const acceptance = isAcceptanceRuntime(env);
    const policy = validateRuntimePolicy(buildPolicy(mode, acceptance,
      acceptance && env.BOL_ACCEPTANCE_HOLD === '1',
      acceptance && env.BOL_ACCEPTANCE_MANUAL_CONTINUE_REQUIRED === '1'));
    const cachedFinalizeSku = resolveAcceptanceCachedFinalizeSku(env);
    return cachedFinalizeSku ? Object.freeze({ ...policy, acceptance_cached_finalize_sku: cachedFinalizeSku }) : policy;
  }
  const policy = buildPolicy(RUNTIME_MODE, ACCEPTANCE_MODE, ACCEPTANCE_HOLD, isManualContinueRequired());
  const observed = { ...policy, business_dispatch_enabled: BUSINESS_DISPATCH_ENABLED,
    dependency_resume_enabled: DEPENDENCY_RESUME_ENABLED,
    background_provider_probe_enabled: BACKGROUND_PROVIDER_PROBE_ENABLED,
    task_auto_mutation_enabled: TASK_AUTO_MUTATION_ENABLED };
  const result = validateRuntimePolicy({ ...observed,
    ...(policyInvalidReason ? { runtime_policy_status: 'INVALID_CONFIG' } : {}) });
  if (result.runtime_policy_status === 'INVALID_CONFIG') {
    policyInvalidReason ||= result.runtime_policy_errors[0];
    applyExecutionFlags(result); // Fail closed for every existing live import too.
  }
  const withManualSku = MANUAL_CONTINUE_REQUIRED && MANUAL_CONTINUE_SKU
    ? { ...result, manual_continue_sku: MANUAL_CONTINUE_SKU } : result;
  const cachedFinalizeSku = resolveAcceptanceCachedFinalizeSku();
  return cachedFinalizeSku
    ? Object.freeze({ ...withManualSku, acceptance_cached_finalize_sku: cachedFinalizeSku })
    : (withManualSku === result ? result : Object.freeze(withManualSku));
}

/** Change the acceptance-only hold in-process without implicitly resuming work. */
export function setAcceptanceHold(enabled, { manualContinueRequired = false, manualContinueSku = null } = {}) {
  if (!ACCEPTANCE_MODE || READINESS_ONLY) throw Object.assign(new Error('Acceptance hold control is unavailable outside NORMAL ACCEPTANCE_4181.'), { code: 'ACCEPTANCE_HOLD_CONTROL_UNAVAILABLE' });
  if (policyInvalidReason) throw Object.assign(new Error('Runtime policy is invalid; restart required.'), { code: 'INVALID_CONFIG' });
  ACCEPTANCE_HOLD = Boolean(enabled);
  MANUAL_CONTINUE_REQUIRED = !ACCEPTANCE_HOLD && Boolean(manualContinueRequired);
  MANUAL_CONTINUE_SKU = MANUAL_CONTINUE_REQUIRED && typeof manualContinueSku === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(manualContinueSku)
    ? manualContinueSku : null;
  applyExecutionFlags(buildPolicy(RUNTIME_MODE, ACCEPTANCE_MODE, ACCEPTANCE_HOLD, MANUAL_CONTINUE_REQUIRED));
  return runtimeModeFields();
}
export function isManualContinueRequired() { return ACCEPTANCE_MODE && MANUAL_CONTINUE_REQUIRED; }

/** Scope guard for acceptance workbook import after HOLD is explicitly released. */
export function acceptanceWorkbookImportScopeStatus(report, selectedSkus) {
  const productScope = Array.isArray(report?.product_id_scope)
    ? new Set(report.product_id_scope.map(value => String(value).trim()).filter(Boolean)) : new Set();
  const selected = new Set(Array.isArray(selectedSkus) ? selectedSkus.map(value => String(value).trim()).filter(Boolean) : []);
  const eligible = Array.isArray(report?.rows) ? report.rows.filter(row => ['PASS', 'WAITING_CONFIRMATION'].includes(row.status)) : [];
  const hasOutOfScopeEligible = eligible.some(row => !productScope.has(String(row.product_id || '').trim()));
  const eligibleSkus = new Set(eligible.filter(row => productScope.has(String(row.product_id || '').trim()))
    .map(row => String(row.sku || '').trim()).filter(Boolean));
  const allowed = productScope.size > 0 && !hasOutOfScopeEligible && selected.size > 0
    && selected.size === eligibleSkus.size && [...selected].every(sku => eligibleSkus.has(sku));
  return Object.freeze({ allowed, reason_code: allowed ? null : 'ACCEPTANCE_IMPORT_SCOPE_MISMATCH' });
}

export function deriveRuntimePolicy(env = process.env) {
  return getEffectiveRuntimePolicy({ env });
}

/**
 * Validate the narrow per-request exception used by an operator's explicit
 * Continue action after an acceptance HOLD release. This never enables a
 * runtime-wide execution flag.
 */
export function isManualContinueScopeAllowed({ runtimePolicy = null, env = process.env,
  action = null, sku = null, manualContinueSku = null, acceptanceDataRoot = false } = {}) {
  const policy = runtimePolicy ? validateRuntimePolicy(runtimePolicy) : getEffectiveRuntimePolicy({ env });
  const targetSku = String(manualContinueSku || policy.manual_continue_sku || '').trim();
  return policy.runtime_policy_status === 'VALID'
    && policy.runtime_mode === 'NORMAL'
    && policy.acceptance_mode === true
    && policy.acceptance_hold === false
    && policy.manual_continue_required === true
    && env.BOL_ACCEPTANCE_MODE === '1'
    && env.BOL_RUNTIME_ENVIRONMENT === 'ACCEPTANCE_4181'
    && Number(env.BOL_ACCEPTANCE_PORT || 4181) === 4181
    && acceptanceDataRoot === true
    && ['continue', 'pause', 'sop06-pane-resume'].includes(String(action || ''))
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(targetSku)
    && String(sku || '').trim() === targetSku;
}

export function runtimeModeFields() {
  return getEffectiveRuntimePolicy();
}

/**
 * Read-only runtime identity/configuration for health diagnostics.
 * The acceptance stop gate is exposed only when this process is actually
 * running as the isolated 4181 acceptance instance. No other environment
 * variables are included in this response.
 */
export function runtimeConfigFields({ dataRoot = null, port = null, env = process.env } = {}) {
  const marker = String(env.BOL_RUNTIME_ENVIRONMENT || (env.BOL_ACCEPTANCE_MODE === '1' ? 'ACCEPTANCE_4181' : 'PRODUCTION_4180'));
  const actualPort = Number(port ?? (env.BOL_ACCEPTANCE_MODE === '1' ? (env.BOL_ACCEPTANCE_PORT || 4181) : 4180));
  const acceptanceMode = env.BOL_ACCEPTANCE_MODE === '1' && marker === 'ACCEPTANCE_4181' && actualPort === 4181;
  let policy = getEffectiveRuntimePolicy({ env });
  if (acceptanceMode !== policy.acceptance_mode) {
    if (env === process.env) policyInvalidReason = 'RUNTIME_IDENTITY_POLICY_MISMATCH';
    policy = validateRuntimePolicy({ ...policy, runtime_policy_status: 'INVALID_CONFIG' });
    if (env === process.env) applyExecutionFlags(policy);
  }
  const configuredStopAfter = acceptanceMode ? String(env.BOL_ACCEPTANCE_STOP_AFTER_STEP || '').trim() : '';
  return {
    pid: process.pid,
    instance: marker,
    ...policy,
    effective_runtime_policy: policy,
    acceptance_stop_after_step: configuredStopAfter || null,
    provider_credentials_loaded: env.BOL_PROVIDER_CREDENTIALS_LOADED === '1',
    provider_credentials_source: env.BOL_PROVIDER_CREDENTIALS_SOURCE === 'DPAPI_CURRENT_USER' ? 'DPAPI_CURRENT_USER' : null,
    data_root: dataRoot,
    environment_marker: marker,
  };
}

export function assertBusinessDispatchEnabled(operation = 'business operation', { sku = null, dataRoot = null } = {}) {
  if (getEffectiveRuntimePolicy().runtime_policy_status === 'INVALID_CONFIG') {
    throw Object.assign(new Error('Runtime policy is invalid; dispatch disabled.'), { code: 'INVALID_CONFIG' });
  }
  if (!TASK_AUTO_MUTATION_ENABLED) {
    if (isActiveAcceptanceManualDispatchScope({ sku, dataRoot })) return;
    const code = ACCEPTANCE_HOLD ? 'ACCEPTANCE_HOLD_ACTIVE'
      : ACCEPTANCE_MODE && MANUAL_CONTINUE_REQUIRED ? 'MANUAL_CONTINUE_SCOPE_REQUIRED'
        : 'BUSINESS_DISPATCH_DISABLED_READINESS_ONLY';
    const message = ACCEPTANCE_HOLD
      ? `${operation} is disabled by the acceptance hold gate.`
      : ACCEPTANCE_MODE && MANUAL_CONTINUE_REQUIRED
        ? `${operation} requires the exact SKU-scoped manual Continue authorization.`
        : `${operation} is disabled in READINESS_ONLY runtime mode.`;
    throw Object.assign(new Error(message), { code, runtime_mode: RUNTIME_MODE, acceptance_hold: ACCEPTANCE_HOLD });
  }
}

export function isReadinessOnlyRequestAllowed(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && ['/api/health', '/api/dashboard', '/api/integrations/bol/readiness'].includes(path)) return true;
  if (verb === 'POST' && ['/api/integrations/bol/readiness-check', '/api/integrations/ai/readiness-check', '/api/shutdown'].includes(path)) return true;
  return !path.startsWith('/api/') && verb === 'GET';
}

export const MANUAL_PROVIDER_PROBE_HEADER = 'x-bol-manual-provider-probe';
export const MANUAL_PROVIDER_PROBE_HEADER_VALUE = 'authorized';
export const MANUAL_PROVIDER_PROBE_TYPES = Object.freeze({
  BOL_READINESS: 'BOL_API_READINESS',
  PRIMARY_CONTROL_PLANE: 'AI_PRIMARY_CONTROL_PLANE_READINESS',
  QWEN_CONTROL_PLANE: 'QWEN_CONTROL_PLANE_READINESS',
  DEEPSEEK_GENERATION: 'DEEPSEEK_GENERATION_CAPABILITY',
  QWEN_GENERATION: 'QWEN_GENERATION_CAPABILITY',
  SOP10_RESPONSES_SHAPE: 'DEEPSEEK_SOP10_RESPONSES_SHAPE_CAPABILITY',
  QWEN_SOP10_RECOVERY: 'QWEN_SOP10_JSON_SCHEMA_RECOVERY',
  QWEN_LISTING_STEP_RECOVERY: 'QWEN_LISTING_STEP_JSON_SCHEMA_LOW_THINKING_RECOVERY',
  DEEPSEEK_LISTING_STEP_RECOVERY: 'DEEPSEEK_LISTING_STEP_RESPONSES_JSON_SCHEMA_RECOVERY',
});

const manualProbeTypeByEndpoint = new Map([
  ['/api/integrations/bol/readiness-check', new Set([MANUAL_PROVIDER_PROBE_TYPES.BOL_READINESS])],
  ['/api/integrations/ai/readiness-check', new Set([MANUAL_PROVIDER_PROBE_TYPES.PRIMARY_CONTROL_PLANE])],
  ['/api/integrations/ai/qwen-control-plane-probe', new Set([MANUAL_PROVIDER_PROBE_TYPES.QWEN_CONTROL_PLANE])],
  ['/api/integrations/ai/generation-capability-probe', new Set([MANUAL_PROVIDER_PROBE_TYPES.DEEPSEEK_GENERATION, MANUAL_PROVIDER_PROBE_TYPES.QWEN_GENERATION])],
  ['/api/integrations/ai/sop10-responses-shape-test', new Set([MANUAL_PROVIDER_PROBE_TYPES.SOP10_RESPONSES_SHAPE])],
  ['/api/integrations/ai/qwen-sop10-recovery-probe', new Set([MANUAL_PROVIDER_PROBE_TYPES.QWEN_SOP10_RECOVERY])],
  ['/api/integrations/ai/qwen-listing-step-recovery-probe', new Set([MANUAL_PROVIDER_PROBE_TYPES.QWEN_LISTING_STEP_RECOVERY])],
  ['/api/integrations/ai/deepseek-listing-step-recovery-probe', new Set([MANUAL_PROVIDER_PROBE_TYPES.DEEPSEEK_LISTING_STEP_RECOVERY])],
]);

/** Create a one-shot claim for one explicitly authorized, non-SKU manual probe. */
export function createManualProviderProbeClaim({ endpoint, probeType } = {}) {
  let claimed = false;
  return context => {
    if (claimed || context?.authorized !== true
      || context.context !== 'MANUAL_PROVIDER_PROBE_CONTEXT'
      || context.endpoint !== endpoint || context.probe_type !== probeType
      || context.sku_execution_lease !== false || context.listing_step_dispatch !== false
      || context.dependency_resume !== false || context.task_auto_mutation !== false) return false;
    claimed = true;
    return true;
  };
}

export function isManualProviderProbeAuthorized(headers = {}) {
  return String(headers[MANUAL_PROVIDER_PROBE_HEADER] || '').trim().toLowerCase() === MANUAL_PROVIDER_PROBE_HEADER_VALUE;
}

/** Build a non-SKU execution context for the narrowly allowlisted manual probes. */
export function createManualProviderProbeContext({ env = process.env, method, pathname, headers = {}, probeType = '', provider = '' } = {}) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  const runtime = deriveRuntimePolicy(env);
  const allowedTypes = manualProbeTypeByEndpoint.get(path);
  let reasonCode = null;
  if (runtime.runtime_policy_status === 'INVALID_CONFIG') reasonCode = 'INVALID_CONFIG';
  else if (!runtime.acceptance_mode || Number(env.BOL_ACCEPTANCE_PORT || 4181) !== 4181 || env.BOL_RUNTIME_ENVIRONMENT !== 'ACCEPTANCE_4181') reasonCode = 'MANUAL_PROBE_ACCEPTANCE_4181_REQUIRED';
  else if (runtime.runtime_mode !== 'NORMAL' || !runtime.acceptance_hold) reasonCode = 'MANUAL_PROBE_HOLD_CONTEXT_REQUIRED';
  else if (verb !== 'POST' || !allowedTypes) reasonCode = 'MANUAL_PROBE_ENDPOINT_NOT_ALLOWED';
  else if (!isManualProviderProbeAuthorized(headers)) reasonCode = 'MANUAL_PROVIDER_PROBE_AUTH_REQUIRED';
  else if (!allowedTypes.has(String(probeType || '').trim())) reasonCode = 'MANUAL_PROVIDER_PROBE_TYPE_NOT_ALLOWED';
  else if (path === '/api/integrations/ai/qwen-sop10-recovery-probe'
      && probeType !== MANUAL_PROVIDER_PROBE_TYPES.QWEN_SOP10_RECOVERY) reasonCode = 'MANUAL_PROBE_TYPE_PROVIDER_MISMATCH';
  else if (path === '/api/integrations/ai/qwen-listing-step-recovery-probe'
      && (probeType !== MANUAL_PROVIDER_PROBE_TYPES.QWEN_LISTING_STEP_RECOVERY || String(provider).toUpperCase() !== 'QWEN')) reasonCode = 'MANUAL_PROBE_TYPE_PROVIDER_MISMATCH';
  else if (path === '/api/integrations/ai/deepseek-listing-step-recovery-probe'
      && (probeType !== MANUAL_PROVIDER_PROBE_TYPES.DEEPSEEK_LISTING_STEP_RECOVERY || String(provider).toUpperCase() !== 'DEEPSEEK')) reasonCode = 'MANUAL_PROBE_TYPE_PROVIDER_MISMATCH';
  else if (path === '/api/integrations/ai/generation-capability-probe'
      && ((probeType === MANUAL_PROVIDER_PROBE_TYPES.DEEPSEEK_GENERATION && String(provider).toUpperCase() !== 'DEEPSEEK')
        || (probeType === MANUAL_PROVIDER_PROBE_TYPES.QWEN_GENERATION && String(provider).toUpperCase() !== 'QWEN'))) reasonCode = 'MANUAL_PROVIDER_PROBE_TYPE_PROVIDER_MISMATCH';

  return Object.freeze({
    authorized: reasonCode === null,
    context: reasonCode === null ? 'MANUAL_PROVIDER_PROBE_CONTEXT' : null,
    probe_type: reasonCode === null ? String(probeType).trim() : null,
    endpoint: reasonCode === null ? path : null,
    reason_code: reasonCode,
    sku_execution_lease: false,
    listing_step_dispatch: false,
    dependency_resume: false,
    task_auto_mutation: false,
  });
}

export function isRuntimeRequestAllowed(method, pathname, { manualProviderProbeContext = null, manualProviderProbeAuthorized = false, runtimePolicy = null } = {}) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  const policy = runtimePolicy ? validateRuntimePolicy(runtimePolicy) : getEffectiveRuntimePolicy();
  if (policy.runtime_policy_status === 'INVALID_CONFIG') {
    return (verb === 'GET' && ['/api/health', '/api/runtime/preflight'].includes(path))
      || (verb === 'POST' && path === '/api/shutdown');
  }
  if (policy.runtime_mode === 'READINESS_ONLY') return isReadinessOnlyRequestAllowed(verb, path);
  if (policy.manual_continue_required) {
    if (verb === 'GET') return ['/api/health', '/api/dashboard', '/api/runtime/preflight', '/api/integrations/bol/readiness', '/api/integrations/ai/readiness'].includes(path)
      || /^\/api\/tasks\/[^/]+$/.test(path);
    if (verb === 'POST' && path === '/api/shutdown') return true;
    // Refreshing BOL dependency readiness is a control-plane action only: it
    // may update readiness evidence but cannot mutate or resume a SKU task.
    if (verb === 'POST' && path === '/api/integrations/bol/readiness-check') return true;
    // Acceptance task creation is an explicit operator action after HOLD is
    // released. The source-workbook routes enforce a non-empty product scope
    // and exact SKU selection before importing any row.
    if (verb === 'POST' && ['/api/source-workbook/validate', '/api/source-workbook/import'].includes(path)) return true;
    // SOP03 source execution is a deliberate task action. The executor still
    // enforces the current SKU, step, source identity, and provider readiness.
    if (verb === 'POST' && /^\/api\/tasks\/[^/]+\/listing\/sop03\/(?:boloo-extractors|local-source-audit)$/.test(path)) return true;
    // An explicit, exact-SKU SOP06 pane resume is allowed after a HOLD release
    // installed the manual-Continue latch. The route performs task/revision,
    // lease, pane freshness, and bridge readiness checks before resuming.
    const sop06ResumeMatch = path.match(/^\/api\/tasks\/([^/]+)\/sop06-pane-resume$/);
    if (verb === 'POST' && sop06ResumeMatch) {
      let pathSku = sop06ResumeMatch[1];
      try { pathSku = decodeURIComponent(pathSku); } catch { return false; }
      const targetSku = policy.manual_continue_sku || MANUAL_CONTINUE_SKU;
      return Boolean(targetSku && pathSku === targetSku);
    }
    // The server restricts this route to the explicit `continue` action.
    // When HOLD release supplied a target SKU, all other task actions are denied.
    if (verb !== 'POST') return false;
    const actionMatch = path.match(/^\/api\/tasks\/([^/]+)\/action$/);
    if (!actionMatch) return false;
    const targetSku = policy.manual_continue_sku || MANUAL_CONTINUE_SKU;
    if (targetSku) {
      let pathSku = actionMatch[1];
      try { pathSku = decodeURIComponent(pathSku); } catch { return false; }
      if (pathSku !== targetSku) return false;
    }
    return true;
  }
  if (!policy.acceptance_hold) return true;
  if (verb === 'GET') {
    if (!path.startsWith('/api/')) return true;
    return ['/api/health', '/api/dashboard', '/api/runtime/preflight', '/api/integrations/bol/readiness', '/api/integrations/ai/readiness'].includes(path)
      || /^\/api\/tasks\/[^/]+$/.test(path);
  }
  if (verb === 'POST' && path === '/api/shutdown') return true;
  // HOLD release is an explicit acceptance control operation. The route
  // handler still validates NORMAL ACCEPTANCE_4181, current HOLD state, and
  // `hold:false`, then installs the manual-Continue latch before initialization.
  if (verb === 'POST' && path === '/api/runtime/acceptance-hold') return true;
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && policy.acceptance_cached_finalize_sku) {
    const cachedFinalizeMatch = path.match(/^\/api\/tasks\/([^/]+)\/action$/);
    if (cachedFinalizeMatch) {
      let pathSku = cachedFinalizeMatch[1];
      try { pathSku = decodeURIComponent(pathSku); } catch { return false; }
      if (pathSku === policy.acceptance_cached_finalize_sku) return true;
    }
  }
  // A single local-only SOP06 repair endpoint is allowed under HOLD. The
  // server route verifies ACCEPTANCE_4181 + NORMAL + HOLD, while the executor
  // checks the exact failed attempt, current step, revision CAS, and no lease.
  // This endpoint never enables task dispatch or provider calls.
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && /^\/api\/tasks\/[^/]+\/sop06-pane-timeout-reconciliation$/.test(path)) return true;
  // HOLD-only transactional linking of one already-successful SOP06 child
  // result to its parent row and the exact-string volume library.
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && /^\/api\/tasks\/[^/]+\/sop06-success-checkpoint-reconciliation$/.test(path)) return true;
  // Dedicated acceptance-only cached SOP07 QA revalidation. The route and core
  // require HOLD, revision CAS, exact SOP07 failure scope, no lease, persisted
  // SOP05/SOP06 inputs, and zero external requests.
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && /^\/api\/tasks\/[^/]+\/sop07-cached-qa-revalidation$/.test(path)) return true;
  // This local reconciliation action is strictly state/decision persistence.
  // Its handler scopes the SKU, revision CAS, event type, and zero-dispatch
  // invariants; it is the only task mutation admitted while acceptance HOLD is
  // active and never creates an execution lease or invokes an executor.
  if (verb === 'POST' && /^\/api\/tasks\/[^/]+\/local-state-reconciliation$/.test(path)) return true;
  // A prebuilt SOP09 input bundle may be registered while HOLD is active.
  // The handler is acceptance-only, revision-CAS guarded, and local-only; it
  // persists an input checkpoint but cannot dispatch an executor or acquire a
  // lease. Keep this exact route unavailable in READINESS_ONLY and production.
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && /^\/api\/tasks\/[^/]+\/sop09-input-bundle-registration$/.test(path)) return true;
  // Revalidate exactly one persisted SOP09 artifact after its evidence-layer
  // QA adapter is corrected. The handler requires HOLD, exact revision and
  // artifact identity, and performs no executor/provider work.
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && /^\/api\/tasks\/[^/]+\/sop09-cached-qa-revalidation$/.test(path)) return true;
  // HOLD permits only a scoped source-workbook preview; this does not create
  // or dispatch a SKU task. The handler rejects an empty product-id scope.
  if (verb === 'POST' && path === '/api/source-workbook/validate') return true;
  // Preserve the pre-existing, narrowly authorized HOLD control endpoints.
  // The task route applies its own SKU/action allowlist before touching core state.
  if (verb === 'POST' && path === '/api/runtime/acceptance-hold' && manualProviderProbeAuthorized) return true;
  if (verb === 'POST' && path === '/api/tasks/SYNTHETIC-SKU-LEGACY-10/action' && manualProviderProbeAuthorized) return true;
  // SYNTHETIC_ACCEPTANCE_05 DeepSeek SOP14 recovery preflight/binding is a HOLD-scoped local
  // control action. The task route still enforces the exact action allowlist,
  // and bol_core enforces the SYNTHETIC_ACCEPTANCE_05 identity, revision CAS, probe evidence,
  // Qwen partial, circuit, and lease gates before any state write.
  if (verb === 'POST' && policy.acceptance_mode && policy.runtime_mode === 'NORMAL'
      && path === '/api/tasks/SYNTHETIC-SKU-LEGACY-05/action') return true;
  return Boolean(manualProviderProbeContext?.authorized
    && manualProviderProbeContext.context === 'MANUAL_PROVIDER_PROBE_CONTEXT'
    && manualProviderProbeContext.endpoint === path
    && verb === 'POST'
    && manualProbeTypeByEndpoint.get(path)?.has(manualProviderProbeContext.probe_type));
}
