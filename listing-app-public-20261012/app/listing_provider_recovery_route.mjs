import { isProviderPartialReusable } from './ai_generation_recovery.mjs';
import { evaluateProviderReadinessHydration } from './ai_provider_readiness_evidence.mjs';

/**
 * Resolves one provider route for an already-held Listing recovery without making a
 * Provider request. A complete exact partial wins; otherwise only fresh persisted
 * control-plane evidence matching the current provider identity can authorize a
 * new call. This helper does not relax the normal task router.
 */
export async function resolveListingProviderRecoveryRouteReadiness({
  dataRoot, provider, identity, partialRecord = null, providerConfig = null,
  adapterMetadata = null, runtimeEnvironment = 'UNKNOWN', now = new Date(),
} = {}) {
  const normalizedProvider = String(provider || '').toLowerCase() === 'qwen' ? 'Qwen'
    : String(provider || '').toLowerCase() === 'deepseek' ? 'DeepSeek' : null;
  const blocked = reason => ({ ready: false, route_readiness_source: 'UNAVAILABLE',
    new_call_required: true, reason, external_requests: 0, evidence: null });
  if (!dataRoot || !normalizedProvider || identity?.provider !== normalizedProvider
      || !identity?.generation_key || !identity?.sku || !identity?.step || !identity?.effective_model) {
    return blocked('RECOVERY_PROVIDER_IDENTITY_INVALID');
  }
  if (isProviderPartialReusable(partialRecord, identity)) {
    return { ready: true, route_readiness_source: 'CACHED_SUCCESS', new_call_required: false,
      reason: null, external_requests: 0, evidence: { generation_key: identity.generation_key } };
  }
  if (!providerConfig || !adapterMetadata
      || String(adapterMetadata.effective_request_model || '') !== identity.effective_model) {
    return blocked('CONTROL_PLANE_PROVIDER_IDENTITY_MISMATCH');
  }
  let hydrated;
  try {
    hydrated = await evaluateProviderReadinessHydration({ dataRoot, provider: normalizedProvider,
      providerConfig, adapterMetadata, runtimeEnvironment, runtimeReadiness: {}, now });
  } catch {
    return blocked('CONTROL_PLANE_EVIDENCE_UNREADABLE');
  }
  const readiness = hydrated?.readiness || {};
  const ready = hydrated?.status === 'READY' && readiness.ready === true
    && String(readiness.effective_request_model || '') === identity.effective_model;
  return {
    ready,
    route_readiness_source: ready ? 'CONTROL_PLANE' : 'UNAVAILABLE',
    new_call_required: true,
    reason: ready ? null : (hydrated?.reason || readiness.reason_code || 'CONTROL_PLANE_EVIDENCE_NOT_READY'),
    external_requests: 0,
    evidence: hydrated?.evidence ? {
      evidence_id: hydrated.evidence.evidence_id || null,
      checked_at: hydrated.evidence.checked_at || null,
      expires_at: hydrated.evidence.expires_at || null,
      source: hydrated.evidence.source || null,
    } : null,
    mismatches: hydrated?.mismatches || [],
  };
}
