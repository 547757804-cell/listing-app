import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiCache } from './api_cache.mjs';
import { BolooKeywordVolumeLibrary, BOL_KEYWORD_VOLUME_IDENTITY } from './boloo_keyword_volume_library_runtime.mjs';
import {
  getTask, getActiveListingExecutionLeaseCount, officialWebBolooReady, prepareSop06BolooExplorerQueries,
  recordSop06BolooExplorerChildResult, attachSop06KeywordLibraryRecord, finalizeSop06BolooExplorer, waitSop06ForBolooPane,
  withAcceptanceSop06CheckpointReconciliationScope, consumeSop06OperationRecoveryEvidence,
} from './bol_core.mjs';
import { BolooWebProvider } from './boloo_web_provider.mjs';
import { buildSop06OperationKey, operationCircuitBlocksSop06Dispatch } from './listing_sop06_operation_circuit.mjs';
import { matchesDisplayedVolume } from './boloo_volume_format.mjs';

const EXPLORER_FIELD = 'Gemiddeld zoekvolume per maand';
const BOL_AUTO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_FILE = path.join(BOL_AUTO_ROOT, 'BOL数据', '验收E2E', 'keyword-volume-library-v1', 'library.sqlite3');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Reconcile a persisted successful child without dispatching any provider or executor. */
export async function reconcileSop06SuccessfulChildCheckpoint(dataRoot, sku, payload = {}, { libraryFile = LIBRARY_FILE } = {}) {
  if (!Number.isInteger(Number(payload.expected_revision)) || !Number.isInteger(Number(payload.expected_child_revision))
    || typeof payload.child_id !== 'string' || typeof payload.exact_string !== 'string') {
    throw Object.assign(new Error('SOP06 checkpoint reconciliation requires exact parent/child revision and identity.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_INPUT_INVALID' });
  }
  return withAcceptanceSop06CheckpointReconciliationScope(dataRoot, sku, async () => {
    let parent = await getTask(dataRoot, sku);
    if (!parent || Number(parent.revision) !== Number(payload.expected_revision)) {
      throw Object.assign(new Error('Parent task changed before SOP06 checkpoint reconciliation.'), { code: 'TASK_REVISION_CAS_MISMATCH' });
    }
    const child = await getTask(dataRoot, payload.child_id);
    const row = parent.listing_sop?.sop06_keyword_queries?.required_subtasks?.find(item => item.exact_string === payload.exact_string);
    const subtask = child?.boloo?.required_subtasks?.[0];
    const result = subtask?.result;
    if (!child || Number(child.revision) !== Number(payload.expected_child_revision)
      || child.provider_child_task?.parent_sku !== parent.sku
      || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_06'
      || child.provider_child_task?.exact_string !== payload.exact_string
      || row?.provider_child_task_id !== child.sku || row.exact_string !== payload.exact_string
      || subtask?.status !== 'PASS' || result?.status !== 'PASS'
      || result?.query_text !== payload.exact_string || result?.request_id !== payload.expected_request_id
      || !Number.isFinite(result?.result?.search_volume) || result.result.search_volume < 0
      || !matchesDisplayedVolume(result?.evidence?.displayed_value, result.result.search_volume)) {
      throw Object.assign(new Error('Persisted SOP06 child success does not match the parent exact-string checkpoint.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_RESULT_INVALID' });
    }
    if (parent.current_step !== 'LISTING_SOP_06' || parent.resume_point !== 'LISTING_SOP_06'
      || !['PAUSED', 'WAITING_DEPENDENCY'].includes(parent.status) || parent.last_success_step !== 'LISTING_SOP_05'
      || parent.qa?.LISTING_SOP_06?.status !== 'NOT_RUN' || Number(parent.open_error_count || 0) !== 0) {
      throw Object.assign(new Error('SOP06 checkpoint is not in its expected safe paused state.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_STATE_MISMATCH' });
    }
    if (parent.status === 'WAITING_DEPENDENCY' && parent.waiting_dependency_key !== 'BOLOO_WEBVIEW2_PANE') {
      throw Object.assign(new Error('Existing dependency wait is not the expected Pane checkpoint.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_STATE_MISMATCH' });
    }
    const active = getActiveListingExecutionLeaseCount(dataRoot, parent.sku, 'LISTING_SOP_06')
      + getActiveListingExecutionLeaseCount(dataRoot, child.sku, null);
    if (active !== 0) throw Object.assign(new Error('An active execution lease prevents SOP06 local reconciliation.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_ACTIVE_LEASE' });
    const evidenceRef = result?.evidence?.dom_evidence_ref?.reference || result?.evidence?.raw_dom_evidence_ref?.reference;
    if (!evidenceRef || !inside(dataRoot, evidenceRef)) throw Object.assign(new Error('SOP06 RAW evidence must resolve inside the isolated SKU data root.'), { code: 'SOP06_PROVIDER_EVIDENCE_MISSING' });
    const bytes = await fs.readFile(evidenceRef);
    const raw = JSON.parse(bytes.toString('utf8'));
    if (raw.operation !== 'keyword_explorer' || raw.query_text !== payload.exact_string
      || raw.request_id !== result.request_id || raw.raw_response?.matched_query !== payload.exact_string
      || raw.raw_response?.field_name !== EXPLORER_FIELD
      || !matchesDisplayedVolume(raw.raw_response?.displayed_value, result.result.search_volume)) {
      throw Object.assign(new Error('Persisted SOP06 RAW evidence does not match its provider result.'), { code: 'SOP06_PROVIDER_EVIDENCE_MISMATCH' });
    }

    // Replaying the same fully linked checkpoint is a no-op; library.record is
    // content-addressed and idempotent for this exact query/source version.
    const library = new BolooKeywordVolumeLibrary(libraryFile).initialize();
    try {
      const expectedSourceRecord = `${parent.listing_sop.sop06_keyword_queries.sop05_version}:${row.result_version || ''}`;
      const currentLookup = library.lookup({ exactString: payload.exact_string, now: result.observed_at, ...BOL_KEYWORD_VOLUME_IDENTITY });
      if (row.status === 'PASS' && row.qa_status === 'PASS' && row.volume === result.result.search_volume
        && row.provider_request_id === result.request_id && row.volume_library_lookup?.source_record === currentLookup.source_record
        && currentLookup.status === 'HIT_TODAY' && row.evidence_refs_result?.some(ref => ref.persisted && ref.matches_request && path.resolve(ref.reference) === path.resolve(evidenceRef))) {
        return { reconciled: true, idempotent: true, provider_requests: 0, parent, child,
          exact_string: payload.exact_string, volume: row.volume, evidence_ref: evidenceRef, library_record: currentLookup.source_record };
      }

      let mapped;
      if (parent.status === 'WAITING_DEPENDENCY') {
        if (row.status !== 'PASS' || row.qa_status !== 'PASS' || row.provider_request_id !== result.request_id
          || row.volume !== result.result.search_volume || !row.result_version
          || !row.evidence_refs_result?.some(ref => ref.persisted && ref.matches_request && path.resolve(ref.reference) === path.resolve(evidenceRef))) {
          throw Object.assign(new Error('Partially reconciled Pane wait has no complete child-to-parent result mapping.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_RESULT_INVALID' });
        }
        mapped = { parent, child, query: row };
      } else {
        if (parent.status !== 'PAUSED') throw Object.assign(new Error('Initial SOP06 checkpoint reconciliation must start from PAUSED.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_STATE_MISMATCH' });
        mapped = await recordSop06BolooExplorerChildResult(dataRoot, parent.sku, child.sku, {
          expectedParentRevision: Number(payload.expected_revision), expectedChildRevision: Number(payload.expected_child_revision),
          localSuccessReconciliation: true,
        });
        parent = mapped.parent;
      }
      const evidenceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const libraryRecord = library.record({ exactString: payload.exact_string, identity: BOL_KEYWORD_VOLUME_IDENTITY,
        queriedAt: result.observed_at, status: result.result.search_volume === 0 ? 'ZERO_VALID' : 'PASS',
        monthlyVolume: result.result.search_volume, sourceSku: parent.sku,
        sourceRecord: `${parent.listing_sop.sop06_keyword_queries.sop05_version}:${mapped.query.result_version}`,
        evidenceRef: path.resolve(evidenceRef), evidenceSha256, providerRequestId: result.request_id });
      const attached = mapped.query.volume_library_lookup?.source_record === libraryRecord.record_id
        ? { row: mapped.query }
        : await attachSop06KeywordLibraryRecord(dataRoot, parent.sku, payload.exact_string, libraryRecord,
          { expectedParentRevision: Number(parent.revision) });
      const finalTask = await getTask(dataRoot, parent.sku);
      return { reconciled: true, idempotent: false, provider_requests: 0, parent: finalTask, child: mapped.child,
        exact_string: payload.exact_string, volume: result.result.search_volume, evidence_ref: evidenceRef,
        library_record: libraryRecord.record_id, library_idempotent: libraryRecord.idempotent === true,
        parent_query_status: attached.row.status };
    } finally { library.close(); }
  });
}

