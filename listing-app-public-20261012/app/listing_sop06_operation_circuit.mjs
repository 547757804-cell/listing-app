import crypto from 'node:crypto';

const NAVIGATION_FAILURE_CODES = new Set([
  'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT',
  'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT',
]);

function normalizedHistory(history, exactString) {
  return (Array.isArray(history) ? history : []).filter(item =>
    item && (!item.query_text || item.query_text === exactString));
}

function isSuccess(item) {
  return item?.status === 'PASS' || item?.status === 'PASS_NO_RESULT'
    || item?.result?.status === 'PASS' || item?.result?.status === 'PASS_NO_RESULT';
}

function failureCode(item) {
  const code = item?.reason_code || item?.error_code || item?.error?.code
    || item?.provider_result?.reason_code || item?.provider_result?.error?.code;
  if (NAVIGATION_FAILURE_CODES.has(code)) return code;
  const message = [item?.error_message, item?.error?.message,
    item?.provider_result?.error_message, item?.provider_result?.error?.message]
    .filter(value => typeof value === 'string').join('\n');
  if (/Timed out waiting for Boloo WebView2 NavigationCompleted/i.test(message)) return 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT';
  if (/Timed out waiting for (?:a response from the shared |the real )Boloo WebView2 Pane/i.test(message)) return 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT';
  return null;
}

export function buildSop06OperationKey({ sku, exactString, step = 'LISTING_SOP_06' } = {}) {
  if (typeof sku !== 'string' || !sku.trim() || typeof exactString !== 'string' || !exactString.trim()
    || step !== 'LISTING_SOP_06') throw new TypeError('SOP06_OPERATION_IDENTITY_INVALID');
  const digest = crypto.createHash('sha256').update(JSON.stringify([sku, step, exactString]), 'utf8').digest('hex').slice(0, 24);
  return `SOP06-OP-${digest}`;
}

/** Count navigation/bridge failures after the most recent success for one exact string. */
export function countSop06OperationFailuresAfterLastSuccess(history, exactString) {
  const entries = normalizedHistory(history, exactString);
  let lastSuccessIndex = -1;
  for (let index = 0; index < entries.length; index += 1) if (isSuccess(entries[index])) lastSuccessIndex = index;
  return entries.slice(lastSuccessIndex + 1).filter(item => failureCode(item) !== null).length;
}

export function buildSop06OperationCircuitFailure({ sku, exactString, history, failedAt, requestId,
  reasonCode, failedPane = null } = {}) {
  const operationKey = buildSop06OperationKey({ sku, exactString });
  const failureCount = countSop06OperationFailuresAfterLastSuccess(history, exactString);
  const opened = failureCount >= 2;
  return {
    schema_version: 1,
    operation_key: operationKey,
    sku,
    step: 'LISTING_SOP_06',
    exact_string: exactString,
    state: opened ? 'OPEN' : 'WAITING_RECOVERY_EVIDENCE',
    failure_count: failureCount,
    latest_failure: { failed_at: failedAt, request_id: requestId || null, reason_code: reasonCode || null },
    required_readiness_after: failedAt,
    failed_pane: failedPane ? {
      pid: failedPane.pid ?? null,
      process_started_at: failedPane.process_started_at ?? null,
      checked_at: failedPane.checked_at ?? null,
    } : null,
    recovery_evidence: null,
    updated_at: failedAt,
  };
}

/** A fresh Pane process incarnation is operation-scoped evidence for one controlled retry. */
export function buildSop06OperationRecoveryEvidence({ circuit, paneReadiness, officialWebReady } = {}) {
  if (!circuit || circuit.state !== 'WAITING_RECOVERY_EVIDENCE'
    || !Number.isFinite(Number(circuit.failure_count)) || Number(circuit.failure_count) !== 1) {
    return { allowed: false, reason: circuit?.state === 'OPEN' ? 'OPERATION_CIRCUIT_OPEN' : 'RECOVERY_NOT_REQUIRED' };
  }
  if (paneReadiness?.status !== 'READY' || officialWebReady !== true
    || paneReadiness.bridge_status !== 'READY' || paneReadiness.explorer_status !== 'READY') {
    return { allowed: false, reason: 'PANE_OR_EXPLORER_NOT_READY' };
  }
  const barrierMs = Date.parse(String(circuit.required_readiness_after || ''));
  const checkedMs = Date.parse(String(paneReadiness.checked_at || ''));
  const startedMs = Date.parse(String(paneReadiness.pane_process_started_at || ''));
  if (!Number.isFinite(barrierMs) || !Number.isFinite(checkedMs) || checkedMs <= barrierMs
    || !Number.isFinite(startedMs) || startedMs <= barrierMs) {
    return { allowed: false, reason: 'FRESH_OPERATION_RECOVERY_EVIDENCE_REQUIRED' };
  }
  if (circuit.failed_pane?.process_started_at
    && circuit.failed_pane.process_started_at === paneReadiness.pane_process_started_at) {
    return { allowed: false, reason: 'PANE_PROCESS_IDENTITY_UNCHANGED' };
  }
  const material = {
    schema_version: 1,
    evidence_type: 'SOP06_OPERATION_RECOVERY_EVIDENCE',
    operation_key: circuit.operation_key,
    sku: circuit.sku,
    step: circuit.step,
    exact_string: circuit.exact_string,
    failure_count: circuit.failure_count,
    failed_at: circuit.latest_failure?.failed_at || null,
    failed_request_id: circuit.latest_failure?.request_id || null,
    pane_pid: Number(paneReadiness.pane_pid) || null,
    pane_process_started_at: paneReadiness.pane_process_started_at,
    readiness_checked_at: paneReadiness.checked_at,
    official_web_ready: true,
    bridge_status: paneReadiness.bridge_status,
    explorer_status: paneReadiness.explorer_status,
    created_at: new Date().toISOString(),
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
  return { allowed: true, evidence: { ...material, evidence_id: `SOP06-OP-RECOVERY-${digest.slice(0, 20)}`, sha256: digest, status: 'AVAILABLE' } };
}

export function operationCircuitBlocksSop06Dispatch(circuit, exactString, sku) {
  if (!circuit) return { blocked: false, reason: null };
  if (circuit.sku !== sku || circuit.step !== 'LISTING_SOP_06' || circuit.exact_string !== exactString
    || circuit.operation_key !== buildSop06OperationKey({ sku, exactString })) {
    return { blocked: true, reason: 'OPERATION_CIRCUIT_IDENTITY_MISMATCH' };
  }
  if (circuit.state === 'OPEN') return { blocked: true, reason: 'OPERATION_CIRCUIT_OPEN' };
  if (circuit.state === 'WAITING_RECOVERY_EVIDENCE') return { blocked: true, reason: 'FRESH_OPERATION_RECOVERY_EVIDENCE_REQUIRED' };
  if (circuit.state === 'RECOVERY_AUTHORIZED'
    && circuit.recovery_evidence?.status !== 'AVAILABLE') {
    return { blocked: true, reason: 'OPERATION_RECOVERY_EVIDENCE_ALREADY_CONSUMED' };
  }
  if (circuit.state === 'RECOVERY_IN_PROGRESS') {
    return { blocked: true, reason: 'OPERATION_RECOVERY_ALREADY_DISPATCHED' };
  }
  if (circuit.state !== 'CLOSED' && circuit.state !== 'RECOVERY_AUTHORIZED') {
    return { blocked: true, reason: 'OPERATION_CIRCUIT_STATE_INVALID' };
  }
  return { blocked: false, reason: null };
}
