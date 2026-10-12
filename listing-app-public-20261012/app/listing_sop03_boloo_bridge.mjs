import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureSop03BolooProviderChild, finalizeSop03BolooProviderSources, getTask, restoreSop03AcceptanceCompetitorSlot,
  resumeSop03ProviderChildBeforeFirstAttempt,
  officialWebBolooReady, readFreshBolooPaneRuntimeReadiness, recordSop03BolooProviderChildResult,
  submitBolooProviderResult, waitSop03ForProviderReadiness,
} from './bol_core.mjs';
import { BolooWebProvider } from './boloo_web_provider.mjs';

const runs = new Map();

function serializeParent(key, work) {
  const prior = runs.get(key) || Promise.resolve();
  const next = prior.then(work, work);
  let tracked;
  tracked = next.finally(() => { if (runs.get(key) === tracked) runs.delete(key); });
  runs.set(key, tracked);
  return tracked;
}

function withinRoot(root, candidate) {
  const base = path.resolve(root), resolved = path.resolve(candidate);
  return resolved.startsWith(`${base}${path.sep}`);
}

export async function recoverPersistedExtractorAttempt(dataRoot, child, subtask) {
  const attempt = Number(subtask?.attempt_count || 0) + 1;
  const childEvidenceDir = path.join(dataRoot, 'integrations', 'sop03-boloo', 'evidence', child.sku);
  const prefix = `keyword_extractor-${String(attempt).padStart(2, '0')}-`;
  const names = (await fs.readdir(childEvidenceDir).catch(() => [])).filter(name => name.startsWith(prefix) && name.endsWith('.json'));
  if (!names.length) return null;
  if (names.length !== 1) throw Object.assign(new Error('同一 Extractor attempt 存在多个未提交 evidence 文件；禁止重发。'), { code: 'SOP03_ORPHANED_EVIDENCE_AMBIGUOUS' });
  const evidencePath = path.resolve(childEvidenceDir, names[0]);
  if (!withinRoot(dataRoot, evidencePath)) throw Object.assign(new Error('未提交 Extractor evidence 超出当前 SKU dataRoot。'), { code: 'SOP03_ORPHANED_EVIDENCE_PATH_INVALID' });
  let record;
  try { record = JSON.parse(await fs.readFile(evidencePath, 'utf8')); }
  catch { throw Object.assign(new Error('未提交 Extractor evidence 无法解析；禁止重复发送该 attempt。'), { code: 'SOP03_ORPHANED_EVIDENCE_INVALID' }); }
  const raw = record.raw_response || {};
  if (record.provider !== 'BOL_AUTO_WEBVIEW2' || record.operation !== 'keyword_extractor'
    || record.attempt !== attempt || record.query_text !== subtask.query_text
    || !record.request_id || (subtask.request_ids || []).includes(record.request_id)
    || raw.input_value !== subtask.query_text || raw.matched_query !== subtask.query_text) {
    throw Object.assign(new Error('未提交 Extractor evidence 与当前 subtask/attempt 身份不匹配；禁止重发。'), { code: 'SOP03_ORPHANED_EVIDENCE_IDENTITY_MISMATCH' });
  }
  let status, reason, result = null;
  if (raw.status === 'NO_RESULT' && raw.no_result_confirmed === true) {
    status = 'PENDING_RECHECK'; reason = 'EXTRACTOR_NO_KEYWORDS';
  } else if (raw.status === 'KEYWORDS_FOUND' && Array.isArray(raw.keywords) && raw.keywords.length) {
    status = 'PASS'; reason = 'KEYWORDS_FOUND'; result = { keywords: raw.keywords };
  } else {
    throw Object.assign(new Error('已持久化 Extractor evidence 不满足可恢复结果契约；禁止重复发送该 attempt。'), { code: 'SOP03_ORPHANED_EVIDENCE_RESULT_UNSUPPORTED' });
  }
  return {
    schema_version: 1, provider: 'BOL_AUTO_WEBVIEW2', provider_source: 'keyword_extractor',
    subtask_id: subtask.subtask_id, source_id: subtask.source_id, request_id: record.request_id,
    attempt, status, reason_code: reason, query_text: subtask.query_text,
    observed_at: record.observed_at_utc,
    evidence: {
      page_url: raw.page_url || '', matched_query: raw.matched_query,
      field_name: raw.field_name || 'Keyword Extractor results',
      displayed_value: String(raw.displayed_value ?? ''), observed_at_utc: record.observed_at_utc,
      dom_evidence_ref: { kind: 'RAW', reference: evidencePath }, dom_evidence: record.dom_evidence || null,
      ...(raw.no_result_confirmed === true ? { no_result_confirmed: true } : {}),
    },
    result, error: null,
  };
}