function inside(root, candidate) {
  const base = path.resolve(root), full = path.resolve(candidate);
  return full.toLowerCase().startsWith(`${base}${path.sep}`.toLowerCase());
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export function classifySop06ReturnedFailure(row) {
  if (row?.status !== 'ERROR') return null;
  if (['BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT', 'NAVIGATION_FAILED', 'NETWORK_FAILED'].includes(row.reason_code)) return row.reason_code;
  if (row.reason_code !== 'UNKNOWN_PROVIDER_ERROR') return null;
  const latest = Array.isArray(row.provider_history) ? row.provider_history.at(-1) : null;
  const messages = [row.error_message, row.provider_result?.error_message, row.provider_result?.error?.message,
    row.error?.message, latest?.error_message, latest?.error?.message].filter(value => typeof value === 'string');
  return messages.some(message => /timed out waiting for Boloo WebView2 NavigationCompleted/i.test(message))
    ? 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT'
    : messages.some(message => /timed out waiting for (?:a response from the shared |the real )Boloo WebView2 Pane/i.test(message))
      ? 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT' : null;
}

function cacheRow(hit, exactString) {
  if (!hit?.formalReuse || hit.exactString !== exactString || hit.source !== 'BOLOO_OFFICIAL_VERIFIED'
    || !['BOLOO_OFFICIAL_WEB', 'BOLOO_OFFICIAL_MCP'].includes(hit.provider_method)
    || hit.stageQaStatus !== 'PASS' || hit.marketplace !== BOL_KEYWORD_VOLUME_IDENTITY.marketplace
    || hit.language !== BOL_KEYWORD_VOLUME_IDENTITY.language || hit.metric !== BOL_KEYWORD_VOLUME_IDENTITY.metric
    || !Number.isFinite(hit.structuredResult?.search_volume ?? hit.structuredResult?.monthlyVolume)) return null;
  const volume = hit.structuredResult.search_volume ?? hit.structuredResult.monthlyVolume;
  return {
    formalReuse: true, query_text: exactString, search_volume: volume, cache_record_id: hit.observationId,
    source: hit.source, provider_method: hit.provider_method, qa_status: hit.stageQaStatus,
    business_date: hit.queryDate, query_date: hit.queryDate, queried_at_utc: hit.queried_at_utc, observed_at: hit.queried_at_utc,
    marketplace: hit.marketplace, language: hit.language, metric: hit.metric,
    evidence: { page_url: hit.page_url, matched_query: exactString, displayed_value: String(volume), field_name: hit.page_field_name,
      dom_evidence_ref: hit.raw_dom_evidence_ref, source_record: hit.observationId },
    raw_dom_evidence_ref: hit.raw_dom_evidence_ref,
  };
}

/** Decide whether a persisted parent SOP06 row is reusable or must be rebuilt from its child. */
export function decideSop06QueryResumeAction(row, child, { operationRecoveryAuthorized = false } = {}) {
  const current = child?.boloo?.required_subtasks?.[0];
  const result = current?.result;
  const evidenceRef = result?.evidence?.dom_evidence_ref?.reference
    || result?.evidence?.raw_dom_evidence_ref?.reference || null;
  const parentMatchesChild = current?.status === row?.status && result?.status === row?.status
    && result?.query_text === row?.exact_string && current?.query_text === row?.exact_string
    && result?.request_id === row?.provider_request_id
    && (row?.status === 'PASS_NO_RESULT'
      || (Number.isFinite(row?.volume) && row.volume === result?.result?.search_volume))
    && row?.evidence_refs_result?.some(ref => ref.persisted === true && ref.matches_request === true
      && ref.reference === evidenceRef);
  if (['PASS', 'PASS_NO_RESULT'].includes(row?.status) && row?.qa_status === 'PASS'
    && row?.result_version && parentMatchesChild) return 'REUSE_PARENT';
  if (['PASS', 'PASS_NO_RESULT'].includes(current?.status) && result?.status === current.status) return 'SYNC_CHILD_RESULT';
  if (['RUNNING', 'PENDING_RECHECK'].includes(child?.status)) {
    const priorAttempts = Number(current?.attempt_count || 0) > 0
      || (Array.isArray(current?.request_ids) && current.request_ids.length > 0)
      || (Array.isArray(current?.history) && current.history.length > 0);
    if (priorAttempts && !result && !operationRecoveryAuthorized) return 'BLOCKED';
    return 'RUN_PROVIDER';
  }
  return 'BLOCKED';
}

async function readSop05Terms(dataRoot, sku, task) {
  const step = task.listing_sop?.steps?.LISTING_SOP_05;
  const registry = task.listing_executor?.registry?.LISTING_SOP_05;
  const version = step?.output_version;
  if (!version || step?.status !== 'PASS' || step?.qa_status !== 'PASS'
    || registry?.status !== 'PASS' || registry?.qa_status !== 'PASS' || registry?.output_version !== version) {
    throw Object.assign(new Error('当前 SKU 的正式 SOP05 版本、Stage QA 与 Executor registry 必须一致。'), { code: 'SOP06_PREFLIGHT_SOP05_FAILED' });
  }
  const file = path.join(dataRoot, 'artifacts', 'listing', sku, 'sop05', `${version}.json`);
  const artifact = JSON.parse(await fs.readFile(file, 'utf8'));
  const terms = (artifact.candidates || []).filter(item => item.status === 'ACTIVE' && item.eligibility_status === 'ELIGIBLE_FOR_SOP06').map(item => item.exact_string);
  if (artifact.version !== version || artifact.sku !== sku || artifact.qa_status !== 'PASS'
    || Number(artifact.selected_for_sop06_count) !== terms.length || !terms.length
    || new Set(terms).size !== terms.length || terms.some(term => typeof term !== 'string' || !term.trim())) {
    throw Object.assign(new Error('当前 SKU 的正式 SOP05 exact-string 集合不完整或身份不匹配。'), { code: 'SOP06_PREFLIGHT_TERMS_CHANGED' });
  }
  return { terms, version };
}

export async function inspectSop06KeywordLibrary(dataRoot, sku, { now = new Date().toISOString() } = {}) {
  const task = await getTask(dataRoot, sku);
  if (!task || task.current_step !== 'LISTING_SOP_06') return { eligible: false, all_cached: false, reason: 'SOP06_NOT_CURRENT' };
  const { terms, version } = await readSop05Terms(dataRoot, sku, task);
  const library = new BolooKeywordVolumeLibrary(LIBRARY_FILE).initialize();
  try {
    const batch = library.lookupBatch([{ sku, exactStrings: terms }], { now, ...BOL_KEYWORD_VOLUME_IDENTITY });
    const hits = batch.per_sku[0].results.filter(item => item.status === 'HIT_TODAY').length;
    return { eligible: true, all_cached: hits === terms.length, hit_count: hits, miss_count: terms.length - hits,
      exact_string_count: terms.length, sop05_version: version, query_date: batch.per_sku[0].results[0]?.query_date || null };
  } finally { library.close(); }
}

export async function runSop06BolooKeywordExplorer(dataRoot, sku, {
  bridgeDir, requestTimeoutMs = 135_000,
  runtimeReadiness = null,
} = {}) {
  const task = await getTask(dataRoot, sku);
  if (!task) throw Object.assign(new Error(`SKU ${sku} does not exist.`), { code: 'SKU_NOT_FOUND' });
  if (task.current_step !== 'LISTING_SOP_06' || task.resume_point !== 'LISTING_SOP_06'
    || task.status !== 'WAITING_DEPENDENCY' || task.waiting_dependency_key !== 'BOLOO_WEBVIEW2_PANE') {
    throw Object.assign(new Error('SOP06 exact-key dependency resume rejected; task cursor or dependency key differs.'), { code: 'SOP06_EXACT_DEPENDENCY_MISMATCH' });
  }
  const { terms, version: sop05Version } = await readSop05Terms(dataRoot, sku, task);
  const f = task.outputs?.confirmed_product_facts;
  const sop03 = task.listing_sop?.steps?.LISTING_SOP_03;
  const sop04 = task.listing_sop?.steps?.LISTING_SOP_04;
  if (!Number.isInteger(Number(f?.version)) || Number(f.version) < 1 || f?.stale === true || sop03?.status !== 'PASS' || sop03?.qa_status !== 'PASS'
    || sop04?.status !== 'PASS' || sop04?.qa_status !== 'PASS'
    || task.listing_executor?.registry?.LISTING_SOP_03?.status !== 'PASS'
    || task.listing_executor?.registry?.LISTING_SOP_04?.status !== 'PASS') {
    throw Object.assign(new Error('当前 SKU facts / SOP03 / SOP04 输入缺失、失效或未 QA PASS。'), { code: 'SOP06_PREFLIGHT_UPSTREAM_FAILED' });
  }
  const openWaiting = (task.listing_executor?.waiting_items || []).filter(item => !item.decided_at).length
    + (task.confirmation?.status === 'OPEN' ? 1 : 0);
  if (openWaiting !== 0) throw Object.assign(new Error('SOP06 is blocked by an unresolved confirmation or decision.'), { code: 'SOP06_PREFLIGHT_WAITING_ITEMS' });

  const now = new Date().toISOString();
  const library = new BolooKeywordVolumeLibrary(LIBRARY_FILE).initialize();
  try {
  const libraryBatch = library.lookupBatch([{ sku, exactStrings: terms }], { now, ...BOL_KEYWORD_VOLUME_IDENTITY });
  const libraryByTerm = new Map(libraryBatch.per_sku[0].results.map(item => [item.exact_string, item]));
  const needsProvider = terms.some(exactString => libraryByTerm.get(exactString)?.status !== 'HIT_TODAY');
  const panePid = Number(runtimeReadiness?.pane_pid || 0);
  if (needsProvider && (!runtimeReadiness || runtimeReadiness.status !== 'READY' || !processAlive(panePid)
    || runtimeReadiness.bridge_status !== 'READY' || runtimeReadiness.explorer_status !== 'READY')) {
    throw Object.assign(new Error('Keyword Library 存在 MISS，且 WebView2 Pane / Explorer / Bridge 不可用。'), { code: 'WAITING_DEPENDENCY_BOLOO_WEBVIEW2_PANE' });
  }
  if (needsProvider && !officialWebBolooReady()) throw Object.assign(new Error('Keyword Library 存在 MISS，但 BOLOO_OFFICIAL_WEB 不可用。'), { code: 'WAITING_DEPENDENCY_BOOLOO_OFFICIAL_WEB' });
  const cacheRows = terms.map(exactString => {
    const lookup = libraryByTerm.get(exactString);
    if (lookup?.status !== 'HIT_TODAY') return null;
    return cacheRow({ formalReuse: true, exactString, queryDate: lookup.query_date, queried_at_utc: lookup.queried_at_utc || now,
      source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: lookup.provider_method || 'BOLOO_OFFICIAL_WEB',
      stageQaStatus: 'PASS', observationId: lookup.source_record, marketplace: lookup.identity.marketplace,
      language: lookup.identity.language, metric: lookup.identity.metric, structuredResult: { search_volume: lookup.monthly_volume },
      raw_dom_evidence_ref: { kind: 'RAW', reference: lookup.evidence_ref }, page_url: '', page_field_name: EXPLORER_FIELD }, exactString);
  }).filter(Boolean);
  const root = path.join(dataRoot, 'integrations', 'sop03-boloo');
  const resolvedBridge = path.resolve(bridgeDir || path.join(root, 'bridge'));
  const evidenceDir = path.join(dataRoot, 'integrations', 'sop06-boloo', 'evidence');
  if (!inside(dataRoot, resolvedBridge) || !inside(dataRoot, evidenceDir)) throw new Error('SOP06 bridge/evidence path escaped the isolated acceptance data root.');

  const { manifest } = await prepareSop06BolooExplorerQueries(dataRoot, sku, { runtimeReadiness, sameDayCacheRows: cacheRows,
    volumeLibraryLookupByExact: Object.fromEntries(libraryByTerm) });
  const provider = new BolooWebProvider({ dataRoot, bridgeDir: resolvedBridge, evidenceDir, requestTimeoutMs });
  const outcomes = [];
  for (const item of manifest) {
    let parent = await getTask(dataRoot, sku);
    let row = parent.listing_sop.sop06_keyword_queries.required_subtasks.find(candidate => candidate.exact_string === item.exact_string);
    const child = await getTask(dataRoot, item.child_id);
    if (!child) throw Object.assign(new Error(`Provider child ${item.child_id} is missing.`), { code: 'SOP06_PROVIDER_CHILD_MISSING' });
    const current = child.boloo?.required_subtasks?.[0];
    const operationKey = buildSop06OperationKey({ sku, exactString: item.exact_string });
    const operationCircuit = parent.sop06_operation_circuits?.[operationKey];
    const operationRecoveryAuthorized = operationCircuit?.state === 'RECOVERY_AUTHORIZED'
      && operationCircuit.recovery_evidence?.status === 'AVAILABLE'
      && operationCircuit.recovery_evidence.operation_key === operationKey;
    const resumeAction = decideSop06QueryResumeAction(row, child, { operationRecoveryAuthorized });
    if (resumeAction === 'REUSE_PARENT') {
      const reused = { exact_string: row.exact_string, status: row.status, volume: row.volume, request_id: row.provider_request_id, result_version: row.result_version, cache_reused: row.cache_reused === true, resumed_without_rerun: true };
      outcomes.push(reused); process.stdout.write(`${JSON.stringify({ type: 'SOP06_QUERY_PROGRESS', ...reused })}\n`);
      continue;
    }
    if (resumeAction === 'SYNC_CHILD_RESULT') {
      await recordSop06BolooExplorerChildResult(dataRoot, sku, item.child_id);
    } else {
      if (resumeAction !== 'RUN_PROVIDER') throw Object.assign(new Error(`Provider child ${item.child_id} is ${child.status}; safe automatic run is blocked.`), { code: 'SOP06_PROVIDER_CHILD_NOT_RUNNABLE' });
      const currentParent = await getTask(dataRoot, sku);
      const operationCircuit = currentParent.sop06_operation_circuits?.[operationKey];
      const operationGate = operationCircuitBlocksSop06Dispatch(operationCircuit, item.exact_string, sku);
      if (operationGate.blocked) throw Object.assign(new Error('SOP06 operation circuit blocks this exact-string query.'), {
        code: 'SOP06_OPERATION_CIRCUIT_BLOCKED', details: { operation_key: operationKey, reason: operationGate.reason },
      });
      if (operationCircuit?.state === 'RECOVERY_AUTHORIZED') {
        await consumeSop06OperationRecoveryEvidence(dataRoot, sku, item.exact_string);
      }
      try {
        await provider.runCurrentSubtask(item.child_id);
      } catch (error) {
        const code = error?.code || 'BOLOO_PROVIDER_RUN_FAILED';
        if (['BOLOO_WEBVIEW2_BRIDGE_TIMEOUT', 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT'].includes(code) || !processAlive(panePid)) {
          const waiting = await waitSop06ForBolooPane(dataRoot, sku, item.child_id, { reasonCode: code });
          return { parent_sku: sku, parent_step: waiting.task.current_step, status: waiting.task.status, waiting_dependency_key: waiting.task.waiting_dependency_key, completed_count: outcomes.filter(x => ['PASS', 'PASS_NO_RESULT'].includes(x.status)).length, outcomes, failed_exact_string: item.exact_string, error_code: code };
        }
        throw error;
      }
      await recordSop06BolooExplorerChildResult(dataRoot, sku, item.child_id);
    }
    parent = await getTask(dataRoot, sku);
    row = parent.listing_sop.sop06_keyword_queries.required_subtasks.find(candidate => candidate.exact_string === item.exact_string);
    const outcome = { exact_string: row.exact_string, status: row.status, volume: row.volume, reason_code: row.reason_code, attempt: row.attempt, request_id: row.provider_request_id, queried_at: row.queried_at, provider_method: row.provider_method, result_version: row.result_version, cache_reused: row.cache_reused === true, evidence_refs: row.evidence_refs_result };
    outcomes.push(outcome); process.stdout.write(`${JSON.stringify({ type: 'SOP06_QUERY_PROGRESS', ...outcome })}\n`);
    if (!['PASS', 'PASS_NO_RESULT'].includes(row.status)) {
      const paneFailure = classifySop06ReturnedFailure(row);
      if (paneFailure) {
        const waiting = await waitSop06ForBolooPane(dataRoot, sku, item.child_id, { reasonCode: paneFailure, requestId: row.provider_request_id });
        return { parent_sku: sku, parent_step: waiting.task.current_step, status: waiting.task.status, waiting_dependency_key: waiting.task.waiting_dependency_key, completed_count: outcomes.filter(x => ['PASS', 'PASS_NO_RESULT'].includes(x.status)).length, outcomes };
      }
      return { parent_sku: sku, parent_step: parent.current_step, status: row.status, waiting_dependency_key: null, completed_count: outcomes.filter(x => ['PASS', 'PASS_NO_RESULT'].includes(x.status)).length, outcomes };
    }
  }

  // Persist each individually QA-passed MISS before parent Stage QA so the
  // final immutable artifact can reference the exact shared-library record.
  let parentAfterQueries = await getTask(dataRoot, sku);
  for (const row of parentAfterQueries.listing_sop.sop06_keyword_queries.required_subtasks) {
    if (row.status !== 'PASS' || row.cache_reused === true || row.volume_library_lookup?.source_record) continue;
    const ref = row.evidence_refs_result?.find(item => item.persisted && item.matches_request)?.reference;
    const result = row.provider_result;
    if (!ref || !result?.request_id || !Number.isFinite(row.volume)) throw Object.assign(new Error('SOP06 result cannot be saved to Keyword Volume Library without request and evidence.'), { code: 'SOP06_KEYWORD_LIBRARY_EVIDENCE_MISSING' });
    const bytes = await fs.readFile(ref);
    const raw = JSON.parse(bytes.toString('utf8'));
    if (raw.request_id !== result.request_id || raw.query_text !== row.exact_string || raw.operation !== 'keyword_explorer'
      || raw.raw_response?.matched_query !== row.exact_string || raw.raw_response?.field_name !== EXPLORER_FIELD) {
      throw Object.assign(new Error('Keyword Library raw evidence identity did not match its SOP06 result.'), { code: 'SOP06_KEYWORD_LIBRARY_EVIDENCE_MISMATCH' });
    }
    const evidenceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const libraryRecord = library.record({ exactString: row.exact_string, identity: BOL_KEYWORD_VOLUME_IDENTITY,
      queriedAt: result.observed_at, status: row.volume === 0 ? 'ZERO_VALID' : 'PASS', monthlyVolume: row.volume,
      sourceSku: sku, sourceRecord: `${parentAfterQueries.listing_sop.sop06_keyword_queries.sop05_version}:${row.result_version}`,
      evidenceRef: path.resolve(ref), evidenceSha256, providerRequestId: result.request_id });
    await attachSop06KeywordLibraryRecord(dataRoot, sku, row.exact_string, libraryRecord);
    parentAfterQueries = await getTask(dataRoot, sku);
  }

  const finalized = await finalizeSop06BolooExplorer(dataRoot, sku);
  if (!finalized.passed) return { parent_sku: sku, parent_step: finalized.task.current_step, status: 'QA_FAIL', report: finalized.report, outcomes };
  let cacheWrite;
  try { cacheWrite = await persistSop06PassResultsToFormalCache(dataRoot, sku, { library }); }
  catch (error) { cacheWrite = { saved_count: 0, blocked: true, reason: error?.code || 'FORMAL_CACHE_WRITE_FAILED' }; }
  return {
    parent_sku: sku, parent_step: finalized.task.current_step, status: finalized.task.status,
    sop06_status: finalized.task.listing_sop.steps.LISTING_SOP_06.status,
    sop06_qa: finalized.task.qa.LISTING_SOP_06.status, sop06_version: finalized.artifact.version,
    artifact_path: finalized.artifact_path, next_step: finalized.next_step,
    waiting_dependency_key: finalized.waiting_dependency_key,
    cache_hit_count: finalized.artifact.results.filter(item => item.cache_reused).length,
    keyword_library: { contract: 'BOLOO_KEYWORD_VOLUME_LIBRARY_V1', identity: BOL_KEYWORD_VOLUME_IDENTITY,
      query_date: libraryBatch.per_sku[0]?.results[0]?.query_date || null,
      hit_count: finalized.artifact.results.filter(item => item.volume_library_lookup?.status === 'HIT_TODAY').length,
      miss_count: finalized.artifact.results.filter(item => item.volume_library_lookup?.status !== 'HIT_TODAY').length,
      reused_count: finalized.artifact.results.filter(item => item.cache_reused).length,
      evidence_refs: finalized.artifact.results.map(item => item.volume_library_lookup?.evidence_ref || item.evidence_refs_result?.[0]?.reference).filter(Boolean) },
    formal_cache_write: cacheWrite,
    outcomes,
  };
  } finally {
    library.close();
  }
}

/** Save only Stage-QA-PASS real Explorer observations via the existing cache owner API. */
export async function persistSop06PassResultsToFormalCache(dataRoot, sku, { library = new BolooKeywordVolumeLibrary(LIBRARY_FILE).initialize() } = {}) {
  const task = await getTask(dataRoot, sku);
  const artifact = task?.outputs?.LISTING_SOP_06;
  if (!task || task.qa?.LISTING_SOP_06?.status !== 'PASS' || artifact?.qa_status !== 'PASS'
    || task.listing_sop?.steps?.LISTING_SOP_06?.status !== 'PASS') {
    throw Object.assign(new Error('Formal keyword cache write requires persisted LISTING_SOP_06 Stage QA PASS.'), { code: 'SOP06_CACHE_WRITE_BEFORE_QA_FORBIDDEN' });
  }
  const apiCache = await new ApiCache(dataRoot).initialize();
  const results = [];
  for (const row of artifact.results || []) {
    if (row.status !== 'PASS' || row.cache_reused === true) continue;
    const result = row.provider_result;
    const ref = row.evidence_refs_result?.find(item => item.persisted && item.matches_request)?.reference;
    if (!result || !ref || !Number.isFinite(row.volume) || result.query_text !== row.exact_string) {
      results.push({ exact_string: row.exact_string, saved: false, reason: 'PERSISTED_RESULT_OR_EVIDENCE_MISSING' });
      continue;
    }
    const existing = await apiCache.findReusableBolooKeyword({ exactString: row.exact_string, queriedAtUtc: result.observed_at });
    if (existing?.observationId) {
      results.push({ exact_string: row.exact_string, saved: true, reused_existing_record: true, observation_id: existing.observationId });
      continue;
    }
    const evidence = JSON.parse(await fs.readFile(ref, 'utf8'));
    const saved = await apiCache.recordBolooKeywordObservation({
      exactString: row.exact_string, queriedAtUtc: result.observed_at, toolName: 'Keyword Explorer',
      providerMethod: row.provider_method, officialSourceVerified: true, stageQaStatus: 'PASS',
      rawResponse: evidence.raw_response, structuredResult: { search_volume: row.volume },
      pageUrl: evidence.raw_response?.page_url, pageFieldName: evidence.raw_response?.field_name || EXPLORER_FIELD,
      rawValue: evidence.raw_response?.displayed_value, fetchedAtUtc: evidence.raw_response?.observed_at_utc,
      rawDomEvidenceRef: { kind: 'RAW', reference: ref },
      marketplace: BOL_KEYWORD_VOLUME_IDENTITY.marketplace, language: BOL_KEYWORD_VOLUME_IDENTITY.language,
      metric: BOL_KEYWORD_VOLUME_IDENTITY.metric,
    });
    results.push({ exact_string: row.exact_string, saved: true, observation_id: saved.observationId, query_date: saved.queryDate });
  }
  return { saved_count: results.filter(item => item.saved && !item.reused_existing_record).length, result_count: results.length, results };
}
