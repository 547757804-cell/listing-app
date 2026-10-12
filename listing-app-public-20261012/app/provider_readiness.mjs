import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testContext = new AsyncLocalStorage();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const officialWebReadinessFile = path.join(projectRoot, 'BOL数据', 'integrations', 'boloo-official-web-readiness.json');
const acceptanceRoot = `${path.resolve(projectRoot, 'BOL数据', '验收E2E')}${path.sep}`;

function loadApprovedBolooWebReadiness() {
  try {
    const approval = JSON.parse(fs.readFileSync(officialWebReadinessFile, 'utf8'));
    const requiredChecks = [
      'explorer_extractor_pass', 'all_required_subtasks_complete',
      'no_result_retry_once_then_confirmed', 'no_result_did_not_enter_exception_pool',
      'zero_volume_is_pass', 'request_id_and_evidence_isolation',
      'evidence_and_submission_use_same_sample_time', 'stage_qa_pass',
      'final_exe_desktop_smoke', 'single_explorer_smoke_pass',
    ];
    const evidenceRefs = Object.values(approval.evidence_refs || {});
    const evidenceIsIsolated = evidenceRefs.length >= 3 && evidenceRefs.every(reference => {
      if (typeof reference !== 'string') return false;
      const absolute = path.resolve(reference);
      return absolute.toLowerCase().startsWith(acceptanceRoot.toLowerCase()) && fs.existsSync(absolute);
    });
    const checksPassed = requiredChecks.every(key => approval.checks?.[key] === true);
    if (approval.schema_version !== 1 || approval.provider_source !== 'BOLOO_OFFICIAL_WEB'
      || approval.readiness !== 'READY' || approval.approval_status !== 'APPROVED'
      || !approval.approved_by || !approval.approved_at_utc || !checksPassed
      || approval.checks?.formal_keyword_pool_written !== false || !evidenceIsIsolated) {
      return { ready: false, validatedAt: null };
    }
    return { ready: true, validatedAt: approval.approved_at_utc };
  } catch {
    return { ready: false, validatedAt: null };
  }
}

const approvedBolooWeb = loadApprovedBolooWebReadiness();
const productionState = {
  BOL_API_READY: false,
  BOL_VALIDATED_AT: null,
  BOLOO_PROVIDER_READY: false,
  BOLOO_OFFICIAL_WEB_READY: approvedBolooWeb.ready,
  BOLOO_WEBVIEW2_VERIFIED: approvedBolooWeb.ready,
  BOLOO_WEBVIEW2_VALIDATED_AT: approvedBolooWeb.validatedAt,
};

export function isBolApiReady() {
  const override = readinessOverride('BOL_API_READY');
  return typeof override === 'boolean' ? override : productionState.BOL_API_READY;
}

export function isBolooProviderReady() {
  const override = readinessOverride('BOLOO_PROVIDER_READY');
  return typeof override === 'boolean' ? override : productionState.BOLOO_PROVIDER_READY || productionState.BOLOO_OFFICIAL_WEB_READY;
}

export function readinessOverride(key) {
  const override = testContext.getStore()?.[key];
  return typeof override === 'boolean' ? override : undefined;
}

export function markBolApiReady(validatedAt = new Date().toISOString()) {
  productionState.BOL_API_READY = true;
  productionState.BOL_VALIDATED_AT = validatedAt;
}

export function markBolooProviderReady() {
  productionState.BOLOO_PROVIDER_READY = true;
}

/** Called only by the live WebView2 validation path after confirming the official page and captured DOM evidence. */
export function markBolooWebView2Verified({ validatedAt = new Date().toISOString(), officialOriginVerified, liveWebView2Navigation, evidenceRef } = {}) {
  if (officialOriginVerified !== true || liveWebView2Navigation !== true || typeof evidenceRef !== 'string' || !evidenceRef.trim()) return false;
  productionState.BOLOO_WEBVIEW2_VERIFIED = true;
  productionState.BOLOO_WEBVIEW2_VALIDATED_AT = validatedAt;
  return true;
}

export function isBolooWebView2Verified() {
  return productionState.BOLOO_WEBVIEW2_VERIFIED;
}

export function productionReadinessSnapshot() {
  return {
    BOL_API_READY: productionState.BOL_API_READY,
    BOL_VALIDATED_AT: productionState.BOL_VALIDATED_AT,
    BOLOO_PROVIDER_READY: isBolooProviderReady(),
    BOLOO_MCP_READY: productionState.BOLOO_PROVIDER_READY,
    BOLOO_OFFICIAL_WEB_READY: productionState.BOLOO_OFFICIAL_WEB_READY,
    BOLOO_WEBVIEW2_VERIFIED: productionState.BOLOO_WEBVIEW2_VERIFIED,
    BOLOO_WEBVIEW2_VALIDATED_AT: productionState.BOLOO_WEBVIEW2_VALIDATED_AT,
  };
}

// Tests use request-local readiness overrides; production status remains unchanged.
export function withReadinessOverrides(overrides, callback) {
  return testContext.run({ ...overrides }, callback);
}