async function reusable(link) {
  if (!['PASS', 'PASS_NO_RESULT'].includes(link?.status) || !link.result_version || link.evidence_persisted !== true) return false;
  const refs = (link.evidence_refs || []).filter(item => item.type === 'RAW_DOM' && item.persisted === true);
  if (!refs.length) return false;
  for (const ref of refs) { try { await fs.access(ref.reference); } catch { return false; } }
  return true;
}

export async function runSop03BolooExtractors(dataRoot, sku, { bridgeDir, requestTimeoutMs = 135_000, localSourceAudit = {} } = {}) {
  return serializeParent(String(sku), async () => {
    if (String(sku) === 'SYNTHETIC-SKU-LEGACY-10') await restoreSop03AcceptanceCompetitorSlot(dataRoot, sku);
    const parent = await getTask(dataRoot, sku);
    if (!parent || parent.current_step !== 'LISTING_SOP_03') throw Object.assign(new Error('父 SKU 必须保持在 LISTING_SOP_03。'), { code: 'SOP03_PARENT_STEP_REQUIRED' });
    const bolooReady = officialWebBolooReady();
    const paneReadiness = await readFreshBolooPaneRuntimeReadiness();
    if (!bolooReady) {
      const task = await waitSop03ForProviderReadiness(dataRoot, sku, 'BOLOO_OFFICIAL_WEB', { status: 'NOT_READY' });
      return { parent_sku: sku, parent_sop_step: 'LISTING_SOP_03', parent_status: task.status, current_step: task.current_step,
        resume_point: task.resume_point, waiting_dependency_key: task.waiting_dependency_key, external_requests: 0 };
    }
    if (paneReadiness.status !== 'READY') {
      const task = await waitSop03ForProviderReadiness(dataRoot, sku, 'BOLOO_WEBVIEW2_PANE', paneReadiness);
      return { parent_sku: sku, parent_sop_step: 'LISTING_SOP_03', parent_status: task.status, current_step: task.current_step,
        resume_point: task.resume_point, waiting_dependency_key: task.waiting_dependency_key, pane_readiness: paneReadiness, external_requests: 0 };
    }
    const eligibleSources = (parent.competitor_url_list || []).filter(source => source.usable_for_boloo_extractor === true);
    if (!eligibleSources.length) throw Object.assign(new Error('当前 SKU 没有已确认且可供 Boloo Extractor 使用的原始 BOL URL。'), { code: 'SOP03_BOLOO_SOURCES_EMPTY' });
    const defaultRoot = path.join(dataRoot, 'integrations', 'sop03-boloo');
    const resolvedBridge = path.resolve(bridgeDir || path.join(defaultRoot, 'bridge'));
    if (!withinRoot(dataRoot, resolvedBridge)) throw Object.assign(new Error('Provider bridge 必须位于当前 acceptance data root 内。'), { code: 'SOP03_BOLOO_BRIDGE_PATH_INVALID' });
    const evidenceDir = path.join(defaultRoot, 'evidence');
    const provider = new BolooWebProvider({ dataRoot, bridgeDir: resolvedBridge, evidenceDir, requestTimeoutMs });

    const prepared = [];
    for (const source of eligibleSources) prepared.push(await ensureSop03BolooProviderChild(dataRoot, sku, source));

    const outcomes = [];
    for (const item of prepared) {
      const sourceLink = item.source;
      if (await reusable(sourceLink)) {
        outcomes.push({ source_id: sourceLink.source_id, source_url: sourceLink.source_url, status: sourceLink.status, result_version: sourceLink.result_version, reused: true, exact_strings: sourceLink.exact_strings || [], evidence_refs: sourceLink.evidence_refs || [] });
        continue;
      }
      const child = await getTask(dataRoot, item.child_id);
      if (!child) throw Object.assign(new Error(`Provider child ${item.child_id} missing.`), { code: 'SOP03_PROVIDER_CHILD_MISSING' });
      const current = child.boloo?.required_subtasks?.[0];
      if (['PASS', 'PASS_NO_RESULT'].includes(current?.status)) {
        const recorded = await recordSop03BolooProviderChildResult(dataRoot, sku, item.child_id);
        outcomes.push({ source_id: sourceLink.source_id, source_url: sourceLink.source_url, status: recorded.source.status, result_version: recorded.result_version, reused: true, exact_strings: recorded.source.exact_strings, evidence_refs: recorded.source.evidence_refs });
        continue;
      }
      if (['PAUSED', 'QUEUED'].includes(child.status)) {
        const resumed = await resumeSop03ProviderChildBeforeFirstAttempt(dataRoot, sku, item.child_id);
        child.status = resumed.task.status;
      }
      if (!['RUNNING', 'PENDING_RECHECK'].includes(child.status)) throw Object.assign(new Error(`Provider child ${item.child_id} is ${child.status}; explicit recovery is required.`), { code: 'SOP03_PROVIDER_CHILD_NOT_RUNNABLE' });
      const pendingBeforeRecovery = child.boloo?.required_subtasks?.[0];
      const recoveredResult = await recoverPersistedExtractorAttempt(dataRoot, child, pendingBeforeRecovery);
      if (recoveredResult) {
        await submitBolooProviderResult(dataRoot, item.child_id, recoveredResult);
        const afterRecovery = await getTask(dataRoot, item.child_id);
        const recoveredSubtask = afterRecovery?.boloo?.required_subtasks?.[0];
        if (['PASS', 'PASS_NO_RESULT'].includes(recoveredSubtask?.status)) {
          const recorded = await recordSop03BolooProviderChildResult(dataRoot, sku, item.child_id);
          outcomes.push({ source_id: sourceLink.source_id, source_url: sourceLink.source_url, status: recorded.source.status, result_version: recorded.result_version, reused: true, recovered_from_persisted_evidence: true, exact_strings: recorded.source.exact_strings, evidence_refs: recorded.source.evidence_refs });
          continue;
        }
        child.status = afterRecovery.status;
        if (!['RUNNING', 'PENDING_RECHECK'].includes(child.status)) throw Object.assign(new Error(`Recovered Provider child ${item.child_id} is ${child.status}.`), { code: 'SOP03_ORPHANED_EVIDENCE_RECOVERY_NOT_RUNNABLE' });
      }
      await provider.runCurrentSubtask(item.child_id);
      const recorded = await recordSop03BolooProviderChildResult(dataRoot, sku, item.child_id);
      outcomes.push({ source_id: sourceLink.source_id, source_url: sourceLink.source_url, status: recorded.source.status, result_version: recorded.result_version, reused: false, exact_strings: recorded.source.exact_strings, evidence_refs: recorded.source.evidence_refs });
    }
    const finalized = await finalizeSop03BolooProviderSources(dataRoot, sku, localSourceAudit);
    return {
      parent_sku: sku, parent_sop_step: 'LISTING_SOP_03', parent_status: finalized.task.status,
      current_step: finalized.task.current_step, resume_point: finalized.task.resume_point,
      waiting_dependency_key: finalized.task.waiting_dependency_key || null,
      source_status: finalized.task.listing_sop?.sop03_sources || {}, outcomes,
      boloo_complete: finalized.boloo_complete, waiting_dependency: finalized.waiting_dependency,
    };
  });
}
