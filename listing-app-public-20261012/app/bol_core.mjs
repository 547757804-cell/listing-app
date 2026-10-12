import { acceptanceControlledRetry } from './listing_acceptance_closeout.mjs';
import { writeAtomicJson } from './atomic_json.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AdapterError, BolRetailerClient, runBolKeywordStage } from './bol_retailer_client.mjs';
import { bolApiReadiness } from './bol_api_readiness.mjs';
import { productionReadinessSnapshot, readinessOverride } from './provider_readiness.mjs';
import {
  createListingExecutorFramework, syncListingExecutorFramework, updateListingExecutorStep as applyListingExecutorStep,
  createListingWaitingItem as createExecutorWaitingItem, resolveListingWaitingItem as resolveExecutorWaitingItem,
  propagateListingStale, recordReleaseGate as updateReleaseGate,
} from './listing_executor_framework.mjs';
import { buildListingSop07Top20, qaListingSop07Top20 } from './listing_sop07_top20.mjs';
import { createListingEvidenceResolver } from './listing_evidence_resolver.mjs';
import { LISTING_SOP05_EXECUTOR_ID, buildListingSop05CandidatePool, qaListingSop05Contract } from './listing_sop05_candidate_pool.mjs';
import {
  LISTING_COMPETITOR_ANALYSIS_EXECUTOR,
  expectedSop09RuntimeVersions,
  getListingSopExecutor,
  qaListingCompetitorAnalysis,
  resolveSop09RuntimeInputs,
  runListingCompetitorAnalysisRuntime,
} from './listing_competitor_analysis_executor.mjs';
import { getAiProviderReadiness, getAiProviderExecutionConfig } from './ai_router.mjs';
import { evaluateGenerationRecoveryGate, evaluateGenerationRecoveryRoute, findQualifyingGenerationProbe, consumeGenerationRecoveryGate, readAiGenerationState, getGenerationCircuit, validateSop10RecoveryBinding, validateQwenSop10RecoveryBinding, rollbackGenerationRecoveryConsumption, assertTaskRevisionCAS, isProviderPartialReusable } from './ai_generation_recovery.mjs';
import { readCapabilityEvidence, persistCapabilitySnapshot, planDeepSeekProtocolMigration, planDeepSeekPromptContractMigration, planQwenSop10RequestContractMigration, writeImmutableRecoveryArtifact } from './sop10_recovery_evidence.mjs';
import { SOP10_17_EXECUTOR_IDS, runListingSop10To17Step, resolveSop10To17Inputs, buildSop10DeepSeekRecoveryIdentity, buildListingProviderGenerationIdentity, listingAiStepRoutePreflight, qaSop10To17Output, sop10To17OutputKey } from './listing_sop10_17_executor.mjs';
import { aiProviderConfig } from './ai_provider_adapters.mjs';
import { buildListingCopyRevision, persistListingCopyRevision } from './listing_copy_revalidation.mjs';
import { matchesDisplayedVolume } from './boloo_volume_format.mjs';
import { buildSop06OperationKey, buildSop06OperationCircuitFailure, buildSop06OperationRecoveryEvidence } from './listing_sop06_operation_circuit.mjs';
import { buildProviderReadinessIdentity } from './ai_provider_readiness_evidence.mjs';
import { resolveListingProviderRecoveryRouteReadiness } from './listing_provider_recovery_route.mjs';
import { resolveAiProviderDependencyBarrier, isProviderReadinessAfterBarrier } from './ai_dependency_resume_gate.mjs';
import { selectSop04SeedFromFacts, SOP04_SEED_SELECTION_POLICY } from './listing_sop04_seed_selector.mjs';
import { buildSop04SupplementalSeedPlan, classifySop04RelatedTerms, SOP04_MULTI_SEED_POLICY } from './listing_sop04_related_terms.mjs';
import {
  buildListingSop08Candidates, buildListingSop08Pool, buildSop08ExistingEvaluationPlan, buildSop08RemoteFailureRecord, canonicalizeSop08BolUrl, classifyListingCompetitor,
  applyBolNetworkFailureBarrier, applySop08HttpClientErrorPause, applySop08RateLimitWait, applySop08UpstreamHttpWait,
  classifySop08BolFailure, completeSop08ExistingCandidateEvaluation, dedupeSop08DiscoveredCandidates, findSop08DuplicateCandidate,
  isBolBusinessNetworkFailure, mapSop08LocalCompetitorEvidence, sop08OwnProductPlacementDisposition, inspectSop08CandidateSlots,
  qaListingSop08Pool, readinessIsAfterDependencyFailure, selectSop08DiscoveryQueries, nextSop08DiscoveryQuery,
  shouldSupplementSop08, sop08ShouldStopSupplementing, planSop08ExecutionPhase, buildSop08PhaseCheckpoint, validateSop08Preflight,
  applySop08RatingsNotAvailable, isSop08RatingsNotFoundForEan, resolveSop08SavedRatingsNotFound,
  planSop08DiscoveryQueryRecovery,
} from './listing_sop08_competitors.mjs';
import { TASK_AUTO_MUTATION_ENABLED, ACCEPTANCE_HOLD, RUNTIME_MODE, isManualContinueRequired, getEffectiveRuntimePolicy, setAcceptanceHold, assertBusinessDispatchEnabled, isManualContinueScopeAllowed, isAcceptanceCachedFinalizeScopeAllowed, withAcceptanceManualContinueDispatchScope } from './runtime_mode.mjs';
import {
  acquireListingExecutionLease, ensureListingExecutionLeaseSchema, finishListingExecutionLease,
  heartbeatListingExecutionLease, makeListingExecutionInputVersion, buildDuplicateDispatchSuppression,
  activateListingExecution, deactivateListingExecution,
} from './listing_execution_lease.mjs';

// Acceptance HOLD permits a small set of explicitly routed recovery controls.
// AsyncLocalStorage scopes each exception to the request chain and SKU.
const acceptanceRecoveryControlScope = new AsyncLocalStorage();
function manualContinueScopeIsLive(scope = acceptanceRecoveryControlScope.getStore()) {
  return Boolean(scope?.manual_continue_scope && isManualContinueScopeAllowed({
    runtimePolicy: getEffectiveRuntimePolicy(), env: process.env,
    action: scope.action, sku: scope.sku,
    manualContinueSku: getEffectiveRuntimePolicy().manual_continue_sku,
    acceptanceDataRoot: scope.acceptance_data_root === true,
  }));
}
function manualContinueChildBelongsToScope(scope, childSku) {
  if (!manualContinueScopeIsLive(scope) || !['continue', 'sop06-pane-resume'].includes(scope.action) || !database || !childSku) return false;
  try {
    const row = database.prepare('SELECT payload FROM products WHERE sku = ?').get(String(childSku));
    const task = row?.payload ? JSON.parse(row.payload) : null;
    return task?.provider_child_task?.parent_sku === scope.sku
      && task?.provider_child_task?.parent_sop_step === 'LISTING_SOP_06';
  } catch { return false; }
}
function localReconciliationChildBelongsToScope(scope, childSku) {
  if (!scope || scope.action !== 'RECONCILE_SOP06_SUCCESS_CHECKPOINT' || !database || !childSku) return false;
  try {
    const row = database.prepare('SELECT payload FROM products WHERE sku = ?').get(String(childSku));
    const task = row?.payload ? JSON.parse(row.payload) : null;
    return task?.provider_child_task?.parent_sku === scope.sku
      && task?.provider_child_task?.parent_sop_step === 'LISTING_SOP_06';
  } catch { return false; }
}
function assertCoreDispatchEnabled(operation, { commitEventType = null, serializedKey = null, taskSku = null } = {}) {
  const scope = acceptanceRecoveryControlScope.getStore();
  const manualContinueAllowed = manualContinueScopeIsLive(scope);
  if (manualContinueAllowed && (
    operation === 'Workbench task database access'
    || (operation === 'Serialized business task mutation'
      && (serializedKey === scope.sku || serializedKey === '__event_log__' || manualContinueChildBelongsToScope(scope, serializedKey)))
    || (operation === 'Listing task state mutation'
      && (taskSku === scope.sku || manualContinueChildBelongsToScope(scope, taskSku)))
    || (operation === 'Task event append' && (taskSku === scope.sku || manualContinueChildBelongsToScope(scope, taskSku)))
  )) return;
  const localReconciliationAllowed = ACCEPTANCE_HOLD
    && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL'
    && ['RECONCILE_LOCAL_TASK_STATE', 'RECONCILE_SOP06_PANE_TIMEOUT', 'RECONCILE_SOP06_SUCCESS_CHECKPOINT', 'finalize_cached_sop07_top20', 'finalize_sop08_persisted_artifact', 'register_sop09_input_bundle', 'revalidate_cached_sop09_qa'].includes(scope?.action)
    && scope?.acceptance_data_root === true;
  if (localReconciliationAllowed && (
    operation === 'Workbench task database access'
    || (operation === 'Serialized business task mutation' && ([scope.sku, '__event_log__'].includes(serializedKey)
      || localReconciliationChildBelongsToScope(scope, serializedKey)))
    || (operation === 'Listing task state mutation' && (
      ['LOCAL_STATE_RECONCILIATION_APPLIED', 'SOP06_ORPHANED_PANE_TIMEOUT_RECONCILED', 'SOP06_PROVIDER_CHILD_WAITING_FOR_PANE',
        'SOP06_PROVIDER_CHILD_RESULT_QA_PASS', 'SOP06_BOOLOO_EXPLORER_RESULT_RECONCILED', 'SOP06_KEYWORD_VOLUME_LIBRARY_RECORD_LINKED',
        'SOP06_OPERATION_RECOVERY_EVIDENCE_CONSUMED', 'LISTING_SOP_07_CACHED_QA_RECOVERED',
        'SOP08_PERSISTED_EVIDENCE_RECONCILED', 'LISTING_SOP_08_STAGE_QA_PASS', 'SOP09_INPUT_BUNDLE_REGISTERED', 'LISTING_SOP_09_CACHED_QA_REVALIDATED'].includes(commitEventType)
      || (taskSku === scope.sku || localReconciliationChildBelongsToScope(scope, taskSku))))
    || (operation === 'Task event append' && (taskSku === scope.sku || localReconciliationChildBelongsToScope(scope, taskSku)))
  )) return;
  const baseAllowed = ACCEPTANCE_HOLD
    && process.env.BOL_ACCEPTANCE_MODE === '1'
    && scope?.sku === 'SYNTHETIC-SKU-LEGACY-10'
    && ['case_a_sop10_recovery_preflight', 'case_a_sop10_generation_recovery_probe_bind', 'recover_listing_transition', 'finalize_cached_listing_evidence_repair', 'finalize_cached_listing_step'].includes(scope?.action);
  const qwenSop10Allowed = ACCEPTANCE_HOLD
    && process.env.BOL_ACCEPTANCE_MODE === '1'
    && scope?.sku === 'SYNTHETIC-SKU-LEGACY-05'
    && ['qwen_sop10_recovery_preflight', 'qwen_sop10_generation_recovery_probe_bind'].includes(scope?.action);
  const deepSeekListingStepAllowed = ACCEPTANCE_HOLD
    && process.env.BOL_ACCEPTANCE_MODE === '1'
    && scope?.sku === 'SYNTHETIC-SKU-LEGACY-05'
    && ['deepseek_listing_step_recovery_preflight', 'deepseek_listing_step_generation_recovery_probe_bind'].includes(scope?.action);
  const scopedCachedListingRepairAllowed = ACCEPTANCE_HOLD
    && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL'
    && scope?.acceptance_data_root === true
    && scope?.action === 'finalize_cached_listing_step'
    && isAcceptanceCachedFinalizeScopeAllowed({ sku: scope?.sku, dataRoot: scope?.data_root, action: scope?.action });
  if (scopedCachedListingRepairAllowed && (
    operation === 'Workbench task database access'
    || (operation === 'Serialized business task mutation' && [scope.sku, '__event_log__'].includes(serializedKey))
    || (operation === 'Listing task state mutation' && taskSku === scope.sku
      && ['LISTING_CACHED_STAGE_QA_RECOVERED','LISTING_REQUEST_CONTRACT_RECOVERED','ACCEPTANCE_STOP_AFTER_STEP'].includes(commitEventType))
    || (operation === 'Task event append' && taskSku === scope.sku)
  )) return;
  const allowed = baseAllowed && (
    operation === 'Workbench task database access'
    || (operation === 'Serialized business task mutation' && ['SYNTHETIC-SKU-LEGACY-10', '__event_log__'].includes(serializedKey))
    || (operation === 'Listing task state mutation' && scope.action === 'case_a_sop10_generation_recovery_probe_bind'
      && commitEventType === 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_EVIDENCE_BOUND')
    || (operation === 'Listing task state mutation' && scope.action === 'recover_listing_transition'
      && commitEventType === 'LEGACY_LISTING_TRANSITION_RECOVERED')
    || (operation === 'Listing task state mutation' && scope.action === 'finalize_cached_listing_step'
      && ['LISTING_CACHED_STAGE_QA_RECOVERED','LISTING_REQUEST_CONTRACT_RECOVERED','ACCEPTANCE_STOP_AFTER_STEP'].includes(commitEventType))
    || (operation === 'Listing task state mutation' && scope.action === 'finalize_cached_listing_evidence_repair'
      && commitEventType === 'LISTING_SOP_EVIDENCE_REPAIR_QA_PASS')
  );
  if (allowed) return;
  const qwenAllowed = qwenSop10Allowed && (
    operation === 'Workbench task database access'
    || (operation === 'Serialized business task mutation' && ['SYNTHETIC-SKU-LEGACY-05', '__event_log__'].includes(serializedKey))
    || (operation === 'Listing task state mutation' && scope.action === 'qwen_sop10_generation_recovery_probe_bind'
      && commitEventType === 'QWEN_SOP10_GENERATION_RECOVERY_EVIDENCE_BOUND')
    || (operation === 'Task event append' && taskSku === 'SYNTHETIC-SKU-LEGACY-05')
  );
  if (qwenAllowed) return;
  const deepSeekListingStepMutationAllowed = deepSeekListingStepAllowed && (
    operation === 'Workbench task database access'
    || (operation === 'Serialized business task mutation' && ['SYNTHETIC-SKU-LEGACY-05', '__event_log__'].includes(serializedKey))
    || (operation === 'Listing task state mutation' && scope.action === 'deepseek_listing_step_generation_recovery_probe_bind'
      && commitEventType === 'DEEPSEEK_LISTING_STEP_RECOVERY_EVIDENCE_BOUND')
    || (operation === 'Task event append' && taskSku === 'SYNTHETIC-SKU-LEGACY-05')
  );
  if (deepSeekListingStepMutationAllowed) return;
  assertBusinessDispatchEnabled(operation);
}

function isOfficialWebBolooReady() {
  const override = readinessOverride('BOLOO_OFFICIAL_WEB_READY');
  return typeof override === 'boolean' ? override : productionReadinessSnapshot().BOLOO_OFFICIAL_WEB_READY === true;
}

export function officialWebBolooReady() { return isOfficialWebBolooReady(); }

export function validateSop03AmazonLocalSource(fields = {}, evidenceCells = [], expressions = []) {
  const amazonUrl = String(fields.amazon_reference?.raw_value || '').trim();
  const validUrl = /^https:\/\/(?:www\.)?amazon\.[a-z.]+\//i.test(amazonUrl);
  const refs = new Set(Array.isArray(evidenceCells) ? evidenceCells : []);
  const requiredCells = [fields.amazon_reference?.cell_reference,
    ...['amazon_supplementary_reference', 'amazon_description_reference']
      .map(key => fields[key]).filter(field => field?.cell_reference && String(field.raw_value || '').trim()).map(field => field.cell_reference)]
    .filter(Boolean);
  const missing = requiredCells.filter(cell => !refs.has(cell));
  if (!validUrl || !fields.amazon_reference?.cell_reference || missing.length) {
    throw Object.assign(new Error('Amazon 本地来源缺少有效参考 URL 或其来源单元格证据。'), {
      code: 'SOP03_LOCAL_SOURCE_QA_FAILED', missing_evidence_cells: missing,
    });
  }
  const structured = Array.isArray(expressions) && expressions.length > 0;
  return Object.freeze({ status: 'PASS', source_url: amazonUrl, source_cells: requiredCells,
    expressions: Array.isArray(expressions) ? expressions : [], expressions_status: structured ? 'STRUCTURED' : 'RAW_SOURCE_ONLY',
    candidate_only: true, never_own_product_fact: true });
}

export const STEPS = [
  ['product_master', '资料处理', '资料处理池'],
  ['bol_keywords', 'BOL 联想词', '关键词池'],
  ['boloo_keywords', 'Boloo 关键词', '关键词池'],
  ['top20', 'TOP20', '关键词池'],
  ['competitors', 'Listing 有效竞品', 'Listing 生成池'],
  ['selling_matrix', '竞争卖点矩阵', 'Listing 生成池'],
  ['title', '标题', 'Listing 生成池'],
  ['anchors', '锚点', 'Listing 生成池'],
  ['description', '描述', 'Listing 生成池'],
  ['qa', 'QA', 'QA 池'],
  ['excel_qa', 'Excel 核验', 'QA 池'],
];

// Canonical business numbering follows chapter 23 of the locked 2026-09-22 V1.1 SOP.
// Existing Provider work is recorded as an internal subtask under the matching SOP step;
// parallel sidecars and release gates are intentionally not numbered here.
export const LISTING_SOP_STEPS = [
  ['LISTING_SOP_01', '读取自有资料', 'product_master_snapshot'],
  ['LISTING_SOP_02', '确认真实产品事实', 'product_fact_confirmation'],
  ['LISTING_SOP_03', 'BOL / Amazon / Boloo 竞品关键词挖掘', 'keyword_source_discovery'],
  ['LISTING_SOP_04', '验证 5–7 个 BOL 关联/联想词', 'bol_keywords'],
  ['LISTING_SOP_05', '建立候选池并筛选约 20 个待查精确字符串', 'keyword_candidate_pool'],
  ['LISTING_SOP_06', '逐词查询 Boloo 月均搜索量', 'boloo_keywords'],
  ['LISTING_SOP_07', '形成正式 TOP20 关键词表', 'top20'],
  ['LISTING_SOP_08', '建立 3–5 个有效竞品池', 'listing_competitor_pool'],
  ['LISTING_SOP_09', 'BOL / Amazon 有效竞品深度分析及评论分析', 'listing_competitor_analysis'],
  ['LISTING_SOP_10', '提炼热卖点、痛点、购买理由及畅销原因', 'buyer_insights'],
  ['LISTING_SOP_11', '比较我方优势、持平和劣势', 'own_competitor_comparison'],
  ['LISTING_SOP_12', '生成竞争卖点矩阵', 'selling_matrix'],
  ['LISTING_SOP_13', '关键词和卖点升权、保持或降权', 'display_weighting'],
  ['LISTING_SOP_14', '输出最终标题', 'title'],
  ['LISTING_SOP_15', '输出 5 个产品专属信息锚点', 'anchors'],
  ['LISTING_SOP_16', '输出荷兰语描述、包装内容、属性及中文对照', 'description'],
  ['LISTING_SOP_17', '执行最终 QA 并交给 Codex 填表', 'final_qa'],
].map(([id, label, executor]) => ({ id, label, executor }));

export const LISTING_SYSTEM_RELEASE_GATES = [
  'LISTING_EXCEL_WRITE', 'LISTING_EXCEL_READBACK_QA', 'AWAIT_UPLOAD', 'FINAL_ARCHIVE',
];

const OWN_FACT_FIELDS = [
  ['sku', 'SKU'], ['ean', 'EAN'], ['model', '型号'], ['brand_name', '品牌'], ['name', '产品名称'],
  ['specifications', '规格'], ['dimensions', '尺寸'], ['weight_kg', '重量 kg'], ['material', '材质'],
  ['color', '颜色'], ['functions', '功能'], ['accessories', '配件'], ['packaging_contents', '包装内容'],
  ['images', '自有产品图片'], ['documents', '自有产品资料'],
];
const OWN_SOURCE_TYPES = new Set(['PRODUCT_MASTER', 'OWN_PRODUCT', '1688', 'OWN_IMAGE', 'OWN_PHYSICAL', 'OWN_DOCUMENT']);
const SOP_STEP_POOL = {
  LISTING_SOP_01: '资料处理池', LISTING_SOP_02: '资料处理池', LISTING_SOP_03: '关键词池',
};

// Independent competitor-research lane. It deliberately has its own task record,
// pool, QA state, event stream, and versions; it never advances Listing tasks.
export const COMPETITOR_RESEARCH_STEPS = [
  ['product_baseline', '产品基准', '产品基准池'],
  ['seed_competitor', '种子竞品', '种子竞品池'],
  ['auto_expand', '自动扩搜', '自动扩搜池'],
  ['same_oem', '同款 / OEM', '同款/OEM池'],
  ['low_price', '低价竞品', '低价竞品池'],
  ['same_price', '同价竞品', '同价竞品池'],
  ['high_spec', '高配竞品', '高配竞品池'],
  ['mature', '成熟竞品', '成熟竞品池'],
  ['amazon_exact', 'Amazon 完全同款', 'Amazon完全同款池'],
  ['saturation_round_1', '第一轮饱和搜索', '饱和搜索池'],
  ['saturation_round_2', '第二轮饱和搜索', '饱和搜索池'],
  ['fact_validation', '参数 / 价格 / 评论 / 销量核验', '数据核验池'],
  ['price_line', '价格线', '价格线池'],
  ['purchase_risk', '20 件采购风险', '采购风险池'],
  ['purchase_action', '采购动作', '采购动作池'],
  ['research_qa', '竞品 QA', '竞品 QA 池'],
  ['research_excel', '竞品调研 Excel', '竞品调研导出池'],
  ['research_archive', '历史存档', '竞品调研存档池'],
];
export const BOLOO_REASON_CODES = [
  'RESULT_FOUND', 'KEYWORDS_FOUND', 'EXPLORER_ZERO_VOLUME', 'EXPLORER_NO_RESULTS', 'EXTRACTOR_NO_KEYWORDS', 'PAGE_NOT_READY',
  'LOGIN_EXPIRED', 'NAVIGATION_FAILED', 'DOM_FIELD_MISSING', 'INPUT_RESULT_MISMATCH', 'NETWORK_FAILED', 'UNKNOWN_PROVIDER_ERROR',
];
export const BOLOO_DISCOVERY_SOURCE_IDS = Object.freeze([
  'product_facts', 'listing_competitor_keywords', 'bol_competitor_keywords', 'amazon_competitor_keywords',
  'boloo_competitor_link_keywords', 'bol_related_terms', 'other_confirmed_candidate_sources',
]);
const BOLOO_DISCOVERY_SOURCES = BOLOO_DISCOVERY_SOURCE_IDS;
const BOLOO_SOURCE_ORIGINS = {
  product_facts: ['PRODUCT_FACTS'],
  listing_competitor_keywords: ['LISTING_COMPETITOR_KEYWORD'],
  bol_competitor_keywords: ['BOL_COMPETITOR_KEYWORD'],
  amazon_competitor_keywords: ['AMAZON_COMPETITOR_KEYWORD'],
  boloo_competitor_link_keywords: ['BOLOO_COMPETITOR_LINK_KEYWORD'],
  bol_related_terms: ['BOL_RELATED_TERM'],
};
export const BOLOO_CANDIDATE_STATUS_VALUES = Object.freeze(['ACTIVE', 'EXCLUDED', 'NO_RESULT', 'CONFIRMED_VOLUME', 'SELECTED_TOP20']);
const BOLOO_CANDIDATE_STATUSES = new Set(BOLOO_CANDIDATE_STATUS_VALUES);

function buildBolooRequiredSubtasks(sku, { explorer_queries = [], extractor_urls = [], explorer_origin = 'LISTING_COMPETITOR_KEYWORD', extractor_origin = 'LISTING_INTERNAL_COMPETITOR_URL' } = {}) {
  if (!Array.isArray(explorer_queries) || !Array.isArray(extractor_urls)) throw Object.assign(new Error('explorer_queries 与 extractor_urls 必须是数组。'), { code: 'BOLOO_REQUIRED_SUBTASKS_INVALID' });
  const rows = [
    ...explorer_queries.map((query_text, index) => ({ provider_source: 'keyword_explorer', input_type: 'exact_keyword', query_text, origin_source: explorer_origin, ordinal: index + 1 })),
    ...extractor_urls.map((query_text, index) => ({ provider_source: 'keyword_extractor', input_type: 'competitor_url', query_text, origin_source: extractor_origin, ordinal: index + 1 })),
  ];
  if (!rows.length) throw Object.assign(new Error('至少提供一个 Explorer 精确关键词或 Extractor 竞品 URL。'), { code: 'BOLOO_REQUIRED_SUBTASKS_EMPTY' });
  return rows.map(row => {
    if (typeof row.query_text !== 'string' || !row.query_text.trim()) throw Object.assign(new Error('Boloo 子任务查询内容不能为空；原始字符串不会被规范化。'), { code: 'BOLOO_QUERY_TEXT_INVALID' });
    const source_query_text = row.query_text;
    let query_text = row.query_text;
    if (row.input_type === 'competitor_url') {
      query_text = canonicalizeBolProviderUrl(row.query_text);
      if (!query_text) throw Object.assign(new Error('Extractor 子任务必须是有效 BOL HTTPS 竞品 URL。'), { code: 'BOLOO_COMPETITOR_URL_INVALID' });
    }
    const identity = `${row.provider_source}\0${query_text}`;
    const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
    const source_id = `${row.provider_source}:${digest}:${String(row.ordinal).padStart(3, '0')}`;
    return {
      subtask_id: `${sku}:${source_id}`, source_id, provider_source: row.provider_source,
      input_type: row.input_type, query_text, source_query_text, ordinal: row.ordinal,
      origin_sources: [row.origin_source],
      status: 'NOT_STARTED', attempt_count: 0, retry_count: 0, extractor_no_keyword_attempts: 0,
      request_ids: [], history: [], result: null, error_code: null, updated_at: iso(),
    };
  });
}

function bolooSubtasksComplete(task) {
  const required = task.boloo?.required_subtasks || [];
  return required.length > 0 && required.every(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status))
    && !required.some(item => item.status === 'PENDING_RECHECK') && activeIssueCount(task) === 0;
}

function addBolooCandidate(task, queryText, origin, { status = 'ACTIVE', volume = null, cache = null, volumeEvidence = null, noResultEvidence = null, exclusionReason = null } = {}) {
  task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null, candidates: [] };
  task.boloo.candidates ||= [];
  const digest = crypto.createHash('sha256').update(queryText, 'utf8').digest('hex').slice(0, 20);
  let candidate = task.boloo.candidates.find(item => item.candidate_id === `${task.sku}:keyword:${digest}` && item.query_text === queryText);
  if (!candidate) {
    candidate = { candidate_id: `${task.sku}:keyword:${digest}`, query_text: queryText, candidate_status: status, origin_sources: [], exclusion_reason: null, confirmed_volume: null, confirmed_volume_evidence: null, no_result_evidence: null, cache_provenance: null, updated_at: iso() };
    task.boloo.candidates.push(candidate);
  }
  candidate.origin_sources ||= [];
  if (origin && !candidate.origin_sources.includes(origin)) candidate.origin_sources.push(origin);
  if (status === 'CONFIRMED_VOLUME' && candidate.candidate_status !== 'EXCLUDED') {
    candidate.candidate_status = 'CONFIRMED_VOLUME';
    candidate.confirmed_volume = volume;
    candidate.confirmed_volume_evidence = volumeEvidence ? clone(volumeEvidence) : candidate.confirmed_volume_evidence;
    candidate.cache_provenance = cache ? clone(cache) : candidate.cache_provenance;
    candidate.exclusion_reason = null;
  } else if (status === 'NO_RESULT' && !['CONFIRMED_VOLUME', 'EXCLUDED'].includes(candidate.candidate_status)) {
    candidate.candidate_status = 'NO_RESULT';
    candidate.confirmed_volume = null;
    candidate.no_result_evidence = noResultEvidence ? clone(noResultEvidence) : candidate.no_result_evidence;
  }
  candidate.updated_at = iso();
  return candidate;
}

function syncBolooCandidatePool(task) {
  task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null, candidates: [] };
  task.boloo.candidates ||= [];
  for (const subtask of task.boloo.required_subtasks || []) {
    if (subtask.provider_source !== 'keyword_explorer') continue;
    const origins = subtask.origin_sources?.length ? subtask.origin_sources : ['BOLOO_DISCOVERED_CANDIDATE'];
    for (const origin of origins) {
      const existing = task.boloo.candidates.find(item => item.query_text === subtask.query_text && item.candidate_status === 'EXCLUDED');
      if (existing) { existing.origin_sources ||= []; if (!existing.origin_sources.includes(origin)) existing.origin_sources.push(origin); continue; }
      const cached = task.boloo.candidates.find(item => item.query_text === subtask.query_text && item.candidate_status === 'CONFIRMED_VOLUME' && item.cache_provenance?.cache_record_id);
      if (cached) {
        cached.origin_sources ||= [];
        if (!cached.origin_sources.includes(origin)) cached.origin_sources.push(origin);
        cached.confirmed_volume_evidence ||= {};
        Object.assign(cached.confirmed_volume_evidence, {
          source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: cached.cache_provenance.provider_method,
          business_date: cached.cache_provenance.business_date, cache_record_id: cached.cache_provenance.cache_record_id,
          qa_status: cached.cache_provenance.qa_status, same_day: cached.cache_provenance.same_day,
          matched_query: cached.query_text,
        });
        continue;
      }
      if (subtask.status === 'PASS' && Number.isFinite(subtask.result?.result?.search_volume) && subtask.result?.cache_source === 'BOLOO_OFFICIAL_WEB') {
        addBolooCandidate(task, subtask.query_text, origin, {
          status: 'CONFIRMED_VOLUME', volume: subtask.result.result.search_volume,
          volumeEvidence: { source: 'BOLOO_OFFICIAL_WEB', subtask_id: subtask.subtask_id, request_id: subtask.result.request_id, observed_at: subtask.result.observed_at, page_url: subtask.result.evidence?.page_url, matched_query: subtask.result.evidence?.matched_query, displayed_value: subtask.result.evidence?.displayed_value },
        });
      } else if (subtask.status === 'PASS_NO_RESULT') addBolooCandidate(task, subtask.query_text, origin, {
        status: 'NO_RESULT', noResultEvidence: { source: 'BOLOO_OFFICIAL_WEB', subtask_id: subtask.subtask_id, request_id: subtask.result?.request_id, reason_code: subtask.result?.reason_code, observed_at: subtask.result?.observed_at, page_url: subtask.result?.evidence?.page_url, matched_query: subtask.result?.evidence?.matched_query, displayed_value: subtask.result?.evidence?.displayed_value },
      });
      else addBolooCandidate(task, subtask.query_text, origin, { status: 'ACTIVE' });
    }
  }
  return task.boloo.candidates;
}

function hasFormalBolooVolume(task, candidate) {
  const evidence = candidate.confirmed_volume_evidence;
  if (candidate.cache_provenance) return candidate.cache_provenance.source === 'BOLOO_OFFICIAL_VERIFIED'
    && ['BOLOO_OFFICIAL_WEB', 'BOLOO_OFFICIAL_MCP'].includes(candidate.cache_provenance.provider_method)
    && candidate.cache_provenance.qa_status === 'PASS' && candidate.cache_provenance.same_day === true
    && typeof candidate.cache_provenance.business_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.cache_provenance.business_date)
    && typeof candidate.cache_provenance.cache_record_id === 'string' && candidate.cache_provenance.cache_record_id.length > 0
    && evidence?.source === 'BOLOO_OFFICIAL_VERIFIED' && evidence.provider_method === candidate.cache_provenance.provider_method
    && evidence.business_date === candidate.cache_provenance.business_date && evidence.matched_query === candidate.query_text
    && evidence.qa_status === 'PASS' && evidence.same_day === true
    && evidence.cache_record_id === candidate.cache_provenance.cache_record_id;
  const subtask = (task.boloo?.required_subtasks || []).find(item => item.subtask_id === evidence?.subtask_id);
  return evidence?.source === 'BOLOO_OFFICIAL_WEB' && evidence.matched_query === candidate.query_text
    && subtask?.provider_source === 'keyword_explorer' && subtask.query_text === candidate.query_text
    && subtask.status === 'PASS' && subtask.result?.cache_source === 'BOLOO_OFFICIAL_WEB'
    && subtask.result?.result?.search_volume === candidate.confirmed_volume;
}

function hasFormalBolooNoResult(task, candidate) {
  const evidence = candidate.no_result_evidence;
  const subtask = (task.boloo?.required_subtasks || []).find(item => item.subtask_id === evidence?.subtask_id);
  return evidence?.source === 'BOLOO_OFFICIAL_WEB' && evidence.matched_query === candidate.query_text
    && subtask?.provider_source === 'keyword_explorer' && subtask.query_text === candidate.query_text
    && subtask.status === 'PASS_NO_RESULT' && subtask.result?.reason_code === 'EXPLORER_NO_RESULTS';
}

function validateSameDayBolooPassCache(cacheRows, submittedQueries) {
  if (!Array.isArray(cacheRows)) throw Object.assign(new Error('same_day_boloo_pass_cache 必须是数组。'), { code: 'BOLOO_CACHE_REUSE_INVALID' });
  const cacheByQuery = new Map();
  for (const rawHit of cacheRows) {
    const hit = rawHit || {};
    const queryText = hit.query_text ?? hit.exactString;
    const searchVolume = hit.search_volume ?? hit.structuredResult?.monthlyVolume ?? hit.structuredResult?.search_volume;
    const cacheRecordId = hit.cache_record_id ?? hit.observationId;
    const source = hit.source;
    const providerMethod = hit.provider_method;
    const qaStatus = hit.qa_status ?? hit.stage_qa_status ?? hit.stageQaStatus;
    const businessDate = hit.business_date ?? hit.query_date ?? hit.queryDate;
    // The cache owner returns formalReuse only after an exact-string lookup for
    // the requested Amsterdam business date. Normalized callers may instead
    // provide the explicit same_day assertion and date.
    const sameDay = hit.same_day === true || hit.formalReuse === true;
    const rawEvidence = hit.evidence || {};
    const evidence = {
      ...clone(rawEvidence),
      page_url: rawEvidence.page_url || hit.page_url || '',
      matched_query: rawEvidence.matched_query ?? queryText,
      displayed_value: rawEvidence.displayed_value ?? String(searchVolume),
    };
    const valid = typeof queryText === 'string' && queryText.trim()
      && source === 'BOLOO_OFFICIAL_VERIFIED'
      && ['BOLOO_OFFICIAL_WEB', 'BOLOO_OFFICIAL_MCP'].includes(providerMethod)
      && (hit.status === 'PASS' || hit.formalReuse === true)
      && qaStatus === 'PASS' && sameDay
      && typeof businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(businessDate)
      && Number.isFinite(searchVolume) && searchVolume >= 0
      && typeof cacheRecordId === 'string' && cacheRecordId.trim()
      && evidence.matched_query === queryText
      && String(evidence.displayed_value).trim() === String(searchVolume)
      && (hit.formalReuse === true ? typeof hit.queried_at_utc === 'string' && !!hit.queried_at_utc : !!(hit.same_day === true && (hit.query_date || hit.business_date || hit.queryDate)));
    if (!valid) throw Object.assign(new Error('关键词缓存复用必须是 exact string 匹配、同一 Europe/Amsterdam 业务日期、Stage QA PASS 且 source=BOLOO_OFFICIAL_VERIFIED 的正式记录；provider_method 仅允许 BOLOO_OFFICIAL_WEB 或 BOLOO_OFFICIAL_MCP。'), { code: 'BOLOO_CACHE_REUSE_NOT_VERIFIED' });
    if (cacheByQuery.has(queryText)) throw Object.assign(new Error('同一 exact keyword 不得重复提交多条缓存复用记录。'), { code: 'BOLOO_CACHE_REUSE_DUPLICATE' });
    if (submittedQueries && !submittedQueries.has(queryText)) throw Object.assign(new Error('缓存命中必须对应本次提交的精确候选词字符串。'), { code: 'BOLOO_CACHE_QUERY_NOT_SUBMITTED' });
    cacheByQuery.set(queryText, {
      ...clone(hit), query_text: queryText, search_volume: searchVolume, cache_record_id: cacheRecordId,
      source, provider_method: providerMethod, qa_status: qaStatus, same_day: true, business_date: businessDate,
      evidence, status: 'PASS',
    });
  }
  return cacheByQuery;
}

function resultFromBolooVolumeCache(sku, subtask, hit) {
  return {
    schema_version: 1, provider: 'BOLOO_OFFICIAL_CACHE', provider_source: 'keyword_explorer',
    subtask_id: subtask?.subtask_id || `${sku}:cache:${crypto.createHash('sha256').update(hit.query_text, 'utf8').digest('hex').slice(0, 16)}`,
    source_id: subtask?.source_id || null, request_id: `cache:${hit.cache_record_id}`, attempt: 0,
    status: 'PASS', reason_code: hit.search_volume === 0 ? 'EXPLORER_ZERO_VOLUME' : 'RESULT_FOUND',
    query_text: hit.query_text, observed_at: hit.observed_at || iso(),
    evidence: { ...clone(hit.evidence), source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: hit.provider_method, business_date: hit.business_date, displayed_value: String(hit.search_volume), matched_query: hit.query_text, cache_record_id: hit.cache_record_id },
    result: { search_volume: hit.search_volume }, cache_source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: hit.provider_method, cache_reused: true,
  };
}

function discoveryEvidenceProblems(task, closeEvidence) {
  const problems = [];
  const sources = closeEvidence?.discovery_sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return ['discovery_sources must explicitly enumerate each required first-stage source'];
  for (const key of BOLOO_DISCOVERY_SOURCES) {
    const entry = sources[key];
    if (!entry || entry.complete !== true || !Number.isInteger(entry.candidate_count) || entry.candidate_count < 0) {
      problems.push(`${key} must be complete and include a nonnegative candidate_count`);
      continue;
    }
    if (key === 'bol_related_terms') {
      if (entry.candidate_count < 5 || entry.candidate_count > 7 || entry.cache_reviewed !== true) problems.push('bol_related_terms must confirm 5–7 terms and an exact-string Boloo PASS cache review');
    }
    if (key === 'other_confirmed_candidate_sources' && (!Array.isArray(entry.sources) || entry.sources.some(source => !source?.source_id || source.complete !== true || !Number.isInteger(source.candidate_count) || source.candidate_count < 0))) {
      problems.push('other_confirmed_candidate_sources must list each additional confirmed source, or an empty sources array');
    }
    if (key === 'other_confirmed_candidate_sources' && Array.isArray(entry.sources) && entry.sources.reduce((sum, source) => sum + (Number(source.candidate_count) || 0), 0) !== entry.candidate_count) problems.push('other_confirmed_candidate_sources candidate_count must equal the sum of listed sources');
  }
  for (const key of Object.keys(sources)) if (!BOLOO_DISCOVERY_SOURCES.includes(key)) problems.push(`unknown discovery source key: ${key}`);
  const candidates = task.boloo?.candidates || [];
  for (const key of BOLOO_DISCOVERY_SOURCES.filter(name => name !== 'other_confirmed_candidate_sources')) {
    const origins = BOLOO_SOURCE_ORIGINS[key] || [key];
    const observed = candidates.filter(candidate => candidate.origin_sources?.some(origin => origins.includes(origin))).length;
    if (sources[key]?.complete === true && sources[key].candidate_count !== observed) problems.push(`${key} candidate_count does not match persisted exact-string candidates (${observed})`);
  }
  const extraSourceIds = sources.other_confirmed_candidate_sources?.sources || [];
  for (const source of extraSourceIds) {
    const observed = candidates.filter(candidate => candidate.origin_sources?.includes(source.source_id)).length;
    if (source.candidate_count !== observed) problems.push(`${source.source_id} candidate_count does not match persisted exact-string candidates (${observed})`);
  }
  if (closeEvidence?.candidate_queue_empty !== true || candidates.some(candidate => candidate.candidate_status === 'ACTIVE')) problems.push('candidate queue must be explicitly empty with no ACTIVE candidates');
  return problems;
}

function isAcceptanceBolooFixture(dataRoot, task) {
  return acceptanceMode(dataRoot) && task.master?.product_facts?.acceptance_fixture === true;
}

async function waitForBolooDiscovery(dataRoot, task, eventType = 'BOLOO_DISCOVERY_WAITING_FOR_MORE_CANDIDATES') {
  task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null, keyword_discovery_closed: false, discovery_close_evidence: null };
  task.boloo.current_subtask_id = null;
  task.boloo.current_source_id = null;
  task.status = 'WAITING_DISCOVERY_INPUT';
  task.resume_point = 'boloo_keywords';
  task.activity_pool = '关键词池';
  task.current_pool = task.activity_pool;
  task.stage_qa_status = task.qa?.boloo_keywords?.status || 'NOT_RUN';
  task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'WAITING_DISCOVERY_INPUT', updated_at: iso() };
  task.error_code = null;
  task.error_message = null;
  await commit(dataRoot, task, eventType, {
    step: 'boloo_keywords', required_count: task.boloo.required_subtasks.length,
    completed_count: task.boloo.required_subtasks.filter(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status)).length,
    keyword_discovery_closed: task.boloo.keyword_discovery_closed === true,
  });
  return task;
}

const LAST = STEPS.at(-1)[0];
const iso = () => new Date().toISOString();
const cleanText = value => String(value ?? '').trim();
const clone = value => structuredClone(value);
const locks = new Map();
let database = null;
let databaseRoot = '';
const initializedRoots = new Set();
const initializingRoots = new Map();
let bolRetailerClient = null;
let bolRetailerClientRoot = '';
let top20ExecutorReady = true;
let listingCompetitorExecutorReady = true;

export function setTop20ExecutorReady(ready) {
  top20ExecutorReady = ready === true;
  return { TOP20_EXECUTOR_READY: top20ExecutorReady };
}

function isTop20ExecutorReady() {
  const override = readinessOverride('TOP20_EXECUTOR_READY');
  return typeof override === 'boolean' ? override : top20ExecutorReady;
}

export function setListingCompetitorExecutorReady(ready) {
  listingCompetitorExecutorReady = ready === true;
  return { LISTING_COMPETITOR_EXECUTOR_READY: listingCompetitorExecutorReady };
}

function isListingCompetitorExecutorReady() {
  const override = readinessOverride('LISTING_COMPETITOR_EXECUTOR_READY');
  return typeof override === 'boolean' ? override : listingCompetitorExecutorReady;
}

function bolClientFor(dataRoot) {
  const root = path.resolve(dataRoot);
  if (bolRetailerClient && root !== bolRetailerClientRoot) throw Object.assign(new Error('BOL API 缓存不能切换数据根目录。'), { code: 'DATA_ROOT_SWITCH_BLOCKED' });
  if (!bolRetailerClient) {
    bolRetailerClientRoot = root;
    bolRetailerClient = new BolRetailerClient({ dataRoot: root });
  }
  return bolRetailerClient;
}

const EXECUTION_DEPENDENCY_FOR_STEP = Object.freeze({ bol_keywords: 'BOL_API', LISTING_SOP_04: 'BOL_API', boloo_keywords: 'BOLOO_PROVIDER', top20: 'TOP20_EXECUTOR', LISTING_SOP_07: 'TOP20_EXECUTOR' });
const BOL_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER_HEALTH_FILE = path.join(BOL_PROJECT_ROOT, 'BOL数据', 'integrations', 'provider-health.json');

export function parseProviderHealthSnapshot(jsonText) {
  return JSON.parse(String(jsonText).replace(/^\uFEFF/, ''));
}

export function listingExecutionDependencyForTask(task) {
  if (task?.current_step === 'LISTING_SOP_06') return 'BOLOO_WEBVIEW2_PANE';
  if (task?.current_step === 'LISTING_SOP_09') return null;
  if (task?.current_step === 'LISTING_SOP_08') {
    return task.listing_executor?.artifacts?.sop08_execution?.phase === 'REMOTE_SUPPLEMENT' ? 'BOL_API' : null;
  }
  if (Object.hasOwn(SOP10_17_EXECUTOR_IDS, task?.current_step) && ['QWEN', 'DEEPSEEK', 'AI_PROVIDER_ADAPTER'].includes(task?.waiting_dependency_key)) return task.waiting_dependency_key;
  const registryEntry = task?.listing_executor?.registry?.[task?.current_step];
  return EXECUTION_DEPENDENCY_FOR_STEP[task?.current_step] || registryEntry?.required_dependencies?.[0] || null;
}

export function isSop06PaneDependencyReadyForContinue({ expectedDependency, paneReadiness, officialWebReady }) {
  return expectedDependency === 'BOLOO_WEBVIEW2_PANE'
    && paneReadiness?.status === 'READY'
    && officialWebReady === true;
}

export function evaluateSop06PaneResumePreflight({ task, sku, expectedRevision, activeLeaseCount,
  runtimeMode, acceptanceModeEnabled, acceptanceHold, manualContinueRequired, manualContinueSku,
  paneReadiness, officialWebReady }) {
  const checks = {
    runtime: runtimeMode === 'NORMAL' && acceptanceModeEnabled === true && acceptanceHold === false,
    explicit_scope: manualContinueRequired === true && manualContinueSku === sku && task?.sku === sku,
    revision: Number.isInteger(Number(expectedRevision)) && Number(task?.revision) === Number(expectedRevision),
    task_state: task?.status === 'WAITING_DEPENDENCY' && task?.current_step === 'LISTING_SOP_06'
      && task?.resume_point === 'LISTING_SOP_06' && task?.waiting_dependency_key === 'BOLOO_WEBVIEW2_PANE'
      && task?.last_success_step === 'LISTING_SOP_05' && task?.qa?.LISTING_SOP_06?.status === 'NOT_RUN'
      && Number(task?.open_error_count || 0) === 0,
    no_active_lease: Number(activeLeaseCount) === 0,
    pane_and_bridge: isSop06PaneDependencyReadyForContinue({
      expectedDependency: task?.waiting_dependency_key, paneReadiness, officialWebReady,
    }),
    pane_recovery_gate: evaluateSop06PaneRecoveryReadiness({ task, paneReadiness, officialWebReady }).allowed,
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([key]) => key);
  return { allowed: failed.length === 0, checks, failed };
}

export async function readFreshBolooPaneRuntimeReadiness() {
  try {
    // Windows PowerShell 5.1's default UTF-8 JSON writer emits a BOM. Node's
    // JSON.parse rejects that leading U+FEFF, so accept either valid UTF-8
    // representation at this cross-runtime health-file boundary.
    const health = parseProviderHealthSnapshot(await fs.readFile(PROVIDER_HEALTH_FILE, 'utf8'));
    const pane = health?.runtime_components?.BOLOO_WEBVIEW2_PANE;
    const checkedAt = Date.parse(String(pane?.checked_at_utc || health?.checked_at_utc || ''));
    const ageMs = Date.now() - checkedAt;
    const checks = pane?.checks || {};
    const alive = Number.isInteger(Number(pane?.pid)) && Number(pane.pid) > 0
      && (() => { try { process.kill(Number(pane.pid), 0); return true; } catch (error) { return error?.code === 'EPERM'; } })();
    const identityReady = pane?.readiness === 'READY' && alive
      && ['webview2', 'explorer', 'login', 'bridge'].every(key => checks[key] === true);
    const fresh = Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= 15 * 60_000;
    return { status: identityReady && fresh ? 'READY' : 'NOT_READY', pane_pid: Number(pane?.pid) || null,
      pane_process_started_at: pane?.process_started_at_utc || pane?.process_started_at || null,
      bridge_status: checks.bridge === true ? 'READY' : 'NOT_READY', explorer_status: checks.explorer === true ? 'READY' : 'NOT_READY',
      webview2_status: checks.webview2 === true ? 'READY' : 'NOT_READY', login_status: checks.login === true ? 'READY' : 'NOT_READY',
      checked_at: pane?.checked_at_utc || health?.checked_at_utc || null, health_checked_at: health?.checked_at_utc || null,
      source: PROVIDER_HEALTH_FILE, evidence_status: identityReady && fresh ? 'FRESH' : 'WAITING_DEPENDENCY' };
  } catch {
    return { status: 'NOT_READY', pane_pid: null, bridge_status: 'NOT_READY', explorer_status: 'NOT_READY',
      checked_at: null, source: PROVIDER_HEALTH_FILE, evidence_status: 'MISSING_OR_INVALID' };
  }
}

function latestPersistedSop06PaneTimeoutFailure(task) {
  const rows = task?.listing_sop?.sop06_keyword_queries?.required_subtasks || [];
  const failures = [];
  for (const row of rows) {
    const history = Array.isArray(row.provider_history) ? row.provider_history : [];
    let lastSuccessIndex = -1;
    for (let index = 0; index < history.length; index += 1) {
      if (history[index]?.status === 'PASS' || history[index]?.status === 'PASS_NO_RESULT') lastSuccessIndex = index;
    }
    for (const item of history.slice(lastSuccessIndex + 1)) {
      const message = [item?.error_message, item?.error?.message, item?.provider_result?.error_message, item?.provider_result?.error?.message]
        .filter(value => typeof value === 'string').join('\n');
      const code = item?.reason_code || item?.error_code || item?.provider_result?.reason_code || item?.provider_result?.error_code || '';
      const isPaneTimeout = ['BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT'].includes(code)
        || /Timed out waiting for Boloo WebView2 NavigationCompleted/i.test(message)
        || /Timed out waiting for (?:a response from the shared |the real )Boloo WebView2 Pane/i.test(message);
      if (!isPaneTimeout) continue;
      const at = item?.observed_at || item?.observed_at_utc || item?.failed_at || null;
      if (Number.isFinite(Date.parse(String(at || '')))) failures.push({ at, request_id: item.request_id || null, exact_string: row.exact_string, reason_code: code || 'LEGACY_PANE_TIMEOUT' });
    }
  }
  failures.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return failures.at(-1) || null;
}

/**
 * Process liveness and bridge health alone are insufficient after a real
 * NavigationCompleted timeout. Require a Pane process incarnation that began
 * after that failure; repeated aggregate READY snapshots from the same hung
 * WebView must never re-dispatch the same exact-string request.
 */
export function evaluateSop06PaneRecoveryReadiness({ task, paneReadiness, officialWebReady, cacheOnly = false }) {
  if (cacheOnly) return { allowed: true, source: 'KEYWORD_LIBRARY_CACHE_ONLY', reason: null };
  if (!isSop06PaneDependencyReadyForContinue({
    expectedDependency: task?.waiting_dependency_key, paneReadiness, officialWebReady,
  })) return { allowed: false, source: 'PANE_RUNTIME', reason: 'PANE_OR_BRIDGE_NOT_READY' };

  const explicit = task?.sop06_pane_recovery_context;
  if (explicit?.exact_string) {
    const operationKey = buildSop06OperationKey({ sku: task?.sku, exactString: explicit.exact_string });
    const circuit = task?.sop06_operation_circuits?.[operationKey];
    if (circuit?.state === 'OPEN') return { allowed: false, source: 'SOP06_OPERATION_CIRCUIT', reason: 'OPERATION_CIRCUIT_OPEN',
      operation_key: operationKey, failure_count: circuit.failure_count };
    if (circuit?.state === 'WAITING_RECOVERY_EVIDENCE') {
      const recovery = buildSop06OperationRecoveryEvidence({ circuit, paneReadiness, officialWebReady });
      if (!recovery.allowed) return { allowed: false, source: 'SOP06_OPERATION_CIRCUIT', reason: recovery.reason,
        operation_key: operationKey, failure_count: circuit.failure_count };
    }
    if (circuit && !['CLOSED', 'WAITING_RECOVERY_EVIDENCE', 'RECOVERY_AUTHORIZED'].includes(circuit.state)) {
      return { allowed: false, source: 'SOP06_OPERATION_CIRCUIT', reason: 'OPERATION_CIRCUIT_STATE_INVALID', operation_key: operationKey };
    }
  }
  const legacyFailure = latestPersistedSop06PaneTimeoutFailure(task);
  const needsPaneRestart = ['BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT'].includes(explicit?.reason_code)
    || ['BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT', 'LEGACY_PANE_TIMEOUT'].includes(legacyFailure?.reason_code);
  const failedAt = explicit && needsPaneRestart
    ? (explicit.dependency_failed_at || explicit.required_readiness_after)
    : legacyFailure?.at;
  if (!failedAt) return { allowed: true, source: 'PANE_RUNTIME', reason: null };

  const failureMs = Date.parse(String(failedAt));
  const checkedMs = Date.parse(String(paneReadiness?.checked_at || ''));
  const paneStartedMs = Date.parse(String(paneReadiness?.pane_process_started_at || ''));
  if (!Number.isFinite(failureMs) || !Number.isFinite(checkedMs) || checkedMs <= failureMs) {
    return { allowed: false, source: 'PANE_RUNTIME', reason: 'READINESS_NOT_AFTER_NAVIGATION_FAILURE', failed_at: failedAt };
  }
  if (!Number.isFinite(paneStartedMs) || paneStartedMs <= failureMs) {
    return { allowed: false, source: 'PANE_PROCESS_RESTART_REQUIRED', reason: 'SAME_PANE_INCARNATION_AFTER_PROVIDER_TIMEOUT', failed_at: failedAt,
      failed_request_id: explicit?.request_id || legacyFailure?.request_id || null,
      failed_pane_pid: explicit?.failed_pane?.pid ?? null, current_pane_pid: paneReadiness?.pane_pid ?? null };
  }
  const failedPane = explicit?.failed_pane;
  if (failedPane?.process_started_at && failedPane.process_started_at === paneReadiness.pane_process_started_at) {
    return { allowed: false, source: 'PANE_PROCESS_RESTART_REQUIRED', reason: 'PANE_PROCESS_IDENTITY_UNCHANGED', failed_at: failedAt,
      failed_request_id: explicit.request_id || null, failed_pane_pid: failedPane.pid ?? null, current_pane_pid: paneReadiness?.pane_pid ?? null };
  }
  return { allowed: true, source: 'PANE_PROCESS_RESTART_AFTER_NAVIGATION_FAILURE', reason: null, failed_at: failedAt,
    failed_request_id: explicit?.request_id || legacyFailure?.request_id || null,
    current_pane_pid: paneReadiness?.pane_pid ?? null, current_pane_process_started_at: paneReadiness?.pane_process_started_at || null };
}

export function getActiveListingExecutionLeaseCount(dataRoot, sku, step = null) {
  const id = productId(sku);
  const query = step
    ? "SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND step=? AND state='RUNNING'"
    : "SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'";
  // HOLD disables the normal database accessor because it also performs
  // guarded schema setup/migrations. Lease inspection is read-only and is
  // required by manual, non-dispatch preflights, so use a query-only handle
  // instead. If the store/table cannot be read, fail closed rather than
  // treating an unknown lease state as zero.
  let database = null;
  const closeAfterRead = !TASK_AUTO_MUTATION_ENABLED;
  if (closeAfterRead) {
    const databaseFile = path.join(dataRoot, 'bol.sqlite3');
    database = new DatabaseSync(databaseFile, { readOnly: true });
    database.exec('PRAGMA query_only=ON');
  } else database = dbFor(dataRoot);
  try {
    const row = step ? database.prepare(query).get(id, step) : database.prepare(query).get(id);
    return Number(row?.n || 0);
  } finally {
    if (closeAfterRead) database.close();
  }
}

function sop03Passed(task) {
  const step = task.listing_executor?.registry?.LISTING_SOP_03;
  return step?.status === 'PASS' && step?.qa_status === 'PASS'
    && task.listing_sop?.steps?.LISTING_SOP_03?.status === 'PASS'
    && task.qa?.LISTING_SOP_03?.status === 'PASS';
}

/** Pure preflight contract shared by dependency recovery and step dispatch. */
export function evaluateListingExecutionPreflight(task, {
  dependencyReady = true,
  executorAvailable = true,
} = {}) {
  const step = task?.current_step;
  const registryEntry = task?.listing_executor?.registry?.[step];
  const expectedDependency = listingExecutionDependencyForTask(task);
  if (expectedDependency && dependencyReady !== true) {
    return { ready: false, status: 'WAITING_DEPENDENCY', dependency: expectedDependency, reason: `依赖 ${expectedDependency} 尚未 READY。`, check: 'DEPENDENCY' };
  }

  const missingInputs = [];
  for (const inputId of registryEntry?.required_inputs || []) {
    if (/^LISTING_SOP_\d{2}$/.test(inputId)) {
      if (inputId === 'LISTING_SOP_02') {
        if (task.qa?.LISTING_SOP_02?.status !== 'PASS' || task.outputs?.confirmed_product_facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION') missingInputs.push(inputId);
      } else {
        const upstream = task.listing_executor?.registry?.[inputId];
        if (upstream?.status !== 'PASS' || upstream?.qa_status !== 'PASS') missingInputs.push(`${inputId}:PASS+QA_PASS`);
      }
    } else if (inputId === 'CONFIRMED_PRODUCT_FACTS_VERSION') {
      const facts = task.outputs?.confirmed_product_facts;
      if (facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || !Number.isInteger(Number(facts.version))) missingInputs.push(inputId);
    } else if (inputId === 'CONFIRMED_DUTCH_MARKET_TERMS') {
      const sources = task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
      if (!sources.some(source => source.status === 'PASS' && Array.isArray(source.exact_strings) && source.exact_strings.length)) missingInputs.push(inputId);
    }
  }
  if (step === 'LISTING_SOP_04') {
    if (!sop03Passed(task)) missingInputs.push('LISTING_SOP_03:PASS+QA_PASS');
    const facts = task.outputs?.confirmed_product_facts;
    if (facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || !Number.isInteger(Number(facts.version))) missingInputs.push('CONFIRMED_PRODUCT_FACTS_VERSION');
    const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version || task.listing_sop?.steps?.LISTING_SOP_03?.output_version;
    if (sop03Version == null || String(sop03Version).trim() === '') missingInputs.push('SOP03_SOURCE_DISCOVERY_VERSION');
  }
  if (missingInputs.length) {
    return { ready: false, status: 'WAITING_DEPENDENCY', dependency: 'LISTING_REQUIRED_INPUTS', reason: `缺少必需输入/版本：${[...new Set(missingInputs)].join(', ')}`, check: 'REQUIRED_INPUTS', missing_inputs: [...new Set(missingInputs)] };
  }

  const unresolved = (task.listing_executor?.waiting_items || []).filter(item => !item.decided_at && item.originating_sop_step === step);
  if (task.confirmation?.status === 'OPEN') {
    return { ready: false, status: 'WAITING_CONFIRMATION', reason: '当前步骤仍有待人工确认事项。', check: 'WAITING_CONFIRMATION' };
  }
  if (unresolved.some(item => item.type === 'WAITING_CONFIRMATION')) {
    return { ready: false, status: 'WAITING_CONFIRMATION', reason: '当前步骤仍有未关闭的 WAITING_CONFIRMATION。', check: 'WAITING_CONFIRMATION' };
  }
  if (unresolved.some(item => item.type === 'WAITING_DECISION')) {
    return { ready: false, status: 'WAITING_DECISION', reason: '当前步骤仍有未解决的 WAITING_DECISION。', check: 'WAITING_DECISION' };
  }

  if (executorAvailable !== true) {
    return { ready: false, status: 'WAITING_DEPENDENCY', dependency: `LISTING_EXECUTOR:${step}`, reason: `步骤执行器 ${step} 尚未连接。`, check: 'EXECUTOR' };
  }

  const missingDeclaredParameters = (registryEntry?.required_parameters || []).filter(parameter => {
    const value = String(parameter).split('.').reduce((current, key) => current?.[key], task);
    return value === undefined || value === null || value === '';
  });
  if (missingDeclaredParameters.length) {
    return { ready: false, status: 'WAITING_DECISION', reason: `缺少当前步骤必需参数：${missingDeclaredParameters.join(', ')}`, check: 'STEP_PARAMETERS', missing_parameters: missingDeclaredParameters };
  }

  if (step === 'LISTING_SOP_04') {
    const seed = task.sop04_seed_selection?.exact_string;
    const sources = task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
    const matchingSource = sources.find(source => source.status === 'PASS' && (source.exact_strings || []).some(item =>
      (typeof item === 'string' ? item : String(item?.keyword ?? '').trim()) === seed));
    const confirmed = Boolean(matchingSource);
    const selectedSourceRefs = task.sop04_seed_selection?.source_refs || [];
    const refsMatch = confirmed && selectedSourceRefs.some(ref => ref.source_id === matchingSource.source_id
      && String(ref.result_version) === String(matchingSource.result_version));
    if (!seed || /[\u3400-\u9fff]/.test(seed) || !confirmed || !refsMatch) {
      return { ready: false, status: 'WAITING_DECISION', reason: '缺少已确认的荷兰语 SOP03 exact string 作为本 SKU Search Terms seed。', check: 'STEP_PARAMETERS', missing_parameters: ['search_terms_seed'] };
    }
  }
  return { ready: true, status: 'READY', step, dependency: expectedDependency };
}

export function prepareSop04RelatedTermSelection(rawTerms, seed) {
  const seen = new Set();
  const candidateTerms = [];
  for (const term of Array.isArray(rawTerms) ? rawTerms : []) {
    const exact = typeof term?.searchTerm === 'string' ? term.searchTerm : '';
    if (!exact || seen.has(exact)) continue;
    seen.add(exact);
    candidateTerms.push({ exact_string: exact, source_seed_exact_string: seed });
  }
  const inAllowedRange = candidateTerms.length >= 5 && candidateTerms.length <= 7;
  return {
    candidateTerms,
    adoptedTerms: inAllowedRange ? structuredClone(candidateTerms) : [],
    decisionCode: candidateTerms.length < 5 ? 'INSUFFICIENT_RELATED_TERMS'
      : candidateTerms.length > 7 ? 'SELECT_5_TO_7_RELATED_TERMS' : null,
    selectorUsed: false,
  };
}

export function prepareSop04SupplementalCandidates(rawTerms, seed, confirmedExactStrings = [], excludedExactStrings = []) {
  const parsed = prepareSop04RelatedTermSelection(rawTerms, seed);
  const confirmed = [...new Set((Array.isArray(confirmedExactStrings) ? confirmedExactStrings : []).filter(value => typeof value === 'string'))];
  const excluded = new Set((Array.isArray(excludedExactStrings) ? excludedExactStrings : []).filter(value => typeof value === 'string'));
  const confirmedSet = new Set(confirmed);
  const newCandidateExactStrings = parsed.candidateTerms.map(item => item.exact_string)
    .filter(value => !confirmedSet.has(value) && !excluded.has(value));
  const combinedCandidateExactStrings = [...confirmed, ...newCandidateExactStrings];
  return {
    candidateTerms: parsed.candidateTerms,
    newCandidateExactStrings,
    combinedCandidateExactStrings,
    confirmedExactStrings: confirmed,
    decisionCode: combinedCandidateExactStrings.length >= 5 ? 'SELECT_5_TO_7_RELATED_TERMS' : 'INSUFFICIENT_RELATED_TERMS',
    selectorUsed: false,
  };
}

function acceptanceMode(dataRoot) {
  return process.env.BOL_ACCEPTANCE_MODE === '1'
    && path.resolve(dataRoot).toLowerCase().includes(`${path.sep}bol数据${path.sep}验收e2e`)
    && path.resolve(dataRoot).toLowerCase().startsWith(`${path.join(BOL_PROJECT_ROOT, 'BOL数据').toLowerCase()}${path.sep}`);
}

/** Execute only one operator-authorized acceptance SKU action with global
 * dispatch/resume/probe/mutation flags remaining disabled. */
export async function withAcceptanceManualContinueScope(dataRoot, sku, action, operation) {
  const id = productId(sku);
  const policy = getEffectiveRuntimePolicy();
  const allowed = isManualContinueScopeAllowed({ runtimePolicy: policy, env: process.env,
    action, sku: id, manualContinueSku: policy.manual_continue_sku,
    acceptanceDataRoot: acceptanceMode(dataRoot) });
  if (!allowed || typeof operation !== 'function') {
    throw Object.assign(new Error('Manual Continue scope is not authorized for this acceptance SKU and data root.'), {
      code: 'ACCEPTANCE_MANUAL_CONTINUE_SCOPE_REJECTED',
    });
  }
  const scopedOperation = () => acceptanceRecoveryControlScope.run({
    sku: id, action, acceptance_data_root: true, manual_continue_scope: true,
  }, operation);
  if (['continue', 'sop06-pane-resume'].includes(String(action))) {
    return withAcceptanceManualContinueDispatchScope({ sku: id, dataRoot, action }, scopedOperation);
  }
  return scopedOperation();
}

/** Narrow HOLD-time scope for reconciling a persisted SOP06 success with its parent and library. */
export async function withAcceptanceSop06CheckpointReconciliationScope(dataRoot, sku, operation) {
  const id = productId(sku);
  const policy = getEffectiveRuntimePolicy();
  if (typeof operation !== 'function' || !ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL'
    || process.env.BOL_ACCEPTANCE_MODE !== '1' || policy.runtime_policy_status !== 'VALID'
    || !acceptanceMode(dataRoot) || !id) {
    throw Object.assign(new Error('SOP06 checkpoint reconciliation is restricted to NORMAL acceptance HOLD with the matching isolated data root.'), {
      code: 'SOP06_CHECKPOINT_RECONCILIATION_SCOPE_REJECTED',
    });
  }
  return acceptanceRecoveryControlScope.run({ sku: id, action: 'RECONCILE_SOP06_SUCCESS_CHECKPOINT', acceptance_data_root: true }, operation);
}

/** Consume one exact-string Pane recovery authorization immediately before its single retry dispatch. */
export async function consumeSop06OperationRecoveryEvidence(dataRoot, sku, exactString) {
  const id = productId(sku);
  const operationKey = buildSop06OperationKey({ sku: id, exactString });
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task || task.current_step !== 'LISTING_SOP_06' || task.status !== 'RUNNING'
      || task.listing_sop?.sop06_keyword_queries?.status !== 'RUNNING'
      || task.sop06_pane_recovery_context?.exact_string !== exactString) {
      throw Object.assign(new Error('SOP06 exact-string recovery execution context is not active.'), { code: 'SOP06_OPERATION_RECOVERY_CONTEXT_MISMATCH' });
    }
    const circuit = task.sop06_operation_circuits?.[operationKey];
    const block = operationCircuitBlocksSop06Dispatch(circuit, exactString, id);
    if (block.blocked || circuit?.state !== 'RECOVERY_AUTHORIZED'
      || circuit.recovery_evidence?.status !== 'AVAILABLE'
      || circuit.recovery_evidence?.operation_key !== operationKey
      || circuit.recovery_evidence?.exact_string !== exactString) {
      throw Object.assign(new Error('SOP06 operation recovery evidence is absent, stale, or already consumed.'), {
        code: 'SOP06_OPERATION_RECOVERY_EVIDENCE_REQUIRED', details: { operation_key: operationKey, reason: block.reason || 'RECOVERY_EVIDENCE_INVALID' },
      });
    }
    circuit.state = 'RECOVERY_IN_PROGRESS';
    circuit.recovery_evidence = { ...circuit.recovery_evidence, status: 'CONSUMED', consumed_at: iso() };
    circuit.updated_at = iso();
    await commit(dataRoot, task, 'SOP06_OPERATION_RECOVERY_EVIDENCE_CONSUMED', {
      operation_key: operationKey, exact_string: exactString,
      evidence_id: circuit.recovery_evidence.evidence_id, failure_count: circuit.failure_count,
      dispatch_allowance: 'ONE_PROVIDER_ATTEMPT',
    });
    return { task: await readTask(dataRoot, id), operation_key: operationKey,
      evidence_id: circuit.recovery_evidence.evidence_id, consumed: true };
  });
}

/**
 * Acceptance-only execution stop. The caller persists the returned checkpoint
 * through the normal task commit path; production mode never opts into it.
 */
export function applyAcceptanceStopAfterStep(task, {
  enabled = false,
  configuredStep = '',
  acceptedAt = null,
} = {}) {
  if (enabled !== true || typeof configuredStep !== 'string' || configuredStep !== task?.current_step) return null;
  const stepIndex = LISTING_SOP_STEPS.findIndex(item => item.id === configuredStep);
  if (stepIndex < 0) return null;
  const nextStep = LISTING_SOP_STEPS[stepIndex + 1]?.id || (configuredStep === 'LISTING_SOP_17' ? 'await_upload' : null);
  if (!nextStep) return null;
  if (task.qa?.[configuredStep]?.status !== 'PASS' || task.last_success_step !== configuredStep) return null;
  task.acceptance_stop_gate = {
    status: 'PAUSED',
    stopped_after_step: configuredStep,
    resume_point: nextStep,
    stopped_at: acceptedAt || new Date().toISOString(),
  };
  task.status = 'PAUSED';
  task.resume_point = nextStep;
  task.waiting_dependency_key = null;
  return { event_name: 'ACCEPTANCE_STOP_AFTER_STEP', stopped_after_step: configuredStep, resume_point: nextStep };
}

/** Resolve the one permitted continue path after an acceptance stop. */
export function acceptanceStopResumeStep(task) {
  const gate = task?.acceptance_stop_gate;
  if (gate?.status !== 'PAUSED'
    || gate.stopped_after_step !== task?.current_step
    || task?.qa?.[gate.stopped_after_step]?.status !== 'PASS'
    || task?.last_success_step !== gate.stopped_after_step
    || task?.resume_point !== gate.resume_point) return null;
  const stoppedIndex = LISTING_SOP_STEPS.findIndex(item => item.id === gate.stopped_after_step);
  return stoppedIndex >= 0 && (LISTING_SOP_STEPS[stoppedIndex + 1]?.id === gate.resume_point
    || (gate.stopped_after_step === 'LISTING_SOP_17' && gate.resume_point === 'await_upload'))
    ? gate.resume_point : null;
}

export function releaseAcceptanceStop(task, { resumedAt = null } = {}) {
  const resumeStep = acceptanceStopResumeStep(task);
  if (!resumeStep) return null;
  task.acceptance_stop_gate = { ...task.acceptance_stop_gate, status: 'RESUMED', resumed_at: resumedAt || new Date().toISOString() };
  task.current_step = resumeStep;
  task.resume_point = resumeStep;
  if (task.listing_sop) task.listing_sop.current_step_id = resumeStep;
  return resumeStep;
}

export function nextWorkflowStep(step) {
  const listingIndex = LISTING_SOP_STEPS.findIndex(item => item.id === step);
  if (listingIndex >= 0) return LISTING_SOP_STEPS[listingIndex + 1]?.id || 'await_upload';
  const index = STEPS.findIndex(item => item[0] === step);
  if (index < 0) throw Object.assign(new Error('Unknown workflow step; refusing to return to the first step.'), { code: 'WORKFLOW_STEP_UNKNOWN' });
  return STEPS[index + 1]?.[0] || 'await_upload';
}

function dbFor(dataRoot) {
  assertCoreDispatchEnabled('Workbench task database access');
  const root = path.resolve(dataRoot);
  if (database && root !== databaseRoot) throw Object.assign(new Error('同一后台进程不能切换 BOL 数据根目录。'), { code: 'DATA_ROOT_SWITCH_BLOCKED' });
  if (!database) {
    databaseRoot = root;
    database = new DatabaseSync(path.join(root, 'bol.sqlite3'));
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        activity_pool TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        current_step TEXT,
        stage_qa_status TEXT,
        error_code TEXT,
        error_message TEXT,
        resume_point TEXT,
        last_success_step TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_versions (
        sku TEXT NOT NULL,
        version INTEGER NOT NULL,
        at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (sku, version),
        FOREIGN KEY (sku) REFERENCES products(sku)
      );
      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        sku TEXT NOT NULL,
        type TEXT NOT NULL,
        current_step TEXT,
        pool TEXT,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_events_sku_seq ON task_events(sku, seq);
      CREATE TABLE IF NOT EXISTS uploaded_finals (
        sku TEXT PRIMARY KEY,
        archived_at TEXT NOT NULL,
        upload_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY (sku) REFERENCES products(sku)
      );
      CREATE TABLE IF NOT EXISTS competitor_research_tasks (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        revision INTEGER NOT NULL,
        current_pool TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS competitor_research_sku_updated ON competitor_research_tasks(sku, updated_at);
      CREATE TABLE IF NOT EXISTS competitor_research_versions (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (task_id, version),
        FOREIGN KEY (task_id) REFERENCES competitor_research_tasks(id)
      );
      CREATE TABLE IF NOT EXISTS competitor_research_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        current_step TEXT NOT NULL,
        current_pool TEXT NOT NULL,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS competitor_research_events_task_seq ON competitor_research_events(task_id, seq);
    `);
    ensureListingExecutionLeaseSchema(database);
    const columns = new Set(database.prepare('PRAGMA table_info(products)').all().map(row => row.name));
    for (const [name, declaration] of [
      ['current_step', 'TEXT'], ['stage_qa_status', 'TEXT'], ['error_code', 'TEXT'], ['error_message', 'TEXT'],
      ['resume_point', 'TEXT'], ['last_success_step', 'TEXT'], ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
    ]) if (!columns.has(name)) database.exec(`ALTER TABLE products ADD COLUMN ${name} ${declaration}`);
  }
  return database;
}

function serialize(key, fn) {
  assertCoreDispatchEnabled('Serialized business task mutation', { serializedKey: key });
  const prior = locks.get(key) || Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  const tracked = next.catch(() => {});
  next.finally(() => { if (locks.get(key) === tracked) locks.delete(key); }).catch(() => {});
  locks.set(key, tracked);
  return next;
}

function taskFile(dataRoot, id) { return path.join(dataRoot, 'products', `${id}.json`); }
function productId(sku) {
  const value = cleanText(sku);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw Object.assign(new Error('SKU 格式错误：只允许字母、数字、点、下划线和短横线。'), { code: 'SKU_INVALID' });
  return value;
}

async function atomicJson(file, value) {
  await writeAtomicJson(file,value);
}

async function appendEvent(dataRoot, task, type, details = {}) {
  const activeScope = acceptanceRecoveryControlScope.getStore();
  if (manualContinueScopeIsLive(activeScope)) {
    assertCoreDispatchEnabled('Task event append', { taskSku: task?.sku });
  }
  const event = { event_id: crypto.randomUUID(), at: iso(), sku: task.sku, type, current_step: task.current_step, pool: task.activity_pool, details };
  await fs.mkdir(path.join(dataRoot, 'events'), { recursive: true });
  const db = dbFor(dataRoot);
  db.prepare('INSERT INTO task_events (event_id, at, sku, type, current_step, pool, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(event.event_id, event.at, event.sku, event.type, event.current_step, event.pool, JSON.stringify(event.details));
  await serialize('__event_log__', () => fs.appendFile(path.join(dataRoot, 'events', 'tasks.jsonl'), `${JSON.stringify(event)}\n`, 'utf8'));
  return event;
}

async function commit(dataRoot, task, type, details = {}, { expectedRevision = null } = {}) {
  assertCoreDispatchEnabled('Listing task state mutation', { commitEventType: type, taskSku: task?.sku });
  syncTaskContract(task);
  syncListingExecutorFramework(task, LISTING_SOP_STEPS);
  const priorRevision = Number(task.revision);
  if (expectedRevision !== null) assertTaskRevisionCAS(expectedRevision, priorRevision);
  task.updated_at = iso();
  task.revision += 1;
  const db = dbFor(dataRoot);
  const event = { event_id: crypto.randomUUID(), at: task.updated_at, sku: task.sku, type, current_step: task.current_step, pool: task.activity_pool, details };
  const productWrite = db.prepare(`INSERT INTO products (sku, revision, activity_pool, status, updated_at, current_step, stage_qa_status, error_code, error_message, resume_point, last_success_step, retry_count, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET revision=excluded.revision, activity_pool=excluded.activity_pool, status=excluded.status, updated_at=excluded.updated_at,
      current_step=excluded.current_step, stage_qa_status=excluded.stage_qa_status, error_code=excluded.error_code, error_message=excluded.error_message,
      resume_point=excluded.resume_point, last_success_step=excluded.last_success_step, retry_count=excluded.retry_count, payload=excluded.payload`);
  const versionWrite = db.prepare('INSERT INTO product_versions (sku, version, at, payload) VALUES (?, ?, ?, ?)');
  const eventWrite = db.prepare('INSERT INTO task_events (event_id, at, sku, type, current_step, pool, details) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const persistedRow = db.prepare('SELECT payload FROM products WHERE sku=?').get(task.sku);
    if (expectedRevision !== null) {
      const actualRevision = persistedRow ? Number(JSON.parse(persistedRow.payload)?.revision) : null;
      if (actualRevision !== Number(expectedRevision)) assertTaskRevisionCAS(expectedRevision, actualRevision);
    }
    if (persistedRow) {
      const persistedTask = JSON.parse(persistedRow.payload);
      if (persistedTask.final_archive && JSON.stringify(persistedTask.final_archive) !== JSON.stringify(task.final_archive)) {
        throw Object.assign(new Error('Final 存档已锁定；不允许覆盖或清除。'), { code: 'FINAL_VERSION_LOCKED' });
      }
    }
    productWrite.run(task.sku, task.revision, task.activity_pool, task.status, task.updated_at, task.current_step, task.stage_qa_status,
      task.error_code, task.error_message, task.resume_point, task.last_success_step, task.retry_count, JSON.stringify(task));
    versionWrite.run(task.sku, task.revision, task.updated_at, JSON.stringify(task));
    eventWrite.run(event.event_id, event.at, event.sku, event.type, event.current_step, event.pool, JSON.stringify(event.details));
    if (task.final_archive) db.prepare(`INSERT INTO uploaded_finals (sku, archived_at, upload_date, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(sku) DO NOTHING`)
      .run(task.sku, task.final_archive.archived_at, task.final_archive.upload_date, JSON.stringify(task.final_archive));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const versionPath = path.join(dataRoot, 'versions', task.id, `${String(task.revision).padStart(6, '0')}.json`);
  await Promise.all([
    atomicJson(taskFile(dataRoot, task.id), task),
    atomicJson(versionPath, { version: task.revision, at: task.updated_at, snapshot: task }),
    serialize('__event_log__', () => fs.appendFile(path.join(dataRoot, 'events', 'tasks.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')),
  ]);
  return task;
}

async function readTask(dataRoot, sku) {
  const id = productId(sku);
  let task = null;
  if (!TASK_AUTO_MUTATION_ENABLED) {
    // Match the dashboard's read-only behavior while HOLD/manual/readiness
    // policy disables mutations. Opening the normal DB accessor would run the
    // dispatch guard (and its migrations); a read-only connection keeps task
    // detail GET available without enabling business actions.
    const databaseFile = path.join(dataRoot, 'bol.sqlite3');
    let databaseExists = false;
    try { await fs.access(databaseFile); databaseExists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (databaseExists) {
      let readOnlyDb;
      try {
        readOnlyDb = new DatabaseSync(databaseFile, { readOnly: true });
        readOnlyDb.exec('PRAGMA query_only=ON');
        const row = readOnlyDb.prepare('SELECT payload FROM products WHERE sku=?').get(id);
        if (row) task = JSON.parse(row.payload);
      } catch (error) {
        if (!/no such table:\s*products/i.test(String(error?.message || ''))) throw error;
      } finally {
        readOnlyDb?.close();
      }
    }
  } else {
    const row = dbFor(dataRoot).prepare('SELECT payload FROM products WHERE sku=?').get(id);
    if (row) task = JSON.parse(row.payload);
  }
  if (!task) {
    try { task = JSON.parse(await fs.readFile(taskFile(dataRoot, id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  if (!acceptanceMode(dataRoot) && task.master?.product_facts?.acceptance_fixture === true) return null;
  return task;
}

function taskTemplate(raw, id) {
  const now = iso();
  const brandName = cleanText(raw.brand_name ?? raw.brand);
  const master = {
    sku: id,
    source_product_id: cleanText(raw.product_id) || null,
    ean: cleanText(raw.ean),
    name: cleanText(raw.name),
    brand_name: brandName,
    brand: brandName,
    weight_kg: raw.weight_kg === '' || raw.weight_kg == null ? null : Number(raw.weight_kg),
    weight_unit: 'kg',
    source_refs: Array.isArray(raw.source_refs) ? raw.source_refs.map(cleanText).filter(Boolean) : cleanText(raw.source_refs).split(/[\n;,]/).map(cleanText).filter(Boolean),
    product_facts: typeof raw.product_facts === 'object' && raw.product_facts ? clone(raw.product_facts) : {},
    confirmed_facts: typeof raw.confirmed_facts === 'object' && raw.confirmed_facts ? clone(raw.confirmed_facts) : {},
    materials: [],
    confirmed_core_terms: (Array.isArray(raw.confirmed_core_terms) ? raw.confirmed_core_terms
      : typeof raw.confirmed_core_terms === 'string' ? raw.confirmed_core_terms.split(/[\n;]/)
        : Array.isArray(raw.product_facts?.confirmed_core_terms) ? raw.product_facts.confirmed_core_terms : [])
      .map(cleanText).filter(Boolean).slice(0, 3),
    created_at: now,
    fact_version: 1,
    excel_source_import: raw.excel_source_import ? clone(raw.excel_source_import) : null,
    competitor_urls: Array.isArray(raw.competitor_urls) ? clone(raw.competitor_urls) : [],
    competitor_url_completion: raw.competitor_url_completion ? clone(raw.competitor_url_completion) : null,
    competitor_url_list: (Array.isArray(raw.competitor_urls) ? raw.competitor_urls : []).filter(row => isValidBolProductUrl(row?.exact_url ?? row?.raw_value)).map(row => ({ source_id: `USER_${row.source_cell || row.source_header || crypto.randomUUID()}`, exact_url: String(row.exact_url ?? row.raw_value).trim(), raw_url: String(row.exact_url ?? row.raw_value), source_header: row.source_header || null, source_cell: row.source_cell || null, import_version: row.import_version || null, source: raw.excel_source_import ? 'LEON_EXCEL' : 'LEON_PRODUCT_IMPORT', origin: 'USER_INPUT', confirmed_by: 'Leon', usable_for_boloo_extractor: true })),
    competitor_source_records: [],
    competitor_candidates: [],
    competitor_discovery: { status: raw.competitor_urls?.length ? 'EXISTING_SOURCES' : 'NOT_STARTED', amazon_status: raw.product_facts?.amazon_reference ? 'EXISTING_SOURCE' : 'SOURCE_NOT_CONNECTED: AMAZON_DISCOVERY', updated_at: now },
  };
  return {
    schema_version: 1,
    id,
    sku: id,
    revision: 0,
    created_at: now,
    updated_at: now,
    master,
    current_step: 'LISTING_SOP_01',
    resume_point: 'LISTING_SOP_01',
    listing_sop: {
      version: '2026-09-22-V1.1', current_step_id: 'LISTING_SOP_01',
      steps: Object.fromEntries(LISTING_SOP_STEPS.map(({ id, label }) => [id, { label, status: 'NOT_STARTED', qa_status: 'NOT_RUN', output_version: null, updated_at: now }])),
      own_materials_snapshots: [], confirmed_product_facts_versions: [], decisions: [], stale_dependencies: [], ignored_facts: {},
      executor_registry: null,
    },
    last_success_step: null,
    retry_count: 0,
    priority: { value: 0, updated_at: now },
    status: 'QUEUED',
    activity_pool: '待处理池',
    current_pool: '待处理池',
    stage_qa_status: 'NOT_RUN',
    error_code: null,
    error_message: null,
    return_pool: null,
    issues: [],
    open_error_count: 0,
    qa: Object.fromEntries([...STEPS.map(([key]) => key), ...LISTING_SOP_STEPS.map(({ id }) => id)].map(key => [key, { status: 'NOT_RUN', checked_at: null, report: null }])),
    stages: Object.fromEntries([
      ...STEPS.map(([key, label]) => [key, { label, status: 'NOT_STARTED', updated_at: now }]),
      ...LISTING_SOP_STEPS.map(({ id, label }) => [id, { label, status: 'NOT_STARTED', updated_at: now }]),
    ]),
    listing_executor: createListingExecutorFramework(LISTING_SOP_STEPS, now),
    sidecars: {
      mabang: { job_id: `${id}:mabang:v${master.fact_version}`, input_fact_version: master.fact_version, status: 'WAITING_FOR_PRODUCT_QA', current_step: 'WAIT_PRODUCT_QA', dependency: 'PRODUCT_MASTER_QA', schema_status: 'WAITING_DECISION', export_allowed: false, weight_kg: master.weight_kg, weight_g: null, updated_at: now },
      art: { status: 'WAITING_DEPENDENCY', current_step: 'WAIT_ART_REVIEW_EXECUTOR', dependency: 'ART_REVIEW_EXECUTOR', dependency_status: 'NOT_READY', updated_at: now },
      artwork: { status: 'NOT_STARTED', images: [], suite_qa: { status: 'NOT_RUN', evidence: null }, final_confirmed_at: null, updated_at: now },
      keywords: { status: 'NOT_CONNECTED', updated_at: now },
      listing: { status: 'NOT_CONNECTED', updated_at: now },
      verification: { status: 'NOT_RUN', updated_at: now },
      upload: { status: 'NOT_READY', updated_at: now },
    },
    boloo: {
      required_subtasks: [],
      current_subtask_id: null,
      current_source_id: null,
      candidates: [],
      keyword_discovery_closed: false,
      discovery_close_evidence: null,
    },
    readiness: { TOP20_EXECUTOR_READY: true },
    final_archive: null,
    source_import_versions: raw.excel_source_import ? [{ ...clone(raw.excel_source_import), changed_fields: ['initial_import'], unchanged: false }] : [],
  };
}

function activeIssueCount(task) { return task.issues.filter(issue => issue.status !== 'CLOSED').length; }

function canonicalFact(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'object') return String(value).trim();
  if (Array.isArray(value)) return JSON.stringify(value.map(item => canonicalFact(item)));
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
}

function safeMaterialPath(dataRoot, relativePath) {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, relativePath || '');
  if (!target.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('自有资料路径越界。'), { code: 'OWN_MATERIAL_PATH_INVALID' });
  return target;
}

async function loadOwnedMaterials(dataRoot, task) {
  const materials = [];
  for (const item of task.master?.materials || []) {
    if (!OWN_SOURCE_TYPES.has(item.source_type)) {
      materials.push({ ...clone(item), excluded_reason: 'NON_OWNED_SOURCE_TYPE' });
      continue;
    }
    const file = safeMaterialPath(dataRoot, item.storage_relpath);
    const bytes = await fs.readFile(file);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error(`资料 ${item.original_name || item.material_id} 哈希不匹配。`), { code: 'OWN_MATERIAL_HASH_MISMATCH' });
    let parsed = null;
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (path.extname(item.original_name || '').toLowerCase() === '.json' || item.content_type === 'application/json') {
      try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error(`自有资料 ${item.original_name || item.material_id} 不是有效 JSON。`), { code: 'OWN_MATERIAL_JSON_INVALID' }); }
    }
    materials.push({ ...clone(item), sha256, parsed, declared_sku: parsed && typeof parsed === 'object' ? parsed.sku || parsed.product?.sku || parsed.product_facts?.sku || null : null, byte_length: bytes.length, verified_path: item.storage_relpath });
  }
  return materials;
}

function materialFactObject(material) {
  const parsed = material.parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const root = parsed.product_facts || parsed.facts || parsed;
  return root && typeof root === 'object' && !Array.isArray(root) ? root : {};
}

function sourceObservation(value, source, source_reference, source_version, source_type, raw_value = value, importProvenance = null) {
  return { value: clone(value), raw_value: clone(raw_value), source, source_type, source_reference, source_version, ...(importProvenance ? clone(importProvenance) : {}) };
}

function classifyOwnReference(reference) {
  const text = String(reference || '').trim();
  if (!text || /^material:\/\//i.test(text) || /(?:amazon\.|bol\.com\/|\bBOL竞品|Amazon竞品)/i.test(text)) return null;
  if (/1688\./i.test(text)) return '1688';
  if (/\.(?:png|jpe?g|webp)(?:$|[?#])/i.test(text)) return 'OWN_IMAGE';
  return 'OWN_DOCUMENT';
}

async function buildOwnMaterialsSnapshot(dataRoot, task) {
  const master = task.master || {};
  const materials = await loadOwnedMaterials(dataRoot, task);
  const facts = master.product_facts && typeof master.product_facts === 'object' ? master.product_facts : {};
  const confirmed = master.confirmed_facts && typeof master.confirmed_facts === 'object' ? master.confirmed_facts : {};
  const pmVersion = Number(master.fact_version || 1);
  const fields = {};
  for (const [key, label] of OWN_FACT_FIELDS) {
    const pmValue = key === 'sku' ? master.sku : key === 'ean' ? master.ean : key === 'brand_name' ? master.brand_name ?? master.brand : key === 'name' ? master.name : key === 'weight_kg' ? master.weight_kg : facts[key];
    const observations = [];
    if (pmValue != null && pmValue !== '') {
      const importedField = master.excel_source_import?.fields?.[key];
      if (importedField && canonicalFact(importedField.raw_value) === canonicalFact(pmValue)) {
        const importRef = `excel-source://${encodeURIComponent(master.excel_source_import.source_file || 'source')}/${encodeURIComponent(importedField.sheet || '')}/${encodeURIComponent(importedField.cell_reference || importedField.header_name || key)}/v${importedField.import_version}`;
        observations.push(sourceObservation(pmValue, 'Leon Excel input', importRef, importedField.import_version, 'PRODUCT_MASTER', importedField.raw_value, importedField));
      } else observations.push(sourceObservation(pmValue, 'Product Master', `product-master://${encodeURIComponent(task.sku)}/v${pmVersion}`, pmVersion, 'PRODUCT_MASTER'));
    }
    const confirmedItem = confirmed[key] || (key === 'brand_name' ? confirmed.brand : null);
    if (confirmedItem && Object.hasOwn(confirmedItem, 'value')) observations.push(sourceObservation(confirmedItem.value, confirmedItem.source || 'Leon-confirmed Product Master fact', confirmedItem.source_reference || `product-master://${encodeURIComponent(task.sku)}/confirmed/${key}`, confirmedItem.source_version ?? pmVersion, confirmedItem.source_type || 'PRODUCT_MASTER'));
    for (const material of materials) {
      if (material.excluded_reason) continue;
      const object = materialFactObject(material);
      const value = object[key] ?? object[label];
      if (value != null && value !== '') observations.push(sourceObservation(value, material.source_label || material.source_type, `material://${encodeURIComponent(task.sku)}/${material.material_id}/v${material.version}`, material.version, material.source_type, value));
    }
    const distinct = new Map(observations.map(item => [canonicalFact(item.value), item]));
    const conflict = distinct.size > 1;
    const values = [...distinct.values()];
    fields[key] = {
      label, raw_value: values.length ? clone(values[0].raw_value) : 'UNKNOWN',
      status: values.length ? conflict ? 'CONFLICT' : 'KNOWN' : 'UNKNOWN',
      observations, source_references: observations.map(item => ({ source_type: item.source_type, source_reference: item.source_reference, source_version: item.source_version })),
      is_new_fact: values.some(item => item.source_type !== 'PRODUCT_MASTER') && (pmValue == null || pmValue === ''),
      confirmed_status: confirmed[key] ? 'CONFIRMED' : 'UNCONFIRMED',
    };
  }
  const knownKeys = new Set(OWN_FACT_FIELDS.map(([key]) => key));
  for (const [key, value] of Object.entries(facts)) {
    if (knownKeys.has(key) || value == null || value === '') continue;
    const observations = [sourceObservation(value, 'Product Master', `product-master://${encodeURIComponent(task.sku)}/v${pmVersion}`, pmVersion, 'PRODUCT_MASTER')];
    for (const material of materials) {
      if (material.excluded_reason) continue;
      const object = materialFactObject(material);
      if (object[key] != null && object[key] !== '') observations.push(sourceObservation(object[key], material.source_label || material.source_type, `material://${encodeURIComponent(task.sku)}/${material.material_id}/v${material.version}`, material.version, material.source_type));
    }
    const distinct = new Map(observations.map(item => [canonicalFact(item.value), item]));
    fields[`product_facts.${key}`] = { label: key, raw_value: clone(observations[0].raw_value), status: distinct.size > 1 ? 'CONFLICT' : 'KNOWN', observations, source_references: observations.map(item => ({ source_type: item.source_type, source_reference: item.source_reference, source_version: item.source_version })), is_new_fact: false, confirmed_status: 'UNCONFIRMED' };
  }
  const previousVersion = Number(task.outputs?.own_materials_snapshot?.snapshot_version || 0);
  const excludedReferences = (master.source_refs || []).filter(ref => /(?:amazon\.|bol\.com\/|\bBOL竞品|Amazon竞品)/i.test(String(ref)));
  const productMasterReference = { source_type: 'PRODUCT_MASTER', source_reference: `product-master://${encodeURIComponent(task.sku)}/v${pmVersion}`, source_version: pmVersion };
  const declaredOwnedReferences = (master.source_refs || []).map(ref => ({ reference: String(ref), source_type: classifyOwnReference(ref), source_version: pmVersion })).filter(item => item.source_type);
  const workbookReferences = master.excel_source_import ? [
    { source_type: 'PRODUCT_MASTER', source_reference: `excel-source://${encodeURIComponent(master.excel_source_import.source_file || 'source')}/${encodeURIComponent(master.excel_source_import.sheet || '')}/row-${master.excel_source_import.row_number}/v${master.excel_source_import.version}`, source_version: master.excel_source_import.version, source_file_hash: master.excel_source_import.source_file_hash || null, schema_fingerprint: master.excel_source_import.schema_fingerprint || null },
    ...Object.entries(master.excel_source_import.fields || {}).map(([key, field]) => ({ source_type: 'PRODUCT_MASTER', source_reference: `excel-source://${encodeURIComponent(master.excel_source_import.source_file || 'source')}/${encodeURIComponent(field.sheet || '')}/${encodeURIComponent(field.cell_reference || field.header_name || key)}/v${field.import_version}`, source_version: field.import_version, source_file_hash: master.excel_source_import.source_file_hash || null, header_name: field.header_name, cell_reference: field.cell_reference })),
  ] : [];
  return {
    schema_version: 1, artifact_type: 'OWN_MATERIALS_SNAPSHOT', sku: task.sku, ean: master.ean || 'UNKNOWN',
    model: facts.model ?? 'UNKNOWN', brand_status: (master.brand_name ?? master.brand) ? ((confirmed.brand_name || confirmed.brand) ? 'CONFIRMED' : 'PRESENT_UNCONFIRMED') : 'UNKNOWN',
    product_name: master.name || 'UNKNOWN', fields, other_product_master_facts: clone(facts),
    excel_source_import: master.excel_source_import ? clone(master.excel_source_import) : null,
    source_references: [
      productMasterReference,
      ...workbookReferences,
      ...Object.entries(confirmed).flatMap(([key, item]) => item?.source_reference && item?.source_version ? [{ source_type: item.source_type || 'PRODUCT_MASTER', source_reference: item.source_reference, source_version: item.source_version, confirmed_field: key }] : []),
      ...declaredOwnedReferences.map(item => ({ source_type: item.source_type, source_reference: item.reference, source_version: item.source_version, declared_in: 'Product Master.source_refs' })),
      ...materials.filter(item => !item.excluded_reason).map(item => ({ source_type: item.source_type, source_reference: `material://${encodeURIComponent(task.sku)}/${item.material_id}/v${item.version}`, source_version: item.version, original_name: item.original_name, sha256: item.sha256, storage_relpath: item.storage_relpath })),
    ],
    excluded_non_owned_references: excludedReferences, materials: materials.map(({ parsed, ...item }) => item),
    read_at: iso(), snapshot_version: previousVersion + 1, product_master_version: pmVersion,
    evidence: { product_master_version: pmVersion, material_versions: materials.filter(item => !item.excluded_reason).map(item => ({ material_id: item.material_id, source_type: item.source_type, version: item.version, sha256: item.sha256 })) },
  };
}

function buildConfirmedProductFacts(task, snapshot) {
  const previous = task.listing_sop?.confirmed_product_facts_versions || [];
  const version = Number(previous.at(-1)?.version || 0) + 1;
  const fields = {};
  const proposals = [];
  for (const [key, item] of Object.entries(snapshot.fields || {})) {
    if (task.listing_sop?.ignored_facts?.[key]) {
      fields[key] = { value: 'UNKNOWN', status: 'UNKNOWN', source_references: [], ignored_at: task.listing_sop.ignored_facts[key].decided_at };
      continue;
    }
    const leonFact = task.master?.confirmed_facts?.[key] || (key === 'brand_name' ? task.master?.confirmed_facts?.brand : null);
    if (leonFact && Object.hasOwn(leonFact, 'value')) {
      fields[key] = { value: clone(leonFact.value), status: 'CONFIRMED', source_references: clone(leonFact.source_references || item.source_references || []), confirmed_by: 'Leon', confirmed_at: leonFact.confirmed_at || null };
      continue;
    }
    if (key === 'brand_name' && item.status === 'UNKNOWN') {
      fields[key] = { value: 'UNKNOWN', status: 'WAITING_CONFIRMATION', source_references: [] };
      proposals.push({ field: key, label: item.label || '品牌', reason: 'BRAND_MISSING', current_value: null, candidates: [], requires_manual_value: true });
      continue;
    }
    if (item.status === 'UNKNOWN') {
      fields[key] = { value: 'UNKNOWN', status: 'UNKNOWN', source_references: [] };
      continue;
    }
    if (item.status === 'CONFLICT' || item.is_new_fact) {
      fields[key] = { value: null, status: item.status === 'CONFLICT' ? 'CONFLICT' : 'WAITING_CONFIRMATION', source_references: clone(item.source_references || []) };
      proposals.push({ field: key, label: item.label || key, reason: item.status === 'CONFLICT' ? 'OWN_SOURCE_CONFLICT' : 'NEW_OWN_SOURCE_FACT', current_value: task.master?.[key] ?? (key === 'brand_name' ? task.master?.brand : null) ?? task.master?.product_facts?.[key] ?? null, candidates: (item.observations || []).map(observation => ({ value: clone(observation.value), raw_value: clone(observation.raw_value), source: observation.source, source_type: observation.source_type, source_reference: observation.source_reference, source_version: observation.source_version })) });
      continue;
    }
    fields[key] = { value: clone(item.raw_value), status: 'CONFIRMED', source_references: clone(item.source_references || []), confirmed_by: 'SOP02_UNAMBIGUOUS_OWN_SOURCE', confirmed_at: iso() };
  }
  return { version, artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', sku: task.sku, source_snapshot_version: snapshot.snapshot_version, product_master_version: task.master.fact_version, created_at: iso(), fields, proposals, evidence: { product_master_version: task.master.fact_version, source_snapshot_version: snapshot.snapshot_version } };
}

async function validateOwnMaterialsSnapshot(task, dataRoot) {
  const snapshot = task.outputs?.own_materials_snapshot;
  const problems = [];
    if (!snapshot || snapshot.artifact_type !== 'OWN_MATERIALS_SNAPSHOT') return [['SOP01_SNAPSHOT_MISSING', '缺少自有资料快照。', 'outputs.own_materials_snapshot', '已持久化 OWN_MATERIALS_SNAPSHOT', '重新执行 LISTING_SOP_01。']];
    if (snapshot.sku !== task.sku || task.master?.sku !== task.sku) problems.push(['SOP01_SKU_MISMATCH', '快照 SKU 与当前任务不一致。', 'outputs.own_materials_snapshot.sku', task.sku, '修复 SKU 对应关系后重跑资料读取。']);
    if (!Number.isInteger(snapshot.snapshot_version) || snapshot.snapshot_version < 1 || !snapshot.read_at) problems.push(['SOP01_SNAPSHOT_VERSION_INVALID', '快照版本或读取时间无效。', 'outputs.own_materials_snapshot.snapshot_version', '正整数版本和读取时间', '重新生成快照。']);
  if (!task.listing_sop?.own_materials_snapshots?.some(item => Number(item.snapshot_version) === Number(snapshot.snapshot_version))) problems.push(['SOP01_SNAPSHOT_HISTORY_MISSING', '当前快照没有保存在版本历史中。', 'listing_sop.own_materials_snapshots', '与当前快照相同的持久化历史版本', '重新生成并保存快照版本。']);
  if (!snapshot.source_references?.some(item => item.source_type === 'PRODUCT_MASTER' && item.source_reference && item.source_version)) problems.push(['SOP01_PM_SOURCE_MISSING', '快照缺少 Product Master 来源版本。', 'outputs.own_materials_snapshot.source_references', 'Product Master URI 与事实版本', '补齐 Product Master 来源。']);
  for (const [field, record] of Object.entries(snapshot.fields || {})) {
    if (!['UNKNOWN', 'KNOWN', 'CONFLICT'].includes(record.status)) problems.push(['SOP01_FIELD_STATUS_INVALID', `字段 ${field} 状态无效。`, `outputs.own_materials_snapshot.fields.${field}.status`, 'UNKNOWN / KNOWN / CONFLICT', '重新生成快照。']);
    if (record.status === 'UNKNOWN' && record.raw_value !== 'UNKNOWN') problems.push(['SOP01_UNKNOWN_NOT_EXPLICIT', `字段 ${field} 未知值未显式标记。`, `outputs.own_materials_snapshot.fields.${field}.raw_value`, 'UNKNOWN', '显式保存 UNKNOWN。']);
    if (record.status !== 'UNKNOWN' && (!record.source_references?.length || record.source_references.some(ref => !ref.source_reference || !ref.source_version || !OWN_SOURCE_TYPES.has(ref.source_type) || !snapshot.source_references.some(source => source.source_type === ref.source_type && source.source_reference === ref.source_reference && String(source.source_version) === String(ref.source_version))))) problems.push(['SOP01_FIELD_SOURCE_MISSING', `字段 ${field} 缺少有效自有来源引用。`, `outputs.own_materials_snapshot.fields.${field}.source_references`, '每项已知事实均有自有来源及版本，且引用存在于快照来源清单', '绑定有效的 Product Master 或自有资料来源。']);
  }
  if (snapshot.excel_source_import) {
    const imported = snapshot.excel_source_import;
    if (!Number.isInteger(Number(imported.version)) || !imported.source_file || !imported.sheet || !imported.imported_at || !imported.schema_fingerprint) problems.push(['SOP01_EXCEL_SOURCE_METADATA_INVALID', 'Excel输入来源缺少文件、Sheet、导入版本、时间或Schema指纹。', 'outputs.own_materials_snapshot.excel_source_import', '保留来源文件、工作表、表头和导入版本证据', '重新通过Excel Adapter导入并执行SOP01。']);
    for (const [field, meta] of Object.entries(imported.fields || {})) {
      if (!Object.hasOwn(meta, 'raw_value') || !meta.source_file || !meta.sheet || !meta.header_name || !Number.isInteger(Number(meta.import_version)) || !meta.imported_at) problems.push(['SOP01_EXCEL_FIELD_PROVENANCE_INVALID', `Excel字段 ${field} 缺少原值或来源位置/版本。`, `outputs.own_materials_snapshot.excel_source_import.fields.${field}`, 'raw_value、source_file、sheet、header_name、import_version、imported_at', '重新读取原始工作簿并保存字段级来源。']);
    }
  }
  for (const material of snapshot.materials || []) {
    if (material.excluded_reason) continue;
    if (material.declared_sku && String(material.declared_sku).trim() !== String(task.sku)) problems.push(['SOP01_MATERIAL_SKU_MISMATCH', `资料 ${material.original_name || material.material_id} 声明的 SKU 与当前任务不一致。`, `outputs.own_materials_snapshot.materials.${material.material_id}.declared_sku`, task.sku, '确认资料属于当前 SKU 后重新绑定。']);
    try {
      const file = safeMaterialPath(dataRoot, material.storage_relpath);
      if (!material.storage_relpath || !material.sha256 || !snapshot.source_references.some(ref => ref.source_type === material.source_type && ref.sha256 === material.sha256)) throw new Error('reference missing');
      const bytes = await fs.readFile(file);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== material.sha256 || bytes.length !== material.byte_length) throw new Error('content hash mismatch');
      const materialUri = `material://${encodeURIComponent(task.sku)}/${material.material_id}/v${material.version}`;
      if (!snapshot.source_references.some(ref => ref.source_reference === materialUri && ref.source_type === material.source_type && ref.source_version === material.version && ref.sha256 === material.sha256)) throw new Error('reference missing');
    } catch { problems.push(['SOP01_MATERIAL_REFERENCE_INVALID', '自有资料路径或来源版本无效。', 'outputs.own_materials_snapshot.materials', '路径位于独立 BOL 数据根且引用有版本', '重新绑定资料。']); }
  }
  return problems;
}

function syncTaskContract(task) {
  task.current_pool = task.activity_pool;
  task.stage_qa_status = task.qa?.[task.current_step]?.status || 'NOT_RUN';
  task.open_error_count = activeIssueCount(task);
  const active = [...(task.issues || [])].reverse().find(issue => issue.status !== 'CLOSED');
  task.error_code = active?.code || null;
  task.error_message = active?.reason || null;
  task.sidecars ||= {};
  const mabang = task.sidecars.mabang;
  if (mabang?.status === 'QUEUED_ENGINE_PENDING') {
    const weightG = mabang.weight_kg == null ? null : Number(mabang.weight_kg) * 1000;
    const fractionalWeight = weightG != null && Number.isFinite(weightG) && !Number.isInteger(weightG);
    Object.assign(mabang, {
      job_id: mabang.job_id || `${task.sku}:mabang:v${task.master?.fact_version || 1}`,
      input_fact_version: mabang.input_fact_version || task.master?.fact_version || 1,
      status: 'WAITING_DECISION', current_step: fractionalWeight ? 'WAIT_WEIGHT_DECISION' : 'WAIT_SCHEMA_CONFIRMATION',
      dependency: 'MABANG_SCHEMA', dependency_status: 'WAITING_DECISION',
      blocking_reason: fractionalWeight ? 'MABANG_FRACTIONAL_GRAM_ACCEPTANCE' : 'MABANG_SCHEMA_CONFIRMATION',
      weight_g: Number.isFinite(weightG) ? weightG : null, weight_conversion_status: weightG == null ? 'NOT_PROVIDED' : fractionalWeight ? 'WAITING_DECISION' : 'PASS',
      export_allowed: false, updated_at: iso(),
    });
  }
  if (task.sidecars.art?.status === 'NOT_CONNECTED') Object.assign(task.sidecars.art, {
    status: 'WAITING_DEPENDENCY', current_step: 'WAIT_ART_REVIEW_EXECUTOR',
    dependency: 'ART_REVIEW_EXECUTOR', dependency_status: 'NOT_READY', updated_at: iso(),
  });
}

function issueFor(task, code, reason, field, expected, suggestion) {
  const current = field.split('.').reduce((value, part) => value?.[part], task);
  const existing = task.issues.find(item => item.code === code && item.step === task.current_step && !['CLOSED'].includes(item.status));
  const issue = existing || { issue_id: crypto.randomUUID(), created_at: iso(), status: 'OPEN' };
  Object.assign(issue, { code, step: task.current_step, location: field, reason, current_value: current ?? null, expected_standard: expected, fix_suggestion: suggestion, resume_point: task.current_step, updated_at: iso() });
  if (!existing) task.issues.push(issue);
  task.error_code = code;
  task.error_message = reason;
  return issue;
}

export function isBolRuntimeDependencyError(errorOrCode) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code;
  const status = Number(typeof errorOrCode === 'object' ? errorOrCode?.status : 0) || 0;
  if (isBolBusinessNetworkFailure(typeof errorOrCode === 'string' ? { code: errorOrCode } : errorOrCode)) return true;
  if (['BOL_API_RETRY_EXHAUSTED', 'BOL_RATE_LIMITED', 'BOL_AUTH_UNAUTHORIZED', 'BOL_CREDENTIALS_MISSING'].includes(code)) return true;
  return ['BOL_API_HTTP_ERROR', 'BOL_AUTH_HTTP_ERROR'].includes(code) && (status === 408 || status === 429 || status >= 500);
}

async function waitForProviderDependency(dataRoot, task, {
  step = task.current_step, dependencyKey = 'BOL_API', error, attempt = null,
  providerMethod = 'BOL_RETAILER_API_V10_SEARCH_TERMS', seed = null,
  sourceEvidence = null, location = `outputs.${step}`, originalFailureAt = null,
} = {}) {
  if (!isBolRuntimeDependencyError(error)) return false;
  const code = String(error?.code || 'BOL_RUNTIME_DEPENDENCY_ERROR');
  const reason = error instanceof AdapterError ? error.message : 'BOL 运行时依赖暂不可用；错误详情已脱敏。';
  const at = iso();
  const failedAt = originalFailureAt || attempt?.provider_evidence?.failed_at || attempt?.failure?.failed_at || at;
  const failureEvidence = {
    dependency_key: dependencyKey, provider_method: providerMethod, step,
    seed_exact_string: seed || attempt?.seed_exact_string || null,
    request_id: attempt?.request_id || attempt?.attempt_id || null,
    error_code: code, error_message: reason, failed_at: failedAt,
    ...(failedAt !== at ? { reclassified_at: at } : {}),
    request_attempted: true, response_received: false,
    input_versions: clone(attempt?.input_versions || null), source_evidence: clone(sourceEvidence || attempt?.source_evidence || null),
  };
  if (attempt) {
    attempt.step ||= step;
    attempt.dependency_key ||= dependencyKey;
    attempt.provider_method ||= providerMethod;
    attempt.failure ||= { status: 'ERROR', ...failureEvidence };
    attempt.status = 'WAITING_DEPENDENCY';
    attempt.error_code = code;
    attempt.error_message = reason;
    if (originalFailureAt) attempt.completed_at = originalFailureAt;
    else attempt.completed_at ||= failedAt;
    if (failedAt !== at) attempt.reclassified_at = at;
    attempt.provider_evidence = failureEvidence;
  }
  task.provider_attempts ||= [];
  if (attempt) {
    const attemptKey = attempt.attempt_id || attempt.request_id;
    let foundProviderAttempt = false;
    for (const collection of [task.provider_attempts, task.sop04_supplemental_queries, task.sop04_search_terms_attempts]) {
      const stored = collection?.find(item => (item.attempt_id || item.request_id) === attemptKey);
      if (stored) { Object.assign(stored, clone(attempt)); if (collection === task.provider_attempts) foundProviderAttempt = true; }
    }
    if (!foundProviderAttempt) task.provider_attempts.push({ attempt_id: attemptKey, ...clone(attempt) });
  }
  let closedIssueCount = 0;
  for (const issue of task.issues || []) {
    if (issue.status === 'OPEN' && issue.code === code && issue.step === step && issue.location === location) {
      issue.status = 'CLOSED'; issue.closed_at = at; issue.updated_at = at;
      issue.close_reason = 'RECLASSIFIED_AS_WAITING_DEPENDENCY'; closedIssueCount += 1;
    }
  }
  task.waiting_dependency_key = dependencyKey;
  if (dependencyKey === 'BOL_API') applyBolNetworkFailureBarrier(task, { error, failedAt, dependencyKey });
  task.current_step = step; task.resume_point = step;
  task.status = 'WAITING_DEPENDENCY'; task.error_code = null; task.error_message = null;
  task.return_pool = '关键词池'; task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
  task.qa ||= {}; task.qa[step] = { ...(task.qa[step] || {}), status: 'NOT_RUN', checked_at: null };
  task.stages ||= {}; task.stages[step] = { ...(task.stages[step] || {}), status: 'WAITING_DEPENDENCY', dependency: dependencyKey, waiting_reason: reason, updated_at: at };
  applyListingExecutorStep(task, step, { status: 'WAITING_DEPENDENCY', waiting_reason: reason, resume_point: step, qa: { status: 'NOT_RUN' } });
  task.open_error_count = activeIssueCount(task);
  await commit(dataRoot, task, 'STEP_REMOTE_CALL_FAILED', {
    step, dependency_key: dependencyKey, provider_method: providerMethod,
    seed_exact_string: seed || attempt?.seed_exact_string || null,
    request_id: attempt?.request_id || attempt?.attempt_id || null,
    error_code: code, error_message: reason, attempt: clone(attempt), provider_evidence: failureEvidence,
    waiting_dependency_key: dependencyKey, qa_status: 'NOT_RUN', open_error_count: task.open_error_count,
    closed_error_count: closedIssueCount, reclassified_existing_error: closedIssueCount > 0,
  });
  return true;
}

async function loadSop07SourceArtifacts(dataRoot, task) {
  const sop05Version = task.listing_executor?.registry?.LISTING_SOP_05?.output_version;
  const sop06Version = task.listing_executor?.registry?.LISTING_SOP_06?.output_version;
  if (!/^SOP05-[A-Za-z0-9_-]+$/.test(String(sop05Version || '')) || !/^SOP06-[A-Za-z0-9_-]+$/.test(String(sop06Version || ''))) {
    throw Object.assign(new Error('缺少正式SOP05/SOP06版本引用。'), { code: 'SOP07_UPSTREAM_VERSION_MISSING' });
  }
  const root = path.resolve(dataRoot);
  const sop05Path = path.resolve(root, 'artifacts', 'listing', task.sku, 'sop05', `${sop05Version}.json`);
  const sop06Path = path.resolve(root, 'artifacts', 'listing', task.sku, 'sop06', `${sop06Version}.json`);
  for (const file of [sop05Path, sop06Path]) if (!file.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('SOP07来源artifact超出当前数据根。'), { code: 'SOP07_ARTIFACT_PATH_INVALID' });
  const [sop05, sop06] = await Promise.all([sop05Path, sop06Path].map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
  return { sop05, sop06, sop05Path, sop06Path };
}

function sop05InputVersionRefs(task, inputs = null) {
  const refs = [
    { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: task.outputs?.confirmed_product_facts?.version },
    { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: task.listing_executor?.registry?.LISTING_SOP_03?.output_version },
    { artifact_type: 'BOL_RELATED_TERMS_SET', version: task.listing_executor?.registry?.LISTING_SOP_04?.output_version },
  ];
  if (inputs?.factsSnapshotRef) refs.push({ artifact_type: 'TASK_VERSION_SNAPSHOT', version: String(inputs.factsSnapshotRef.version), sha256: inputs.factsSnapshotRef.sha256 });
  if (inputs?.sop03Ref) refs.push({ artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: String(inputs.sop03Ref.version), sha256: inputs.sop03Ref.sha256 });
  if (inputs?.sop04Ref) refs.push({ artifact_type: 'BOL_RELATED_TERMS_SET', version: String(inputs.sop04Ref.version), sha256: inputs.sop04Ref.sha256 });
  for (const [sourceId, evidence] of Object.entries(inputs?.rawEvidenceBySource || {}).sort(([a], [b]) => a.localeCompare(b))) {
    refs.push({ artifact_type: 'BOLOO_RAW_DOM_EVIDENCE', source_id: sourceId, version: String(evidence.version), sha256: evidence.sha256 });
  }
  return refs;
}

function relativeReferenceInsideRoot(dataRoot, reference) {
  if (typeof reference !== 'string' || !reference.trim()) throw Object.assign(new Error('SOP05 evidence reference is missing.'), { code: 'SOP05_EVIDENCE_REF_MISSING' });
  const root = path.resolve(dataRoot);
  const target = path.isAbsolute(reference) ? path.resolve(reference) : path.resolve(root, reference);
  const relative = path.relative(root, target);
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw Object.assign(new Error('SOP05 evidence reference is outside the active dataRoot.'), { code: 'SOP05_EVIDENCE_PATH_INVALID' });
  }
  return { absolute: target, relative: relative.replace(/\\/g, '/') };
}

async function readHashedSop05Artifact(dataRoot, relativeReference, expectedType, expectedSku, expectedVersion = null) {
  const target = relativeReferenceInsideRoot(dataRoot, relativeReference);
  const bytes = await fs.readFile(target.absolute);
  const data = JSON.parse(bytes.toString('utf8'));
  if (data?.artifact_type !== expectedType || data?.sku !== expectedSku
    || (expectedVersion != null && data?.version != null && String(data.version) !== String(expectedVersion))) {
    throw Object.assign(new Error(`SOP05 source artifact identity/version mismatch: ${target.relative}`), { code: 'SOP05_SOURCE_ARTIFACT_IDENTITY_MISMATCH' });
  }
  return { reference: target.relative, absolute: target.absolute, data, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function readSop05RawExtractorEvidence(dataRoot, evidenceRef, sourceRow) {
  const target = relativeReferenceInsideRoot(dataRoot, evidenceRef.reference);
  const bytes = await fs.readFile(target.absolute);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (evidenceRef.sha256 && String(evidenceRef.sha256).toLowerCase() !== sha256) {
    throw Object.assign(new Error(`Boloo RAW evidence SHA mismatch: ${target.relative}`), { code: 'SOP05_RAW_EVIDENCE_SHA_MISMATCH' });
  }
  const data = JSON.parse(bytes.toString('utf8'));
  const rawKeywords = data?.raw_response?.keywords;
  const rowTerms = Array.isArray(sourceRow.exact_strings) ? sourceRow.exact_strings : [];
  const exact = value => typeof value === 'string' ? value : String(value?.keyword ?? value?.exact_string ?? '');
  if (data?.request_id !== sourceRow.provider_request_id || data?.query_text !== sourceRow.source_url
    || !Array.isArray(rawKeywords) || rawKeywords.length !== rowTerms.length
    || !rawKeywords.every((term, index) => exact(term) === exact(rowTerms[index]))) {
    throw Object.assign(new Error(`Boloo RAW evidence does not match the exact persisted request/result for ${sourceRow.source_id}.`), { code: 'SOP05_RAW_EVIDENCE_REQUEST_MISMATCH' });
  }
  return { reference: target.relative, absolute: target.absolute, data, sha256 };
}

async function findImmutableSop05FactsSnapshot(dataRoot, task, facts) {
  if (task.qa?.LISTING_SOP_02?.status !== 'PASS' || facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION'
    || facts?.sku !== task.sku || !task.listing_sop?.confirmed_product_facts_versions?.some(item => Number(item.version) === Number(facts.version))) {
    throw Object.assign(new Error('Current Product Facts do not have a current-SKU SOP02 PASS lineage.'), { code: 'SOP05_FACTS_VERSION_NOT_CONFIRMED' });
  }
  const directory = path.join(dataRoot, 'versions', task.id);
  const names = (await fs.readdir(directory)).filter(name => /^\d+\.json$/u.test(name)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  for (const name of names) {
    const reference = path.posix.join('versions', task.id, name);
    const target = relativeReferenceInsideRoot(dataRoot, reference);
    let bytes;
    let wrapper;
    try {
      bytes = await fs.readFile(target.absolute);
      wrapper = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const snapshot = wrapper.snapshot;
    if (!snapshot || String(snapshot.id || '') !== String(task.id) || String(snapshot.sku || '') !== String(task.sku)
      || Number(wrapper.version) !== Number(snapshot.revision) || snapshot.qa?.LISTING_SOP_02?.status !== 'PASS'
      || !isDeepStrictEqual(snapshot.outputs?.confirmed_product_facts, facts)) continue;
    return { reference: target.relative, absolute: target.absolute, data: wrapper,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      version: String(wrapper.version), artifact_type: 'TASK_VERSION_SNAPSHOT', layer: 'OWN_FACTS', sku: task.sku };
  }
  throw Object.assign(new Error('No immutable task snapshot contains the exact current facts object with SOP02 PASS.'), { code: 'SOP05_IMMUTABLE_FACTS_SNAPSHOT_MISSING' });
}

async function loadSop05Inputs(dataRoot, task) {
  const facts = task.outputs?.confirmed_product_facts;
  const sop03Version = String(task.listing_executor?.registry?.LISTING_SOP_03?.output_version || '');
  const sop04Version = String(task.listing_executor?.registry?.LISTING_SOP_04?.output_version || '');
  if (task.qa?.LISTING_SOP_03?.status !== 'PASS' || task.qa?.LISTING_SOP_04?.status !== 'PASS'
    || task.listing_executor?.registry?.LISTING_SOP_03?.qa_status !== 'PASS'
    || task.listing_executor?.registry?.LISTING_SOP_04?.qa_status !== 'PASS'
    || !/^SOP03-SOURCES-[a-f0-9]{20,32}$/iu.test(sop03Version)
    || !/^SOP04-[a-f0-9]{20}$/iu.test(sop04Version)) {
    throw Object.assign(new Error('SOP05 requires current facts, SOP03, and SOP04 Stage QA PASS.'), { code: 'SOP05_UPSTREAM_QA_NOT_PASS' });
  }
  const sop03Suffix = sop03Version.slice('SOP03-SOURCES-'.length);
  const sop03Reference = path.posix.join('artifacts', 'listing', task.sku, 'sop03', `${sop03Suffix}.json`);
  const sop04Reference = path.posix.join('artifacts', 'listing', task.sku, 'sop04', `${sop04Version}.json`);
  const sop03RegistryRefs = (task.listing_executor?.registry?.LISTING_SOP_03?.evidence_refs || [])
    .map(reference => { try { return relativeReferenceInsideRoot(dataRoot, reference).relative; } catch { return null; } }).filter(Boolean);
  const sop04RegistryRefs = (task.listing_executor?.registry?.LISTING_SOP_04?.evidence_refs || [])
    .map(reference => { try { return relativeReferenceInsideRoot(dataRoot, reference).relative; } catch { return null; } }).filter(Boolean);
  if (!sop03RegistryRefs.includes(sop03Reference) || !sop04RegistryRefs.includes(sop04Reference)) {
    throw Object.assign(new Error('Derived SOP03/SOP04 file reference is not explicitly locked in the current task registry.'), { code: 'SOP05_UPSTREAM_ARTIFACT_REF_MISMATCH' });
  }
  const [factsSnapshot, sop03Loaded, sop04Loaded] = await Promise.all([
    findImmutableSop05FactsSnapshot(dataRoot, task, facts),
    readHashedSop05Artifact(dataRoot, sop03Reference, 'SOP03_SOURCE_DISCOVERY_VERSION', task.sku),
    readHashedSop05Artifact(dataRoot, sop04Reference, 'BOL_RELATED_TERMS_SET', task.sku, sop04Version),
  ]);
  const sop03 = sop03Loaded.data;
  const sop04 = sop04Loaded.data;
  if (Number(sop03.facts_version) !== Number(facts.version)
    || Number(sop04.confirmed_product_facts_version) !== Number(facts.version)
    || String(sop04.sop03_artifact_version) !== sop03Version) {
    throw Object.assign(new Error('SOP03/SOP04 facts or parent-version locks do not match the current Product Facts.'), { code: 'SOP05_UPSTREAM_VERSION_MISMATCH' });
  }

  const rawEvidenceBySource = {};
  const evidenceArtifacts = [
    factsSnapshot,
    { ...sop03Loaded, version: sop03Version, artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', layer: 'SOURCE_EVIDENCE', sku: task.sku },
    { ...sop04Loaded, version: sop04Version, artifact_type: 'BOL_RELATED_TERMS_SET', layer: 'LISTING_ARTIFACT', sku: task.sku },
  ];
  for (const row of sop03.boloo_competitor_extractor || []) {
    if (row.status === 'PASS_NO_RESULT') continue;
    if (row.status !== 'PASS') continue;
    const references = Array.isArray(row.evidence_refs) ? row.evidence_refs : row.evidence_refs ? [row.evidence_refs] : [];
    const verified = [];
    for (const evidenceRef of references) {
      if (evidenceRef?.persisted !== true || evidenceRef?.matches_request !== true || !evidenceRef.reference) continue;
      const loaded = await readSop05RawExtractorEvidence(dataRoot, evidenceRef, row);
      verified.push(loaded);
    }
    if (verified.length !== 1) throw Object.assign(new Error(`PASS Extractor ${row.source_id} must resolve exactly one persisted matching RAW/DOM result.`), { code: 'SOP05_EXTRACTOR_EVIDENCE_AMBIGUOUS', source_id: row.source_id });
    const loaded = verified[0];
    rawEvidenceBySource[row.source_id] = {
      reference: loaded.reference, version: row.result_version, artifact_type: 'BOLOO_RAW_DOM_EVIDENCE',
      sha256: loaded.sha256, layer: 'SOURCE_EVIDENCE', sku: task.sku, data: loaded.data,
    };
    evidenceArtifacts.push(rawEvidenceBySource[row.source_id]);
  }
  return {
    facts, sop03: { ...sop03, version: sop03Version }, sop04,
    factsSnapshotRef: factsSnapshot,
    sop03Ref: { reference: sop03Loaded.reference, version: sop03Version, artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', sha256: sop03Loaded.sha256, layer: 'SOURCE_EVIDENCE' },
    sop04Ref: { reference: sop04Loaded.reference, version: sop04Version, artifact_type: 'BOL_RELATED_TERMS_SET', sha256: sop04Loaded.sha256, layer: 'LISTING_ARTIFACT' },
    rawEvidenceBySource, evidenceResolver: createListingEvidenceResolver({ sku: task.sku, evidence_artifacts: evidenceArtifacts }),
  };
}

async function executeListingSop05CandidatePool(dataRoot, task) {
  const step = 'LISTING_SOP_05';
  task.outputs ||= {}; task.qa ||= {}; task.stages ||= {};
  task.listing_executor ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso());
  task.listing_executor.registry ||= {};
  task.listing_executor.registry[step] ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso()).registry[step];
  const inputs = await loadSop05Inputs(dataRoot, task);
  const inputVersionRefs = sop05InputVersionRefs(task, inputs);
  const executorId = LISTING_SOP05_EXECUTOR_ID;
  const existingOutput = task.outputs.keyword_candidate_pool;
  if (existingOutput?.version && existingOutput?.evidence?.artifact_ref) {
    if (Number(existingOutput.input_versions?.confirmed_product_facts_version) !== Number(inputs.facts.version)
      || String(existingOutput.input_versions?.sop03_artifact_version) !== String(inputs.sop03Ref.version)
      || String(existingOutput.input_versions?.sop04_artifact_version) !== String(inputs.sop04Ref.version)) {
      throw Object.assign(new Error('已有SOP05输出与当前事实/来源版本不匹配；拒绝覆盖或重用。'), { code: 'SOP05_EXISTING_OUTPUT_STALE' });
    }
    return verifyCurrent(dataRoot, task);
  }

  task.waiting_dependency_key = null;
  task.error_code = null; task.error_message = null;
  task.stage_qa_status = 'NOT_RUN';
  task.listing_executor.registry[step] = {
    ...task.listing_executor.registry[step], executor_id: executorId,
    input_version_refs: clone(inputVersionRefs), required_dependencies: [],
    status: 'RUNNING', qa_status: 'NOT_RUN', waiting_reason: null, resume_point: step,
  };
  applyListingExecutorStep(task, step, { status: 'RUNNING', input_version_refs: inputVersionRefs, resume_point: step, qa: { status: 'NOT_RUN' } });
  await commit(dataRoot, task, 'LISTING_SOP_05_EXECUTOR_STARTED', {
    step, executor_id: executorId, input_versions: {
      facts: inputs.facts.version, facts_snapshot_revision: inputs.factsSnapshotRef.version,
      sop03: inputs.sop03Ref.version, sop04: inputs.sop04Ref.version,
    }, external_requests: 0,
  });

  const artifact = buildListingSop05CandidatePool({
    sku: task.sku, facts: inputs.facts, sop03: inputs.sop03, sop04: inputs.sop04,
    factsSnapshotRef: inputs.factsSnapshotRef, sop03Ref: inputs.sop03Ref, sop04Ref: inputs.sop04Ref,
    rawEvidenceBySource: inputs.rawEvidenceBySource,
  });
  const relativeArtifact = path.posix.join('artifacts', 'listing', task.sku, 'sop05', `${artifact.version}.json`);
  artifact.evidence.artifact_ref = relativeArtifact;
  artifact.evidence.evidence_refs = [...new Set([
    ...(artifact.evidence.evidence_refs || []),
    inputs.factsSnapshotRef.reference, inputs.sop03Ref.reference, inputs.sop04Ref.reference,
    ...Object.values(inputs.rawEvidenceBySource).map(item => item.reference),
  ])];
  artifact.execution = { executor_id: executorId, external_requests: 0, provider_requests: 0, boloo_requests: 0 };
  const artifactPath = safeMaterialPath(dataRoot, relativeArtifact);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  const serialized = JSON.stringify(artifact, null, 2);
  try {
    await fs.writeFile(artifactPath, serialized, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    const sameIdentity = prior.version === artifact.version && prior.sku === task.sku
      && prior.artifact_type === artifact.artifact_type
      && prior.evidence?.artifact_ref === relativeArtifact
      && isDeepStrictEqual(prior.input_versions, artifact.input_versions)
      && isDeepStrictEqual(prior.input_artifacts, artifact.input_artifacts)
      && isDeepStrictEqual(prior.candidates, artifact.candidates)
      && ['PENDING_QA', 'PASS'].includes(prior.status)
      && (prior.status !== 'PASS' || prior.qa_status === 'PASS');
    if (!sameIdentity) throw Object.assign(new Error('SOP05版本路径已存在不同内容；保留原件并停止。'), { code: 'SOP05_ARTIFACT_VERSION_COLLISION' });
    Object.assign(artifact, prior);
  }
  const output = { ...clone(artifact), open_error_count: activeIssueCount(task) };
  task.outputs.keyword_candidate_pool = output;
  task.listing_executor.registry[step] = {
    ...task.listing_executor.registry[step], executor_id: executorId,
    input_version_refs: clone(inputVersionRefs), output_version: artifact.version,
    evidence_refs: [...new Set([...(task.listing_executor.registry[step].evidence_refs || []), ...artifact.evidence.evidence_refs, relativeArtifact])],
  };
  applyListingExecutorStep(task, step, { status: 'DONE_PENDING_QA', output, input_version_refs: inputVersionRefs, resume_point: step, qa: { status: 'NOT_RUN' } });
  await commit(dataRoot, task, 'LISTING_SOP_05_EXECUTOR_DONE_PENDING_QA', {
    step, executor_id: executorId, version: artifact.version, artifact_ref: relativeArtifact,
    candidate_count: artifact.candidate_count, selected_for_sop06_count: artifact.selected_for_sop06_count,
    excluded_count: artifact.excluded_count, external_requests: 0,
  });
  return verifyCurrent(dataRoot, task);
}

function sop03ArtifactPath(dataRoot, task) {
  const version = String(task.listing_executor?.registry?.LISTING_SOP_03?.output_version || '');
  const suffix = version.startsWith('SOP03-SOURCES-') ? version.slice('SOP03-SOURCES-'.length) : '';
  if (!/^[a-f0-9]{20,32}$/i.test(suffix)) throw Object.assign(new Error('缺少有效的SOP03来源artifact版本。'), { code: 'SOP08_SOP03_VERSION_INVALID' });
  const root = path.resolve(dataRoot);
  const file = path.resolve(root, 'artifacts', 'listing', task.sku, 'sop03', `${suffix}.json`);
  if (!file.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('SOP03来源artifact超出当前数据根。'), { code: 'SOP08_SOP03_ARTIFACT_PATH_INVALID' });
  return file;
}

function bolProductIdFromDetailUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || (url.hostname !== 'www.bol.com' && url.hostname !== 'bol.com')) return null;
    return url.pathname.match(/^\/nl\/nl\/p\/[^/]+\/(\d+)\/?$/i)?.[1] || null;
  } catch { return null; }
}

function apiHttpStatus(response) {
  const source = String(response?.source || '');
  const match = source.match(/HTTP\s+(\d{3})/i);
  return Number(response?.structuredResult?.http_status || response?.httpStatus || match?.[1] || 0) || null;
}

function normalizedCategoryIds(placement) {
  const categories = placement?.categories;
  if (!Array.isArray(categories)) return [];
  return [...new Set(categories.map(item => {
    if (item && typeof item === 'object') return String(item.categoryId ?? item.id ?? item.categoryCode ?? item.name ?? item.categoryName ?? '').trim();
    return String(item ?? '').trim();
  }).filter(Boolean))];
}

function numericPrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === 'object') {
    for (const key of ['amount', 'value', 'price', 'unitPrice']) if (Number.isFinite(Number(value[key]))) return Number(value[key]);
  }
  return null;
}

async function writeSop08Evidence(dataRoot, sku, competitorId, method, response, request, queriedAt) {
  const root = path.resolve(dataRoot);
  const filename = `${competitorId}-${method}-${crypto.createHash('sha256').update(`${queriedAt}:${JSON.stringify(request)}`).digest('hex').slice(0, 10)}.json`;
  const file = path.resolve(root, 'artifacts', 'listing', sku, 'sop08', 'evidence', filename);
  if (!file.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('SOP08 evidence路径超出当前数据根。'), { code: 'SOP08_EVIDENCE_PATH_INVALID' });
  await atomicJson(file, { schema_version: 1, artifact_type: 'BOL_RETAILER_API_EVIDENCE', sku, competitor_id: competitorId, provider: 'BOL_RETAILER_V10', method, request, http_status: apiHttpStatus(response), response_source: response?.source || null, cache_hit: response?.cacheHit === true, queried_at: queriedAt, raw_response: response?.rawResponse ?? null, structured_result: response?.structuredResult ?? null });
  return path.relative(root, file).replace(/\\/g, '/');
}

async function writeSop08RemoteErrorEvidence(dataRoot, sku, competitorId, method, failureRecord, request, observedAt) {
  const root = path.resolve(dataRoot);
  const filename = `${competitorId}-${method}-${crypto.createHash('sha256').update(`${observedAt}:${JSON.stringify(request)}:${JSON.stringify(failureRecord)}`).digest('hex').slice(0, 10)}.json`;
  const file = path.resolve(root, 'artifacts', 'listing', sku, 'sop08', 'evidence', filename);
  if (!file.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('SOP08 error evidence路径超出当前数据根。'), { code: 'SOP08_EVIDENCE_PATH_INVALID' });
  await atomicJson(file, { schema_version: 1, artifact_type: 'BOL_RETAILER_API_ERROR_EVIDENCE', sku,
    competitor_id: competitorId, provider: 'BOL_RETAILER_V10', method, request, http_status: failureRecord.http_status,
    response_received: failureRecord.response_received, outcome_status: 'NOT_AVAILABLE', observed_at: observedAt,
    failure: failureRecord });
  return path.relative(root, file).replace(/\\/g, '/');
}

function tagSop08RemoteRequestError(error, { candidateId, endpoint, method, requestParameters, startedAt, remoteMethod }) {
  if (!error || typeof error !== 'object') return error;
  Object.assign(error, { sop08_candidate_id: candidateId || null, sop08_endpoint: endpoint || null,
    sop08_method: method || null, sop08_request_parameters: requestParameters || null,
    sop08_started_at: startedAt || null, sop08_remote_method: remoteMethod || null });
  return error;
}

function currentSopExecutionId(dataRoot, sku, step = 'LISTING_SOP_08') {
  try {
    return dbFor(dataRoot).prepare(`SELECT execution_id FROM listing_execution_leases
      WHERE sku_id=? AND step=? AND state='RUNNING' ORDER BY started_at DESC LIMIT 1`).get(sku, step)?.execution_id || null;
  } catch { return null; }
}

function sop08InputVersions(task) {
  return {
    facts: task.outputs?.confirmed_product_facts?.version ?? null,
    sop03: task.listing_executor?.registry?.LISTING_SOP_03?.output_version ?? null,
    top20: task.listing_executor?.registry?.LISTING_SOP_07?.output_version ?? null,
  };
}

async function loadSop08Source(dataRoot, task) {
  const file = sop03ArtifactPath(dataRoot, task);
  const artifact = JSON.parse(await fs.readFile(file, 'utf8'));
  artifact.version = task.listing_executor.registry.LISTING_SOP_03.output_version;
  return { artifact, file };
}

function setSop08Waiting(task, { dependency = null, reason, dependencyStatus = 'WAITING', candidateManifestRef = null, status = 'WAITING_DEPENDENCY', dependencyFailedAt = null }) {
  const now = iso();
  task.current_step = 'LISTING_SOP_08'; task.resume_point = 'LISTING_SOP_08'; task.listing_sop.current_step_id = 'LISTING_SOP_08';
  task.status = status; task.waiting_dependency_key = status === 'WAITING_DEPENDENCY' ? dependency : null;
  if (dependency === 'BOL_API' && dependencyFailedAt) {
    task.dependency_failed_at = dependencyFailedAt;
    task.required_readiness_after = dependencyFailedAt;
  }
  task.activity_pool = status === 'WAITING_CONFIRMATION' || status === 'WAITING_DECISION' ? '待人工确认' : 'Listing 生成池'; task.current_pool = task.activity_pool;
  task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
  task.qa.LISTING_SOP_08 = { status: 'NOT_RUN', checked_at: null, report: null };
  task.stages.LISTING_SOP_08 = { ...task.stages.LISTING_SOP_08, status, dependency, dependency_status: dependencyStatus, waiting_reason: reason, updated_at: now };
  task.listing_sop.steps.LISTING_SOP_08 = { ...task.listing_sop.steps.LISTING_SOP_08, status, qa_status: 'NOT_RUN', waiting_reason: reason, updated_at: now };
  applyListingExecutorStep(task, 'LISTING_SOP_08', { status, waiting_reason: reason, resume_point: 'LISTING_SOP_08', input_version_refs: [
    { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: task.outputs?.confirmed_product_facts?.version ?? null },
    { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: task.listing_executor?.registry?.LISTING_SOP_03?.output_version ?? null },
    { artifact_type: 'LISTING_TOP20_VERSION', version: task.listing_executor?.registry?.LISTING_SOP_07?.output_version ?? null },
  ] });
  task.stages.LISTING_SOP_08 = { ...task.stages.LISTING_SOP_08, dependency, dependency_status: dependencyStatus, waiting_reason: reason, updated_at: now };
  task.listing_executor.registry.LISTING_SOP_08.waiting_reason = reason;
  task.listing_executor.registry.LISTING_SOP_08.evidence_refs = candidateManifestRef ? [...new Set([...(task.listing_executor.registry.LISTING_SOP_08.evidence_refs || []), candidateManifestRef])] : task.listing_executor.registry.LISTING_SOP_08.evidence_refs;
}

async function collectSop08CandidateEvidence(dataRoot, task, sourceArtifact, candidates) {
  const executionPlan = buildSop08ExistingEvaluationPlan(candidates);
  task.listing_executor ||= {};
  task.listing_executor.artifacts ||= {};
  const priorCandidateOwnPlacement = (task.listing_executor.artifacts.competitor_candidates || [])
    .find(item => item.own_category_evidence)?.own_category_evidence || null;
  const priorOwnPlacement = task.listing_executor?.artifacts?.own_product_placement
    || task.listing_executor?.artifacts?.own_category_evidence || task.outputs?.own_product_placement
    || priorCandidateOwnPlacement || null;
  const ownPlacementError = priorOwnPlacement?.error || priorOwnPlacement;
  const ownCategoriesEvidence = sop08OwnProductPlacementDisposition(ownPlacementError);
  ownCategoriesEvidence.historical_evidence_ref = priorOwnPlacement?.evidence_ref || null;
  task.listing_executor.artifacts.own_product_placement = {
    artifact_type: 'OWN_PRODUCT_PLACEMENT', ...clone(priorOwnPlacement || {}), ...ownCategoriesEvidence,
    applicability: 'NOT_APPLICABLE_FOR_COMPETITOR_POOL', affects_competitor_pool: false,
  };

  const sop03Rows = sourceArtifact.bol_local_source?.competitor_urls || [];
  for (const candidate of candidates) {
    const versions = sop08InputVersions(task);
    const resumed = (task.listing_executor?.artifacts?.competitor_candidates || []).find(item => item.competitor_id === candidate.competitor_id
      && item.input_versions?.facts === versions.facts && item.input_versions?.sop03 === versions.sop03 && item.input_versions?.top20 === versions.top20
      && item.existing_evaluation_status === 'EXISTING_CANDIDATE_EVALUATION_COMPLETE');
    if (resumed) { Object.assign(candidate, clone(resumed)); continue; }
    const sourceRow = sop03Rows.find(row => row.source_field === candidate.source_field);
    if (candidate.own_category_evidence) {
      // Older artifacts could have derived own-vs-competitor category from our
      // own Placement. Discard that derived status and remap from confirmed facts
      // plus the competitor's local evidence only.
      candidate.same_category = 'UNKNOWN';
      candidate.competitor_conditions = { ...(candidate.competitor_conditions || {}) };
      delete candidate.competitor_conditions.same_category;
      delete candidate.own_category_evidence;
    }
    Object.assign(candidate, {
      evaluation_type: 'EXISTING_COMPETITOR_EVALUATION',
      product_list_query: null,
      discovery_query: null,
      ean: candidate.ean || null,
      ean_status: candidate.ean ? 'CONFIRMED_FROM_SOURCE' : 'UNKNOWN',
      api_fields: {
        current_offer: candidate.offers_evidence ? 'AVAILABLE_FROM_SAVED_EVIDENCE' : 'NOT_AVAILABLE',
        ratings: candidate.ratings_evidence ? 'AVAILABLE_FROM_SAVED_EVIDENCE' : 'NOT_AVAILABLE',
        sales: candidate.sales_evidence?.status || 'NOT_AVAILABLE',
        latest_review_activity: candidate.latest_review_or_activity?.status || 'NOT_AVAILABLE',
      },
      status: candidate.bol_url ? 'READY_FOR_EVIDENCE_CLASSIFICATION' : 'INVALID_SOURCE_URL',
      assessment_status: 'LOCAL_EVIDENCE_REUSED',
      checked_at: iso(),
    });
    if (sourceRow) candidate.local_source_row = clone(sourceRow);
    candidate.own_product_placement = clone(ownCategoriesEvidence);
    candidate.evidence_refs = [...new Set([
      ...(candidate.evidence_refs || []),
      ...(candidate.local_evidence?.extractor?.evidence_refs || []).map(item => item.reference),
    ].filter(Boolean))];
    Object.assign(candidate, mapSop08LocalCompetitorEvidence(candidate, task.outputs?.confirmed_product_facts));
    Object.assign(candidate, classifyListingCompetitor(candidate));
    candidate.local_evidence_mapping_status = 'COMPLETE';
    const hasEan = Boolean(String(candidate.ean || '').trim());
    const closeRemoteField = (evidence, unavailableReason) => {
      if (evidence?.status === 'PASS') return { status: 'PASS', evidence_ref: evidence.evidence_ref || null, reason: null };
      if (['UNKNOWN', 'NOT_AVAILABLE', 'NOT_APPLICABLE'].includes(evidence?.status)) {
        return { status: evidence.status, evidence_ref: evidence.evidence_ref || null, reason: evidence.reason || unavailableReason };
      }
      if (['QUEUED', 'RUNNING', 'PENDING', 'ERROR', 'FAILED'].includes(evidence?.status)) {
        return { status: evidence.status, evidence_ref: evidence.evidence_ref || null, reason: evidence.reason || '远端 enrichment 尚未完成。' };
      }
      return { status: hasEan ? 'UNKNOWN' : 'NOT_AVAILABLE', evidence_ref: evidence?.evidence_ref || null,
        reason: hasEan ? unavailableReason : '缺少可用于市场字段核验的竞品 EAN。' };
    };
    candidate.remote_enrichment_fields = {
      current_offer: closeRemoteField(candidate.offers_evidence, '未取得可追溯的当前 Offer enrichment；字段显式收口为 UNKNOWN。'),
      ratings: closeRemoteField(candidate.ratings_evidence, '未取得可追溯的 Ratings enrichment；字段显式收口为 UNKNOWN。'),
      sales_or_heat: closeRemoteField(candidate.sales_evidence || candidate.heat_evidence,
        '当前可用来源没有可验证的销量/热度数据；字段显式收口为 NOT_AVAILABLE。'),
      recent_activity: closeRemoteField(candidate.latest_review_or_activity,
        '当前可用来源没有近期评论/活动时间；字段显式收口为 NOT_AVAILABLE。'),
    };
    candidate.pending_remote_subtasks ||= [];
    if (!completeSop08ExistingCandidateEvaluation(candidate)) {
      candidate.existing_evaluation_status = 'EXISTING_CANDIDATE_EVALUATION_PENDING';
      candidate.existing_evaluation_complete = false;
    }
  }
  return { candidates, ownCategoriesEvidence, existingEvaluationPlan: executionPlan };
}

async function reclassifySop08PersistedCandidates(dataRoot, task, candidates) {
  task.listing_executor.artifacts.sop08_discovery_candidates ||= [];
  task.listing_executor.artifacts.sop08_unresolved_discoveries ||= [];
  const versions = sop08InputVersions(task);

  // Reuse persisted discovery evidence before considering another query. Older
  // runs stored insufficient-evidence rows in a manual-confirmation list; V5
  // deterministically reclassifies those rows and keeps the original list as
  // an audit trail, without repeating Placement/Offers/Ratings.
  const priorDiscoveryRows = [
    ...(task.listing_executor.artifacts.competitor_candidates || []),
    ...(task.listing_executor.artifacts.sop08_unresolved_discoveries || []),
  ].filter(item => item?.source_field === 'SOP07_CORE_PRODUCT_DISCOVERY'
    && (item.input_versions?.facts ?? item.facts_version) === versions.facts
    && (item.input_versions?.top20 ?? item.top20_version) === versions.top20
    && (item.input_versions?.sop03 == null || item.input_versions.sop03 === versions.sop03));
  const currentIds = new Set(candidates.map(item => item.competitor_id).filter(Boolean));
  let reclassifiedCount = 0;
  for (const prior of priorDiscoveryRows) {
    if (!prior.competitor_id || currentIds.has(prior.competitor_id)) continue;
    const restored = classifyListingCompetitor(mapSop08LocalCompetitorEvidence(clone(prior), task.outputs?.confirmed_product_facts));
    restored.assessment_status = restored.classification === 'UNQUALIFIED_INSUFFICIENT_EVIDENCE'
      ? 'UNQUALIFIED_INSUFFICIENT_EVIDENCE' : 'COMPLETE';
    if (restored.classification === 'UNQUALIFIED_INSUFFICIENT_EVIDENCE') restored.status = 'UNQUALIFIED_INSUFFICIENT_EVIDENCE';
    candidates.push(restored);
    currentIds.add(restored.competitor_id);
    const discovery = task.listing_executor.artifacts.sop08_discovery_candidates.find(item => item.competitor_id === restored.competitor_id);
    if (discovery) Object.assign(discovery, { status: 'ASSESSED', assessment_status: restored.assessment_status,
      classification: restored.classification, classification_reason: restored.classification_reason,
      condition_evidence: restored.competitor_conditions, evidence_refs: restored.evidence_refs || [], assessed_at: iso(),
      waiting_reason: null });
    for (const historical of task.listing_executor.artifacts.sop08_unresolved_discoveries) {
      if (historical.competitor_id === restored.competitor_id && !historical.v5_reclassification) {
        historical.v5_reclassification = { status: 'RECLASSIFIED_NO_LEON_DECISION', classification: restored.classification,
          reason: restored.classification_reason, at: iso() };
      }
    }
    reclassifiedCount += 1;
  }
  if (reclassifiedCount) {
    task.listing_executor.artifacts.competitor_candidates = clone(candidates);
    await commit(dataRoot, task, 'SOP08_LEGACY_CANDIDATES_RECLASSIFIED_V5', {
      step: 'LISTING_SOP_08', reclassified_count: reclassifiedCount, manual_confirmation_required: false,
      product_list_requests: 0, placement_requests: 0, enrichment_requests: 0,
    });
  }
  return { candidates, reclassified_count: reclassifiedCount };
}

function refreshSop08SupplementCheckpoint(task, top20Artifact) {
  const initialCheckpoint = task.listing_executor?.artifacts?.sop08_execution;
  if (!checkpoint || checkpoint.phase !== 'REMOTE_SUPPLEMENT') return checkpoint || null;
  const versions = checkpoint.input_versions || {};
  const queries = task.listing_executor?.artifacts?.sop08_discovery_queries || [];
  const completedQueries = queries.filter(item => item.status === 'PASS'
    && item.input_versions?.facts === versions.facts && item.input_versions?.top20 === versions.top20)
    .map(item => item.exact_string);
  const candidates = task.listing_executor?.artifacts?.competitor_candidates || [];
  const processed = candidates.filter(item => item.existing_evaluation_status === 'EXISTING_CANDIDATE_EVALUATION_COMPLETE'
    || ['COMPLETE', 'UNQUALIFIED_INSUFFICIENT_EVIDENCE'].includes(item.assessment_status))
    .map(item => item.competitor_id).filter(Boolean);
  checkpoint.processed_candidate_ids = [...new Set([...(checkpoint.processed_candidate_ids || []), ...processed])];
  checkpoint.processed_candidate_count = checkpoint.processed_candidate_ids.length;
  checkpoint.candidate_cursor = checkpoint.processed_candidate_count;
  checkpoint.candidate_count = candidates.length;
  checkpoint.usable_primary_pool_count = shouldSupplementSop08(candidates).usable_primary_pool_count;
  checkpoint.processed_discovery_queries = [...new Set([...(checkpoint.processed_discovery_queries || []), ...completedQueries])];
  checkpoint.remaining_discovery_queries = checkpoint.usable_primary_pool_count >= 3 ? []
    : selectSop08DiscoveryQueries(top20Artifact, { alreadyQueried: completedQueries }).map(item => item.exact_string);
  checkpoint.updated_at = iso();
  return checkpoint;
}

async function readSop08SavedProductListEvidence(dataRoot, task, query, attempt, versions) {
  const root = path.resolve(dataRoot);
  const reference = attempt?.evidence_ref;
  if (typeof reference !== 'string' || !reference.trim()) {
    throw Object.assign(new Error(`SOP08 ${query.exact_string} 缺少已保存的 Product List evidence ref。`), { code: 'SOP08_DISCOVERY_EVIDENCE_MISSING' });
  }
  const file = path.resolve(root, reference);
  if (!file.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error(`SOP08 ${query.exact_string} evidence ref 越出当前 SKU dataRoot。`), { code: 'SOP08_DISCOVERY_EVIDENCE_PATH_INVALID' });
  }
  const bytes = await fs.readFile(file);
  const evidence = JSON.parse(bytes.toString('utf8'));
  const rawProducts = evidence?.raw_response?.products;
  const identityMatches = evidence?.artifact_type === 'BOL_RETAILER_API_EVIDENCE'
    && evidence?.sku === task.sku && Number(evidence?.http_status) === 200
    && evidence?.request?.country_code === 'NL'
    && evidence?.request?.exact_query === query.exact_string
    && Number(evidence?.request?.facts_version) === Number(versions.facts)
    && evidence?.request?.top20_version === versions.top20
    && Number(attempt?.http_status) === 200
    && attempt?.request_parameters?.countryCode === 'NL'
    && attempt?.request_parameters?.searchTerm === query.exact_string
    && attempt?.input_versions?.facts === versions.facts
    && attempt?.input_versions?.top20 === versions.top20;
  if (!identityMatches || !Array.isArray(rawProducts)) {
    throw Object.assign(new Error(`SOP08 ${query.exact_string} 保存的 Product List evidence 与 SKU/query/version/HTTP200 不匹配。`), { code: 'SOP08_DISCOVERY_EVIDENCE_IDENTITY_MISMATCH' });
  }
  return { evidence, products: rawProducts, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function verifySop08SourceLineage(dataRoot, task, artifact, expectedVersions) {
  const root = path.resolve(dataRoot);
  const sop03RegistryRefs = new Set((task.listing_executor?.registry?.LISTING_SOP_03?.evidence_refs || [])
    .map(reference => String(reference).replace(/\\/g, '/')));
  const sop03Cache = new Map();
  const failures = [];
  for (const item of artifact?.candidates || []) {
    const ref = item.source_ref || {};
    if (ref.source_field === 'SOP07_CORE_PRODUCT_DISCOVERY') {
      const query = (artifact.discovery?.queries || []).find(row => row.exact_string === item.discovery_query
        && row.evidence_ref === ref.product_list_evidence_ref && row.status === 'PASS');
      const official = canonicalizeSop08BolUrl(item.bol_url || ref.exact_url);
      if (!query || !official.canonical_url || official.canonical_url !== ref.exact_url
        || !item.evidence_refs?.includes(ref.product_list_evidence_ref)) {
        failures.push({ competitor_id: item.competitor_id, reason: 'DISCOVERED_CANDIDATE_SOURCE_LINK_MISMATCH' });
      }
      continue;
    }
    const reference = String(ref.sop03_artifact_ref || '').replace(/\\/g, '/');
    if (!reference || !sop03RegistryRefs.has(reference) || ref.sop03_artifact_version !== expectedVersions?.sop03
      || item.input_versions?.sop03 !== expectedVersions?.sop03) {
      failures.push({ competitor_id: item.competitor_id, reason: 'SOP03_VERSION_OR_REFERENCE_MISMATCH' });
      continue;
    }
    let sop03 = sop03Cache.get(reference);
    if (!sop03) {
      const sourcePath = path.resolve(root, reference);
      if (!sourcePath.startsWith(`${root}${path.sep}`)) {
        failures.push({ competitor_id: item.competitor_id, reason: 'SOP03_REFERENCE_OUTSIDE_DATAROOT' });
        continue;
      }
      try {
        sop03 = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
        sop03Cache.set(reference, sop03);
      } catch {
        failures.push({ competitor_id: item.competitor_id, reason: 'SOP03_ARTIFACT_UNREADABLE' });
        continue;
      }
    }
    const sourceRow = (sop03?.bol_local_source?.competitor_urls || []).find(row => row.source_field === ref.source_field
      && String(row.source_cell || '') === String(ref.source_cell || ''));
    const rawUrl = String(sourceRow?.exact_url ?? sourceRow?.raw_url ?? '').trim();
    const resolved = canonicalizeSop08BolUrl(rawUrl);
    const sourceMatches = sop03?.sku === task.sku && sop03.artifact_type === 'SOP03_SOURCE_DISCOVERY_VERSION'
      && sop03.version == null && sop03RegistryRefs.has(reference)
      && rawUrl && rawUrl === String(ref.raw_url || '').trim()
      && resolved.canonical_url === (ref.exact_url || null)
      && resolved.reason === (ref.url_resolution_reason || null)
      && (!ref.source_file_hash || ref.source_file_hash === sop03.source_file_hash)
      && item.evidence_refs?.includes(reference);
    if (!sourceMatches) failures.push({ competitor_id: item.competitor_id, reason: 'SOURCE_ROW_ORIGINAL_URL_MISMATCH' });
  }
  return { pass: failures.length === 0, failures };
}

async function collectSop08SupplementalCandidates(dataRoot, task, top20Artifact, candidates, ownCategoriesEvidence) {
  task.listing_executor.artifacts.sop08_discovery_queries ||= [];
  task.listing_executor.artifacts.sop08_discovery_candidates ||= [];
  task.listing_executor.artifacts.sop08_unresolved_discoveries ||= [];
  task.listing_executor.artifacts.sop08_duplicate_discoveries ||= [];
  task.listing_executor.artifacts.competitor_candidates ||= [];
  const versions = sop08InputVersions(task);

  const initialPool = shouldSupplementSop08(candidates);
  if (!initialPool.should_supplement) {
    return { candidates, queries: [], unresolved: [], exhausted: false, skipped_reason: 'INITIAL_EFFECTIVE_POOL_AT_LEAST_3' };
  }
  const client = bolClientFor(dataRoot);
  const priorCandidates = [...candidates];
  const recoveryPlan = planSop08DiscoveryQueryRecovery({
    top20Artifact,
    queryAttempts: task.listing_executor.artifacts.sop08_discovery_queries,
    factsVersion: versions.facts,
    top20Version: versions.top20,
  });
  const completedQueries = recoveryPlan.completed_exact_strings;
  const queryPlan = recoveryPlan.ordered_queries;
  const processedQueries = new Set(completedQueries);
  const effectiveCount = () => shouldSupplementSop08(candidates).usable_primary_pool_count;

  // Query one SOP07 term at a time. A query is fully deduplicated, resolved,
  // enriched, and classified before selecting the next term.
  for (let index = 0; index < queryPlan.length; index += 1) {
    const query = nextSop08DiscoveryQuery(top20Artifact, { alreadyQueried: [...processedQueries], effectiveCount: effectiveCount() });
    if (!query || sop08ShouldStopSupplementing({ effectiveCount: effectiveCount(), remainingQueryCount: queryPlan.length - index })) break;
    processedQueries.add(query.exact_string);
    let attempt = task.listing_executor.artifacts.sop08_discovery_queries.find(item => item.exact_string === query.exact_string
      && item.input_versions?.facts === versions.facts && item.input_versions?.top20 === versions.top20);
    let products = null;
    if (['RESULT_SAVED', 'RUNNING'].includes(attempt?.status) && attempt.evidence_ref) {
      const saved = await readSop08SavedProductListEvidence(dataRoot, task, query, attempt, versions);
      products = saved.products;
      attempt.recovered_from_saved_result = true;
      attempt.saved_evidence_sha256 = saved.sha256;
      attempt.processing_resumed_at = iso();
    } else {
      if (!attempt) {
        attempt = { exact_string: query.exact_string, rank: query.rank, boloo_search_volume: query.boloo_search_volume,
          keyword_category: query.keyword_category, status: 'RUNNING', attempt: 1,
          input_versions: { facts: versions.facts, top20: versions.top20 }, started_at: iso(),
          execution_id: currentSopExecutionId(dataRoot, task.sku), request_id: crypto.randomUUID(),
          endpoint: '/retailer/products/list', method: 'POST',
          request_parameters: { countryCode: 'NL', searchTerm: query.exact_string, page: 1, cacheMode: 'CACHE_OK' } };
        task.listing_executor.artifacts.sop08_discovery_queries.push(attempt);
      } else {
        attempt.status = 'RUNNING'; attempt.attempt = Number(attempt.attempt || 0) + 1; attempt.started_at = iso();
        attempt.execution_id = currentSopExecutionId(dataRoot, task.sku);
        attempt.request_id = crypto.randomUUID();
        attempt.endpoint = '/retailer/products/list'; attempt.method = 'POST';
        attempt.request_parameters = { countryCode: 'NL', searchTerm: query.exact_string, page: 1, cacheMode: 'CACHE_OK' };
      }
      await commit(dataRoot, task, 'SOP08_SUPPLEMENT_PRODUCT_LIST_STARTED', {
        step: 'LISTING_SOP_08', exact_string: query.exact_string, rank: query.rank,
        formal_boloo_volume: query.boloo_search_volume, facts_version: versions.facts,
        top20_version: versions.top20, attempt: attempt.attempt, execution_id: attempt.execution_id,
        request_id: attempt.request_id, endpoint: attempt.endpoint, method: attempt.method,
        request_parameters: attempt.request_parameters,
      });
      const queriedAt = iso(); attempt.started_at = queriedAt;
      try {
        const response = await client.getProductList({ countryCode: 'NL', searchTerm: query.exact_string, page: 1, cacheMode: 'CACHE_OK' });
        const evidenceId = `DISCOVERY-${crypto.createHash('sha256').update(`${task.sku}\0${query.exact_string}`).digest('hex').slice(0, 16)}`;
        const evidenceRef = await writeSop08Evidence(dataRoot, task.sku, evidenceId, 'SUPPLEMENT_PRODUCT_LIST', response,
          { country_code: 'NL', exact_query: query.exact_string, facts_version: versions.facts, top20_version: versions.top20,
            top20_rank: query.rank, formal_boloo_volume: query.boloo_search_volume }, queriedAt);
        products = Array.isArray(response.rawResponse?.products) ? response.rawResponse.products : [];
        Object.assign(attempt, { status: 'RESULT_SAVED', evidence_ref: evidenceRef, http_status: apiHttpStatus(response),
          cache_hit: response.cacheHit === true, queried_at: queriedAt, returned_count: products.length, completed_at: iso() });
        await commit(dataRoot, task, 'SOP08_SUPPLEMENT_PRODUCT_LIST_SAVED', {
          step: 'LISTING_SOP_08', exact_string: query.exact_string, evidence_ref: evidenceRef,
          http_status: attempt.http_status, returned_count: products.length, cache_hit: attempt.cache_hit,
        });
      } catch (error) {
        attempt.status = 'WAITING_DEPENDENCY'; attempt.error_code = error?.code || 'BOL_PRODUCT_LIST_FAILED';
        attempt.failed_at = iso();
        attempt.failure = buildSop08RemoteFailureRecord({ error, executionId: attempt.execution_id,
          requestId: attempt.request_id, endpoint: attempt.endpoint, method: attempt.method,
          requestParameters: attempt.request_parameters, startedAt: attempt.started_at, finishedAt: attempt.failed_at });
        error.sop08_failure_record = clone(attempt.failure);
        error.sop08_candidate_id = `DISCOVERY:${query.exact_string}`;
        error.sop08_remote_method = 'PRODUCT_LIST_SUPPLEMENT'; error.sop08_discovery_query = query.exact_string;
        error.sop08_request_id = attempt.request_id; error.sop08_request_parameters = attempt.request_parameters;
        throw error;
      }
    }

    const listEvidenceRef = attempt.evidence_ref;
    const uniqueProductRows = [];
    const rawBatchSeen = [];
    const rawBatchDuplicates = [];
    for (const [productIndex, product] of products.entries()) {
      const productIdentity = {
        bol_product_id: String(product?.bolProductId || product?.productId || '').trim() || null,
        eans: [...new Set((Array.isArray(product?.eans) ? product.eans : []).map(item => String(item?.ean || '').trim()).filter(Boolean))],
      };
      const duplicate = findSop08DuplicateCandidate(productIdentity, rawBatchSeen);
      if (duplicate) {
        rawBatchDuplicates.push({ product, productIndex, duplicateOf: duplicate.product_list_rank ?? duplicate.product_index ?? null });
        continue;
      }
      uniqueProductRows.push({ product, productIndex });
      rawBatchSeen.push({ ...productIdentity, product_list_rank: product.rank ?? productIndex + 1, product_index: productIndex });
    }
    const productDiscoveryRecords = uniqueProductRows.map(({ product, productIndex }) => {
      const eans = [...new Set((Array.isArray(product?.eans) ? product.eans : []).map(item => String(item?.ean || '').trim()).filter(Boolean))];
      const identity = String(product?.bolProductId || product?.productId || eans.join(',') || product?.title || productIndex);
      const discoveryCandidateId = `S08D-${crypto.createHash('sha256').update(`${task.sku}\0${query.exact_string}\0${identity}`).digest('hex').slice(0, 18)}`;
      const record = task.listing_executor.artifacts.sop08_discovery_candidates.find(item => item.discovery_candidate_id === discoveryCandidateId)
        || { discovery_candidate_id: discoveryCandidateId, candidate_status: 'DISCOVERED_CANDIDATE', facts_version: versions.facts,
          top20_version: versions.top20, discovery_query: query.exact_string, query_rank: query.rank, product_list_rank: product.rank ?? productIndex + 1,
          title: String(product?.title || '').trim() || null, bol_product_id: String(product?.bolProductId || product?.productId || '').trim() || null,
          ean: eans[0] || null, eans, product_list_evidence_ref: listEvidenceRef,
          url_resolution_status: eans.length ? 'PENDING_RESOLUTION' : 'FAILED',
          url_resolution_reason: eans.length ? null : 'PRODUCT_LIST_ROW_HAS_NO_EAN', status: 'DISCOVERED_CANDIDATE',
          sales_evidence: { status: 'NOT_AVAILABLE', reason: 'Product List rank/page presence is not sales evidence.' },
          heat_evidence: { status: 'NOT_AVAILABLE', reason: 'Product List rank/page presence is not heat evidence.' }, created_at: iso() };
      if (!task.listing_executor.artifacts.sop08_discovery_candidates.some(item => item.discovery_candidate_id === discoveryCandidateId)) {
        task.listing_executor.artifacts.sop08_discovery_candidates.push(record);
      }
      return record;
    });
    for (const duplicate of rawBatchDuplicates) {
      task.listing_executor.artifacts.sop08_duplicate_discoveries.push({
        title: String(duplicate.product?.title || '').trim() || null,
        ean: duplicate.product?.eans?.[0]?.ean || null,
        bol_product_id: String(duplicate.product?.bolProductId || duplicate.product?.productId || '').trim() || null,
        product_list_rank: duplicate.product?.rank ?? duplicate.productIndex + 1,
        duplicate_of_product_list_rank: duplicate.duplicateOf,
        discovery_query: query.exact_string, status: 'DUPLICATE_WITHIN_PRODUCT_LIST_BATCH', checked_at: iso(),
        dedupe_stage: 'PRODUCT_LIST_BATCH_BEFORE_PLACEMENT',
      });
      await commit(dataRoot, task, 'SOP08_PRODUCT_CANDIDATE_DEDUPED', {
        step: 'LISTING_SOP_08', exact_string: query.exact_string,
        product_list_rank: duplicate.product?.rank ?? duplicate.productIndex + 1,
        duplicate_of_product_list_rank: duplicate.duplicateOf,
        dedupe_stage: 'PRODUCT_LIST_BATCH_BEFORE_PLACEMENT', placement_skipped: true,
      });
    }
    attempt.discovered_candidate_ids = productDiscoveryRecords.map(item => item.discovery_candidate_id);
    await commit(dataRoot, task, 'SOP08_PRODUCT_LIST_CANDIDATES_RECORDED', { step: 'LISTING_SOP_08', exact_string: query.exact_string,
      evidence_ref: listEvidenceRef, discovered_candidate_count: productDiscoveryRecords.length,
      unresolved_ean_count: productDiscoveryRecords.filter(item => !(item.eans || []).length).length,
      product_list_rank_used_as_sales_or_heat: false });

    // Deduplicate the entire Product List batch using known product IDs/EANs
    // before any Placement call. Placement remains the URL authority; it is only
    // requested for identities that cannot be matched from the batch evidence.
    const batchSeen = [...priorCandidates];
    const batchUniqueIds = new Set();
    for (const record of productDiscoveryRecords) {
      const savedAssessment = task.listing_executor.artifacts.competitor_candidates.find(item => item.competitor_id === record.competitor_id
        && item.input_versions?.facts === versions.facts && item.input_versions?.sop03 === versions.sop03
        && item.input_versions?.top20 === versions.top20
        && ['COMPLETE', 'UNQUALIFIED_INSUFFICIENT_EVIDENCE'].includes(item.assessment_status)
        && item.classification);
      if (savedAssessment) {
        Object.assign(record, { status: 'ASSESSED', assessment_status: savedAssessment.assessment_status,
          classification: savedAssessment.classification, classification_reason: savedAssessment.classification_reason,
          competitor_id: savedAssessment.competitor_id, condition_evidence: savedAssessment.competitor_conditions,
          evidence_refs: savedAssessment.evidence_refs || [], assessed_at: savedAssessment.checked_at || iso(),
          reused_assessment: true });
        if (!candidates.some(item => item.competitor_id === savedAssessment.competitor_id)) candidates.push(clone(savedAssessment));
        if (!priorCandidates.some(item => item.competitor_id === savedAssessment.competitor_id)) priorCandidates.push(clone(savedAssessment));
        continue;
      }
      const duplicate = findSop08DuplicateCandidate(record, batchSeen);
      if (duplicate) {
        record.status = 'DUPLICATE_OF_EXISTING_CANDIDATE';
        record.duplicate_of = duplicate.competitor_id || duplicate.discovery_candidate_id || null;
        task.listing_executor.artifacts.sop08_duplicate_discoveries.push({
          discovery_candidate_id: record.discovery_candidate_id, bol_product_id: record.bol_product_id || null,
          ean: record.ean || null, title: record.title || null, discovery_query: query.exact_string,
          status: 'DUPLICATE_OF_EXISTING_CANDIDATE', duplicate_of: record.duplicate_of, checked_at: iso(),
          dedupe_stage: 'PRODUCT_LIST_BATCH_BEFORE_PLACEMENT',
        });
        await commit(dataRoot, task, 'SOP08_PRODUCT_CANDIDATE_DEDUPED', {
          step: 'LISTING_SOP_08', discovery_candidate_id: record.discovery_candidate_id,
          duplicate_of: record.duplicate_of, exact_string: query.exact_string,
          dedupe_stage: 'PRODUCT_LIST_BATCH_BEFORE_PLACEMENT', placement_skipped: true,
        });
        continue;
      }
      batchUniqueIds.add(record.discovery_candidate_id);
      batchSeen.push(record);
    }
    for (const [batchIndex, { product, productIndex }] of uniqueProductRows.entries()) {
      if (Number(effectiveCount()) >= 3) break;
      const eans = [...new Set((Array.isArray(product?.eans) ? product.eans : []).map(item => String(item?.ean || '').trim()).filter(Boolean))];
      const discoveryRecord = productDiscoveryRecords[batchIndex];
      if (!batchUniqueIds.has(discoveryRecord.discovery_candidate_id)) continue;
      if (!eans.length) continue;
      let resolved = discoveryRecord.url_resolution_status === 'RESOLVED' && bolProductIdFromDetailUrl(discoveryRecord.bol_url)
        ? { ean: discoveryRecord.resolved_ean, officialUrl: discoveryRecord.bol_url, productId: discoveryRecord.bol_product_id,
          placement: { url: discoveryRecord.bol_url, categories: discoveryRecord.placement_categories || [], categoryIds: discoveryRecord.placement_category_ids || [] },
          placementRef: discoveryRecord.placement_evidence_ref }
        : null;
      for (const ean of eans) {
        if (resolved) break;
        const placementAt = iso();
        try {
          const placementResponse = await client.getProductPlacement({ ean, countryCode: 'NL', cacheMode: 'CACHE_OK' });
          const officialUrl = String(placementResponse?.structuredResult?.url || '').trim();
          const productId = bolProductIdFromDetailUrl(officialUrl);
          if (!productId) continue;
          const candidateId = `BOL-${crypto.createHash('sha256').update(`${task.sku}\0${officialUrl}`).digest('hex').slice(0, 20)}`;
          const placementRef = await writeSop08Evidence(dataRoot, task.sku, candidateId, 'SUPPLEMENT_PRODUCT_PLACEMENT', placementResponse,
            { ean, country_code: 'NL', discovery_query: query.exact_string }, placementAt);
          resolved = { ean, officialUrl, productId, placement: placementResponse.structuredResult, placementRef };
          Object.assign(discoveryRecord, { url_resolution_status: 'RESOLVED', bol_url: officialUrl, bol_product_id: productId, resolved_ean: ean,
            placement_evidence_ref: placementRef, placement_categories: placementResponse.structuredResult?.categories || [],
            placement_category_ids: normalizedCategoryIds(placementResponse.structuredResult), url_resolved_at: placementAt });
          break;
        } catch (error) {
          tagSop08RemoteRequestError(error, { candidateId: discoveryRecord.discovery_candidate_id,
            endpoint: `/retailer/products/${encodeURIComponent(ean)}/placement`, method: 'GET',
            requestParameters: { ean, countryCode: 'NL' }, startedAt: placementAt, remoteMethod: 'PRODUCT_PLACEMENT_SUPPLEMENT' });
          if (Number(error?.status) === 404) {
            discoveryRecord.url_resolution_status = 'FAILED'; discoveryRecord.url_resolution_reason = 'PRODUCT_PLACEMENT_NOT_FOUND';
            discoveryRecord.url_resolution_checked_at = placementAt;
            task.listing_executor.artifacts.sop08_unresolved_discoveries.push({ status: 'URL_RESOLUTION_FAILED', reason_code: 'PRODUCT_PLACEMENT_NOT_FOUND', ean, title: product.title || null, discovery_query: query.exact_string, facts_version: versions.facts, top20_version: versions.top20, checked_at: placementAt });
            continue;
          }
          error.sop08_candidate_id = `DISCOVERY:${query.exact_string}:${ean}`;
          error.sop08_remote_method = 'PRODUCT_PLACEMENT_SUPPLEMENT'; error.sop08_discovery_query = query.exact_string;
          throw error;
        }
      }
      if (!resolved) {
        if (eans.length && discoveryRecord.url_resolution_status === 'FAILED') {
          discoveryRecord.status = 'URL_RESOLUTION_FAILED';
          await commit(dataRoot, task, 'SOP08_PRODUCT_CANDIDATE_URL_RESOLUTION_FAILED', { step: 'LISTING_SOP_08', discovery_candidate_id: discoveryRecord.discovery_candidate_id, eans, discovery_query: query.exact_string, reason_code: 'PRODUCT_PLACEMENT_NOT_FOUND' });
        }
        continue;
      }

      const provisional = { competitor_id: `BOL-${crypto.createHash('sha256').update(`${task.sku}\0${resolved.officialUrl}`).digest('hex').slice(0, 20)}`,
        bol_product_id: resolved.productId, ean: resolved.ean, bol_url: resolved.officialUrl };
      const duplicateAfterPlacement = findSop08DuplicateCandidate(provisional, priorCandidates);
      if (duplicateAfterPlacement) {
        discoveryRecord.status = 'DUPLICATE_OF_EXISTING_CANDIDATE';
        discoveryRecord.duplicate_of = duplicateAfterPlacement.competitor_id || duplicateAfterPlacement.discovery_candidate_id || null;
        task.listing_executor.artifacts.sop08_duplicate_discoveries.push({ bol_url: resolved.officialUrl, bol_product_id: resolved.productId, ean: resolved.ean, title: product.title || null, discovery_query: query.exact_string, status: 'DUPLICATE_OF_EXISTING_CANDIDATE', duplicate_of: discoveryRecord.duplicate_of, checked_at: iso(), dedupe_stage: 'OFFICIAL_URL_AFTER_PLACEMENT' });
        await commit(dataRoot, task, 'SOP08_PRODUCT_CANDIDATE_DEDUPED', { step: 'LISTING_SOP_08', discovery_candidate_id: discoveryRecord.discovery_candidate_id, duplicate_of: discoveryRecord.duplicate_of, official_url: resolved.officialUrl, dedupe_stage: 'OFFICIAL_URL_AFTER_PLACEMENT' });
        continue;
      }

      const candidate = {
        competitor_id: provisional.competitor_id, candidate_status: 'DISCOVERED_CANDIDATE', proposed_type: 'DISCOVERED_CANDIDATE',
        source_field: 'SOP07_CORE_PRODUCT_DISCOVERY', source_header: 'SOP07 CORE_PRODUCT exact string', source_cell: null,
        bol_url: resolved.officialUrl, bol_url_official: resolved.officialUrl, bol_product_id: resolved.productId, ean: resolved.ean,
        title: String(product.title || '').trim() || null, title_source: 'BOL_PRODUCT_LIST',
        discovery_query: query.exact_string, product_list_rank: product.rank ?? productIndex + 1,
        discovery_provenance: { sop07_version: versions.top20, exact_string: query.exact_string, rank: query.rank,
          boloo_search_volume: query.boloo_search_volume, product_list_evidence_ref: listEvidenceRef, facts_version: versions.facts },
        url_status: 'RESOLVED_OFFICIAL_PLACEMENT_URL', current_sale_status: 'NOT_CONFIRMED',
        same_category: 'UNKNOWN', same_use_case: 'UNKNOWN', price_band_fit: 'UNKNOWN', comparable_positioning: 'UNKNOWN',
        listing_stability: 'NOT_CONFIRMED', classification: null, classification_reason: null,
        current_price: null, price_status: 'NOT_CONFIRMED', rating: null, rating_status: 'NOT_CONFIRMED', review_count: null,
        latest_review_or_activity: { status: 'NOT_AVAILABLE', reason: '当前Retailer API没有近期评论/活动时间字段。' },
        sales_evidence: { status: 'NOT_AVAILABLE', reason: 'Product List rank/page presence is discovery evidence only, not sales or heat evidence.' },
        heat_evidence: { status: 'NOT_AVAILABLE', reason: 'Product List rank/page presence, review count, and Offer count are not used as sales/heat evidence.', evidence_refs: [] },
        product_placement: { status: 'RESOLVED', url: resolved.officialUrl, categories: resolved.placement?.categories || [], category_ids: normalizedCategoryIds(resolved.placement), evidence_ref: resolved.placementRef },
        product_list_evidence: { query: query.exact_string, provider: 'BOL_RETAILER_V10_PRODUCT_LIST', http_status: attempt.http_status,
          cache_hit: attempt.cache_hit, observed_at: attempt.queried_at, returned_count: attempt.returned_count, matched_title: product.title || null, matched_ean: resolved.ean, evidence_ref: listEvidenceRef },
        offers_evidence: null, ratings_evidence: null,
        source_ref: { sop03_artifact_type: 'LISTING_SOP_07_TOP20_VERSION', sop03_artifact_version: null, source_file: null, source_file_hash: null,
          import_version: null, source_field: 'SOP07_CORE_PRODUCT_DISCOVERY', source_header: 'SOP07 CORE_PRODUCT exact string', source_cell: null,
          exact_url: resolved.officialUrl, discovery_query: query.exact_string, facts_version: versions.facts,
          top20_version: versions.top20, product_list_evidence_ref: listEvidenceRef },
        input_versions: { facts: versions.facts, sop03: versions.sop03, top20: versions.top20 },
        evidence_refs: [...new Set([listEvidenceRef, resolved.placementRef, ...(task.listing_executor.registry.LISTING_SOP_07.evidence_refs || []).slice(0, 1)])],
        checked_at: iso(), status: 'DISCOVERED_CANDIDATE', assessment_status: 'RUNNING',
      };
      candidate.own_product_placement = clone(ownCategoriesEvidence || sop08OwnProductPlacementDisposition());
      Object.assign(candidate, mapSop08LocalCompetitorEvidence(candidate, task.outputs?.confirmed_product_facts));

      const offersAt = iso();
      const offersRequest = { ean: resolved.ean, countryCode: 'NL', page: 1 };
      let offers;
      try {
        offers = await client.getOffers({ ...offersRequest, cacheMode: 'CACHE_OK' });
      } catch (error) {
        throw tagSop08RemoteRequestError(error, { candidateId: candidate.competitor_id,
          endpoint: `/retailer/products/${encodeURIComponent(resolved.ean)}/offers`, method: 'GET',
          requestParameters: offersRequest, startedAt: offersAt, remoteMethod: 'OFFERS_SUPPLEMENT' });
      }
      const offersRef = await writeSop08Evidence(dataRoot, task.sku, candidate.competitor_id, 'OFFERS', offers, { ean: resolved.ean, country_code: 'NL', page: 1 }, offersAt);
      const offerRows = offers.structuredResult?.offers || [];
      const prices = offerRows.map(row => numericPrice(row.price)).filter(value => value != null);
      candidate.current_sale_status = offerRows.length ? 'ON_SALE' : 'NOT_ON_SALE';
      candidate.current_price = prices.length ? { min: Math.min(...prices), max: Math.max(...prices), currency: 'EUR', offer_count: offerRows.length } : null;
      candidate.price_status = prices.length ? 'CONFIRMED' : 'NOT_CONFIRMED';
      candidate.offers_evidence = { status: 'PASS', http_status: apiHttpStatus(offers), cache_hit: offers.cacheHit === true, observed_at: offersAt, active_offer_count: offerRows.length, offer_count_with_price: prices.length, evidence_ref: offersRef };
      candidate.evidence_refs.push(offersRef);

      const ratingsAt = iso();
      const ratingsRequest = { ean: resolved.ean, countryCode: 'NL' };
      const savedRatingsFailure = resolveSop08SavedRatingsNotFound(task, resolved.ean);
      let ratingsUnavailableRef = null;
      let ratings = null;
      if (savedRatingsFailure) {
        const failureRecord = buildSop08RemoteFailureRecord({ error: savedRatingsFailure,
          executionId: savedRatingsFailure.execution_id, requestId: savedRatingsFailure.request_id,
          endpoint: savedRatingsFailure.endpoint, method: 'GET', requestParameters: ratingsRequest,
          startedAt: savedRatingsFailure.started_at, finishedAt: savedRatingsFailure.finished_at });
        ratingsUnavailableRef = await writeSop08RemoteErrorEvidence(dataRoot, task.sku, candidate.competitor_id,
          'RATINGS', failureRecord, ratingsRequest, savedRatingsFailure.finished_at || ratingsAt);
        const applied = applySop08RatingsNotAvailable(candidate, { failureRecord, evidenceRef: ratingsUnavailableRef,
          observedAt: savedRatingsFailure.finished_at || ratingsAt });
        if (!applied) throw Object.assign(new Error('已保存的 Ratings 404 未能通过 exact-EAN 证据校验。'), { code: 'SOP08_SAVED_RATINGS_404_MISMATCH' });
        await commit(dataRoot, task, 'SOP08_CANDIDATE_RATINGS_NOT_AVAILABLE', { step: 'LISTING_SOP_08',
          competitor_id: candidate.competitor_id, ean: resolved.ean, http_status: 404,
          evidence_ref: ratingsUnavailableRef, source: 'REUSED_SAVED_TASK_DIAGNOSTIC', provider_request_repeated: false });
      } else {
        try {
          ratings = await client.getRatings({ ean: resolved.ean, cacheMode: 'CACHE_OK' });
        } catch (error) {
          tagSop08RemoteRequestError(error, { candidateId: candidate.competitor_id,
            endpoint: `/retailer/products/${encodeURIComponent(resolved.ean)}/ratings`, method: 'GET',
            requestParameters: ratingsRequest, startedAt: ratingsAt, remoteMethod: 'RATINGS_SUPPLEMENT' });
          if (isSop08RatingsNotFoundForEan(error, resolved.ean)) {
            const failureRecord = buildSop08RemoteFailureRecord({ error, executionId: currentSopExecutionId(dataRoot, task.sku),
              requestId: error.request_id || error.requestId, endpoint: error.sop08_endpoint, method: error.sop08_method,
              requestParameters: ratingsRequest, startedAt: ratingsAt, finishedAt: error.finished_at || iso() });
            ratingsUnavailableRef = await writeSop08RemoteErrorEvidence(dataRoot, task.sku, candidate.competitor_id,
              'RATINGS', failureRecord, ratingsRequest, failureRecord.finished_at || ratingsAt);
            const applied = applySop08RatingsNotAvailable(candidate, { failureRecord, evidenceRef: ratingsUnavailableRef,
              observedAt: failureRecord.finished_at || ratingsAt });
            if (!applied) throw error;
            await commit(dataRoot, task, 'SOP08_CANDIDATE_RATINGS_NOT_AVAILABLE', { step: 'LISTING_SOP_08',
              competitor_id: candidate.competitor_id, ean: resolved.ean, http_status: 404,
              request_id: failureRecord.request_id, evidence_ref: ratingsUnavailableRef, provider_request_repeated: false });
          } else throw error;
        }
      }
      if (ratings) {
        const ratingsRef = await writeSop08Evidence(dataRoot, task.sku, candidate.competitor_id, 'RATINGS', ratings, ratingsRequest, ratingsAt);
        const ratingRows = ratings.structuredResult?.ratings || [];
        const reviewCount = ratingRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
        candidate.review_count = reviewCount;
        candidate.rating = reviewCount ? Number((ratingRows.reduce((sum, row) => sum + (Number(row.rating) || 0) * (Number(row.count) || 0), 0) / reviewCount).toFixed(2)) : null;
        candidate.rating_status = ratingRows.length ? 'CONFIRMED' : 'NOT_CONFIRMED';
        candidate.ratings_evidence = { status: 'PASS', http_status: apiHttpStatus(ratings), cache_hit: ratings.cacheHit === true, observed_at: ratingsAt, distribution: ratingRows, review_count: reviewCount, average_rating: candidate.rating, evidence_ref: ratingsRef };
        candidate.latest_review_or_activity = { status: 'NOT_AVAILABLE', reason: 'Ratings分布不包含最近评论时间。', evidence_ref: ratingsRef };
        candidate.evidence_refs.push(ratingsRef);
      }
      candidate.sales_evidence = { status: 'NOT_AVAILABLE', reason: '当前接口没有直接销量字段；Product List rank、评论数及Offer数量未替代销量。', evidence_ref: null };
      candidate.heat_evidence = { status: 'NOT_AVAILABLE', reason: '没有可验证销量/热度指标。', evidence_refs: [] };
      candidate.same_use_case = 'UNKNOWN';
      candidate.price_band_fit = 'UNKNOWN';
      candidate.comparable_positioning = candidate.comparable_positioning === false ? false : 'UNKNOWN';
      if (ratingsUnavailableRef) candidate.evidence_refs.push(ratingsUnavailableRef);
      candidate.evidence_refs = [...new Set(candidate.evidence_refs)];
      Object.assign(candidate, classifyListingCompetitor(candidate));
      candidate.assessment_status = candidate.classification === 'UNQUALIFIED_INSUFFICIENT_EVIDENCE'
        ? 'UNQUALIFIED_INSUFFICIENT_EVIDENCE' : 'COMPLETE';
      Object.assign(discoveryRecord, { status: 'ASSESSED', assessment_status: candidate.assessment_status, classification: candidate.classification,
        classification_reason: candidate.classification_reason, competitor_id: candidate.competitor_id, condition_evidence: candidate.competitor_conditions,
        evidence_refs: candidate.evidence_refs, assessed_at: candidate.checked_at });
      priorCandidates.push(candidate);
      candidates.push(candidate);
      task.listing_executor.artifacts.competitor_candidates = clone(candidates);
      refreshSop08SupplementCheckpoint(task, top20Artifact);
      await commit(dataRoot, task, 'SOP08_SUPPLEMENT_CANDIDATE_ASSESSED', { step: 'LISTING_SOP_08', candidate_status: candidate.candidate_status,
        competitor_id: candidate.competitor_id, discovery_query: query.exact_string, classification: candidate.classification || null,
        condition_passes: Object.values(candidate.competitor_conditions || {}).filter(item => item.status === 'PASS').length,
        product_list_rank_used_as_heat: false });
    }
    attempt.status = 'PASS'; attempt.completed_at ||= iso();
    refreshSop08SupplementCheckpoint(task, top20Artifact);
    await commit(dataRoot, task, 'SOP08_SUPPLEMENT_QUERY_COMPLETE', { step: 'LISTING_SOP_08', exact_string: query.exact_string,
      evidence_ref: attempt.evidence_ref, discovered_count: candidates.filter(item => item.discovery_query === query.exact_string).length,
      effective_count: effectiveCount() });
  }
  return { candidates, queries: task.listing_executor.artifacts.sop08_discovery_queries.filter(item => item.input_versions?.facts === versions.facts
      && item.input_versions?.top20 === versions.top20),
    unresolved: task.listing_executor.artifacts.sop08_unresolved_discoveries.filter(item => item.input_versions?.facts === versions.facts
      && item.input_versions?.top20 === versions.top20 && !item.v5_reclassification),
    exhausted: shouldSupplementSop08(candidates).should_supplement && selectSop08DiscoveryQueries(top20Artifact, {
      alreadyQueried: task.listing_executor.artifacts.sop08_discovery_queries.filter(item => item.status === 'PASS'
        && item.input_versions?.facts === versions.facts && item.input_versions?.top20 === versions.top20).map(item => item.exact_string),
    }).length === 0 };
}

async function executeListingSop08(dataRoot, task) {
  const step = 'LISTING_SOP_08';
  if (!isListingCompetitorExecutorReady()) {
    setSop08Waiting(task, { dependency: 'LISTING_COMPETITOR_EXECUTOR', dependencyStatus: 'NOT_READY', reason: 'SOP08工作台Executor尚未READY。' });
    await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step, dependency: 'LISTING_COMPETITOR_EXECUTOR', executor_registered: true, executor_ready: false });
    return task;
  }
  const priorCheckpoint = task.listing_executor?.artifacts?.sop08_execution;
  const sourceVersions = sop08InputVersions(task);
  let phaseCheckpoint = task.listing_executor?.artifacts?.sop08_execution || null;
  const savedVersionsMatch = phaseCheckpoint?.input_versions
    && ['facts', 'sop03', 'top20'].every(key => phaseCheckpoint.input_versions[key] === sourceVersions[key]);
  const savedCandidates = clone(task.listing_executor?.artifacts?.competitor_candidates || []);
  const hasSavedConvergence = savedVersionsMatch && phaseCheckpoint?.local_convergence_status === 'PASS'
    && ['LOCAL_CONVERGENCE', 'REMOTE_SUPPLEMENT', 'COMPLETE'].includes(phaseCheckpoint?.phase);
  const savedPoolDecision = hasSavedConvergence ? shouldSupplementSop08(savedCandidates) : null;
  const savedDiscoveryAttempts = task.listing_executor?.artifacts?.sop08_discovery_queries || [];
  const savedDiscoveryRecovery = planSop08DiscoveryQueryRecovery({
    top20Artifact: task.outputs?.top20,
    queryAttempts: savedDiscoveryAttempts,
    factsVersion: sourceVersions.facts,
    top20Version: sourceVersions.top20,
  });
  const remoteResume = hasSavedConvergence && savedPoolDecision?.should_supplement === true
    && (phaseCheckpoint?.phase === 'REMOTE_SUPPLEMENT' || phaseCheckpoint?.phase === 'COMPLETE')
    && (savedDiscoveryRecovery.ordered_queries.length > 0 || (phaseCheckpoint.remaining_discovery_queries || []).length > 0);
  const reuseSavedConvergence = hasSavedConvergence;
  let readiness = { status: 'NOT_CHECKED', checked_at: null };
  let bolReady = false;
  if (remoteResume) {
    readiness = await bolApiReadiness(dataRoot);
    const override = readinessOverride('BOL_API_READY');
    bolReady = typeof override === 'boolean' ? override : readiness.status === 'PASS';
  }
  const preflight = evaluateListingExecutionPreflight(task, { dependencyReady: remoteResume ? bolReady : true, executorAvailable: true });
  if (!preflight.ready) {
    setSop08Waiting(task, { dependency: preflight.status === 'WAITING_DEPENDENCY' ? preflight.dependency : null, status: preflight.status, dependencyStatus: readiness.status || 'NOT_READY', reason: `${preflight.reason}${!bolReady && preflight.dependency === 'BOL_API' ? ` readiness=${readiness.status}` : ''}` });
    await commit(dataRoot, task, 'LISTING_SOP_08_PREFLIGHT_BLOCKED', { step, check: preflight.check, status: preflight.status, dependency: preflight.dependency || null, readiness: { status: readiness.status, checked_at: readiness.checked_at || null }, external_requests: 0 });
    return task;
  }

  const { artifact: sourceArtifact, file: sourceArtifactFile } = await loadSop08Source(dataRoot, task);
  const sop08Preflight = validateSop08Preflight({ task, sop03Artifact: sourceArtifact });
  if (!sop08Preflight.ready) {
    const statuses = sop08Preflight.blockers.map(item => item.status);
    const status = statuses.includes('WAITING_DECISION') ? 'WAITING_DECISION'
      : statuses.includes('WAITING_CONFIRMATION') ? 'WAITING_CONFIRMATION' : 'WAITING_DEPENDENCY';
    const dependency = status === 'WAITING_DEPENDENCY' ? 'LISTING_REQUIRED_INPUTS' : null;
    const reason = sop08Preflight.blockers.map(item => `${item.code}: ${item.reason}`).join('；');
    setSop08Waiting(task, { dependency, status, dependencyStatus: 'PREFLIGHT_BLOCKED', reason });
    await commit(dataRoot, task, 'LISTING_SOP_08_PREFLIGHT_BLOCKED', { step, check: 'SOP08_LOCAL_INPUTS', status,
      blockers: sop08Preflight.blockers, external_requests: 0 });
    return task;
  }
  task.current_step = step; task.resume_point = step; task.listing_sop.current_step_id = step;
  task.status = 'RUNNING'; task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
  task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool; task.stage_qa_status = 'NOT_RUN';
  task.stages[step] = { ...task.stages[step], status: 'RUNNING', dependency: remoteResume ? 'BOL_API' : null, waiting_reason: null, executor_id: 'LISTING_COMPETITOR_EXECUTOR', updated_at: iso() };
  const resumedCandidates = reuseSavedConvergence ? savedCandidates : [];
  const resumeRef = reuseSavedConvergence ? phaseCheckpoint.candidate_manifest_ref : null;
  await commit(dataRoot, task, remoteResume ? 'SOP08_REMOTE_SUPPLEMENT_RESUMED' : 'STEP_EXECUTION_STARTED', {
    step, phase: remoteResume ? 'SOP08_REMOTE_SUPPLEMENT' : 'SOP08_LOCAL_CONVERGENCE',
    executor_id: 'LISTING_COMPETITOR_EXECUTOR', candidate_count: resumedCandidates.length, input_versions: sourceVersions,
    reused_local_convergence: reuseSavedConvergence, external_requests: 0,
  });

  try {
    let collected;
    let currentCandidateRef = resumeRef;
    if (reuseSavedConvergence) {
      const ownCategoriesEvidence = phaseCheckpoint.own_categories_evidence || sop08OwnProductPlacementDisposition();
      collected = { candidates: resumedCandidates, ownCategoriesEvidence, existingEvaluationPlan: { type: 'PERSISTED_LOCAL_CONVERGENCE', candidates: [], remote_product_list_requests: [] } };
    } else {
      const candidateSet = buildListingSop08Candidates({ sku: task.sku, sop03Artifact: sourceArtifact, factsVersion: sourceVersions.facts, top20Version: sourceVersions.top20 });
      const sop03Ref = path.relative(dataRoot, sourceArtifactFile).replace(/\\/g, '/');
      for (const candidate of candidateSet) {
        candidate.source_ref.sop03_artifact_ref = sop03Ref;
        candidate.evidence_refs = [sop03Ref];
      }
      const priorCandidates = task.listing_executor?.artifacts?.competitor_candidates || [];
      const mergedCandidates = candidateSet.map(candidate => {
        const prior = priorCandidates.find(item => item.competitor_id === candidate.competitor_id
          && item.input_versions?.facts === sourceVersions.facts && item.input_versions?.sop03 === sourceVersions.sop03 && item.input_versions?.top20 === sourceVersions.top20);
        return prior ? { ...candidate, ...clone(prior), source_ref: candidate.source_ref } : candidate;
      });
      const manifestCreatedAt = iso();
      const manifestVersion = `SOP08-CANDIDATES-${crypto.createHash('sha256').update(JSON.stringify({ sku: task.sku, sourceVersions, mergedCandidates, manifestCreatedAt })).digest('hex').slice(0, 20)}`;
      const sourceManifest = { schema_version: 1, artifact_type: 'LISTING_SOP08_COMPETITOR_CANDIDATE_SOURCE_SET', version: manifestVersion, sku: task.sku, input_versions: sourceVersions, candidate_count: mergedCandidates.length, source_slot_statuses: sop08Preflight.candidate_slot_statuses || inspectSop08CandidateSlots(sourceArtifact), candidates: mergedCandidates, created_at: manifestCreatedAt, formal_pool_created: false };
      const currentCandidateFile = path.resolve(dataRoot, 'artifacts', 'listing', task.sku, 'sop08', 'candidate-sources', `${manifestVersion}.json`);
      currentCandidateRef = path.relative(dataRoot, currentCandidateFile).replace(/\\/g, '/');
      await atomicJson(currentCandidateFile, sourceManifest);
      task.listing_executor.artifacts.competitor_candidates = mergedCandidates;
      task.listing_executor.registry.LISTING_SOP_08.input_version_refs = [
        { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: sourceVersions.facts },
        { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: sourceVersions.sop03 },
        { artifact_type: 'LISTING_TOP20_VERSION', version: sourceVersions.top20 },
      ];
      const local = await collectSop08CandidateEvidence(dataRoot, task, sourceArtifact, mergedCandidates);
      task.listing_executor.artifacts.competitor_candidates = local.candidates;
      await commit(dataRoot, task, 'SOP08_EXISTING_COMPETITOR_EVALUATION_PREPARED', {
        step, evaluation_type: local.existingEvaluationPlan.type,
        existing_candidate_count: local.existingEvaluationPlan.candidates.length,
        product_list_requests: local.existingEvaluationPlan.remote_product_list_requests.length,
        candidates: local.existingEvaluationPlan.candidates, external_requests: 0,
      });
      for (const candidate of local.candidates) Object.assign(candidate, classifyListingCompetitor(candidate));
      const converged = await reclassifySop08PersistedCandidates(dataRoot, task, local.candidates);
      collected = { ...local, candidates: converged.candidates };
    }
    task.listing_executor.artifacts.competitor_candidates = collected.candidates;
    const initialPoolDecision = shouldSupplementSop08(collected.candidates);
    const phasePlan = planSop08ExecutionPhase({ phase: remoteResume ? 'REMOTE_SUPPLEMENT' : 'LOCAL_CONVERGENCE',
      usablePoolCount: initialPoolDecision.usable_primary_pool_count, bolReady });
    if (initialPoolDecision.reason === 'EXISTING_CANDIDATE_EVALUATION_INCOMPLETE') {
      const reason = `SOP08补充发现已阻止：J12–N12仍有 ${initialPoolDecision.incomplete_existing_count} 条 existing candidate 未完成本地映射/远端字段收口。`;
      setSop08Waiting(task, { dependency: 'SOP08_EXISTING_CANDIDATE_EVALUATION', dependencyStatus: 'INCOMPLETE', reason, status: 'WAITING_DEPENDENCY' });
      task.listing_executor.artifacts.competitor_candidates = collected.candidates;
      await commit(dataRoot, task, 'SOP08_SUPPLEMENT_DISCOVERY_BLOCKED_EXISTING_INCOMPLETE', {
        step, incomplete_existing_count: initialPoolDecision.incomplete_existing_count,
        supplement_dispatched: false, usable_primary_pool_count: null, external_requests: 0,
      });
      return task;
    }
    const recoveryPlan = planSop08DiscoveryQueryRecovery({
      top20Artifact: task.outputs?.top20,
      queryAttempts: task.listing_executor.artifacts.sop08_discovery_queries || [],
      factsVersion: sourceVersions.facts,
      top20Version: sourceVersions.top20,
    });
    const remainingQueries = recoveryPlan.ordered_queries;
    if (!reuseSavedConvergence) {
      phaseCheckpoint = buildSop08PhaseCheckpoint({
        phase: phasePlan.phase === 'REMOTE_SUPPLEMENT' ? 'REMOTE_SUPPLEMENT' : 'LOCAL_CONVERGENCE',
        versions: sourceVersions, candidates: collected.candidates, usablePoolCount: initialPoolDecision.usable_primary_pool_count,
        candidateManifestRef: currentCandidateRef, remainingQueries,
        processedCandidateIds: collected.candidates.map(item => item.competitor_id),
      });
      phaseCheckpoint.own_categories_evidence = clone(collected.ownCategoriesEvidence);
      phaseCheckpoint.local_convergence_status = 'PASS';
      phaseCheckpoint.completed_at = iso();
      task.listing_executor.artifacts.sop08_execution = phaseCheckpoint;
      await commit(dataRoot, task, 'SOP08_LOCAL_CONVERGENCE_COMPLETE', {
        step, phase: 'SOP08_LOCAL_CONVERGENCE', candidate_count: collected.candidates.length,
        usable_primary_pool_count: initialPoolDecision.usable_primary_pool_count,
        remaining_discovery_query_count: remainingQueries.length, reprocessed_candidate_count: collected.candidates.length,
        external_requests: 0,
      });
    } else {
      phaseCheckpoint.usable_primary_pool_count = initialPoolDecision.usable_primary_pool_count;
      phaseCheckpoint.candidate_count = collected.candidates.length;
      phaseCheckpoint.candidate_manifest_ref ||= currentCandidateRef;
    }
    if (phasePlan.action === 'FINALIZE') {
      phaseCheckpoint.phase = 'LOCAL_CONVERGENCE';
      phaseCheckpoint.remote_supplement_status = 'NOT_REQUIRED';
    } else {
      if (!remoteResume) {
        readiness = await bolApiReadiness(dataRoot);
        const override = readinessOverride('BOL_API_READY');
        bolReady = typeof override === 'boolean' ? override : readiness.status === 'PASS';
      }
      const remotePlan = planSop08ExecutionPhase({ phase: 'REMOTE_SUPPLEMENT', usablePoolCount: initialPoolDecision.usable_primary_pool_count, bolReady });
      phaseCheckpoint.phase = 'REMOTE_SUPPLEMENT';
      phaseCheckpoint.remote_supplement_status = bolReady ? 'READY' : 'WAITING_DEPENDENCY';
      task.listing_executor.artifacts.sop08_execution = phaseCheckpoint;
      if (remotePlan.action === 'WAITING_DEPENDENCY') {
        const reason = `SOP08本地收敛完成，可用竞品池=${initialPoolDecision.usable_primary_pool_count}；远程补充等待 BOL_API:${readiness.status}。`;
        setSop08Waiting(task, { dependency: 'BOL_API', dependencyStatus: readiness.status, reason, candidateManifestRef: currentCandidateRef });
        task.listing_executor.artifacts.competitor_candidates = clone(collected.candidates);
        task.listing_executor.artifacts.sop08_execution = phaseCheckpoint;
        await commit(dataRoot, task, 'SOP08_REMOTE_SUPPLEMENT_WAITING_FOR_BOL_API', {
          step, dependency: 'BOL_API', readiness_status: readiness.status, usable_primary_pool_count: initialPoolDecision.usable_primary_pool_count,
          candidate_cursor: phaseCheckpoint.candidate_cursor, remaining_discovery_queries: phaseCheckpoint.remaining_discovery_queries,
          external_requests: 0,
        });
        return task;
      }
    }
    let supplementResult = { queries: [], unresolved: [], exhausted: false };
    if (initialPoolDecision.should_supplement) {
      phaseCheckpoint.phase = 'REMOTE_SUPPLEMENT';
      phaseCheckpoint.remote_supplement_status = 'RUNNING';
      task.listing_executor.artifacts.sop08_execution = phaseCheckpoint;
      supplementResult = await collectSop08SupplementalCandidates(dataRoot, task, task.outputs?.top20, collected.candidates, collected.ownCategoriesEvidence);
      collected.candidates = supplementResult.candidates;
      task.listing_executor.artifacts.competitor_candidates = collected.candidates;
      phaseCheckpoint.processed_candidate_ids = [...new Set([...phaseCheckpoint.processed_candidate_ids, ...collected.candidates.map(item => item.competitor_id).filter(Boolean)])];
      phaseCheckpoint.processed_candidate_count = phaseCheckpoint.processed_candidate_ids.length;
      phaseCheckpoint.candidate_cursor = phaseCheckpoint.processed_candidate_count;
      phaseCheckpoint.usable_primary_pool_count = shouldSupplementSop08(collected.candidates).usable_primary_pool_count;
      const recoveryPlan = planSop08DiscoveryQueryRecovery({
        top20Artifact: task.outputs?.top20,
        queryAttempts: task.listing_executor.artifacts.sop08_discovery_queries || [],
        factsVersion: sourceVersions.facts,
        top20Version: sourceVersions.top20,
      });
      phaseCheckpoint.remaining_discovery_queries = recoveryPlan.ordered_queries.map(item => item.exact_string);
      if (phaseCheckpoint.usable_primary_pool_count >= 3) phaseCheckpoint.remaining_discovery_queries = [];
      phaseCheckpoint.remote_supplement_status = phaseCheckpoint.usable_primary_pool_count >= 3 ? 'COMPLETE' : 'CONVERGED';
      phaseCheckpoint.processed_at = iso();
      task.listing_executor.artifacts.sop08_execution = phaseCheckpoint;
      await commit(dataRoot, task, 'SOP08_SUPPLEMENTAL_DISCOVERY_FINISHED', {
        step, initial_effective_count: initialPoolDecision.effective_count,
        final_effective_count: shouldSupplementSop08(collected.candidates).effective_count,
        query_count: supplementResult.queries.filter(item => item.status === 'PASS').length,
        unresolved_candidate_count: supplementResult.unresolved.length,
        exhausted: supplementResult.exhausted,
      });
    }
    for (const candidate of collected.candidates) {
      await commit(dataRoot, task, 'LISTING_SOP_08_CANDIDATE_ASSESSED', { step, competitor_id: candidate.competitor_id, source_field: candidate.source_field, assessment_status: candidate.assessment_status || null, classification: candidate.classification || null, evidence_count: candidate.evidence_refs?.length || 0 });
    }
    if (collected.candidates.some(candidate => !candidate.classification)) {
      const reason = 'SOP08候选已保留；部分候选的官方URL匹配、品类或用途证据仍未确认，暂不生成最终有效竞品池。';
      task.current_step = step; task.resume_point = step; task.listing_sop.current_step_id = step;
      task.status = 'WAITING_CONFIRMATION'; task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
      task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: null };
      task.stages[step] = { ...task.stages[step], status: 'WAITING_CONFIRMATION', waiting_reason: reason, updated_at: iso() };
      task.listing_sop.steps[step] = { ...task.listing_sop.steps[step], status: 'WAITING_CONFIRMATION', qa_status: 'NOT_RUN', waiting_reason: reason, updated_at: iso() };
      await commit(dataRoot, task, 'LISTING_SOP_08_WAITING_FOR_EVIDENCE', { step, reason, unclassified_candidates: collected.candidates.filter(item => !item.classification).map(item => item.competitor_id) });
      return task;
    }

    const createdAt = iso();
    phaseCheckpoint ||= buildSop08PhaseCheckpoint({ phase: 'LOCAL_CONVERGENCE', versions: sourceVersions, candidates: collected.candidates,
      usablePoolCount: shouldSupplementSop08(collected.candidates).usable_primary_pool_count, candidateManifestRef: currentCandidateRef,
      processedCandidateIds: collected.candidates.map(item => item.competitor_id) });
    phaseCheckpoint.phase = 'COMPLETE';
    phaseCheckpoint.completed_at = iso();
    phaseCheckpoint.usable_primary_pool_count = shouldSupplementSop08(collected.candidates).usable_primary_pool_count;
    task.listing_executor.artifacts.sop08_execution = phaseCheckpoint;
    const execution = buildListingSop08Pool({ sku: task.sku, factsVersion: sourceVersions.facts, sop03Version: sourceVersions.sop03, top20Version: sourceVersions.top20, candidates: collected.candidates, createdAt });
    const artifact = execution;
    artifact.discovery = {
      triggered: initialPoolDecision.should_supplement,
      initial_effective_count: initialPoolDecision.effective_count,
      queries: clone(supplementResult.queries),
      unresolved_candidates: clone(supplementResult.unresolved),
      discovered_candidates: clone((task.listing_executor.artifacts.sop08_discovery_candidates || []).filter(item => item.facts_version === sourceVersions.facts && item.top20_version === sourceVersions.top20)),
      duplicate_candidates: clone(task.listing_executor.artifacts.sop08_duplicate_discoveries || []),
      exhausted: supplementResult.exhausted,
      product_list_rank_used_as_sales_or_heat: false,
    };
    const exhaustiveLowConfidence = artifact.usable_primary_pool_count < 3
      && artifact.discovery.triggered === true
      && artifact.discovery.exhausted === true
      && artifact.discovery.unresolved_candidates.length === 0
      && phaseCheckpoint.remaining_discovery_queries.length === 0;
    if (exhaustiveLowConfidence) {
      artifact.confidence_reason = 'ONLY_ONE_USABLE_COMPETITOR_AFTER_EXHAUSTIVE_DISCOVERY';
      artifact.confidence_details = `穷尽现有发现查询后仅有 ${artifact.usable_primary_pool_count} 个可用主要比较对象。`;
      phaseCheckpoint.remote_supplement_status = 'EXHAUSTED_LOW_CONFIDENCE';
      await commit(dataRoot, task, 'SOP08_EXHAUSTIVE_DISCOVERY_LOW_CONFIDENCE_TERMINAL', {
        step, usable_primary_pool_count: artifact.usable_primary_pool_count,
        remaining_discovery_queries: 0, unresolved_candidates: 0, external_requests: 0,
        confidence_reason: artifact.confidence_reason,
      });
    }
    const pendingFile = path.resolve(dataRoot, 'artifacts', 'listing', task.sku, 'sop08', 'pending', `${artifact.version}.json`);
    const pendingRef = path.relative(dataRoot, pendingFile).replace(/\\/g, '/');
    artifact.evidence = { ...artifact.evidence, artifact_ref: pendingRef, evidence_refs: [...new Set([...(artifact.evidence.evidence_refs || []), currentCandidateRef])] };
    artifact.status = 'DONE_PENDING_QA';
    task.outputs ||= {}; task.outputs.listing_competitor_pool = clone(artifact); task.outputs.competitors = clone(artifact);
    task.listing_executor.artifacts.listing_outputs.LISTING_SOP_08 = clone(artifact);
    await atomicJson(pendingFile, artifact);
    await commit(dataRoot, task, 'LISTING_SOP_08_OUTPUT_PERSISTED', { version: artifact.version, artifact_ref: pendingRef, candidate_count: artifact.candidates.length, effective_count: artifact.effective_count, reference_count: artifact.reference_count, low_confidence: artifact.confidence_status });

    const validation = qaListingSop08Pool({ artifact, expectedVersions: sourceVersions });
    const discoveryRefs = (artifact.discovery.discovered_candidates || []).flatMap(item => [item.product_list_evidence_ref, item.placement_evidence_ref]);
    const evidenceRefs = [...new Set([...artifact.candidates.flatMap(item => item.evidence_refs || []), ...discoveryRefs].filter(Boolean))];
    const missingEvidence = [];
    const root = path.resolve(dataRoot);
    for (const reference of evidenceRefs) {
      const file = path.resolve(dataRoot, reference);
      if (!file.startsWith(`${root}${path.sep}`) || !await fs.stat(file).catch(() => null)) missingEvidence.push(reference);
    }
    const evidenceCheck = { code: 'SOP08_EVIDENCE_PERSISTED', pass: missingEvidence.length === 0, message: missingEvidence.length ? `${missingEvidence.length}条候选证据不可读取。` : '所有候选的源文件及API evidence均可读取。' };
    const sourceLineage = await verifySop08SourceLineage(dataRoot, task, artifact, sourceVersions);
    const sourceLineageCheck = { code: 'SOP08_SOURCE_LINEAGE', pass: sourceLineage.pass,
      message: sourceLineage.pass ? 'SOP03和SOP07来源均解析到实际版本化证据。' : `来源链校验失败：${sourceLineage.failures.length}项。`, details: sourceLineage.failures };
    const discoveryEvidenceFailures = [];
    for (const queryRow of artifact.discovery.queries || []) {
      const attempt = (task.listing_executor.artifacts.sop08_discovery_queries || []).find(item => item.exact_string === queryRow.exact_string
        && item.input_versions?.facts === sourceVersions.facts && item.input_versions?.top20 === sourceVersions.top20);
      if (!attempt || attempt.status !== 'PASS' || attempt.evidence_ref !== queryRow.evidence_ref) {
        discoveryEvidenceFailures.push({ exact_string: queryRow.exact_string, reason: 'ATTEMPT_NOT_COMPLETED_OR_REF_MISMATCH' });
        continue;
      }
      try {
        const saved = await readSop08SavedProductListEvidence(dataRoot, task, queryRow, attempt, sourceVersions);
        if (saved.products.length !== Number(attempt.returned_count)) {
          discoveryEvidenceFailures.push({ exact_string: queryRow.exact_string, reason: 'RETURNED_COUNT_MISMATCH' });
        }
      } catch (error) {
        discoveryEvidenceFailures.push({ exact_string: queryRow.exact_string, reason: error?.code || 'EVIDENCE_UNREADABLE' });
      }
    }
    const discoveryEvidenceCheck = { code: 'SOP08_DISCOVERY_EVIDENCE_CONTENT', pass: discoveryEvidenceFailures.length === 0,
      message: discoveryEvidenceFailures.length ? `发现${discoveryEvidenceFailures.length}项Product List原始证据不匹配。` : '每条Product List查询均通过SKU、exact query、版本、HTTP状态和原始结果校验。', details: discoveryEvidenceFailures };
    const coreEvidencePassed = validation.status === 'PASS' && evidenceCheck.pass && sourceLineageCheck.pass && discoveryEvidenceCheck.pass;
    const resolvedIssueIds = [];
    if (coreEvidencePassed) {
      const recoverableCodes = new Set(['SOP08_EVIDENCE_TRACEABLE', 'SOP08_DISCOVERY_EVIDENCE', 'SOP08_SOURCE_LINEAGE', 'SOP08_DISCOVERY_EVIDENCE_CONTENT']);
      for (const issue of task.issues || []) {
        if (issue.status === 'OPEN' && issue.step === step && issue.location === 'outputs.listing_competitor_pool'
          && recoverableCodes.has(issue.code)) {
          issue.status = 'CLOSED'; issue.closed_at = iso(); issue.updated_at = issue.closed_at;
          issue.close_reason = 'RECOVERED_BY_STRICT_EVIDENCE_REVALIDATION';
          issue.closure_evidence = { artifact_version: artifact.version, source_lineage_pass: sourceLineageCheck.pass,
            discovery_evidence_pass: discoveryEvidenceCheck.pass };
          resolvedIssueIds.push(issue.issue_id);
        }
      }
      task.open_error_count = activeIssueCount(task);
    }
    const openErrorCount = activeIssueCount(task);
    const qaChecks = [...validation.checks, evidenceCheck, sourceLineageCheck, discoveryEvidenceCheck,
      { code: 'OPEN_ERROR_COUNT_ZERO', pass: openErrorCount === 0, message: openErrorCount === 0 ? '当前SKU没有OPEN_ERROR。' : `当前SKU存在${openErrorCount}个OPEN_ERROR。` }];
    const passed = validation.status === 'PASS' && evidenceCheck.pass && sourceLineageCheck.pass
      && discoveryEvidenceCheck.pass && openErrorCount === 0;
    artifact.qa = { status: passed ? 'PASS' : 'FAIL', checked_at: iso(), checks: qaChecks };
    if (!passed) {
      artifact.status = 'QA_FAIL';
      task.outputs.listing_competitor_pool = clone(artifact); task.outputs.competitors = clone(artifact);
      task.qa[step] = { status: 'FAIL', checked_at: artifact.qa.checked_at, report: qaChecks.filter(item => !item.pass).map(item => item.message) };
      task.stages[step] = { ...task.stages[step], status: 'QA_FAIL', updated_at: iso() };
      for (const check of qaChecks.filter(item => !item.pass)) issueFor(task, check.code, check.message, 'outputs.listing_competitor_pool', 'SOP08 evidence and candidate classifications pass all checks', '修复缺失的证据或字段后重新核验；不得放宽分级条件。');
      task.open_error_count = activeIssueCount(task); task.return_pool = 'Listing 生成池'; task.activity_pool = '异常池'; task.current_pool = task.activity_pool; task.status = 'ERROR';
      await commit(dataRoot, task, 'STAGE_QA_FAIL', { step, codes: qaChecks.filter(item => !item.pass).map(item => item.code),
        resolved_issue_ids: resolvedIssueIds, source_lineage_failures: sourceLineage.failures, discovery_evidence_failures: discoveryEvidenceFailures });
      return task;
    }

    artifact.status = 'PASS'; artifact.qa_status = 'PASS';
    const finalFile = path.resolve(dataRoot, 'artifacts', 'listing', task.sku, 'sop08', `${artifact.version}.json`);
    const finalRef = path.relative(dataRoot, finalFile).replace(/\\/g, '/');
    artifact.evidence.artifact_ref = finalRef;
    await atomicJson(finalFile, artifact);
    task.outputs.listing_competitor_pool = clone(artifact); task.outputs.competitors = clone(artifact);
    task.listing_executor.artifacts.listing_outputs.LISTING_SOP_08 = clone(artifact);
    task.listing_executor.registry.LISTING_SOP_08 = { ...task.listing_executor.registry.LISTING_SOP_08, status: 'PASS', qa_status: 'PASS', output_version: artifact.version, output_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION', evidence_refs: [finalRef, currentCandidateRef, ...evidenceRefs], input_version_refs: [
      { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: sourceVersions.facts },
      { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: sourceVersions.sop03 },
      { artifact_type: 'LISTING_TOP20_VERSION', version: sourceVersions.top20 },
    ], waiting_reason: null, completed_at: iso(), updated_at: iso() };
    task.listing_sop.steps[step] = { ...task.listing_sop.steps[step], status: 'PASS', qa_status: 'PASS', output_version: artifact.version, updated_at: iso() };
    task.stages[step] = { ...task.stages[step], status: 'PASS', qa_status: 'PASS', output_version: artifact.version, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_08_STAGE_QA_PASS', { step, version: artifact.version, effective_count: artifact.effective_count, reference_count: artifact.reference_count, invalid_count: artifact.invalid_count, comparison_pool_count: artifact.main_comparison_pool.length, confidence_status: artifact.confidence_status, resolved_issue_ids: resolvedIssueIds, next_step: 'LISTING_SOP_09' });
    await verifyCurrent(dataRoot, task);
    return task;
  } catch (error) {
    const classification = classifySop08BolFailure(error);
    if (classification.route !== 'UNCLASSIFIED') {
      const failure = error.sop08_failure_record || buildSop08RemoteFailureRecord({
        error, executionId: currentSopExecutionId(dataRoot, task.sku, step),
        requestId: error.sop08_request_id || null,
        endpoint: error.sop08_endpoint || (error.sop08_remote_method === 'PRODUCT_LIST_SUPPLEMENT' ? '/retailer/products/list' : error.sop08_remote_method),
        method: error.sop08_method || (error.sop08_remote_method?.startsWith('PRODUCT_LIST') ? 'POST' : null),
        requestParameters: error.sop08_request_parameters || (error.sop08_discovery_query ? { searchTerm: error.sop08_discovery_query, countryCode: 'NL', page: 1 } : null),
        startedAt: error.sop08_started_at || null, finishedAt: iso(),
      });
      const failedAt = failure.finished_at || iso();
      const common = {
        step, competitor_id: error.sop08_candidate_id || null, endpoint: failure.endpoint,
        exact_query: error.sop08_discovery_query || null, ...failure,
        raw_error_body_available: failure.response_body != null,
        failure_route: classification.route, reason_code: classification.reason_code,
      };

      if (classification.route === 'PAUSE_HTTP_CLIENT_ERROR') {
        applySop08HttpClientErrorPause(task, { error, failureRecord: failure, failedAt });
        task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
        task.open_error_count = activeIssueCount(task);
        await commit(dataRoot, task, 'SOP08_HTTP_CLIENT_ERROR_PAUSED', {
          ...common, status: 'PAUSED', waiting_dependency_key: null, qa_status: 'NOT_RUN', open_error_count: task.open_error_count,
        });
        return task;
      }

      if (classification.route === 'RATE_LIMIT_WAIT') {
        applySop08RateLimitWait(task, { error, failureRecord: failure, failedAt });
        const waitReason = task.rate_limit_wait?.retry_after_at
          ? `BOL API HTTP 429；Retry-After至 ${task.rate_limit_wait.retry_after_at}` : 'BOL API HTTP 429；等待 Retry-After 限流窗口。';
        task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
        task.listing_sop.steps[step] = { ...task.listing_sop.steps[step], status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: waitReason, updated_at: failedAt };
        task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: waitReason, updated_at: failedAt };
        task.open_error_count = activeIssueCount(task);
        await commit(dataRoot, task, 'SOP08_RATE_LIMIT_WAIT', {
          ...common, status: 'WAITING_DEPENDENCY', waiting_dependency_key: task.waiting_dependency_key,
          retry_after: classification.retry_after, retry_after_at: task.rate_limit_wait?.retry_after_at || null,
          qa_status: 'NOT_RUN', open_error_count: task.open_error_count,
        });
        return task;
      }

      const reason = classification.route === 'UPSTREAM_WAIT'
        ? `SOP08 BOL API上游HTTP ${classification.http_status}错误（HTTP_5XX）。`
        : `SOP08 BOL API传输失败（${error?.code || 'TRANSPORT_FAILURE'}）；无HTTP响应。`;
      if (classification.route === 'TRANSPORT_WAIT') applyBolNetworkFailureBarrier(task, { error, failedAt, dependencyKey: 'BOL_API' });
      else applySop08UpstreamHttpWait(task, { error, failureRecord: failure, failedAt });
      setSop08Waiting(task, { dependency: 'BOL_API', dependencyStatus: classification.reason_code, reason, dependencyFailedAt: failedAt });
      task.provider_wait_classification = {
        route: classification.route, reason_code: classification.reason_code, http_status: classification.http_status,
        response_received: failure.response_received === true, transport_failure: classification.route === 'TRANSPORT_WAIT',
        diagnostic: failure, failed_at: failedAt,
      };
      await commit(dataRoot, task, 'STEP_REMOTE_CALL_FAILED', {
        ...common, dependency_key: 'BOL_API', error_message: reason,
        waiting_dependency_key: 'BOL_API', qa_status: 'NOT_RUN',
        dependency_failed_at: failedAt, required_readiness_after: failedAt,
        provider_wait_classification: task.provider_wait_classification,
      });
      return task;
    }
    throw error;
  }
}

async function reconcileSop08SavedDiscoveryQueries(dataRoot, task, artifact, versions) {
  const rows = artifact?.discovery?.queries || [];
  const attempts = task.listing_executor?.artifacts?.sop08_discovery_queries || [];
  const top20 = task.outputs?.top20;
  if (!Array.isArray(rows) || !Array.isArray(top20?.records)) {
    throw Object.assign(new Error('SOP08 缺少可核验的 Product List query 或正式 SOP07 记录。'), { code: 'SOP08_DISCOVERY_RECONCILIATION_INPUT_MISSING' });
  }
  const seen = new Set();
  const promoted = [];
  for (const row of rows) {
    const exact = row?.exact_string;
    if (typeof exact !== 'string' || !exact || seen.has(exact)) {
      throw Object.assign(new Error('SOP08 discovery query exact string 缺失或重复。'), { code: 'SOP08_DISCOVERY_QUERY_IDENTITY_INVALID' });
    }
    seen.add(exact);
    const keyword = top20.records.find(item => item?.exact_string === exact);
    if (!keyword || keyword.keyword_category !== 'CORE_PRODUCT' || keyword.demand_status !== 'POSITIVE'
      || !(Number(keyword.boloo_search_volume) > 0) || row.keyword_category !== 'CORE_PRODUCT'
      || !(Number(row.boloo_search_volume) > 0)) {
      throw Object.assign(new Error(`SOP08 query ${exact} 不符合正式 SOP07 positive-volume CORE_PRODUCT 来源。`), { code: 'SOP08_DISCOVERY_QUERY_NOT_ELIGIBLE' });
    }
    const matchingAttempts = attempts.filter(item => item?.exact_string === exact
      && item?.input_versions?.facts === versions.facts
      && item?.input_versions?.top20 === versions.top20);
    if (matchingAttempts.length !== 1) {
      throw Object.assign(new Error(`SOP08 query ${exact} 的保存 attempt 数量不是唯一，拒绝推断映射。`), { code: 'SOP08_DISCOVERY_ATTEMPT_AMBIGUOUS' });
    }
    const attempt = matchingAttempts[0];
    if (!['PASS', 'RESULT_SAVED'].includes(attempt.status)
      || attempt.evidence_ref !== row.evidence_ref
      || attempt.request_parameters?.searchTerm !== exact
      || attempt.request_parameters?.countryCode !== 'NL'
      || Number(attempt.http_status) !== 200) {
      throw Object.assign(new Error(`SOP08 query ${exact} 的保存 attempt 与父记录或 HTTP 200 不匹配。`), { code: 'SOP08_DISCOVERY_ATTEMPT_MISMATCH' });
    }
    const saved = await readSop08SavedProductListEvidence(dataRoot, task, row, attempt, versions);
    if (saved.products.length !== Number(attempt.returned_count)
      || (row.returned_count != null && Number(row.returned_count) !== saved.products.length)) {
      throw Object.assign(new Error(`SOP08 query ${exact} 的持久化结果数量与 attempt 不匹配。`), { code: 'SOP08_DISCOVERY_RESULT_COUNT_MISMATCH' });
    }
    row.status = 'PASS';
    row.evidence_ref = attempt.evidence_ref;
    row.request_id = attempt.request_id || row.request_id || null;
    row.http_status = 200;
    row.returned_count = saved.products.length;
    row.evidence_sha256 = saved.sha256;
    row.reconciled_from_status = attempt.status === 'RESULT_SAVED' ? 'RESULT_SAVED' : (row.reconciled_from_status || null);
    attempt.status = 'PASS';
    attempt.evidence_sha256 = saved.sha256;
    attempt.reconciled_at = iso();
    promoted.push({ exact_string: exact, request_id: attempt.request_id || null, evidence_ref: attempt.evidence_ref, evidence_sha256: saved.sha256 });
  }
  if (attempts.some(item => item.status === 'RUNNING')) {
    throw Object.assign(new Error('SOP08 仍存在 RUNNING Product List attempt；拒绝最终收口。'), { code: 'SOP08_REMOTE_REQUESTS_PENDING' });
  }
  const remaining = selectSop08DiscoveryQueries(top20, { alreadyQueried: [...seen] }).map(item => item.exact_string);
  if (artifact.discovery?.exhausted === true && remaining.length) {
    throw Object.assign(new Error('SOP08 标记 discovery exhausted，但正式 SOP07 仍有未查询核心词。'), { code: 'SOP08_DISCOVERY_EXHAUSTION_CONFLICT' });
  }
  return { promoted, remaining, attempts };
}

async function finalizeSop08PersistedArtifact(dataRoot, task, { allowActiveExecutionId = null } = {}) {
  if (!acceptanceMode(dataRoot) || !task?.sku || task.outputs?.listing_competitor_pool?.sku !== task.sku) {
    throw Object.assign(new Error('从已保存证据收口 SOP08 只允许在隔离 acceptance dataRoot 且 SKU identity 匹配时执行。'), { code: 'SOP08_FINALIZE_ACCEPTANCE_ONLY' });
  }
  if (task.current_step !== 'LISTING_SOP_08' || task.qa?.LISTING_SOP_08?.status === 'PASS') {
    throw Object.assign(new Error('当前任务不在待完成的 SOP08 Stage QA 检查点。'), { code: 'SOP08_FINALIZE_PRECONDITION_FAILED' });
  }
  const activeLease = dbFor(dataRoot).prepare(`SELECT execution_id FROM listing_execution_leases
    WHERE sku_id=? AND step=? AND state='RUNNING' LIMIT 1`).get(task.sku, 'LISTING_SOP_08');
  if (activeLease && activeLease.execution_id !== allowActiveExecutionId) throw Object.assign(new Error('SOP08 仍有其他活动 execution lease；未进行最终收口。'), { code: 'SOP08_FINALIZE_ACTIVE_LEASE' });

  const output = task.outputs?.listing_competitor_pool;
  const checkpoint = task.listing_executor?.artifacts?.sop08_execution;
  const initialCheckpoint = checkpoint;
  const pendingRef = output?.evidence?.artifact_ref;
  if (!output || !/^SOP08-[a-f0-9]{20}$/i.test(String(output.version || '')) || !['DONE_PENDING_QA', 'QA_FAIL'].includes(output.status)
    || typeof pendingRef !== 'string' || !pendingRef.includes('/pending/')) {
    throw Object.assign(new Error('当前没有匹配本次 SOP08 执行的待 QA artifact。'), { code: 'SOP08_PENDING_ARTIFACT_MISMATCH' });
  }
  if (initialCheckpoint?.phase !== 'COMPLETE' || initialCheckpoint.local_convergence_status !== 'PASS'
    || !['CONVERGED', 'RESULTS_SAVED_NEED_RECONCILIATION'].includes(initialCheckpoint.remote_supplement_status)
    || initialCheckpoint.candidate_cursor !== initialCheckpoint.processed_candidate_count
    || (output.discovery?.unresolved_candidates || []).length !== 0) {
    throw Object.assign(new Error('SOP08 本地收敛或远程补充尚未满足完整耗尽条件。'), { code: 'SOP08_EXHAUSTION_NOT_PROVEN' });
  }

  const root = path.resolve(dataRoot);
  const pendingPath = path.resolve(root, pendingRef);
  if (!pendingPath.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('待 QA artifact 路径越出验收数据根。'), { code: 'SOP08_ARTIFACT_PATH_INVALID' });
  let persisted = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
  if (persisted.version !== output.version || persisted.status !== 'DONE_PENDING_QA') {
    throw Object.assign(new Error('磁盘上的 SOP08 pending artifact 与任务记录不一致。'), { code: 'SOP08_PENDING_ARTIFACT_CONTENT_MISMATCH' });
  }
  const versions = sop08InputVersions(task);
  const workingTask = clone(task);
  const queryReconciliation = await reconcileSop08SavedDiscoveryQueries(dataRoot, workingTask, persisted, versions);
  const remappedCandidates = (persisted.candidates || []).map(candidate => classifyListingCompetitor(
    mapSop08LocalCompetitorEvidence(candidate, workingTask.outputs?.confirmed_product_facts),
  ));
  const rebuiltPool = buildListingSop08Pool({
    sku: task.sku, factsVersion: versions.facts, sop03Version: versions.sop03, top20Version: versions.top20,
    candidates: remappedCandidates, createdAt: iso(),
  });
  const priorArtifact = persisted;
  persisted = {
    ...priorArtifact,
    ...rebuiltPool,
    discovery: priorArtifact.discovery,
    evidence: {
      ...priorArtifact.evidence,
      ...rebuiltPool.evidence,
      created_at: priorArtifact.evidence?.created_at || rebuiltPool.evidence.created_at,
      artifact_ref: pendingRef,
      reconciled_from_version: priorArtifact.version,
      reconciled_at: iso(),
      reconciliation: {
        type: 'SOP08_PERSISTED_EVIDENCE_RECONCILIATION',
        promoted_queries: queryReconciliation.promoted,
        external_requests: 0,
      },
      evidence_refs: [...new Set([...(priorArtifact.evidence?.evidence_refs || []), ...(rebuiltPool.evidence?.evidence_refs || [])])],
    },
  };
  const candidateRows = persisted.candidates || [];
  const reconciledCheckpoint = workingTask.listing_executor?.artifacts?.sop08_execution;
  const completedCandidateIds = candidateRows.filter(item => item.competitor_id && item.classification
    && item.classification_reason && item.assessment_status !== 'RUNNING').map(item => item.competitor_id);
  reconciledCheckpoint.processed_candidate_ids = [...new Set([...(reconciledCheckpoint.processed_candidate_ids || []), ...completedCandidateIds])];
  reconciledCheckpoint.processed_candidate_count = completedCandidateIds.length;
  reconciledCheckpoint.candidate_cursor = completedCandidateIds.length;
  reconciledCheckpoint.candidate_count = candidateRows.length;
  reconciledCheckpoint.usable_primary_pool_count = persisted.usable_primary_pool_count;
  reconciledCheckpoint.processed_discovery_queries = [...new Set([...(reconciledCheckpoint.processed_discovery_queries || []), ...(persisted.discovery?.queries || []).map(item => item.exact_string)])];
  reconciledCheckpoint.remaining_discovery_queries = queryReconciliation.remaining;
  reconciledCheckpoint.remote_supplement_status = 'CONVERGED';
  reconciledCheckpoint.updated_at = iso();
  workingTask.outputs.listing_competitor_pool = clone(persisted);
  workingTask.outputs.competitors = clone(persisted);
  workingTask.listing_executor.artifacts.sop08_discovery_queries = clone(queryReconciliation.attempts);
  const allowedClasses = new Set(['A_STRONG_EFFECTIVE', 'B_REFERENCE', 'C_WEAK_INVALID', 'UNQUALIFIED_INSUFFICIENT_EVIDENCE']);
  if (!candidateRows.length || candidateRows.some(item => !allowedClasses.has(item.classification))
    || candidateRows.some(item => item.status === 'RUNNING')) {
    throw Object.assign(new Error('仍有未分类或运行中的 SOP08 候选；未进行最终收口。'), { code: 'SOP08_CANDIDATES_NOT_COMPLETE' });
  }
  const queryRows = persisted.discovery?.queries || [];
  if (queryRows.some(item => item.status !== 'PASS')
    || (workingTask.listing_executor?.artifacts?.sop08_discovery_queries || []).some(item => item.status === 'RUNNING')) {
    throw Object.assign(new Error('仍有未完成或运行中的远程发现请求；未进行最终收口。'), { code: 'SOP08_REMOTE_REQUESTS_PENDING' });
  }
  const eligibleQueryExactStrings = selectSop08DiscoveryQueries(workingTask.outputs?.top20).map(item => item.exact_string);
  const completedQueryExactStrings = new Set(queryRows.filter(item => item.status === 'PASS').map(item => item.exact_string));
  const allEligibleQueriesCompleted = queryReconciliation.remaining.length === 0
    && queryRows.length === eligibleQueryExactStrings.length
    && eligibleQueryExactStrings.every(exact => completedQueryExactStrings.has(exact));
  persisted.discovery = {
    ...persisted.discovery,
    exhausted: allEligibleQueriesCompleted,
    remaining_queries: queryReconciliation.remaining,
    exhaustion_evidence: {
      source: 'FORMAL_SOP07_POSITIVE_CORE_PRODUCT_QUERIES',
      sop07_version: versions.top20,
      eligible_query_count: eligibleQueryExactStrings.length,
      completed_query_count: completedQueryExactStrings.size,
      remaining_query_count: queryReconciliation.remaining.length,
      checked_at: iso(),
    },
  };
  const usableCount = Number(persisted.usable_primary_pool_count || 0);
  if (usableCount < 1 || !(persisted.main_comparison_pool || []).length) {
    throw Object.assign(new Error('没有可形成最终 SOP08 竞品池的真实对象。'), { code: 'SOP08_FINAL_POOL_EMPTY' });
  }
  if (usableCount < 3) {
    persisted.confidence_status = 'LOW_COMPETITOR_POOL_CONFIDENCE';
    persisted.confidence_reason = 'FEWER_THAN_THREE_USABLE_COMPETITORS_AFTER_EXHAUSTIVE_DISCOVERY';
    persisted.confidence_details = `穷尽现有发现查询后仅有 ${usableCount} 个可用主要比较对象。`;
  }
  const domainQa = qaListingSop08Pool({ artifact: persisted, expectedVersions: versions });
  const sourceLineage = await verifySop08SourceLineage(root, workingTask, persisted, versions);
  const evidenceRefs = [...new Set([
    ...candidateRows.flatMap(item => item.evidence_refs || []),
    ...(persisted.discovery?.discovered_candidates || []).flatMap(item => [item.product_list_evidence_ref, item.placement_evidence_ref]),
    ...queryRows.map(item => item.evidence_ref),
  ].filter(Boolean))];
  const missingEvidence = [];
  for (const reference of evidenceRefs) {
    const file = path.resolve(root, reference);
    if (!file.startsWith(`${root}${path.sep}`) || !await fs.stat(file).catch(() => null)) missingEvidence.push(reference);
  }
  const queryExhaustionProven = persisted.discovery?.triggered !== true
    || (allEligibleQueriesCompleted && queryRows.length > 0 && queryRows.every(item => item.status === 'PASS'));
  const recoverableIssueCodes = new Set(['SOP08_EVIDENCE_TRACEABLE', 'SOP08_DISCOVERY_EVIDENCE', 'SOP08_SOURCE_LINEAGE', 'SOP08_DISCOVERY_EVIDENCE_CONTENT']);
  const coreEvidenceValid = domainQa.status === 'PASS' && sourceLineage.pass && missingEvidence.length === 0
    && queryExhaustionProven && queryReconciliation.remaining.length === 0;
  const resolvedIssueIds = [];
  if (coreEvidenceValid) {
    for (const issue of workingTask.issues || []) {
      if (issue.status === 'OPEN' && issue.step === 'LISTING_SOP_08'
        && issue.location === 'outputs.listing_competitor_pool' && recoverableIssueCodes.has(issue.code)) {
        issue.status = 'CLOSED';
        issue.closed_at = iso();
        issue.updated_at = issue.closed_at;
        issue.close_reason = 'RECOVERED_BY_PERSISTED_EVIDENCE_RECONCILIATION';
        issue.closure_evidence = { artifact_version: persisted.version, source_lineage_pass: true,
          promoted_query_count: queryReconciliation.promoted.length, external_requests: 0 };
        resolvedIssueIds.push(issue.issue_id);
      }
    }
  }
  workingTask.open_error_count = activeIssueCount(workingTask);
  const finalChecks = [
    { code: 'SOP08_LOCAL_CONVERGENCE_COMPLETE', pass: checkpoint.local_convergence_status === 'PASS', message: '本地候选收敛已完成。' },
    { code: 'SOP08_REMOTE_SUPPLEMENT_EXHAUSTED', pass: queryExhaustionProven && (reconciledCheckpoint.remaining_discovery_queries || []).length === 0, message: queryExhaustionProven ? '远程补充查询已穷尽且没有剩余 query。' : '远程补充尚未证明已穷尽。' },
    { code: 'SOP08_NO_UNRESOLVED_CANDIDATES', pass: (persisted.discovery?.unresolved_candidates || []).length === 0, message: '没有未处理候选。' },
    { code: 'SOP08_NO_ACTIVE_REMOTE_REQUEST', pass: (!activeLease || activeLease.execution_id === allowActiveExecutionId) && queryRows.every(item => item.status !== 'RUNNING'), message: '没有活动远程请求；如有租约，仅属于当前最终收口执行。' },
    { code: 'SOP08_FINAL_POOL_PRESENT', pass: usableCount > 0 && (persisted.main_comparison_pool || []).length > 0, message: '最终竞品池至少有一个真实可用对象。' },
    { code: 'SOP08_LOW_CONFIDENCE_EXPLICIT', pass: usableCount >= 3 || (persisted.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE' && typeof persisted.confidence_reason === 'string' && persisted.confidence_reason.length > 0), message: usableCount >= 3 ? '主要比较池达到目标数量。' : '池数量不足已按穷尽发现结果标记低置信。' },
    { code: 'SOP08_SOURCE_LINEAGE_VALID', pass: sourceLineage.pass, message: sourceLineage.pass ? '源候选与 discovery 结果均能追溯到正式上游和实际 evidence。' : `来源lineage有${sourceLineage.failures.length}项未通过。` },
    { code: 'SOP08_EVIDENCE_PERSISTED', pass: missingEvidence.length === 0, message: missingEvidence.length ? `${missingEvidence.length} 条证据不可读取。` : '所有候选、查询和上游证据均可读取。' },
    { code: 'OPEN_ERROR_COUNT_ZERO', pass: activeIssueCount(workingTask) === 0, message: activeIssueCount(workingTask) === 0 ? '当前 SKU 没有 OPEN_ERROR。' : `仍有 ${activeIssueCount(workingTask)} 个不属于本次可恢复 evidence issue 的 OPEN_ERROR。` },
  ];
  const failedChecks = [...domainQa.checks.filter(item => !item.pass), ...finalChecks.filter(item => !item.pass)];
  if (failedChecks.length) {
    throw Object.assign(new Error(`SOP08 最终 Stage QA 未通过：${failedChecks.map(item => item.code).join(', ')}`), { code: 'SOP08_FINAL_QA_FAILED', checks: failedChecks });
  }

  const checkedAt = iso();
  persisted.status = 'PASS';
  persisted.qa_status = 'PASS';
  persisted.qa = { status: 'PASS', checked_at: checkedAt, checks: [...domainQa.checks, ...finalChecks] };
  workingTask.outputs.listing_competitor_pool = clone(persisted);
  workingTask.outputs.competitors = clone(persisted);
  const stageProblems = await validateStage(workingTask, 'LISTING_SOP_08', dataRoot);
  if (stageProblems.length) {
    throw Object.assign(new Error(`SOP08 Stage QA 未通过：${stageProblems.map(item => item[0]).join(', ')}`), { code: 'SOP08_FINAL_STAGE_QA_FAILED', checks: stageProblems });
  }
  const finalPath = path.resolve(root, 'artifacts', 'listing', task.sku, 'sop08', `${persisted.version}.json`);
  const finalRef = path.relative(root, finalPath).replace(/\\/g, '/');
  persisted.evidence.artifact_ref = finalRef;
  if (await fs.stat(finalPath).catch(() => null)) {
    const existing = JSON.parse(await fs.readFile(finalPath, 'utf8'));
    if (existing.version !== persisted.version || existing.status !== 'PASS' || existing.qa?.status !== 'PASS') {
      throw Object.assign(new Error('SOP08 正式版本路径已存在不同内容；拒绝覆盖历史 artifact。'), { code: 'SOP08_ARTIFACT_VERSION_COLLISION' });
    }
  } else {
    await atomicJson(finalPath, persisted);
  }

  const finalEvidenceRefs = [finalRef, pendingRef, checkpoint.candidate_manifest_ref, ...evidenceRefs].filter(Boolean);
  workingTask.outputs.listing_competitor_pool = clone(persisted);
  workingTask.outputs.competitors = clone(persisted);
  workingTask.listing_executor.artifacts.listing_outputs.LISTING_SOP_08 = clone(persisted);
  workingTask.listing_executor.artifacts.sop08_execution.remote_supplement_status = usableCount < 3 ? 'EXHAUSTED_LOW_CONFIDENCE' : 'COMPLETE';
  workingTask.listing_executor.registry.LISTING_SOP_08 = {
    ...workingTask.listing_executor.registry.LISTING_SOP_08,
    status: 'PASS', qa_status: 'PASS', output_version: persisted.version,
    output_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION', evidence_refs: finalEvidenceRefs,
    input_version_refs: [
      { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: versions.facts },
      { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: versions.sop03 },
      { artifact_type: 'LISTING_TOP20_VERSION', version: versions.top20 },
    ], waiting_reason: null, completed_at: checkedAt, updated_at: checkedAt,
  };
  workingTask.qa.LISTING_SOP_08 = { status: 'PASS', checked_at: checkedAt, report: finalChecks };
  workingTask.stages.LISTING_SOP_08 = { ...workingTask.stages.LISTING_SOP_08, status: 'PASS', qa_status: 'PASS', output_version: persisted.version, waiting_reason: null, updated_at: checkedAt };
  workingTask.listing_sop.steps.LISTING_SOP_08 = { ...workingTask.listing_sop.steps.LISTING_SOP_08, status: 'PASS', qa_status: 'PASS', output_version: persisted.version, updated_at: checkedAt };
  workingTask.last_success_step = 'LISTING_SOP_08';
  workingTask.current_step = 'LISTING_SOP_09';
  workingTask.resume_point = 'LISTING_SOP_09';
  workingTask.listing_sop.current_step_id = 'LISTING_SOP_09';
  workingTask.waiting_dependency_key = null;
  workingTask.error_code = null; workingTask.error_message = null;
  workingTask.open_error_count = activeIssueCount(workingTask);
  workingTask.status = 'PAUSED';
  workingTask.activity_pool = 'Listing 生成池'; workingTask.current_pool = workingTask.activity_pool;
  workingTask.acceptance_stop_gate = null;

  await commit(dataRoot, workingTask, 'SOP08_PERSISTED_EVIDENCE_RECONCILED', {
    step: 'LISTING_SOP_08', source_artifact_version: output.version, artifact_version: persisted.version,
    promoted_queries: queryReconciliation.promoted, resolved_issue_ids: resolvedIssueIds,
    candidate_classification_counts: persisted.counts, usable_primary_pool_count: usableCount,
    external_requests: 0,
  }, { expectedRevision: task.revision });
  await commit(dataRoot, workingTask, 'LISTING_SOP_08_STAGE_QA_PASS', {
    step: 'LISTING_SOP_08', version: persisted.version, effective_count: persisted.effective_count,
    reference_count: persisted.reference_count, invalid_count: persisted.invalid_count,
    comparison_pool_count: persisted.main_comparison_pool.length, confidence_status: persisted.confidence_status,
    confidence_reason: persisted.confidence_reason, resolved_issue_ids: resolvedIssueIds,
    resumed_from_persisted_evidence: true, external_requests: 0,
  }, { expectedRevision: workingTask.revision });
  return { task: workingTask, qa_checks: persisted.qa.checks, artifact_version: persisted.version,
    reconciled_queries: queryReconciliation.promoted, next_step: 'LISTING_SOP_09', sop09_dispatched: false, external_requests: 0 };
}

export async function validateStage(task, step, dataRoot) {
  const master = task.master;
  const problems = [];
  if (step === 'LISTING_SOP_01') {
    return await validateOwnMaterialsSnapshot(task, dataRoot);
  } else if (step === 'LISTING_SOP_02') {
    const version = task.outputs?.confirmed_product_facts;
    if (task.qa?.LISTING_SOP_01?.status !== 'PASS') problems.push(['SOP02_SOP01_GATE_NOT_PASS', 'SOP02 只能消费已通过 Stage QA 的 SOP01 快照。', 'qa.LISTING_SOP_01.status', 'PASS', '先完成 SOP01 Stage QA。']);
    if (!task.listing_sop?.own_materials_snapshots?.some(item => Number(item.snapshot_version) === Number(version?.source_snapshot_version))) problems.push(['SOP02_SNAPSHOT_VERSION_NOT_PERSISTED', 'SOP02 输入快照版本没有保存在版本历史中。', 'listing_sop.own_materials_snapshots', '与 confirmed facts 输入版本一致的历史快照', '恢复或重新生成已持久化的 SOP01 快照。']);
    if (!version || version.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || version.sku !== task.sku) problems.push(['SOP02_FACTS_VERSION_MISSING', '缺少当前 SKU 的确认事实版本。', 'outputs.confirmed_product_facts', '已冻结的 CONFIRMED_PRODUCT_FACTS_VERSION', '重新执行事实确认并完成待确认项。']);
    if (!task.listing_sop?.confirmed_product_facts_versions?.some(item => Number(item.version) === Number(version?.version))) problems.push(['SOP02_FACTS_HISTORY_MISSING', '当前确认事实版本没有保存在不可覆盖的版本历史中。', 'listing_sop.confirmed_product_facts_versions', '与当前输出相同的已持久化版本', '重新生成并保存事实版本。']);
    if (task.confirmation?.status === 'OPEN' || (version?.proposals || []).length) problems.push(['SOP02_CONFIRMATION_OPEN', '仍有事实冲突或新增事实等待 Leon 确认。', 'confirmation.proposals', '所有可确认事实已决定；不确认项显式保留 UNKNOWN', '在待人工确认中心完成确认或忽略，再重新核验。']);
    for (const [field, fact] of Object.entries(version?.fields || {})) {
      if (!['CONFIRMED', 'UNKNOWN'].includes(fact.status)) problems.push(['SOP02_FACT_STATUS_INVALID', `字段 ${field} 仍处于 ${fact.status}。`, `outputs.confirmed_product_facts.fields.${field}.status`, 'CONFIRMED 或 UNKNOWN', '处理事实确认后重新核验。']);
      if (fact.status === 'UNKNOWN' && fact.value !== 'UNKNOWN') problems.push(['SOP02_UNKNOWN_NOT_EXPLICIT', `字段 ${field} 的未知值未显式标记。`, `outputs.confirmed_product_facts.fields.${field}.value`, 'UNKNOWN', '保留为 UNKNOWN，不推断填值。']);
      if (fact.status === 'CONFIRMED' && (!fact.source_references?.length || fact.source_references.some(ref => !OWN_SOURCE_TYPES.has(ref.source_type) || !ref.source_reference || !ref.source_version))) problems.push(['SOP02_CONFIRMED_SOURCE_MISSING', `已确认事实 ${field} 缺少自有来源证据。`, `outputs.confirmed_product_facts.fields.${field}.source_references`, '可追溯的自有来源和版本', '补齐来源证据后重新核验。']);
    }
    if (!Number.isInteger(version?.version) || version.version < 1 || !version?.created_at || !version?.source_snapshot_version) problems.push(['SOP02_VERSION_INVALID', '确认事实版本或输入快照版本无效。', 'outputs.confirmed_product_facts', '有版本号、时间和 OWN_MATERIALS_SNAPSHOT 版本', '重新生成确认事实版本。']);
  } else if (step === 'LISTING_SOP_09') {
    const output = task.outputs?.competitor_analysis;
    const evidence = output?.evidence || {};
    if (output?.artifact_type !== 'LISTING_COMPETITOR_ANALYSIS_VERSION' || !output?.version || evidence.version !== output.version || !evidence.artifact_ref || !evidence.qa_ref) {
      problems.push(['SOP09_OUTPUT_ARTIFACT_MISSING', 'SOP09 Executor未保存带版本的正式分析产物和QA引用。', 'outputs.competitor_analysis.evidence', 'analysis与QA文件均在当前SKU的正式SOP09版本目录中', '确认执行器输出路径和版本化证据引用。']);
    } else {
      try {
        const artifactPath = safeMaterialPath(dataRoot, evidence.artifact_ref);
        const qaPath = safeMaterialPath(dataRoot, evidence.qa_ref);
        const persistedArtifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
        const persistedQa = JSON.parse(await fs.readFile(qaPath, 'utf8'));
        const expectedVersions = expectedSop09RuntimeVersions(task, dataRoot);
        const inputs = await resolveSop09RuntimeInputs({ dataRoot, task, expectedVersions });
        if (persistedArtifact.version !== output.version || persistedArtifact.artifact_type !== 'LISTING_COMPETITOR_ANALYSIS_VERSION'
          || persistedArtifact.sku !== task.sku || persistedQa.status !== 'PASS' || persistedQa.external_requests !== 0) {
          problems.push(['SOP09_PERSISTED_OUTPUT_MISMATCH', 'SOP09正式产物或QA文件与任务引用不匹配。', 'outputs.competitor_analysis', '当前SKU、分析版本、QA PASS且无外部请求', '检查正式版本目录中的不可变分析和QA文件。']);
        } else {
          // Runtime input resolution returns both an immutable reference bundle
          // and a hydrated in-memory view of the exact resolved PAGE/API facts.
          // Stage QA must consume the same hydrated view as the executor; using
          // reference wrappers here turns historical/NOT_RUN temporal metadata
          // into false TIME_UNKNOWN mismatches.
          const qaInputs = { ...inputs, bolEvidenceBundle: inputs.bolEvidenceBundleForAnalysis || inputs.bolEvidenceBundle };
          const qa = qaListingCompetitorAnalysis({ artifact: persistedArtifact, inputs: qaInputs });
          if (qa.status !== 'PASS') for (const failed of qa.checks.filter(item => !item.pass)) {
            problems.push([failed.code, failed.message, `artifacts.listing.${task.sku}.sop09.${output.version}`, '14项SOP09 QA全部PASS', '使用已锁定的本地输入重新核验产物。']);
          }
        }
      } catch (error) {
        problems.push([error.code || 'SOP09_INPUT_RESOLUTION_FAILED', `SOP09正式输入或证据不可读取：${error.message}`, 'outputs.competitor_analysis.evidence', '全部版本化输入及证据可从当前dataRoot精确读取', '修复明确缺失/歧义引用；不得猜测或改用离线产物。']);
      }
    }
  } else if (Object.hasOwn(SOP10_17_EXECUTOR_IDS, step)) {
    const outputKey = sop10To17OutputKey(step);
    const output = task.outputs?.[outputKey];
    const evidence = output?.evidence || {};
    if (output?.artifact_type !== ({
      LISTING_SOP_10: 'LISTING_BUYER_INSIGHTS_VERSION', LISTING_SOP_11: 'LISTING_OWN_COMPETITOR_COMPARISON_VERSION',
      LISTING_SOP_12: 'LISTING_SELLING_POINT_MATRIX_VERSION', LISTING_SOP_13: 'LISTING_DISPLAY_WEIGHTING_VERSION',
      LISTING_SOP_14: 'LISTING_TITLE_VERSION', LISTING_SOP_15: 'LISTING_ANCHORS_VERSION',
      LISTING_SOP_16: 'LISTING_DESCRIPTION_PACKAGE_ATTRIBUTES_VERSION', LISTING_SOP_17: 'LISTING_FINAL_QA_REPORT',
    })[step] || !output?.version || evidence.version !== output.version || !evidence.artifact_ref || !evidence.qa_ref) {
      problems.push(['SOP10_17_ARTIFACT_MISSING', `${step}缺少正式版本产物或 QA evidence 引用。`, `outputs.${outputKey}`, '版本、结果文件和 PASS QA 文件均已持久化', '从当前步骤重新执行并核验。']);
    } else {
      try {
        const artifactPath = safeMaterialPath(dataRoot, evidence.artifact_ref);
        const qaPath = safeMaterialPath(dataRoot, evidence.qa_ref);
        const persisted = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
        const qaRecord = JSON.parse(await fs.readFile(qaPath, 'utf8'));
        const inputs = await resolveSop10To17Inputs(dataRoot, task, step);
        const qa = qaSop10To17Output(step, persisted, inputs, task);
        if (persisted.version !== output.version || persisted.artifact_type !== output.artifact_type || persisted.sku !== task.sku
          || qaRecord.status !== 'PASS' || qa.status !== 'PASS' || Number(evidence.bol_amazon_external_requests || 0) !== 0
          || Number(evidence.external_requests || 0) !== Number(evidence.ai_provider_requests || 0)) {
          for (const failed of qa.checks.filter(item => !item.pass)) problems.push([failed.code, failed.message, `artifacts.listing.${task.sku}.${step.toLowerCase()}`, '持久化版本、输入哈希、证据引用和 Stage QA 全部有效', '修复对应输入/产物后重新执行 Stage QA。']);
          if (qaRecord.status !== 'PASS') problems.push(['SOP10_17_PERSISTED_QA_NOT_PASS', `${step}持久化 QA 记录不是 PASS。`, evidence.qa_ref, 'PASS', '只在重新核验通过后登记 PASS。']);
          if (Number(evidence.bol_amazon_external_requests || 0) !== 0 || Number(evidence.external_requests || 0) !== Number(evidence.ai_provider_requests || 0)) problems.push(['SOP10_17_EXTERNAL_REQUESTS_UNEXPECTED', `${step}的 BOL/Amazon 请求计数或 AI 请求审计不一致。`, `outputs.${outputKey}.evidence`, 'BOL/Amazon 请求为 0，AI Provider 请求数与总外部请求数一致', '核查执行器请求计数和证据记录。']);
        }
        if (Number(output.open_error_count || 0) > 0 || activeIssueCount(task) > 0) problems.push(['SOP10_17_OPEN_ERRORS', `${step}仍有未关闭业务错误。`, 'issues', 'OPEN_ERROR_COUNT=0', '先修复并重新核验。']);
      } catch (error) {
        problems.push([error.code || 'SOP10_17_ARTIFACT_UNREADABLE', `${step}正式输入或产物不可读取：${error.message}`, `outputs.${outputKey}.evidence`, '当前 dataRoot 内可读取且版本一致的输入与产物', '恢复明确缺失的文件后重新核验。']);
      }
    }
  } else if (step === 'product_master') {
    if (!master.sku) problems.push(['SKU_MISSING', 'Product Master.SKU 为空。', 'master.sku', '非空且唯一的 SKU', '填写唯一 SKU。']);
    if (!master.name) problems.push(['PRODUCT_NAME_MISSING', '产品名称为空。', 'master.name', '有来源依据的产品名称', '补充产品名称并保留资料来源。']);
    if (!master.source_refs.length) problems.push(['FACT_SOURCE_MISSING', '缺少自家产品/1688/自家图片等事实来源引用。', 'master.source_refs', '至少一个可追溯的自有产品事实来源', '添加来源文件或自有资料链接。']);
    if (master.weight_kg != null && (!Number.isFinite(master.weight_kg) || master.weight_kg < 0)) problems.push(['WEIGHT_INVALID', '重量不是有效的 kg 数值。', 'master.weight_kg', '非负数，单位 kg', '核对原始 kg 重量。']);
  } else if (step === 'boloo_keywords') {
    const required = task.boloo?.required_subtasks || [];
    if (task.boloo?.keyword_discovery_closed !== true) problems.push(['BOLOO_DISCOVERY_OPEN', '关键词发现尚未明确关闭，不能进入 TOP20。', 'boloo.keyword_discovery_closed', 'discovery_closed=true 且所有发现来源和候选已处理', '处理完全部来源与新增候选、确认候选队列为空后关闭 discovery。']);
    const closeEvidence = task.boloo?.discovery_close_evidence;
    if (task.boloo?.keyword_discovery_closed === true) {
      const acceptanceFixture = isAcceptanceBolooFixture(dataRoot, task);
      const evidenceProblems = acceptanceFixture ? [] : discoveryEvidenceProblems(task, closeEvidence);
      if (evidenceProblems.length) problems.push(['BOLOO_DISCOVERY_CLOSE_EVIDENCE_INVALID', `Discovery 来源证据未覆盖或不匹配：${evidenceProblems.join('; ')}`, 'boloo.discovery_close_evidence.discovery_sources', 'Product Facts、BOL 竞品、Amazon 竞品、Boloo 竞品链接、5–7 个 BOL 关联词及其他已确认来源均明确完成', '逐项补齐来源完整状态、候选数、BOL 搜索词缓存复用核验及其他来源清单。']);
      const confirmedCount = (task.boloo?.candidates || []).filter(candidate => candidate.candidate_status === 'CONFIRMED_VOLUME').length;
      if (!acceptanceFixture && confirmedCount < 20) problems.push(['BOLOO_CONFIRMED_VOLUME_CANDIDATES_INSUFFICIENT', `仅有 ${confirmedCount} 个正式 Boloo 搜索量候选，TOP20 需要至少 20 个。`, 'boloo.candidates', '至少 20 个有正式 Boloo 搜索量且 QA PASS 的精确关键词', '保持 discovery 开放，继续扩充并查询候选池；NO_RESULT 和零结果不能补足正式搜索量候选数。']);
    }
    if (!required.length) problems.push(['BOLOO_REQUIRED_SUBTASKS_MISSING', 'Boloo 尚未配置必需查询子任务。', 'boloo.required_subtasks', '由上游 Listing 产物配置每条精确关键词和竞品 URL 子任务', '先提交完整 exact keywords 与 competitor URLs 清单；未配置前禁止阶段放行。']);
    const incomplete = required.filter(subtask => !['PASS', 'PASS_NO_RESULT'].includes(subtask.status));
    if (incomplete.length) problems.push(['BOLOO_SUBTASKS_INCOMPLETE', `仍有 ${incomplete.length} 个 Boloo 子任务未完成。`, 'boloo.required_subtasks', '每个 required_subtask 均为 PASS 或合法 PASS_NO_RESULT', '继续当前子任务；不得因单个查询完成而放行整个 Boloo 阶段。']);
    const pending = required.filter(subtask => subtask.status === 'PENDING_RECHECK');
    if (pending.length) problems.push(['BOLOO_SUBTASKS_PENDING', `仍有 ${pending.length} 个 Boloo 子任务等待重查。`, 'boloo.required_subtasks', 'PENDING_RECHECK_COUNT=0', '按对应子任务继续检查，完成前不得进入 Stage QA。']);
    if (activeIssueCount(task) > 0) problems.push(['BOLOO_OPEN_ERRORS', `Boloo 子任务仍有 ${activeIssueCount(task)} 个 OPEN_ERROR。`, 'issues', 'OPEN_ERROR_COUNT=0', '先完成所有子任务异常的修复与重新核验，再进行 Boloo Stage QA。']);
    const invalid = required.filter(subtask => {
      const evidence = subtask.result?.evidence;
      if (!['PASS', 'PASS_NO_RESULT'].includes(subtask.status)) return false;
      if (subtask.result?.status !== subtask.status || !subtask.result?.reason_code || subtask.result.query_text !== subtask.query_text
        || (!subtask.result?.cache_reused && !evidence?.page_url)
        || subtask.result?.cache_reused && (evidence?.source !== 'BOLOO_OFFICIAL_VERIFIED' || !evidence.cache_record_id || !['BOLOO_OFFICIAL_WEB', 'BOLOO_OFFICIAL_MCP'].includes(evidence.provider_method))
        || evidence.matched_query !== subtask.query_text || !evidence.displayed_value) return true;
      if (subtask.status === 'PASS' && (!subtask.result.result || subtask.provider_source === 'keyword_explorer' && ['0', '0.0', '0,0'].includes(String(evidence.displayed_value).trim()) && subtask.result.reason_code !== 'EXPLORER_ZERO_VOLUME')) return true;
      if (subtask.status === 'PASS_NO_RESULT') {
        const expected = subtask.provider_source === 'keyword_extractor' ? 'EXTRACTOR_NO_KEYWORDS' : 'EXPLORER_NO_RESULTS';
        return subtask.result.reason_code !== expected || evidence.no_result_confirmed !== true;
      }
      return false;
    });
    if (invalid.length) problems.push(['BOLOO_SUBTASK_EVIDENCE_INVALID', `有 ${invalid.length} 个已完成子任务缺少合法结果或页面证据。`, 'boloo.required_subtasks', '每个 PASS/PASS_NO_RESULT 子任务均有匹配查询的页面证据', '补齐该子任务结果、精确查询匹配和页面证据后重新核验。']);
    const invalidCandidates = (isAcceptanceBolooFixture(dataRoot, task) ? [] : task.boloo?.candidates || []).filter(candidate => !BOLOO_CANDIDATE_STATUSES.has(candidate.candidate_status)
      || typeof candidate.query_text !== 'string' || !candidate.query_text.trim()
      || candidate.candidate_status === 'EXCLUDED' && !candidate.exclusion_reason
      || candidate.candidate_status === 'NO_RESULT' && (candidate.confirmed_volume !== null || !hasFormalBolooNoResult(task, candidate))
      || candidate.candidate_status === 'CONFIRMED_VOLUME' && (!Number.isFinite(candidate.confirmed_volume) || candidate.confirmed_volume < 0 || !hasFormalBolooVolume(task, candidate)));
    if (invalidCandidates.length) problems.push(['BOLOO_CANDIDATE_STATE_INVALID', `有 ${invalidCandidates.length} 个关键词候选状态或证据无效。`, 'boloo.candidates', '候选状态符合白名单，EXCLUDED 有原因，CONFIRMED_VOLUME 有正式数值', '修正候选状态、排除原因或正式搜索量证据后重新核验。']);
  } else if (step === 'LISTING_SOP_04') {
    const output = task.outputs?.bol_keywords;
    const pendingDecision = (task.listing_executor?.waiting_items || []).some(item => !item.decided_at
      && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04');
    if (pendingDecision) return problems;
    if (!output || output.artifact_type !== 'BOL_RELATED_TERMS_SET' || !output.evidence?.artifact_ref) problems.push(['SOP04_ARTIFACT_MISSING', 'SOP04 缺少已保存的 Search Terms 产物。', 'outputs.bol_keywords', 'BOL_RELATED_TERMS_SET 与持久化 evidence', '从当前 SOP04 断点执行真实 Search Terms。']);
    else {
      const sourceQueries = Array.isArray(output.source_query_artifacts) ? output.source_query_artifacts : [];
      const allRawTerms = [
        ...sourceQueries.flatMap(query => Array.isArray(query.returned_raw_terms) ? query.returned_raw_terms
          : query.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms || []),
        ...(output.returned_raw_terms || []),
      ];
      const uniqueCandidates = [];
      const seen = new Set();
      for (const term of allRawTerms) {
        const exact = typeof term?.searchTerm === 'string' ? term.searchTerm : '';
        if (exact && !seen.has(exact)) { seen.add(exact); uniqueCandidates.push(exact); }
      }
      const hasMultipleQuerySources = sourceQueries.length > 0;
      const candidateStrings = output.candidate_exact_strings || [];
      const candidateSourceMismatch = hasMultipleQuerySources
        ? candidateStrings.some(exact => !uniqueCandidates.includes(exact))
          || (output.returned_raw_terms || []).some(term => typeof term?.searchTerm === 'string' && !candidateStrings.includes(term.searchTerm))
        : JSON.stringify(uniqueCandidates) !== JSON.stringify(candidateStrings);
      if (candidateSourceMismatch) problems.push(['SOP04_RAW_ORDER_OR_DEDUP_MISMATCH', '多次 Search Terms 的候选必须可追溯到各自原始响应，且本次完整原始响应候选不得丢失。', 'outputs.bol_keywords.candidate_exact_strings', '每个候选均来自已保存的一个或多个 raw query artifact；本次响应顺序与 exact-string 去重保持一致', '保留各次 raw response 和来源版本；不得排序、改写或补造。']);
      if (!Array.isArray(output.adopted_terms) || output.adopted_terms.length < 5 || output.adopted_terms.length > 7
        || new Set((output.adopted_terms || []).map(item => item.exact_string)).size !== output.adopted_terms?.length
        || (output.adopted_terms || []).some(item => !uniqueCandidates.includes(item.exact_string))) problems.push(['SOP04_ADOPTED_COUNT_INVALID', 'SOP04正式采用词必须为5–7个真实返回的唯一exact string。', 'outputs.bol_keywords.adopted_terms', '5–7个来自已保存候选的exact string', '若候选多于7个由Leon选择；少于5个不得补造。']);
      if (output.seed_exact_string !== task.sop04_seed_selection?.exact_string) problems.push(['SOP04_SEED_DECISION_MISMATCH', 'Search Terms seed 与当前 SKU 已记录的 seed 选择不一致。', 'outputs.bol_keywords.seed_exact_string', task.sop04_seed_selection?.exact_string || '当前 SKU 已记录的 SOP04 seed', '核对该 SKU 的 seed 选择记录和 SOP04 artifact 版本。']);
      if (Number(output.confirmed_product_facts_version) !== Number(task.outputs.confirmed_product_facts?.version)
        || String(output.sop03_artifact_version) !== String(task.listing_executor?.registry?.LISTING_SOP_03?.output_version)) problems.push(['SOP04_INPUT_VERSION_MISMATCH', 'SOP04 未引用当前 Product Facts 和 SOP03 artifact 版本。', 'outputs.bol_keywords', '当前 CONFIRMED_PRODUCT_FACTS_VERSION 与 SOP03 artifact version', '从正确版本断点重新执行并保留旧 artifact。']);
      if (Number(output.api_evidence?.http_status) !== 200 || !output.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms) problems.push(['SOP04_API_EVIDENCE_INVALID', 'SOP04 缺少 HTTP 200 和完整 Search Terms 原始响应。', 'outputs.bol_keywords.api_evidence', 'HTTP 200 与原始 relatedSearchTerms', '核对 API evidence；不得手工补齐。']);
      if ((output.adopted_terms || []).some(item => Object.hasOwn(item, 'total') || Object.hasOwn(item, 'search_volume') || Object.hasOwn(item, 'boloo_search_volume'))) problems.push(['SOP04_NUMBER_FIELD_CONTAMINATION', 'Search Terms 数字进入正式采用词字段。', 'outputs.bol_keywords.adopted_terms', '正式采用词只保存 exact string 与来源', '移除数字字段，Search Terms数字只留在 raw evidence。']);
      const artifactPath = path.resolve(dataRoot, output.evidence.artifact_ref);
      if (!artifactPath.startsWith(`${path.resolve(dataRoot)}${path.sep}`) || !await fs.stat(artifactPath).catch(() => null)) problems.push(['SOP04_EVIDENCE_NOT_PERSISTED', 'SOP04 artifact 文件不可读取或超出当前数据根。', 'outputs.bol_keywords.evidence.artifact_ref', '当前验收数据根内的已持久化artifact', '恢复证据文件后重新核验。']);
      if (output.related_term_selection_policy === SOP04_MULTI_SEED_POLICY) {
        const querySources = Array.isArray(output.source_query_artifacts) ? output.source_query_artifacts : [];
        const allQueries = [...querySources, {
          version: output.version, artifact_ref: output.evidence.artifact_ref,
          seed_exact_string: output.last_seed_exact_string || output.seed_exact_string,
          returned_raw_terms: output.returned_raw_terms, api_evidence: output.api_evidence,
        }];
        const seedSequence = allQueries.map(item => item.seed_exact_string);
        if (allQueries.length < 1 || allQueries.length > 3 || seedSequence.some(value => !value)
          || new Set(seedSequence).size !== seedSequence.length
          || JSON.stringify(output.seed_exact_strings || []) !== JSON.stringify(seedSequence)) {
          problems.push(['SOP04_MULTI_SEED_SEQUENCE_INVALID', '多 seed 查询顺序、数量或 exact seed 记录不一致。', 'outputs.bol_keywords.seed_exact_strings', '1–3 个有来源的 exact seed，顺序与实际查询一致', '从持久化查询 attempt 和 raw artifact 逐项核对；不得重发已成功查询。']);
        }
        const incompleteQuery = allQueries.find(item => !item.version || !item.artifact_ref
          || Number(item.api_evidence?.http_status) !== 200
          || !Array.isArray(item.returned_raw_terms || item.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms));
        if (incompleteQuery) problems.push(['SOP04_MULTI_SEED_QUERY_EVIDENCE_INCOMPLETE', '有 seed 查询缺少可读版本、artifact ref、HTTP 200 或完整 raw terms。', 'outputs.bol_keywords.source_query_artifacts', '每个实际 seed 查询都有不可变 raw artifact 和完整 API evidence', '核对每次真实查询的落盘 artifact；禁止用引用字符串代替证据。']);
        const annotations = Array.isArray(output.candidate_status_annotations) ? output.candidate_status_annotations : [];
        if ((output.adopted_terms || []).some(item => !annotations.some(row => row.exact_string === item.exact_string
          && ['RELEVANT_FACT_SUPPORTED', 'ADOPTED_BY_LEON_FACT_RULE'].includes(row.status)))) {
          problems.push(['SOP04_MULTI_SEED_ADOPTION_UNSUPPORTED', '正式采用词没有对应的事实相关性分类记录。', 'outputs.bol_keywords.candidate_status_annotations', '每个 adopted exact string 均有事实支持的分类及来源 seed', '只采用被当前 confirmed facts 支持、且真实出现在 Search Terms raw response 的 exact string。']);
        }
        if ((output.excluded_terms || []).some(item => !allQueries.some(query => (query.returned_raw_terms || []).some(raw => raw?.searchTerm === item.exact_string)))) {
          problems.push(['SOP04_MULTI_SEED_EXCLUSION_UNTRACEABLE', '排除记录不属于任何已保存 Search Terms raw response。', 'outputs.bol_keywords.excluded_terms', '每个排除 exact string 均可追溯到 raw response', '保留原始候选并核对 exact string；不得创造排除项。']);
        }
        try {
          const currentArtifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
          if (currentArtifact.version !== output.version || currentArtifact.sku !== task.sku
            || currentArtifact.related_term_selection_policy !== SOP04_MULTI_SEED_POLICY
            || JSON.stringify(currentArtifact.returned_raw_terms || []) !== JSON.stringify(output.returned_raw_terms || [])) {
            problems.push(['SOP04_MULTI_SEED_CURRENT_ARTIFACT_MISMATCH', '最终 SOP04 artifact 与任务引用中的 SKU、版本、policy 或 raw response 不一致。', output.evidence.artifact_ref, '不可变文件内容与正式 task output 完全一致', '保留原文件，查明写入或引用分歧后再执行 QA。']);
          }
          for (const sourceQuery of querySources) {
            const sourcePath = safeMaterialPath(dataRoot, sourceQuery.artifact_ref);
            const persistedSource = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
            if (persistedSource.version !== sourceQuery.version || persistedSource.sku !== task.sku
              || persistedSource.seed_exact_string !== sourceQuery.seed_exact_string
              || Number(persistedSource.api_evidence?.http_status) !== 200
              || JSON.stringify(persistedSource.returned_raw_terms || []) !== JSON.stringify(sourceQuery.returned_raw_terms || [])) {
              problems.push(['SOP04_MULTI_SEED_SOURCE_ARTIFACT_MISMATCH', `seed ${sourceQuery.seed_exact_string || '(missing)'} 的原始 artifact 与引用记录不一致。`, sourceQuery.artifact_ref || 'outputs.bol_keywords.source_query_artifacts', '精确 SKU/version/seed/raw response 一致', '仅引用真实、可读且匹配当前 SKU 的已持久化查询 artifact。']);
            }
          }
        } catch (error) {
          problems.push(['SOP04_MULTI_SEED_SOURCE_ARTIFACT_UNREADABLE', `多 seed 查询 evidence 无法解析：${error.message}`, 'outputs.bol_keywords.source_query_artifacts', '所有历史查询 artifact 可从当前 dataRoot 精确读取', '修复准确的缺失文件或引用；不得猜路径、补 placeholder。']);
        }
      }
    }
    if (Number(output?.open_error_count || 0) > 0 || activeIssueCount(task) > 0) problems.push(['SOP04_OPEN_ERRORS', 'SOP04 存在未关闭异常。', 'issues', 'OPEN_ERROR_COUNT=0', '先处理异常并重新核验。']);
  } else if (step === 'LISTING_SOP_05') {
    const output = task.outputs?.keyword_candidate_pool;
    if (!output || output.artifact_type !== 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL' || !output.evidence?.artifact_ref) {
      problems.push(['SOP05_ARTIFACT_MISSING', 'SOP05 缺少正式候选池产物或持久化引用。', 'outputs.keyword_candidate_pool', '当前 SKU 的正式候选池 artifact', '从当前 SOP05 断点运行已注册执行器；不得引用测试 fixture。']);
    } else {
      try {
        const inputs = await loadSop05Inputs(dataRoot, task);
        const target = safeMaterialPath(dataRoot, output.evidence.artifact_ref);
        const persistedBytes = await fs.readFile(target);
        const persisted = JSON.parse(persistedBytes.toString('utf8'));
        const outputComparable = clone(output); delete outputComparable.open_error_count;
        if (persisted.version !== output.version || persisted.sku !== task.sku
          || persisted.artifact_type !== 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL'
          || !isDeepStrictEqual(persisted, outputComparable)
          || !['PENDING_QA', 'PASS'].includes(persisted.status)
          || (persisted.status === 'PASS' && persisted.qa_status !== 'PASS')) {
          problems.push(['SOP05_PERSISTED_ARTIFACT_MISMATCH', 'SOP05 artifact 与 task 引用、身份或QA状态不一致。', 'outputs.keyword_candidate_pool.evidence.artifact_ref', '可读取且与正式task output完全一致的当前版本artifact', '保留原文件并核验版本、路径和持久化内容；不得以引用名代替证据。']);
        }
        const result = qaListingSop05Contract({ artifact: persisted, facts: inputs.facts, sop03: inputs.sop03, sop04: inputs.sop04,
          expectedVersions: { facts: inputs.facts.version, sop03: inputs.sop03Ref.version, sop04: inputs.sop04Ref.version }, evidenceResolver: inputs.evidenceResolver });
        for (const check of result.checks.filter(item => !item.pass)) problems.push([check.code, check.message, 'outputs.keyword_candidate_pool', 'SOP05候选、来源、exact string与strict evidence resolver全部通过', '核对明确来源及证据；不得补造候选、数字或evidence。']);
        if (Number(output.open_error_count || 0) !== 0 || activeIssueCount(task) !== 0) problems.push(['SOP05_OPEN_ERRORS', 'SOP05仍有关联OPEN_ERROR。', 'issues', 'OPEN_ERROR_COUNT=0', '先按正式恢复流程关闭已修复的内部错误，再进行Stage QA。']);
      } catch (error) {
        problems.push([error.code || 'SOP05_INPUT_EVIDENCE_INVALID', `SOP05输入或来源证据无法严格核验：${error.message}`, 'outputs.keyword_candidate_pool.input_versions', '当前facts、SOP03、SOP04及RAW/DOM证据可读且版本一致', '修复真实缺失或版本不匹配；不要猜路径或降级到其他证据层。']);
      }
    }
  } else if (step === 'LISTING_SOP_08') {
    const artifact = task.outputs?.listing_competitor_pool;
    if (!artifact || artifact.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION' || artifact.status !== 'PASS') {
      problems.push(['SOP08_ARTIFACT_MISSING_OR_NOT_PASS', 'SOP08缺少已完成QA的有效竞品池版本。', 'outputs.listing_competitor_pool', 'EFFECTIVE_COMPETITOR_POOL_VERSION 且 status=PASS', '完成候选核验与SOP08 Stage QA后重新核验。']);
    } else {
      const result = qaListingSop08Pool({ artifact, expectedVersions: sop08InputVersions(task) });
      for (const check of result.checks.filter(item => !item.pass)) problems.push([check.code, check.message, 'outputs.listing_competitor_pool', 'SOP08数据与来源核验通过', '修复对应数据或证据后重新核验，不得放宽分级条件。']);
      if (artifact.qa?.status !== 'PASS' || artifact.qa_status !== 'PASS') problems.push(['SOP08_QA_NOT_PASS', 'SOP08产物自身QA状态尚未通过。', 'outputs.listing_competitor_pool.qa', 'PASS', '完成SOP08证据与分级核验。']);
      if ((artifact.main_comparison_pool || []).length < 3 && artifact.confidence_status !== 'LOW_COMPETITOR_POOL_CONFIDENCE') problems.push(['SOP08_LOW_POOL_CONFIDENCE_MISSING', '主要有效竞品少于3个但未标记置信度降低。', 'outputs.listing_competitor_pool.confidence_status', 'LOW_COMPETITOR_POOL_CONFIDENCE', '如实标记有效数量不足，不得硬凑竞品。']);
      if (activeIssueCount(task) > 0) problems.push(['SOP08_OPEN_ERRORS', 'SOP08存在未关闭异常。', 'issues', 'OPEN_ERROR_COUNT=0', '先关闭异常并重新核验。']);
      const root = path.resolve(dataRoot);
      for (const reference of artifact.candidates.flatMap(item => item.evidence_refs || [])) {
        const file = path.resolve(root, reference);
        if (!file.startsWith(`${root}${path.sep}`) || !await fs.stat(file).catch(() => null)) problems.push(['SOP08_EVIDENCE_NOT_PERSISTED', `SOP08来源证据不可读取：${reference}`, 'outputs.listing_competitor_pool.candidates.evidence_refs', '当前数据根内可读取的来源证据', '恢复对应证据文件后重新核验。']);
      }
    }
  } else if (step === 'top20' && isAcceptanceBolooFixture(dataRoot, task)) {
    const output = task.outputs?.top20;
    if (!output || !output.evidence || !Object.keys(output.evidence).length) problems.push(['ENGINE_NOT_CONNECTED', '验收夹具TOP20缺少隔离产物证据。', 'outputs.top20', '仅用于隔离状态机验证的fixture evidence', '修复夹具输入后重新执行验收；不得作为真实Executor PASS。']);
    if (Number(output?.open_error_count || 0) > 0 || activeIssueCount(task) > 0) problems.push(['STAGE_OPEN_ERRORS', 'TOP20夹具存在未关闭异常。', 'outputs.top20.open_error_count', 'OPEN_ERROR_COUNT=0', '先清理隔离夹具异常。']);
  } else if (step === 'top20' || step === 'LISTING_SOP_07') {
    const output = task.outputs?.top20;
    if (!output || output.artifact_type !== 'LISTING_SOP_07_TOP20' || !output.evidence?.artifact_ref) {
      problems.push(['SOP07_ARTIFACT_MISSING', 'TOP20执行器尚无已持久化的正式产物。', 'outputs.top20', 'LISTING_SOP_07_TOP20版本artifact', '从当前SOP07断点执行已注册TOP20执行器。']);
    } else {
      if (output.status !== 'PASS' || output.qa_status !== 'PASS') problems.push(['SOP07_DONE_NOT_PASS', 'TOP20产物尚未完成最终Stage QA。', 'outputs.top20.status', 'status=PASS 且 qa_status=PASS', '仅在TOP20输入、排序、版本和证据复核全部通过后登记PASS。']);
      if (Number(output.open_error_count || 0) > 0 || activeIssueCount(task) > 0) problems.push(['SOP07_OPEN_ERRORS', 'SOP07产物仍有未关闭异常。', 'outputs.top20.open_error_count', 'OPEN_ERROR_COUNT=0', '先关闭异常并重新核验。']);
      const root = path.resolve(dataRoot);
      const outputPath = path.resolve(root, output.evidence.artifact_ref);
      if (!outputPath.startsWith(`${root}${path.sep}`) || !await fs.stat(outputPath).catch(() => null)) {
        problems.push(['SOP07_ARTIFACT_NOT_PERSISTED', 'SOP07 artifact文件不存在或不在当前数据根。', 'outputs.top20.evidence.artifact_ref', '可读取的独立验收/正式数据根内artifact', '恢复该版本文件后重新核验。']);
      }
      try {
        const { sop05, sop06 } = await loadSop07SourceArtifacts(dataRoot, task);
        const factsVersion = task.outputs?.confirmed_product_facts?.version;
        const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version;
        const sop04Version = task.listing_executor?.registry?.LISTING_SOP_04?.output_version;
        const qa = qaListingSop07Top20({ artifact: output, sop05, sop06, expectedVersions: { facts: factsVersion, sop03: sop03Version, sop04: sop04Version } });
        for (const check of qa.checks.filter(item => !item.pass)) problems.push([check.code, check.message, 'outputs.top20', 'SOP05/SOP06正式输入可逐条复现的无评分TOP20', '检查来源版本、exact string、Boloo正式搜索量及原始evidence；不放宽QA。']);
        const evidenceRefs = (output.records || []).flatMap(item => item.sop06_evidence_refs || []).map(item => item.reference).filter(Boolean);
        const missingEvidence = [];
        for (const reference of evidenceRefs) {
          const file = path.resolve(reference);
          if (!file.startsWith(`${root}${path.sep}`) || !await fs.stat(file).catch(() => null)) missingEvidence.push(reference);
        }
        if (missingEvidence.length) problems.push(['SOP07_SOURCE_EVIDENCE_MISSING', `${missingEvidence.length}条SOP06 RAW/DOM evidence引用无法读取或超出当前数据根。`, 'outputs.top20.records.sop06_evidence_refs', '所有SOP06真实查询证据均在当前数据根可追溯', '恢复缺失证据后重新执行Stage QA。']);
      } catch (error) {
        problems.push([error.code || 'SOP07_INPUT_ARTIFACT_INVALID', `SOP07上游正式artifact无法核验：${error.message}`, 'outputs.top20.input_versions', '当前SKU正式SOP05/SOP06版本及其持久化文件', '检查上游版本引用与文件完整性。']);
      }
    }
  } else {
    const output = task.outputs?.[step];
    if (!output || !output.evidence || !Object.keys(output.evidence).length) problems.push(['ENGINE_NOT_CONNECTED', `步骤“${STEPS.find(item => item[0] === step)?.[1] || step}”尚无可核验的执行结果。`, `outputs.${step}`, '步骤产物及来源证据完整，并通过该步骤 QA', '接入对应 BOL 引擎后重新执行；不得用占位结果放行。']);
    else if (output.open_error_count > 0) problems.push(['STAGE_OPEN_ERRORS', '步骤产物仍有未关闭异常。', `outputs.${step}.open_error_count`, 'OPEN_ERROR_COUNT=0', '先完成异常修复并重新核验。']);
    if (step === 'bol_keywords' && output?.evidence) {
      const terms = output.evidence.relatedTerms;
      if (!Array.isArray(terms) || terms.length < 5 || terms.length > 7) problems.push(['BOL_RELATED_TERMS_COUNT_INVALID', 'BOL 关联词数量必须为 5–7 个。', 'outputs.bol_keywords.evidence.relatedTerms', '5–7 个通过 Product Master 相关性核验的唯一原词', '按已确认核心词重新执行；不足 5 个时最多查询 3 个种子词，仍不足则留在异常池。']);
      else if (terms.some(item => typeof item?.searchTerm !== 'string' || !item.searchTerm.trim()) || new Set(terms.map(item => item.searchTerm)).size !== terms.length) problems.push(['BOL_RELATED_TERMS_INVALID', 'BOL 关联词为空或存在完全重复项。', 'outputs.bol_keywords.evidence.relatedTerms', '原始词串非空且完全重复项已去重', '重新执行 BOL Search Terms。']);
      if (!Array.isArray(output.evidence.rawResponses) || !output.evidence.rawResponses.length || output.evidence.rawResponses.length > 3) problems.push(['BOL_SEARCH_EVIDENCE_INCOMPLETE', 'BOL Search Terms 缺少查询原始响应或种子词超过 3 个。', 'outputs.bol_keywords.evidence.rawResponses', '1–3 个原始响应及对应核心查询词', '重新执行 BOL Search Terms 并保留响应来源。']);
    }
  }
  return problems;
}

function setPoolForStep(task, step) {
  const pool = SOP_STEP_POOL[step] || STEPS.find(item => item[0] === step)?.[2];
  task.activity_pool = pool || '待上传池';
  task.return_pool = null;
}

async function executeListingSop07Top20(dataRoot, task) {
  const step = 'LISTING_SOP_07';
  if (!isTop20ExecutorReady()) {
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'TOP20_EXECUTOR'; task.resume_point = step;
    task.error_code = null; task.error_message = null;
    task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'TOP20_EXECUTOR', dependency_status: 'NOT_READY', updated_at: iso() };
    await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step, dependency: 'TOP20_EXECUTOR', executor_registered: true, executor_ready: false });
    return task;
  }
  const preflight = evaluateListingExecutionPreflight(task, { dependencyReady: true, executorAvailable: true });
  if (!preflight.ready) {
    task.status = preflight.status;
    task.waiting_dependency_key = preflight.status === 'WAITING_DEPENDENCY' ? preflight.dependency : null;
    task.resume_point = step;
    task.error_code = null; task.error_message = null;
    task.stages[step] = { ...task.stages[step], status: preflight.status, dependency: task.waiting_dependency_key, waiting_reason: preflight.reason, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_07_PREFLIGHT_BLOCKED', { check: preflight.check, reason: preflight.reason, external_requests: 0 });
    return task;
  }

  const { sop05, sop06 } = await loadSop07SourceArtifacts(dataRoot, task);
  const factsVersion = task.outputs?.confirmed_product_facts?.version;
  const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version;
  const sop04Version = task.listing_executor?.registry?.LISTING_SOP_04?.output_version;
  const execution = buildListingSop07Top20({
    sku: task.sku, sop05, sop06, confirmedProductFactsVersion: factsVersion,
    sop03ArtifactVersion: sop03Version, sop04ArtifactVersion: sop04Version,
  });
  const artifact = execution.artifact;
  const sop05Ref = path.relative(dataRoot, path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop05', `${sop05.version}.json`)).replace(/\\/g, '/');
  const sop06Ref = path.relative(dataRoot, path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop06', `${sop06.version}.json`)).replace(/\\/g, '/');
  artifact.evidence = { ...artifact.evidence, sop05_artifact_ref: sop05Ref, sop06_artifact_ref: sop06Ref };
  const pendingFile = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop07', 'pending', `${artifact.version}-${crypto.randomUUID()}.json`);
  const pendingRef = path.relative(dataRoot, pendingFile).replace(/\\/g, '/');
  artifact.evidence.artifact_ref = pendingRef;

  task.current_step = step; task.resume_point = step; task.listing_sop.current_step_id = step;
  task.status = 'RUNNING'; task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
  task.readiness ||= {}; task.readiness.TOP20_EXECUTOR_READY = true;
  task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
  task.stage_qa_status = 'NOT_RUN';
  task.stages[step] = { ...task.stages[step], status: 'RUNNING', dependency: null, waiting_reason: null, executor_id: 'TOP20_EXECUTOR', updated_at: iso() };
  await commit(dataRoot, task, 'STEP_EXECUTION_STARTED', { step, executor_id: 'TOP20_EXECUTOR', input_versions: artifact.input_versions, external_requests: 0 });

  await atomicJson(pendingFile, artifact);
  task.outputs ||= {};
  task.outputs.top20 = { ...clone(artifact), open_error_count: activeIssueCount(task) };
  task.listing_executor.artifacts.listing_outputs.LISTING_SOP_07 = clone(artifact);
  task.listing_executor.registry.LISTING_SOP_07 = {
    ...task.listing_executor.registry.LISTING_SOP_07,
    status: 'DONE_PENDING_QA', qa_status: 'NOT_RUN', output_version: artifact.version,
    output_type: 'LISTING_TOP20_VERSION', executor_id: 'TOP20_EXECUTOR',
    required_inputs: ['CONFIRMED_PRODUCT_FACTS_VERSION', 'LISTING_SOP_03', 'LISTING_SOP_04', 'LISTING_SOP_05', 'LISTING_SOP_06'],
    required_dependencies: [],
    output_fields: ['rank', 'exact_string', 'boloo_search_volume', 'demand_status', 'keyword_category', 'sop05_provenance', 'sop06_result_version', 'sop06_evidence_version', 'facts_eligibility'],
    input_version_refs: [
      { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: factsVersion },
      { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
      { artifact_type: 'LISTING_SOP_04_RELATED_TERMS_VERSION', version: sop04Version },
      { artifact_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL', version: sop05.version },
      { artifact_type: 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES', version: sop06.version },
    ],
    evidence_refs: [pendingRef, sop05Ref, sop06Ref], completed_at: null, updated_at: iso(),
  };
  task.listing_sop.steps[step] = { ...task.listing_sop.steps[step], status: 'DONE_PENDING_QA', qa_status: 'NOT_RUN', output_version: artifact.version, input_version_refs: clone(task.listing_executor.registry[step].input_version_refs), updated_at: iso() };
  task.stages[step] = { ...task.stages[step], status: 'DONE_PENDING_QA', qa_status: 'NOT_RUN', output_version: artifact.version, updated_at: iso() };
  await commit(dataRoot, task, 'LISTING_SOP_07_OUTPUT_PERSISTED', { version: artifact.version, artifact_ref: pendingRef, item_count: artifact.records.length, input_versions: artifact.input_versions });

  const validation = qaListingSop07Top20({ artifact, sop05, sop06, expectedVersions: { facts: factsVersion, sop03: sop03Version, sop04: sop04Version } });
  const root = path.resolve(dataRoot);
  const missingEvidence = [];
  for (const record of artifact.records) for (const ref of record.sop06_evidence_refs || []) {
    const file = path.resolve(ref.reference || '');
    if (!ref.reference || !file.startsWith(`${root}${path.sep}`) || !await fs.stat(file).catch(() => null)) missingEvidence.push(ref.reference || '(empty evidence ref)');
  }
  const evidenceCheck = { code: 'SOP06_SOURCE_EVIDENCE_PERSISTED', pass: missingEvidence.length === 0,
    message: missingEvidence.length ? `${missingEvidence.length}条SOP06 RAW/DOM evidence不可读取。` : `${artifact.records.length}条入选SOP06 RAW/DOM evidence均可从当前数据根读取。` };
  const noOpenErrorsCheck = { code: 'OPEN_ERROR_COUNT_ZERO', pass: activeIssueCount(task) === 0,
    message: activeIssueCount(task) === 0 ? '当前SKU没有OPEN_ERROR。' : `当前SKU有${activeIssueCount(task)}个OPEN_ERROR。` };
  const qaChecks = [...validation.checks, evidenceCheck, noOpenErrorsCheck];
  const qaPassed = execution.passed && validation.status === 'PASS' && evidenceCheck.pass && noOpenErrorsCheck.pass;
  if (qaPassed) {
    const finalFile = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop07', `${artifact.version}.json`);
    const finalRef = path.relative(dataRoot, finalFile).replace(/\\/g, '/');
    artifact.status = 'PASS'; artifact.qa_status = 'PASS';
    artifact.qa = { status: 'PASS', checks: qaChecks, checked_at: iso() };
    artifact.evidence = { ...artifact.evidence, artifact_ref: finalRef };
    await atomicJson(finalFile, artifact);
    task.outputs.top20 = { ...clone(artifact), open_error_count: 0 };
    task.listing_executor.artifacts.listing_outputs.LISTING_SOP_07 = clone(artifact);
    task.listing_executor.registry.LISTING_SOP_07 = { ...task.listing_executor.registry.LISTING_SOP_07,
      evidence_refs: [finalRef, sop05Ref, sop06Ref], updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_07_PRE_QA_PASS', { version: artifact.version, artifact_ref: finalRef, checks: qaChecks.length, external_requests: 0 });
  }
  return verifyCurrent(dataRoot, task);
}

async function finalizeCachedSop07Top20(dataRoot, task, payload = {}) {
  assertTaskRevisionCAS(payload.expected_revision, task.revision);
  if (Object.keys(payload).some(key => key !== 'expected_revision')
    || !ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1'
    || !acceptanceMode(dataRoot) || task.current_step !== 'LISTING_SOP_07'
    || task.resume_point !== 'LISTING_SOP_07' || task.last_success_step !== 'LISTING_SOP_06'
    || task.status !== 'ERROR' || task.qa?.LISTING_SOP_07?.status !== 'FAIL'
    || !task.outputs?.top20 || task.outputs.top20.status === 'PASS'
    || task.outputs.top20.qa_status === 'PASS' || task.error_code !== 'SOP06_RESULT_COUNT_INVALID') {
    throw Object.assign(new Error('SOP07 cached QA recovery preconditions failed closed.'), { code: 'SOP07_CACHED_QA_RECOVERY_PRECONDITION' });
  }
  const recoverableCodes = new Set(['SOP07_DONE_NOT_PASS', 'SOP05_ELIGIBLE_COUNT_INVALID', 'SOP06_RESULT_COUNT_INVALID']);
  const openIssues = (task.issues || []).filter(issue => issue.status === 'OPEN');
  if (!openIssues.length || openIssues.some(issue => issue.step !== 'LISTING_SOP_07' || !recoverableCodes.has(issue.code))) {
    throw Object.assign(new Error('Open issues include defects outside the corrected SOP07 candidate-count gate.'), { code: 'SOP07_CACHED_QA_RECOVERY_ISSUES_UNSCOPED' });
  }
  const db = dbFor(dataRoot);
  if (Number(db.prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0) !== 0) {
    throw Object.assign(new Error('Active execution lease blocks cached SOP07 QA recovery.'), { code: 'SOP07_CACHED_QA_RECOVERY_ACTIVE_LEASE' });
  }

  const { sop05, sop06 } = await loadSop07SourceArtifacts(dataRoot, task);
  const factsVersion = task.outputs?.confirmed_product_facts?.version;
  const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version;
  const sop04Version = task.listing_executor?.registry?.LISTING_SOP_04?.output_version;
  const inputRefs = [
    { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: factsVersion },
    { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
    { artifact_type: 'LISTING_SOP_04_RELATED_TERMS_VERSION', version: sop04Version },
    { artifact_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL', version: sop05.version },
    { artifact_type: 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES', version: sop06.version },
  ];
  const inputVersion = makeListingExecutionInputVersion(inputRefs, []);
  const acquired = acquireListingExecutionLease(db, { skuId: task.sku, step: 'LISTING_SOP_07', inputVersion });
  if (!acquired.acquired) return { status: 'NOOP_ALREADY_RUNNING', task_revision: task.revision, external_requests: 0 };
  const { lease } = acquired;
  activateListingExecution(lease.execution_id);
  let stagingPath = null;
  try {
    const execution = buildListingSop07Top20({
      sku: task.sku, sop05, sop06, confirmedProductFactsVersion: factsVersion,
      sop03ArtifactVersion: sop03Version, sop04ArtifactVersion: sop04Version,
    });
    if (!execution.passed) throw Object.assign(new Error('Corrected SOP07 builder did not pass its input/evidence checks.'), { code: 'SOP07_CACHED_QA_BUILDER_FAILED', checks: execution.checks.filter(check => !check.pass) });
    const artifact = execution.artifact;
    const sop05Ref = path.relative(dataRoot, path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop05', `${sop05.version}.json`)).replace(/\\/g, '/');
    const sop06Ref = path.relative(dataRoot, path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop06', `${sop06.version}.json`)).replace(/\\/g, '/');
    artifact.evidence = { ...artifact.evidence, sop05_artifact_ref: sop05Ref, sop06_artifact_ref: sop06Ref };

    const root = path.resolve(dataRoot);
    const missingEvidence = [];
    for (const record of artifact.records) for (const ref of record.sop06_evidence_refs || []) {
      const file = path.resolve(ref.reference || '');
      if (!ref.reference || !file.startsWith(`${root}${path.sep}`) || !await fs.stat(file).catch(() => null)) missingEvidence.push(ref.reference || '(empty evidence ref)');
    }
    if (missingEvidence.length) throw Object.assign(new Error(`${missingEvidence.length} persisted SOP06 evidence references are unavailable.`), { code: 'SOP07_CACHED_QA_EVIDENCE_MISSING', missing_evidence_count: missingEvidence.length });

    const working = clone(task);
    const recoverableIssueIds = new Set(openIssues.map(issue => issue.issue_id));
    for (const issue of working.issues || []) if (recoverableIssueIds.has(issue.issue_id)) {
      issue.status = 'CLOSED'; issue.closed_at = iso(); issue.updated_at = issue.closed_at;
      issue.close_reason = 'SOP07_ACTUAL_ELIGIBLE_COUNT_RULE_CORRECTED';
    }
    working.open_error_count = activeIssueCount(working);
    if (working.open_error_count !== 0) throw Object.assign(new Error('Unrelated open issues remain; cached SOP07 recovery cannot close them.'), { code: 'SOP07_CACHED_QA_RECOVERY_UNRELATED_ERRORS' });
    working.error_code = null; working.error_message = null;

    const evidenceCheck = { code: 'SOP06_SOURCE_EVIDENCE_PERSISTED', pass: true,
      message: `${artifact.records.length}个入选候选的SOP06原始证据均可从当前数据根读取。` };
    const noOpenErrorsCheck = { code: 'OPEN_ERROR_COUNT_ZERO', pass: true, message: 'SOP07恢复范围内错误已被本次QA重验，不存在其他OPEN_ERROR。' };
    const qaChecks = [...execution.checks, evidenceCheck, noOpenErrorsCheck];
    artifact.status = 'PASS'; artifact.qa_status = 'PASS';
    artifact.qa = { status: 'PASS', checks: qaChecks, checked_at: iso() };
    const pendingDir = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop07', 'pending');
    await fs.mkdir(pendingDir, { recursive: true });
    const pendingRef = path.relative(dataRoot, path.join(pendingDir, `qa-recovery-${artifact.version}-${crypto.randomUUID()}.json`)).replace(/\\/g, '/');
    stagingPath = safeMaterialPath(dataRoot, pendingRef);
    artifact.evidence = { ...artifact.evidence, artifact_ref: pendingRef };
    await fs.writeFile(stagingPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    working.outputs ||= {};
    working.outputs.top20 = { ...clone(artifact), open_error_count: 0 };
    working.qa.LISTING_SOP_07 = { status: 'PASS', checked_at: artifact.qa.checked_at, report: qaChecks };
    working.stages.LISTING_SOP_07 = { ...working.stages.LISTING_SOP_07, status: 'PASS', qa_status: 'PASS', output_version: artifact.version, updated_at: iso() };
    working.listing_sop.steps.LISTING_SOP_07 = { ...working.listing_sop.steps.LISTING_SOP_07, status: 'PASS', qa_status: 'PASS', output_version: artifact.version, updated_at: iso() };
    applyListingExecutorStep(working, 'LISTING_SOP_07', { status: 'PASS', output: working.outputs.top20,
      input_version_refs: inputRefs, qa: { status: 'PASS', report: qaChecks }, resume_point: 'LISTING_SOP_08' });
    const stageProblems = await validateStage(working, 'LISTING_SOP_07', dataRoot);
    if (stageProblems.length) throw Object.assign(new Error('Persisted-input Stage QA rejected the corrected SOP07 artifact.'), { code: 'SOP07_CACHED_QA_STAGE_FAILED', failures: stageProblems });

    const finalFile = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop07', `${artifact.version}.json`);
    const finalRef = path.relative(dataRoot, finalFile).replace(/\\/g, '/');
    artifact.evidence = { ...artifact.evidence, artifact_ref: finalRef };
    working.outputs.top20 = { ...clone(artifact), open_error_count: 0 };
    working.listing_executor.artifacts.listing_outputs.LISTING_SOP_07 = clone(artifact);
    working.listing_executor.registry.LISTING_SOP_07 = { ...working.listing_executor.registry.LISTING_SOP_07,
      status: 'PASS', qa_status: 'PASS', execution_status: 'REAL_EXECUTOR_PASS', output_version: artifact.version,
      evidence_refs: [finalRef, sop05Ref, sop06Ref], completed_at: iso(), updated_at: iso() };
    const finalBytes = `${JSON.stringify(artifact, null, 2)}\n`;
    await fs.mkdir(path.dirname(finalFile), { recursive: true });
    try { await fs.writeFile(finalFile, finalBytes, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if (error?.code !== 'EEXIST' || await fs.readFile(finalFile, 'utf8') !== finalBytes) throw Object.assign(error, { code: 'SOP07_IMMUTABLE_ARTIFACT_CONFLICT' });
    }
    const finalQaProblems = await validateStage(working, 'LISTING_SOP_07', dataRoot);
    if (finalQaProblems.length) throw Object.assign(new Error('Final-path persisted SOP07 Stage QA failed.'), { code: 'SOP07_CACHED_QA_FINAL_PATH_FAILED', failures: finalQaProblems });
    await fs.rm(stagingPath, { force: true }); stagingPath = null;

    const historyRef = `artifacts/listing/${task.sku}/sop07/recovery-history/${artifact.version}-${crypto.randomUUID()}.json`;
    const historyPath = safeMaterialPath(dataRoot, historyRef);
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    await fs.writeFile(historyPath, `${JSON.stringify({ prior_revision: task.revision, prior_status: task.status,
      prior_qa: task.qa?.LISTING_SOP_07, prior_output: task.outputs?.top20, resolved_issue_ids: [...recoverableIssueIds],
      corrected_version: artifact.version, recovered_at: iso(), external_requests: 0 }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    working.outputs.top20 = { ...clone(artifact), open_error_count: 0 };
    working.listing_executor.artifacts.listing_outputs.LISTING_SOP_07 = clone(artifact);
    working.current_step = 'LISTING_SOP_08'; working.resume_point = 'LISTING_SOP_08';
    working.last_success_step = 'LISTING_SOP_07'; working.listing_sop.current_step_id = 'LISTING_SOP_08';
    working.status = 'PAUSED'; working.waiting_dependency_key = null; working.stage_qa_status = 'NOT_RUN';
    working.error_code = null; working.error_message = null; working.return_pool = null;
    working.stages.LISTING_SOP_08 = { ...working.stages.LISTING_SOP_08, status: 'PAUSED', updated_at: iso() };
    working.qa.LISTING_SOP_08 = working.qa.LISTING_SOP_08 || { status: 'NOT_RUN', checked_at: null, report: null };
    working.listing_sop.steps.LISTING_SOP_08 = { ...working.listing_sop.steps.LISTING_SOP_08, status: 'PAUSED', qa_status: 'NOT_RUN', updated_at: iso() };
    working.activity_pool = 'Listing 生成池'; working.current_pool = working.activity_pool;
    working.sidecars.keywords = { ...working.sidecars.keywords, status: 'PASS', updated_at: iso() };
    working.sidecars.listing = { ...working.sidecars.listing, status: 'PAUSED', updated_at: iso() };
    await commit(dataRoot, working, 'LISTING_SOP_07_CACHED_QA_RECOVERED', {
      version: artifact.version, prior_version: task.outputs.top20.version, history_ref: historyRef,
      resolved_issue_ids: [...recoverableIssueIds], selected_count: artifact.item_count,
      eligible_candidate_count: artifact.evaluated_candidate_count, shortfall: artifact.selection,
      qa_status: 'PASS', external_requests: 0, next_step: 'LISTING_SOP_08', next_step_dispatched: false,
    }, { expectedRevision: payload.expected_revision });
    finishListingExecutionLease(db, lease.lease_id, 'PASS');
    return { status: 'PASS', qa_status: 'PASS', version: artifact.version, selected_count: artifact.item_count,
      shortfall: artifact.selection, external_requests: 0, task_revision: working.revision,
      task_status: working.status, current_step: working.current_step, resume_point: working.resume_point };
  } catch (error) {
    finishListingExecutionLease(db, lease.lease_id, 'FAILED');
    throw error;
  } finally {
    if (stagingPath) await fs.rm(stagingPath, { force: true }).catch(() => {});
    deactivateListingExecution(lease.execution_id);
  }
}

function markDependentListingOutputsStale(task, newFactVersion, reason = 'PRODUCT_MASTER_FACT_VERSION_CHANGED') {
  if (task.final_archive) return [];
  syncListingExecutorFramework(task, LISTING_SOP_STEPS);
  const affected = [];
  const stageByOutput = { own_materials_snapshot: 'LISTING_SOP_01', confirmed_product_facts: 'LISTING_SOP_02', confirmed_product_facts_draft: 'LISTING_SOP_02' };
  const mark = (key, output) => {
    if (!output || typeof output !== 'object' || !output.evidence) return;
    const inputVersion = Number(output.evidence.product_master_version ?? output.evidence.fact_version ?? output.evidence.product_fact_version ?? output.evidence.source_fact_version ?? 0);
    if (!inputVersion || inputVersion === Number(newFactVersion)) return;
    output.stale = true; output.stale_reason = reason; output.stale_since_fact_version = Number(newFactVersion); output.stale_at = iso();
    const stageKey = stageByOutput[key] || key;
    const stage = task.stages?.[stageKey];
    if (stage && task.qa?.[stageKey]?.status === 'PASS') {
      task.qa[stageKey] = { ...task.qa[stageKey], previous_status: 'PASS', status: 'NOT_RUN', stale: true, stale_since_fact_version: Number(newFactVersion) };
      task.stages[stageKey] = { ...stage, status: 'STALE', stale_since_fact_version: Number(newFactVersion), updated_at: iso() };
      if (task.listing_sop?.steps?.[stageKey]) task.listing_sop.steps[stageKey] = { ...task.listing_sop.steps[stageKey], previous_qa_status: 'PASS', qa_status: 'NOT_RUN', stale: true, stale_since_fact_version: Number(newFactVersion), updated_at: iso() };
    }
    affected.push(key);
  };
  for (const [key, output] of Object.entries(task.outputs || {})) mark(key, output);
  for (const output of task.listing_sop?.own_materials_snapshots || []) mark('own_materials_snapshot', output);
  for (const output of task.listing_sop?.confirmed_product_facts_versions || []) mark('confirmed_product_facts', output);
  const staleSteps = propagateListingStale(task, 'CONFIRMED_PRODUCT_FACTS_VERSION', reason, iso(), { recordHistory: false });
  affected.push(...staleSteps);
  if (affected.length) {
    // SOP03 has no executor in this implementation pass. When SOP01/02 inputs
    // become stale, withdraw its old dependency-wait marker until SOP02 passes again.
    if (affected.some(key => key === 'own_materials_snapshot' || key === 'confirmed_product_facts')) {
      task.qa.LISTING_SOP_03 = { status: 'NOT_RUN', checked_at: null, report: null };
      if (task.stages?.LISTING_SOP_03) task.stages.LISTING_SOP_03 = { ...task.stages.LISTING_SOP_03, status: 'NOT_STARTED', dependency: null, updated_at: iso() };
      if (task.listing_sop?.steps?.LISTING_SOP_03) task.listing_sop.steps.LISTING_SOP_03 = { ...task.listing_sop.steps.LISTING_SOP_03, status: 'NOT_STARTED', qa_status: 'NOT_RUN', updated_at: iso() };
      if (task.waiting_dependency_key === 'LISTING_SOP_03_EXECUTOR') task.waiting_dependency_key = null;
    }
    task.listing_sop ||= { version: '2026-09-22-V1.1', steps: {}, own_materials_snapshots: [], confirmed_product_facts_versions: [], decisions: [], stale_dependencies: [] };
    task.listing_sop.stale_dependencies ||= [];
    task.listing_sop.stale_dependencies.push({ fact_version: Number(newFactVersion), outputs: [...new Set(affected)], reason, at: iso() });
  }
  return [...new Set(affected)];
}

async function persistOwnedMaterial(dataRoot, task, input = {}) {
  const sourceType = String(input.source_type || 'OWN_PRODUCT').trim().toUpperCase();
  if (!OWN_SOURCE_TYPES.has(sourceType) || sourceType === 'PRODUCT_MASTER') throw Object.assign(new Error('资料来源必须是 Product Master、1688 或自家产品资料。'), { code: 'OWN_MATERIAL_SOURCE_TYPE_INVALID' });
  const filename = path.basename(String(input.filename || 'own-material.json')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'own-material.json';
  const extension = path.extname(filename).toLowerCase();
  if (!['.json', '.txt', '.md', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(extension)) throw Object.assign(new Error('当前资料绑定仅接受 JSON、TXT、MD、CSV、图片或 PDF。'), { code: 'OWN_MATERIAL_TYPE_UNSUPPORTED' });
  let bytes;
  if (typeof input.content_base64 === 'string') bytes = Buffer.from(input.content_base64, 'base64');
  else if (typeof input.content_text === 'string') bytes = Buffer.from(input.content_text, 'utf8');
  else if (input.content && typeof input.content === 'object') bytes = Buffer.from(JSON.stringify(input.content, null, 2), 'utf8');
  else throw Object.assign(new Error('缺少资料文件内容。'), { code: 'OWN_MATERIAL_CONTENT_MISSING' });
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw Object.assign(new Error('资料文件必须为 1 byte 至 10 MiB。'), { code: 'OWN_MATERIAL_SIZE_INVALID' });
  const materialId = crypto.randomUUID();
  const version = Math.max(0, ...(task.master.materials || []).filter(item => item.original_name === filename).map(item => Number(item.version) || 0)) + 1;
  const relative = path.join('materials', task.id, `${materialId}_v${version}${extension}`);
  const target = safeMaterialPath(dataRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const item = { material_id: materialId, version, original_name: filename, source_type: sourceType, source_label: cleanText(input.source_label) || sourceType, source_reference: cleanText(input.source_reference) || null, storage_relpath: relative, content_type: cleanText(input.content_type) || (extension === '.json' ? 'application/json' : 'application/octet-stream'), byte_length: bytes.length, sha256, added_at: iso(), active: true };
  task.master.materials ||= []; task.master.materials.push(item);
  task.master.source_refs ||= [];
  task.master.source_refs.push(`material://${encodeURIComponent(task.sku)}/${materialId}/v${version}`);
  const oldFactVersion = Number(task.master.fact_version || 1);
  task.master.fact_version = oldFactVersion + 1;
  const stale = markDependentListingOutputsStale(task, task.master.fact_version, 'OWN_MATERIAL_ADDED');
  if (task.confirmation?.status === 'OPEN') {
    task.listing_sop ||= { steps: {} };
    task.listing_sop.decisions ||= [];
    task.listing_sop.decisions.push({ type: 'PROPOSAL_SUPERSEDED_BY_NEW_SOURCE', proposal_id: task.confirmation.proposal_id, at: iso() });
    task.confirmation.status = 'SUPERSEDED'; task.confirmation.closed_at = iso();
  }
  task.current_step = 'LISTING_SOP_01'; task.resume_point = 'LISTING_SOP_01'; task.listing_sop.current_step_id = 'LISTING_SOP_01';
  task.status = 'QUEUED'; task.activity_pool = '资料处理池'; task.return_pool = null;
  task.stages.LISTING_SOP_01 = { ...task.stages.LISTING_SOP_01, status: 'QUEUED', updated_at: iso() };
  task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'NOT_STARTED', updated_at: iso() };
  task.qa.LISTING_SOP_01 = { status: 'NOT_RUN', checked_at: null, report: null };
  task.qa.LISTING_SOP_02 = { status: 'NOT_RUN', checked_at: null, report: null };
  await commit(dataRoot, task, 'OWN_MATERIAL_ATTACHED', { material_id: materialId, source_type: sourceType, source_version: version, new_product_master_version: task.master.fact_version, stale_outputs: stale });
  return { material: item, task };
}

async function verifyCurrent(dataRoot, task) {
  const step = task.current_step;
  if (step === 'LISTING_SOP_04' && ['WAITING_DECISION', 'WAITING_CONFIRMATION', 'WAITING_DEPENDENCY'].includes(task.status)
    && (!task.outputs?.bol_keywords || (task.listing_executor?.waiting_items || []).some(item => !item.decided_at && item.originating_sop_step === step))) {
    return { passed: false, waiting: true, task };
  }
  const issues = task.issues.filter(issue => issue.step === step && issue.status !== 'CLOSED');
  for (const issue of issues) if (issue.status === 'FIXED_PENDING_QA') issue.status = 'CLOSED';
  const problems = await validateStage(task, step, dataRoot);
  let sop05Finalize = null;
  if (step === 'LISTING_SOP_05' && problems.length === 0) {
    try {
      const output = task.outputs?.keyword_candidate_pool;
      const inputs = await loadSop05Inputs(dataRoot, task);
      const target = safeMaterialPath(dataRoot, output.evidence.artifact_ref);
      const persisted = JSON.parse(await fs.readFile(target, 'utf8'));
      const qa = qaListingSop05Contract({ artifact: persisted, facts: inputs.facts, sop03: inputs.sop03, sop04: inputs.sop04,
        expectedVersions: { facts: inputs.facts.version, sop03: inputs.sop03Ref.version, sop04: inputs.sop04Ref.version }, evidenceResolver: inputs.evidenceResolver });
      if (qa.status !== 'PASS') {
        for (const failed of qa.failures) problems.push([failed.code, failed.message, 'outputs.keyword_candidate_pool', '完整SOP05 Stage QA PASS', '按失败的精确检查修复候选或证据；不得放宽strict resolver。']);
      } else {
        const checkedAt = iso();
        const finalArtifact = { ...persisted, status: 'PASS', qa_status: 'PASS', qa: { status: 'PASS', checked_at: checkedAt, checks: qa.checks, external_requests: 0 } };
        await atomicJson(target, finalArtifact);
        sop05Finalize = { output: { ...clone(finalArtifact), open_error_count: activeIssueCount(task) }, report: qa.checks };
      }
    } catch (error) {
      problems.push([error.code || 'SOP05_FINALIZE_FAILED', `SOP05 QA产物未能正式封板：${error.message}`, 'outputs.keyword_candidate_pool.evidence.artifact_ref', '持久化SOP05 artifact与Stage QA PASS', '保留现有候选和原始证据，修复持久化或严格来源校验问题。']);
    }
  }
  if (problems.length) {
    task.qa[step] = { status: 'FAIL', checked_at: iso(), report: problems.map(item => item[1]) };
    task.stages[step] = { ...task.stages[step], status: 'QA_FAIL', updated_at: iso() };
    for (const [code, reason, field, standard, suggestion] of problems) issueFor(task, code, reason, field, standard, suggestion);
    task.return_pool = task.return_pool || STEPS.find(item => item[0] === step)?.[2] || '待处理池';
    task.activity_pool = '异常池';
    task.status = 'ERROR';
    task.sidecars.verification = { status: 'FAIL', updated_at: iso() };
    task.open_error_count = activeIssueCount(task);
    await commit(dataRoot, task, 'STAGE_QA_FAIL', { step, codes: problems.map(item => item[0]) });
    return { passed: false, task };
  }
  if (sop05Finalize) {
    task.outputs.keyword_candidate_pool = sop05Finalize.output;
    task.listing_executor ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso());
    task.listing_executor.artifacts ||= { listing_outputs: {} };
    task.listing_executor.artifacts.listing_outputs ||= {};
    task.listing_executor.artifacts.listing_outputs[step] = clone(sop05Finalize.output);
    task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], executor_id: LISTING_SOP05_EXECUTOR_ID,
      output_version: sop05Finalize.output.version, status: 'PASS', qa_status: 'PASS', completed_at: iso(), waiting_reason: null };
  }
  task.qa[step] = { status: 'PASS', checked_at: iso(), report: sop05Finalize?.report || [] };
  task.stages[step] = { ...task.stages[step], status: 'QA_PASS', updated_at: iso() };
  if (step === 'LISTING_SOP_09' && task.outputs?.competitor_analysis) {
    task.outputs.competitor_analysis.status = 'PASS';
    task.outputs.competitor_analysis.qa_status = 'PASS';
  }
  if (task.listing_sop?.steps?.[step]) {
    task.listing_sop.steps[step] = { ...task.listing_sop.steps[step], status: 'PASS', qa_status: 'PASS', checked_at: task.qa[step].checked_at, updated_at: iso() };
  }
  task.last_success_step = step;
  task.open_error_count = activeIssueCount(task);
  if (task.open_error_count) {
    task.activity_pool = '异常池'; task.status = 'ERROR';
    task.sidecars.verification = { status: 'BLOCKED_OPEN_ERRORS', updated_at: iso() };
    await commit(dataRoot, task, 'QA_BLOCKED_OPEN_ERRORS', { step, open_error_count: task.open_error_count });
    return { passed: false, task };
  }
  const acceptanceStop = applyAcceptanceStopAfterStep(task, {
    enabled: acceptanceMode(dataRoot),
    configuredStep: process.env.BOL_ACCEPTANCE_STOP_AFTER_STEP || '',
    acceptedAt: iso(),
  });
  if (acceptanceStop) {
    await commit(dataRoot, task, acceptanceStop.event_name, {
      step: acceptanceStop.stopped_after_step,
      resume_point: acceptanceStop.resume_point,
      last_success_step: task.last_success_step,
      qa_status: task.qa[step]?.status,
      artifact_version: step === 'LISTING_SOP_09' ? (task.outputs?.competitor_analysis?.version || null) : (task.outputs?.listing_competitor_pool?.version || null),
      open_error_count: task.open_error_count,
      sop09_created_or_dispatched: step === 'LISTING_SOP_09',
      next_sop_started: false,
    });
    return { passed: true, acceptance_stopped: true, task, resume_point: acceptanceStop.resume_point };
  }
  if (step === 'top20') {
    const selected = task.outputs?.top20?.evidence?.selected_terms || [];
    const selectedQueries = new Set(selected.map(item => item.query_text));
    for (const candidate of task.boloo?.candidates || []) if (selectedQueries.has(candidate.query_text)) candidate.candidate_status = 'SELECTED_TOP20';
  }
  if (step === 'product_master') {
    const weightG = task.master.weight_kg == null ? null : task.master.weight_kg * 1000;
    const fractionalWeight = weightG != null && !Number.isInteger(weightG);
    task.sidecars.mabang = {
      job_id: `${task.sku}:mabang:v${task.master.fact_version}`,
      input_fact_version: task.master.fact_version,
      status: 'WAITING_DECISION',
      current_step: fractionalWeight ? 'WAIT_WEIGHT_DECISION' : 'WAIT_SCHEMA_CONFIRMATION',
      dependency: 'MABANG_SCHEMA',
      dependency_status: 'WAITING_DECISION',
      blocking_reason: fractionalWeight ? 'MABANG_FRACTIONAL_GRAM_ACCEPTANCE' : 'MABANG_SCHEMA_CONFIRMATION',
      export_allowed: false,
      weight_kg: task.master.weight_kg,
      weight_g: weightG,
      weight_conversion_status: weightG == null ? 'NOT_PROVIDED' : fractionalWeight ? 'WAITING_DECISION' : 'PASS',
      decision_required: fractionalWeight ? 'MABANG_FRACTIONAL_GRAM_ACCEPTANCE' : null,
      updated_at: iso()
    };
    task.sidecars.listing.status = 'READY_FOR_KEYWORDS';
  }
  task.sidecars.verification = { status: 'PASS', updated_at: iso() };
  if (step === 'LISTING_SOP_01') {
    task.last_success_step = step;
    task.current_step = 'LISTING_SOP_02';
    task.resume_point = task.current_step;
    task.listing_sop.current_step_id = task.current_step;
    task.status = 'QUEUED'; setPoolForStep(task, task.current_step);
    task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'QUEUED', updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_01_QA_PASS', { step_id: 'LISTING_SOP_01', snapshot_version: task.outputs?.own_materials_snapshot?.snapshot_version, next_step_id: task.current_step });
    await dispatchCurrent(dataRoot, task);
    return { passed: true, task };
  }
  if (step === 'LISTING_SOP_02') {
    task.last_success_step = step;
    task.current_step = 'LISTING_SOP_03';
    task.resume_point = task.current_step;
    task.listing_sop.current_step_id = task.current_step;
    task.waiting_dependency_key = 'LISTING_SOP_03_EXECUTOR';
    task.status = 'WAITING_DEPENDENCY'; setPoolForStep(task, task.current_step);
    task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'WAITING_DEPENDENCY', dependency: task.waiting_dependency_key, updated_at: iso() };
    task.qa.LISTING_SOP_03 = { status: 'NOT_RUN', checked_at: null, report: null };
    task.listing_sop.steps.LISTING_SOP_03 = { ...task.listing_sop.steps.LISTING_SOP_03, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', dependency: task.waiting_dependency_key, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_02_QA_PASS', { step_id: 'LISTING_SOP_02', confirmed_facts_version: task.outputs?.confirmed_product_facts?.version, next_step_id: task.current_step, dependency: task.waiting_dependency_key });
    return { passed: true, task };
  }
  if (step === 'LISTING_SOP_07') {
    const nextStep = 'LISTING_SOP_08';
    task.last_success_step = 'LISTING_SOP_07';
    task.current_step = nextStep; task.resume_point = nextStep; task.listing_sop.current_step_id = nextStep;
    task.waiting_dependency_key = null;
    task.status = 'QUEUED';
    task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
    task.stages[nextStep] = { ...task.stages[nextStep], status: 'QUEUED', dependency: 'BOL_API', dependency_status: 'CHECK_REQUIRED', waiting_reason: null, updated_at: iso() };
    task.qa[nextStep] = { status: 'NOT_RUN', checked_at: null, report: null };
    task.listing_sop.steps[nextStep] = { ...task.listing_sop.steps[nextStep], status: 'QUEUED', qa_status: 'NOT_RUN', dependency: null, waiting_reason: null, updated_at: iso() };
    task.sidecars.keywords = { ...task.sidecars.keywords, status: 'PASS', updated_at: iso() };
    task.sidecars.listing = { ...task.sidecars.listing, status: 'QUEUED', dependency: null, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_07_STAGE_QA_PASS', { step, top20_version: task.outputs?.top20?.version, next_step: nextStep, executor_id: 'LISTING_COMPETITOR_EXECUTOR' });
    return dispatchCurrent(dataRoot, task);
  }
  if (step === 'LISTING_SOP_08') {
    const nextStep = 'LISTING_SOP_09';
    task.last_success_step = step;
    task.current_step = nextStep; task.resume_point = nextStep; task.listing_sop.current_step_id = nextStep;
    task.waiting_dependency_key = 'LISTING_COMPETITOR_ANALYSIS_EXECUTOR';
    task.status = 'WAITING_DEPENDENCY'; task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
    task.stages[nextStep] = { ...task.stages[nextStep], status: 'WAITING_DEPENDENCY', dependency: task.waiting_dependency_key, dependency_status: 'NOT_READY', waiting_reason: 'SOP09深度竞品分析执行器尚未接入。', updated_at: iso() };
    task.qa[nextStep] = { status: 'NOT_RUN', checked_at: null, report: null };
    task.listing_sop.steps[nextStep] = { ...task.listing_sop.steps[nextStep], status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', dependency: task.waiting_dependency_key, waiting_reason: 'SOP09深度竞品分析执行器尚未接入。', updated_at: iso() };
    task.sidecars.listing = { ...task.sidecars.listing, status: 'WAITING_DEPENDENCY', dependency: task.waiting_dependency_key, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_08_ADVANCED_TO_SOP09', { sop08_version: task.outputs?.listing_competitor_pool?.version, next_step: nextStep, waiting_dependency_key: task.waiting_dependency_key });
    return { passed: true, task, next_step: nextStep, waiting_dependency_key: task.waiting_dependency_key };
  }
  const nextStep = nextWorkflowStep(step);
  if (nextStep !== 'await_upload') {
    task.current_step = nextStep;
    task.resume_point = task.current_step;
    task.status = 'QUEUED';
    setPoolForStep(task, task.current_step);
    task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'QUEUED', updated_at: iso() };
    task.sidecars[step.startsWith('bol') || ['top20'].includes(step) ? 'keywords' : 'listing'].status = 'QUEUED';
  } else {
    task.current_step = 'await_upload';
    task.resume_point = 'await_upload';
    task.activity_pool = '待上传池';
    task.status = 'READY_FOR_UPLOAD';
    task.sidecars.upload = { status: 'READY', updated_at: iso() };
  }
  await commit(dataRoot, task, 'STAGE_QA_PASS', { step, next_step: task.current_step });
  if (task.current_step !== 'await_upload') await dispatchCurrent(dataRoot, task);
  return { passed: true, task };
}

function providerChildQaProblems(task, dataRoot, subtask) {
  const problems = [];
  const child = task.provider_child_task;
  const result = subtask?.result;
  const allowed = ['PASS', 'PASS_NO_RESULT', 'PENDING_RECHECK', 'ERROR'];
  if (!child || child.parent_sop_step !== 'LISTING_SOP_03' || child.provider_stage !== 'boloo_keywords'
    || child.provider !== 'BOLOO_OFFICIAL_WEB' || child.task_type !== 'KEYWORD_EXTRACTOR') {
    problems.push('Provider child 父级/阶段/类型关联不完整。');
  }
  if (!subtask || task.boloo?.required_subtasks?.length !== 1 || subtask.provider_source !== 'keyword_extractor'
    || subtask.input_type !== 'competitor_url' || subtask.query_text !== (child?.query_url || child?.source_url)) {
    problems.push('Provider child 必须且只能包含与已绑定来源 URL 完全一致的 Extractor 子任务。');
  }
  if (!allowed.includes(subtask?.status) || !result || result.status !== subtask.status) {
    problems.push('Provider Result 状态与 child subtask 状态不合法或不一致。');
  }
  if (!result?.request_id || result.subtask_id !== subtask?.subtask_id || result.source_id !== subtask?.source_id
    || result.query_text !== subtask?.query_text || !(subtask?.request_ids || []).includes(result.request_id)
    || !(subtask?.history || []).some(item => item.request_id === result.request_id && item.status === result.status)) {
    problems.push('request_id、subtask_id、source_id、查询 URL 或 Provider 历史之间无法对应。');
  }
  const evidence = result?.evidence;
  const evidenceRef = evidence?.dom_evidence_ref?.reference;
  if (!evidenceRef || evidence.matched_query !== subtask?.query_text || !evidence.page_url || !evidence.displayed_value) {
    problems.push('Provider Result 缺少与当前 URL 对应的页面证据。');
  } else {
    const resolvedDataRoot = path.resolve(dataRoot).toLowerCase();
    const resolvedEvidence = path.resolve(evidenceRef).toLowerCase();
    if (!(resolvedEvidence === resolvedDataRoot || resolvedEvidence.startsWith(`${resolvedDataRoot}${path.sep.toLowerCase()}`))) {
      problems.push('RAW/DOM evidence 不在当前独立数据根中。');
    }
  }
  if (subtask?.status === 'PASS' && (result.reason_code !== 'KEYWORDS_FOUND'
    || !Array.isArray(result.result?.keywords) || !result.result.keywords.length)) {
    problems.push('Extractor PASS 必须有 KEYWORDS_FOUND 和非空关键词结果。');
  }
  if (subtask?.status === 'PASS_NO_RESULT' && (result.reason_code !== 'EXTRACTOR_NO_KEYWORDS'
    || evidence?.no_result_confirmed !== true)) {
    problems.push('Extractor PASS_NO_RESULT 必须有明确无结果证据。');
  }
  return problems;
}

async function verifyBolooProviderChild(dataRoot, task) {
  const subtask = task.boloo?.required_subtasks?.[0];
  const problems = providerChildQaProblems(task, dataRoot, subtask);
  const result = subtask?.result;
  const evidenceRef = result?.evidence?.dom_evidence_ref?.reference;
  if (evidenceRef && result?.request_id && subtask?.query_text) {
    try {
      const rawEvidence = JSON.parse(await fs.readFile(evidenceRef, 'utf8'));
      if (rawEvidence.operation !== 'keyword_extractor' || rawEvidence.query_text !== subtask.query_text
        || rawEvidence.request_id !== result.request_id || rawEvidence.raw_response?.matched_query !== subtask.query_text) {
        problems.push('RAW evidence 的 operation、query 或 request_id 与当前 Provider Result 不匹配。');
      }
    } catch {
      problems.push('Provider Result 指向的 RAW evidence 文件不存在或无法解析。');
    }
  }
  let resultVersion = null;
  if (task.provider_child_task?.parent_sku && subtask && result) {
    const parent = await readTask(dataRoot, task.provider_child_task.parent_sku);
    const parentRows = parent?.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
    const link = parentRows.find(item => item.provider_child_task_id === task.sku && item.source_url === task.provider_child_task.source_url);
    const digest = crypto.createHash('sha256').update(JSON.stringify({ source_url: task.provider_child_task.source_url, history: subtask.history || [], result }), 'utf8').digest('hex');
    resultVersion = `SOP03-BOLOO-${digest.slice(0, 20)}`;
    if (!link || link.result_version !== resultVersion || link.provider_request_id !== result.request_id
      || link.status !== subtask.status || link.provider_child_task_id !== task.sku
      || !link.evidence_refs?.some(ref => ref.persisted === true && ref.matches_request === true && ref.reference === evidenceRef)) {
      problems.push('父级 source link 的 result_version、request、状态或 evidence ref 与 child 当前结果不一致。');
    }
  } else {
    problems.push('Provider Result 版本无法从已保存结果与历史计算。');
  }
  if (subtask && ['PENDING_RECHECK', 'ERROR'].includes(subtask.status)) {
    return { passed: false, provider_recheck_required: subtask.status === 'PENDING_RECHECK', task, report: problems };
  }
  if (problems.length) {
    task.qa.boloo_keywords = { status: 'FAIL', checked_at: iso(), report: problems };
    task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'QA_FAIL', updated_at: iso() };
    issueFor(task, 'BOLOO_CHILD_RESULT_INVALID', problems.join(' '), 'boloo.required_subtasks.0', '单个 Extractor Provider Result、请求关联和 RAW/DOM evidence 均有效', '修复该 child 的 Provider Result/evidence 关联后重新核验；不要执行父级 discovery close gate。');
    task.open_error_count = activeIssueCount(task);
    task.status = 'ERROR'; task.activity_pool = '异常池';
    await commit(dataRoot, task, 'SOP03_PROVIDER_CHILD_QA_FAIL', { parent_sku: task.provider_child_task?.parent_sku, source_id: task.provider_child_task?.source_id, codes: ['BOLOO_CHILD_RESULT_INVALID'] });
    return { passed: false, task, report: problems };
  }

  const closedIssues = [];
  for (const issue of task.issues || []) {
    if (issue.status === 'OPEN' && issue.code === 'BOLOO_DISCOVERY_OPEN' && issue.step === 'boloo_keywords'
      && issue.location === 'boloo.keyword_discovery_closed') {
      issue.status = 'CLOSED'; issue.closed_at = iso(); issue.updated_at = issue.closed_at;
      issue.close_reason = 'WRONG_QA_SCOPE_PROVIDER_CHILD';
      issue.closure_evidence = { parent_sop_step: task.provider_child_task.parent_sop_step, source_id: task.provider_child_task.source_id, provider_result_request_id: subtask.result.request_id };
      closedIssues.push(issue.issue_id);
    }
  }
  task.qa.boloo_keywords = { status: 'PASS', checked_at: iso(), report: [], scope: 'PROVIDER_CHILD_RESULT_ONLY', parent_sop_step: task.provider_child_task.parent_sop_step, source_id: task.provider_child_task.source_id, subtask_id: subtask.subtask_id, result_status: subtask.status, request_id: subtask.result.request_id, result_version: resultVersion, evidence_ref: subtask.result.evidence.dom_evidence_ref.reference };
  task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'QA_PASS', updated_at: iso() };
  task.stage_qa_status = 'PASS'; task.status = 'PASS'; task.activity_pool = '关键词池'; task.current_pool = '关键词池';
  task.return_pool = null; task.open_error_count = activeIssueCount(task); task.error_code = null; task.error_message = null;
  task.last_success_step = 'boloo_keywords'; task.resume_point = 'boloo_keywords';
  if (task.open_error_count > 0) {
    task.status = 'ERROR'; task.activity_pool = '异常池'; task.current_pool = '异常池';
    await commit(dataRoot, task, 'SOP03_PROVIDER_CHILD_QA_BLOCKED_OPEN_ERRORS', { parent_sku: task.provider_child_task.parent_sku, source_id: task.provider_child_task.source_id, open_error_count: task.open_error_count });
    return { passed: false, task, report: ['仍存在其他未关闭异常。'] };
  }
  await commit(dataRoot, task, closedIssues.length ? 'SOP03_PROVIDER_CHILD_QA_PASS_WRONG_SCOPE_ISSUE_CLOSED' : 'SOP03_PROVIDER_CHILD_QA_PASS', {
    parent_sku: task.provider_child_task.parent_sku, parent_sop_step: task.provider_child_task.parent_sop_step,
    source_id: task.provider_child_task.source_id, subtask_id: subtask.subtask_id, status: subtask.status,
    request_id: subtask.result.request_id, result_version: task.qa.boloo_keywords.result_version,
    evidence_ref: task.qa.boloo_keywords.evidence_ref, closed_issue_ids: closedIssues,
    qa_scope: 'ONE_PROVIDER_CHILD_ONLY', discovery_gate_executed: false,
  });
  return { passed: true, provider_child_qa: 'PASS', qa_scope: 'ONE_PROVIDER_CHILD_ONLY', closed_issue_ids: closedIssues, task };
}

async function executeListingSop01(dataRoot, task) {
  task.listing_sop ||= { version: '2026-09-22-V1.1', current_step_id: 'LISTING_SOP_01', steps: {}, own_materials_snapshots: [], confirmed_product_facts_versions: [] };
  task.listing_sop.current_step_id = 'LISTING_SOP_01';
  task.qa.LISTING_SOP_01 = { status: 'NOT_RUN', checked_at: null, report: null };
  task.status = 'RUNNING'; task.resume_point = 'LISTING_SOP_01'; task.activity_pool = '资料处理池';
  task.stages.LISTING_SOP_01 = { ...task.stages.LISTING_SOP_01, status: 'RUNNING', updated_at: iso() };
  task.listing_sop.steps.LISTING_SOP_01 = { ...task.listing_sop.steps.LISTING_SOP_01, status: 'RUNNING', qa_status: 'NOT_RUN', updated_at: iso() };
  await commit(dataRoot, task, 'LISTING_SOP_01_EXECUTION_STARTED', { step_id: 'LISTING_SOP_01', input_product_master_version: task.master.fact_version });
  const snapshot = await buildOwnMaterialsSnapshot(dataRoot, task);
  task.outputs ||= {};
  task.outputs.own_materials_snapshot = snapshot;
  task.listing_sop.own_materials_snapshots ||= [];
  task.listing_sop.own_materials_snapshots.push(clone(snapshot));
  task.stages.LISTING_SOP_01 = { ...task.stages.LISTING_SOP_01, status: 'DONE_PENDING_QA', updated_at: iso() };
  task.listing_sop.steps.LISTING_SOP_01 = { ...task.listing_sop.steps.LISTING_SOP_01, status: 'DONE_PENDING_QA', output_version: snapshot.snapshot_version, updated_at: iso() };
  await commit(dataRoot, task, 'OWN_MATERIALS_SNAPSHOT_CREATED', { step_id: 'LISTING_SOP_01', snapshot_version: snapshot.snapshot_version, product_master_version: snapshot.product_master_version, material_count: snapshot.materials.filter(item => !item.excluded_reason).length });
  await verifyCurrent(dataRoot, task);
  return task;
}

async function executeListingSop02(dataRoot, task) {
  task.listing_sop.current_step_id = 'LISTING_SOP_02';
  task.qa.LISTING_SOP_02 = { status: 'NOT_RUN', checked_at: null, report: null };
  task.status = 'RUNNING'; task.resume_point = 'LISTING_SOP_02'; task.activity_pool = '资料处理池';
  task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'RUNNING', updated_at: iso() };
  task.listing_sop.steps.LISTING_SOP_02 = { ...task.listing_sop.steps.LISTING_SOP_02, status: 'RUNNING', qa_status: 'NOT_RUN', updated_at: iso() };
  await commit(dataRoot, task, 'LISTING_SOP_02_EXECUTION_STARTED', { step_id: 'LISTING_SOP_02', snapshot_version: task.outputs?.own_materials_snapshot?.snapshot_version });
  const snapshot = task.outputs?.own_materials_snapshot;
  if (!snapshot) {
    const problem = ['SOP02_SNAPSHOT_REQUIRED', 'SOP02 必须消费已通过 QA 的 SOP01 快照。', 'outputs.own_materials_snapshot', 'OWN_MATERIALS_SNAPSHOT QA=PASS', '先完成 SOP01 并恢复其快照。'];
    task.outputs ||= {}; task.outputs.confirmed_product_facts = null;
    task.qa.LISTING_SOP_02 = { status: 'FAIL', checked_at: iso(), report: [problem[1]] };
    task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'QA_FAIL', updated_at: iso() };
    issueFor(task, ...problem); task.status = 'ERROR'; task.return_pool = task.activity_pool; task.activity_pool = '异常池'; task.open_error_count = activeIssueCount(task);
    await commit(dataRoot, task, 'LISTING_SOP_02_BLOCKED_NO_SNAPSHOT', { step_id: 'LISTING_SOP_02' });
    return task;
  }
  const factVersion = buildConfirmedProductFacts(task, snapshot);
  task.outputs ||= {};
  task.outputs.confirmed_product_facts_draft = factVersion;
  const proposals = factVersion.proposals || [];
  if (proposals.length) {
    task.confirmation = {
      status: 'OPEN', source_module: 'LISTING_SOP_02', problem_type: '事实冲突或新增事实待确认',
      proposal_id: crypto.randomUUID(), evidence: { snapshot_version: snapshot.snapshot_version, product_master_version: task.master.fact_version },
      current_value: proposals.map(item => ({ field: item.field, value: item.current_value })), suggested_value: proposals,
      proposals: clone(proposals), impact: ['只影响当前 SKU 的 SOP02事实确认与后续Listing步骤', '不会进入ERROR异常池', '不阻塞其他SKU'], opened_at: iso(), updated_at: iso(),
    };
    task.status = 'WAITING_CONFIRMATION'; task.resume_point = 'LISTING_SOP_02'; task.activity_pool = '待人工确认';
    task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'WAITING_CONFIRMATION', updated_at: iso() };
    task.listing_sop.steps.LISTING_SOP_02 = { ...task.listing_sop.steps.LISTING_SOP_02, status: 'WAITING_CONFIRMATION', qa_status: 'NOT_RUN', updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_02_WAITING_CONFIRMATION', { step_id: 'LISTING_SOP_02', proposal_id: task.confirmation.proposal_id, proposal_count: proposals.length });
    return task;
  }
  task.outputs.confirmed_product_facts = factVersion;
  delete task.outputs.confirmed_product_facts_draft;
  task.listing_sop.confirmed_product_facts_versions ||= [];
  task.listing_sop.confirmed_product_facts_versions.push(clone(factVersion));
  task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'DONE_PENDING_QA', updated_at: iso() };
  task.listing_sop.steps.LISTING_SOP_02 = { ...task.listing_sop.steps.LISTING_SOP_02, status: 'DONE_PENDING_QA', output_version: factVersion.version, updated_at: iso() };
  await commit(dataRoot, task, 'CONFIRMED_PRODUCT_FACTS_VERSION_CREATED', { step_id: 'LISTING_SOP_02', version: factVersion.version, input_snapshot_version: factVersion.source_snapshot_version });
  await verifyCurrent(dataRoot, task);
  return task;
}

function sop04Preflight(task, dependencyReady = true) {
  return evaluateListingExecutionPreflight(task, { dependencyReady, executorAvailable: true });
}

async function executeListingSop04(dataRoot, task) {
  const readiness = await bolApiReadiness(dataRoot);
  const override = readinessOverride('BOL_API_READY');
  const dependencyReady = typeof override === 'boolean' ? override : readiness.status === 'PASS';
  const preflight = sop04Preflight(task, dependencyReady);
  if (!preflight.ready) {
    const waitingAt = iso();
    task.status = preflight.status;
    task.waiting_dependency_key = preflight.status === 'WAITING_DEPENDENCY' ? preflight.dependency : null;
    task.resume_point = 'LISTING_SOP_04';
    task.current_step = 'LISTING_SOP_04';
    task.listing_sop.current_step_id = 'LISTING_SOP_04';
    task.error_code = null; task.error_message = null;
    task.activity_pool = preflight.status === 'WAITING_DECISION' || preflight.status === 'WAITING_CONFIRMATION' ? '待人工确认' : '关键词池';
    task.current_pool = task.activity_pool;
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: preflight.status, dependency: task.waiting_dependency_key, waiting_reason: preflight.reason, updated_at: waitingAt };
    task.qa.LISTING_SOP_04 = { ...task.qa.LISTING_SOP_04, status: 'NOT_RUN', checked_at: null, report: null };
    await commit(dataRoot, task, 'STEP_EXECUTION_PREFLIGHT_BLOCKED', { step: 'LISTING_SOP_04', check: preflight.check, status: preflight.status, dependency: preflight.dependency || null, reason: preflight.reason, external_requests: 0 });
    return task;
  }

  const seed = task.sop04_seed_selection.exact_string;
  const factsVersion = Number(task.outputs.confirmed_product_facts.version);
  const sop03Version = task.listing_executor.registry.LISTING_SOP_03.output_version
    || task.listing_sop.steps.LISTING_SOP_03.output_version;
  const sourceRows = task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
  const multiSeedPlan = buildSop04SupplementalSeedPlan({
    facts: task.outputs.confirmed_product_facts, sourceRows, primarySeed: seed,
  });
  const confirmedPartial = clone(task.sop04_confirmed_related_terms || []);
  const supplementalMode = confirmedPartial.length > 0;
  const attemptNumber = supplementalMode
    ? (task.sop04_supplemental_queries || []).filter(item => item.seed_exact_string === seed).length + 1
    : (task.sop04_search_terms_attempts || []).filter(item => item.seed_exact_string === seed).length + 1;
  const attempt = {
    attempt_id: crypto.randomUUID(), request_id: crypto.randomUUID(), attempt: attemptNumber,
    step: 'LISTING_SOP_04', dependency_key: 'BOL_API', provider_method: 'BOL_RETAILER_API_V10_SEARCH_TERMS',
    seed_exact_string: seed, status: 'RUNNING', started_at: iso(),
    input_versions: { confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version },
    source_evidence: clone(task.sop04_seed_selection.source_refs || []),
    decision_scope: supplementalMode ? 'SKU_ONLY' : (task.sop04_seed_selection.decision_scope || 'SKU_ONLY'),
  };
  task.provider_attempts ||= [];
  task.provider_attempts.push(clone(attempt));
  if (supplementalMode) {
    task.sop04_supplemental_queries ||= [];
    task.sop04_supplemental_queries.push({ ...clone(attempt), status: 'RUNNING' });
  } else {
    task.sop04_search_terms_attempts ||= [];
    task.sop04_search_terms_attempts.push({ ...clone(attempt), status: 'RUNNING' });
  }
  task.status = 'RUNNING'; task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04';
  task.waiting_dependency_key = null; task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
  task.listing_sop.current_step_id = 'LISTING_SOP_04'; task.error_code = null; task.error_message = null;
  task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'RUNNING', dependency: 'BOL_API', dependency_status: 'READY', waiting_reason: null, started_at: iso(), updated_at: iso() };
  task.qa.LISTING_SOP_04 = { ...task.qa.LISTING_SOP_04, status: 'NOT_RUN', checked_at: null, report: null };
  await commit(dataRoot, task, 'STEP_EXECUTION_STARTED', { step: 'LISTING_SOP_04', resume_point: 'LISTING_SOP_04', search_terms_seed: seed, confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version, provider_method: attempt.provider_method, request_id: attempt.request_id, attempt: attemptNumber, attempt_context: supplementalMode ? 'SUPPLEMENTAL_SEARCH_TERMS' : 'INITIAL_SEARCH_TERMS' });

  try {
    const requestedAt = iso();
    const response = await bolClientFor(dataRoot).getSearchTerms({ searchTerm: seed, period: 'WEEK', numberOfPeriods: 52, related: true });
    const httpMatch = String(response.source || '').match(/HTTP\s+(\d{3})/i);
    const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
    const rawSearchTerms = response.rawResponse?.searchTerms || null;
    const returnedRawTerms = Array.isArray(rawSearchTerms?.relatedSearchTerms) ? clone(rawSearchTerms.relatedSearchTerms) : [];
    const initialSelection = prepareSop04RelatedTermSelection(returnedRawTerms, seed);
    const initialClassification = classifySop04RelatedTerms({
      rawTerms: returnedRawTerms, seed,
      anchors: multiSeedPlan.seed_plan.map(item => item.exact_string),
    });
    const supplementalSelection = supplementalMode
      ? prepareSop04SupplementalCandidates(returnedRawTerms, seed, confirmedPartial.map(item => item.exact_string), (task.sop04_excluded_related_terms || []).map(item => item.exact_string))
      : null;
    const candidateTerms = supplementalMode
      ? supplementalSelection.combinedCandidateExactStrings.map(exact_string => ({ exact_string, source_seed_exact_string: confirmedPartial.find(item => item.exact_string === exact_string)?.source_seed_exact_string || seed }))
      : initialSelection.candidateTerms;
    const autoAdoptedInitial = initialClassification.classifications
      .filter(item => item.status === 'RELEVANT_FACT_SUPPORTED')
      .slice(0, 7)
      .map(item => ({ exact_string: item.exact_string, source_seed_exact_string: seed, relevance_reason: `匹配已确认产品事实支持的 SOP03 seed anchor：${item.matched_anchor}` }));
    const adoptedTerms = supplementalMode ? [] : autoAdoptedInitial.length >= 5 ? autoAdoptedInitial : [];
    const termSelection = supplementalMode
      ? { ...supplementalSelection, decisionCode: supplementalSelection.decisionCode, selectorUsed: false }
      : {
        ...initialSelection,
        adoptedTerms,
        candidateClassifications: initialClassification.classifications,
        decisionCode: autoAdoptedInitial.length >= 5 ? null : 'INSUFFICIENT_RELATED_TERMS',
        selectorUsed: false,
      };
    const evidenceRecord = {
      source: 'BOL Retailer API v10 · Search Terms',
      endpoint: '/retailer/insights/search-terms',
      provider_method: 'BOL_RETAILER_API_V10_SEARCH_TERMS',
      seed_exact_string: seed,
      requested_at: requestedAt,
      queried_at: response.createdAt || requestedAt,
      cache_expires_at: response.expiresAt || null,
      cache_hit: response.cacheHit === true,
      cache_source: response.source || null,
      http_status: httpStatus,
      raw_response: clone(response.rawResponse),
      returned_raw_terms: returnedRawTerms,
      auxiliary_search_terms_total: rawSearchTerms?.total ?? null,
    };
    const sourceQueryArtifacts = supplementalMode ? clone(task.sop04_prior_query_records || []) : [];
    attempt.status = 'RESULT_RECEIVED'; attempt.http_status = httpStatus; attempt.queried_at = response.createdAt || requestedAt;
    attempt.completed_at = iso(); attempt.api_evidence = clone(evidenceRecord);
    const attemptCollection = supplementalMode ? task.sop04_supplemental_queries : task.sop04_search_terms_attempts;
    const storedAttempt = attemptCollection.find(item => item.attempt_id === attempt.attempt_id);
    if (storedAttempt) Object.assign(storedAttempt, clone(attempt));
    const genericAttempt = task.provider_attempts.find(item => item.attempt_id === attempt.attempt_id);
    if (genericAttempt) Object.assign(genericAttempt, clone(attempt));
    const outputVersionSeed = {
      artifact_type: 'BOL_RELATED_TERMS_SET', sku: task.sku,
      seed_exact_string: seed, returned_raw_terms: returnedRawTerms,
      candidate_exact_strings: candidateTerms.map(item => item.exact_string), adopted_terms: adoptedTerms,
      candidate_status_annotations: supplementalMode ? [] : initialClassification.classifications,
      related_term_seed_plan: multiSeedPlan.seed_plan,
      related_term_selection_policy: SOP04_MULTI_SEED_POLICY,
      adoption_status: termSelection.decisionCode ? `WAITING_DECISION:${termSelection.decisionCode}` : 'READY_FOR_STAGE_QA',
      api_evidence: evidenceRecord, queried_at: requestedAt,
      confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version,
      ...(supplementalMode ? { parent_version: sourceQueryArtifacts.at(-1)?.version || null, source_query_artifacts: sourceQueryArtifacts, confirmed_partial_terms: confirmedPartial, excluded_prior_terms: clone(task.sop04_excluded_related_terms || []), new_candidate_exact_strings: supplementalSelection.newCandidateExactStrings } : {}),
    };
    const version = `SOP04-${crypto.createHash('sha256').update(JSON.stringify(outputVersionSeed)).digest('hex').slice(0, 20)}`;
    const artifact = { ...outputVersionSeed, version, saved_at: iso() };
    const artifactPath = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop04', `${version}.json`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const artifactJson = JSON.stringify(artifact, null, 2);
    try { await fs.writeFile(artifactPath, artifactJson, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(artifactPath, 'utf8');
      if (existing !== artifactJson) throw Object.assign(new Error('SOP04 版本文件已存在但内容不一致。'), { code: 'SOP04_ARTIFACT_VERSION_COLLISION' });
    }
    const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
    const output = {
      ...artifact,
      evidence: {
        evidence_refs: [relativeArtifact], artifact_ref: relativeArtifact,
        api_evidence: evidenceRecord, confirmed_product_facts_version: factsVersion,
        sop03_artifact_version: sop03Version, no_formal_boloo_volume_written: true,
      },
      open_error_count: activeIssueCount(task), created_at: artifact.saved_at,
    };
    task.outputs ||= {};
    task.outputs.bol_keywords = output;
    task.listing_sop.sop04_artifact_versions ||= [];
    if (!task.listing_sop.sop04_artifact_versions.some(item => item.version === version)) task.listing_sop.sop04_artifact_versions.push({ version, artifact_ref: relativeArtifact, seed_exact_string: seed, queried_at: artifact.queried_at, created_at: artifact.saved_at });
    const qaChecks = [
      { code: 'SOP04_SEED_EXACT_MATCH', pass: artifact.seed_exact_string === seed },
      { code: 'SOP04_FACTS_VERSION_MATCH', pass: Number(artifact.confirmed_product_facts_version) === factsVersion },
      { code: 'SOP04_SOP03_VERSION_MATCH', pass: String(artifact.sop03_artifact_version) === String(sop03Version) },
      { code: 'SOP04_HTTP_200', pass: httpStatus === 200 },
      { code: 'SOP04_RAW_RESPONSE_PRESENT', pass: Boolean(rawSearchTerms) && Array.isArray(rawSearchTerms.relatedSearchTerms) },
      { code: 'SOP04_QUERY_EXACT_MATCH', pass: String(response.structuredResult?.searchTerm || '') === seed },
      { code: 'SOP04_ADOPTED_TERMS_5_TO_7', pass: adoptedTerms.length >= 5 && adoptedTerms.length <= 7 && new Set(adoptedTerms.map(item => item.exact_string)).size === adoptedTerms.length },
      { code: 'SOP04_EVIDENCE_PERSISTED', pass: Boolean(relativeArtifact) && Boolean(await fs.stat(artifactPath).catch(() => null)) },
      { code: 'SOP04_NO_OFFICIAL_VOLUME_CONTAMINATION', pass: !('boloo_search_volume' in output) && !('confirmed_volume' in output) && adoptedTerms.every(item => !('search_volume' in item) && !('total' in item)) },
      { code: 'SOP04_NO_OPEN_ERRORS', pass: activeIssueCount(task) === 0 },
    ];
    const failed = qaChecks.filter(item => !item.pass);
    const qaReport = { checks: qaChecks, failures: failed.map(item => item.code), returned_term_count: returnedRawTerms.length, adopted_term_count: adoptedTerms.length };
    if (termSelection.decisionCode) {
      if (!supplementalMode && termSelection.decisionCode === 'INSUFFICIENT_RELATED_TERMS') {
        task.outputs ||= {};
        task.outputs.bol_keywords = output;
        task.sop04_multi_seed_completion = {
          policy: SOP04_MULTI_SEED_POLICY, status: 'RUNNING',
          primary_seed_exact_string: seed,
          seed_plan: clone(multiSeedPlan.seed_plan), next_seed_index: 0,
          confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version,
          processed_query_artifact_versions: [version],
          adopted_exact_strings: autoAdoptedInitial.map(item => item.exact_string),
          candidate_status_annotations: clone(initialClassification.classifications),
          started_at: iso(),
        };
        await commit(dataRoot, task, 'SOP04_MULTI_SEED_COMPLETION_STARTED', {
          policy: SOP04_MULTI_SEED_POLICY, primary_seed_exact_string: seed,
          initial_adopted_count: autoAdoptedInitial.length,
          seed_plan: multiSeedPlan.seed_plan.map(item => ({ exact_string: item.exact_string, seed_role: item.seed_role, source_refs: item.source_refs })),
          external_requests: 0,
        });
        return runSop04MultiSeedCompletion(dataRoot, task, {
          primaryArtifact: artifact, primaryArtifactRef: relativeArtifact,
          initialAdoptedTerms: autoAdoptedInitial,
          initialClassifications: initialClassification.classifications,
          seedPlan: multiSeedPlan.seed_plan,
        });
      }
      const decisionCode = termSelection.decisionCode;
      const reason = supplementalMode
        ? (candidateTerms.length < 5
          ? '此前 Leon 已确认的关联词与本次补充候选合计仍少于 5 个；已保存完整响应，不补造词。'
          : '此前已确认词与本次补充候选已保存。新增词尚待 Leon 按 SYNTHETIC_ACCEPTANCE_10 产品事实确认；系统不排名、不打分、不自动选择。')
        : candidateTerms.length < 5
        ? 'SOP04 Search Terms exact-string 去重后少于 5 个；已保存完整原始响应，不补造词。'
        : 'SOP04 Search Terms exact-string 去重后超过 7 个；已保存全部候选和原始顺序，等待 Leon 选择正式的 5–7 个。';
      const waiting = createExecutorWaitingItem(task, {
        type: 'WAITING_DECISION', originating_sop_step: 'LISTING_SOP_04',
        current_value: { seed_exact_string: seed, confirmed_exact_strings: confirmedPartial.map(item => item.exact_string), candidate_exact_strings: candidateTerms.map(item => item.exact_string), new_candidate_exact_strings: supplementalMode ? supplementalSelection.newCandidateExactStrings : candidateTerms.map(item => item.exact_string), unique_count: candidateTerms.length, raw_count: returnedRawTerms.length, source_artifact_versions: [...sourceQueryArtifacts.map(item => item.version).filter(Boolean), version] },
        proposed_value_or_action: candidateTerms.length >= 5 ? '请从已保存的 exact strings 中确认最终 5–7 个（必须保留已有确认词）；系统不排名、不打分、不自动挑选。' : '候选少于 5 个；请 Leon 决定是否提供另一个已验证 Dutch seed，不补造关键词。',
        reason,
        evidence: [...sourceQueryArtifacts.map(item => ({ type: 'SOP04_SEARCH_TERMS_RESULT', version: item.version, artifact_ref: item.artifact_ref, http_status: item.api_evidence?.http_status })), { type: supplementalMode ? 'SOP04_SUPPLEMENTAL_SEARCH_TERMS' : 'SOP04_SEARCH_TERMS_RESULT', version, artifact_ref: relativeArtifact, http_status: httpStatus }],
        affected_downstream_modules: ['LISTING_SOP_04', 'LISTING_SOP_05'],
      });
      waiting.decision_code = decisionCode;
      attempt.status = 'WAITING_DECISION';
      const attemptCollection = supplementalMode ? task.sop04_supplemental_queries : task.sop04_search_terms_attempts;
      const storedAttempt = attemptCollection.find(item => item.attempt_id === attempt.attempt_id);
      if (storedAttempt) Object.assign(storedAttempt, clone(attempt));
      const genericAttempt = task.provider_attempts.find(item => item.attempt_id === attempt.attempt_id);
      if (genericAttempt) Object.assign(genericAttempt, clone(attempt));
      applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'WAITING_DECISION', waiting_reason: waiting.reason, resume_point: 'LISTING_SOP_04', output, qa: { status: 'NOT_RUN', report: qaReport } });
      task.qa.LISTING_SOP_04 = { status: 'NOT_RUN', checked_at: null, report: qaReport };
      task.status = 'WAITING_DECISION'; task.activity_pool = '待人工确认'; task.current_pool = task.activity_pool;
      task.error_code = null; task.error_message = null;
      await commit(dataRoot, task, `LISTING_SOP_04_WAITING_FOR_${decisionCode}`, { version, candidate_count: candidateTerms.length, raw_term_count: returnedRawTerms.length, waiting_id: waiting.waiting_id, decision_code: decisionCode, selector_used: termSelection.selectorUsed });
      return task;
    }
    if (failed.length) {
      task.qa.LISTING_SOP_04 = { status: 'FAIL', checked_at: iso(), report: qaReport };
      task.status = 'ERROR'; task.activity_pool = '异常池'; task.current_pool = task.activity_pool;
      const problem = issueFor(task, 'SOP04_STAGE_QA_FAILED', `SOP04 Stage QA 未通过：${failed.map(item => item.code).join(', ')}`, 'outputs.bol_keywords', 'HTTP 200、5–7个唯一词、版本/evidence一致且无正式搜索量污染', '检查真实响应与来源版本后重新核验。');
      task.open_error_count = activeIssueCount(task);
      applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'QA_FAIL', waiting_reason: problem.reason, output, qa: { status: 'QA_FAIL', checked_at: iso(), report: qaReport } });
      await commit(dataRoot, task, 'LISTING_SOP_04_STAGE_QA_FAIL', { version, failed_checks: failed.map(item => item.code) });
      return task;
    }
    applyListingExecutorStep(task, 'LISTING_SOP_04', {
      status: 'PASS', output,
      input_version_refs: [
        { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
        { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: factsVersion },
      ],
      qa: { status: 'PASS', checked_at: iso(), report: qaReport },
    });
    task.qa.LISTING_SOP_04 = { status: 'PASS', checked_at: iso(), report: qaReport };
    attempt.status = 'PASS';
    const successfulAttemptCollection = supplementalMode ? task.sop04_supplemental_queries : task.sop04_search_terms_attempts;
    const successfulStoredAttempt = successfulAttemptCollection.find(item => item.attempt_id === attempt.attempt_id);
    if (successfulStoredAttempt) Object.assign(successfulStoredAttempt, clone(attempt));
    const successfulGenericAttempt = task.provider_attempts.find(item => item.attempt_id === attempt.attempt_id);
    if (successfulGenericAttempt) Object.assign(successfulGenericAttempt, clone(attempt));
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'PASS', dependency: null, dependency_status: 'READY', completed_at: iso(), updated_at: iso() };
    task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.listing_sop.current_step_id = 'LISTING_SOP_04';
    task.last_success_step = 'LISTING_SOP_04'; task.waiting_dependency_key = null; task.status = 'PASS';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.sidecars.keywords = { ...task.sidecars.keywords, status: 'PASS', updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_04_STAGE_QA_PASS_STOPPED', { version, seed_exact_string: seed, adopted_term_count: adoptedTerms.length, sop03_artifact_version: sop03Version, confirmed_product_facts_version: factsVersion, stopped_before_sop05: true });
    return task;
  } catch (error) {
    const code = error instanceof AdapterError ? error.code : 'BOL_SEARCH_TERMS_EXECUTION_FAILED';
    const reason = error instanceof AdapterError ? error.message : 'BOL Search Terms 执行失败，错误内容已脱敏。';
    if (await waitForProviderDependency(dataRoot, task, {
      step: 'LISTING_SOP_04', dependencyKey: 'BOL_API', error, attempt,
      providerMethod: attempt.provider_method, seed, sourceEvidence: attempt.source_evidence,
      location: 'outputs.bol_keywords',
    })) return task;
    issueFor(task, code, reason, 'outputs.bol_keywords', '真实 BOL Search Terms 原始响应、5–7 个有效关联词与可追溯版本', '检查 BOL readiness/网络并从 SOP04 断点重新执行。');
    task.open_error_count = activeIssueCount(task); task.return_pool = '关键词池'; task.activity_pool = '异常池'; task.current_pool = task.activity_pool; task.status = 'ERROR';
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'ERROR', updated_at: iso() };
    task.qa.LISTING_SOP_04 = { status: 'FAIL', checked_at: iso(), report: [reason] };
    await commit(dataRoot, task, 'LISTING_SOP_04_EXECUTION_FAILED', { code, http_status: error?.status || null });
    return task;
  }
}

function sop04QueryRecordFromArtifact(artifact, artifactRef) {
  const returned = Array.isArray(artifact?.returned_raw_terms)
    ? clone(artifact.returned_raw_terms)
    : clone(artifact?.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms || []);
  return {
    version: artifact?.version || null,
    artifact_ref: artifactRef || null,
    seed_exact_string: artifact?.seed_exact_string || null,
    queried_at: artifact?.api_evidence?.queried_at || artifact?.queried_at || null,
    returned_raw_terms: returned,
    api_evidence: clone(artifact?.api_evidence || null),
    candidate_status_annotations: clone(artifact?.candidate_status_annotations || []),
  };
}

function uniqueSop04RawExactStrings(queryRecords) {
  const seen = new Set();
  const result = [];
  for (const query of queryRecords || []) {
    for (const row of query.returned_raw_terms || []) {
      const exact = typeof row?.searchTerm === 'string' ? row.searchTerm : '';
      if (exact && !seen.has(exact)) { seen.add(exact); result.push(exact); }
    }
  }
  return result;
}

async function runSop04MultiSeedCompletion(dataRoot, task, {
  primaryArtifact = null, primaryArtifactRef = null,
  initialAdoptedTerms = null, initialClassifications = null,
  seedPlan = null, preferredExactStrings = null, explicitInitialDecision = null,
} = {}) {
  const step = 'LISTING_SOP_04';
  const facts = task.outputs?.confirmed_product_facts;
  const factsVersion = Number(facts?.version || 0);
  const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version
    || task.listing_sop?.steps?.LISTING_SOP_03?.output_version;
  const primarySeed = String(task.sop04_seed_selection?.exact_string || '');
  if (task.current_step !== step || !primarySeed || facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION'
    || task.qa?.LISTING_SOP_03?.status !== 'PASS'
    || !sop03Version || factsVersion !== Number(task.sop04_seed_selection?.confirmed_product_facts_version)
    || String(sop03Version) !== String(task.sop04_seed_selection?.sop03_artifact_version)) {
    throw Object.assign(new Error('SOP04 multi-seed completion 的当前 facts、SOP03 或 primary seed 版本不一致。'), { code: 'SOP04_MULTI_SEED_INPUT_VERSION_MISMATCH' });
  }

  if (!primaryArtifact || !primaryArtifactRef) {
    const currentOutput = task.outputs?.bol_keywords;
    primaryArtifactRef = currentOutput?.evidence?.artifact_ref;
    if (!primaryArtifactRef) throw Object.assign(new Error('缺少已持久化的首个 SOP04 Search Terms artifact。'), { code: 'SOP04_PRIMARY_ARTIFACT_MISSING' });
    const resolved = path.resolve(dataRoot, primaryArtifactRef);
    if (!resolved.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw Object.assign(new Error('SOP04 primary artifact 越出当前数据根。'), { code: 'SOP04_ARTIFACT_PATH_INVALID' });
    primaryArtifact = JSON.parse(await fs.readFile(resolved, 'utf8'));
  }
  if (primaryArtifact.seed_exact_string !== primarySeed
    || Number(primaryArtifact.confirmed_product_facts_version) !== factsVersion
    || String(primaryArtifact.sop03_artifact_version) !== String(sop03Version)
    || !Array.isArray(primaryArtifact.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms)) {
    throw Object.assign(new Error('首个 SOP04 artifact 的 seed、facts/SOP03 version 或 raw response 不匹配。'), { code: 'SOP04_PRIMARY_ARTIFACT_INVALID' });
  }

  const sourceRows = task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
  const orderedPreferredExactStrings = explicitInitialDecision?.seed_sequence || preferredExactStrings;
  const derivedPlan = buildSop04SupplementalSeedPlan({ facts, sourceRows, primarySeed, preferredExactStrings: orderedPreferredExactStrings });
  if (derivedPlan.invalid_preferred_exact_strings.length) {
    throw Object.assign(new Error('补充 seed 不属于当前 confirmed facts 支持且已由 SOP03 PASS 输出的 exact string。'), {
      code: 'SOP04_MULTI_SEED_PLAN_INVALID', invalid_exact_strings: derivedPlan.invalid_preferred_exact_strings,
    });
  }
  if (Array.isArray(seedPlan) && JSON.stringify(seedPlan.map(item => item.exact_string)) !== JSON.stringify(derivedPlan.seed_plan.map(item => item.exact_string))) {
    throw Object.assign(new Error('执行 seed plan 与当前 facts/SOP03 可验证计划不一致。'), { code: 'SOP04_MULTI_SEED_PLAN_CHANGED' });
  }
  const finalSeedPlan = derivedPlan.seed_plan;
  if (finalSeedPlan.length > 2) throw Object.assign(new Error('SOP04 最多允许三个 exact seed。'), { code: 'SOP04_MULTI_SEED_LIMIT_EXCEEDED' });

  const rawInitial = primaryArtifact.returned_raw_terms || primaryArtifact.api_evidence.raw_response.searchTerms.relatedSearchTerms;
  const initialExact = [...new Set(rawInitial.map(item => typeof item?.searchTerm === 'string' ? item.searchTerm : '').filter(Boolean))];
  let adopted = Array.isArray(initialAdoptedTerms) ? clone(initialAdoptedTerms) : [];
  let annotations = Array.isArray(initialClassifications) ? clone(initialClassifications) : [];
  const explicitAdopt = Array.isArray(explicitInitialDecision?.adopt_exact_strings) ? explicitInitialDecision.adopt_exact_strings : null;
  const explicitReject = Array.isArray(explicitInitialDecision?.reject_exact_strings) ? explicitInitialDecision.reject_exact_strings : null;
  if (explicitInitialDecision) {
    if (!explicitAdopt?.length || !explicitReject || explicitAdopt.length + explicitReject.length !== initialExact.length
      || new Set([...explicitAdopt, ...explicitReject]).size !== initialExact.length
      || [...explicitAdopt, ...explicitReject].some(exact => !initialExact.includes(exact))) {
      throw Object.assign(new Error('首轮 ADOPT/REJECT 必须完整、互斥地覆盖首轮真实 exact candidates。'), { code: 'SOP04_INITIAL_FACT_DECISION_INVALID' });
    }
    adopted = explicitAdopt.map(exact_string => ({
      exact_string, source_seed_exact_string: primarySeed,
      relevance_reason: 'Leon按当前SKU已确认事实对首轮真实Search Terms候选作出的明确事实相关性分类。',
      selection_source: 'LEON_EXPLICIT_FACT_RULE',
    }));
    annotations = [
      ...explicitAdopt.map((exact_string, index) => ({ raw_position: rawInitial.findIndex(item => item?.searchTerm === exact_string) + 1,
        exact_string, status: 'ADOPTED_BY_LEON_FACT_RULE', reason_code: 'EXPLICIT_CURRENT_SKU_FACT_MATCH', matched_anchor: null, decision_position: index + 1 })),
      ...explicitReject.map(exact_string => ({ raw_position: rawInitial.findIndex(item => item?.searchTerm === exact_string) + 1,
        exact_string, status: 'REJECT_AS_IRRELEVANT', reason_code: 'EXPLICIT_CURRENT_SKU_FACT_MISMATCH', matched_anchor: null })),
    ].sort((a, b) => a.raw_position - b.raw_position);
    task.sop04_confirmed_related_terms = adopted.map(item => ({
      ...clone(item), source_artifact_version: primaryArtifact.version,
      selected_at: iso(), decision_scope: 'SKU_ONLY',
    }));
    task.sop04_excluded_related_terms = explicitReject.map(exact_string => ({
      exact_string, status: 'REJECT_AS_IRRELEVANT',
      exclusion_reason: '与当前 SKU 已确认 DIY/串珠圣诞树套装方向不匹配；不得为凑数采用。',
      source_artifact_version: primaryArtifact.version, decided_at: iso(), decision_scope: 'SKU_ONLY',
    }));
    task.listing_sop.decisions ||= [];
    task.listing_sop.decisions.push({
      type: 'SOP04_INITIAL_RELATED_TERMS_FACT_CLASSIFICATION',
      selected_by: 'Leon', at: iso(), decision_scope: 'SYNTHETIC_ACCEPTANCE_05_ONLY',
      adopted_exact_strings: explicitAdopt, rejected_exact_strings: explicitReject,
      source_artifact_version: primaryArtifact.version, reusable_as_global_rule: false,
    });
  }
  if (adopted.length > 7 || new Set(adopted.map(item => item.exact_string)).size !== adopted.length
    || adopted.some(item => !initialExact.includes(item.exact_string))) {
    throw Object.assign(new Error('首轮 adopted terms 必须是5–7个以内、唯一且来自原始响应的 exact strings。'), { code: 'SOP04_INITIAL_ADOPTED_INVALID' });
  }

  const existingWait = [...(task.listing_executor?.waiting_items || [])].reverse().find(item => !item.decided_at
    && item.type === 'WAITING_DECISION' && item.originating_sop_step === step
    && ['SELECT_5_TO_7_RELATED_TERMS', 'INSUFFICIENT_RELATED_TERMS'].includes(item.decision_code));
  if (existingWait && explicitInitialDecision) resolveExecutorWaitingItem(task, existingWait.waiting_id,
    '自动追加 SOP03 已确认 exact seed；不进入人工选词。', iso());

  const primaryRecord = sop04QueryRecordFromArtifact(primaryArtifact, primaryArtifactRef);
  let queryRecords = Array.isArray(task.sop04_multi_seed_completion?.query_records)
    ? clone(task.sop04_multi_seed_completion.query_records) : [primaryRecord];
  if (!queryRecords.some(item => item.version === primaryRecord.version)) queryRecords = [primaryRecord, ...queryRecords];
  let candidateAnnotations = annotations.length ? annotations : clone(primaryRecord.candidate_status_annotations || []);
  const allAnchors = [...new Set([primarySeed, ...finalSeedPlan.map(item => item.exact_string)])];
  const attemptedSeeds = new Set((task.sop04_supplemental_queries || []).map(item => item.seed_exact_string).filter(Boolean));
  const startedAt = task.sop04_multi_seed_completion?.started_at || iso();
  task.sop04_multi_seed_completion = {
    ...(task.sop04_multi_seed_completion || {}),
    policy: SOP04_MULTI_SEED_POLICY, status: 'RUNNING', primary_seed_exact_string: primarySeed,
    seed_plan: clone(finalSeedPlan), query_records: clone(queryRecords),
    next_seed_index: Number(task.sop04_multi_seed_completion?.next_seed_index || 0),
    adopted_exact_strings: adopted.map(item => item.exact_string),
    candidate_status_annotations: clone(candidateAnnotations),
    confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version,
    started_at: startedAt,
  };
  task.sop04_confirmed_related_terms = adopted.map(item => ({ ...clone(item), decision_scope: 'SKU_ONLY' }));
  task.status = 'RUNNING'; task.current_step = step; task.resume_point = step;
  task.listing_sop.current_step_id = step; task.waiting_dependency_key = null;
  task.error_code = null; task.error_message = null;
  task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
  task.stages[step] = { ...task.stages[step], status: 'RUNNING', dependency: 'BOL_API', waiting_reason: null, updated_at: iso() };
  await commit(dataRoot, task, 'SOP04_MULTI_SEED_COMPLETION_CHECKPOINT_SAVED', {
    policy: SOP04_MULTI_SEED_POLICY, primary_seed_exact_string: primarySeed,
    initial_adopted_count: adopted.length, initial_candidate_count: initialExact.length,
    seed_plan: finalSeedPlan.map(item => ({ exact_string: item.exact_string, seed_role: item.seed_role, source_refs: item.source_refs })),
    external_requests: 0,
  });

  let latestArtifact = primaryArtifact;
  let latestArtifactRef = primaryArtifactRef;
  let lastApiEvidence = primaryArtifact.api_evidence;
  const usedSeedSet = new Set([primarySeed]);
  for (let index = 0; index < finalSeedPlan.length && adopted.length < 5; index += 1) {
    const planItem = finalSeedPlan[index];
    const seed = planItem.exact_string;
    if (usedSeedSet.has(seed)) continue;
    usedSeedSet.add(seed);
    if (attemptedSeeds.has(seed)) {
      const priorAttempt = [...(task.sop04_supplemental_queries || [])].reverse().find(item => item.seed_exact_string === seed);
      if (priorAttempt?.status === 'PASS' && priorAttempt.artifact_ref) {
        throw Object.assign(new Error('该 seed 已有历史调用；恢复时必须从已保存 query artifact 读取，不得重新发起。'), {
          code: 'SOP04_MULTI_SEED_EXISTING_ATTEMPT_REQUIRES_RECONCILIATION', seed_exact_string: seed,
        });
      }
      task.sop04_multi_seed_completion.status = 'WAITING_ATTEMPT_RECONCILIATION';
      task.sop04_multi_seed_completion.next_seed_index = index;
      task.status = 'PAUSED'; task.waiting_dependency_key = null; task.resume_point = step;
      await commit(dataRoot, task, 'SOP04_MULTI_SEED_ATTEMPT_RECONCILIATION_REQUIRED', {
        seed_exact_string: seed, attempt_status: priorAttempt?.status || 'UNKNOWN', external_requests: 0,
      });
      return { task, multi_seed_status: 'WAITING_ATTEMPT_RECONCILIATION', external_requests: 0 };
    }

    const readiness = await bolApiReadiness(dataRoot);
    const override = readinessOverride('BOL_API_READY');
    const dependencyReady = typeof override === 'boolean' ? override : readiness.status === 'PASS';
    if (!dependencyReady) {
      task.sop04_multi_seed_completion.status = 'WAITING_DEPENDENCY';
      task.sop04_multi_seed_completion.next_seed_index = index;
      task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'BOL_API';
      task.current_step = step; task.resume_point = step; task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: null };
      task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'BOL_API', waiting_reason: `补充 seed ${seed} 未发送：BOL API readiness=${readiness.status || 'UNKNOWN'}。`, updated_at: iso() };
      await commit(dataRoot, task, 'SOP04_MULTI_SEED_PREFLIGHT_BLOCKED', {
        seed_exact_string: seed, dependency: 'BOL_API', readiness_status: readiness.status || 'UNKNOWN', external_requests: 0,
      });
      return { task, multi_seed_status: 'WAITING_DEPENDENCY', next_seed_exact_string: seed, external_requests: 0 };
    }

    const source = sourceRows.find(row => row.status === 'PASS' && (row.exact_strings || [])
      .some(value => (typeof value === 'string' ? value : String(value?.exact_string ?? value?.keyword ?? '').trim()) === seed));
    if (!source?.source_id || !source.result_version || !source.provider_request_id) {
      throw Object.assign(new Error(`补充 seed ${seed} 缺少 SOP03 PASS 来源 request/version。`), { code: 'SOP04_MULTI_SEED_SOURCE_MISSING' });
    }
    const queryAttempt = {
      attempt_id: crypto.randomUUID(), request_id: crypto.randomUUID(), attempt: 1,
      step, dependency_key: 'BOL_API', provider_method: 'BOL_RETAILER_API_V10_SEARCH_TERMS',
      seed_exact_string: seed, status: 'RUNNING', started_at: iso(), decision_scope: 'SKU_ONLY',
      input_versions: { confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version },
      source_evidence: [{ source_id: source.source_id, result_version: source.result_version,
        provider_request_id: source.provider_request_id, evidence_refs: clone(source.evidence_refs || []) }],
    };
    task.sop04_supplemental_queries ||= [];
    task.sop04_supplemental_queries.push(clone(queryAttempt));
    task.provider_attempts ||= [];
    task.provider_attempts.push(clone(queryAttempt));
    task.sop04_multi_seed_completion.next_seed_index = index;
    task.sop04_multi_seed_completion.active_seed_exact_string = seed;
    await commit(dataRoot, task, 'SOP04_MULTI_SEED_QUERY_STARTED', {
      seed_exact_string: seed, attempt_id: queryAttempt.attempt_id, request_id: queryAttempt.request_id,
      seed_role: planItem.seed_role, facts_version: factsVersion, sop03_artifact_version: sop03Version,
      external_requests: 1,
    });

    try {
      const requestedAt = iso();
      const response = await bolClientFor(dataRoot).getSearchTerms({ searchTerm: seed, period: 'WEEK', numberOfPeriods: 52, related: true });
      const httpMatch = String(response.source || '').match(/HTTP\s+(\d{3})/i);
      const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
      const rawResponse = clone(response.rawResponse);
      const rawTerms = rawResponse?.searchTerms?.relatedSearchTerms;
      if (httpStatus !== 200 || !Array.isArray(rawTerms)) {
        throw Object.assign(new Error('BOL Search Terms 未返回可验证的 HTTP 200 relatedSearchTerms。'), {
          code: 'BOL_SEARCH_TERMS_RESPONSE_INVALID', status: httpStatus,
          response_received: httpStatus !== null,
        });
      }
      const returnedRawTerms = clone(rawTerms);
      const apiEvidence = {
        source: 'BOL Retailer API v10 · Search Terms', endpoint: '/retailer/insights/search-terms',
        provider_method: 'BOL_RETAILER_API_V10_SEARCH_TERMS', seed_exact_string: seed,
        requested_at: requestedAt, queried_at: response.createdAt || requestedAt,
        cache_expires_at: response.expiresAt || null, cache_hit: response.cacheHit === true,
        cache_source: response.source || null, http_status: httpStatus,
        raw_response: rawResponse, returned_raw_terms: returnedRawTerms,
        auxiliary_search_terms_total: rawResponse?.searchTerms?.total ?? null,
      };
      const classified = classifySop04RelatedTerms({
        rawTerms: returnedRawTerms, seed, anchors: allAnchors,
        alreadyAdopted: adopted.map(item => item.exact_string),
        explicitlyRejected: (task.sop04_excluded_related_terms || []).map(item => item.exact_string),
      });
      const newRelevant = classified.classifications.filter(item => item.status === 'RELEVANT_FACT_SUPPORTED');
      const availableSlots = Math.max(0, Math.min(7, 5 - adopted.length));
      const selectedNow = newRelevant.slice(0, availableSlots);
      const adoptedBefore = new Set(adopted.map(item => item.exact_string));
      for (const item of selectedNow) {
        if (adoptedBefore.has(item.exact_string)) continue;
        adopted.push({ exact_string: item.exact_string, source_seed_exact_string: seed,
          relevance_reason: `匹配已确认产品事实支持的 SOP03 seed anchor：${item.matched_anchor}` });
        adoptedBefore.add(item.exact_string);
      }
      for (const item of newRelevant.slice(selectedNow.length)) {
        const annotation = classified.classifications.find(row => row.exact_string === item.exact_string);
        if (annotation) Object.assign(annotation, { status: 'NOT_ADOPTED_AFTER_MINIMUM_MET', reason_code: 'MINIMUM_5_TERMS_REACHED_IN_PROVIDER_ORDER' });
      }
      candidateAnnotations = [...candidateAnnotations, ...classified.classifications];
      const queryAttemptRecord = {
        ...clone(queryAttempt), status: 'PASS', http_status: httpStatus,
        queried_at: apiEvidence.queried_at, completed_at: iso(), version: null, artifact_ref: null,
        api_evidence: clone(apiEvidence), returned_raw_terms: clone(returnedRawTerms),
        candidate_status_annotations: clone(classified.classifications),
      };
      Object.assign(task.sop04_supplemental_queries.find(item => item.attempt_id === queryAttempt.attempt_id), queryAttemptRecord);
      Object.assign(task.provider_attempts.find(item => item.attempt_id === queryAttempt.attempt_id), queryAttemptRecord);
      const nextRecord = {
        version: null, artifact_ref: null, seed_exact_string: seed, queried_at: apiEvidence.queried_at,
        returned_raw_terms: clone(returnedRawTerms), api_evidence: clone(apiEvidence),
        candidate_status_annotations: clone(classified.classifications),
      };
      queryRecords.push(nextRecord);
      const candidateExactStrings = uniqueSop04RawExactStrings(queryRecords);
      const enough = adopted.length >= 5 && adopted.length <= 7;
      const artifactSeed = {
        artifact_type: 'BOL_RELATED_TERMS_SET', sku: task.sku,
        parent_version: latestArtifact.version,
        seed_exact_string: primarySeed,
        seed_exact_strings: [primarySeed, ...queryRecords.slice(1).map(item => item.seed_exact_string)],
        last_seed_exact_string: seed,
        returned_raw_terms: returnedRawTerms,
        candidate_exact_strings: candidateExactStrings,
        candidate_status_annotations: clone(candidateAnnotations),
        adopted_terms: clone(adopted),
        excluded_terms: clone(task.sop04_excluded_related_terms || []),
        related_term_seed_plan: clone(finalSeedPlan),
        related_term_selection_policy: SOP04_MULTI_SEED_POLICY,
        adoption_status: enough ? 'READY_FOR_STAGE_QA' : 'SUPPLEMENT_REQUIRED',
        api_evidence: apiEvidence, queried_at: requestedAt,
        // Prior immutable query artifacts are referenced here. The current raw
        // response is this artifact itself and cannot self-reference its hash.
        source_query_artifacts: clone(queryRecords.slice(0, -1)),
        confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version,
      };
      const version = `SOP04-${crypto.createHash('sha256').update(JSON.stringify(artifactSeed)).digest('hex').slice(0, 20)}`;
      const artifact = { ...artifactSeed, version, saved_at: iso() };
      const artifactPath = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop04', `${version}.json`);
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      const artifactJson = JSON.stringify(artifact, null, 2);
      try { await fs.writeFile(artifactPath, artifactJson, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST' || await fs.readFile(artifactPath, 'utf8') !== artifactJson) {
          throw Object.assign(new Error('SOP04 multi-seed artifact cannot be overwritten or reconciled.'), { code: 'SOP04_ARTIFACT_VERSION_COLLISION' });
        }
      }
      const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
      nextRecord.version = version; nextRecord.artifact_ref = relativeArtifact;
      queryAttemptRecord.version = version; queryAttemptRecord.artifact_ref = relativeArtifact;
      const output = {
        ...artifact,
        evidence: {
          evidence_refs: queryRecords.map(item => item.artifact_ref).filter(Boolean).concat(relativeArtifact),
          query_artifact_refs: queryRecords.map(item => item.artifact_ref).filter(Boolean),
          artifact_ref: relativeArtifact, parent_artifact_ref: latestArtifactRef,
          api_evidence: apiEvidence, confirmed_product_facts_version: factsVersion,
          sop03_artifact_version: sop03Version, no_formal_boloo_volume_written: true,
        },
        open_error_count: activeIssueCount(task), created_at: artifact.saved_at,
      };
      task.outputs.bol_keywords = output;
      task.listing_sop.sop04_artifact_versions ||= [];
      for (const versionRow of task.listing_sop.sop04_artifact_versions) {
        if (versionRow.version === latestArtifact.version) versionRow.current = false;
      }
      if (!task.listing_sop.sop04_artifact_versions.some(item => item.version === version)) {
        task.listing_sop.sop04_artifact_versions.push({ version, artifact_ref: relativeArtifact,
          parent_version: latestArtifact.version, seed_exact_string: seed,
          created_at: artifact.saved_at, status: enough ? 'READY_FOR_STAGE_QA' : 'SUPPLEMENT_REQUIRED', current: true });
      }
      queryRecords[queryRecords.length - 1] = nextRecord;
      task.sop04_multi_seed_completion.query_records = clone(queryRecords);
      task.sop04_multi_seed_completion.processed_query_artifact_versions = queryRecords.map(item => item.version).filter(Boolean);
      task.sop04_multi_seed_completion.adopted_exact_strings = adopted.map(item => item.exact_string);
      task.sop04_multi_seed_completion.candidate_status_annotations = clone(candidateAnnotations);
      task.sop04_multi_seed_completion.last_completed_seed_exact_string = seed;
      task.sop04_multi_seed_completion.next_seed_index = index + 1;
      task.sop04_multi_seed_completion.active_seed_exact_string = null;
      task.sop04_supplemental_queries.find(item => item.attempt_id === queryAttempt.attempt_id).version = version;
      task.sop04_supplemental_queries.find(item => item.attempt_id === queryAttempt.attempt_id).artifact_ref = relativeArtifact;
      task.provider_attempts.find(item => item.attempt_id === queryAttempt.attempt_id).version = version;
      task.provider_attempts.find(item => item.attempt_id === queryAttempt.attempt_id).artifact_ref = relativeArtifact;
      task.sop04_confirmed_related_terms = adopted.map(item => ({ ...clone(item), decision_scope: 'SKU_ONLY' }));
      await commit(dataRoot, task, 'SOP04_MULTI_SEED_QUERY_RESULT_SAVED', {
        seed_exact_string: seed, version, http_status: httpStatus,
        raw_term_count: returnedRawTerms.length,
        relevant_count: classified.classifications.filter(item => item.status === 'RELEVANT_FACT_SUPPORTED').length,
        adopted_total: adopted.length, minimum_met: enough, external_requests: 1,
        no_formal_volume_written: true,
      });
      latestArtifact = artifact;
      latestArtifactRef = relativeArtifact;
      lastApiEvidence = apiEvidence;
      if (enough) break;
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : String(error?.code || 'BOL_SEARCH_TERMS_EXECUTION_FAILED');
      const reason = error instanceof AdapterError ? error.message : 'BOL Search Terms multi-seed 执行失败，诊断已脱敏。';
      const savedAttempt = task.sop04_supplemental_queries.find(item => item.attempt_id === queryAttempt.attempt_id);
      if (savedAttempt && savedAttempt.status === 'RUNNING') {
        savedAttempt.status = 'FAILED'; savedAttempt.error_code = code; savedAttempt.http_status = error?.status || null; savedAttempt.completed_at = iso();
      }
      const genericAttempt = task.provider_attempts.find(item => item.attempt_id === queryAttempt.attempt_id);
      if (genericAttempt && genericAttempt.status === 'RUNNING') Object.assign(genericAttempt, clone(savedAttempt));
      if (await waitForProviderDependency(dataRoot, task, {
        step, dependencyKey: 'BOL_API', error, attempt: savedAttempt || queryAttempt,
        providerMethod: 'BOL_RETAILER_API_V10_SEARCH_TERMS', seed,
        sourceEvidence: { facts_version: factsVersion, sop03_artifact_version: sop03Version,
          prior_artifact_versions: queryRecords.map(item => item.version).filter(Boolean) },
        location: 'outputs.bol_keywords.multi_seed_search_terms',
      })) return { task, external_requests: 1, failed_seed_exact_string: seed, error_code: code };
      issueFor(task, code, reason, 'outputs.bol_keywords.multi_seed_search_terms', '保存当前 seed 的真实 Search Terms raw response 和 evidence', '从 SOP04 multi-seed checkpoint 检查失败 attempt；不得无审计地重复请求。');
      task.open_error_count = activeIssueCount(task); task.status = 'ERROR';
      task.return_pool = '关键词池'; task.activity_pool = '异常池'; task.current_pool = task.activity_pool;
      task.stages[step] = { ...task.stages[step], status: 'ERROR', updated_at: iso() };
      task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: ['SOP04_MULTI_SEED_PROVIDER_FAILED'] };
      task.sop04_multi_seed_completion.status = 'FAILED';
      await commit(dataRoot, task, 'SOP04_MULTI_SEED_QUERY_FAILED', { seed_exact_string: seed, error_code: code, http_status: error?.status || null, external_requests: 1 });
      return { task, external_requests: 1, failed_seed_exact_string: seed, error_code: code };
    }
  }

  if (adopted.length < 5) {
    const exhaustion = {
      policy: SOP04_MULTI_SEED_POLICY, status: 'WAITING_DECISION',
      reason_code: 'INSUFFICIENT_RELATED_TERMS',
      available_seed_count: finalSeedPlan.length,
      attempted_seed_count: (task.sop04_supplemental_queries || []).length,
      adopted_exact_strings: adopted.map(item => item.exact_string),
      remaining_seed_queries: [],
      decision_scope: 'ONLY_NEW_SEED_OR_SOP04_REQUIREMENT_CLARIFICATION',
    };
    task.sop04_multi_seed_completion = { ...task.sop04_multi_seed_completion, ...exhaustion };
    const waiting = createExecutorWaitingItem(task, {
      type: 'WAITING_DECISION', originating_sop_step: step,
      current_value: exhaustion,
      proposed_value_or_action: '所有 facts-supported SOP03 seed 已按序查询且仍不足5个；不得补造或采用不相关词。',
      reason: '当前 SKU 可验证的既有 exact seed 已耗尽，仍未取得SOP要求的5个相关词；等待新增已验证 exact seed 或澄清SOP约束。',
      evidence: queryRecords.map(item => ({ type: 'SOP04_SEARCH_TERMS_QUERY', version: item.version, artifact_ref: item.artifact_ref, seed_exact_string: item.seed_exact_string })),
      affected_downstream_modules: ['LISTING_SOP_04', 'LISTING_SOP_05'],
    });
    waiting.decision_code = 'INSUFFICIENT_RELATED_TERMS';
    task.status = 'WAITING_DECISION'; task.waiting_dependency_key = null; task.resume_point = step;
    task.stages[step] = { ...task.stages[step], status: 'WAITING_DECISION', waiting_reason: '现有事实支持的SOP03 seed已耗尽，相关词仍不足5个。', updated_at: iso() };
    task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: { adopted_term_count: adopted.length, queried_seed_count: queryRecords.length } };
    await commit(dataRoot, task, 'SOP04_MULTI_SEED_EXHAUSTED_INSUFFICIENT_TERMS', {
      adopted_term_count: adopted.length, queried_seed_count: queryRecords.length, waiting_id: waiting.waiting_id,
      external_requests: 0, no_irrelevant_padding: true,
    });
    return { task, waiting_item: waiting, external_requests: 0, multi_seed_status: 'INSUFFICIENT_RELATED_TERMS' };
  }

  const output = task.outputs?.bol_keywords;
  if (!output || !output.evidence?.artifact_ref) throw Object.assign(new Error('SOP04 final multi-seed artifact 尚未持久化。'), { code: 'SOP04_FINAL_ARTIFACT_MISSING' });
  task.sop04_confirmed_related_terms = adopted.map(item => ({ ...clone(item), decision_scope: 'SKU_ONLY' }));
  const checks = [
    { code: 'SOP04_MULTI_SEED_MINIMUM', pass: adopted.length >= 5 && adopted.length <= 7 },
    { code: 'SOP04_MULTI_SEED_EXACT_UNIQUE', pass: new Set(adopted.map(item => item.exact_string)).size === adopted.length },
    { code: 'SOP04_MULTI_SEED_ALL_FROM_RAW', pass: adopted.every(item => uniqueSop04RawExactStrings(queryRecords).includes(item.exact_string)) },
    { code: 'SOP04_MULTI_SEED_RAW_EVIDENCE_COMPLETE', pass: queryRecords.length >= 1 && queryRecords.length <= 3 && queryRecords.every(item => item.version && item.artifact_ref && Array.isArray(item.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms)) },
    { code: 'SOP04_MULTI_SEED_FACT_CLASSIFICATION', pass: adopted.every(item => candidateAnnotations.some(row => row.exact_string === item.exact_string && ['RELEVANT_FACT_SUPPORTED', 'ADOPTED_BY_LEON_FACT_RULE'].includes(row.status))) },
    { code: 'SOP04_MULTI_SEED_INPUT_VERSIONS', pass: Number(output.confirmed_product_facts_version) === factsVersion && String(output.sop03_artifact_version) === String(sop03Version) },
    { code: 'SOP04_MULTI_SEED_NO_VOLUME_FIELDS', pass: adopted.every(item => !Object.hasOwn(item, 'total') && !Object.hasOwn(item, 'search_volume') && !Object.hasOwn(item, 'boloo_search_volume')) },
    { code: 'SOP04_MULTI_SEED_NO_OPEN_ERRORS', pass: activeIssueCount(task) === 0 },
  ];
  task.outputs.bol_keywords.candidate_status_annotations = clone(candidateAnnotations);
  task.outputs.bol_keywords.adoption_status = 'READY_FOR_STAGE_QA';
  task.outputs.bol_keywords.qa_prechecks = checks;
  task.sop04_multi_seed_completion.status = 'READY_FOR_STAGE_QA';
  task.sop04_multi_seed_completion.query_records = clone(queryRecords);
  task.sop04_multi_seed_completion.processed_query_artifact_versions = queryRecords.map(item => item.version).filter(Boolean);
  task.sop04_multi_seed_completion.adopted_exact_strings = adopted.map(item => item.exact_string);
  const preFailures = checks.filter(item => !item.pass);
  if (preFailures.length) {
    task.status = 'ERROR'; task.open_error_count = activeIssueCount(task);
    task.qa[step] = { status: 'FAIL', checked_at: iso(), report: { checks, failures: preFailures.map(item => item.code) } };
    await commit(dataRoot, task, 'SOP04_MULTI_SEED_LOCAL_QA_FAILED', { version: output.version, failed_checks: preFailures.map(item => item.code), external_requests: 0 });
    return { task, external_requests: 0, failed_checks: preFailures.map(item => item.code) };
  }
  const completedAt = iso();
  if (existingWait && !existingWait.decided_at) resolveExecutorWaitingItem(task, existingWait.waiting_id, '自动 seed completion 已满足5个 facts-supported exact strings。', completedAt);
  task.current_step = step; task.resume_point = step; task.listing_sop.current_step_id = step;
  task.status = 'RUNNING'; task.waiting_dependency_key = null;
  task.stages[step] = { ...task.stages[step], status: 'DONE_PENDING_QA', dependency: null, updated_at: completedAt };
  applyListingExecutorStep(task, step, {
    status: 'DONE_PENDING_QA', output,
    input_version_refs: [
      { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
      { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: factsVersion },
    ],
    qa: { status: 'NOT_RUN', report: { checks, failures: [] } },
  });
  await commit(dataRoot, task, 'SOP04_MULTI_SEED_READY_FOR_STAGE_QA', {
    version: output.version, adopted_exact_strings: adopted.map(item => item.exact_string),
    query_count: queryRecords.length, facts_version: factsVersion, sop03_version: sop03Version, external_requests: 0,
  });
  const verification = await verifyCurrent(dataRoot, task);
  if (verification.passed) {
    task.sop04_multi_seed_completion.status = 'PASS';
    task.sop04_multi_seed_completion.completed_at = iso();
    task.sop04_multi_seed_completion.stage_qa_status = 'PASS';
    await commit(dataRoot, task, 'SOP04_MULTI_SEED_COMPLETION_STAGE_QA_PASS', {
      version: output.version, adopted_count: adopted.length,
      next_step: task.current_step, stage_qa_status: task.qa?.LISTING_SOP_04?.status,
      external_requests: 0,
    });
  }
  return { ...verification, task, multi_seed_status: verification.passed ? 'PASS' : task.sop04_multi_seed_completion.status,
    query_count: queryRecords.length, external_requests: Math.max(0, queryRecords.length - 1) };
}

async function runSop04MultiSeedCompletionWithLease(dataRoot, task, options) {
  const step = 'LISTING_SOP_04';
  const stepRecord = task.listing_executor?.registry?.[step];
  const inputVersion = makeListingExecutionInputVersion(
    stepRecord?.input_version_refs || [], stepRecord?.required_dependencies || [],
  );
  const activeForStep = dbFor(dataRoot).prepare("SELECT * FROM listing_execution_leases WHERE sku_id=? AND step=? AND state='RUNNING' ORDER BY started_at DESC LIMIT 1")
    .get(task.sku, step);
  if (activeForStep) {
    const suppressed = buildDuplicateDispatchSuppression({ task, step, inputVersion, lease: activeForStep, code: 'NOOP_ALREADY_RUNNING' });
    await appendEvent(dataRoot, task, 'DUPLICATE_DISPATCH_SUPPRESSED', suppressed.event_details);
    return { task, duplicate_dispatch_suppressed: true, external_requests: 0 };
  }
  const acquired = acquireListingExecutionLease(dbFor(dataRoot), { skuId: task.sku, step, inputVersion });
  if (!acquired.acquired) {
    const suppressed = buildDuplicateDispatchSuppression({ task, step, inputVersion, lease: acquired.lease, code: acquired.code });
    await appendEvent(dataRoot, task, 'DUPLICATE_DISPATCH_SUPPRESSED', suppressed.event_details);
    return { task, duplicate_dispatch_suppressed: true, external_requests: 0 };
  }
  const { lease } = acquired;
  activateListingExecution(lease.execution_id);
  Object.defineProperty(task, 'active_execution_id', { value: lease.execution_id, configurable: true, enumerable: false });
  const heartbeat = setInterval(() => {
    try { heartbeatListingExecutionLease(dbFor(dataRoot), lease.lease_id); } catch { /* Keep lease active on heartbeat write errors. */ }
  }, 10_000);
  heartbeat.unref?.();
  try {
    const result = await runSop04MultiSeedCompletion(dataRoot, task, options);
    const resultingTask = result?.task || result;
    const terminalState = resultingTask?.qa?.[step]?.status === 'PASS' ? 'PASS'
      : String(resultingTask?.status || 'FAILED');
    finishListingExecutionLease(dbFor(dataRoot), lease.lease_id, terminalState);
    return result;
  } catch (error) {
    finishListingExecutionLease(dbFor(dataRoot), lease.lease_id, 'FAILED');
    throw error;
  } finally {
    clearInterval(heartbeat);
    deactivateListingExecution(lease.execution_id);
    try { delete task.active_execution_id; } catch { /* transient execution metadata cleanup */ }
  }
}

async function executeListingSop09(dataRoot, task) {
  const step = 'LISTING_SOP_09';
  task.outputs ||= {};
  task.qa ||= {};
  task.stages ||= {};
  task.listing_sop ||= { steps: {}, current_step_id: step };
  task.listing_sop.steps ||= {};
  const executor = getListingSopExecutor(step);
  const available = executor?.executor_id === LISTING_COMPETITOR_ANALYSIS_EXECUTOR.executor_id
    && executor?.run === LISTING_COMPETITOR_ANALYSIS_EXECUTOR.run;
  const preflight = evaluateListingExecutionPreflight(task, { dependencyReady: true, executorAvailable: available });
  if (!preflight.ready) {
    task.status = preflight.status;
    task.waiting_dependency_key = preflight.status === 'WAITING_DEPENDENCY' ? (preflight.dependency || null) : null;
    task.resume_point = step;
    task.stage_qa_status = 'NOT_RUN';
    task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
    task.stages[step] = { ...task.stages[step], status: preflight.status, dependency: task.waiting_dependency_key, waiting_reason: preflight.reason, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_09_PREFLIGHT_BLOCKED', { check: preflight.check, dependency: task.waiting_dependency_key, missing_inputs: preflight.missing_inputs || [], external_requests: 0 });
    return task;
  }

  let expectedVersions;
  try {
    expectedVersions = expectedSop09RuntimeVersions(task, dataRoot);
  } catch (error) {
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'SOP09_INPUTS'; task.resume_point = step;
    task.stage_qa_status = 'NOT_RUN'; task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
    task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'SOP09_INPUTS', waiting_reason: error.message, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_09_INPUTS_WAITING', { code: error.code || 'SOP09_INPUT_VERSION_LOCK_MISSING', external_requests: 0 });
    return task;
  }

  task.status = 'RUNNING'; task.current_step = step; task.resume_point = step; task.waiting_dependency_key = null;
  task.stage_qa_status = 'NOT_RUN'; task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
  task.stages[step] = { ...task.stages[step], status: 'RUNNING', executor_id: executor.executor_id, dependency: null, waiting_reason: null, updated_at: iso() };
  task.listing_sop.current_step_id = step;
  await commit(dataRoot, task, 'STEP_EXECUTION_STARTED', { step, executor_id: executor.executor_id, input_versions: expectedVersions, external_requests: 0 });

  let result;
  try {
    result = await runListingCompetitorAnalysisRuntime({ dataRoot, task, expectedVersions, createdAt: iso() });
  } catch (error) {
    if (String(error.code || '').startsWith('SOP09_') && /MISSING|AMBIGUOUS|UNREADABLE|MISMATCH|LOCK/.test(String(error.code))) {
      task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'SOP09_INPUTS'; task.resume_point = step;
      task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'SOP09_INPUTS', waiting_reason: error.message, updated_at: iso() };
      await commit(dataRoot, task, 'LISTING_SOP_09_INPUTS_WAITING', { code: error.code, message: error.message, external_requests: 0 });
      return task;
    }
    task.status = 'ERROR'; task.error_code = error.code || 'SOP09_EXECUTOR_FAILED'; task.error_message = error.message;
    task.stages[step] = { ...task.stages[step], status: 'ERROR', updated_at: iso() };
    task.open_error_count = activeIssueCount(task);
    await commit(dataRoot, task, 'LISTING_SOP_09_EXECUTOR_FAILED', { code: task.error_code, message: error.message, external_requests: 0 });
    return task;
  }

  task.outputs.competitor_analysis = {
    ...result.artifact,
    status: 'DONE_PENDING_QA',
    evidence: {
      version: result.artifact.version,
      artifact_ref: result.artifact_ref,
      qa_ref: result.qa_ref,
      evidence_refs: result.inputs.sourceFileRefs.map(item => item.reference),
      source_references: result.inputs.sourceFileRefs.map(item => ({ source_type: item.source, source_reference: item.reference, source_version: item.version, sha256: item.sha256 })),
    },
  };
  task.status = 'RUNNING'; task.current_step = step; task.resume_point = step;
  task.stages[step] = { ...task.stages[step], status: 'DONE_PENDING_QA', output_version: result.artifact.version, updated_at: iso() };
  task.listing_sop.steps[step] = { ...task.listing_sop.steps[step], status: 'DONE_PENDING_QA', qa_status: 'NOT_RUN', output_version: result.artifact.version, updated_at: iso() };
  await commit(dataRoot, task, 'LISTING_SOP_09_EXECUTOR_DONE_PENDING_QA', { version: result.artifact.version, artifact_ref: result.artifact_ref, qa_status: result.qa.status, evidence_count: result.inputs.sourceFileRefs.length, external_requests: 0 });
  return verifyCurrent(dataRoot, task);
}

async function executeListingSop10To17(dataRoot, task) {
  const step = task.current_step;
  const executorId = SOP10_17_EXECUTOR_IDS[step];
  if (!executorId) return null;
  task.outputs ||= {}; task.qa ||= {}; task.stages ||= {}; task.listing_sop ||= { steps: {} };
  task.listing_sop.steps ||= {}; task.listing_executor ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso());
  task.listing_executor.registry ||= {};
  task.listing_executor.registry[step] ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso()).registry[step];
  const input = await resolveSop10To17Inputs(dataRoot, task, step).catch(error => ({ error }));
  if (input.error) {
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'LISTING_REQUIRED_INPUTS'; task.resume_point = step;
    task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
    task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'LISTING_REQUIRED_INPUTS', waiting_reason: input.error.message, updated_at: iso() };
    applyListingExecutorStep(task, step, { status: 'WAITING_DEPENDENCY', waiting_reason: input.error.message, resume_point: step, qa: { status: 'NOT_RUN' } });
    task.waiting_dependency_key = 'LISTING_REQUIRED_INPUTS';
    await commit(dataRoot, task, 'LISTING_SOP_STEP_PREFLIGHT_BLOCKED', { step, executor_id: executorId, check: 'INPUT_VERSION', reason: input.error.code || 'SOP10_17_INPUTS_NOT_READY', missing_inputs: input.error.missing_inputs || [], external_requests: 0 });
    return task;
  }

  const readiness = await getAiProviderReadiness(dataRoot);
  const stepRoute = await listingAiStepRoutePreflight(dataRoot, task, step, input);
  const primaryReady = stepRoute.ready;
  if (!primaryReady) {
    const statuses = ['Qwen', 'DeepSeek'].filter(name => !stepRoute.providers[name].ready).map(name => stepRoute.providers[name]);
    const reasons = statuses.map(item => item?.reason_code || '').filter(Boolean);
    const dependency = reasons.includes('PROVIDER_ADAPTER_NOT_REGISTERED') ? 'AI_PROVIDER_ADAPTER'
      : reasons.some(code => code.includes('CREDENTIAL') || code.includes('CONFIG')) ? 'AI_PROVIDER_CONFIG'
        : statuses.length ? (!stepRoute.providers.Qwen.ready ? 'QWEN' : 'DEEPSEEK')
          : 'AI_PROVIDER_CONFIG';
    const reason = `Qwen 与 DeepSeek 主流程尚未全部 READY：Qwen=${readiness.QWEN}; DeepSeek=${readiness.DEEPSEEK}.`;
    for (const issue of task.issues || []) {
      if (issue.step === step && issue.code === 'ENGINE_NOT_CONNECTED' && issue.status === 'OPEN') {
        issue.status = 'CLOSED'; issue.close_reason = 'RECLASSIFIED_AS_PROVIDER_DEPENDENCY'; issue.closed_at = iso();
      }
    }
    task.open_error_count = activeIssueCount(task);
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = dependency; task.resume_point = step;
    task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
    task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], executor_id: executorId, input_version_refs: input.input_version_refs, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: reason, resume_point: step };
    task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency, waiting_reason: reason, executor_id: executorId, updated_at: iso() };
    task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: null };
    await commit(dataRoot, task, 'LISTING_AI_PROVIDER_DEPENDENCY_WAITING', { step, executor_id: executorId, dependency, qwen_status: readiness.QWEN, deepseek_status: readiness.DEEPSEEK, gpt_status: readiness.GPT, closed_legacy_engine_issue: reasons.includes('PROVIDER_ADAPTER_NOT_REGISTERED'), external_requests: 0 });
    return task;
  }

  const preflight = evaluateListingExecutionPreflight(task, { dependencyReady: true, executorAvailable: true });
  if (!preflight.ready) {
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = preflight.dependency || 'LISTING_REQUIRED_INPUTS'; task.resume_point = step;
    task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
    task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: task.waiting_dependency_key, waiting_reason: preflight.reason, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_STEP_PREFLIGHT_BLOCKED', { step, executor_id: executorId, check: preflight.check, reason: preflight.reason, external_requests: 0 });
    return task;
  }

  task.status = 'RUNNING'; task.current_step = step; task.resume_point = step; task.waiting_dependency_key = null;
  task.stage_qa_status = 'NOT_RUN'; task.listing_sop.current_step_id = step;
  task.activity_pool = 'Listing 生成池'; task.current_pool = task.activity_pool;
  task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], executor_id: executorId, input_version_refs: input.input_version_refs, status: 'RUNNING', qa_status: 'NOT_RUN', started_at: iso() };
  task.stages[step] = { ...task.stages[step], status: 'RUNNING', executor_id: executorId, dependency: null, waiting_reason: null, updated_at: iso() };
  await commit(dataRoot, task, 'STEP_EXECUTION_STARTED', { step, executor_id: executorId, input_version_refs: input.input_version_refs, external_requests: 'AI_ROUTER_ONLY' });

  let result;
  try { result = await runListingSop10To17Step({ dataRoot, task, step }); }
  catch (error) {
    const errorCode = String(error?.code || 'AI_EXECUTOR_FAILED');
    if (/AI_(?:PROVIDER|PRIMARY_PROVIDER|ROUTER|STRUCTURED_RESPONSE|ADAPTER)/.test(errorCode)) {
      const dependency = errorCode.includes('CONFIG') || errorCode.includes('CREDENTIAL') ? 'AI_PROVIDER_CONFIG' : 'AI_PROVIDER_ADAPTER';
      const reason = `AI执行依赖未完成：${errorCode}`;
      const dependencyFailedAt = iso();
      task.dependency_failed_at = dependencyFailedAt; task.required_readiness_after = dependencyFailedAt;
      task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = dependency; task.resume_point = step;
      task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency, waiting_reason: reason, updated_at: iso() };
      task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: reason, resume_point: step };
      await commit(dataRoot, task, 'LISTING_AI_EXECUTION_WAITING_DEPENDENCY', { step, dependency, dependency_failed_at: dependencyFailedAt, required_readiness_after: dependencyFailedAt, error_code: errorCode, external_requests: 0 });
      return task;
    }
    throw error;
  }

  if (result.status === 'PAUSED' && /^ACCEPTANCE_/.test(result.reason || '')) {
    task.status='PAUSED';task.waiting_dependency_key=null;task.resume_point=step;task.stage_qa_status='NOT_RUN';
    task.error_code=null;task.error_message=null;
    task.stages[step]={...task.stages[step],status:'PAUSED',waiting_reason:result.reason,updated_at:iso()};
    task.listing_executor.registry[step]={...task.listing_executor.registry[step],status:'PAUSED',qa_status:'NOT_RUN',waiting_reason:result.reason,resume_point:step};
    await commit(dataRoot,task,'ACCEPTANCE_EXECUTION_WINDOW_CLOSED',{step,reason:result.reason,external_requests:result.external_requests||0});
    return task;
  }
  if (result.status === 'WAITING_DEPENDENCY' || result.status === 'WAITING_CONFIRMATION') {
    const dependency = result.status === 'WAITING_DEPENDENCY' ? (result.dependency || 'AI_PROVIDER_ADAPTER') : null;
    const dependencyFailedAt = result.status === 'WAITING_DEPENDENCY'
      ? (result.generation_wait?.generation_failed_at || iso()) : null;
    if (dependencyFailedAt) {
      task.dependency_failed_at = dependencyFailedAt;
      task.required_readiness_after = dependencyFailedAt;
    }
    if (result.status === 'WAITING_DEPENDENCY' && result.generation_wait) {
      task.ai_generation_waiting = { ...clone(result.generation_wait), dependency, recorded_at: dependencyFailedAt || iso() };
    }
    task.status = result.status; task.waiting_dependency_key = dependency; task.resume_point = step;
    task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
    task.stages[step] = { ...task.stages[step], status: result.status, dependency, waiting_reason: result.reason || result.reason_code, updated_at: iso() };
    task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], status: result.status, qa_status: 'NOT_RUN', waiting_reason: result.reason || result.reason_code, resume_point: step };
    task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: null };
    await commit(dataRoot, task, 'LISTING_AI_EXECUTION_WAITING', { step, status: result.status, dependency, dependency_failed_at: dependencyFailedAt, required_readiness_after: dependencyFailedAt, generation_wait: result.generation_wait || null, provider_results: result.provider_results?.map(item => ({ provider: item.provider, status: item.status, reason_code: item.reason_code, request_id: item.request_id || null, provider_request_id: item.provider_request_id || item.attempt_metadata?.provider_request_id || null, provider_error_code: item.provider_error_code || item.attempt_metadata?.provider_error_code || null, provider_error_message: item.provider_error_message || item.attempt_metadata?.provider_error_message || null, attempt_metadata: item.attempt_metadata || null })) || [], reason: result.reason || result.reason_code, external_requests: result.external_requests || 0 });
    return task;
  }
  if (result.status === 'QA_FAIL') {
    task.outputs[sop10To17OutputKey(step)] = result.output || null;
    task.status = 'ERROR'; task.error_code = 'LISTING_STAGE_QA_FAIL'; task.error_message = `Stage QA 未通过：${step}`;
    task.qa[step] = { status: 'FAIL', checked_at: iso(), report: result.qa?.failures || [] };
    task.stages[step] = { ...task.stages[step], status: 'QA_FAIL', updated_at: iso() };
    issueFor(task, 'LISTING_STAGE_QA_FAIL', task.error_message, `outputs.${sop10To17OutputKey(step)}`, '该步骤结构、事实、来源和QA均通过', '保留当前产物与失败报告，修复后重新核验。');
    task.open_error_count = activeIssueCount(task);
    await commit(dataRoot, task, 'LISTING_STAGE_QA_FAIL', { step, executor_id: executorId, failures: result.qa?.failures || [], external_requests: 0 });
    return task;
  }

  task.outputs[sop10To17OutputKey(step)] = result.output;
  task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], executor_id: executorId };
  applyListingExecutorStep(task, step, { status: 'DONE_PENDING_QA', output: result.output, input_version_refs: result.input_version_refs, resume_point: step, qa: { status: 'NOT_RUN' } });
  await commit(dataRoot, task, 'LISTING_SOP_EXECUTOR_DONE_PENDING_QA', { step, executor_id: executorId, version: result.version, evidence_refs: result.output.evidence?.evidence_refs || [], external_requests: 0 });
  return verifyCurrent(dataRoot, task);
}

async function dispatchCurrentUnlocked(dataRoot, task) {
  const scope = acceptanceRecoveryControlScope.getStore();
  if (!(manualContinueScopeIsLive(scope) && scope.action === 'continue' && acceptanceMode(dataRoot) && task?.sku === scope.sku)) {
    assertBusinessDispatchEnabled('Listing Executor dispatch');
  }
  const step = task.current_step;
  task.waiting_dependency_key = null;
  if (step === 'LISTING_SOP_09') return executeListingSop09(dataRoot, task);
  if (Object.hasOwn(SOP10_17_EXECUTOR_IDS, step)) return executeListingSop10To17(dataRoot, task);
  if (step === 'LISTING_SOP_08') return executeListingSop08(dataRoot, task);
  if (step === 'LISTING_SOP_05') return executeListingSop05CandidatePool(dataRoot, task);
  if (step === 'LISTING_SOP_07' || (step === 'top20' && !(acceptanceMode(dataRoot) && task.master?.product_facts?.acceptance_fixture === true))) {
    return executeListingSop07Top20(dataRoot, task);
  }
  if (step === 'LISTING_SOP_01') return executeListingSop01(dataRoot, task);
  if (step === 'LISTING_SOP_02') return executeListingSop02(dataRoot, task);
  if (step === 'LISTING_SOP_04' && !(acceptanceMode(dataRoot) && task.master?.product_facts?.acceptance_fixture === true)) return executeListingSop04(dataRoot, task);
  if (step === 'LISTING_SOP_06') {
    const now = iso();
    task.current_step = 'LISTING_SOP_06'; task.resume_point = 'LISTING_SOP_06';
    task.listing_sop.current_step_id = 'LISTING_SOP_06';
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'BOLOO_WEBVIEW2_PANE';
    task.qa.LISTING_SOP_06 = { status: 'NOT_RUN', checked_at: null, report: null };
    task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
    task.stages.LISTING_SOP_06 = { ...task.stages.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_WEBVIEW2_PANE', dependency_status: 'READINESS_CHECK_REQUIRED', updated_at: now };
    task.listing_sop.steps.LISTING_SOP_06 = { ...task.listing_sop.steps.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: '等待通过健康快照确认 Boloo WebView2 Pane / Explorer / Bridge。', updated_at: now };
    await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step, dependency: 'BOLOO_WEBVIEW2_PANE', reason: 'RUNTIME_HEALTH_SNAPSHOT_REQUIRED', business_requests: 0 });
    return task;
  }
  if (step === 'LISTING_SOP_03') {
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'LISTING_SOP_03_EXECUTOR';
    task.listing_sop.current_step_id = 'LISTING_SOP_03'; task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.stages.LISTING_SOP_03 = { ...task.stages.LISTING_SOP_03, status: 'WAITING_DEPENDENCY', dependency: task.waiting_dependency_key, updated_at: iso() };
    await commit(dataRoot, task, 'LISTING_SOP_03_EXECUTOR_WAITING', { step_id: 'LISTING_SOP_03', preserved_last_success_step: task.last_success_step });
    return task;
  }
  if (step === 'product_master') return task;
  const fixture = acceptanceMode(dataRoot) && task.master?.product_facts?.acceptance_fixture === true;
  if (step === 'bol_keywords' && !fixture) {
    const readiness = await bolApiReadiness(dataRoot);
    const override = readinessOverride('BOL_API_READY');
    if (typeof override === 'boolean' ? !override : readiness.status !== 'PASS') {
      const waitingAt = iso();
      task.resume_point = step;
      task.status = 'WAITING_DEPENDENCY';
      task.waiting_dependency_key = 'BOL_API';
      task.activity_pool = '关键词池';
      task.current_pool = task.activity_pool;
      task.stage_qa_status = task.qa?.[step]?.status || 'NOT_RUN';
      const dependencyStatus = readiness.status || 'WAITING_FOR_READINESS_CHECK';
      task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'BOL_API', dependency_status: dependencyStatus, updated_at: waitingAt };
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'WAITING_DEPENDENCY', dependency: 'BOL_API', updated_at: waitingAt };
      task.error_code = null;
      task.error_message = null;
      await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step, dependency: 'BOL_API', dependency_status: dependencyStatus });
      return task;
    }
  }
  if (step === 'boloo_keywords' && !fixture) {
    if (!isOfficialWebBolooReady()) {
      const waitingAt = iso();
      task.resume_point = step;
      task.status = 'WAITING_DEPENDENCY';
      task.waiting_dependency_key = 'BOLOO_PROVIDER';
      task.activity_pool = '关键词池';
      task.current_pool = task.activity_pool;
      task.stage_qa_status = task.qa?.[step]?.status || 'NOT_RUN';
      task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_PROVIDER', dependency_status: 'NOT_READY', updated_at: waitingAt };
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_PROVIDER', updated_at: waitingAt };
      task.error_code = null;
      task.error_message = null;
      await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step, dependency: 'BOLOO_PROVIDER', dependency_status: 'NOT_READY' });
      return task;
    }
    task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null };
    task.boloo.required_subtasks ||= [];
    if (typeof task.boloo.keyword_discovery_closed !== 'boolean') task.boloo.keyword_discovery_closed = false;
    task.boloo.discovery_close_evidence ||= null;
    if (!task.boloo.required_subtasks.length) {
      task.boloo.current_subtask_id = null;
      task.boloo.current_source_id = null;
      task.resume_point = step;
      task.status = 'WAITING_PROVIDER_INPUT';
      task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
      task.stages[step] = { ...task.stages[step], status: 'WAITING_PROVIDER_INPUT', dependency: null, updated_at: iso() };
      task.error_code = null; task.error_message = null;
      await commit(dataRoot, task, 'BOLOO_REQUIRED_SUBTASKS_REQUIRED', { step });
      return task;
    }
    const nextSubtask = task.boloo.required_subtasks.find(subtask => !['PASS', 'PASS_NO_RESULT'].includes(subtask.status));
    task.boloo.current_subtask_id = nextSubtask?.subtask_id || null;
    task.boloo.current_source_id = nextSubtask?.source_id || null;
    if (!nextSubtask) {
      if (task.boloo.keyword_discovery_closed !== true) {
        await waitForBolooDiscovery(dataRoot, task, 'BOLOO_DISCOVERY_WAITING_FOR_MORE_CANDIDATES');
        return task;
      }
      task.outputs ||= {};
      task.outputs.boloo_keywords = { evidence: { source: 'BOLOO_OFFICIAL_WEB', required_subtasks: clone(task.boloo.required_subtasks), discovery_close_evidence: clone(task.boloo.discovery_close_evidence) }, open_error_count: activeIssueCount(task), created_at: iso() };
      await commit(dataRoot, task, 'BOLOO_DISCOVERY_CLOSED_READY_FOR_QA', { step, required_count: task.boloo.required_subtasks.length });
      await verifyCurrent(dataRoot, task);
      return task;
    }
    if (nextSubtask.status === 'PENDING_RECHECK') {
      task.status = 'PENDING_RECHECK';
      task.stages[step] = { ...task.stages[step], status: 'PENDING_RECHECK', updated_at: iso() };
      await commit(dataRoot, task, 'BOLOO_SUBTASK_RECHECK_PENDING', { step, subtask_id: nextSubtask.subtask_id, source_id: nextSubtask.source_id, reason_code: nextSubtask.result?.reason_code || null });
      return task;
    }
    task.resume_point = step;
    task.status = 'RUNNING';
    task.activity_pool = '关键词池';
    task.current_pool = task.activity_pool;
    task.stage_qa_status = task.qa?.[step]?.status || 'NOT_RUN';
    task.stages[step] = { ...task.stages[step], status: 'RUNNING', dependency: null, updated_at: iso() };
    task.sidecars.keywords = { ...task.sidecars.keywords, status: 'RUNNING', updated_at: iso() };
    await commit(dataRoot, task, 'BOLOO_PROVIDER_RESULT_EXPECTED', { step, subtask_id: nextSubtask.subtask_id, source_id: nextSubtask.source_id, provider_source: nextSubtask.provider_source, query_text: nextSubtask.query_text, next_attempt: Number(nextSubtask.attempt_count || 0) + 1 });
    return task;
  }
  if (step === 'top20' && !fixture) {
    const ready = isTop20ExecutorReady();
    task.readiness ||= {};
    task.readiness.TOP20_EXECUTOR_READY = ready;
    if (!ready) {
      const waitingAt = iso();
      task.resume_point = step;
      task.status = 'WAITING_DEPENDENCY';
      task.waiting_dependency_key = 'TOP20_EXECUTOR';
      task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
      task.stages[step] = { ...task.stages[step], status: 'WAITING_DEPENDENCY', dependency: 'TOP20_EXECUTOR', dependency_status: 'NOT_READY', TOP20_EXECUTOR_READY: false, updated_at: waitingAt };
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'WAITING_DEPENDENCY', dependency: 'TOP20_EXECUTOR', updated_at: waitingAt };
      task.error_code = null; task.error_message = null;
      await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step, dependency: 'TOP20_EXECUTOR', TOP20_EXECUTOR_READY: false, preserved_last_success_step: task.last_success_step });
      return task;
    }
    task.stages[step] = { ...task.stages[step], dependency: 'TOP20_EXECUTOR', dependency_status: 'READY', TOP20_EXECUTOR_READY: true, updated_at: iso() };
  }
  const label = STEPS.find(item => item[0] === step)?.[1] || step;
  task.resume_point = step;
  task.status = 'RUNNING';
  task.stage_qa_status = task.qa?.[step]?.status || 'NOT_RUN';
  task.stages[step] = { ...task.stages[step], status: 'RUNNING', updated_at: iso() };
  await commit(dataRoot, task, 'STEP_EXECUTION_STARTED', { step, resume_point: step });

  if (fixture) {
    const facts = task.master.product_facts;
    const released = process.env.BOL_ACCEPTANCE_RELEASE_ALL === '1'
      || (process.env.BOL_ACCEPTANCE_RELEASE_SKUS || '').split(',').map(value => value.trim()).includes(task.sku);
    if (facts.acceptance_hold_step === step && !released) {
      await new Promise(resolve => setTimeout(resolve, Math.min(120000, Math.max(1000, Number(facts.acceptance_hold_ms) || 45000))));
    }
    task.outputs ||= {};
    const evidence = { fixture: true, step, source: 'acceptance-test-only' };
    if (step === 'bol_keywords') {
      const relatedTerms = ['acceptance term one', 'acceptance term two', 'acceptance term three', 'acceptance term four', 'acceptance term five'].map((searchTerm, index) => ({ searchTerm, total: index + 1 }));
      evidence.relatedTerms = relatedTerms;
      evidence.rawResponses = [{ searchTerm: 'acceptance seed', response: { acceptanceFixture: true } }];
    }
    if (step === 'boloo_keywords') {
      const facts = task.master.product_facts || {};
      const checklist = task.boloo?.required_subtasks?.length ? task.boloo.required_subtasks : buildBolooRequiredSubtasks(task.sku, {
        explorer_queries: Array.isArray(facts.boloo_exact_keywords) && facts.boloo_exact_keywords.length ? facts.boloo_exact_keywords : ['acceptance fixture query'],
        extractor_urls: Array.isArray(facts.boloo_competitor_urls) && facts.boloo_competitor_urls.length ? facts.boloo_competitor_urls : ['https://acceptance.invalid/product'],
      });
      task.boloo ||= {};
      task.boloo.candidates ||= [];
      task.boloo.required_subtasks = checklist.map((subtask, index) => {
        const extractor = subtask.provider_source === 'keyword_extractor';
        const status = extractor ? 'PASS_NO_RESULT' : 'PASS';
        const reasonCode = extractor ? 'EXTRACTOR_NO_KEYWORDS' : 'EXPLORER_ZERO_VOLUME';
        const result = {
          status, reason_code: reasonCode, query_text: subtask.query_text,
          result: extractor ? null : { search_volume: 0 },
          evidence: { source: 'acceptance-test-only', page_url: 'https://acceptance.invalid/boloo', observed_at: iso(), matched_query: subtask.query_text, field_name: extractor ? 'Keyword Extractor results' : 'Gemiddeld zoekvolume per maand', displayed_value: extractor ? 'No results' : '0', ...(extractor ? { no_result_confirmed: true } : {}) },
        };
        if (!extractor) for (const origin of subtask.origin_sources || ['LISTING_COMPETITOR_KEYWORD']) addBolooCandidate(task, subtask.query_text, origin, {
          status: 'CONFIRMED_VOLUME', volume: 0,
          volumeEvidence: { source: 'acceptance-test-only', page_url: 'https://acceptance.invalid/boloo', matched_query: subtask.query_text, displayed_value: '0' },
        });
        return { ...subtask, status, attempt_count: extractor ? 2 : 1, retry_count: extractor ? 1 : 0,
          extractor_no_keyword_attempts: extractor ? 2 : 0, request_ids: [`acceptance-${index + 1}-${subtask.source_id}`], history: [clone(result)], result, updated_at: iso() };
      });
      task.boloo.current_subtask_id = null;
      task.boloo.current_source_id = null;
      task.boloo.keyword_discovery_closed = true;
      task.boloo.discovery_close_evidence = {
        acceptance_fixture: true,
        candidate_queue_empty: true,
        discovery_sources: Object.fromEntries(BOLOO_DISCOVERY_SOURCES.map(source => [source, {
          complete: true,
          candidate_count: 0,
          ...(source === 'bol_related_terms' ? { cache_reviewed: true } : {}),
          ...(source === 'other_confirmed_candidate_sources' ? { sources: [] } : {}),
        }])),
        closed_at: iso(),
      };
    }
    task.outputs[step] = { evidence, open_error_count: 0, created_at: iso() };
    await commit(dataRoot, task, 'STAGE_ACCEPTANCE_EXECUTED', { step, fixture: true });
    await verifyCurrent(dataRoot, task);
    return task;
  }

  if (step === 'bol_keywords') {
    try {
      const dutchExtractorTerms = confirmedDutchMarketQueries(task).map(item => item.query);
      if (!dutchExtractorTerms.length) {
        task.resume_point = step;
        task.status = 'WAITING_PROVIDER_INPUT';
        task.waiting_dependency_key = null;
        task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
        task.stages[step] = { ...task.stages[step], status: 'WAITING_PROVIDER_INPUT', dependency: null, reason: 'DUTCH_BOLOO_EXTRACTOR_TERMS_REQUIRED', updated_at: iso() };
        task.sidecars.keywords = { ...task.sidecars.keywords, status: 'WAITING_PROVIDER_INPUT', updated_at: iso() };
        task.error_code = null; task.error_message = null;
        await commit(dataRoot, task, 'BOL_SEARCH_TERMS_WAITING_FOR_DUTCH_EXTRACTOR_TERMS', { step, source_urls_available: (task.master?.competitor_urls || []).filter(row => COMPETITOR_SOURCE_HEADERS.includes(String(row?.source_header || row?.source_field || '').trim()) && isBolProductDetailUrl(row?.exact_url ?? row?.raw_value)).length });
        return task;
      }
      const productMasterForDutchSearch = { ...task.master, confirmed_core_terms: dutchExtractorTerms.slice(0, 3), name: '' };
      const result = await runBolKeywordStage({ client: bolClientFor(dataRoot), productMaster: productMasterForDutchSearch, sku: task.sku });
      task.outputs ||= {};
      task.outputs[step] = {
        evidence: {
          source: result.source,
          queriedAt: result.queriedAt,
          selectionRule: result.selectionRule,
          seeds: result.seeds,
          relatedTerms: result.relatedTerms,
          rawResponses: result.rawResponses,
          cacheProvenance: result.cacheProvenance,
        },
        open_error_count: result.open_error_count,
        created_at: result.queriedAt,
      };
      for (const issue of task.issues.filter(item => item.step === step && item.status === 'OPEN' && /^BOL_/.test(item.code))) {
        issue.status = 'FIXED_PENDING_QA'; issue.fixed_at = iso(); issue.updated_at = iso();
      }
      await commit(dataRoot, task, 'BOL_SEARCH_TERMS_EXECUTED', { step, term_count: result.relatedTerms.length, seed_count: result.seeds.length, source: result.source });
      await verifyCurrent(dataRoot, task);
      return task;
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : 'BOL_EXECUTION_FAILED';
      const reason = error instanceof AdapterError ? error.message : 'BOL Search Terms 执行失败，错误内容已脱敏。';
      if (await waitForProviderDependency(dataRoot, task, {
        step, dependencyKey: 'BOL_API', error, providerMethod: 'BOL_RETAILER_API_V10_SEARCH_TERMS',
        sourceEvidence: clone(task.outputs?.[step]?.evidence || null), location: `outputs.${step}`,
      })) return task;
      issueFor(task, code, reason, `outputs.${step}`, '真实 BOL 原始响应、5–7 个相关原词及 PASS QA', '检查 BOL OAuth/网络或补齐 Product Master 的已确认核心词，然后重新执行并重新核验。');
      task.return_pool = task.activity_pool;
      task.activity_pool = '异常池'; task.status = 'ERROR';
      task.stages[step] = { ...task.stages[step], status: 'QA_FAIL', updated_at: iso() };
      task.qa[step] = { status: 'FAIL', checked_at: iso(), report: [reason] };
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'FAIL', updated_at: iso() };
      task.open_error_count = activeIssueCount(task);
      await commit(dataRoot, task, 'BOL_SEARCH_TERMS_FAILED', { step, code, http_status: error?.status || null });
      return task;
    }
  }

  const detail = [`ENGINE_NOT_CONNECTED`, `步骤“${label}”执行器尚未接入。`, `outputs.${step}`, '真实产物、来源证据和本步骤 QA PASS', '接入该阶段执行器后从此检查点重新执行。'];
  issueFor(task, ...detail);
  task.return_pool = task.activity_pool;
  task.activity_pool = '异常池';
  task.status = 'ERROR';
  task.stages[step] = { ...task.stages[step], status: 'BLOCKED_ENGINE_NOT_CONNECTED', updated_at: iso() };
  task.sidecars.listing = { ...task.sidecars.listing, status: 'WAITING_FOR_ENGINE', updated_at: iso() };
  task.open_error_count = activeIssueCount(task);
  await commit(dataRoot, task, 'STEP_ENGINE_UNAVAILABLE', { step, resume_point: task.resume_point });
  return task;
}

async function dispatchCurrent(dataRoot, task) {
  const scope = acceptanceRecoveryControlScope.getStore();
  if (!(manualContinueScopeIsLive(scope) && scope.action === 'continue' && acceptanceMode(dataRoot) && task?.sku === scope.sku)) {
    assertBusinessDispatchEnabled('Listing Executor dispatch');
  }
  const step = task.current_step;
  if (!/^LISTING_SOP_\d{2}$/.test(String(step || ''))) return dispatchCurrentUnlocked(dataRoot, task);
  if (step === 'LISTING_SOP_05') {
    try {
      const inputs = await loadSop05Inputs(dataRoot, task);
      task.listing_executor ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso());
      task.listing_executor.registry ||= {};
      task.listing_executor.registry[step] ||= createListingExecutorFramework(STEPS.map(([id, label]) => ({ id, label })), iso()).registry[step];
      task.listing_executor.registry[step] = { ...task.listing_executor.registry[step], executor_id: LISTING_SOP05_EXECUTOR_ID,
        required_dependencies: [], input_version_refs: clone(sop05InputVersionRefs(task, inputs)) };
    } catch (error) {
      const code = String(error?.code || 'SOP05_PREFLIGHT_FAILED');
      const detail = String(error?.message || code).replace(/[\r\n\t]+/gu, ' ').slice(0, 400);
      const reason = `SOP05输入证据或版本锁定未通过：${code}；${detail}`;
      task.qa ||= {}; task.stages ||= {};
      task.qa[step] = { status: 'NOT_RUN', checked_at: null, report: [reason] };
      task.status = 'ERROR'; task.waiting_dependency_key = null; task.resume_point = step;
      task.error_code = code; task.error_message = reason; task.stage_qa_status = 'NOT_RUN';
      task.stages[step] = { ...task.stages[step], status: 'ERROR', waiting_reason: reason, updated_at: iso() };
      issueFor(task, code, reason, 'outputs.keyword_candidate_pool.input_versions', '当前SKU的facts/SOP03/SOP04及原始证据精确匹配', '修复实际来源/版本问题；不得猜路径、降级证据或重跑远端步骤。');
      task.open_error_count = activeIssueCount(task);
      await commit(dataRoot, task, 'LISTING_SOP_05_PREFLIGHT_FAILED', { step, executor_id: LISTING_SOP05_EXECUTOR_ID, error_code: code, external_requests: 0 });
      return task;
    }
  }
  const stepRecord = task.listing_executor?.registry?.[step];
  const inputVersion = makeListingExecutionInputVersion(
    stepRecord?.input_version_refs || [], stepRecord?.required_dependencies || [],
  );
  const acquired = acquireListingExecutionLease(dbFor(dataRoot), { skuId: task.sku, step, inputVersion });
  if (!acquired.acquired) {
    const suppressed = buildDuplicateDispatchSuppression({ task, step, inputVersion, lease: acquired.lease, code: acquired.code });
    await appendEvent(dataRoot, task, 'DUPLICATE_DISPATCH_SUPPRESSED', suppressed.event_details);
    return suppressed.task;
  }

  const { lease } = acquired;
  activateListingExecution(lease.execution_id);
  Object.defineProperty(task, 'active_execution_id', { value: lease.execution_id, configurable: true, enumerable: false });
  const heartbeat = setInterval(() => {
    try { heartbeatListingExecutionLease(dbFor(dataRoot), lease.lease_id); } catch { /* Keep the active lease on heartbeat write errors. */ }
  }, 10_000);
  heartbeat.unref?.();
  try {
    const result = await dispatchCurrentUnlocked(dataRoot, task);
    const resultingTask = result?.task || result;
    const status = resultingTask?.qa?.[step]?.status === 'PASS' ? 'PASS' : String(resultingTask?.status || 'FAILED');
    const terminalState = status === 'PASS' ? 'PASS'
      : status === 'WAITING_DEPENDENCY' ? 'WAITING_DEPENDENCY'
        : status === 'WAITING_CONFIRMATION' ? 'WAITING_CONFIRMATION'
          : status === 'WAITING_DECISION' ? 'WAITING_DECISION'
            : status === 'WAITING_PROVIDER_INPUT' ? 'WAITING_PROVIDER_INPUT'
              : status === 'PAUSED' ? 'PAUSED'
                : status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    finishListingExecutionLease(dbFor(dataRoot), lease.lease_id, terminalState);
    return result;
  } catch (error) {
    finishListingExecutionLease(dbFor(dataRoot), lease.lease_id, 'FAILED');
    throw error;
  } finally {
    clearInterval(heartbeat);
    deactivateListingExecution(lease.execution_id);
    try { delete task.active_execution_id; } catch { /* transient execution metadata is best-effort cleanup */ }
  }
}

export async function clearFalseSop08DuplicateWait(dataRoot, sku) {
  assertBusinessDispatchEnabled('SOP08 duplicate-wait repair');
  const task = await readTask(dataRoot, sku);
  if (!task || task.current_step !== 'LISTING_SOP_08' || task.status !== 'WAITING_DECISION'
    || !String(task.listing_executor?.registry?.LISTING_SOP_08?.waiting_reason || '').includes('SOP08_DUPLICATE_EXECUTION_IN_PROGRESS')) {
    throw Object.assign(new Error('当前任务并非由 SOP08 duplicate-execution preflight 误置的 WAITING_DECISION。'), { code: 'SOP08_FALSE_WAIT_NOT_FOUND' });
  }
  const inputRefs = task.listing_executor.registry.LISTING_SOP_08.input_version_refs || [];
  const inputVersion = makeListingExecutionInputVersion(inputRefs, task.listing_executor.registry.LISTING_SOP_08.required_dependencies || []);
  const activeLease = dbFor(dataRoot).prepare(`SELECT lease_id, execution_id, heartbeat_at, owner_worker FROM listing_execution_leases
    WHERE sku_id=? AND step=? AND input_version=? AND state='RUNNING' ORDER BY started_at DESC LIMIT 1`)
    .get(task.sku, 'LISTING_SOP_08', inputVersion);
  if (activeLease) throw Object.assign(new Error('SOP08仍持有活动 execution lease；为避免并发，未修正任务状态。'), { code: 'SOP08_EXECUTION_LEASE_ACTIVE' });

  const events = dbFor(dataRoot).prepare(`SELECT event_id, at, type, details FROM task_events
    WHERE sku=? AND type IN ('STEP_EXECUTION_STARTED','STEP_REMOTE_CALL_FAILED','LISTING_SOP_08_PREFLIGHT_BLOCKED')
    ORDER BY seq ASC`).all(task.sku).map(row => ({ at: row.at, type: row.type, details: JSON.parse(row.details || '{}') }));
  const stepStarts = events.filter(item => item.type === 'STEP_EXECUTION_STARTED' && item.details?.step === 'LISTING_SOP_08');
  const remoteFailures = events.filter(item => item.type === 'STEP_REMOTE_CALL_FAILED' && item.details?.step === 'LISTING_SOP_08');
  const duplicateBlocks = events.filter(item => item.type === 'LISTING_SOP_08_PREFLIGHT_BLOCKED'
    && item.details?.blockers?.some(blocker => blocker.code === 'SOP08_DUPLICATE_EXECUTION_IN_PROGRESS'));
  if (stepStarts.length !== 1 || remoteFailures.length !== 1 || duplicateBlocks.length !== 1) {
    throw Object.assign(new Error('SOP08历史事件不能证明单次失败后仅发生一次重复拦截；未修改任务。'), { code: 'SOP08_DUPLICATE_HISTORY_NOT_UNAMBIGUOUS' });
  }
  const failure = remoteFailures[0];
  const candidate = (task.listing_executor.artifacts.competitor_candidates || [])
    .find(item => item.competitor_id === failure.details.competitor_id);
  if (!candidate || candidate.status !== 'RUNNING') {
    throw Object.assign(new Error('没有找到与该失败请求关联的遗留 RUNNING 候选；未修改任务。'), { code: 'SOP08_STALE_CANDIDATE_NOT_FOUND' });
  }

  const repairedAt = iso();
  candidate.status = 'FAILED';
  candidate.assessment_status = 'INCOMPLETE';
  candidate.request_attempts ||= [];
  if (!candidate.request_attempts.some(item => item.error_code === failure.details.error_code && item.reconstructed_from_event_id === failure.event_id)) {
    candidate.request_attempts.push({
      request_id: failure.details.request_id || null,
      reconstructed_from_event_id: failure.event_id,
      endpoint: failure.details.endpoint || null,
      exact_query: candidate.discovery_query || null,
      request_parameters: failure.details.request_parameters || null,
      started_at: candidate.attempted_at || stepStarts[0].at,
      finished_at: failure.at,
      status: 'FAILED',
      error_code: failure.details.error_code || null,
      http_status: failure.details.http_status ?? null,
      response_received: failure.details.response_received ?? (failure.details.error_code === 'BOL_API_HTTP_ERROR'),
      raw_error_body_available: failure.details.raw_error_body_available === true,
      evidence_completeness: 'INCOMPLETE_LEGACY_EVENT',
    });
  }
  task.current_step = 'LISTING_SOP_08';
  task.resume_point = 'LISTING_SOP_08';
  task.listing_sop.current_step_id = 'LISTING_SOP_08';
  task.last_success_step = 'LISTING_SOP_07';
  task.status = 'PAUSED';
  task.waiting_dependency_key = null;
  task.error_code = null;
  task.error_message = null;
  task.stage_qa_status = 'NOT_RUN';
  task.qa.LISTING_SOP_08 = { status: 'NOT_RUN', checked_at: null, report: null };
  task.stages.LISTING_SOP_08 = { ...task.stages.LISTING_SOP_08, status: 'PAUSED', dependency: null, waiting_reason: null, updated_at: repairedAt };
  task.listing_sop.steps.LISTING_SOP_08 = { ...task.listing_sop.steps.LISTING_SOP_08, status: 'PAUSED', qa_status: 'NOT_RUN', waiting_reason: null, updated_at: repairedAt };
  task.listing_executor.registry.LISTING_SOP_08 = { ...task.listing_executor.registry.LISTING_SOP_08, status: 'PAUSED', qa_status: 'NOT_RUN', waiting_reason: null, updated_at: repairedAt };
  for (const item of task.listing_executor.waiting_items || []) {
    if (!item.decided_at && item.originating_sop_step === 'LISTING_SOP_08'
      && `${item.reason || ''} ${item.decision_code || ''}`.includes('SOP08_DUPLICATE_EXECUTION_IN_PROGRESS')) {
      item.status = 'CLOSED'; item.decided_at = repairedAt; item.decision = 'CLEARED_FALSE_EXECUTOR_DUPLICATE_WAIT';
    }
  }
  task.open_error_count = activeIssueCount(task);
  task.activity_pool = 'Listing 生成池';
  task.current_pool = task.activity_pool;
  await commit(dataRoot, task, 'SOP08_DUPLICATE_WAIT_CLEARED_NO_RETRY', {
    step: 'LISTING_SOP_08', previous_status: 'WAITING_DECISION', new_status: 'PAUSED',
    preserved_step: true, resume_point: 'LISTING_SOP_08', qa_status: 'NOT_RUN',
    original_remote_failure_event_id: failure.event_id, duplicate_preflight_event_id: duplicateBlocks[0].event_id,
    no_active_lease: true, product_list_retried: false,
  });
  return task;
}

export async function initialize(dataRoot) {
  if (!TASK_AUTO_MUTATION_ENABLED) return {
    initialized: false, read_only: true, runtime_mode: RUNTIME_MODE,
    ...(ACCEPTANCE_HOLD ? { acceptance_hold: true } : {}),
  };
  const normalizedRoot = path.resolve(dataRoot);
  if (initializedRoots.has(normalizedRoot)) return;
  if (initializingRoots.has(normalizedRoot)) return initializingRoots.get(normalizedRoot);
  const pending = initializeRoot(dataRoot, normalizedRoot);
  initializingRoots.set(normalizedRoot, pending);
  try { return await pending; }
  finally { initializingRoots.delete(normalizedRoot); }
}

async function initializeRoot(dataRoot, normalizedRoot) {
  for (const directory of ['products', 'versions', 'events', 'uploads']) await fs.mkdir(path.join(dataRoot, directory), { recursive: true });
  const db = dbFor(dataRoot);
  const entries = await fs.readdir(path.join(dataRoot, 'products')).catch(() => []);
  for (const filename of entries.filter(name => name.endsWith('.json'))) {
    const file = path.join(dataRoot, 'products', filename);
    try {
      const task = JSON.parse(await fs.readFile(file, 'utf8'));
      const existing = db.prepare('SELECT sku FROM products WHERE sku=?').get(task.sku);
      if (!existing && task.sku && task.id) {
        task.current_pool ||= task.activity_pool || '待处理池';
        task.qa ||= {};
        task.issues ||= [];
        task.current_step ||= STEPS[0][0];
        task.resume_point ||= task.current_step;
        syncTaskContract(task);
        db.prepare(`INSERT INTO products (sku, revision, activity_pool, status, updated_at, current_step, stage_qa_status, error_code, error_message, resume_point, last_success_step, retry_count, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(task.sku, Number(task.revision || 0), task.activity_pool || '待处理池', task.status || 'QUEUED', task.updated_at || iso(), task.current_step,
            task.stage_qa_status, task.error_code, task.error_message, task.resume_point, task.last_success_step || null, Number(task.retry_count || 0), JSON.stringify(task));
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  const all = db.prepare('SELECT payload FROM products').all();
  for (const row of all) {
    const task = JSON.parse(row.payload);
    const before = JSON.stringify(task);
    task.issues ||= [];
    task.qa ||= {};
    task.current_step ||= STEPS[0][0];
    task.resume_point ||= task.current_step;
    task.retry_count ||= 0;
    task.stages ||= {};
    task.status ||= 'QUEUED';
    task.activity_pool ||= '待处理池';
    syncTaskContract(task);
    if (before !== JSON.stringify(task)) await commit(dataRoot, task, 'TASK_STATE_SCHEMA_MIGRATED', { fields: ['current_pool', 'stage_qa_status', 'error_code', 'error_message'] });
  }
  const running = db.prepare("SELECT payload FROM products WHERE status='RUNNING'").all();
  for (const row of running) {
    const task = JSON.parse(row.payload);
    task.status = 'PAUSED'; task.resume_point ||= task.current_step; task.updated_at = iso();
    task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'PAUSED', updated_at: task.updated_at };
    await commit(dataRoot, task, 'SERVER_RESTART_RECOVERED', { resume_point: task.resume_point });
  }
  initializedRoots.add(normalizedRoot);
}

export function closeDatabase() {
  database?.close();
  database = null;
  databaseRoot = '';
  initializedRoots.clear();
  bolRetailerClient?.cache.close();
  bolRetailerClient = null;
  bolRetailerClientRoot = '';
}

export async function listTasks(dataRoot) {
  if (!TASK_AUTO_MUTATION_ENABLED) {
    const entries = await fs.readdir(path.join(dataRoot, 'products')).catch(() => []);
    const tasks = [];
    for (const filename of entries.filter(name => name.endsWith('.json'))) {
      try { tasks.push(JSON.parse(await fs.readFile(path.join(dataRoot, 'products', filename), 'utf8'))); }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    }
    return tasks
      .filter(task => task.provider_child_task?.hidden_from_product_dashboard !== true)
      .filter(task => acceptanceMode(dataRoot) || task.master?.product_facts?.acceptance_fixture !== true)
      .sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''));
  }
  await initialize(dataRoot);
  return dbFor(dataRoot).prepare('SELECT payload FROM products ORDER BY updated_at DESC').all()
    .map(row => JSON.parse(row.payload))
    .filter(task => task.provider_child_task?.hidden_from_product_dashboard !== true)
    .filter(task => acceptanceMode(dataRoot) || task.master?.product_facts?.acceptance_fixture !== true);
}

export async function resumeReadyDependencies(dataRoot, { onlySku = null, expectedRevision = null } = {}) {
  if (onlySku !== null && (!acceptanceMode(dataRoot) || typeof onlySku !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(onlySku))) {
    throw Object.assign(new Error('Exact-SKU dependency resume is restricted to a valid acceptance SKU.'), { code: 'SCOPED_DEPENDENCY_RESUME_REJECTED' });
  }
  if (expectedRevision !== null && (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 0)) {
    throw Object.assign(new Error('Expected revision must be a non-negative integer.'), { code: 'TASK_REVISION_CAS_INVALID' });
  }
  const activeScope = acceptanceRecoveryControlScope.getStore();
  const explicitPaneResume = manualContinueScopeIsLive(activeScope)
    && activeScope.action === 'sop06-pane-resume'
    && activeScope.sku === onlySku
    && acceptanceMode(dataRoot)
    && expectedRevision !== null;
  if (!TASK_AUTO_MUTATION_ENABLED && !explicitPaneResume) return {
    resumed: 0, observed_only: true, runtime_mode: RUNTIME_MODE,
    ...(ACCEPTANCE_HOLD ? { acceptance_hold: true } : {}),
    dependency_resume_enabled: false, business_dispatch_enabled: false,
  };
  const readiness = await bolApiReadiness(dataRoot);
  const aiReadiness = await getAiProviderReadiness(dataRoot);
  const bolOverride = readinessOverride('BOL_API_READY');
  const bolReady = typeof bolOverride === 'boolean' ? bolOverride : readiness.status === 'PASS';
  const bolooReady = isOfficialWebBolooReady();
  const paneReadiness = await readFreshBolooPaneRuntimeReadiness();
  const sop06Bridge = await import('./listing_sop06_boloo_bridge.mjs');
  const cacheOnlySop06Skus = new Set();
  for (const waitingTask of (await listTasks(dataRoot)).filter(item => (!onlySku || item.sku === onlySku) && item.current_step === 'LISTING_SOP_06'
    && item.status === 'WAITING_DEPENDENCY' && item.waiting_dependency_key === 'BOLOO_WEBVIEW2_PANE')) {
    try {
      const lookup = await sop06Bridge.inspectSop06KeywordLibrary(dataRoot, waitingTask.sku);
      if (lookup.eligible && lookup.all_cached) cacheOnlySop06Skus.add(waitingTask.sku);
    } catch { /* An invalid or stale candidate is not resumable. */ }
  }
  const top20Ready = isTop20ExecutorReady();
  const competitorReady = isListingCompetitorExecutorReady();
  const competitorAnalysisReady = getListingSopExecutor('LISTING_SOP_09')?.executor_id === LISTING_COMPETITOR_ANALYSIS_EXECUTOR.executor_id;
  const qwenReady = aiReadiness.providers?.QWEN?.ready === true;
  const deepSeekReady = aiReadiness.providers?.DEEPSEEK?.ready === true;
  if (!bolReady && !bolooReady && paneReadiness.status !== 'READY' && cacheOnlySop06Skus.size === 0 && !top20Ready && !competitorReady && !competitorAnalysisReady && !qwenReady && !deepSeekReady) return { resumed: 0, readiness, ai_readiness: aiReadiness, boloo_ready: bolooReady, pane_readiness: paneReadiness, BOLOO_OFFICIAL_WEB_READY: false, TOP20_EXECUTOR_READY: false };
  const waitingDependencyKey = task => {
    const expected = listingExecutionDependencyForTask(task);
    const explicit = task?.waiting_dependency_key;
    if (Object.hasOwn(SOP10_17_EXECUTOR_IDS, task?.current_step) && ['QWEN', 'DEEPSEEK'].includes(explicit)) return explicit;
    if (task?.current_step === 'LISTING_SOP_09' && explicit === 'LISTING_COMPETITOR_ANALYSIS_EXECUTOR') return explicit;
    // Migrate the already-persisted internal S08 executor wait from the prior
    // registration state. This exact legacy key is accepted only for SOP08.
    if (task?.current_step === 'LISTING_SOP_08' && explicit === 'LISTING_COMPETITOR_EXECUTOR') return explicit;
    if (!expected) return null;
    return typeof explicit === 'string' && explicit === expected ? explicit : null;
  };
  const readyByDependency = { BOL_API: bolReady, BOLOO_PROVIDER: bolooReady,
    BOLOO_WEBVIEW2_PANE: paneReadiness.status === 'READY' && bolooReady,
    TOP20_EXECUTOR: top20Ready, LISTING_COMPETITOR_EXECUTOR: competitorReady, LISTING_COMPETITOR_ANALYSIS_EXECUTOR: competitorAnalysisReady, QWEN: qwenReady, DEEPSEEK: deepSeekReady };
  let resumed = 0;
  const waiting = (await listTasks(dataRoot))
    .filter(task => task.status === 'WAITING_DEPENDENCY' && (!onlySku || task.sku === onlySku))
    .map(task => ({ id: task.id, sku: task.sku, task, dependency_key: waitingDependencyKey(task) }))
    .filter(candidate => {
      if (!candidate.dependency_key) return false;
      if (candidate.dependency_key === 'BOLOO_WEBVIEW2_PANE') {
        const cacheOnly = cacheOnlySop06Skus.has(candidate.sku);
        return cacheOnly || (readyByDependency.BOLOO_WEBVIEW2_PANE === true
          && evaluateSop06PaneRecoveryReadiness({ task: candidate.task, paneReadiness, officialWebReady: bolooReady }).allowed);
      }
      return readyByDependency[candidate.dependency_key] === true;
    });
  for (const candidate of waiting) {
    if (candidate.dependency_key === 'BOLOO_WEBVIEW2_PANE') {
      const task = await getTask(dataRoot, candidate.id);
      if (!task || task.status !== 'WAITING_DEPENDENCY' || task.current_step !== 'LISTING_SOP_06'
        || task.waiting_dependency_key !== 'BOLOO_WEBVIEW2_PANE'
        || (expectedRevision !== null && Number(task.revision) !== Number(expectedRevision))) continue;
      const cacheOnly = cacheOnlySop06Skus.has(task.sku);
      const paneRecoveryGate = evaluateSop06PaneRecoveryReadiness({ task, paneReadiness, officialWebReady: bolooReady, cacheOnly });
      if (!cacheOnly && !paneRecoveryGate.allowed) continue;
      const registry = task.listing_executor?.registry?.LISTING_SOP_06;
      const inputVersion = makeListingExecutionInputVersion(registry?.input_version_refs || [], registry?.required_dependencies || []);
      const acquired = acquireListingExecutionLease(dbFor(dataRoot), { skuId: task.sku, step: 'LISTING_SOP_06', inputVersion });
      if (!acquired.acquired) {
        await appendEvent(dataRoot, task, 'DUPLICATE_DISPATCH_SUPPRESSED', buildDuplicateDispatchSuppression({ task, step: 'LISTING_SOP_06', inputVersion, lease: acquired.lease, code: acquired.code }).event_details);
        continue;
      }
      activateListingExecution(acquired.lease.execution_id);
      await appendEvent(dataRoot, task, 'DEPENDENCY_BECAME_READY', {
        step: 'LISTING_SOP_06', dependency: 'BOLOO_WEBVIEW2_PANE', exact_key_match: true,
        pane_recovery_gate: paneRecoveryGate, cache_only: cacheOnly, external_readiness_probe: false,
      });
      const heartbeat = setInterval(() => { try { heartbeatListingExecutionLease(dbFor(dataRoot), acquired.lease.lease_id); } catch { /* Keep lease visible on heartbeat write failure. */ } }, 10_000);
      heartbeat.unref?.();
      try {
        const result = await sop06Bridge.runSop06BolooKeywordExplorer(dataRoot, task.sku, {
          runtimeReadiness: cacheOnly ? null : paneReadiness,
          bridgeDir: path.join(dataRoot, 'integrations', 'sop03-boloo', 'bridge'),
        });
        const finalTask = result?.task || await getTask(dataRoot, task.sku);
        const terminal = finalTask?.qa?.LISTING_SOP_06?.status === 'PASS' ? 'PASS'
          : finalTask?.status === 'WAITING_DEPENDENCY' ? 'WAITING_DEPENDENCY'
            : finalTask?.status === 'PAUSED' ? 'PAUSED' : 'FAILED';
        finishListingExecutionLease(dbFor(dataRoot), acquired.lease.lease_id, terminal);
        resumed += 1;
      } catch (error) {
        const finalTask = await getTask(dataRoot, task.sku);
        finishListingExecutionLease(dbFor(dataRoot), acquired.lease.lease_id,
          error?.code?.startsWith('WAITING_DEPENDENCY') || finalTask?.status === 'WAITING_DEPENDENCY' ? 'WAITING_DEPENDENCY' : 'FAILED');
      } finally { clearInterval(heartbeat); deactivateListingExecution(acquired.lease.execution_id); }
      continue;
    }
    if (candidate.dependency_key === 'BOL_API') {
      const candidateTask = await getTask(dataRoot, candidate.id);
      const multiSeed = candidateTask?.sop04_multi_seed_completion;
      if (candidateTask?.current_step === 'LISTING_SOP_04'
        && multiSeed?.status === 'WAITING_DEPENDENCY'
        && multiSeed?.decision_artifact_ref
        && Array.isArray(multiSeed?.seed_plan)) {
        await serialize(candidate.id, async () => {
          const task = await readTask(dataRoot, candidate.id);
          const checkpoint = task?.sop04_multi_seed_completion;
          if (!task || task.status !== 'WAITING_DEPENDENCY' || task.current_step !== 'LISTING_SOP_04'
            || task.resume_point !== 'LISTING_SOP_04' || task.waiting_dependency_key !== 'BOL_API'
            || checkpoint?.status !== 'WAITING_DEPENDENCY' || checkpoint.active_seed_exact_string
            || !Array.isArray(checkpoint.initial_adopted_terms) || !Array.isArray(checkpoint.initial_classifications)
            || !Array.isArray(checkpoint.seed_plan) || !checkpoint.primary_query_artifact_ref
            || !readinessIsAfterDependencyFailure(readiness, task)) return;
          const unresolvedDecision = (task.listing_executor?.waiting_items || []).some(item => !item.decided_at
            && ['WAITING_DECISION', 'WAITING_CONFIRMATION'].includes(item.type)
            && item.originating_sop_step === 'LISTING_SOP_04');
          const runningAttempt = (task.sop04_supplemental_queries || []).some(item => item.status === 'RUNNING')
            || (task.provider_attempts || []).some(item => item.step === 'LISTING_SOP_04' && item.status === 'RUNNING');
          if (unresolvedDecision || runningAttempt) return;
          const db = dbFor(dataRoot);
          const activeLease = Number(db.prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND step='LISTING_SOP_04' AND state='RUNNING'").get(task.sku)?.n || 0);
          if (activeLease) return;
          const primaryRef = task.outputs?.bol_keywords?.evidence?.artifact_ref;
          if (primaryRef !== checkpoint.primary_query_artifact_ref
            || task.outputs?.bol_keywords?.seed_exact_string !== checkpoint.primary_seed_exact_string) return;
          const primaryArtifact = JSON.parse(await fs.readFile(safeMaterialPath(dataRoot, primaryRef), 'utf8'));
          if (primaryArtifact.version !== checkpoint.primary_query_artifact_version
            || primaryArtifact.sku !== task.sku
            || primaryArtifact.seed_exact_string !== checkpoint.primary_seed_exact_string) return;
          const recoveryBarrier = { dependency_failed_at: task.dependency_failed_at || null,
            required_readiness_after: task.required_readiness_after || null,
            readiness_checked_at: readiness.checked_at || null };
          task.status = 'QUEUED'; task.waiting_dependency_key = null;
          task.dependency_failed_at = null; task.required_readiness_after = null;
          task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'QUEUED', dependency: null, updated_at: iso() };
          await commit(dataRoot, task, 'DEPENDENCY_BECAME_READY', {
            step: 'LISTING_SOP_04', dependency: 'BOL_API', recovery_barrier: recoveryBarrier,
            resumed_phase: 'SOP04_MULTI_SEED_COMPLETION', seed_cursor: checkpoint.next_seed_index,
            first_seed_reused: true, executor_dispatched: false,
          });
          await runSop04MultiSeedCompletionWithLease(dataRoot, task, {
            primaryArtifact, primaryArtifactRef: primaryRef,
            initialAdoptedTerms: checkpoint.initial_adopted_terms,
            initialClassifications: checkpoint.initial_classifications,
            seedPlan: checkpoint.seed_plan,
            preferredExactStrings: checkpoint.seed_plan.map(item => item.exact_string),
          });
          resumed += 1;
        });
        continue;
      }
    }
    await serialize(candidate.id, async () => {
      const task = await readTask(dataRoot, candidate.id);
      if (!task || task.status !== 'WAITING_DEPENDENCY' || waitingDependencyKey(task) !== candidate.dependency_key) return;
      if (readyByDependency[candidate.dependency_key] !== true) return;
      if (candidate.dependency_key === 'BOL_API' && !readinessIsAfterDependencyFailure(readiness, task)) return;
      let aiRecoveryBarrier = null;
      if (['QWEN', 'DEEPSEEK'].includes(candidate.dependency_key)) {
        const provider = candidate.dependency_key === 'QWEN' ? aiReadiness.providers?.QWEN : aiReadiness.providers?.DEEPSEEK;
        const failedAt = task.dependency_failed_at || task.stages?.[task.current_step]?.updated_at || task.updated_at;
        if (!task.required_readiness_after) {
          task.dependency_failed_at = failedAt;
          task.required_readiness_after = failedAt;
          await commit(dataRoot, task, 'AI_DEPENDENCY_RECOVERY_BARRIER_MIGRATED', {
            step: task.current_step, dependency: candidate.dependency_key,
            dependency_failed_at: failedAt, required_readiness_after: failedAt,
            readiness_checked_at: provider?.checked_at || null,
          });
        }
        if (task.ai_generation_waiting?.generation_key) {
          const gate = await evaluateGenerationRecoveryGate(dataRoot, task.ai_generation_waiting);
          // A second full timeout opens the circuit. Even a passing synthetic probe
          // cannot auto-dispatch that key; only an explicit, controlled continue can.
          if (!gate.allowed || gate.circuit_state === 'OPEN') return;
          const consumed = await consumeGenerationRecoveryGate(dataRoot, task.ai_generation_waiting);
          if (!consumed.allowed) return;
          aiRecoveryBarrier = { generation_probe_id: consumed.probe_id, circuit_state: consumed.circuit_state,
            generation_failed_at: task.ai_generation_waiting.generation_failed_at, required_generation_readiness_after: task.ai_generation_waiting.required_generation_readiness_after,
            wait_context: clone(task.ai_generation_waiting) };
        } else {
          const legacyWaitReason = [task.stages?.[task.current_step]?.waiting_reason, task.listing_executor?.registry?.[task.current_step]?.waiting_reason]
            .filter(Boolean).join(' ');
          const legacyGenerationFailure = /PROVIDER_TIMEOUT|EMPTY_CONTENT|TRUNCAT|JSON_INVALID|JSON_PARSE|SCHEMA_INVALID|ECONNRESET|NETWORK_ERROR|NETWORK_TIMEOUT|TRANSPORT_FAILURE/i.test(legacyWaitReason);
          // A legacy generation failure without its exact recovery context must fail closed.
          // Control-plane READY is never sufficient to redispatch a business generation.
          if (Object.hasOwn(SOP10_17_EXECUTOR_IDS, task.current_step) && legacyGenerationFailure) return;
          const checkedAt = Date.parse(String(provider?.checked_at || ''));
          const requiredAfter = Date.parse(String(task.required_readiness_after || ''));
          if (provider?.ready !== true || !Number.isFinite(checkedAt) || !Number.isFinite(requiredAfter) || checkedAt <= requiredAfter) return;
        }
        if (!aiRecoveryBarrier) aiRecoveryBarrier = {
          dependency_failed_at: task.dependency_failed_at || failedAt,
          required_readiness_after: task.required_readiness_after,
          readiness_checked_at: provider?.checked_at || null,
          provider: candidate.dependency_key,
        };
      }
      const preflight = evaluateListingExecutionPreflight(task, {
        dependencyReady: true,
        executorAvailable: Object.hasOwn(SOP10_17_EXECUTOR_IDS, task.current_step) || task.current_step === 'LISTING_SOP_04' || task.current_step === 'LISTING_SOP_08' || task.current_step === 'LISTING_SOP_09' || ['bol_keywords', 'boloo_keywords', 'top20', 'LISTING_SOP_07'].includes(task.current_step),
      });
      if (!preflight.ready) {
        task.status = preflight.status;
        task.waiting_dependency_key = preflight.status === 'WAITING_DEPENDENCY' ? preflight.dependency : null;
        task.error_code = null; task.error_message = null;
        task.resume_point = task.current_step;
        if (preflight.status === 'WAITING_CONFIRMATION' || preflight.status === 'WAITING_DECISION') {
          task.activity_pool = '待人工确认'; task.current_pool = task.activity_pool;
        }
        task.stages[task.current_step] = { ...task.stages[task.current_step], status: preflight.status, dependency: task.waiting_dependency_key, waiting_reason: preflight.reason, updated_at: iso() };
        await commit(dataRoot, task, 'DEPENDENCY_PREFLIGHT_BLOCKED', {
          step: task.current_step, dependency: candidate.dependency_key, preflight_check: preflight.check,
          preflight_status: preflight.status, reason: preflight.reason, external_requests: 0,
          execution_started: false,
        });
        return;
      }
      task.waiting_dependency_key = null;
      const recoveryBarrier = candidate.dependency_key === 'BOL_API' ? {
        dependency_failed_at: task.dependency_failed_at || null,
        required_readiness_after: task.required_readiness_after || null,
        readiness_checked_at: readiness.checked_at || null,
      } : null;
      if (candidate.dependency_key === 'BOL_API') {
        task.dependency_failed_at = null;
        task.required_readiness_after = null;
      }
      if (aiRecoveryBarrier) {
        task.generation_recovery = {
          probe_id: aiRecoveryBarrier.generation_probe_id,
          circuit_state: aiRecoveryBarrier.circuit_state,
          consumed_at: iso(),
          wait_context: aiRecoveryBarrier.wait_context,
        };
        task.dependency_failed_at = null;
        task.required_readiness_after = null;
        task.ai_generation_waiting = null;
      }
      task.status = 'QUEUED';
      task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'QUEUED', updated_at: iso() };
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'QUEUED', updated_at: iso() };
      const dependency = candidate.dependency_key;
      task.readiness ||= {};
      if (task.current_step === 'top20' || task.current_step === 'LISTING_SOP_07') task.readiness.TOP20_EXECUTOR_READY = true;
      await commit(dataRoot, task, 'DEPENDENCY_BECAME_READY', { step: task.current_step, dependency, recovery_barrier: recoveryBarrier || aiRecoveryBarrier, TOP20_EXECUTOR_READY: ['top20', 'LISTING_SOP_07'].includes(task.current_step) ? true : undefined });
      await dispatchCurrent(dataRoot, task);
      resumed += 1;
    });
  }
  return { resumed, readiness, ai_readiness: aiReadiness, boloo_ready: bolooReady, pane_readiness: paneReadiness,
    ...(onlySku ? { scoped_sku: onlySku, expected_revision: Number(expectedRevision) } : {}),
    keyword_library_cache_only_sku_count: cacheOnlySop06Skus.size, BOLOO_OFFICIAL_WEB_READY: bolooReady,
    TOP20_EXECUTOR_READY: top20Ready, LISTING_COMPETITOR_EXECUTOR_READY: competitorReady,
    LISTING_COMPETITOR_ANALYSIS_EXECUTOR_READY: competitorAnalysisReady };
}

export async function importProducts(dataRoot, rows) {
  assertBusinessDispatchEnabled('Product import');
  await initialize(dataRoot);
  if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('请导入至少一个产品。'), { code: 'IMPORT_EMPTY' });
  const results = [];
  const imports = await Promise.all(rows.map(async raw => {
    const sku = cleanText(raw?.sku);
    try {
      if (!acceptanceMode(dataRoot) && raw?.product_facts?.acceptance_fixture === true) {
        throw Object.assign(new Error('验收夹具只能导入隔离验收数据根，不能进入正式 SKU 列表。'), { code: 'ACCEPTANCE_FIXTURE_PRODUCTION_IMPORT_FORBIDDEN' });
      }
      const id = productId(sku);
      const result = await serialize(id, async () => {
        const storedRow = dbFor(dataRoot).prepare('SELECT 1 AS found FROM products WHERE sku=?').get(id);
        if (storedRow || await readTask(dataRoot, id)) throw Object.assign(new Error(`SKU ${id} 已存在；不会覆盖历史任务。`), { code: 'SKU_ALREADY_EXISTS' });
        const task = taskTemplate(raw || {}, id);
        await commit(dataRoot, task, 'PRODUCT_IMPORTED', { source_count: task.master.source_refs.length });
        const executed = await dispatchCurrent(dataRoot, task);
        return executed;
      });
      return { sku: id, ok: true, task: result };
    } catch (error) { return { sku: sku || '(空 SKU)', ok: false, error: { code: error.code || 'IMPORT_FAILED', message: error.message } }; }
  }));
  results.push(...imports);
  return { accepted: results.filter(item => item.ok).length, rejected: results.filter(item => !item.ok).length, results };
}

function excelInputBusinessValue(input) {
  return input?.excel_source_import?.raw_values || {
    产品ID: input.product_id || null, 产品sku: input.sku || null, 产品EAN: input.ean || null, 中文名称: input.name || null,
    品牌名: input.brand_name || null, 产品事实: input.product_facts || {}, 竞品URL: input.competitor_urls || [],
  };
}

function applyExcelInputToMaster(task, input, importedAt, changedCanonicalFields = null) {
  const master = task.master;
  const shouldApply = field => !changedCanonicalFields || changedCanonicalFields.has(field);
  if (shouldApply('product_id')) master.source_product_id = input.product_id || master.source_product_id || null;
  for (const field of ['ean', 'name']) if (shouldApply(field) && input[field] != null && String(input[field]).trim() !== '') master[field] = cleanText(input[field]);
  if (shouldApply('brand_name')) {
    const brandName = cleanText(input.brand_name);
    master.brand_name = brandName;
    master.brand = brandName; // Read compatibility alias; brand_name is the canonical field.
  }
  if (shouldApply('owned_product_source')) master.source_refs = Array.isArray(input.source_refs) ? input.source_refs.map(cleanText).filter(Boolean) : [];
  master.product_facts ||= {};
  for (const [field, value] of Object.entries(input.product_facts || {})) {
    if (field === 'extra_source_fields') {
      if (!changedCanonicalFields) master.product_facts.extra_source_fields = clone(value || {});
      else {
        master.product_facts.extra_source_fields ||= {};
        for (const [extraField, extraValue] of Object.entries(value || {})) if (shouldApply(extraField)) master.product_facts.extra_source_fields[extraField] = clone(extraValue);
      }
      continue;
    }
    const sourceField = field === 'owned_product_source_content' ? 'owned_product_source' : field === 'amazon_reference' ? 'amazon_reference' : field;
    if (shouldApply(sourceField) && value != null && value !== '' && field !== 'owned_product_source_content' && field !== 'amazon_reference') master.product_facts[field] = clone(value);
  }
  if (shouldApply('owned_product_source')) master.product_facts.owned_product_source_content = clone(input.product_facts?.owned_product_source_content || { raw_value: null, content_type: 'MISSING' });
  if (shouldApply('amazon_reference')) master.product_facts.amazon_reference = input.product_facts?.amazon_reference || null;
  const competitorFields = ['bol_direct_competitor', 'bol_similar_competitor_1', 'bol_similar_competitor_2', 'bol_similar_competitor_3', 'bol_similar_competitor_4'];
  if (!changedCanonicalFields || competitorFields.some(shouldApply)) {
    master.competitor_urls = clone(input.competitor_urls || []);
    master.competitor_url_completion = clone(input.competitor_url_completion || null);
    const autoConfirmed = (task.competitor_url_list || []).filter(item => item.origin === 'AUTO_DISCOVERY' || item.source === 'BOL_API_PRODUCT_LIST');
    const importedUrls = master.competitor_urls.filter(item => isValidBolProductUrl(item?.exact_url ?? item?.raw_value)).map(item => ({
      source_id: `EXCEL_${item.source_cell || item.source_header || crypto.randomUUID()}`, exact_url: String(item.exact_url ?? item.raw_value).trim(), raw_url: String(item.exact_url ?? item.raw_value),
      source_header: item.source_header || null, source_cell: item.source_cell || null, import_version: item.import_version || null,
      source: 'LEON_EXCEL', origin: 'USER_INPUT', confirmed_by: 'Leon', usable_for_boloo_extractor: true,
    }));
    task.competitor_url_list = [...autoConfirmed, ...importedUrls.filter(item => !autoConfirmed.some(existing => existing.exact_url === item.exact_url))];
  }
  master.excel_source_import = clone(input.excel_source_import);
  master.excel_source_import.imported_at = importedAt;
}

export async function importExcelSourceProducts(dataRoot, rows) {
  assertBusinessDispatchEnabled('Excel Product Master import');
  await initialize(dataRoot);
  if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('没有通过 SOURCE_SCHEMA_VALIDATION 的产品行。'), { code: 'SOURCE_SCHEMA_VALIDATION_FAILED' });
  const results = await Promise.all(rows.map(async incoming => {
    const skuRaw = cleanText(incoming?.sku);
    try {
      const id = productId(skuRaw);
      return await serialize(id, async () => {
        let task = await getTask(dataRoot, id);
        const importedAt = iso();
        if (task?.final_archive) throw Object.assign(new Error('已上传 Final SKU 不接受自动导入覆盖。'), { code: 'FINAL_VERSION_LOCKED' });
        if (!task) {
          const raw = { ...incoming, brand_name: incoming.brand_name, excel_source_import: incoming.excel_source_import };
          task = taskTemplate(raw, id);
          applyExcelInputToMaster(task, incoming, importedAt);
          task.source_import_versions = [{ ...clone(task.master.excel_source_import), changed_fields: Object.keys(excelInputBusinessValue(incoming)), unchanged: false, imported_at: importedAt }];
          await commit(dataRoot, task, 'PRODUCT_EXCEL_SOURCE_IMPORTED', { sku: id, import_version: 1, changed_fields: task.source_import_versions[0].changed_fields, source_product_id: incoming.product_id || null });
          task = await dispatchCurrent(dataRoot, task);
          return { sku: id, ok: true, created: true, import_version: 1, changed_fields: task.source_import_versions[0].changed_fields, task };
        }
        const priorBusiness = task.master?.excel_source_import?.raw_values || {
          产品ID: task.master?.source_product_id || null, 产品sku: task.sku, 产品EAN: task.master?.ean || null,
          中文名称: task.master?.name || null, 品牌名: task.master?.brand_name ?? task.master?.brand ?? null,
          产品事实: task.master?.product_facts || {}, 竞品URL: task.master?.competitor_urls || [],
        };
        const nextBusiness = excelInputBusinessValue(incoming);
        const changedFields = Object.keys(nextBusiness).filter(key => canonicalFact(priorBusiness[key]) !== canonicalFact(nextBusiness[key]));
        const importVersion = (task.source_import_versions || []).length + 1;
        const versioned = clone(incoming);
        versioned.excel_source_import.version = importVersion;
        versioned.excel_source_import.imported_at = importedAt;
        for (const field of Object.values(versioned.excel_source_import.fields || {})) {
          field.import_version = importVersion; field.imported_at = importedAt;
        }
        task.source_import_versions ||= [];
        const historyRecord = { ...clone(versioned.excel_source_import), changed_fields: changedFields, unchanged: changedFields.length === 0, imported_at: importedAt };
        task.source_import_versions.push(historyRecord);
        if (changedFields.length) {
          const brandHeader = versioned.excel_source_import.fields?.brand_name?.header_name || '品牌名';
          const brandChanged = changedFields.includes(brandHeader);
          const changedCanonicalFields = new Set(Object.entries(versioned.excel_source_import.fields || {})
            .filter(([, field]) => changedFields.includes(field.header_name))
            .map(([field]) => field));
          if (brandChanged) {
            task.master.confirmed_facts ||= {};
            delete task.master.confirmed_facts.brand_name;
            delete task.master.confirmed_facts.brand;
          }
          const masterInput = clone(versioned);
          applyExcelInputToMaster(task, masterInput, importedAt, changedCanonicalFields);
          task.master.fact_version = Number(task.master.fact_version || 1) + 1;
          const staleOutputs = markDependentListingOutputsStale(task, task.master.fact_version, 'EXCEL_SOURCE_IMPORT_CHANGED');
          if (task.confirmation?.status === 'OPEN' && task.confirmation.source_module === 'LISTING_SOP_02') {
            task.listing_sop.decisions ||= [];
            task.listing_sop.decisions.push({ type: 'SOURCE_IMPORT_SUPERSEDED_OPEN_CONFIRMATION', proposal_id: task.confirmation.proposal_id, at: importedAt, import_version: importVersion });
            task.confirmation = null;
          }
          task.current_step = 'LISTING_SOP_01'; task.resume_point = 'LISTING_SOP_01'; task.listing_sop.current_step_id = 'LISTING_SOP_01';
          task.status = 'QUEUED'; task.activity_pool = '资料处理池';
          task.stages.LISTING_SOP_01 = { ...task.stages.LISTING_SOP_01, status: 'QUEUED', updated_at: importedAt };
          task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'NOT_STARTED', updated_at: importedAt };
          task.qa.LISTING_SOP_01 = { status: 'NOT_RUN', checked_at: null, report: null };
          task.qa.LISTING_SOP_02 = { status: 'NOT_RUN', checked_at: null, report: null };
          await commit(dataRoot, task, 'PRODUCT_EXCEL_SOURCE_CHANGED', { sku: id, import_version: importVersion, changed_fields: changedFields, new_product_master_version: task.master.fact_version, stale_outputs: staleOutputs });
          task = await dispatchCurrent(dataRoot, task);
        } else {
          // Record the new import provenance/version without reapplying unchanged raw values
          // over Product Master facts that may have been confirmed or edited since that import.
          task.master.excel_source_import = clone(versioned.excel_source_import);
          task.master.excel_source_import.imported_at = importedAt;
          await commit(dataRoot, task, 'PRODUCT_EXCEL_SOURCE_REIMPORTED_UNCHANGED', { sku: id, import_version: importVersion, changed_fields: [] });
        }
        return { sku: id, ok: true, created: false, unchanged: changedFields.length === 0, import_version: importVersion, changed_fields: changedFields, task };
      });
    } catch (error) {
      return { sku: skuRaw || '(空 SKU)', ok: false, error: { code: error.code || 'EXCEL_SOURCE_IMPORT_FAILED', message: error.message } };
    }
  }));
  return { accepted: results.filter(row => row.ok).length, rejected: results.filter(row => !row.ok).length, results };
}

const COMPETITOR_SOURCE_HEADERS = ['BOL直接竞品', 'BOL同类竞品1', 'BOL同类竞品2', 'BOL同类竞品3', 'BOL同类竞品4'];

function isValidBolProductUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && (url.hostname === 'bol.com' || url.hostname.endsWith('.bol.com')) && url.pathname.length > 1;
  } catch { return false; }
}

export function canonicalizeBolProviderUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!isValidBolProductUrl(url.href) || url.username || url.password) return null;
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:') return null;
    return url.href;
  } catch { return null; }
}

function isBolProductDetailUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !(url.hostname === 'bol.com' || url.hostname.endsWith('.bol.com'))) return false;
    if (/^\/s(?:\/|$)/i.test(url.pathname) || /searchtext=/i.test(url.search)) return false;
    return /^\/(?:nl\/)?nl\/p\/.+$/i.test(url.pathname) || /^\/p\/.+$/i.test(url.pathname);
  } catch { return false; }
}

async function resolveBolProductUrlAutomatically({ client, ean }) {
  const exactEan = String(ean || '').trim();
  const evidence = { method: 'BOL_RETAILER_V10_PRODUCT_PLACEMENT', endpoint: `/retailer/products/${exactEan}/placement`, ean: exactEan, attempted_at: iso() };
  if (!exactEan) return { status: 'FAILED', reason_code: 'URL_RESOLUTION_EAN_MISSING', evidence };
  if (typeof client?.getProductPlacement !== 'function') {
    return { status: 'WAITING_DEPENDENCY', reason_code: 'API_ADAPTER_ENDPOINT_MISSING: PRODUCT_PLACEMENT', evidence };
  }
  try {
    const response = await client.getProductPlacement({ ean: exactEan, cacheMode: 'FORCE_REFRESH' });
    const result = response?.structuredResult ?? response?.data ?? response;
    const httpStatus = Number(response?.httpStatus ?? response?.statusCode ?? 200);
    evidence.response_source = response?.source || null;
    evidence.cache_hit = response?.cacheHit ?? null;
    if (httpStatus === 404) return { status: 'FAILED', reason_code: 'PRODUCT_PLACEMENT_NOT_FOUND', evidence: { ...evidence, http_status: 404 } };
    const url = String(result?.url || '').trim();
    evidence.categories = result?.categories || result?.category || null;
    if (httpStatus !== 200 || !isBolProductDetailUrl(url)) {
      return { status: 'FAILED', reason_code: 'PRODUCT_PLACEMENT_URL_INVALID', evidence: { ...evidence, http_status: httpStatus, returned_url_present: Boolean(url) } };
    }
    return { status: 'RESOLVED', product_url: url, reason_code: null, evidence: { ...evidence, http_status: 200, resolved_at: iso(), verified_url: url, verification: 'OFFICIAL_PRODUCT_PLACEMENT_URL_AND_BOL_PRODUCT_DETAIL_PATH' } };
  } catch (error) {
    if (Number(error?.status) === 404) return { status: 'FAILED', reason_code: 'PRODUCT_PLACEMENT_NOT_FOUND', evidence: { ...evidence, http_status: 404 } };
    return { status: 'WAITING_DEPENDENCY', reason_code: error?.code || 'PRODUCT_PLACEMENT_REQUEST_UNAVAILABLE', evidence: { ...evidence, safe_error_code: error?.code || null, http_status: error?.status || null } };
  }
}
async function attemptCandidateUrlResolution(dataRoot, task, candidate) {
  const resolution = await resolveBolProductUrlAutomatically({ client: bolClientFor(dataRoot), ean: candidate.ean });
  candidate.url_resolution_attempts ||= [];
  candidate.url_resolution_attempts.push(clone(resolution));
  candidate.url_resolution_status = resolution.status === 'WAITING_DEPENDENCY' ? 'PENDING_RESOLUTION' : resolution.status;
  candidate.url_resolution = { ...clone(resolution), method: resolution.evidence?.method || 'BOL_RETAILER_V10_PRODUCT_PLACEMENT', updated_at: iso(), source: 'BOL_RETAILER_V10_PRODUCT_PLACEMENT' };
  if (resolution.status === 'RESOLVED') {
    candidate.product_url = resolution.product_url;
    candidate.view_url = resolution.product_url;
    candidate.status = 'WAITING_CONFIRMATION';
    candidate.decision_status = 'WAITING_CONFIRMATION';
    task.competitor_discovery.status = 'WAITING_CONFIRMATION';
    await commit(dataRoot, task, 'COMPETITOR_CANDIDATE_URL_AUTO_RESOLVED', { candidate_id: candidate.candidate_id, url_resolution_status: 'RESOLVED', reason_code: resolution.reason_code });
  } else if (resolution.status === 'WAITING_DEPENDENCY') {
    candidate.product_url = null;
    candidate.view_url = null;
    candidate.status = 'WAITING_DEPENDENCY';
    candidate.decision_status = 'WAITING_DEPENDENCY';
    task.competitor_discovery.status = 'WAITING_DEPENDENCY';
    task.competitor_discovery.dependency = 'BOL_API_ENDPOINT:PRODUCT_PLACEMENT';
    task.competitor_discovery.dependency_reason = resolution.reason_code;
    await commit(dataRoot, task, 'COMPETITOR_CANDIDATE_URL_RESOLUTION_WAITING_DEPENDENCY', { candidate_id: candidate.candidate_id, reason_code: resolution.reason_code });
  } else {
    candidate.product_url = null;
    candidate.view_url = null;
    candidate.url_resolution.reason_code = resolution.reason_code || 'URL_RESOLUTION_REQUIRED';
    candidate.status = 'WAITING_CONFIRMATION';
    candidate.decision_status = 'WAITING_CONFIRMATION';
    candidate.url_resolution.error = 'Product Placement 未返回有效商品详情页 URL；自动解析失败后可由 Leon 提交真实详情页链接作为 fallback。';
    task.competitor_discovery.status = 'WAITING_CONFIRMATION: URL_RESOLUTION_REQUIRED';
    await commit(dataRoot, task, 'COMPETITOR_CANDIDATE_URL_AUTO_RESOLUTION_FAILED', { candidate_id: candidate.candidate_id, url_resolution_status: 'FAILED', reason_code: candidate.url_resolution.reason_code });
  }
  task.competitor_discovery.updated_at = iso();
  return resolution;
}

function confirmedFactValue(facts, keys) {
  for (const key of keys) {
    const fact = facts?.fields?.[key];
    if (fact?.status === 'CONFIRMED' && typeof fact.value === 'string' && fact.value.trim()) return fact.value.trim();
  }
  return '';
}

const CJK_MARKET_QUERY_PATTERN = /[\u3400-\u9fff]/;

function confirmedDutchMarketQueries(task) {
  const queries = [];
  const seen = new Set();
  const existingUrls = new Set((task.master?.competitor_urls || [])
    .filter(row => COMPETITOR_SOURCE_HEADERS.includes(String(row?.source_header || row?.source_field || '').trim()))
    .map(row => String(row?.exact_url ?? row?.raw_value ?? '').trim())
    .filter(isBolProductDetailUrl));
  for (const subtask of task.boloo?.required_subtasks || []) {
    if (subtask.provider_source !== 'keyword_extractor' || subtask.status !== 'PASS' || !existingUrls.has(String(subtask.query_text || '').trim())) continue;
    const providerResult = subtask.result;
    if (providerResult?.cache_source !== 'BOLOO_OFFICIAL_WEB' || !providerResult?.request_id || providerResult?.evidence?.fixture === true || providerResult?.evidence?.source === 'acceptance-test-only') continue;
    const keywords = providerResult?.result?.keywords;
    if (!Array.isArray(keywords)) continue;
    for (const item of keywords) {
      const expression = typeof item === 'string' ? item.trim() : String(item?.keyword ?? item?.search_term ?? '').trim();
      if (!expression || CJK_MARKET_QUERY_PATTERN.test(expression)) continue;
      const key = expression.toLocaleLowerCase('nl-NL');
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ query: expression, language: 'nl-NL', source_id: subtask.source_id || null, subtask_id: subtask.subtask_id || null, source_url: String(subtask.query_text).trim(), source: 'BOLOO_OFFICIAL_WEB_EXTRACTOR' });
    }
  }
  return queries;
}

async function discoverCompetitorSources(dataRoot, task) {
  task.master.competitor_urls ||= [];
  task.competitor_source_records ||= [];
  task.competitor_candidates ||= [];
  task.competitor_url_list ||= [];
  task.competitor_discovery ||= {};
  const imported = task.master.excel_source_import || {};
  const now = iso();
  const occupied = new Set();
  const seenUrls = new Set();
  const valid = [];
  const invalid = [];
  for (const row of task.master.competitor_urls) {
    const header = String(row?.source_header || row?.source_field || '').trim();
    const originalUrl = String(row?.exact_url ?? row?.raw_value ?? '');
    const canonicalUrl = originalUrl.trim();
    if (!COMPETITOR_SOURCE_HEADERS.includes(header) || !canonicalUrl) continue;
    if (isValidBolProductUrl(canonicalUrl) && !seenUrls.has(canonicalUrl)) {
      seenUrls.add(canonicalUrl);
      occupied.add(header);
      valid.push({ header, raw_url: originalUrl, canonical_url: canonicalUrl, source_cell: row.source_cell || null, import_version: row.import_version || imported.version || null });
    } else {
      invalid.push({ source_header: header, source_file: imported.source_file || null, source_cell: row.source_cell || null, raw_url: originalUrl, import_version: row.import_version || imported.version || null, invalid_reason: isValidBolProductUrl(canonicalUrl) ? 'DUPLICATE_BOL_URL_SLOT' : 'INVALID_BOL_URL_FORMAT', checked_at: now });
    }
  }
  for (const item of invalid) {
    if (!task.competitor_source_records.some(record => record.record_status === 'INVALID' && record.source_header === item.source_header && record.raw_url === item.raw_url && record.import_version === item.import_version)) task.competitor_source_records.push({ ...item, record_status: 'INVALID' });
  }
  for (const source of valid) {
    if (!task.competitor_source_records.some(record => record.record_status === 'ORIGINAL' && record.source_header === source.header && record.raw_url === source.raw_url && record.import_version === source.import_version)) {
      task.competitor_source_records.push({ source_header: source.header, source_file: imported.source_file || null, source_cell: source.source_cell, raw_url: source.raw_url, import_version: source.import_version, record_status: 'ORIGINAL', checked_at: now });
    }
    if (!task.competitor_url_list.some(item => item.exact_url === source.canonical_url)) task.competitor_url_list.push({ source_id: `USER_${source.source_cell || source.header}`, exact_url: source.canonical_url, raw_url: source.raw_url, source_header: source.header, source_cell: source.source_cell, import_version: source.import_version, source: 'LEON_EXCEL', origin: 'USER_INPUT', confirmed_by: 'Leon', usable_for_boloo_extractor: true });
  }
  const missingSlots = COMPETITOR_SOURCE_HEADERS.filter(header => !occupied.has(header));
  const amazonRaw = task.master.product_facts?.amazon_reference;
  const amazonPresent = typeof amazonRaw === 'string' ? !!amazonRaw.trim() : !!amazonRaw?.raw_value;
  task.competitor_discovery.amazon_status = amazonPresent ? 'EXISTING_SOURCE' : 'SOURCE_NOT_CONNECTED: AMAZON_DISCOVERY';
  if (!missingSlots.length) {
    task.competitor_discovery = { ...task.competitor_discovery, status: 'EXISTING_SOURCES_REUSED', valid_existing_count: valid.length, invalid_original_count: invalid.length, search_count: 0, updated_at: now, amazon_status: task.competitor_discovery.amazon_status };
    await commit(dataRoot, task, 'COMPETITOR_SOURCES_REUSED_NO_SEARCH', { valid_existing_count: valid.length, invalid_original_count: invalid.length, search_count: 0 });
    return { task, discovery: clone(task.competitor_discovery) };
  }
  const facts = task.outputs?.confirmed_product_facts;
  if (!facts || facts.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || Number(facts.product_master_version) !== Number(task.master.fact_version) || task.qa?.LISTING_SOP_02?.status !== 'PASS') {
    task.competitor_discovery = { ...task.competitor_discovery, status: 'WAITING_DEPENDENCY', dependency: 'CONFIRMED_PRODUCT_FACTS_VERSION', dependency_status: 'NOT_READY', missing_slots: missingSlots, valid_existing_count: valid.length, search_count: 0, updated_at: now, amazon_status: task.competitor_discovery.amazon_status };
    await commit(dataRoot, task, 'COMPETITOR_DISCOVERY_WAITING_FOR_CONFIRMED_FACTS', { missing_slots: missingSlots, search_count: 0 });
    return { task, discovery: clone(task.competitor_discovery) };
  }
  const readiness = await bolApiReadiness(dataRoot);
  const override = readinessOverride('BOL_API_READY');
  const ready = typeof override === 'boolean' ? override : readiness.status === 'PASS';
  if (!ready) {
    task.competitor_discovery = { ...task.competitor_discovery, status: 'WAITING_DEPENDENCY', dependency: 'BOL_API', dependency_status: readiness.status, missing_slots: missingSlots, valid_existing_count: valid.length, search_count: 0, updated_at: now, amazon_status: task.competitor_discovery.amazon_status };
    await commit(dataRoot, task, 'COMPETITOR_DISCOVERY_WAITING_FOR_BOL_API', { dependency_status: readiness.status, missing_slots: missingSlots, search_count: 0 });
    return { task, discovery: clone(task.competitor_discovery) };
  }
  const searchTerms = confirmedDutchMarketQueries(task);
  if (!searchTerms.length) {
    task.competitor_discovery = { ...task.competitor_discovery, status: 'WAITING_PROVIDER_INPUT', dependency: null, dependency_status: null, reason: 'NO_CONFIRMED_DUTCH_MARKET_QUERY_SOURCE', missing_slots: missingSlots, valid_existing_count: valid.length, search_count: 0, updated_at: now, amazon_status: task.competitor_discovery.amazon_status };
    await commit(dataRoot, task, 'COMPETITOR_DISCOVERY_WAITING_FOR_DUTCH_EXTRACTOR_TERMS', { missing_slots: missingSlots, search_count: 0, provider_input: 'BOLOO_OFFICIAL_WEB_EXTRACTOR_TERMS_REQUIRED' });
    return { task, discovery: clone(task.competitor_discovery) };
  }
  const candidateEans = new Set();
  const candidateRows = [];
  let searchCount = 0;
  for (const querySource of searchTerms) {
    const query = querySource.query;
    if (CJK_MARKET_QUERY_PATTERN.test(query)) {
      task.competitor_discovery = { ...task.competitor_discovery, status: 'WAITING_CONFIRMATION', reason: 'NON_DUTCH_MARKET_QUERY_REJECTED', missing_slots: missingSlots, valid_existing_count: valid.length, search_count: searchCount, updated_at: iso(), amazon_status: task.competitor_discovery.amazon_status };
      await commit(dataRoot, task, 'COMPETITOR_DISCOVERY_REJECTED_NON_DUTCH_QUERY', { missing_slots: missingSlots, search_count: searchCount, source_id: querySource.source_id });
      return { task, discovery: clone(task.competitor_discovery) };
    }
    let response;
    try { response = await bolClientFor(dataRoot).getProductList({ countryCode: 'NL', searchTerm: query, page: 1, cacheMode: 'FORCE_REFRESH' }); }
    catch (error) {
      task.competitor_discovery = { ...task.competitor_discovery, status: 'WAITING_DEPENDENCY', dependency: 'BOL_API', provider_error_code: error?.code || 'BOL_PRODUCT_LIST_UNAVAILABLE', missing_slots: missingSlots, valid_existing_count: valid.length, search_count: searchCount, updated_at: iso(), amazon_status: task.competitor_discovery.amazon_status };
      await commit(dataRoot, task, 'COMPETITOR_DISCOVERY_PROVIDER_WAITING', { dependency: 'BOL_API', provider_error_code: error?.code || 'BOL_PRODUCT_LIST_UNAVAILABLE', search_count: searchCount });
      return { task, discovery: clone(task.competitor_discovery) };
    }
    if (!response.cacheHit) searchCount += 1;
    for (const product of response.rawResponse?.products || []) {
      const ean = String(product?.eans?.find(item => item?.ean)?.ean || '');
      const title = String(product?.title || '').trim();
      if (!ean || !title || candidateEans.has(ean)) continue;
      candidateEans.add(ean);
      const directSlotOpen = !occupied.has('BOL直接竞品');
      const rawProductUrl = [product.url, product.productUrl, product.productURL, product.canonicalUrl].find(isBolProductDetailUrl) || null;
      candidateRows.push({
        candidate_id: crypto.randomUUID(), status: 'WAITING_CONFIRMATION', candidate_status: 'CANDIDATE_DISCOVERED', bol_product_id: product.bolProductId || product.productId || null, ean,
        product_url: null, view_url: null,
        title, discovery_query: query, source_provider: 'BOL_API_PRODUCT_LIST', discovered_at: iso(), facts_version: facts.version,
        match_basis: { query_language: querySource.language, query_source: querySource.source, query_source_id: querySource.source_id, query_source_header: querySource.source_header, confirmed_source_url: querySource.source_url, query },
        proposed_type: directSlotOpen ? 'DIRECT' : 'SIMILAR', decision_status: 'WAITING_CONFIRMATION',
        url_resolution_status: 'PENDING_RESOLUTION',
        url_resolution: { status: 'PENDING_RESOLUTION', reason_code: 'URL_RESOLUTION_REQUIRED', source: null, updated_at: iso() },
        product_list_evidence: { provider: 'BOL_API_PRODUCT_LIST', request: { country_code: 'NL', search_term: query, page: 1 }, response_source: response.source || null, cache_hit: response.cacheHit === true, observed_at: iso(), product_list_url_candidate: rawProductUrl, matched_product: clone(product) },
      });
      if (candidateRows.length >= Math.max(1, missingSlots.length)) break;
    }
    if (candidateRows.length >= Math.max(1, missingSlots.length)) break;
  }
  task.competitor_candidates.push(...candidateRows);
  task.competitor_discovery = { ...task.competitor_discovery, status: candidateRows.length ? 'CANDIDATES_DISCOVERED' : 'NO_CANDIDATES_RETURNED', dependency: null, dependency_status: 'PASS', missing_slots: missingSlots, valid_existing_count: valid.length, search_count: searchCount, candidate_count: candidateRows.length, provider: 'BOL_API_PRODUCT_LIST', facts_version: facts.version, updated_at: iso(), amazon_status: task.competitor_discovery.amazon_status };
  await commit(dataRoot, task, 'COMPETITOR_SOURCE_CANDIDATES_DISCOVERED', { candidate_ids: candidateRows.map(item => item.candidate_id), candidate_count: candidateRows.length, missing_slots: missingSlots, search_count: searchCount, facts_version: facts.version });
  for (const candidate of candidateRows) await attemptCandidateUrlResolution(dataRoot, task, candidate);
  const endpointWaiting = candidateRows.some(item => item.status === 'WAITING_DEPENDENCY');
  const allUnresolved = candidateRows.length > 0 && candidateRows.every(item => item.url_resolution_status !== 'RESOLVED');
  task.competitor_discovery = { ...task.competitor_discovery, status: endpointWaiting ? 'WAITING_DEPENDENCY' : (allUnresolved ? 'WAITING_CONFIRMATION: URL_RESOLUTION_REQUIRED' : (candidateRows.length ? 'WAITING_CONFIRMATION' : 'NO_CANDIDATES_RETURNED')), updated_at: iso() };
  await commit(dataRoot, task, 'COMPETITOR_SOURCE_URL_RESOLUTION_FINISHED', { candidate_count: candidateRows.length, resolved_count: candidateRows.filter(item => item.url_resolution_status === 'RESOLVED').length, unresolved_count: candidateRows.filter(item => item.url_resolution_status !== 'RESOLVED').length });
  return { task, discovery: clone(task.competitor_discovery) };
}

export async function getTask(dataRoot, sku) { return readTask(dataRoot, sku); }

/** Restore a deliberately removed competitor slot in the isolated SYNTHETIC_ACCEPTANCE_10 acceptance copy. */
export async function restoreSop03AcceptanceCompetitorSlot(dataRoot, sku) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (id !== 'SYNTHETIC-SKU-LEGACY-10' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_10') throw Object.assign(new Error('该恢复入口仅用于 SYNTHETIC_ACCEPTANCE_10 的 4181 隔离验收记录。'), { code: 'SOP03_ACCEPTANCE_RESTORE_SCOPE' });
    if (task.current_step !== 'LISTING_SOP_03') throw Object.assign(new Error('只能在 SYNTHETIC_ACCEPTANCE_10 保持 LISTING_SOP_03 时恢复竞品来源。'), { code: 'SOP03_PARENT_STEP_REQUIRED' });
    const field = task.master?.excel_source_import?.fields?.bol_similar_competitor_4;
    const url = String(field?.acceptance_original_raw_value || '').trim();
    if (field?.header_name !== 'BOL同类竞品4' || field?.cell_reference !== 'N12'
      || field?.acceptance_override?.scenario !== 'remove_normalized_competitor_slot'
      || field?.acceptance_override?.source_cell !== 'N12'
      || !isValidBolProductUrl(url)) {
      throw Object.assign(new Error('N12 未包含可验证的验收原始值/覆盖记录；未恢复任何 URL。'), { code: 'SOP03_ACCEPTANCE_SOURCE_EVIDENCE_INVALID' });
    }
    task.master.competitor_urls ||= [];
    task.competitor_url_list ||= [];
    const already = task.competitor_url_list.some(item => item.exact_url === url);
    if (!already) {
      const restored = {
        source_header: field.header_name, source_cell: field.cell_reference, exact_url: url,
        raw_url: url, import_version: field.import_version || task.master.excel_source_import.version,
        source_file: field.source_file || task.master.excel_source_import.source_file,
        origin: 'RESTORED_FROM_ACCEPTANCE_SNAPSHOT',
      };
      task.master.competitor_urls.push(restored);
      task.competitor_url_list.push({
        source_id: 'EXCEL_N12', exact_url: url, raw_url: url, source_header: field.header_name,
        source_cell: field.cell_reference, import_version: restored.import_version,
        source: 'LEON_EXCEL_ACCEPTANCE_ORIGINAL', origin: 'USER_INPUT', confirmed_by: 'Leon',
        usable_for_boloo_extractor: true, restored_from_acceptance_override: true,
      });
      task.master.competitor_url_completion = { status: 'NOT_REQUIRED', reason: null, candidates: [] };
      await commit(dataRoot, task, 'SOP03_COMPETITOR_SOURCE_RESTORED_FROM_ACCEPTANCE_SNAPSHOT', {
        source_cell: 'N12', source_header: field.header_name, source_url: url,
        acceptance_scenario: field.acceptance_override.scenario,
      });
    }
    return { task, restored: !already, source_url: url, source_cell: 'N12' };
  });
}

/** Create one internal Boloo Provider task for a confirmed SOP03 source. */
export async function ensureSop03BolooProviderChild(dataRoot, parentSku, sourceRecord) {
  const parentId = productId(parentSku);
  return serialize(parentId, async () => {
    const parent = await readTask(dataRoot, parentId);
    if (!parent) throw Object.assign(new Error(`找不到 SKU ${parentId}`), { code: 'SKU_NOT_FOUND' });
    if (parent.current_step !== 'LISTING_SOP_03') throw Object.assign(new Error('Boloo Provider child 只能挂载在 LISTING_SOP_03 父步骤。'), { code: 'SOP03_PROVIDER_PARENT_STEP_REQUIRED' });
    if (!isOfficialWebBolooReady()) throw Object.assign(new Error('BOLOO_OFFICIAL_WEB 尚未 READY。'), { code: 'WAITING_DEPENDENCY_BOOLOO_OFFICIAL_WEB' });
    const sourceId = cleanText(sourceRecord?.source_id);
    const sourceUrl = String(sourceRecord?.exact_url ?? '');
    const officialSource = (parent.competitor_url_list || []).find(item => item.source_id === sourceId && item.exact_url === sourceUrl && item.usable_for_boloo_extractor === true);
    if (!officialSource || !isValidBolProductUrl(sourceUrl)) throw Object.assign(new Error('SOP03 Extractor 只能使用该 SKU 已确认且可供 Boloo 使用的原始 BOL 商品 URL。'), { code: 'SOP03_BOLOO_SOURCE_NOT_CONFIRMED' });

    parent.listing_sop ||= {};
    parent.listing_sop.sop03_sources ||= {};
    const sourceState = parent.listing_sop.sop03_sources;
    sourceState.BOLOO_COMPETITOR_EXTRACTOR ||= { source_type: 'BOLOO_COMPETITOR_EXTRACTOR', provider: 'BOLOO_OFFICIAL_WEB', status: 'QUEUED', required_subtasks: [], updated_at: iso() };
    sourceState.BOLOO_COMPETITOR_EXTRACTOR.required_subtasks ||= [];
    sourceState.BOL_SOURCE = { ...sourceState.BOL_SOURCE, source_type: 'BOL_SOURCE', status: 'LOCAL_SOURCE_AVAILABLE', dependency: null, dependency_status: null, updated_at: iso() };
    sourceState.AMAZON_SOURCE = { ...sourceState.AMAZON_SOURCE, source_type: 'AMAZON_SOURCE', status: parent.master?.product_facts?.amazon_reference ? 'LOCAL_SOURCE_AVAILABLE' : 'OPTIONAL/NOT_APPLICABLE', dependency: null, updated_at: iso() };

    const digest = crypto.createHash('sha256').update(`${parentId}\0${sourceId}\0${sourceUrl}`, 'utf8').digest('hex').slice(0, 28);
    const childId = `BCHILD-${digest}`;
    const existingLink = sourceState.BOLOO_COMPETITOR_EXTRACTOR.required_subtasks.find(item => item.source_id === sourceId && item.source_url === sourceUrl);
    let child = await readTask(dataRoot, childId);
    if (!child) {
      child = clone(parent);
      const now = iso();
      child.id = childId; child.sku = childId; child.revision = 0; child.created_at = now; child.updated_at = now;
      child.master = { ...child.master, sku: childId };
      const queryUrl = canonicalizeBolProviderUrl(sourceUrl);
      if (!queryUrl) throw Object.assign(new Error('SOP03 Extractor 来源无法转换为安全的 BOL HTTPS URL。'), { code: 'BOLOO_COMPETITOR_URL_INVALID' });
      child.provider_child_task = { parent_sku: parentId, parent_sop_step: 'LISTING_SOP_03', provider_stage: 'boloo_keywords', provider: 'BOLOO_OFFICIAL_WEB', task_type: 'KEYWORD_EXTRACTOR', source_id: sourceId, source_field: officialSource.source_header || null, source_url: sourceUrl, query_url: queryUrl, url_normalization: queryUrl === sourceUrl ? null : { from: sourceUrl, to: queryUrl, reason: 'BOL_HTTP_TO_HTTPS_UPGRADE' }, hidden_from_product_dashboard: true, created_at: now };
      child.current_step = 'boloo_keywords'; child.resume_point = 'boloo_keywords'; child.last_success_step = parent.last_success_step || null;
      child.status = 'QUEUED'; child.waiting_dependency_key = null; child.activity_pool = '关键词池'; child.current_pool = '关键词池';
      child.stage_qa_status = 'NOT_RUN'; child.error_code = null; child.error_message = null; child.return_pool = null; child.issues = []; child.open_error_count = 0;
      child.final_archive = null; child.outputs = {};
      child.qa = { ...child.qa, boloo_keywords: { status: 'NOT_RUN', checked_at: null, report: null } };
      child.stages = { ...child.stages, boloo_keywords: { ...(child.stages?.boloo_keywords || {}), label: 'Boloo 关键词 Provider 子任务', status: 'QUEUED', updated_at: now } };
      child.sidecars = { ...child.sidecars, keywords: { ...(child.sidecars?.keywords || {}), status: 'QUEUED', updated_at: now } };
      child.boloo = { required_subtasks: [], current_subtask_id: null, current_source_id: null, candidates: [], keyword_discovery_closed: false, discovery_close_evidence: null };
      await commit(dataRoot, child, 'SOP03_BOOLOO_PROVIDER_CHILD_CREATED', { parent_sku: parentId, parent_sop_step: 'LISTING_SOP_03', source_id: sourceId, provider_stage: 'boloo_keywords', provider: 'BOLOO_OFFICIAL_WEB', task_type: 'KEYWORD_EXTRACTOR' });
    } else if (child.provider_child_task?.parent_sku !== parentId || child.provider_child_task?.source_id !== sourceId) {
      throw Object.assign(new Error('Existing SOP03 Provider child identity does not match the confirmed source.'), { code: 'SOP03_PROVIDER_CHILD_IDENTITY_MISMATCH' });
    }

    // Child creation is a preparation step. Install the exact source subtask
    // without dispatch so a later bad source cannot leave earlier sources half
    // prepared or accidentally start remote work out of order.
    const queryUrl = canonicalizeBolProviderUrl(sourceUrl);
    if (!queryUrl) throw Object.assign(new Error('SOP03 Extractor 来源无法转换为安全的 BOL HTTPS URL。'), { code: 'BOLOO_COMPETITOR_URL_INVALID' });
    child.provider_child_task ||= { parent_sku: parentId, parent_sop_step: 'LISTING_SOP_03', source_id: sourceId, source_url: sourceUrl };
    child.provider_child_task.query_url = queryUrl;
    child.provider_child_task.url_normalization = queryUrl === sourceUrl ? null : { from: sourceUrl, to: queryUrl, reason: 'BOL_HTTP_TO_HTTPS_UPGRADE' };
    if (!Array.isArray(child.boloo?.required_subtasks) || child.boloo.required_subtasks.length === 0) {
      const configured = await configureBolooRequiredSubtasks(dataRoot, childId, { extractor_urls: [sourceUrl], extractor_origin: `LISTING_SOP_03:${sourceId}`, dispatch: false });
      child = configured.task;
      child.provider_child_task.query_url = queryUrl;
      child.provider_child_task.url_normalization = queryUrl === sourceUrl ? null : { from: sourceUrl, to: queryUrl, reason: 'BOL_HTTP_TO_HTTPS_UPGRADE' };
      await commit(dataRoot, child, 'SOP03_PROVIDER_CHILD_SOURCE_PREPARED', { parent_sku: parentId, source_id: sourceId, source_url: sourceUrl, query_url: queryUrl, dispatch: false });
    }

    const providerSubtask = child.boloo?.required_subtasks?.[0];
    if (!providerSubtask || providerSubtask.provider_source !== 'keyword_extractor' || providerSubtask.query_text !== queryUrl) {
      throw Object.assign(new Error('Existing SOP03 Provider child subtask does not match this source.'), { code: 'SOP03_PROVIDER_SUBTASK_IDENTITY_MISMATCH' });
    }
    if (existingLink) {
      const repairedLink = { ...existingLink, subtask_id: providerSubtask.subtask_id, status: providerSubtask.status || 'NOT_STARTED', updated_at: iso() };
      const index = sourceState.BOLOO_COMPETITOR_EXTRACTOR.required_subtasks.findIndex(item => item.source_id === sourceId && item.source_url === sourceUrl);
      sourceState.BOLOO_COMPETITOR_EXTRACTOR.required_subtasks[index] = repairedLink;
      await commit(dataRoot, parent, 'SOP03_BOOLOO_PROVIDER_CHILD_LINK_RECONCILED', { source_id: sourceId, provider_child_task_id: childId, subtask_id: providerSubtask.subtask_id, status: repairedLink.status });
      return { parent, child, child_id: child.sku, source: clone(repairedLink), reused: true };
    }

    const link = {
      parent_sop_step: 'LISTING_SOP_03', provider_stage: 'boloo_keywords', provider: 'BOLOO_OFFICIAL_WEB', task_type: 'KEYWORD_EXTRACTOR',
      source_id: sourceId, source_field: officialSource.source_header || null, source_url: sourceUrl,
      subtask_id: providerSubtask?.subtask_id || null, provider_child_task_id: childId,
      dependency_status: 'READY', status: providerSubtask?.status || 'NOT_STARTED', result_version: null, evidence_refs: [], updated_at: iso(),
    };
    sourceState.BOLOO_COMPETITOR_EXTRACTOR.required_subtasks.push(link);
    sourceState.BOLOO_COMPETITOR_EXTRACTOR.status = 'RUNNING'; sourceState.BOLOO_COMPETITOR_EXTRACTOR.updated_at = iso();
    parent.status = 'RUNNING'; parent.waiting_dependency_key = null; parent.resume_point = 'LISTING_SOP_03';
    parent.listing_sop.current_step_id = 'LISTING_SOP_03'; parent.activity_pool = '关键词池'; parent.current_pool = parent.activity_pool;
    parent.stages.LISTING_SOP_03 = { ...parent.stages.LISTING_SOP_03, status: 'RUNNING', dependency: null, updated_at: iso() };
    await commit(dataRoot, parent, 'SOP03_BOOLOO_PROVIDER_CHILD_ATTACHED', { source_id: sourceId, source_url: sourceUrl, provider_child_task_id: childId, subtask_id: link.subtask_id });
    return { parent, child, child_id: childId, source: link, reused: false };
  });
}

/** Resume a persisted SOP03 child only when no Provider attempt has ever started. */
export async function resumeSop03ProviderChildBeforeFirstAttempt(dataRoot, parentSku, childSku) {
  const parentId = productId(parentSku), childId = productId(childSku);
  return serialize(childId, async () => {
    const parent = await readTask(dataRoot, parentId), child = await readTask(dataRoot, childId);
    if (!parent || !child) throw Object.assign(new Error('SOP03 parent or Provider child task is missing.'), { code: 'SOP03_PROVIDER_CHILD_MISSING' });
    if (parent.current_step !== 'LISTING_SOP_03' || child.provider_child_task?.parent_sku !== parentId || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_03') {
      throw Object.assign(new Error('Provider child is not attached to this SOP03 parent.'), { code: 'SOP03_PROVIDER_PARENT_MISMATCH' });
    }
    const subtask = child.boloo?.required_subtasks?.[0];
    if (['RUNNING', 'PENDING_RECHECK'].includes(child.status)) return { task: child, resumed: false };
    const neverAttempted = subtask && child.boloo.required_subtasks.length === 1
      && subtask.status === 'NOT_STARTED' && Number(subtask.attempt_count || 0) === 0
      && Number(subtask.retry_count || 0) === 0 && !(subtask.request_ids || []).length
      && !(subtask.history || []).length && !subtask.result;
    if (!['PAUSED', 'QUEUED'].includes(child.status) || !neverAttempted) {
      throw Object.assign(new Error('Provider child cannot be resumed automatically because a Provider attempt or result may already exist.'), { code: 'SOP03_PROVIDER_CHILD_RECOVERY_UNSAFE' });
    }
    const priorStatus = child.status;
    child.status = 'QUEUED'; child.waiting_dependency_key = null; child.error_code = null; child.error_message = null;
    child.stage_qa_status = 'NOT_RUN'; child.resume_point = 'boloo_keywords';
    child.stages.boloo_keywords = { ...child.stages.boloo_keywords, status: 'QUEUED', updated_at: iso() };
    await commit(dataRoot, child, 'SOP03_PROVIDER_CHILD_RESUMED_BEFORE_FIRST_ATTEMPT', { parent_sku: parentId, child_sku: childId, subtask_id: subtask.subtask_id, prior_status: priorStatus });
    const dispatched = await dispatchCurrent(dataRoot, child);
    return { task: dispatched, resumed: true };
  });
}

/** Save a Provider result and immutable evidence reference on its SOP03 parent. */
export async function recordSop03BolooProviderChildResult(dataRoot, parentSku, childSku) {
  const parentId = productId(parentSku), childId = productId(childSku);
  return serialize(parentId, async () => {
    const parent = await readTask(dataRoot, parentId), child = await readTask(dataRoot, childId);
    if (!parent || !child) throw Object.assign(new Error('SOP03 parent or Provider child task is missing.'), { code: 'SOP03_PROVIDER_CHILD_MISSING' });
    if (parent.current_step !== 'LISTING_SOP_03' || child.provider_child_task?.parent_sku !== parentId || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_03') throw Object.assign(new Error('Provider child is not attached to this SOP03 parent.'), { code: 'SOP03_PROVIDER_PARENT_MISMATCH' });
    const providerSubtask = child.boloo?.required_subtasks?.[0];
    if (!providerSubtask || providerSubtask.provider_source !== 'keyword_extractor') throw Object.assign(new Error('Provider child does not contain one Keyword Extractor subtask.'), { code: 'SOP03_PROVIDER_RESULT_MISSING' });
    const providerQueryUrl = child.provider_child_task.query_url || child.provider_child_task.source_url;
    if (providerSubtask.query_text !== providerQueryUrl) throw Object.assign(new Error('Provider child query does not match its canonical source URL.'), { code: 'SOP03_PROVIDER_QUERY_MISMATCH' });
    const result = providerSubtask.result;
    const evidenceRef = result?.evidence?.dom_evidence_ref?.reference || null;
    let evidencePersisted = false, evidenceMatches = false;
    if (evidenceRef) {
      try {
        const rawEvidence = JSON.parse(await fs.readFile(evidenceRef, 'utf8'));
        evidencePersisted = true;
        evidenceMatches = rawEvidence.operation === 'keyword_extractor'
          && rawEvidence.query_text === providerQueryUrl
          && rawEvidence.request_id === result?.request_id
          && rawEvidence.raw_response?.matched_query === providerQueryUrl;
      } catch { evidencePersisted = false; }
    }
    const resultDigest = crypto.createHash('sha256').update(JSON.stringify({ source_url: child.provider_child_task.source_url, history: providerSubtask.history || [], result }), 'utf8').digest('hex');
    const resultVersion = `SOP03-BOLOO-${resultDigest.slice(0, 20)}`;
    const sourceRows = parent.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
    const link = sourceRows.find(item => item.provider_child_task_id === childId && item.source_url === child.provider_child_task.source_url);
    if (!link) throw Object.assign(new Error('Provider child is not listed under its SOP03 source.'), { code: 'SOP03_PROVIDER_LINK_MISSING' });
    if (['PASS', 'PASS_NO_RESULT'].includes(providerSubtask.status) && (!evidencePersisted || !evidenceMatches)) throw Object.assign(new Error('Boloo result has no matching persisted RAW/DOM evidence file.'), { code: 'SOP03_PROVIDER_EVIDENCE_MISSING' });
    let sourceQaStatus = 'NOT_RUN';
    if (['PASS', 'PASS_NO_RESULT'].includes(providerSubtask.status) && evidencePersisted && evidenceMatches
      && result?.query_text === providerQueryUrl
      && result?.evidence?.matched_query === providerQueryUrl
      && (providerSubtask.status !== 'PASS' || Array.isArray(result?.result?.keywords))) {
      sourceQaStatus = 'PASS';
      let issueClosed = false;
      for (const issue of child.issues || []) {
        if (issue.step === 'boloo_keywords' && issue.location === 'boloo.required_subtasks.0' && issue.status === 'FIXED_PENDING_QA') {
          issue.status = 'CLOSED'; issue.closed_at = iso(); issue.close_reason = 'SOP03_PROVIDER_CHILD_RESULT_QA_PASS'; issue.updated_at = iso(); issueClosed = true;
        }
      }
      if (issueClosed) {
        child.open_error_count = activeIssueCount(child); child.error_code = null; child.error_message = null;
        child.qa.boloo_keywords = { status: 'NOT_RUN', checked_at: null, report: null };
        await commit(dataRoot, child, 'SOP03_PROVIDER_CHILD_RESULT_QA_PASS', { parent_sku: parentId, source_id: child.provider_child_task.source_id, subtask_id: providerSubtask.subtask_id, request_id: result.request_id, evidence_ref: evidenceRef });
      }
    }
    Object.assign(link, {
      status: providerSubtask.status, provider_method: result?.provider_method || 'BOLOO_OFFICIAL_WEB', provider_request_id: result?.request_id || null,
      exact_strings: providerSubtask.status === 'PASS' ? (result?.result?.keywords || []).map(item => typeof item === 'string' ? item : item?.keyword).filter(item => typeof item === 'string' && item.length > 0) : [],
      queried_at: result?.observed_at || null, result_version: result ? resultVersion : null,
      provider_result: result ? clone(result) : null, provider_history: clone(providerSubtask.history || []),
      source_qa_status: sourceQaStatus, evidence_refs: evidenceRef ? [{ type: 'RAW_DOM', reference: evidenceRef, persisted: evidencePersisted, matches_request: evidenceMatches }] : [], evidence_persisted: evidencePersisted, updated_at: iso(),
    });
    const complete = sourceRows.length > 0 && sourceRows.every(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status));
    parent.listing_sop.sop03_sources.BOLOO_COMPETITOR_EXTRACTOR.status = sourceRows.some(item => item.status === 'ERROR') ? 'ERROR' : complete ? 'PASS' : 'RUNNING';
    parent.listing_sop.sop03_sources.BOLOO_COMPETITOR_EXTRACTOR.updated_at = iso();
    await commit(dataRoot, parent, 'SOP03_BOOLOO_PROVIDER_RESULT_RECORDED', { source_id: link.source_id, provider_child_task_id: childId, status: link.status, request_id: link.provider_request_id, result_version: link.result_version, evidence_persisted: evidencePersisted });
    return { parent, child, source: clone(link), result_version: resultVersion, evidence_persisted: evidencePersisted };
  });
}

/** Prepare the LISTING_SOP_06 -> existing boloo_keywords Provider child bridge. */
export async function prepareSop06BolooExplorerQueries(dataRoot, parentSku, { runtimeReadiness, sameDayCacheRows = [], volumeLibraryLookupByExact = {} } = {}) {
  const parentId = productId(parentSku);
  return serialize(parentId, async () => {
    const parent = await readTask(dataRoot, parentId);
    if (!parent) throw Object.assign(new Error(`找不到 SKU ${parentId}`), { code: 'SKU_NOT_FOUND' });
    if (parent.current_step !== 'LISTING_SOP_06' || parent.resume_point !== 'LISTING_SOP_06'
      || parent.status !== 'WAITING_DEPENDENCY' || parent.waiting_dependency_key !== 'BOLOO_WEBVIEW2_PANE') {
      throw Object.assign(new Error('SOP06 exact-key resume 仅允许当前精确等待 BOLOO_WEBVIEW2_PANE 的任务。'), { code: 'SOP06_EXACT_DEPENDENCY_MISMATCH' });
    }
    const sop05 = parent.listing_sop?.steps?.LISTING_SOP_05;
    const sop05Version = sop05?.output_version;
    if (!sop05Version || !/^SOP05-[A-Za-z0-9_-]+$/.test(sop05Version)) {
      throw Object.assign(new Error('当前SKU缺少有效的正式SOP05版本。'), { code: 'SOP06_SOP05_VERSION_MISSING' });
    }
    if (sop05?.status !== 'PASS' || sop05?.qa_status !== 'PASS' || sop05?.output_version !== sop05Version
      || parent.listing_executor?.registry?.LISTING_SOP_05?.output_version !== sop05Version) {
      throw Object.assign(new Error('SOP05 已封板版本与要求的版本不一致。'), { code: 'SOP06_SOP05_VERSION_MISMATCH' });
    }
    const sop05File = path.join(dataRoot, 'artifacts', 'listing', parentId, 'sop05', `${sop05Version}.json`);
    let artifact;
    try { artifact = JSON.parse(await fs.readFile(sop05File, 'utf8')); }
    catch { throw Object.assign(new Error('SOP05 正式候选池工件不存在或不可读。'), { code: 'SOP06_SOP05_ARTIFACT_MISSING' }); }
    const selectedRows = (artifact.candidates || []).filter(item => item.status === 'ACTIVE' && item.eligibility_status === 'ELIGIBLE_FOR_SOP06');
    const exactStrings = selectedRows.map(item => item.exact_string);
    const selectedCount = Number(artifact.selected_for_sop06_count);
    if (artifact.version !== sop05Version || artifact.sku !== parentId || artifact.qa_status !== 'PASS'
      || !Number.isInteger(selectedCount) || selectedCount < 1 || selectedCount !== exactStrings.length
      || exactStrings.some(value => typeof value !== 'string' || !value.trim())
      || new Set(exactStrings).size !== exactStrings.length) {
      throw Object.assign(new Error('SOP05 工件中的 exact strings 数量、SKU或内容不完整。'), { code: 'SOP06_EXACT_STRINGS_MISMATCH' });
    }
    const refs = parent.listing_executor?.registry || {};
    const factVersion = Number(parent.outputs?.confirmed_product_facts?.version || 0);
    const sop03Version = parent.listing_sop?.steps?.LISTING_SOP_03?.output_version;
    const sop04Version = parent.listing_sop?.steps?.LISTING_SOP_04?.output_version;
    for (const [stepId, version] of [['LISTING_SOP_03', sop03Version], ['LISTING_SOP_04', sop04Version]]) {
      const step = parent.listing_sop?.steps?.[stepId];
      if (!version || step?.status !== 'PASS' || step?.qa_status !== 'PASS' || refs[stepId]?.output_version !== version
        || refs[stepId]?.status !== 'PASS' || refs[stepId]?.qa_status !== 'PASS') {
        throw Object.assign(new Error(`${stepId} 版本缺失、未 PASS 或已失效。`), { code: 'SOP06_UPSTREAM_VERSION_INVALID' });
      }
    }
    if (!Number.isInteger(factVersion) || factVersion < 1 || Number(parent.outputs?.confirmed_product_facts?.version) !== factVersion
      || parent.outputs?.confirmed_product_facts?.stale === true) {
      throw Object.assign(new Error('当前SKU确认事实版本无效或已失效。'), { code: 'SOP06_FACTS_VERSION_INVALID' });
    }
    const waitingCount = (parent.listing_executor?.waiting_items || []).filter(item => !item.decided_at).length;
    const confirmationOpen = parent.confirmation?.status === 'OPEN';
    if (waitingCount || confirmationOpen) throw Object.assign(new Error('仍有 WAITING_CONFIRMATION / WAITING_DECISION。'), { code: 'SOP06_WAITING_ITEMS_OPEN' });
    const allTasks = dbFor(dataRoot).prepare('SELECT sku, payload FROM products').all().map(row => ({ sku: row.sku, ...JSON.parse(row.payload) }));
    const activeLeaseRows = dbFor(dataRoot).prepare("SELECT sku_id, COUNT(*) AS n FROM listing_execution_leases WHERE sku_id IN (SELECT sku FROM products) AND state IN ('RUNNING','ACQUIRED','RECOVERING') GROUP BY sku_id").all();
    const activeLeaseSkus = new Set(activeLeaseRows.filter(row => Number(row.n) > 0).map(row => row.sku_id));
    const duplicateRunning = allTasks.filter(item => item.provider_child_task?.parent_sku === parentId
      && item.provider_child_task?.parent_sop_step === 'LISTING_SOP_06'
      && item.status === 'RUNNING'
      && (item.boloo?.required_subtasks || []).some(subtask => ['RUNNING', 'PENDING_RECHECK'].includes(subtask.status))
      && activeLeaseSkus.has(item.sku));
    if (duplicateRunning.length) throw Object.assign(new Error('检测到仍持有有效 lease 的 SOP06 Provider child；为避免重复正式请求，先等待该 execution 结束。'), { code: 'SOP06_QUERY_ALREADY_RUNNING', children: duplicateRunning.map(item => item.sku) });
    const existingRows = parent.listing_sop?.sop06_keyword_queries?.required_subtasks || [];
    if (existingRows.length && existingRows.some((item, index) => item.exact_string !== exactStrings[index])) {
      throw Object.assign(new Error('既有 SOP06 清单与封板 SOP05 exact-string 序列不一致。'), { code: 'SOP06_MANIFEST_MISMATCH' });
    }

    const now = iso();
    parent.listing_sop ||= {};
    parent.listing_sop.sop06_keyword_queries ||= {
      sop05_version: sop05Version, confirmed_product_facts_version: factVersion,
      sop03_artifact_version: sop03Version, sop04_artifact_version: sop04Version,
      required_subtasks: selectedRows.map((candidate, index) => ({
        ordinal: index + 1, exact_string: candidate.exact_string, source_refs: clone(candidate.source_refs || []),
        evidence_refs: clone(candidate.evidence_refs || []), source_version: sop05Version,
        status: 'NOT_STARTED', result_version: null, provider_request_id: null, queried_at: null,
        provider_method: null, volume: null, evidence_refs_result: [], provider_result: null,
        provider_history: [], provider_child_task_id: null, updated_at: now,
      })),
      status: 'RUNNING', updated_at: now,
    };
    const queryState = parent.listing_sop.sop06_keyword_queries;
    queryState.required_exact_string_count = selectedCount;
    if (queryState.required_subtasks.length !== selectedCount || queryState.sop05_version !== sop05Version
      || Number(queryState.confirmed_product_facts_version) !== factVersion
      || queryState.sop03_artifact_version !== sop03Version || queryState.sop04_artifact_version !== sop04Version) {
      throw Object.assign(new Error('SOP06 query manifest 上游版本或数量与当前封板输入不一致。'), { code: 'SOP06_MANIFEST_VERSION_MISMATCH' });
    }
    const cacheByQuery = new Map((Array.isArray(sameDayCacheRows) ? sameDayCacheRows : []).map(row => [row.query_text || row.exactString, row]));
    const allResultsCached = exactStrings.every(exact => cacheByQuery.has(exact));
    if (!allResultsCached && (!runtimeReadiness || runtimeReadiness.status !== 'READY' || !Number.isInteger(Number(runtimeReadiness.pane_pid))
      || runtimeReadiness.bridge_status !== 'READY' || runtimeReadiness.explorer_status !== 'READY')) {
      throw Object.assign(new Error('存在 Keyword Library MISS；Pane / Explorer / bridge runtime snapshot 尚未 READY。'), { code: 'WAITING_DEPENDENCY_BOOLO_WEBVIEW2_PANE' });
    }
    if (!allResultsCached && !isOfficialWebBolooReady()) throw Object.assign(new Error('存在 Keyword Library MISS；BOLOO_OFFICIAL_WEB readiness 未 READY。'), { code: 'WAITING_DEPENDENCY_BOOLOO_OFFICIAL_WEB' });
    let operationRecoveryEvidenceId = null;
    const failedOperationExact = parent.sop06_pane_recovery_context?.exact_string;
    if (failedOperationExact) {
      const recoveryRow = queryState.required_subtasks.find(item => item.exact_string === failedOperationExact);
      const operationKey = buildSop06OperationKey({ sku: parentId, exactString: failedOperationExact });
      const circuit = parent.sop06_operation_circuits?.[operationKey];
      if (!recoveryRow || circuit?.state === 'OPEN') {
        throw Object.assign(new Error('SOP06 operation circuit is open or its exact-string recovery row is missing.'), { code: 'SOP06_OPERATION_CIRCUIT_OPEN' });
      }
      if (circuit?.state === 'WAITING_RECOVERY_EVIDENCE') {
        const recovery = buildSop06OperationRecoveryEvidence({ circuit, paneReadiness: runtimeReadiness, officialWebReady: isOfficialWebBolooReady() });
        if (!recovery.allowed) throw Object.assign(new Error('A fresh operation-scoped Pane recovery evidence record is required before dispatch.'), {
          code: 'SOP06_OPERATION_RECOVERY_EVIDENCE_REQUIRED', details: { reason: recovery.reason, operation_key: operationKey },
        });
        circuit.state = 'RECOVERY_AUTHORIZED';
        circuit.recovery_evidence = recovery.evidence;
        circuit.updated_at = iso();
        operationRecoveryEvidenceId = recovery.evidence.evidence_id;
      } else if (circuit?.state === 'RECOVERY_AUTHORIZED'
        && circuit.recovery_evidence?.status === 'AVAILABLE'
        && circuit.recovery_evidence.operation_key === operationKey) {
        operationRecoveryEvidenceId = circuit.recovery_evidence.evidence_id;
      } else if (circuit && circuit.state !== 'CLOSED') {
        throw Object.assign(new Error('SOP06 operation circuit is not in a dispatchable state.'), {
          code: 'SOP06_OPERATION_RECOVERY_EVIDENCE_REQUIRED', details: { operation_key: operationKey, state: circuit.state },
        });
      }
    }
    for (const row of queryState.required_subtasks) {
      const lookup = volumeLibraryLookupByExact?.[row.exact_string] || null;
      row.volume_library_lookup = lookup ? clone(lookup) : { status: 'MISS', exact_string: row.exact_string };
    }
    parent.listing_sop.current_step_id = 'LISTING_SOP_06';
    parent.current_step = 'LISTING_SOP_06'; parent.resume_point = 'LISTING_SOP_06';
    parent.waiting_dependency_key = null; parent.status = 'RUNNING';
    parent.activity_pool = '关键词池'; parent.current_pool = parent.activity_pool;
    parent.stage_qa_status = 'NOT_RUN'; parent.error_code = null; parent.error_message = null;
    parent.qa.LISTING_SOP_06 = { status: 'NOT_RUN', checked_at: null, report: null };
    parent.stages.LISTING_SOP_06 = { ...parent.stages.LISTING_SOP_06, status: 'RUNNING', dependency: 'BOLOO_WEBVIEW2_PANE', dependency_status: 'READY', updated_at: now };
    parent.listing_sop.steps.LISTING_SOP_06 = { ...parent.listing_sop.steps.LISTING_SOP_06, status: 'RUNNING', qa_status: 'NOT_RUN', input_version_refs: [
      { artifact_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL', version: sop05Version },
      { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: factVersion },
      { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
      { artifact_type: 'LISTING_SOP_04_RELATED_TERMS_VERSION', version: sop04Version },
    ], updated_at: now };
    queryState.status = 'RUNNING'; queryState.started_at ||= now; queryState.updated_at = now;
    parent.sop06_runtime_readiness = clone(runtimeReadiness || { status: 'NOT_REQUIRED', source: 'ALL_EXACT_STRINGS_LIBRARY_HIT' });
    await commit(dataRoot, parent, 'DEPENDENCY_BECAME_READY', { step: 'LISTING_SOP_06', dependency: allResultsCached ? 'BOL_KEYWORD_VOLUME_LIBRARY' : 'BOLOO_WEBVIEW2_PANE', exact_key_match: true, runtime_status: allResultsCached ? 'NOT_REQUIRED' : runtimeReadiness.status, pane_pid: runtimeReadiness?.pane_pid || null, preflight: {
      sop05_version: sop05Version, exact_string_count: exactStrings.length, confirmed_product_facts_version: factVersion,
      sop03_artifact_version: sop03Version, sop04_artifact_version: sop04Version,
      BOLOO_OFFICIAL_WEB_READY: allResultsCached ? 'NOT_REQUIRED' : true, BOLOO_WEBVIEW2_PANE_READY: allResultsCached ? 'NOT_REQUIRED' : true, bridge_ready: allResultsCached ? 'NOT_REQUIRED' : true,
      duplicate_inflight_count: 0, waiting_confirmation_count: waitingCount, waiting_decision_count: waitingCount,
      operation_recovery_evidence_id: operationRecoveryEvidenceId,
    } });

    const manifest = [];
    for (const row of queryState.required_subtasks) {
      const existingChild = row.provider_child_task_id ? await readTask(dataRoot, row.provider_child_task_id) : null;
      const digest = crypto.createHash('sha256').update(`${parentId}\0LISTING_SOP_06\0${row.exact_string}`, 'utf8').digest('hex').slice(0, 24);
      const childId = row.provider_child_task_id || `BCHILD-S06-${digest}`;
      let child = existingChild || await readTask(dataRoot, childId);
      if (!child) {
        child = clone(parent); const childNow = iso();
        child.id = childId; child.sku = childId; child.revision = 0; child.created_at = childNow; child.updated_at = childNow;
        child.master = { ...child.master, sku: childId };
        child.provider_child_task = { parent_sku: parentId, parent_sop_step: 'LISTING_SOP_06', provider_stage: 'boloo_keywords', provider: 'BOLOO_OFFICIAL_WEB', task_type: 'KEYWORD_EXPLORER', exact_string: row.exact_string, source_id: null, hidden_from_product_dashboard: true, created_at: childNow };
        child.current_step = 'boloo_keywords'; child.resume_point = 'boloo_keywords'; child.last_success_step = 'LISTING_SOP_05';
        child.status = 'QUEUED'; child.waiting_dependency_key = null; child.activity_pool = '关键词池'; child.current_pool = '关键词池';
        child.stage_qa_status = 'NOT_RUN'; child.error_code = null; child.error_message = null; child.issues = []; child.open_error_count = 0;
        child.final_archive = null; child.outputs = {}; child.issues = [];
        child.qa = { ...child.qa, boloo_keywords: { status: 'NOT_RUN', checked_at: null, report: null } };
        child.stages = { ...child.stages, boloo_keywords: { ...(child.stages?.boloo_keywords || {}), label: 'SOP06 Keyword Explorer Provider 子任务', status: 'QUEUED', updated_at: childNow } };
        child.boloo = { required_subtasks: [], current_subtask_id: null, current_source_id: null, candidates: [], keyword_discovery_closed: false, discovery_close_evidence: null };
        await commit(dataRoot, child, 'SOP06_BOOLOO_EXPLORER_CHILD_CREATED', { parent_sku: parentId, parent_sop_step: 'LISTING_SOP_06', exact_string: row.exact_string, provider: 'BOLOO_OFFICIAL_WEB', provider_stage: 'boloo_keywords', task_type: 'KEYWORD_EXPLORER' });
        const cache = cacheByQuery.get(row.exact_string);
        const configured = await configureBolooRequiredSubtasks(dataRoot, childId, {
          explorer_queries: [row.exact_string], explorer_origin: `LISTING_SOP_06:${sop05Version}`,
          same_day_boloo_pass_cache: cache ? [cache] : [],
        });
        child = configured.task;
      }
      const childSubtask = child.boloo?.required_subtasks?.[0];
      if (!childSubtask || childSubtask.provider_source !== 'keyword_explorer' || childSubtask.query_text !== row.exact_string
        || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_06') {
        throw Object.assign(new Error(`SOP06 Provider child ${childId} exact-string 或父子关系不匹配。`), { code: 'SOP06_PROVIDER_CHILD_MISMATCH' });
      }
      if (child.provider_child_task.source_id !== childSubtask.source_id) {
        child.provider_child_task.source_id = childSubtask.source_id;
        await commit(dataRoot, child, 'SOP06_PROVIDER_CHILD_SOURCE_LINKED', { parent_sku: parentId, exact_string: row.exact_string, source_id: childSubtask.source_id, subtask_id: childSubtask.subtask_id });
      }
      // A pane wait preserves the failed attempt and parks the child as
      // WAITING_DEPENDENCY + PENDING_RECHECK. Once the parent has passed its
      // exact-key readiness preflight, re-arm that same child without creating
      // a new child or erasing its request history.
      const childActiveLeaseCount = Number(dbFor(dataRoot).prepare(
        "SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state IN ('RUNNING','ACQUIRED','RECOVERING')",
      ).get(childId)?.n || 0);
      if (childActiveLeaseCount > 0) {
        throw Object.assign(new Error(`SOP06 child ${childId} still owns an active execution lease.`), { code: 'SOP06_PROVIDER_CHILD_ALREADY_ACTIVE' });
      }
      const previousChildStatus = child.status;
      const previousSubtaskStatus = childSubtask.status;
      const rearmedAt = iso();
      const operationKey = buildSop06OperationKey({ sku: parentId, exactString: row.exact_string });
      const operationCircuit = parent.sop06_operation_circuits?.[operationKey];
      const operationRecoveryAuthorized = operationCircuit?.state === 'RECOVERY_AUTHORIZED'
        && operationCircuit.recovery_evidence?.status === 'AVAILABLE'
        && operationCircuit.recovery_evidence.operation_key === operationKey;
      if (rearmSop06PaneChildAfterReadiness(child, rearmedAt, {
        activeLeaseCount: childActiveLeaseCount, operationRecoveryAuthorized,
      })) {
        const eventType = previousChildStatus === 'RUNNING'
          ? 'SOP06_PROVIDER_CHILD_ORPHANED_RUNNING_REQUEUED'
          : 'SOP06_PROVIDER_CHILD_REARMED_AFTER_PANE_READY';
        await commit(dataRoot, child, eventType, {
          parent_sku: parentId, exact_string: row.exact_string, subtask_id: childSubtask.subtask_id,
          rearm_reason: previousChildStatus === 'WAITING_DEPENDENCY' ? 'FRESH_PANE_READINESS'
            : previousChildStatus === 'RUNNING' ? 'NO_ACTIVE_EXECUTION_LEASE'
              : (Number(childSubtask.attempt_count || 0) > 0 || (childSubtask.history || []).length > 0)
                ? 'EXACT_OPERATION_RECOVERY_AUTHORIZED' : 'ACCEPTANCE_HOLD_RELEASED_UNSTARTED_CHILD',
          previous_child_status: previousChildStatus,
          previous_subtask_status: previousSubtaskStatus,
          preserved_attempt_count: childSubtask.attempt_count, request_history_count: (childSubtask.history || []).length,
          active_lease_count: childActiveLeaseCount, operation_recovery_authorized: operationRecoveryAuthorized,
          provider_requests_sent_during_reconciliation: 0,
        });
      }
      row.provider_child_task_id = childId; row.subtask_id = childSubtask.subtask_id; row.source_id = childSubtask.source_id;
      row.status = childSubtask.status; row.result_version = row.result_version || null; row.updated_at = iso();
      manifest.push({ exact_string: row.exact_string, child_id: childId, status: childSubtask.status, cache_hit: childSubtask.result?.cache_reused === true });
      await commit(dataRoot, parent, 'SOP06_BOOLOO_EXPLORER_CHILD_ATTACHED', { exact_string: row.exact_string, provider_child_task_id: childId, subtask_id: childSubtask.subtask_id, cache_hit: childSubtask.result?.cache_reused === true });
    }
    return { task: await readTask(dataRoot, parentId), manifest };
  });
}

/** Re-arm only a pane-waiting child after the caller has passed readiness preflight. */
export function rearmSop06PaneChildAfterReadiness(child, now = iso(), { activeLeaseCount = 0, operationRecoveryAuthorized = false } = {}) {
  const subtask = child?.boloo?.required_subtasks?.[0];
  if (Number(activeLeaseCount) !== 0) return false;
  const paneWait = child?.status === 'WAITING_DEPENDENCY' && child.waiting_dependency_key === 'BOLOO_WEBVIEW2_PANE'
    && subtask?.status === 'PENDING_RECHECK';
  const priorAttempts = Number(subtask?.attempt_count || 0) > 0
    || (Array.isArray(subtask?.request_ids) && subtask.request_ids.length > 0)
    || (Array.isArray(subtask?.history) && subtask.history.length > 0);
  const noCurrentResult = !subtask?.result;
  const safeUnstarted = !priorAttempts;
  const safePausedNoResult = ['PAUSED', 'QUEUED'].includes(child?.status)
    && ['NOT_STARTED', 'ERROR', 'PENDING_RECHECK'].includes(subtask?.status)
    && noCurrentResult && (safeUnstarted || operationRecoveryAuthorized);
  const orphanedRunningNoLease = child?.status === 'RUNNING'
    && ['RUNNING', 'NOT_STARTED', 'ERROR', 'PENDING_RECHECK'].includes(subtask?.status)
    && noCurrentResult && (safeUnstarted || operationRecoveryAuthorized);
  if ((!paneWait && !safePausedNoResult && !orphanedRunningNoLease)
    || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_06'
    || child.provider_child_task?.task_type !== 'KEYWORD_EXPLORER'
    || child.provider_child_task?.exact_string !== subtask?.query_text
    || subtask?.provider_source !== 'keyword_explorer') return false;
  if (safePausedNoResult || orphanedRunningNoLease) subtask.status = priorAttempts ? 'PENDING_RECHECK' : 'NOT_STARTED';
  child.status = 'RUNNING'; child.waiting_dependency_key = null;
  child.error_code = null; child.error_message = null;
  child.stages ||= {}; child.stages.boloo_keywords = { ...child.stages.boloo_keywords, status: 'RUNNING', dependency: 'BOLOO_WEBVIEW2_PANE', updated_at: now };
  child.qa ||= {}; child.qa.boloo_keywords = { status: 'NOT_RUN', checked_at: null, report: null };
  return true;
}

/** Persist and verify one Explorer result without running the parent discovery gate. */
export async function recordSop06BolooExplorerChildResult(dataRoot, parentSku, childSku, {
  expectedParentRevision = null, expectedChildRevision = null, localSuccessReconciliation = false,
} = {}) {
  const parentId = productId(parentSku), childId = productId(childSku);
  return serialize(parentId, async () => {
    const parent = await readTask(dataRoot, parentId), child = await readTask(dataRoot, childId);
    if (!parent || !child || parent.current_step !== 'LISTING_SOP_06'
      || child.provider_child_task?.parent_sku !== parentId || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_06') {
      throw Object.assign(new Error('SOP06 parent/Provider child 关联无效。'), { code: 'SOP06_PROVIDER_PARENT_MISMATCH' });
    }
    if (expectedParentRevision !== null) assertTaskRevisionCAS(expectedParentRevision, parent.revision);
    if (expectedChildRevision !== null) assertTaskRevisionCAS(expectedChildRevision, child.revision);
    if (localSuccessReconciliation) {
      const scope = acceptanceRecoveryControlScope.getStore();
      if (!ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1'
        || !acceptanceMode(dataRoot) || scope?.action !== 'RECONCILE_SOP06_SUCCESS_CHECKPOINT'
        || scope?.sku !== parentId || scope?.acceptance_data_root !== true) {
        throw Object.assign(new Error('Local SOP06 success reconciliation requires its exact HOLD-only control scope.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_SCOPE_REJECTED' });
      }
      if (parent.status !== 'PAUSED' || parent.resume_point !== 'LISTING_SOP_06'
        || parent.last_success_step !== 'LISTING_SOP_05' || parent.qa?.LISTING_SOP_06?.status !== 'NOT_RUN'
        || Number(parent.open_error_count || 0) !== 0) {
        throw Object.assign(new Error('The parent task must remain paused at its unpassed SOP06 checkpoint with no open errors.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_STATE_MISMATCH' });
      }
      const activeLeases = dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id IN (?,?) AND state IN ('RUNNING','ACQUIRED','RECOVERING')")
        .get(parentId, childId)?.n || 0;
      if (Number(activeLeases) !== 0) throw Object.assign(new Error('SOP06 checkpoint reconciliation is forbidden while either parent or child has an active lease.'), { code: 'SOP06_CHECKPOINT_RECONCILIATION_ACTIVE_LEASE' });
    }
    const subtask = child.boloo?.required_subtasks?.[0];
    const result = subtask?.result;
    const row = parent.listing_sop?.sop06_keyword_queries?.required_subtasks?.find(item => item.exact_string === child.provider_child_task.exact_string && item.provider_child_task_id === childId);
    if (!row || !subtask || subtask.provider_source !== 'keyword_explorer' || subtask.query_text !== row.exact_string
      || result?.query_text !== row.exact_string || result?.subtask_id !== subtask.subtask_id || result?.source_id !== subtask.source_id
      || !subtask.request_ids?.includes(result.request_id) || !subtask.history?.some(item => item.request_id === result.request_id)) {
      throw Object.assign(new Error('SOP06 Provider Result 与 exact string / request / subtask 关联不完整。'), { code: 'SOP06_PROVIDER_RESULT_MISMATCH' });
    }
    const evidenceRef = result?.evidence?.dom_evidence_ref?.reference || result?.evidence?.raw_dom_evidence_ref?.reference || null;
    let evidence = null;
    if (evidenceRef) {
      try { evidence = JSON.parse(await fs.readFile(evidenceRef, 'utf8')); }
      catch { throw Object.assign(new Error('SOP06 RAW/DOM evidence 不存在或不可解析。'), { code: 'SOP06_PROVIDER_EVIDENCE_MISSING' }); }
    }
    const cacheReuse = result?.cache_reused === true;
    const evidenceMatches = cacheReuse
      ? result?.evidence?.matched_query === row.exact_string && result?.evidence?.source === 'BOLOO_OFFICIAL_VERIFIED'
        && ['BOLOO_OFFICIAL_WEB', 'BOLOO_OFFICIAL_MCP'].includes(result?.evidence?.provider_method)
      : (() => {
        let host = '';
        try { host = new URL(evidence?.raw_response?.page_url || '').hostname; } catch { /* Invalid evidence fails below. */ }
        return evidence?.operation === 'keyword_explorer' && evidence.query_text === row.exact_string
          && evidence.request_id === result.request_id && evidence.raw_response?.matched_query === row.exact_string
          && evidence.raw_response?.page_url && (host === 'boloo.co' || host.endsWith('.boloo.co'));
      })();
    const success = ['PASS', 'PASS_NO_RESULT'].includes(subtask.status) && result.status === subtask.status;
    if (success && (!evidenceMatches || !evidenceRef)) throw Object.assign(new Error('SOP06 结果缺少匹配的、持久化的官方 RAW/DOM evidence。'), { code: 'SOP06_PROVIDER_EVIDENCE_MISMATCH' });
    if (subtask.status === 'PASS' && (!Number.isFinite(result.result?.search_volume) || result.result.search_volume < 0
      || !['RESULT_FOUND', 'EXPLORER_ZERO_VOLUME'].includes(result.reason_code)
      || !matchesDisplayedVolume(result.evidence.displayed_value, result.result.search_volume))) {
      throw Object.assign(new Error('SOP06 PASS 缺少与官方页面显示一致的月均搜索量。'), { code: 'SOP06_VOLUME_INVALID' });
    }
    if (subtask.status === 'PASS_NO_RESULT' && (result.reason_code !== 'EXPLORER_NO_RESULTS' || result.evidence.no_result_confirmed !== true)) {
      throw Object.assign(new Error('SOP06 PASS_NO_RESULT 缺少明确无结果状态。'), { code: 'SOP06_NO_RESULT_INVALID' });
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify({ exact_string: row.exact_string, history: subtask.history, result, upstream: parent.listing_sop.sop06_keyword_queries }), 'utf8').digest('hex');
    const resultVersion = `SOP06-QUERY-${digest.slice(0, 20)}`;
    row.status = subtask.status; row.reason_code = result.reason_code; row.provider_method = cacheReuse ? result.evidence.provider_method : 'BOLOO_OFFICIAL_WEB';
    row.provider_request_id = result.request_id; row.attempt = Number(result.attempt || 0); row.queried_at = result.observed_at;
    row.volume = subtask.status === 'PASS' ? result.result.search_volume : null; row.result_version = resultVersion;
    row.cache_reused = cacheReuse; row.evidence_refs_result = evidenceRef ? [{ type: cacheReuse ? 'RAW_DOM_CACHE' : 'RAW_DOM', reference: evidenceRef, persisted: true, matches_request: evidenceMatches }] : [];
    row.volume_library_lookup ||= { status: cacheReuse ? 'HIT_TODAY' : 'MISS', exact_string: row.exact_string };
    if (success) {
      row.volume_library_lookup = cacheReuse
        ? { ...row.volume_library_lookup, status: 'HIT_TODAY', evidence_ref: evidenceRef, reused_count: 1 }
        : { ...row.volume_library_lookup, status: 'MISS_QUERY_COMPLETED', evidence_ref: evidenceRef, query_date: row.queried_at?.slice(0, 10), reused_count: 0 };
    }
    row.provider_result = clone(result); row.provider_history = clone(subtask.history || []); row.updated_at = iso();
    row.qa_status = success ? 'PASS' : 'NOT_RUN';
    if (success) {
      const operationKey = buildSop06OperationKey({ sku: parentId, exactString: row.exact_string });
      const priorCircuit = parent.sop06_operation_circuits?.[operationKey];
      if (priorCircuit) {
        parent.sop06_operation_circuits[operationKey] = {
          ...priorCircuit, state: 'CLOSED', failure_count: 0,
          recovery_evidence: priorCircuit.recovery_evidence?.status === 'CONSUMED'
            ? { ...priorCircuit.recovery_evidence, status: 'CONSUMED' } : null,
          last_success: { exact_string: row.exact_string, request_id: result.request_id, completed_at: iso() },
          updated_at: iso(),
        };
      }
      child.qa.boloo_keywords = { status: 'PASS', checked_at: iso(), report: [], scope: 'ONE_SOP06_EXPLORER_RESULT_ONLY', exact_string: row.exact_string, request_id: result.request_id, evidence_ref: evidenceRef, result_version: resultVersion };
      child.stages.boloo_keywords = { ...child.stages.boloo_keywords, status: 'QA_PASS', updated_at: iso() };
      child.stage_qa_status = 'PASS'; child.status = 'PASS'; child.activity_pool = '关键词池'; child.current_pool = child.activity_pool;
      child.error_code = null; child.error_message = null; child.open_error_count = activeIssueCount(child);
      await commit(dataRoot, child, 'SOP06_PROVIDER_CHILD_RESULT_QA_PASS', { parent_sku: parentId, exact_string: row.exact_string, request_id: result.request_id, result_version: resultVersion, evidence_ref: evidenceRef, discovery_gate_executed: false },
        expectedChildRevision === null ? {} : { expectedRevision: expectedChildRevision });
    }
    if (localSuccessReconciliation) {
      parent.current_step = 'LISTING_SOP_06'; parent.resume_point = 'LISTING_SOP_06';
      parent.listing_sop.current_step_id = 'LISTING_SOP_06';
      parent.status = 'WAITING_DEPENDENCY'; parent.waiting_dependency_key = 'BOLOO_WEBVIEW2_PANE';
      parent.error_code = null; parent.error_message = null;
      parent.qa.LISTING_SOP_06 = { status: 'NOT_RUN', checked_at: null, report: null };
      parent.stages.LISTING_SOP_06 = { ...parent.stages.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_WEBVIEW2_PANE', dependency_status: 'NOT_CHECKED', updated_at: iso() };
      parent.listing_sop.steps.LISTING_SOP_06 = { ...parent.listing_sop.steps.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: 'EXPLICIT_PANE_PREFLIGHT_REQUIRED', updated_at: iso() };
      parent.listing_sop.sop06_keyword_queries.status = 'WAITING_DEPENDENCY';
      parent.listing_sop.sop06_keyword_queries.updated_at = iso();
    }
    const parentEventType = localSuccessReconciliation ? 'SOP06_BOOLOO_EXPLORER_RESULT_RECONCILED' : 'SOP06_BOOLOO_EXPLORER_RESULT_RECORDED';
    await commit(dataRoot, parent, parentEventType, { exact_string: row.exact_string, provider_child_task_id: childId, status: row.status, reason_code: row.reason_code, request_id: row.provider_request_id, attempt: row.attempt, result_version: row.result_version, cache_reused: cacheReuse, evidence_ref: evidenceRef,
      ...(localSuccessReconciliation ? { checkpoint_reconciliation: true, explicit_pane_preflight_required: true, provider_requests: 0, leases_created: 0, executor_dispatched: false, dependency_resume: false } : {}) },
    expectedParentRevision === null ? {} : { expectedRevision: expectedParentRevision });
    return { parent: await readTask(dataRoot, parentId), child, query: clone(row) };
  });
}

export async function attachSop06KeywordLibraryRecord(dataRoot, parentSku, exactString, libraryRecord, { expectedParentRevision = null } = {}) {
  const parentId = productId(parentSku);
  return serialize(parentId, async () => {
    const parent = await readTask(dataRoot, parentId);
    if (expectedParentRevision !== null) assertTaskRevisionCAS(expectedParentRevision, parent?.revision);
    const row = parent?.listing_sop?.sop06_keyword_queries?.required_subtasks?.find(item => item.exact_string === exactString);
    if (!parent || parent.current_step !== 'LISTING_SOP_06' || row?.status !== 'PASS' || row.qa_status !== 'PASS'
      || row.cache_reused === true || !libraryRecord?.record_id
      || (libraryRecord.keyword_exact ?? libraryRecord.exactString) !== exactString
      || libraryRecord.marketplace !== 'BOL_NL' || libraryRecord.language !== 'nl-NL'
      || libraryRecord.metric !== 'Gemiddeld zoekvolume per maand' || libraryRecord.monthly_volume !== row.volume
      || !row.evidence_refs_result?.some(ref => ref.persisted && ref.matches_request && path.resolve(ref.reference) === path.resolve(libraryRecord.evidence_ref))) {
      throw Object.assign(new Error('SOP06 Keyword Library entry must match a completed, individually QA-passed exact-string result.'), { code: 'SOP06_KEYWORD_LIBRARY_LINK_INVALID' });
    }
    row.volume_library_lookup = { status: 'MISS_QUERY_COMPLETED', source_record: libraryRecord.record_id,
      query_date: libraryRecord.query_date, reused_count: 0, evidence_ref: libraryRecord.evidence_ref,
      identity: { marketplace: libraryRecord.marketplace, language: libraryRecord.language, metric: libraryRecord.metric } };
    await commit(dataRoot, parent, 'SOP06_KEYWORD_VOLUME_LIBRARY_RECORD_LINKED', { exact_string: exactString,
      source_record: libraryRecord.record_id, query_date: libraryRecord.query_date, marketplace: libraryRecord.marketplace,
      language: libraryRecord.language, metric: libraryRecord.metric, evidence_ref: libraryRecord.evidence_ref },
      expectedParentRevision === null ? {} : { expectedRevision: expectedParentRevision });
    return { task: parent, row: clone(row) };
  });
}

/** A Pane/bridge loss is a runtime dependency wait, never a parent SKU business ERROR. */
export async function waitSop06ForBolooPane(dataRoot, parentSku, childSku, { reasonCode = 'BOLOO_WEBVIEW2_BRIDGE_UNAVAILABLE', requestId = null } = {}) {
  const parentId = productId(parentSku), childId = productId(childSku);
  return serialize(parentId, async () => {
    const parent = await readTask(dataRoot, parentId), child = await readTask(dataRoot, childId);
    if (!parent || !child || child.provider_child_task?.parent_sku !== parentId || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_06') {
      throw Object.assign(new Error('SOP06 Pane recovery child linkage is invalid.'), { code: 'SOP06_PROVIDER_PARENT_MISMATCH' });
    }
    const subtask = child.boloo?.required_subtasks?.[0];
    const row = parent.listing_sop?.sop06_keyword_queries?.required_subtasks?.find(item => item.provider_child_task_id === childId);
    if (!subtask || !row || subtask.query_text !== row.exact_string) throw Object.assign(new Error('SOP06 Pane recovery exact-string checkpoint is missing.'), { code: 'SOP06_RESUME_CONTEXT_MISSING' });
    const paneAtFailure = await readFreshBolooPaneRuntimeReadiness();
    const now = iso();
    const failedRequestId = requestId || subtask.result?.request_id || subtask.request_ids?.at(-1) || null;
    parent.sop06_operation_circuits ||= {};
    const operationKey = buildSop06OperationKey({ sku: parentId, exactString: row.exact_string });
    const circuit = buildSop06OperationCircuitFailure({ sku: parentId, exactString: row.exact_string,
      history: subtask.history || [], failedAt: now, requestId: failedRequestId, reasonCode,
      failedPane: { pid: paneAtFailure.pane_pid || null, process_started_at: paneAtFailure.pane_process_started_at || null,
        checked_at: paneAtFailure.checked_at || null } });
    parent.sop06_operation_circuits[operationKey] = circuit;
    row.last_failed_status = subtask.status;
    row.last_error_code = reasonCode;
    row.last_failed_request_id = failedRequestId;
    row.status = 'PENDING_RECHECK'; row.qa_status = 'NOT_RUN'; row.updated_at = now;
    subtask.status = 'PENDING_RECHECK'; subtask.error_code = null; subtask.retry_count = Number(subtask.retry_count || 0) + 1; subtask.updated_at = now;
    child.status = 'WAITING_DEPENDENCY'; child.waiting_dependency_key = 'BOLOO_WEBVIEW2_PANE'; child.resume_point = 'boloo_keywords';
    child.error_code = null; child.error_message = null;
    for (const issue of child.issues || []) {
      if (issue.step === 'boloo_keywords' && issue.status === 'OPEN' && ['NAVIGATION_FAILED', 'NETWORK_FAILED', 'UNKNOWN_PROVIDER_ERROR'].includes(issue.code)) {
        issue.status = 'CLOSED'; issue.closed_at = now; issue.close_reason = 'RECLASSIFIED_AS_BOLOO_WEBVIEW2_PANE_DEPENDENCY'; issue.updated_at = now;
      }
    }
    child.open_error_count = activeIssueCount(child);
    child.stages.boloo_keywords = { ...child.stages.boloo_keywords, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_WEBVIEW2_PANE', updated_at: now };
    child.qa.boloo_keywords = { status: 'NOT_RUN', checked_at: null, report: null };
    await commit(dataRoot, child, 'SOP06_PROVIDER_CHILD_WAITING_FOR_PANE', { parent_sku: parentId, exact_string: row.exact_string, reason_code: reasonCode, request_id: row.last_failed_request_id, attempt_context_preserved: true });

    if (parent.current_step !== 'LISTING_SOP_06') throw Object.assign(new Error('SOP06 parent cursor changed before runtime dependency recovery.'), { code: 'SOP06_PARENT_STEP_REQUIRED' });
    parent.current_step = 'LISTING_SOP_06'; parent.resume_point = 'LISTING_SOP_06'; parent.listing_sop.current_step_id = 'LISTING_SOP_06';
    parent.status = 'WAITING_DEPENDENCY'; parent.waiting_dependency_key = 'BOLOO_WEBVIEW2_PANE';
    parent.dependency_failed_at = now; parent.required_readiness_after = now;
    parent.sop06_pane_recovery_context = {
      schema_version: 1, state: 'WAITING_FOR_RECOVERY_EVIDENCE', dependency: 'BOLOO_WEBVIEW2_PANE',
      reason_code: reasonCode, exact_string: row.exact_string, request_id: failedRequestId,
      dependency_failed_at: now, required_readiness_after: now,
      failed_pane: { pid: paneAtFailure.pane_pid || null, process_started_at: paneAtFailure.pane_process_started_at || null,
        checked_at: paneAtFailure.checked_at || null, source: paneAtFailure.source || null },
      recovery_requirement: ['BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT'].includes(reasonCode)
        ? 'NEW_PANE_PROCESS_STARTED_AFTER_FAILURE'
        : 'FRESH_PANE_AND_BRIDGE_READINESS_AFTER_FAILURE',
      operation_key: operationKey,
      operation_circuit_state: circuit.state,
      operation_failure_count: circuit.failure_count,
    };
    parent.error_code = null; parent.error_message = null; parent.open_error_count = activeIssueCount(parent);
    parent.qa.LISTING_SOP_06 = { status: 'NOT_RUN', checked_at: null, report: null };
    parent.stages.LISTING_SOP_06 = { ...parent.stages.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_WEBVIEW2_PANE', dependency_status: 'NOT_READY', updated_at: now };
    parent.listing_sop.steps.LISTING_SOP_06 = { ...parent.listing_sop.steps.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: reasonCode, updated_at: now };
    parent.activity_pool = '关键词池'; parent.current_pool = parent.activity_pool;
    parent.listing_sop.sop06_keyword_queries.status = 'WAITING_DEPENDENCY'; parent.listing_sop.sop06_keyword_queries.updated_at = now;
    await commit(dataRoot, parent, 'STEP_REMOTE_CALL_FAILED', { step: 'LISTING_SOP_06', exact_string: row.exact_string,
      dependency: 'BOLOO_WEBVIEW2_PANE', request_id: row.last_failed_request_id, error_code: reasonCode,
      dependency_failed_at: now, required_readiness_after: now, failed_pane: parent.sop06_pane_recovery_context.failed_pane,
      operation_key: operationKey, operation_circuit_state: circuit.state, operation_failure_count: circuit.failure_count,
      recovery_requirement: parent.sop06_pane_recovery_context.recovery_requirement,
      open_error_created: false, resume_point: 'LISTING_SOP_06' });
    return { task: await readTask(dataRoot, parentId), child: await readTask(dataRoot, childId), exact_string: row.exact_string };
  });
}

/**
 * Local, no-dispatch repair for the narrow orphaned SOP06 case where a
 * navigation timeout was persisted but the worker lease closed FAILED before
 * the parent could enter its dependency wait. This never calls a Provider.
 */
async function reconcileSop06OrphanedPaneTimeout(dataRoot, parentSku, payload = {}) {
  const parentId = productId(parentSku);
    const parent = await readTask(dataRoot, parentId);
    if (!parent) throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_05 task not found.'), { code: 'SKU_NOT_FOUND' });
    assertTaskRevisionCAS(payload.expected_revision, parent.revision);
    if (!ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1'
      || !acceptanceMode(dataRoot) || parent.current_step !== 'LISTING_SOP_06'
      || parent.resume_point !== 'LISTING_SOP_06' || parent.status !== 'RUNNING'
      || parent.last_success_step !== 'LISTING_SOP_05' || parent.qa?.LISTING_SOP_06?.status !== 'NOT_RUN'
      || Number(parent.open_error_count || 0) !== 0 || activeIssueCount(parent) !== 0
      || Object.keys(payload).some(key => !['expected_revision'].includes(key))) {
      throw Object.assign(new Error('Orphaned SOP06 reconciliation scope does not match a no-lease RUNNING checkpoint.'), { code: 'SOP06_ORPHAN_RECONCILIATION_SCOPE_REJECTED' });
    }
    const db = dbFor(dataRoot);
    const rows = parent.listing_sop?.sop06_keyword_queries?.required_subtasks || [];
    if (!rows.length) throw Object.assign(new Error('SOP06 query manifest is missing.'), { code: 'SOP06_MANIFEST_MISSING' });
    const activeStateSql = "state IN ('RUNNING','ACQUIRED','RECOVERING')";
    const parentLeaseCount = Number(db.prepare(`SELECT COUNT(*) n FROM listing_execution_leases WHERE sku_id=? AND ${activeStateSql}`).get(parentId)?.n || 0);
    if (parentLeaseCount) throw Object.assign(new Error('An SOP06 execution lease is still active.'), { code: 'SOP06_ORPHAN_RECONCILIATION_ACTIVE_LEASE' });
    const failedLease = db.prepare("SELECT execution_id,ended_at FROM listing_execution_leases WHERE sku_id=? AND step='LISTING_SOP_06' AND state='FAILED' ORDER BY COALESCE(ended_at,started_at) DESC LIMIT 1").get(parentId);
    if (!failedLease) throw Object.assign(new Error('No failed SOP06 lease exists to reconcile.'), { code: 'SOP06_FAILED_LEASE_NOT_FOUND' });
    const candidates = rows.filter(row => row.status === 'ERROR' && row.reason_code === 'UNKNOWN_PROVIDER_ERROR'
      && /Timed out waiting for Boloo WebView2 NavigationCompleted/i.test(String(row.provider_result?.error_message || row.provider_result?.error?.message || ''))
      && row.provider_child_task_id && row.provider_request_id);
    if (candidates.length !== 1) throw Object.assign(new Error('Expected exactly one persisted WebView2 navigation-timeout result.'), { code: 'SOP06_NAVIGATION_TIMEOUT_EVIDENCE_AMBIGUOUS' });
    const row = candidates[0];
    const childId = row.provider_child_task_id;
    const child = await readTask(dataRoot, childId);
    const subtask = child?.boloo?.required_subtasks?.[0];
    if (!child || child.provider_child_task?.parent_sku !== parentId || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_06'
      || child.provider_child_task?.exact_string !== row.exact_string || child.status !== 'ERROR'
      || subtask?.status !== 'ERROR' || subtask.query_text !== row.exact_string
      || !subtask.request_ids?.includes(row.provider_request_id)
      || !subtask.history?.some(item => item.request_id === row.provider_request_id
        && /Timed out waiting for Boloo WebView2 NavigationCompleted/i.test(String(item.error?.message || item.error_message || '')))) {
      throw Object.assign(new Error('Provider child and failed attempt identity did not match the parent checkpoint.'), { code: 'SOP06_CHILD_FAILURE_IDENTITY_MISMATCH' });
    }
    const childIds = [...new Set(rows.map(item => item.provider_child_task_id).filter(Boolean))];
    const anyChildActive = childIds.some(id => Number(db.prepare(`SELECT COUNT(*) n FROM listing_execution_leases WHERE sku_id=? AND ${activeStateSql}`).get(id)?.n || 0) > 0);
    if (anyChildActive || rows.some(item => item.provider_child_task_id && item.provider_child_task_id !== childId
      && ['RUNNING', 'PENDING_RECHECK'].includes(item.status))) {
      throw Object.assign(new Error('Another SOP06 provider child is in flight; refusing local reconciliation.'), { code: 'SOP06_ORPHAN_RECONCILIATION_CHILD_IN_FLIGHT' });
    }
    const rawRef = (row.evidence_refs_result || []).find(ref => ref.persisted && ref.reference)?.reference;
    if (!rawRef) throw Object.assign(new Error('Persisted raw evidence reference is missing.'), { code: 'SOP06_NAVIGATION_TIMEOUT_RAW_EVIDENCE_MISSING' });
    const raw = JSON.parse(await fs.readFile(safeMaterialPath(dataRoot, rawRef), 'utf8'));
    if (raw.request_id !== row.provider_request_id || raw.query_text !== row.exact_string
      || raw.operation !== 'keyword_explorer' || raw.raw_response?.status !== 'ERROR'
      || raw.raw_response?.reason_code !== 'UNKNOWN_PROVIDER_ERROR'
      || !/Timed out waiting for Boloo WebView2 NavigationCompleted/i.test(String(raw.raw_response?.error || ''))) {
      throw Object.assign(new Error('Persisted raw evidence does not prove the matching WebView2 navigation timeout.'), { code: 'SOP06_NAVIGATION_TIMEOUT_RAW_EVIDENCE_MISMATCH' });
    }
    const now = iso();
    const artifactBase = { schema_version: 1, artifact_type: 'SOP06_ORPHANED_PANE_TIMEOUT_RECONCILIATION', sku: parentId,
      revision_before: parent.revision, failed_execution_id: failedLease.execution_id, child_sku: childId,
      exact_string: row.exact_string, request_id: row.provider_request_id, original_reason_code: row.reason_code,
      raw_evidence_ref: rawRef, observed_at: raw.observed_at_utc, target: { status: 'WAITING_DEPENDENCY', step: 'LISTING_SOP_06', dependency: 'BOLOO_WEBVIEW2_PANE' }, created_at: now };
    const version = `SOP06-RECOVERY-${crypto.createHash('sha256').update(JSON.stringify(artifactBase)).digest('hex').slice(0, 20)}`;
    const artifact = { ...artifactBase, version };
    const artifactRef = path.join('artifacts', 'listing', parentId, 'sop06', 'recovery', `${version}.json`).replace(/\\/g, '/');
    const artifactPath = safeMaterialPath(dataRoot, artifactRef);
    await writeAtomicJson(artifactPath, artifact);

    row.last_failed_status = row.status; row.last_error_code = row.reason_code;
    row.last_failed_request_id = row.provider_request_id; row.status = 'PENDING_RECHECK'; row.qa_status = 'NOT_RUN'; row.updated_at = now;
    subtask.status = 'PENDING_RECHECK'; subtask.error_code = null; subtask.retry_count = Number(subtask.retry_count || 0) + 1; subtask.updated_at = now;
    child.status = 'WAITING_DEPENDENCY'; child.waiting_dependency_key = 'BOLOO_WEBVIEW2_PANE'; child.resume_point = 'boloo_keywords';
    child.error_code = null; child.error_message = null; child.qa.boloo_keywords = { status: 'NOT_RUN', checked_at: null, report: null };
    child.stages.boloo_keywords = { ...child.stages.boloo_keywords, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_WEBVIEW2_PANE', updated_at: now };
    for (const issue of child.issues || []) if (issue.status === 'OPEN' && issue.code === 'UNKNOWN_PROVIDER_ERROR') {
      issue.status = 'CLOSED'; issue.closed_at = now; issue.close_reason = 'RECLASSIFIED_AS_BOLOO_WEBVIEW2_PANE_DEPENDENCY'; issue.updated_at = now;
    }
    child.open_error_count = activeIssueCount(child);
    await commit(dataRoot, child, 'SOP06_PROVIDER_CHILD_WAITING_FOR_PANE', { parent_sku: parentId, exact_string: row.exact_string,
      reason_code: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', request_id: row.provider_request_id, attempt_context_preserved: true }, { expectedRevision: child.revision });

    parent.current_step = 'LISTING_SOP_06'; parent.resume_point = 'LISTING_SOP_06'; parent.status = 'WAITING_DEPENDENCY';
    parent.waiting_dependency_key = 'BOLOO_WEBVIEW2_PANE'; parent.error_code = null; parent.error_message = null;
    parent.qa.LISTING_SOP_06 = { status: 'NOT_RUN', checked_at: null, report: null };
    parent.stages.LISTING_SOP_06 = { ...parent.stages.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', dependency: 'BOLOO_WEBVIEW2_PANE', dependency_status: 'READY', updated_at: now };
    parent.listing_sop.steps.LISTING_SOP_06 = { ...parent.listing_sop.steps.LISTING_SOP_06, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', waiting_reason: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', updated_at: now };
    parent.listing_sop.sop06_keyword_queries.status = 'WAITING_DEPENDENCY'; parent.listing_sop.sop06_keyword_queries.updated_at = now;
    parent.sop06_orphan_recovery = { artifact_ref: artifactRef, artifact_version: version, failed_execution_id: failedLease.execution_id,
      exact_string: row.exact_string, request_id: row.provider_request_id, recovered_at: now, provider_requests: 0 };
    await commit(dataRoot, parent, 'SOP06_ORPHANED_PANE_TIMEOUT_RECONCILED', { step: 'LISTING_SOP_06', dependency: 'BOLOO_WEBVIEW2_PANE',
      failed_execution_id: failedLease.execution_id, exact_string: row.exact_string, request_id: row.provider_request_id,
      artifact_ref: artifactRef, artifact_version: version, open_error_created: false, provider_requests: 0, executor_dispatched: false }, { expectedRevision: payload.expected_revision });
    return { task: await readTask(dataRoot, parentId), child: await readTask(dataRoot, childId), artifact_ref: artifactRef, artifact_version: version,
      provider_requests: 0, leases_created: 0, executor_dispatched: false };
}

/** Stage-QA every selected exact query, archive an immutable SOP06 artifact, then honor the TOP20 executor gate. */
export async function finalizeSop06BolooExplorer(dataRoot, parentSku) {
  const parentId = productId(parentSku);
  return serialize(parentId, async () => {
    const task = await readTask(dataRoot, parentId);
    if (!task || task.current_step !== 'LISTING_SOP_06') throw Object.assign(new Error('SOP06 final QA requires the parent to remain at LISTING_SOP_06.'), { code: 'SOP06_PARENT_STEP_REQUIRED' });
    const queryState = task.listing_sop?.sop06_keyword_queries;
    const rows = queryState?.required_subtasks || [];
    const problems = [];
    if (!rows.length || rows.length !== Number(queryState?.required_exact_string_count || rows.length)) problems.push('required exact-string count must match sealed SOP05 selection');
    if (new Set(rows.map(item => item.exact_string)).size !== rows.length) problems.push('duplicate exact strings are not allowed');
    if (rows.some(item => !['PASS', 'PASS_NO_RESULT'].includes(item.status) || item.qa_status !== 'PASS' || !item.result_version || !item.provider_request_id || !item.queried_at || !item.evidence_refs_result?.some(ref => ref.persisted && ref.matches_request))) problems.push('every exact string must have a completed Provider result, QA, version, request, timestamp, and evidence');
    if (rows.some(item => item.status === 'PASS' && (!Number.isFinite(item.volume) || item.volume < 0))) problems.push('every PASS query must retain the official nonnegative search volume');
    if (Number(task.open_error_count || 0) !== 0 || activeIssueCount(task) !== 0) problems.push('OPEN_ERROR_COUNT must be zero');
    if ((task.listing_executor?.waiting_items || []).some(item => !item.decided_at)) problems.push('WAITING_CONFIRMATION / WAITING_DECISION must be zero');
    if (queryState?.sop05_version !== task.listing_sop.steps.LISTING_SOP_05.output_version
      || queryState?.sop03_artifact_version !== task.listing_sop.steps.LISTING_SOP_03.output_version
      || queryState?.sop04_artifact_version !== task.listing_sop.steps.LISTING_SOP_04.output_version
      || Number(queryState?.confirmed_product_facts_version) !== Number(task.outputs?.confirmed_product_facts?.version)) problems.push('upstream facts/SOP03/SOP04/SOP05 versions changed');
    if (problems.length) {
      task.qa.LISTING_SOP_06 = { status: 'FAIL', checked_at: iso(), report: problems };
      task.stages.LISTING_SOP_06 = { ...task.stages.LISTING_SOP_06, status: 'QA_FAIL', updated_at: iso() };
      task.listing_sop.steps.LISTING_SOP_06 = { ...task.listing_sop.steps.LISTING_SOP_06, status: 'QA_FAIL', qa_status: 'FAIL', updated_at: iso() };
      task.listing_sop.sop06_keyword_queries.status = 'QA_FAIL';
      await commit(dataRoot, task, 'LISTING_SOP_06_STAGE_QA_FAIL', { problems, completed_count: rows.filter(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status)).length });
      return { passed: false, task, report: problems };
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify({ sku: parentId, upstream: queryState, rows: rows.map(item => ({ exact_string: item.exact_string, status: item.status, result_version: item.result_version, volume: item.volume })) }), 'utf8').digest('hex');
    const version = `SOP06-${digest.slice(0, 20)}`;
    const artifact = { schema_version: 1, artifact_type: 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES', sop_step_id: 'LISTING_SOP_06', sku: parentId, version, status: 'PASS', qa_status: 'PASS', confirmed_product_facts_version: queryState.confirmed_product_facts_version, sop03_artifact_version: queryState.sop03_artifact_version, sop04_artifact_version: queryState.sop04_artifact_version, sop05_version: queryState.sop05_version, results: clone(rows), provider_method: 'BOLOO_OFFICIAL_WEB', created_at: iso() };
    const artifactFile = path.join(dataRoot, 'artifacts', 'listing', parentId, 'sop06', `${version}.json`);
    await atomicJson(artifactFile, artifact);
    task.outputs ||= {}; task.outputs.LISTING_SOP_06 = clone(artifact);
    task.listing_executor.artifacts ||= {}; task.listing_executor.artifacts.listing_outputs ||= {};
    task.listing_executor.artifacts.listing_outputs.LISTING_SOP_06 = clone(artifact);
    task.listing_executor.registry.LISTING_SOP_06 = { ...task.listing_executor.registry.LISTING_SOP_06, status: 'PASS', qa_status: 'PASS', output_version: version, waiting_reason: null, stale_reason: null, evidence_refs: [path.relative(dataRoot, artifactFile).replace(/\\/g, '/')], input_version_refs: [
      { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: queryState.confirmed_product_facts_version },
      { artifact_type: 'LISTING_SOP_03_SOURCE_DISCOVERY_VERSION', version: queryState.sop03_artifact_version },
      { artifact_type: 'LISTING_SOP_04_RELATED_TERMS_VERSION', version: queryState.sop04_artifact_version },
      { artifact_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL', version: queryState.sop05_version },
    ], completed_at: iso(), updated_at: iso() };
    task.listing_sop.steps.LISTING_SOP_06 = { ...task.listing_sop.steps.LISTING_SOP_06, status: 'PASS', qa_status: 'PASS', output_version: version, waiting_reason: null, stale_reason: null, completed_at: iso(), updated_at: iso() };
    task.listing_sop.sop06_keyword_queries.status = 'PASS'; task.listing_sop.sop06_keyword_queries.output_version = version; task.listing_sop.sop06_keyword_queries.qa_status = 'PASS'; task.listing_sop.sop06_keyword_queries.completed_at = iso();
    task.qa.LISTING_SOP_06 = { status: 'PASS', checked_at: iso(), report: [], checks: [
      { code: 'SOP05_VERSION', pass: true }, { code: 'EXACT_STRING_COUNT_MATCHES_SOP05', pass: true },
      { code: 'EVERY_RESULT_COMPLETE_AND_EVIDENCED', pass: true }, { code: 'OFFICIAL_VOLUME_VALID', pass: true },
      { code: 'UPSTREAM_VERSIONS_CURRENT', pass: true }, { code: 'OPEN_ERROR_COUNT_ZERO', pass: true },
    ], artifact_version: version, artifact_path: path.relative(dataRoot, artifactFile).replace(/\\/g, '/') };
    task.stages.LISTING_SOP_06 = { ...task.stages.LISTING_SOP_06, status: 'PASS', qa_status: 'PASS', dependency: null, dependency_status: 'READY', updated_at: iso() };
    task.last_success_step = 'LISTING_SOP_06'; task.stage_qa_status = 'PASS'; task.waiting_dependency_key = null;
    task.current_step = 'LISTING_SOP_07'; task.resume_point = 'LISTING_SOP_07'; task.listing_sop.current_step_id = 'LISTING_SOP_07';
    task.qa.LISTING_SOP_07 = { status: 'NOT_RUN', checked_at: null, report: null };
    const now = iso();
    task.stages.LISTING_SOP_07 = { ...task.stages.LISTING_SOP_07, status: 'WAITING_DEPENDENCY', dependency: 'TOP20_EXECUTOR', dependency_status: 'NOT_READY', updated_at: now };
    task.listing_sop.steps.LISTING_SOP_07 = { ...task.listing_sop.steps.LISTING_SOP_07, status: 'WAITING_DEPENDENCY', qa_status: 'NOT_RUN', input_version_refs: [{ artifact_type: 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES', version }], updated_at: now };
    task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'TOP20_EXECUTOR'; task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.sidecars.keywords = { ...task.sidecars.keywords, status: 'WAITING_DEPENDENCY', dependency: 'TOP20_EXECUTOR', updated_at: now };
    await commit(dataRoot, task, 'LISTING_SOP_06_STAGE_QA_PASS', { version, artifact_path: path.relative(dataRoot, artifactFile).replace(/\\/g, '/'), query_count: rows.length, cache_hit_count: rows.filter(item => item.cache_reused).length, next_step: 'LISTING_SOP_07', next_dependency: 'TOP20_EXECUTOR', executor_ready: isTop20ExecutorReady() });
    return { passed: true, task, artifact, artifact_path: artifactFile, next_step: task.current_step, waiting_dependency_key: task.waiting_dependency_key };
  });
}

export async function clearPassedSop06WaitingReason(dataRoot, parentSku) {
  const parentId = productId(parentSku);
  return serialize(parentId, async () => {
    const task = await readTask(dataRoot, parentId);
    if (!task || task.listing_sop?.steps?.LISTING_SOP_06?.status !== 'PASS'
      || task.qa?.LISTING_SOP_06?.status !== 'PASS') throw Object.assign(new Error('Only a passed SOP06 can clear its former waiting annotation.'), { code: 'SOP06_NOT_PASSED' });
    const step = task.listing_sop.steps.LISTING_SOP_06;
    const registry = task.listing_executor?.registry?.LISTING_SOP_06;
    if (!step.waiting_reason && !registry?.waiting_reason) return { task, changed: false };
    step.waiting_reason = null; step.stale_reason = null; step.updated_at = iso();
    if (registry) { registry.waiting_reason = null; registry.stale_reason = null; registry.updated_at = iso(); }
    await commit(dataRoot, task, 'SOP06_OBSOLETE_WAITING_REASON_CLEARED', { step: 'LISTING_SOP_06', preserved_status: 'PASS' });
    return { task, changed: true };
  });
}

export async function finalizeSop03BolooProviderSources(dataRoot, sku, localSourceAudit = {}, options = {}) {
  const id = productId(sku);
  if (options.localEvidenceRevalidation === true && (id !== 'SYNTHETIC-SKU-LEGACY-10' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot))) {
    throw Object.assign(new Error('本地证据重核模式仅允许在 SYNTHETIC_ACCEPTANCE_10 的 4181 acceptance 数据根运行。'), { code: 'SYNTHETIC_ACCEPTANCE_10_ACCEPTANCE_ROOT_REQUIRED' });
  }
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task || task.current_step !== 'LISTING_SOP_03') throw Object.assign(new Error('SKU is not at LISTING_SOP_03.'), { code: 'SOP03_PARENT_STEP_REQUIRED' });
    const sources = task.listing_sop?.sop03_sources;
    const boloo = sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
    for (const item of boloo) {
      item.exact_strings = (item.exact_strings || []).map(value => typeof value === 'string' ? value : value?.keyword).filter(value => typeof value === 'string' && value.length > 0);
    }
    const bolooComplete = boloo.length > 0 && boloo.every(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status));
    if (activeIssueCount(task) > 0 || Number(task.open_error_count || 0) > 0) throw Object.assign(new Error('SOP03 父级仍有 OPEN_ERROR，不能通过聚合 QA。'), { code: 'SOP03_REQUIRED_SOURCE_OPEN_ERRORS' });
    const imported = task.master?.excel_source_import;
    const fields = imported?.fields || {};
    const factVersion = task.outputs?.confirmed_product_facts?.evidence?.version || task.outputs?.confirmed_product_facts?.version || null;
    const competitorSources = task.competitor_url_list || [];
    const expectedFields = ['bol_direct_competitor', 'bol_similar_competitor_1', 'bol_similar_competitor_2', 'bol_similar_competitor_3', 'bol_similar_competitor_4'];
    const expectedUrls = expectedFields.map(key => {
      const field = fields[key];
      return String(field?.raw_value || field?.acceptance_original_raw_value || '').trim();
    });
    if (!imported?.source_file_hash || !factVersion || expectedUrls.some(url => !isValidBolProductUrl(url))
      || expectedUrls.some(url => !competitorSources.some(source => source.exact_url === url && source.usable_for_boloo_extractor === true))) {
      throw Object.assign(new Error('SOP03 本地来源 QA 未通过：五条真实 BOL URL、confirmed facts version 或正式 Extractor 输入不完整。'), { code: 'SOP03_LOCAL_SOURCE_QA_FAILED' });
    }
    if (boloo.length !== 5 || !bolooComplete || boloo.some((item, index) => item.source_url !== expectedUrls[index] || !['PASS', 'PASS_NO_RESULT'].includes(item.status)
      || item.source_qa_status !== 'PASS' || item.evidence_persisted !== true
      || !item.evidence_refs?.some(ref => ref.persisted === true && ref.matches_request === true))) {
      throw Object.assign(new Error('SOP03 Boloo 来源清单必须完整覆盖 J12–N12，且每条结果与 evidence/request/version 可追溯。'), { code: 'SOP03_REQUIRED_SOURCE_EVIDENCE_INCOMPLETE' });
    }
    for (const item of boloo) {
      let child = await readTask(dataRoot, item.provider_child_task_id);
      if (!child || child.provider_child_task?.parent_sku !== id || child.provider_child_task?.parent_sop_step !== 'LISTING_SOP_03') {
        throw Object.assign(new Error(`SOP03 必需来源 ${item.source_id} 的 child task 缺失或父级关联错误。`), { code: 'SOP03_REQUIRED_SOURCE_CHILD_QA_INCOMPLETE' });
      }
      // A persisted result/source link is not a substitute for the required
      // provider-child QA. Re-run the scoped, local-only QA before aggregation;
      // this validates the exact result and RAW/DOM evidence without calling
      // the Provider or applying the parent discovery close gate.
      const childQa = await verifyBolooProviderChild(dataRoot, child);
      if (!childQa?.passed) {
        throw Object.assign(new Error(`SOP03 必需来源 ${item.source_id} 的 child result/evidence QA 未通过。`), {
          code: 'SOP03_REQUIRED_SOURCE_CHILD_QA_INCOMPLETE', child_qa_report: childQa?.report || [],
        });
      }
      child = await readTask(dataRoot, item.provider_child_task_id);
      const childSubtask = child?.boloo?.required_subtasks?.[0];
      const currentEvidence = childSubtask?.result?.evidence?.dom_evidence_ref?.reference;
      if (child.qa?.boloo_keywords?.status !== 'PASS' || child.qa?.boloo_keywords?.scope !== 'PROVIDER_CHILD_RESULT_ONLY'
        || child.open_error_count !== 0 || activeIssueCount(child) !== 0 || childSubtask?.status !== item.status
        || childSubtask?.result?.request_id !== item.provider_request_id || !currentEvidence
        || !item.evidence_refs.some(ref => ref.reference === currentEvidence && ref.matches_request === true)) {
        throw Object.assign(new Error(`SOP03 必需来源 ${item.source_id} 尚未通过独立 child QA、无 OPEN_ERROR 或关联证据校验。`), { code: 'SOP03_REQUIRED_SOURCE_CHILD_QA_INCOMPLETE' });
      }
    }
    if (localSourceAudit.source_file_hash !== imported.source_file_hash) throw Object.assign(new Error('本地来源审计与 Product Master 工作簿哈希不一致。'), { code: 'SOP03_LOCAL_SOURCE_EVIDENCE_MISMATCH' });
    const bolEvidence = Array.isArray(localSourceAudit.bol_evidence_map) ? localSourceAudit.bol_evidence_map : [];
    const amazonRefs = Array.isArray(localSourceAudit.amazon_evidence_cells) ? localSourceAudit.amazon_evidence_cells : [];
    const sourceFieldForCell = cell => Object.entries(fields).find(([, value]) => value?.cell_reference === cell);
    for (const evidence of bolEvidence) {
      const [fieldKey, field] = sourceFieldForCell(evidence.cell) || [];
      if (!field || !String(field.raw_value || '').includes(evidence.evidence_id || 'DISPIMG(')) throw Object.assign(new Error(`BOL 本地证据 ${evidence.cell} 与导入快照不匹配。`), { code: 'SOP03_LOCAL_SOURCE_EVIDENCE_MISMATCH' });
      if (evidence.mapped_competitor_field && !expectedFields.includes(evidence.mapped_competitor_field)) throw Object.assign(new Error(`BOL 本地证据 ${evidence.cell} 的竞品映射字段无效。`), { code: 'SOP03_LOCAL_SOURCE_EVIDENCE_MISMATCH' });
      evidence.source_field = fieldKey;
      evidence.header_name = field.header_name;
    }
    // The confirmed URL fields themselves are first-class source evidence.
    // Screenshot artifacts are optional enrichment and must not be forced into
    // a URL mapping when their visible content does not establish that link.
    const bolUrlSourceEvidence = expectedFields.map((fieldKey, index) => {
      const field = fields[fieldKey];
      const cell = field?.cell_reference;
      if (!field || !cell || !expectedUrls[index]) throw Object.assign(new Error(`BOL 来源 URL 缺少可验证的工作簿单元格：${fieldKey}`), { code: 'SOP03_LOCAL_SOURCE_QA_FAILED' });
      return {
        source_field: fieldKey, source_header: field.header_name, source_cell: cell,
        exact_url: expectedUrls[index], evidence_type: 'LEON_CONFIRMED_WORKBOOK_URL',
        evidence_ref: `excel-source://${encodeURIComponent(imported.source_file)}/${encodeURIComponent(imported.sheet)}/${encodeURIComponent(cell)}/v${imported.version}`,
        source_file_hash: imported.source_file_hash, import_version: imported.version,
      };
    });
    for (const cell of amazonRefs) {
      const [fieldKey, field] = sourceFieldForCell(cell) || [];
      if (!field || !['amazon_reference', 'amazon_supplementary_reference', 'amazon_description_reference'].includes(fieldKey)) throw Object.assign(new Error(`Amazon 本地证据 ${cell} 与已导入来源不匹配。`), { code: 'SOP03_LOCAL_SOURCE_EVIDENCE_MISMATCH' });
    }
    const unassigned = Array.isArray(localSourceAudit.unassigned_evidence) ? localSourceAudit.unassigned_evidence : [];
    for (const evidence of unassigned) {
      const [fieldKey, field] = sourceFieldForCell(evidence.cell) || [];
      if (!field || !String(field.raw_value || '').includes(evidence.evidence_id || 'DISPIMG(')) throw Object.assign(new Error(`未分配证据 ${evidence.cell} 与导入快照不匹配。`), { code: 'SOP03_LOCAL_SOURCE_EVIDENCE_MISMATCH' });
      evidence.source_field = fieldKey;
      evidence.header_name = field.header_name;
      evidence.status = 'UNASSIGNED_EVIDENCE';
    }
    const amazonLocalSource = validateSop03AmazonLocalSource(fields, amazonRefs, localSourceAudit.amazon_expressions);
    const keywordMining = Array.isArray(localSourceAudit.keyword_mining) ? localSourceAudit.keyword_mining : [];
    if (options.requireKeywordMining === true && !keywordMining.length) {
      throw Object.assign(new Error('本地证据重核要求存在 BOL_LOCAL_KEYWORD_MINING 输出。'), { code: 'SOP03_BOL_KEYWORD_MINING_MISSING' });
    }
    const miningCategories = new Set(['CORE_PRODUCT', 'FUNCTION', 'ATTRIBUTE', 'SCENARIO', 'LOCAL_EXPRESSION']);
    for (const item of keywordMining) {
      const urlIndex = expectedUrls.indexOf(item.source_url);
      const sourceCell = item.source_cell;
      const [fieldKey, field] = sourceFieldForCell(sourceCell) || [];
      let slug = '';
      try { slug = decodeURIComponent(new URL(item.source_url).pathname.split('/').filter(Boolean)[3] || '').replace(/-/g, ' '); } catch {}
      if (urlIndex < 0 || !field || fieldKey !== expectedFields[urlIndex]
        || item.source_title_slug !== decodeURIComponent(new URL(item.source_url).pathname.split('/').filter(Boolean)[3] || '')
        || !miningCategories.has(item.category) || typeof item.exact_string !== 'string' || !item.exact_string.trim()
        || !slug.toLocaleLowerCase('nl-NL').includes(item.exact_string.toLocaleLowerCase('nl-NL'))
        || item.language !== 'nl' || item.source_file_hash !== imported.source_file_hash || Number(item.import_version) !== Number(imported.version)) {
        throw Object.assign(new Error(`BOL keyword-mining 项缺少与原 URL 单元格/标题路径/导入版本一致的证据：${item?.exact_string || '(empty)'}`), { code: 'SOP03_BOL_KEYWORD_MINING_EVIDENCE_INVALID' });
      }
      item.evidence_ref = `excel-source://${encodeURIComponent(imported.source_file)}/${encodeURIComponent(imported.sheet)}/${encodeURIComponent(sourceCell)}/v${imported.version}`;
      item.facts_version = Number(factVersion);
      item.source_field = fieldKey;
      item.source_header = field.header_name;
      item.source_title = slug;
      item.evidence_type = 'LEON_PROVIDED_BOL_URL_PATH_TITLE';
    }
    const sourceEvidence = {
      schema_version: 1, artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', sku: id,
      source_file: imported.source_file, source_file_hash: imported.source_file_hash,
      source_sheet: imported.sheet, import_version: imported.version,
      facts_version: factVersion, bol_local_source: {
        status: 'PASS', competitor_urls: expectedFields.map((field, index) => ({
          source_field: field, source_header: fields[field]?.header_name,
          source_cell: fields[field]?.cell_reference, exact_url: expectedUrls[index],
          local_expression: (() => { try { return decodeURIComponent(new URL(expectedUrls[index]).pathname.split('/').filter(Boolean)[3] || ''); } catch { return ''; } })(),
          extractor_status: boloo.find(item => item.source_url === expectedUrls[index])?.status || null,
          extractor_result_version: boloo.find(item => item.source_url === expectedUrls[index])?.result_version || null,
      })), source_url_evidence: bolUrlSourceEvidence, evidence_map: bolEvidence,
        keyword_mining: { status: keywordMining.length ? 'PASS' : 'NOT_RUN', exact_strings: keywordMining, source_count: new Set(keywordMining.map(item => item.source_url)).size },
        unassigned_evidence: unassigned,
      },
      amazon_local_source: {
        ...amazonLocalSource, source_language: localSourceAudit.amazon_language || 'de', evidence_cells: amazonRefs,
      },
      boloo_competitor_extractor: boloo.map(item => {
        const exactStrings = (item.exact_strings || []).map(value => typeof value === 'string' ? value : value?.keyword).filter(value => typeof value === 'string' && value.length > 0);
        return { source_id: item.source_id, source_url: item.source_url, status: item.status, provider_method: item.provider_method, provider_request_id: item.provider_request_id, result_version: item.result_version, exact_strings: exactStrings, evidence_refs: item.evidence_refs || [] };
      }),
      created_at: iso(),
    };
    const sourcePath = path.join(dataRoot, 'artifacts', 'listing', id, 'sop03', `${crypto.createHash('sha256').update(JSON.stringify(sourceEvidence)).digest('hex').slice(0, 20)}.json`);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, JSON.stringify(sourceEvidence, null, 2), { encoding: 'utf8', flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST') throw error; });
    const outputVersion = `SOP03-SOURCES-${crypto.createHash('sha256').update(JSON.stringify(sourceEvidence)).digest('hex').slice(0, 20)}`;
    task.outputs ||= {};
    task.outputs.keyword_source_discovery = { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: outputVersion,
      evidence: { evidence_refs: [path.relative(dataRoot, sourcePath).replace(/\\/g, '/')], source_file_hash: imported.source_file_hash, facts_version: factVersion },
      created_at: sourceEvidence.created_at };
    sources.BOL_SOURCE = { ...sources.BOL_SOURCE, status: 'PASS', evidence_refs: [path.relative(dataRoot, sourcePath)], updated_at: iso() };
    sources.AMAZON_SOURCE = { ...sources.AMAZON_SOURCE, status: 'PASS', source_mode: 'LOCAL_SOURCE_AVAILABLE', evidence_refs: amazonRefs, candidate_only: true, updated_at: iso() };
    const bolooAllComplete = boloo.length === 5 && boloo.every(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status) && item.evidence_persisted === true && item.source_qa_status === 'PASS');
    if (!bolooAllComplete) {
      await commit(dataRoot, task, 'SOP03_LOCAL_SOURCES_STRUCTURED', {
        source_artifact: path.relative(dataRoot, sourcePath), bol_local_source: 'PASS', amazon_local_source: 'PASS',
        boloo_complete: false, boloo_statuses: boloo.map(item => ({ source_id: item.source_id, status: item.status, result_version: item.result_version || null })),
      });
      return { task, boloo_complete: false, source_qa_status: 'LOCAL_SOURCES_PASS', source_artifact: path.relative(dataRoot, sourcePath), waiting_dependency: null };
    }
    syncListingExecutorFramework(task, LISTING_SOP_STEPS);
    task.listing_executor.registry.LISTING_SOP_03.required_dependencies = ['BOLOO_OFFICIAL_WEB', 'AMAZON_SOURCE_IF_CONNECTED'];
    const qaReport = { bol_local_source: 'PASS', amazon_local_source: 'PASS', boloo_extractor_sources: boloo.length, required_subtasks_complete: true, required_child_open_error_count: 0, open_error_count: Number(task.open_error_count || 0), source_file_hash: imported.source_file_hash, extractor_volume_numbers_saved_only_in_raw_evidence: true, formal_search_volume_written: false };
    const result = applyListingExecutorStep(task, 'LISTING_SOP_03', {
      status: 'PASS', input_version_refs: [imported.source_file_hash, factVersion, ...boloo.map(item => item.result_version)],
      output: { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: outputVersion, evidence: { evidence_refs: [path.relative(dataRoot, sourcePath)], source_file_hash: imported.source_file_hash, facts_version: factVersion } },
      qa: { status: 'PASS', checked_at: iso(), report: qaReport },
    });
    if (!result.can_advance) throw Object.assign(new Error('SOP03 Stage QA 未达到 PASS 门禁。'), { code: 'SOP03_STAGE_QA_GATE_FAILED' });
    task.qa.LISTING_SOP_03 = { status: 'PASS', checked_at: iso(), report: qaReport };
    task.stages.LISTING_SOP_03 = { ...task.stages.LISTING_SOP_03, status: 'PASS', dependency: null, completed_at: iso(), updated_at: iso() };
    // During a read-only evidence revalidation, do not probe or refresh any
    // remote dependency. Existing downstream evidence is reattached and QA'd
    // separately by revalidateSYNTHETIC_ACCEPTANCE_10Sop04ExistingEvidence.
    const readiness = options.localEvidenceRevalidation === true ? { status: 'PASS', source: 'LOCAL_EVIDENCE_REVALIDATION_NO_PROBE' } : await bolApiReadiness(dataRoot);
    syncListingExecutorFramework(task, LISTING_SOP_STEPS);
    const sop04Status = readiness.status === 'PASS' ? 'QUEUED' : 'WAITING_DEPENDENCY';
    const sop04Patch = { status: sop04Status, reason: sop04Status === 'WAITING_DEPENDENCY' ? '等待 BOL API，用于 LISTING_SOP_04 Search Terms；SOP03 已独立通过。' : undefined, resume_point: 'LISTING_SOP_04' };
    applyListingExecutorStep(task, 'LISTING_SOP_04', sop04Patch);
    task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.listing_sop.current_step_id = 'LISTING_SOP_04';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.waiting_dependency_key = sop04Status === 'WAITING_DEPENDENCY' ? 'BOL_API' : null;
    task.status = sop04Status;
    task.last_success_step = 'LISTING_SOP_03';
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: sop04Status, dependency: task.waiting_dependency_key, updated_at: iso() };
    task.qa.LISTING_SOP_04 = { ...task.qa.LISTING_SOP_04, status: 'NOT_RUN', checked_at: null, report: null };
    await commit(dataRoot, task, 'SOP03_STAGE_QA_PASS_ADVANCED_TO_SOP04', { output_version: outputVersion, source_artifact: path.relative(dataRoot, sourcePath), sop04_status: sop04Status, waiting_dependency_key: task.waiting_dependency_key });
    return { task, boloo_complete: true, source_qa_status: 'PASS', source_artifact: path.relative(dataRoot, sourcePath), output_version: outputVersion, current_step: task.current_step, waiting_dependency: task.waiting_dependency_key };
  });
}

export async function waitSop03ForProviderReadiness(dataRoot, sku, dependencyKey, readiness = {}) {
  const id = productId(sku);
  if (!['BOLOO_OFFICIAL_WEB', 'BOLOO_WEBVIEW2_PANE'].includes(dependencyKey)) {
    throw Object.assign(new Error('Unsupported SOP03 provider dependency.'), { code: 'SOP03_DEPENDENCY_KEY_INVALID' });
  }
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task || task.current_step !== 'LISTING_SOP_03') throw Object.assign(new Error('SOP03 dependency wait requires the current parent step.'), { code: 'SOP03_PARENT_STEP_REQUIRED' });
    task.status = 'WAITING_DEPENDENCY';
    task.waiting_dependency_key = dependencyKey;
    task.resume_point = 'LISTING_SOP_03';
    task.stage_qa_status = 'NOT_RUN';
    task.stages.LISTING_SOP_03 = { ...task.stages.LISTING_SOP_03, status: 'WAITING_DEPENDENCY', dependency: dependencyKey, dependency_status: readiness.status || 'NOT_READY', updated_at: iso() };
    task.qa.LISTING_SOP_03 = { ...task.qa.LISTING_SOP_03, status: 'NOT_RUN', checked_at: null, report: null };
    task.error_code = null; task.error_message = null;
    await commit(dataRoot, task, 'STEP_WAITING_FOR_DEPENDENCY', { step: 'LISTING_SOP_03', dependency: dependencyKey, readiness, external_requests: 0, open_error_created: false });
    return task;
  });
}

/**
 * Offline SYNTHETIC_ACCEPTANCE_10 acceptance revalidation using only already-saved workbook media.
 * This deliberately has no provider client path and refuses production roots.
 */
export async function revalidateSYNTHETIC_ACCEPTANCE_10FactsFromExistingEvidence(dataRoot, sku, { images = [], structured_evidence = null } = {}) {
  const id = productId(sku);
  if (id !== 'SYNTHETIC-SKU-LEGACY-10' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot)) {
    throw Object.assign(new Error('该离线补验只允许在 SYNTHETIC_ACCEPTANCE_10 的 4181 acceptance 数据根执行。'), { code: 'SYNTHETIC_ACCEPTANCE_10_ACCEPTANCE_ROOT_REQUIRED' });
  }
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_10' || task.final_archive) throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 acceptance task 不存在或已归档。'), { code: 'SYNTHETIC_ACCEPTANCE_10_ACCEPTANCE_TASK_REQUIRED' });
    if (task.listing_sop?.source_completeness_revalidation?.facts?.status === 'PASS') {
      return { task, idempotent: true, external_requests: 0, fact_version: task.master.fact_version };
    }
    if (task.current_step !== 'LISTING_SOP_04' || task.qa?.LISTING_SOP_04?.status !== 'PASS') throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 必须从已通过的 SOP04 断点启动前置完整度补验。'), { code: 'SYNTHETIC_ACCEPTANCE_10_REVALIDATION_PRECONDITION_FAILED' });
    const importRecord = task.master.excel_source_import;
    const sourceFields = importRecord?.fields || {};
    if (importRecord?.source_file_hash !== '2cee49f42f2dcb2ba1934e56649049a9f937ccad84e0c3e11f14d21ebbdc1ee3') throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 的只读源工作簿哈希与已确认基线不符。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOURCE_WORKBOOK_HASH_MISMATCH' });
    const expectedAssets = [
      ['1688_sku_reference', 'T12', 'case_a_1688_sku.png'],
      ['1688_attributes_reference', 'U12', 'case_a_1688_attributes.png'],
      ['1688_dimensions_reference', 'V12', 'case_a_1688_dimensions.png'],
      ['1688_packaging_reference', 'W12', 'case_a_1688_packaging.png'],
      ['own_product_image_reference', 'X12', 'case_a_own_product.png'],
    ];
    if (images.length !== expectedAssets.length) throw Object.assign(new Error('必须提供 workbook 中 T12–X12 五项原始嵌入图片证据。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOURCE_ASSET_SET_INVALID' });
    const assets = [];
    for (const [fieldKey, cell, filename] of expectedAssets) {
      const supplied = images.find(item => item.source_cell === cell);
      const source = sourceFields[fieldKey];
      if (!supplied || !source || source.cell_reference !== cell || !String(source.raw_value || '').includes('DISPIMG(')
        || typeof supplied.content_base64 !== 'string' || !supplied.content_base64) throw Object.assign(new Error(`SYNTHETIC_ACCEPTANCE_10 ${cell} 图片引用与当前只读工作簿导入记录不匹配。`), { code: 'SYNTHETIC_ACCEPTANCE_10_SOURCE_ASSET_REFERENCE_MISMATCH' });
      const bytes = Buffer.from(supplied.content_base64, 'base64');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!bytes.length || (supplied.sha256 && supplied.sha256 !== sha256)) throw Object.assign(new Error(`SYNTHETIC_ACCEPTANCE_10 ${cell} 图片 SHA-256 校验失败。`), { code: 'SYNTHETIC_ACCEPTANCE_10_SOURCE_ASSET_HASH_MISMATCH' });
      assets.push({ field_key: fieldKey, source_cell: cell, filename, source_header: source.header_name, source_file_hash: importRecord.source_file_hash, import_version: Number(importRecord.version), bytes, sha256 });
    }
    const packagingContents = '三款12纸袋（正反面不同）+18贴纸';
    if (!structured_evidence || structured_evidence.packaging_contents !== packagingContents
      || structured_evidence.source_workbook_hash !== importRecord.source_file_hash
      || !['采购名称', '1688包装内容截图/文件'].every(header => structured_evidence.supporting_headers?.includes(header))) {
      throw Object.assign(new Error('新增包装内容结构化事实必须与 SYNTHETIC_ACCEPTANCE_10 原文/截图来源一致。'), { code: 'SYNTHETIC_ACCEPTANCE_10_STRUCTURED_FACT_EVIDENCE_INVALID' });
    }
    const sourceFactDocument = {
      schema_version: 1, artifact_type: 'SYNTHETIC_ACCEPTANCE_10_EXISTING_OWN_SOURCE_STRUCTURING', sku: id, source_product_id: 'SYNTHETIC_ACCEPTANCE_10',
      source_workbook: { source_file: importRecord.source_file, sheet: importRecord.sheet, import_version: importRecord.version, sha256: importRecord.source_file_hash },
      facts: { packaging_contents: packagingContents },
      fact_evidence: [{ field: 'packaging_contents', value: packagingContents, status: 'SOURCE_SUPPORTED', supporting_cells: ['G12', 'W12'], supporting_headers: ['采购名称', '1688包装内容截图/文件'], source_file_hash: importRecord.source_file_hash, interpretation: '按原文结构化；未将供应商品牌、未知功能或竞品资料并入自有事实。' }],
      observations_not_promoted_to_confirmed_facts: [
        { field: 'paper_bag_dimensions', values: ['22*12*8CM（高度含折口处2CM）'], status: 'UNKNOWN', source_cell: 'W12', reason: '尺寸轴向/折口测量口径需保持来源原文，未转成确定的长宽高字段。' },
        { field: 'outer_package_dimensions', values: ['23*13*2 cm', '23*13*1.5 cm（12个/包）'], status: 'CONFLICT', source_cells: ['V12', 'W12'], reason: '同一包装层级高度数值不一致，未静默择一。' },
        { field: 'material', values: ['复合材料', '120g牛皮纸'], status: 'CONFLICT', source_cells: ['U12', 'W12'], reason: '1688属性与详情中材质表述不一致。' },
        { field: 'weight', values: ['0.14KG/千克（单袋）', '210g（商品包装）', '15KG/千克（100包外箱）'], status: 'UNKNOWN', source_cell: 'W12', reason: '数值对应不同包装层级，不并入商品重量 kg。' },
        { field: 'supplier_sku', values: ['LB386'], status: 'SOURCE_REFERENCE_ONLY', source_cells: ['T12', 'U12', 'G12'], reason: '供应商款号，不作为我方型号。' },
        { field: 'supplier_brand_label', values: ['馨德理'], status: 'SOURCE_REFERENCE_ONLY', source_cell: 'U12', reason: '供应商页面标签，不作为我方品牌。' },
      ],
      source_assets: assets.map(({ field_key, source_cell, source_header, sha256, source_file_hash, import_version }) => ({ field_key, source_cell, source_header, sha256, source_file_hash, import_version })),
      external_requests: 0, created_at: iso(),
    };
    const addMaterial = async ({ filename, source_type, source_label, source_reference, bytes, content_type }) => {
      const materialId = crypto.randomUUID();
      const ext = path.extname(filename).toLowerCase();
      const relative = path.join('materials', task.id, `${materialId}_v1${ext}`);
      const target = safeMaterialPath(dataRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx' });
      const item = { material_id: materialId, version: 1, original_name: filename, source_type, source_label, source_reference,
        storage_relpath: relative, content_type, byte_length: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), added_at: iso(), active: true };
      task.master.materials ||= []; task.master.materials.push(item);
      task.master.source_refs ||= []; task.master.source_refs.push(`material://${encodeURIComponent(task.sku)}/${materialId}/v1`);
      return item;
    };
    const assetMaterials = [];
    for (const asset of assets) {
      assetMaterials.push(await addMaterial({ filename: asset.filename, source_type: 'OWN_IMAGE', source_label: 'SYNTHETIC_ACCEPTANCE_10 workbook embedded own-source image',
        source_reference: `excel-source://${encodeURIComponent(importRecord.source_file)}/${encodeURIComponent(importRecord.sheet)}/${asset.source_cell}/v${importRecord.version}`, bytes: asset.bytes, content_type: 'image/png' }));
    }
    const factDocBytes = Buffer.from(JSON.stringify(sourceFactDocument, null, 2), 'utf8');
    const factDoc = await addMaterial({ filename: 'case_a_existing_source_fact_structuring.json', source_type: 'OWN_DOCUMENT', source_label: 'SYNTHETIC_ACCEPTANCE_10 existing 1688 source evidence structuring',
      source_reference: `excel-source://${encodeURIComponent(importRecord.source_file)}/${encodeURIComponent(importRecord.sheet)}/W12/v${importRecord.version}`, bytes: factDocBytes, content_type: 'application/json' });
    const oldFactVersion = Number(task.master.fact_version || 1);
    task.master.product_facts ||= {};
    task.master.product_facts.packaging_contents = packagingContents;
    task.master.fact_version = oldFactVersion + 1;
    const staleOutputs = markDependentListingOutputsStale(task, task.master.fact_version, 'SYNTHETIC_ACCEPTANCE_10_EXISTING_OWN_SOURCE_FACTS_STRUCTURED');
    task.listing_sop.source_completeness_revalidation = {
      status: 'RUNNING', facts: { status: 'RUNNING', old_fact_version: oldFactVersion, new_product_master_version: task.master.fact_version,
        new_fact_fields: ['packaging_contents'], unknown_or_conflicting: ['model', 'specifications', 'dimensions', 'weight_kg', 'material', 'color', 'functions', 'accessories'],
        evidence_material_ids: [...assetMaterials.map(item => item.material_id), factDoc.material_id], source_file_hash: importRecord.source_file_hash, external_requests: 0 },
      started_at: iso(),
    };
    task.confirmation = task.confirmation?.status === 'OPEN' ? { ...task.confirmation, status: 'SUPERSEDED', closed_at: iso(), superseded_reason: 'SYNTHETIC_ACCEPTANCE_10_FACT_VERSION_REVALIDATION' } : task.confirmation;
    task.current_step = 'LISTING_SOP_01'; task.resume_point = 'LISTING_SOP_01'; task.listing_sop.current_step_id = 'LISTING_SOP_01';
    task.waiting_dependency_key = null; task.status = 'QUEUED'; task.activity_pool = '资料处理池'; task.current_pool = task.activity_pool;
    task.qa.LISTING_SOP_01 = { status: 'NOT_RUN', checked_at: null, report: null };
    task.qa.LISTING_SOP_02 = { status: 'NOT_RUN', checked_at: null, report: null };
    task.stages.LISTING_SOP_01 = { ...task.stages.LISTING_SOP_01, status: 'QUEUED', updated_at: iso() };
    task.stages.LISTING_SOP_02 = { ...task.stages.LISTING_SOP_02, status: 'NOT_STARTED', updated_at: iso() };
    await commit(dataRoot, task, 'SYNTHETIC_ACCEPTANCE_10_EXISTING_SOURCE_FACTS_REVALIDATION_STARTED', { old_fact_version: oldFactVersion, new_fact_version: task.master.fact_version,
      fact_fields: ['packaging_contents'], evidence_material_ids: [...assetMaterials.map(item => item.material_id), factDoc.material_id], stale_outputs: staleOutputs, external_requests: 0 });
    const executed = await executeListingSop01(dataRoot, task);
    const latest = await readTask(dataRoot, id);
    const sop01Pass = latest?.qa?.LISTING_SOP_01?.status === 'PASS';
    const sop02Pass = latest?.qa?.LISTING_SOP_02?.status === 'PASS';
    const confirmed = latest?.outputs?.confirmed_product_facts?.fields?.packaging_contents;
    if (!sop01Pass || !sop02Pass || latest.current_step !== 'LISTING_SOP_03' || confirmed?.status !== 'CONFIRMED'
      || Number(latest.outputs.confirmed_product_facts.version) !== 2) {
      return { task: latest, sop01_status: latest?.qa?.LISTING_SOP_01?.status, sop02_status: latest?.qa?.LISTING_SOP_02?.status, external_requests: 0, failed_closed: true };
    }
    latest.listing_sop.source_completeness_revalidation.facts = { ...latest.listing_sop.source_completeness_revalidation.facts,
      status: 'PASS', sop01_snapshot_version: latest.outputs.own_materials_snapshot.snapshot_version,
      confirmed_product_facts_version: latest.outputs.confirmed_product_facts.version,
      confirmed_packaging_contents: confirmed.value, qa: { sop01: clone(latest.qa.LISTING_SOP_01), sop02: clone(latest.qa.LISTING_SOP_02) } };
    latest.listing_sop.source_completeness_revalidation.status = 'FACTS_PASS';
    await commit(dataRoot, latest, 'SYNTHETIC_ACCEPTANCE_10_EXISTING_SOURCE_FACTS_REVALIDATION_PASS', { sop01_snapshot_version: latest.outputs.own_materials_snapshot.snapshot_version,
      confirmed_product_facts_version: latest.outputs.confirmed_product_facts.version, external_requests: 0 });
    return { task: latest, idempotent: false, external_requests: 0, sop01_status: 'PASS', sop02_status: 'PASS',
      fact_version: latest.outputs.confirmed_product_facts.version, new_fields: ['packaging_contents'], stale_outputs: staleOutputs, evidence_material: factDoc };
  });
}

/** Rebinds and QA-checks only immutable Search Terms evidence; never calls BOL. */
export async function revalidateSYNTHETIC_ACCEPTANCE_10Sop04ExistingEvidence(dataRoot, sku, { excluded_first_query = [] } = {}) {
  const id = productId(sku);
  if (id !== 'SYNTHETIC-SKU-LEGACY-10' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot)) throw Object.assign(new Error('该 SOP04 离线重核只允许在 SYNTHETIC_ACCEPTANCE_10 4181 acceptance 数据根执行。'), { code: 'SYNTHETIC_ACCEPTANCE_10_ACCEPTANCE_ROOT_REQUIRED' });
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_10' || task.final_archive) throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 acceptance task 不存在或已归档。'), { code: 'SYNTHETIC_ACCEPTANCE_10_ACCEPTANCE_TASK_REQUIRED' });
    if (task.qa?.LISTING_SOP_02?.status !== 'PASS' || task.qa?.LISTING_SOP_03?.status !== 'PASS'
      || task.outputs?.confirmed_product_facts?.version !== 2 || !task.listing_executor?.registry?.LISTING_SOP_03?.output_version) {
      throw Object.assign(new Error('SOP04 重核前要求当前 SOP02/SOP03 已通过，并引用新事实版本。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP04_REVALIDATION_PRECONDITION_FAILED' });
    }
    const approved = ['cadeau zakjes papier', 'cadeauzakjes kerst', 'kerst verpakkingsmateriaal', 'kerst verpakkingsset', 'kerstverpakkingsset'];
    const existing = task.outputs?.bol_keywords;
    const oldRef = existing?.evidence?.artifact_ref;
    if (task.current_step !== 'LISTING_SOP_04' || !oldRef || JSON.stringify((existing.adopted_terms || []).map(item => item.exact_string)) !== JSON.stringify(approved)) {
      throw Object.assign(new Error('SOP04 现有 Final 选择与 Leon 已确认的 SYNTHETIC_ACCEPTANCE_10 五词不一致。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP04_FINAL_SELECTION_MISMATCH' });
    }
    const rawArtifacts = [];
    for (const record of task.listing_sop?.sop04_artifact_versions || []) {
      if (!record.artifact_ref) continue;
      const artifactPath = safeMaterialPath(dataRoot, record.artifact_ref);
      const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
      const terms = artifact.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms;
      if (Array.isArray(terms) && terms.length) rawArtifacts.push({ record, artifact, terms });
    }
    const firstQuery = rawArtifacts.find(row => row.artifact.seed_exact_string === 'cadeauzakjes' && row.artifact.version === 'SOP04-ea10224d88422545f285');
    const secondQuery = rawArtifacts.find(row => row.artifact.seed_exact_string === 'kerstverpakking' && row.artifact.version === 'SOP04-13c888f2a3dfe90cda0d');
    if (!firstQuery || !secondQuery || firstQuery.terms.length !== 10 || secondQuery.terms.length !== 10) throw Object.assign(new Error('SOP04 两次真实 Search Terms raw evidence 不完整；拒绝重建候选状态。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP04_RAW_EVIDENCE_INCOMPLETE' });
    const excluded = Array.isArray(task.sop04_excluded_related_terms) ? task.sop04_excluded_related_terms : [];
    const adoptedSet = new Set(approved);
    const excludedSet = new Set(excluded.map(item => item.exact_string));
    const secondTerms = secondQuery.terms.map(item => item.searchTerm).filter(value => typeof value === 'string');
    const expectedNotAdopted = secondTerms.filter(value => !adoptedSet.has(value));
    const approvedFromRaw = new Set([...firstQuery.terms, ...secondQuery.terms].map(item => item.searchTerm));
    if (approved.some(value => !approvedFromRaw.has(value)) || excluded.length !== 8
      || excluded.some(item => !firstQuery.terms.some(term => term.searchTerm === item.exact_string))
      || expectedNotAdopted.length !== 7 || excluded_first_query.length !== 8
      || excluded_first_query.some(value => !excludedSet.has(value))) throw Object.assign(new Error('SOP04 的五个 adopted、八个 excluded 或第二次查询七个未采用词无法与原始 evidence 精确对应。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP04_DECISION_EVIDENCE_MISMATCH' });
    const annotations = [
      ...approved.map(exact_string => ({ exact_string, status: 'ADOPTED', decision_source: 'LEON_FINAL_SOP04_DECISION', source_query_versions: [firstQuery.artifact.version, secondQuery.artifact.version] })),
      ...excluded.map(item => ({ exact_string: item.exact_string, status: 'EXCLUDED', exclusion_reason: item.exclusion_reason, decided_at: item.decided_at, source_query_versions: [firstQuery.artifact.version] })),
      ...expectedNotAdopted.map(exact_string => ({ exact_string, status: 'NOT_ADOPTED_IN_SOP04_FINAL_SET', reason: 'Raw result retained; not among Leon-approved five. It is not a SOP05 candidate source.', source_query_versions: [secondQuery.artifact.version] })),
    ];
    const firstQuerySource = {
      version: firstQuery.artifact.version, artifact_ref: firstQuery.record.artifact_ref,
      seed_exact_string: firstQuery.artifact.seed_exact_string, returned_raw_terms: clone(firstQuery.terms),
      api_evidence: clone(firstQuery.artifact.api_evidence), queried_at: firstQuery.artifact.queried_at,
    };
    const artifactSeed = {
      ...clone(existing), version: undefined, saved_at: undefined,
      parent_revalidation_version: existing.version,
      confirmed_product_facts_version: Number(task.outputs.confirmed_product_facts.version),
      sop03_artifact_version: task.listing_executor.registry.LISTING_SOP_03.output_version,
      source_query_artifacts: [firstQuerySource],
      candidate_status_annotations: annotations,
      revalidation: { type: 'LOCAL_EVIDENCE_REVALIDATION', external_requests: 0, provider_calls: 0, at: iso(), raw_evidence_unchanged: true },
    };
    const { evidence: _oldEnvelope, open_error_count: _oldOpenCount, created_at: _oldCreatedAt, ...artifactBody } = artifactSeed;
    const version = `SOP04-${crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex').slice(0, 20)}`;
    const artifact = { ...artifactBody, version, saved_at: iso() };
    const artifactPath = path.join(dataRoot, 'artifacts', 'listing', id, 'sop04', `${version}.json`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const json = JSON.stringify(artifact, null, 2);
    try { await fs.writeFile(artifactPath, json, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(artifactPath, 'utf8') !== json) throw error; }
    const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
    const output = {
      ...artifact,
      evidence: { ...clone(existing.evidence), evidence_refs: [...new Set([...(existing.evidence?.evidence_refs || []), firstQuery.record.artifact_ref, relativeArtifact])],
        artifact_ref: relativeArtifact, parent_artifact_ref: oldRef, confirmed_product_facts_version: task.outputs.confirmed_product_facts.version,
        sop03_artifact_version: task.outputs.keyword_source_discovery.version, no_formal_boloo_volume_written: true },
      open_error_count: activeIssueCount(task), created_at: artifact.saved_at,
    };
    const priorStatus = clone(existing);
    task.outputs.bol_keywords = output;
    task.listing_sop.sop04_artifact_versions ||= [];
    task.listing_sop.sop04_artifact_versions.push({ version, artifact_ref: relativeArtifact, seed_exact_string: artifact.seed_exact_string,
      queried_at: artifact.queried_at, created_at: artifact.saved_at, revalidation_of: priorStatus.version, current: true });
    for (const record of task.listing_sop.sop04_artifact_versions) if (record.version === priorStatus.version) { record.current = false; record.superseded_by = version; }
    output.stale = false; delete output.stale_reason; delete output.stale_since_fact_version; delete output.stale_at;
    const problems = await validateStage(task, 'LISTING_SOP_04', dataRoot);
    const checkedAt = iso();
    const report = { checks: [
      { code: 'SOP04_FACTS_V2_BOUND', pass: Number(output.confirmed_product_facts_version) === 2 },
      { code: 'SOP04_SOP03_REVALIDATED_VERSION_BOUND', pass: output.sop03_artifact_version === task.outputs.keyword_source_discovery.version },
      { code: 'SOP04_FIVE_ADOPTED_TERMS_PRESERVED', pass: JSON.stringify(output.adopted_terms.map(item => item.exact_string)) === JSON.stringify(approved) },
      { code: 'SOP04_EIGHT_EXCLUSIONS_PRESERVED', pass: annotations.filter(item => item.status === 'EXCLUDED').length === 8 },
      { code: 'SOP04_SECOND_QUERY_SEVEN_NOT_ADOPTED_ANNOTATED', pass: annotations.filter(item => item.status === 'NOT_ADOPTED_IN_SOP04_FINAL_SET').length === 7 },
      { code: 'SOP04_RAW_EVIDENCE_REFERENCES_EXIST', pass: Boolean(await fs.stat(path.resolve(dataRoot, firstQuery.record.artifact_ref)).catch(() => null)) && Boolean(await fs.stat(path.resolve(dataRoot, relativeArtifact)).catch(() => null)) },
      { code: 'SOP04_NO_REMOTE_REQUESTS', pass: artifact.revalidation.external_requests === 0 && artifact.revalidation.provider_calls === 0 },
      { code: 'SOP04_NO_SEARCH_TERMS_TOTAL_AS_VOLUME', pass: !Object.hasOwn(output, 'boloo_search_volume') && output.adopted_terms.every(item => !Object.hasOwn(item, 'total') && !Object.hasOwn(item, 'search_volume')) },
      { code: 'SOP04_NO_OPEN_ERRORS', pass: activeIssueCount(task) === 0 },
      { code: 'SOP04_CONTRACT_VALIDATOR', pass: problems.length === 0, problems: problems.map(item => item[0]) },
    ], failures: problems.map(item => item[0]), external_requests: 0 };
    if (problems.length) throw Object.assign(new Error(`SYNTHETIC_ACCEPTANCE_10 SOP04 本地 evidence revalidation QA 未通过：${problems.map(item => item[0]).join(', ')}`), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP04_REVALIDATION_QA_FAILED', report });
    const applied = applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'PASS', output,
      input_version_refs: [{ artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: output.sop03_artifact_version }, { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: output.confirmed_product_facts_version }],
      qa: { status: 'PASS', checked_at: checkedAt, report } });
    if (!applied.can_advance) throw Object.assign(new Error('SOP04 QA PASS 门禁未允许保存重核结果。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP04_REVALIDATION_GATE_FAILED' });
    task.qa.LISTING_SOP_04 = { status: 'PASS', checked_at: checkedAt, report };
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'PASS', dependency: null, updated_at: checkedAt };
    task.listing_sop.steps.LISTING_SOP_04 = { ...task.listing_sop.steps.LISTING_SOP_04, status: 'PASS', qa_status: 'PASS', output_version: version, updated_at: checkedAt };
    task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.listing_sop.current_step_id = 'LISTING_SOP_04';
    task.last_success_step = 'LISTING_SOP_04'; task.waiting_dependency_key = null; task.status = 'PASS';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool; task.open_error_count = activeIssueCount(task);
    task.listing_sop.source_completeness_revalidation.sop04 = { status: 'PASS', version, parent_version: priorStatus.version, qa: report, external_requests: 0 };
    task.listing_sop.source_completeness_revalidation.status = 'SOP04_REVALIDATED';
    await commit(dataRoot, task, 'SYNTHETIC_ACCEPTANCE_10_SOP04_EXISTING_EVIDENCE_REVALIDATED', { version, parent_version: priorStatus.version, facts_version: 2,
      sop03_version: output.sop03_artifact_version, adopted_count: approved.length, excluded_count: 8, not_adopted_count: 7, external_requests: 0 });
    return { task, status: 'PASS', version, report, annotations, external_requests: 0 };
  });
}

/** Creates a read-only precheck pool; this does not start formal SOP05. */
export async function createSYNTHETIC_ACCEPTANCE_10Sop05PrecheckCandidatePool(dataRoot, sku) {
  const id = productId(sku);
  if (id !== 'SYNTHETIC-SKU-LEGACY-10' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot)) throw Object.assign(new Error('该 SOP05 前置候选审计只允许在 SYNTHETIC_ACCEPTANCE_10 4181 acceptance 数据根执行。'), { code: 'SYNTHETIC_ACCEPTANCE_10_ACCEPTANCE_ROOT_REQUIRED' });
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task || task.qa?.LISTING_SOP_02?.status !== 'PASS' || task.qa?.LISTING_SOP_03?.status !== 'PASS'
      || task.qa?.LISTING_SOP_04?.status !== 'PASS' || !['LISTING_SOP_04', 'LISTING_SOP_05_PRECHECK'].includes(task.current_step)) throw Object.assign(new Error('SOP05 precheck 需要当前 SOP02–04 全部 QA PASS，且不得启动正式 SOP05。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP05_PRECHECK_PRECONDITION_FAILED' });
    if (task.current_step === 'LISTING_SOP_05_PRECHECK' && task.listing_sop?.latest_sop05_precheck?.formal_sop05_started === false) {
      // Correct an earlier precheck-only waiting item that accidentally moved
      // the top-level task cursor. The formal Listing cursor remains SOP04.
      for (const item of task.listing_executor?.waiting_items || []) if (item.originating_sop_step === 'LISTING_SOP_05_PRECHECK' && !item.decided_at) {
        item.status = 'SUPERSEDED'; item.decided_at = iso(); item.decision = 'SUPERSEDED_AFTER_PRECHECK_SOURCE_CLASSIFICATION_QA';
      }
      task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.listing_sop.current_step_id = 'LISTING_SOP_04';
      task.status = 'PASS'; task.waiting_dependency_key = null; task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    }
    const sourceRef = task.outputs.keyword_source_discovery?.evidence?.evidence_refs?.at(-1)
      || task.listing_executor?.registry?.LISTING_SOP_03?.evidence_refs?.at(-1);
    const sop03Version = task.outputs.keyword_source_discovery?.version || task.listing_executor?.registry?.LISTING_SOP_03?.output_version;
    if (!sourceRef) throw Object.assign(new Error('缺少最新 SOP03 本地来源 artifact。'), { code: 'SYNTHETIC_ACCEPTANCE_10_SOP03_ARTIFACT_MISSING' });
    const sop03 = JSON.parse(await fs.readFile(safeMaterialPath(dataRoot, sourceRef), 'utf8'));
    const candidateMap = new Map();
    const sourceEvidenceRecords = [];
    const addSourceEvidence = (recordType, exactValue, fields = {}) => {
      if (typeof exactValue !== 'string' || !exactValue.length) return;
      sourceEvidenceRecords.push({ record_type: recordType, exact_value: exactValue, eligibility_status: 'SOURCE_EVIDENCE_ONLY', ...clone(fields) });
    };
    const add = (exact, source) => {
      if (typeof exact !== 'string' || !exact.length || /^https?:\/\//i.test(exact.trim())) return;
      const sourceRecordType = source.record_type || (source.language === 'nl' ? 'DUTCH_KEYWORD_CANDIDATE' : 'RAW_SOURCE_EXPRESSION');
      const current = candidateMap.get(exact) || { candidate_id: `${id}:precheck:${crypto.createHash('sha256').update(exact, 'utf8').digest('hex').slice(0, 16)}`, exact_string: exact, record_type: sourceRecordType, eligibility_status: sourceRecordType === 'DUTCH_KEYWORD_CANDIDATE' ? 'ELIGIBLE_SOURCE_CANDIDATE' : 'SOURCE_LANGUAGE_REVIEW_REQUIRED', status: 'PRECHECK_CANDIDATE', languages: [], sources: [] };
      if (sourceRecordType === 'DUTCH_KEYWORD_CANDIDATE') {
        current.record_type = 'DUTCH_KEYWORD_CANDIDATE';
        current.eligibility_status = 'ELIGIBLE_SOURCE_CANDIDATE';
      }
      const key = JSON.stringify(source);
      if (!current.sources.some(item => JSON.stringify(item) === key)) current.sources.push(source);
      if (source.language && !current.languages.includes(source.language)) current.languages.push(source.language);
      candidateMap.set(exact, current);
    };
    const facts = task.outputs.confirmed_product_facts.fields || {};
    const dutchOwnFacts = [];
    for (const [field, fact] of Object.entries(facts)) {
      if (fact.status !== 'CONFIRMED' || typeof fact.value !== 'string') continue;
      const common = { source_type: 'PRODUCT_FACTS', field, facts_version: task.outputs.confirmed_product_facts.version, source_references: clone(fact.source_references || []) };
      if (/^https?:\/\//i.test(fact.value.trim())) {
        addSourceEvidence('SOURCE_URL', fact.value, common);
      } else if (fact.language === 'nl' && fact.market_query_allowed === true && !/[\u3400-\u9fff]/.test(fact.value)) {
        dutchOwnFacts.push({ field, exact_string: fact.value, source_references: fact.source_references || [] });
        add(fact.value, { ...common, record_type: 'DUTCH_KEYWORD_CANDIDATE', source_type: 'PRODUCT_FACTS', language: 'nl' });
      } else {
        addSourceEvidence(fact.language && fact.language !== 'nl' ? 'NON_DUTCH_SOURCE_EVIDENCE' : 'RAW_SOURCE_EXPRESSION', fact.value, { ...common, language: fact.language || 'UNKNOWN' });
      }
    }
    for (const sourceUrl of sop03.bol_local_source?.competitor_urls || []) {
      addSourceEvidence('SOURCE_URL', sourceUrl.exact_url, { source_type: 'BOL_COMPETITOR_SOURCE', source_field: sourceUrl.source_field, source_cell: sourceUrl.source_cell,
        source_version: sop03Version, facts_version: task.outputs.confirmed_product_facts.version, source_title: sourceUrl.local_expression || null });
      if (sourceUrl.local_expression) addSourceEvidence('RAW_SOURCE_EXPRESSION', sourceUrl.local_expression, { source_type: 'BOL_PRODUCT_TITLE_SLUG', source_url: sourceUrl.exact_url,
        source_field: sourceUrl.source_field, source_cell: sourceUrl.source_cell, source_version: sop03Version, facts_version: task.outputs.confirmed_product_facts.version });
    }
    const amazonSourceUrl = sop03.amazon_local_source?.source_url;
    if (amazonSourceUrl) addSourceEvidence('SOURCE_URL', amazonSourceUrl, { source_type: 'AMAZON_REFERENCE', source_version: sop03Version, facts_version: task.outputs.confirmed_product_facts.version });
    const mining = sop03.bol_local_source?.keyword_mining?.exact_strings || [];
    for (const item of mining) add(item.exact_string, { record_type: 'DUTCH_KEYWORD_CANDIDATE', source_type: 'BOL_LOCAL_KEYWORD_MINING', category: item.category, language: 'nl', source_url: item.source_url,
      source_cell: item.source_cell, evidence_ref: item.evidence_ref, facts_version: item.facts_version, sop03_artifact_version: sop03.output_version || task.outputs.keyword_source_discovery.version });
    const extractorSources = task.listing_sop.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
    for (const source of extractorSources) {
      if (source.status !== 'PASS') continue;
      for (const exact of source.exact_strings || []) add(exact, { record_type: 'RAW_SOURCE_EXPRESSION', source_type: 'BOLOO_COMPETITOR_EXTRACTOR', language: 'SOURCE_LANGUAGE_REVIEW_REQUIRED', source_id: source.source_id, source_url: source.source_url,
        provider_method: source.provider_method, result_version: source.result_version, request_id: source.provider_request_id, evidence_refs: clone(source.evidence_refs || []), facts_version: task.outputs.confirmed_product_facts.version });
    }
    const amazonExpressions = sop03.amazon_local_source?.expressions || [];
    const amazonDutch = [];
    for (const expression of amazonExpressions) {
      const exact = typeof expression === 'string' ? expression : expression?.exact_string || expression?.text;
      const language = typeof expression === 'string' ? sop03.amazon_local_source?.source_language : expression?.language || sop03.amazon_local_source?.source_language;
      if (typeof exact === 'string' && language === 'nl' && !/[\u3400-\u9fff]/.test(exact) && !/^https?:\/\//i.test(exact.trim())) {
        amazonDutch.push(exact);
        add(exact, { record_type: 'DUTCH_KEYWORD_CANDIDATE', source_type: 'AMAZON_LOCAL_SOURCE', language, source_url: sop03.amazon_local_source.source_url, evidence_cells: clone(sop03.amazon_local_source.evidence_cells || []), candidate_only: true });
      } else if (typeof exact === 'string') {
        addSourceEvidence('NON_DUTCH_SOURCE_EVIDENCE', exact, { source_type: 'AMAZON_LOCAL_SOURCE', language: language || 'UNKNOWN', source_url: sop03.amazon_local_source.source_url,
          evidence_cells: clone(sop03.amazon_local_source.evidence_cells || []), source_version: sop03Version, facts_version: task.outputs.confirmed_product_facts.version, translated: false });
      }
    }
    for (const term of task.outputs.bol_keywords.adopted_terms || []) add(term.exact_string, { record_type: 'DUTCH_KEYWORD_CANDIDATE', source_type: 'BOL_SEARCH_TERMS_ADOPTED', language: 'nl', facts_version: task.outputs.confirmed_product_facts.version,
      sop03_artifact_version: task.outputs.keyword_source_discovery.version, sop04_artifact_version: task.outputs.bol_keywords.version, decision_by: 'Leon' });
    const candidates = [...candidateMap.values()];
    const versionPayload = { schema_version: 1, artifact_type: 'SOP05_PRECHECK_CANDIDATE_POOL', sku: id,
      status: candidates.length > 30 ? 'WAITING_DECISION' : 'PRECHECK_READY', formal_sop05_started: false, eligible_for_downstream: false,
      rule: 'Exact-string identity only; no scoring, ranking, normalization, translation, TOP20 selection, or Boloo Explorer request.',
      candidate_count: candidates.length, candidates, source_evidence_records: sourceEvidenceRecords, source_coverage: {
        product_facts: { facts_version: task.outputs.confirmed_product_facts.version, dutch_candidate_count: dutchOwnFacts.length, considered_non_dutch_fact_count: Object.values(facts).filter(item => item.status === 'CONFIRMED' && typeof item.value === 'string' && /[\u3400-\u9fff]/.test(item.value)).length },
        bol_local_keyword_mining: { status: sop03.bol_local_source?.keyword_mining?.status || 'NOT_RUN', input_count: mining.length, unique_exact_strings: new Set(mining.map(item => item.exact_string)).size },
        boloo_extractor: { status_counts: Object.fromEntries(['PASS', 'PASS_NO_RESULT'].map(status => [status, extractorSources.filter(item => item.status === status).length])), pass_exact_string_count: extractorSources.filter(item => item.status === 'PASS').reduce((sum, item) => sum + (item.exact_strings || []).length, 0) },
        amazon_local_source: { status: sop03.amazon_local_source?.status, source_language: sop03.amazon_local_source?.source_language || null, source_expression_count: amazonExpressions.length, dutch_candidate_count: amazonDutch.length, non_dutch_not_translated: true },
        sop04: { version: task.outputs.bol_keywords.version, adopted_exact_strings: (task.outputs.bol_keywords.adopted_terms || []).map(item => item.exact_string), excluded_terms_not_added: (task.sop04_excluded_related_terms || []).map(item => item.exact_string), not_adopted_raw_terms_not_added: (task.outputs.bol_keywords.candidate_status_annotations || []).filter(item => item.status === 'NOT_ADOPTED_IN_SOP04_FINAL_SET').map(item => item.exact_string) },
      },
      excluded_historical_terms: clone(task.sop04_excluded_related_terms || []),
      sop04_not_adopted_terms: clone((task.outputs.bol_keywords.candidate_status_annotations || []).filter(item => item.status === 'NOT_ADOPTED_IN_SOP04_FINAL_SET')),
      input_versions: { facts: task.outputs.confirmed_product_facts.version, sop03: sop03Version, sop04: task.outputs.bol_keywords.version },
      external_requests: 0, created_at: iso(),
    };
    const version = `SOP05-PRECHECK-${crypto.createHash('sha256').update(JSON.stringify(versionPayload)).digest('hex').slice(0, 20)}`;
    const artifact = { ...versionPayload, version };
    const artifactPath = path.join(dataRoot, 'artifacts', 'listing', id, 'sop05-precheck', `${version}.json`);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const json = JSON.stringify(artifact, null, 2);
    try { await fs.writeFile(artifactPath, json, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(artifactPath, 'utf8') !== json) throw error; }
    const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
    task.listing_sop.sop05_precheck_artifacts ||= [];
    for (const previous of task.listing_sop.sop05_precheck_artifacts) {
      const initialBadPrecheck = previous.version === 'SOP05-PRECHECK-15e8b0a887730706d8db';
      if (initialBadPrecheck && previous.status === 'INVALIDATED / SUPERSEDED') continue;
      const shouldSupersede = previous.current !== false || initialBadPrecheck;
      if (!shouldSupersede) continue;
      previous.current = false;
      previous.superseded_by = version; previous.eligible_for_downstream = false;
      if (initialBadPrecheck) {
        previous.status = 'INVALIDATED / SUPERSEDED';
        previous.invalidated_at = iso();
        previous.invalidated_reason = '该初版把 Amazon URL 当作候选来源；URL 不得成为 keyword exact string。原始artifact保留审计，但禁止下游消费。';
        const invalidation = { schema_version: 1, artifact_type: 'SOP05_PRECHECK_INVALIDATION', invalidated_version: previous.version,
          invalidated_artifact_ref: previous.artifact_ref, status: 'INVALIDATED / SUPERSEDED', eligible_for_downstream: false,
          reason: previous.invalidated_reason, superseded_by: version, created_at: previous.invalidated_at };
        const invalidationPath = path.join(dataRoot, 'artifacts', 'listing', id, 'sop05-precheck', 'invalidations', `${previous.version}.json`);
        await fs.mkdir(path.dirname(invalidationPath), { recursive: true });
        const invalidationJson = JSON.stringify(invalidation, null, 2);
        try { await fs.writeFile(invalidationPath, invalidationJson, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(invalidationPath, 'utf8') !== invalidationJson) throw error; }
        task.listing_sop.sop05_precheck_invalidations ||= [];
        task.listing_sop.sop05_precheck_invalidations.push({ ...invalidation, artifact_ref: path.relative(dataRoot, invalidationPath).replace(/\\/g, '/') });
      } else {
        previous.status = 'SUPERSEDED';
        previous.superseded_reason = 'SUPERSEDED_AFTER_SOURCE_TYPE_CLASSIFICATION';
      }
    }
    for (const waiting of task.listing_executor?.waiting_items || []) if (waiting.originating_sop_step === 'LISTING_SOP_05_PRECHECK'
      && !waiting.decided_at && waiting.status === 'WAITING_DECISION') {
      waiting.status = 'SUPERSEDED'; waiting.decision = 'SUPERSEDED_AFTER_SOURCE_TYPE_CLASSIFICATION'; waiting.decided_at = iso();
    }
    task.listing_sop.sop05_precheck_artifacts.push({ version, artifact_ref: relativeArtifact, candidate_count: candidates.length, status: artifact.status, formal_sop05_started: false, current: true, eligible_for_downstream: false, eligible_for_decision: artifact.status === 'WAITING_DECISION', created_at: artifact.created_at });
    task.listing_sop.latest_sop05_precheck = { version, artifact_ref: relativeArtifact, candidate_count: candidates.length, status: artifact.status, formal_sop05_started: false, eligible_for_downstream: false };
    if (artifact.status === 'WAITING_DECISION') {
      task.listing_executor ||= { waiting_items: [] }; task.listing_executor.waiting_items ||= [];
      const waiting = { waiting_id: crypto.randomUUID(), sku: task.sku, type: 'WAITING_DECISION', originating_sop_step: 'LISTING_SOP_05_PRECHECK',
        current_value: { candidate_count: candidates.length, approximate_target: '约20个', candidate_version: version, candidate_artifact_ref: relativeArtifact },
        proposed_value_or_action: '候选来源完整收敛后候选池明显多于约20；请 Leon 决定后续保留边界。系统不排序、不打分、不翻译、不做TOP20。',
        reason: `SYNTHETIC_ACCEPTANCE_10 完整候选池为 ${candidates.length} 个 exact strings，明显多于约20；SOP未授权自动缩减算法。`,
        evidence: [{ type: 'SOP05_PRECHECK_CANDIDATE_POOL', version, artifact_ref: relativeArtifact, candidate_count: candidates.length, facts_version: task.outputs.confirmed_product_facts.version, sop03_version: task.outputs.keyword_source_discovery.version, sop04_version: task.outputs.bol_keywords.version }],
        affected_downstream_modules: ['LISTING_SOP_05'], status: 'WAITING_DECISION', created_at: iso(), decision: null, decided_at: null };
      task.listing_executor.waiting_items.push(waiting);
      task.listing_sop.latest_sop05_precheck.waiting_id = waiting.waiting_id;
    }
    await commit(dataRoot, task, 'SOP05_PRECHECK_CANDIDATE_POOL_CREATED', { version, candidate_count: candidates.length, status: artifact.status, formal_sop05_started: false, external_requests: 0, sources: artifact.source_coverage });
    return { task, artifact, artifact_ref: relativeArtifact, external_requests: 0 };
  });
}

/** Persist a future SOP executor state through the normal per-SKU version/event path. */
export async function updateListingExecutorStage(dataRoot, sku, stepId, patch) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('Final 存档已锁定，不能修改 Listing Executor。'), { code: 'FINAL_VERSION_LOCKED' });
    syncListingExecutorFramework(task, LISTING_SOP_STEPS);
    const result = applyListingExecutorStep(task, stepId, patch);
    if (patch.status === 'WAITING_DEPENDENCY') {
      const dependencyKey = String(patch.waiting_dependency_key || patch.dependency || '').trim();
      if (dependencyKey) {
        task.waiting_dependency_key = dependencyKey;
        task.stages[stepId] = { ...task.stages[stepId], dependency: dependencyKey, dependency_status: patch.dependency_status || 'WAITING' };
      }
    } else if (task.current_step === stepId) {
      task.waiting_dependency_key = null;
    }
    await commit(dataRoot, task, 'LISTING_EXECUTOR_STAGE_RECORDED', {
      step_id: stepId, status: result.step.status, qa_status: result.step.qa_status,
      output_version: result.step.output_version, can_advance: result.can_advance,
      waiting_dependency_key: patch.waiting_dependency_key || patch.dependency || null,
    });
    return { task, can_advance: result.can_advance };
  });
}

export async function addListingWaitingItem(dataRoot, sku, item) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('Final 存档已锁定，不能新增待处理事项。'), { code: 'FINAL_VERSION_LOCKED' });
    const record = createExecutorWaitingItem(task, item);
    await commit(dataRoot, task, 'LISTING_WAITING_ITEM_CREATED', { waiting_id: record.waiting_id, type: record.type, originating_sop_step: record.originating_sop_step });
    return { task, waiting_item: record };
  });
}

export async function decideListingWaitingItem(dataRoot, sku, waitingId, decision) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('Final 存档已锁定，不能修改待处理事项。'), { code: 'FINAL_VERSION_LOCKED' });
    const record = resolveExecutorWaitingItem(task, waitingId, decision);
    await commit(dataRoot, task, 'LISTING_WAITING_ITEM_DECIDED', { waiting_id: waitingId, decision: record.decision });
    return { task, waiting_item: record };
  });
}

export async function updateListingReleaseGate(dataRoot, sku, gateId, patch) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('Final 存档已锁定，不能修改 Release Gate。'), { code: 'FINAL_VERSION_LOCKED' });
    syncListingExecutorFramework(task, LISTING_SOP_STEPS);
    const gate = updateReleaseGate(task, gateId, patch);
    await commit(dataRoot, task, 'LISTING_RELEASE_GATE_RECORDED', { gate_id: gateId, status: gate.status, qa_status: gate.qa_status });
    return { task, gate };
  });
}

/** Install the complete upstream-produced Boloo checklist before any query starts. */
export async function configureBolooRequiredSubtasks(dataRoot, sku, { explorer_queries = [], extractor_urls = [], explorer_origin = 'LISTING_COMPETITOR_KEYWORD', extractor_origin = 'LISTING_INTERNAL_COMPETITOR_URL', same_day_boloo_pass_cache = [], dispatch = true } = {}) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('该 SKU 已上传归档，不能重设 Boloo 子任务。'), { code: 'FINAL_VERSION_LOCKED' });
    if (task.current_step !== 'boloo_keywords') throw Object.assign(new Error('只有 SKU 当前进入 boloo_keywords 阶段后才能配置 Boloo 子任务。'), { code: 'BOLOO_STAGE_NOT_ACTIVE' });
    if (!Array.isArray(explorer_queries)) throw Object.assign(new Error('explorer_queries 必须是字符串数组。'), { code: 'BOLOO_REQUIRED_SUBTASKS_INVALID' });
    const required = buildBolooRequiredSubtasks(id, { explorer_queries, extractor_urls, explorer_origin, extractor_origin });
    task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null };
    const existing = task.boloo.required_subtasks || [];
    const same = existing.length === required.length && existing.every((item, index) => item.provider_source === required[index].provider_source && item.query_text === required[index].query_text);
    if (same) return { task, unchanged: true };
    if (existing.length || existing.some(item => item.attempt_count > 0 || item.request_ids?.length || item.result)) throw Object.assign(new Error('初始子任务清单已建立；后续候选必须追加，不能替换清单或丢弃历史。'), { code: 'BOLOO_SUBTASK_LIST_LOCKED' });
    const explorerQueries = new Set(required.filter(item => item.provider_source === 'keyword_explorer').map(item => item.query_text));
    const cacheByQuery = validateSameDayBolooPassCache(same_day_boloo_pass_cache, explorerQueries);
    task.boloo.required_subtasks = required;
    task.boloo.candidates ||= [];
    let cacheReuseCount = 0;
    for (const subtask of required.filter(item => item.provider_source === 'keyword_explorer')) {
      const hit = cacheByQuery.get(subtask.query_text);
      if (hit) {
        const cachedResult = resultFromBolooVolumeCache(id, subtask, hit);
        subtask.status = 'PASS'; subtask.result = cachedResult; subtask.request_ids = [cachedResult.request_id];
        subtask.history = [clone(cachedResult)]; subtask.updated_at = iso(); cacheReuseCount += 1;
        addBolooCandidate(task, subtask.query_text, explorer_origin, { status: 'CONFIRMED_VOLUME', volume: hit.search_volume, volumeEvidence: {
          source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: hit.provider_method, business_date: hit.business_date,
          cache_record_id: hit.cache_record_id, qa_status: 'PASS', same_day: true,
          page_url: hit.evidence.page_url, matched_query: hit.query_text, displayed_value: String(hit.search_volume), observed_at: hit.observed_at || null,
        }, cache: { source: hit.source, provider_method: hit.provider_method, business_date: hit.business_date, cache_record_id: hit.cache_record_id, qa_status: hit.qa_status, same_day: hit.same_day, observed_at: hit.observed_at || hit.recordedAt || null } });
      } else addBolooCandidate(task, subtask.query_text, explorer_origin);
    }
    syncBolooCandidatePool(task);
    task.boloo.current_subtask_id = null;
    task.boloo.current_source_id = null;
    task.boloo.keyword_discovery_closed = false;
    task.boloo.discovery_close_evidence = null;
    task.boloo.discovery_waiting_decision = null;
    task.status = 'QUEUED'; task.resume_point = 'boloo_keywords';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'QUEUED', updated_at: iso() };
    await commit(dataRoot, task, 'BOLOO_REQUIRED_SUBTASKS_CONFIGURED', {
      step: 'boloo_keywords', required_count: required.length,
      explorer_count: required.filter(item => item.provider_source === 'keyword_explorer').length,
      extractor_count: required.filter(item => item.provider_source === 'keyword_extractor').length,
      same_day_cache_reuse_count: cacheReuseCount,
    });
    if (dispatch) await dispatchCurrent(dataRoot, task);
    return { task, unchanged: false };
  });
}

/**
 * Append exact candidates/URLs while discovery is open. Cache hits must be
 * BOLOO_OFFICIAL_VERIFIED + same Amsterdam business date + Stage QA PASS and
 * provider_method WEB/MCP with exact-string evidence; BOL API output
 * API output is never itself treated as Boloo search-volume cache data.
 */
export async function appendBolooRequiredSubtasks(dataRoot, sku, {
  explorer_queries = [], extractor_urls = [],
  explorer_origin = 'BOLOO_DISCOVERED_CANDIDATE', extractor_origin = 'LISTING_INTERNAL_COMPETITOR_URL',
  same_day_boloo_pass_cache = [],
} = {}) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('该 SKU 已上传归档，不能追加 Boloo 子任务。'), { code: 'FINAL_VERSION_LOCKED' });
    if (task.current_step !== 'boloo_keywords') throw Object.assign(new Error('只有 SKU 当前处于 boloo_keywords 阶段才能追加发现任务。'), { code: 'BOLOO_STAGE_NOT_ACTIVE' });
    task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null, keyword_discovery_closed: false, discovery_close_evidence: null };
    task.boloo.required_subtasks ||= [];
    syncBolooCandidatePool(task);
    if (task.boloo.keyword_discovery_closed === true) throw Object.assign(new Error('Keyword discovery 已关闭；不能静默追加。需要先由主流程显式重新打开阶段。'), { code: 'BOLOO_DISCOVERY_CLOSED' });
    if (activeIssueCount(task) > 0 || task.boloo.required_subtasks.some(item => item.status === 'PENDING_RECHECK' || item.status === 'ERROR')) throw Object.assign(new Error('存在待复核或异常子任务；先完成异常闭环再追加候选。'), { code: 'BOLOO_DISCOVERY_BLOCKED_BY_SUBTASK' });

    if (!Array.isArray(explorer_queries) || !Array.isArray(extractor_urls) || !Array.isArray(same_day_boloo_pass_cache)) throw Object.assign(new Error('Explorer、Extractor 和缓存复用数据必须是数组。'), { code: 'BOLOO_REQUIRED_SUBTASKS_INVALID' });
    const incoming = explorer_queries.length || extractor_urls.length
      ? buildBolooRequiredSubtasks(id, { explorer_queries, extractor_urls, explorer_origin, extractor_origin }) : [];
    const existing = task.boloo.required_subtasks;
    const priorStatus = task.status;
    const dedup = new Map(existing.map(item => [`${item.provider_source}\0${item.query_text}`, item]));
    const incomingKeywordQueries = new Set(incoming.filter(item => item.provider_source === 'keyword_explorer').map(item => item.query_text));
    const cacheByQuery = validateSameDayBolooPassCache(same_day_boloo_pass_cache, incomingKeywordQueries);
    const nextOrdinals = Object.fromEntries(['keyword_explorer', 'keyword_extractor'].map(source => [source,
      Math.max(0, ...existing.filter(item => item.provider_source === source).map(item => Number(item.ordinal) || 0)) + 1]));
    const appended = [];
    let provenanceUpdates = 0;
    let cacheReuseCount = 0;
    for (const candidate of incoming) {
      const key = `${candidate.provider_source}\0${candidate.query_text}`;
      const prior = dedup.get(key);
      const isKeyword = candidate.provider_source === 'keyword_explorer';
      const cacheHit = isKeyword ? cacheByQuery.get(candidate.query_text) : null;
      if (isKeyword) addBolooCandidate(task, candidate.query_text, candidate.origin_sources[0], cacheHit ? {
        status: 'CONFIRMED_VOLUME', volume: cacheHit.search_volume, volumeEvidence: {
          source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: cacheHit.provider_method, business_date: cacheHit.business_date,
          cache_record_id: cacheHit.cache_record_id, qa_status: 'PASS', same_day: true,
          page_url: cacheHit.evidence.page_url, matched_query: cacheHit.evidence.matched_query, displayed_value: String(cacheHit.search_volume), observed_at: cacheHit.observed_at || null,
        }, cache: {
          source: cacheHit.source, provider_method: cacheHit.provider_method, business_date: cacheHit.business_date,
          cache_record_id: cacheHit.cache_record_id, qa_status: cacheHit.qa_status,
          same_day: cacheHit.same_day, observed_at: cacheHit.observed_at || cacheHit.recordedAt || null,
        },
      } : {});
      if (cacheHit) {
        const cachedResult = resultFromBolooVolumeCache(id, prior, cacheHit);
        if (prior) {
          prior.origin_sources ||= [];
          if (!prior.origin_sources.includes(candidate.origin_sources[0])) { prior.origin_sources.push(candidate.origin_sources[0]); provenanceUpdates += 1; }
          if (prior.status !== 'PASS' || prior.result?.cache_reused !== true) {
            prior.history ||= [];
            prior.history.push(clone(cachedResult));
            prior.result = clone(cachedResult); prior.status = 'PASS'; prior.error_code = null; prior.updated_at = iso();
          }
        }
        cacheReuseCount += 1;
        continue;
      }
      if (prior) {
        prior.origin_sources ||= [];
        if (!prior.origin_sources.includes(candidate.origin_sources[0])) { prior.origin_sources.push(candidate.origin_sources[0]); prior.updated_at = iso(); provenanceUpdates += 1; }
        continue;
      }
      const ordinal = nextOrdinals[candidate.provider_source]++;
      const digest = crypto.createHash('sha256').update(`${candidate.provider_source}\0${candidate.query_text}`, 'utf8').digest('hex').slice(0, 16);
      candidate.ordinal = ordinal;
      candidate.source_id = `${candidate.provider_source}:${digest}:${String(ordinal).padStart(3, '0')}`;
      candidate.subtask_id = `${id}:${candidate.source_id}`;
      existing.push(candidate);
      dedup.set(key, candidate);
      appended.push(candidate);
    }
    task.boloo.discovery_close_evidence = null;
    task.boloo.discovery_waiting_decision = null;
    if (!appended.length && !provenanceUpdates && !cacheReuseCount) return { task, appended_count: 0, unchanged: true };
    const activeSubtask = existing.find(item => item.subtask_id === task.boloo.current_subtask_id);
    const preserveActiveDispatch = priorStatus === 'RUNNING' && activeSubtask && !['PASS', 'PASS_NO_RESULT', 'ERROR'].includes(activeSubtask.status);
    task.status = preserveActiveDispatch ? priorStatus : 'QUEUED'; task.resume_point = 'boloo_keywords';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'QUEUED', updated_at: iso() };
    await commit(dataRoot, task, 'BOLOO_REQUIRED_SUBTASKS_APPENDED', {
      step: 'boloo_keywords', appended_count: appended.length, provenance_updates: provenanceUpdates,
      cache_reuse_count: cacheReuseCount,
      subtask_ids: appended.map(item => item.subtask_id), source_ids: appended.map(item => item.source_id),
      origins: [...new Set(appended.flatMap(item => item.origin_sources))], total_required_count: existing.length,
    });
    if (preserveActiveDispatch) {
      return { task, appended_count: appended.length, provenance_updates: provenanceUpdates, cache_reuse_count: cacheReuseCount, unchanged: false, current_subtask_id: activeSubtask.subtask_id, dispatch_required: false };
    }
    await dispatchCurrent(dataRoot, task);
    return { task, appended_count: appended.length, provenance_updates: provenanceUpdates, cache_reuse_count: cacheReuseCount, unchanged: false, current_subtask_id: task.boloo.current_subtask_id, dispatch_required: true };
  });
}

/**
 * Close discovery only after every source is explicit in discovery_sources:
 * product_facts, listing_competitor_keywords, bol_competitor_keywords,
 * amazon_competitor_keywords, boloo_competitor_link_keywords,
 * bol_related_terms (5–7, with exact-string Boloo PASS-cache review), and
 * other_confirmed_candidate_sources. Counts refer to persisted exact strings.
 */
export async function closeBolooKeywordDiscovery(dataRoot, sku, evidence) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('该 SKU 已上传归档，不能关闭或修改 Boloo discovery。'), { code: 'FINAL_VERSION_LOCKED' });
    if (task.current_step !== 'boloo_keywords') throw Object.assign(new Error('只有当前 boloo_keywords 阶段才能关闭 discovery。'), { code: 'BOLOO_STAGE_NOT_ACTIVE' });
    syncBolooCandidatePool(task);
    const supplied = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? clone(evidence) : {};
    if (supplied.candidate_queue_empty !== true) throw Object.assign(new Error('候选队列必须明确确认为空。'), { code: 'BOLOO_DISCOVERY_EVIDENCE_INCOMPLETE', missing: ['candidate_queue_empty'] });
    const acceptanceFixture = isAcceptanceBolooFixture(dataRoot, task);
    const evidenceProblems = acceptanceFixture ? [] : discoveryEvidenceProblems(task, supplied);
    if (evidenceProblems.length) throw Object.assign(new Error(`Discovery 来源覆盖/计数/缓存证据不完整：${evidenceProblems.join('; ')}`), { code: 'BOLOO_DISCOVERY_EVIDENCE_INCOMPLETE', problems: evidenceProblems });
    if (!bolooSubtasksComplete(task)) throw Object.assign(new Error('仍有必需 Boloo 子任务未完成、等待复核或存在 OPEN_ERROR，不能关闭 discovery。'), { code: 'BOLOO_DISCOVERY_NOT_DRAINED' });
    const confirmedCount = (task.boloo?.candidates || []).filter(candidate => candidate.candidate_status === 'CONFIRMED_VOLUME'
      && Number.isFinite(candidate.confirmed_volume) && candidate.confirmed_volume >= 0 && hasFormalBolooVolume(task, candidate)).length;
    if (!acceptanceFixture && confirmedCount < 20) {
      const waiting = {
        status: 'WAITING_DECISION', reason_code: 'CONFIRMED_CANDIDATES_BELOW_TOP20_REQUIREMENT',
        automatic_sources_exhausted: true, confirmed_volume_count: confirmedCount,
        required_count: 20, candidate_gap: 20 - confirmedCount, updated_at: iso(),
      };
      task.boloo.keyword_discovery_closed = false;
      task.boloo.discovery_close_evidence = { ...supplied, automatic_sources_exhausted: true, checked_at: iso() };
      task.boloo.discovery_waiting_decision = waiting;
      task.status = 'WAITING_DECISION'; task.resume_point = 'boloo_keywords';
      task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
      task.stage_qa_status = task.qa?.boloo_keywords?.status || 'NOT_RUN';
      task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'WAITING_DECISION', updated_at: iso() };
      task.error_code = null; task.error_message = null;
      await commit(dataRoot, task, 'BOLOO_DISCOVERY_WAITING_FOR_INPUT', {
        step: 'boloo_keywords', ...waiting,
      });
      return { task, keyword_discovery_closed: false, discovery_status: 'WAITING_DISCOVERY_INPUT', ...waiting, next_step: 'boloo_keywords' };
    }
    task.boloo.keyword_discovery_closed = true;
    task.boloo.discovery_waiting_decision = null;
    task.boloo.discovery_close_evidence = { ...supplied, closed_at: iso() };
    task.outputs ||= {};
    task.outputs.boloo_keywords = { evidence: { source: 'BOLOO_OFFICIAL_WEB', required_subtasks: clone(task.boloo.required_subtasks), discovery_close_evidence: clone(task.boloo.discovery_close_evidence) }, open_error_count: 0, created_at: iso() };
    task.status = 'RUNNING'; task.resume_point = 'boloo_keywords';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    await commit(dataRoot, task, 'BOLOO_KEYWORD_DISCOVERY_CLOSED', {
      step: 'boloo_keywords', required_count: task.boloo.required_subtasks.length,
      completed_count: task.boloo.required_subtasks.length, evidence: task.boloo.discovery_close_evidence,
    });
    const verification = await verifyCurrent(dataRoot, task);
    return { task: verification.task, keyword_discovery_closed: true, stage_qa: verification.passed ? 'PASS' : 'FAIL', next_step: verification.task.current_step };
  });
}

/** Preserve a candidate while excluding it from later selection, with an auditable reason. */
export async function excludeBolooCandidate(dataRoot, sku, queryText, exclusionReason) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.current_step !== 'boloo_keywords' || task.boloo?.keyword_discovery_closed === true) throw Object.assign(new Error('只能在 Boloo keyword discovery 开放时排除候选。'), { code: 'BOLOO_DISCOVERY_NOT_OPEN' });
    const query = typeof queryText === 'string' ? queryText : '';
    if (!query.trim()) throw Object.assign(new Error('候选精确字符串不能为空。'), { code: 'BOLOO_CANDIDATE_QUERY_INVALID' });
    const reason = cleanText(exclusionReason);
    if (!reason) throw Object.assign(new Error('排除候选必须填写 exclusion_reason。'), { code: 'BOLOO_EXCLUSION_REASON_REQUIRED' });
    const candidate = task.boloo?.candidates?.find(item => item.query_text === query);
    if (!candidate) throw Object.assign(new Error('找不到该精确字符串候选。'), { code: 'BOLOO_CANDIDATE_NOT_FOUND' });
    const linked = task.boloo.required_subtasks.filter(item => item.provider_source === 'keyword_explorer' && item.query_text === query);
    if (linked.some(item => !['PASS', 'PASS_NO_RESULT'].includes(item.status))) throw Object.assign(new Error('该候选的 Explorer 子任务尚未完成，不能用排除操作绕过必需查询。'), { code: 'BOLOO_CANDIDATE_SUBTASK_INCOMPLETE' });
    candidate.candidate_status = 'EXCLUDED';
    candidate.exclusion_reason = reason.slice(0, 500);
    candidate.updated_at = iso();
    await commit(dataRoot, task, 'BOLOO_CANDIDATE_EXCLUDED', { step: 'boloo_keywords', candidate_id: candidate.candidate_id, query_text: query, exclusion_reason: candidate.exclusion_reason });
    return { task, candidate: clone(candidate) };
  });
}

const BOLOO_ERROR_REASONS = new Set(['LOGIN_EXPIRED', 'NAVIGATION_FAILED', 'DOM_FIELD_MISSING', 'INPUT_RESULT_MISMATCH', 'NETWORK_FAILED', 'UNKNOWN_PROVIDER_ERROR']);
const BOLOO_SUCCESS_REASONS = new Set(['RESULT_FOUND', 'KEYWORDS_FOUND', 'EXPLORER_ZERO_VOLUME']);
const BOLOO_REASON_TEXT = {
  EXTRACTOR_NO_KEYWORDS: 'Keyword Extractor 页面已稳定，但没有返回关键词。',
  PAGE_NOT_READY: 'Boloo 页面或结果区域尚未稳定。',
  LOGIN_EXPIRED: 'Boloo 登录状态已失效。',
  NAVIGATION_FAILED: 'Boloo 页面导航失败。',
  DOM_FIELD_MISSING: 'Boloo 页面缺少所需查询或结果字段。',
  INPUT_RESULT_MISMATCH: 'Boloo 页面显示的查询词与本次提交查询词不一致。',
  NETWORK_FAILED: 'Boloo 页面网络请求失败。',
  UNKNOWN_PROVIDER_ERROR: 'Boloo Provider 返回未分类技术错误。',
};

function safeProviderMessage(value, fallback) {
  const message = cleanText(value).replace(/[\r\n\t]+/g, ' ').replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|api[_ -]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
  return (message || fallback).slice(0, 500);
}

function bolooProviderError(task, subtask, index, result, reasonCode, message) {
  const normalized = { ...result, status: 'ERROR', reason_code: reasonCode, error_message: safeProviderMessage(message, BOLOO_REASON_TEXT[reasonCode]) };
  subtask.status = 'ERROR';
  subtask.error_code = reasonCode;
  subtask.result = normalized;
  subtask.history ||= [];
  subtask.updated_at = iso();
  task.boloo.current_subtask_id = subtask.subtask_id;
  task.boloo.current_source_id = subtask.source_id;
  task.qa.boloo_keywords = { status: 'FAIL', checked_at: iso(), report: [normalized.error_message] };
  task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'QA_FAIL', updated_at: iso() };
  task.return_pool = '关键词池';
  task.activity_pool = '异常池';
  task.status = 'ERROR';
  task.sidecars.keywords = { ...task.sidecars.keywords, status: 'FAIL', updated_at: iso() };
  issueFor(task, reasonCode, normalized.error_message, `boloo.required_subtasks.${index}`, '当前子任务的查询词与页面结果匹配，且关键字段已定位', '按 reason_code 修复登录、导航、DOM 字段或查询词匹配后，重新执行此子任务并重新核验。');
  task.open_error_count = activeIssueCount(task);
  return normalized;
}

/**
 * Apply one result from the Boloo WebView2 provider to the active per-SKU subtask.
 * This function deliberately does not call or implement the browser provider.
 */
export async function submitBolooProviderResult(dataRoot, sku, providerResult) {
  const id = productId(sku);
  return serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (task.final_archive) throw Object.assign(new Error('该 SKU 已上传归档，不能修改 Boloo 结果。'), { code: 'FINAL_VERSION_LOCKED' });
    const input = providerResult && typeof providerResult === 'object' && !Array.isArray(providerResult) ? clone(providerResult) : {};
    const { schema_version, provider, provider_source, subtask_id, source_id, request_id, attempt, status, reason_code, query_text, observed_at, evidence, result, error } = input;
    if (schema_version !== 1 || provider !== 'BOL_AUTO_WEBVIEW2') throw Object.assign(new Error('Boloo Provider Result Schema 版本或 Provider 标识无效。'), { code: 'BOLOO_RESULT_SCHEMA_INVALID' });
    if (typeof request_id !== 'string' || !request_id.trim() || request_id.length > 160) throw Object.assign(new Error('request_id 必须是非空且不超过 160 字符的字符串。'), { code: 'BOLOO_REQUEST_ID_INVALID' });
    let acceptanceUrl = false;
    if (typeof evidence?.page_url === 'string') {
      try {
        const hostname = new URL(evidence.page_url).hostname;
        acceptanceUrl = hostname === 'acceptance.invalid' || hostname.endsWith('.acceptance.invalid');
      } catch { /* invalid evidence is rejected by the normal schema checks */ }
    }
    const acceptanceEvidence = evidence?.source === 'acceptance-test-only'
      || evidence?.fixture === true
      || acceptanceUrl
      || request_id.startsWith('acceptance-');
    if (acceptanceEvidence && !isAcceptanceBolooFixture(dataRoot, task)) {
      throw Object.assign(new Error('验收夹具结果只能写入隔离验收数据根中的明确测试 SKU。'), { code: 'BOLOO_ACCEPTANCE_EVIDENCE_FORBIDDEN' });
    }
    task.boloo ||= { required_subtasks: [], current_subtask_id: null, current_source_id: null };
    task.boloo.required_subtasks ||= [];
    const prior = task.boloo.required_subtasks.find(item => item.request_ids?.includes(request_id));
    if (prior) return { accepted: true, duplicate: true, sku: id, subtask_id: prior.subtask_id, source_id: prior.source_id, status: prior.status, next_subtask_id: task.boloo.current_subtask_id };
    if (task.current_step !== 'boloo_keywords' || !['RUNNING', 'PENDING_RECHECK'].includes(task.status)) throw Object.assign(new Error('SKU 当前没有等待 Boloo 子任务结果。'), { code: 'BOLOO_RESULT_NOT_EXPECTED' });
    const subtask = task.boloo.required_subtasks.find(item => item.subtask_id === task.boloo.current_subtask_id);
    if (!subtask || subtask_id !== subtask.subtask_id || source_id !== subtask.source_id || provider_source !== subtask.provider_source) throw Object.assign(new Error('Boloo 子任务 ID、source_id 或 provider_source 与当前待处理子任务不匹配。'), { code: 'BOLOO_SUBTASK_MISMATCH' });
    const subtaskIndex = task.boloo.required_subtasks.indexOf(subtask);
    if (!Number.isInteger(attempt) || attempt !== Number(subtask.attempt_count || 0) + 1) throw Object.assign(new Error(`attempt 必须等于当前子任务的下一序号 ${Number(subtask.attempt_count || 0) + 1}。`), { code: 'BOLOO_ATTEMPT_OUT_OF_ORDER' });
    if (!['PASS', 'PASS_NO_RESULT', 'PENDING_RECHECK', 'ERROR'].includes(status)) throw Object.assign(new Error('status 必须为 PASS、PASS_NO_RESULT、PENDING_RECHECK 或 ERROR。'), { code: 'BOLOO_STATUS_INVALID' });
    if (!BOLOO_REASON_CODES.includes(reason_code)) throw Object.assign(new Error('reason_code 不在稳定代码表中。'), { code: 'BOLOO_REASON_CODE_INVALID' });
    if (typeof observed_at !== 'string' || !Number.isFinite(Date.parse(observed_at))) throw Object.assign(new Error('observed_at 必须是有效日期时间。'), { code: 'BOLOO_OBSERVED_AT_INVALID' });

    const normalized = {
      schema_version, provider, provider_source, subtask_id, source_id, request_id, attempt, status, reason_code,
      query_text, observed_at, evidence: evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? clone(evidence) : null,
      result: result == null ? null : clone(result), error: error && typeof error === 'object' ? clone(error) : null,
    };
    const evidenceQuery = normalized.evidence?.matched_query;
    const evidenceComplete = typeof normalized.evidence?.page_url === 'string' && normalized.evidence.page_url.trim()
      && evidenceQuery === query_text && typeof normalized.evidence?.displayed_value === 'string'
      && normalized.evidence.displayed_value.trim();
    let finalStatus = status;
    let finalReason = reason_code;
    let providerError = null;

    if (typeof query_text !== 'string' || query_text !== subtask.query_text) {
      finalStatus = 'ERROR'; finalReason = 'INPUT_RESULT_MISMATCH'; providerError = BOLOO_REASON_TEXT.INPUT_RESULT_MISMATCH;
    } else if (status === 'ERROR') {
      if (!BOLOO_ERROR_REASONS.has(reason_code)) throw Object.assign(new Error('ERROR 必须使用 LOGIN_EXPIRED、NAVIGATION_FAILED、DOM_FIELD_MISSING、INPUT_RESULT_MISMATCH、NETWORK_FAILED 或 UNKNOWN_PROVIDER_ERROR。'), { code: 'BOLOO_ERROR_REASON_INVALID' });
      providerError = safeProviderMessage(error?.message, BOLOO_REASON_TEXT[reason_code]);
    } else if (status === 'PASS' || status === 'PASS_NO_RESULT') {
      if (!evidenceComplete) {
        finalStatus = 'ERROR'; finalReason = evidenceQuery !== query_text ? 'INPUT_RESULT_MISMATCH' : 'DOM_FIELD_MISSING';
        providerError = BOLOO_REASON_TEXT[finalReason];
      } else if (status === 'PASS') {
        const allowedSuccessReasons = subtask.provider_source === 'keyword_explorer' ? ['RESULT_FOUND', 'EXPLORER_ZERO_VOLUME'] : ['RESULT_FOUND', 'KEYWORDS_FOUND'];
        if (!BOLOO_SUCCESS_REASONS.has(reason_code) || !allowedSuccessReasons.includes(reason_code)) throw Object.assign(new Error(`PASS 的 reason_code 对 ${subtask.provider_source} 不合法。`), { code: 'BOLOO_SUCCESS_REASON_INVALID' });
        if (subtask.provider_source === 'keyword_explorer' && (!Number.isFinite(result?.search_volume) || result.search_volume < 0)) throw Object.assign(new Error('Keyword Explorer PASS 必须包含官方页面对应的非负数值 search_volume；无结果不能伪装成搜索量。'), { code: 'BOLOO_OFFICIAL_VOLUME_MISSING' });
        if (reason_code === 'EXPLORER_ZERO_VOLUME' && subtask.provider_source !== 'keyword_explorer') throw Object.assign(new Error('EXPLORER_ZERO_VOLUME 只能用于 Keyword Explorer。'), { code: 'BOLOO_REASON_SOURCE_MISMATCH' });
        if (reason_code === 'EXPLORER_ZERO_VOLUME' && !['0', '0.0', '0,0'].includes(String(normalized.evidence.displayed_value).trim())) throw Object.assign(new Error('EXPLORER_ZERO_VOLUME 的 displayed_value 必须精确表示 0。'), { code: 'BOLOO_ZERO_VOLUME_EVIDENCE_INVALID' });
        if (subtask.provider_source === 'keyword_explorer' && ['0', '0.0', '0,0'].includes(String(normalized.evidence.displayed_value).trim()) && reason_code !== 'EXPLORER_ZERO_VOLUME') throw Object.assign(new Error('Keyword Explorer 显示搜索量 0 时 reason_code 必须为 EXPLORER_ZERO_VOLUME。'), { code: 'BOLOO_ZERO_VOLUME_REASON_REQUIRED' });
        if (subtask.provider_source === 'keyword_explorer' && (result.search_volume === 0) !== ['0', '0.0', '0,0'].includes(String(normalized.evidence.displayed_value).trim())) throw Object.assign(new Error('Keyword Explorer 页面显示值与结构化 search_volume 不一致。'), { code: 'BOLOO_VOLUME_EVIDENCE_MISMATCH' });
        if (result == null || (typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0)) throw Object.assign(new Error('PASS 必须包含非空结构化 result。'), { code: 'BOLOO_RESULT_BODY_MISSING' });
      } else {
        const expectedNoResultReason = subtask.provider_source === 'keyword_extractor' ? 'EXTRACTOR_NO_KEYWORDS' : 'EXPLORER_NO_RESULTS';
        if (reason_code !== expectedNoResultReason || normalized.evidence.no_result_confirmed !== true) throw Object.assign(new Error(`PASS_NO_RESULT 当前来源要求 reason_code=${expectedNoResultReason}，并需提供 no_result_confirmed=true。`), { code: 'BOLOO_NO_RESULT_EVIDENCE_INVALID' });
        if (!String(normalized.evidence.displayed_value).trim()) throw Object.assign(new Error('PASS_NO_RESULT 必须记录页面显示的无结果状态。'), { code: 'BOLOO_NO_RESULT_EVIDENCE_INVALID' });
      }
    } else {
      const pendingReasons = subtask.provider_source === 'keyword_extractor' ? ['PAGE_NOT_READY', 'EXTRACTOR_NO_KEYWORDS'] : ['PAGE_NOT_READY'];
      if (!pendingReasons.includes(reason_code)) throw Object.assign(new Error(`PENDING_RECHECK 的 reason_code 对 ${subtask.provider_source} 不合法。`), { code: 'BOLOO_PENDING_REASON_INVALID' });
      if (evidenceQuery && evidenceQuery !== query_text) { finalStatus = 'ERROR'; finalReason = 'INPUT_RESULT_MISMATCH'; providerError = BOLOO_REASON_TEXT[finalReason]; }
      if (reason_code === 'EXTRACTOR_NO_KEYWORDS' && (!evidenceComplete || normalized.evidence.no_result_confirmed !== true)) throw Object.assign(new Error('Extractor 无关键词重试必须附带稳定页面的明确无结果证据。'), { code: 'BOLOO_NO_RESULT_EVIDENCE_INVALID' });
    }

    if (subtask.provider_source === 'keyword_extractor' && finalReason === 'EXTRACTOR_NO_KEYWORDS' && ['PENDING_RECHECK', 'PASS_NO_RESULT'].includes(finalStatus)) {
      subtask.extractor_no_keyword_attempts = Number(subtask.extractor_no_keyword_attempts || 0) + 1;
      if (subtask.extractor_no_keyword_attempts === 1) {
        finalStatus = 'PENDING_RECHECK';
        normalized.retry_policy = 'EXTRACTOR_NO_KEYWORDS_ONCE';
      } else {
        finalStatus = 'PASS_NO_RESULT';
        normalized.evidence ||= {};
        normalized.evidence.no_result_confirmed = true;
      }
    }

    normalized.status = finalStatus;
    normalized.reason_code = finalReason;
    if (finalStatus === 'PASS') normalized.cache_source = 'BOLOO_OFFICIAL_WEB';
    if (providerError) normalized.error_message = providerError;
    normalized.error = finalStatus === 'ERROR' ? { code: finalReason, message: providerError || BOLOO_REASON_TEXT[finalReason] } : null;
    subtask.attempt_count = attempt;
    subtask.request_ids ||= [];
    subtask.request_ids.push(request_id);
    subtask.history ||= [];
    subtask.history.push(clone(normalized));
    subtask.result = clone(normalized);
    subtask.status = finalStatus;
    subtask.error_code = finalStatus === 'ERROR' ? finalReason : null;
    subtask.updated_at = iso();
    if (subtask.provider_source === 'keyword_explorer') {
      for (const origin of subtask.origin_sources || []) addBolooCandidate(task, subtask.query_text, origin, finalStatus === 'PASS' ? {
        status: 'CONFIRMED_VOLUME', volume: normalized.result.search_volume, volumeEvidence: {
          source: 'BOLOO_OFFICIAL_WEB', subtask_id: subtask.subtask_id, request_id,
          reason_code: normalized.reason_code, observed_at: normalized.observed_at,
          page_url: normalized.evidence.page_url, matched_query: normalized.evidence.matched_query,
          displayed_value: normalized.evidence.displayed_value,
        },
      } : { status: 'NO_RESULT', noResultEvidence: {
        source: 'BOLOO_OFFICIAL_WEB', subtask_id: subtask.subtask_id, request_id,
        reason_code: normalized.reason_code, observed_at: normalized.observed_at,
        page_url: normalized.evidence?.page_url, matched_query: normalized.evidence?.matched_query,
        displayed_value: normalized.evidence?.displayed_value,
      } });
    }
    task.boloo.current_subtask_id = subtask.subtask_id;
    task.boloo.current_source_id = subtask.source_id;

    if (finalStatus === 'ERROR') {
      bolooProviderError(task, subtask, subtaskIndex, normalized, finalReason, providerError || BOLOO_REASON_TEXT[finalReason]);
      await commit(dataRoot, task, 'BOLOO_PROVIDER_ERROR', { step: 'boloo_keywords', source_id, subtask_id, request_id, reason_code: finalReason });
      return { accepted: true, duplicate: false, sku: id, subtask_id, source_id, status: finalStatus, reason_code: finalReason, open_error_count: task.open_error_count };
    }

    if (finalStatus === 'PENDING_RECHECK') {
      subtask.retry_count = Number(subtask.retry_count || 0) + 1;
      task.status = 'PENDING_RECHECK'; task.resume_point = 'boloo_keywords';
      task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'PENDING_RECHECK', updated_at: iso() };
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'PENDING_RECHECK', updated_at: iso() };
      task.error_code = null; task.error_message = null;
      const retrySameSubtask = finalReason === 'EXTRACTOR_NO_KEYWORDS' && subtask.extractor_no_keyword_attempts === 1;
      await commit(dataRoot, task, 'BOLOO_SUBTASK_PENDING_RECHECK', { step: 'boloo_keywords', source_id, subtask_id, request_id, reason_code: finalReason, retry_same_subtask: retrySameSubtask });
      return { accepted: true, duplicate: false, sku: id, subtask_id, source_id, status: finalStatus, reason_code: finalReason, retry_same_subtask: retrySameSubtask, next_attempt: attempt + 1, next_subtask_id: subtask.subtask_id };
    }

    const nextSubtask = task.boloo.required_subtasks.find(candidate => !['PASS', 'PASS_NO_RESULT'].includes(candidate.status));
    task.boloo.current_subtask_id = nextSubtask?.subtask_id || null;
    task.boloo.current_source_id = nextSubtask?.source_id || null;
    task.status = 'RUNNING'; task.resume_point = 'boloo_keywords';
    task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'RUNNING', updated_at: iso() };
    task.sidecars.keywords = { ...task.sidecars.keywords, status: 'RUNNING', updated_at: iso() };
    await commit(dataRoot, task, 'BOLOO_SUBTASK_COMPLETED', { step: 'boloo_keywords', source_id, subtask_id, request_id, status: finalStatus, reason_code: finalReason, next_subtask_id: nextSubtask?.subtask_id || null });
    if (nextSubtask) return { accepted: true, duplicate: false, sku: id, subtask_id, source_id, status: finalStatus, reason_code: finalReason, next_subtask_id: nextSubtask.subtask_id, next_source_id: nextSubtask.source_id, next_query_text: nextSubtask.query_text };

    if (task.boloo.keyword_discovery_closed !== true) {
      await waitForBolooDiscovery(dataRoot, task);
      return { accepted: true, duplicate: false, sku: id, subtask_id, source_id, status: finalStatus, reason_code: finalReason, stage_qa: 'NOT_RUN', discovery_status: 'WAITING_FOR_MORE_CANDIDATES', next_step: 'boloo_keywords' };
    }

    task.outputs ||= {};
    task.outputs.boloo_keywords = { evidence: { source: 'BOLOO_OFFICIAL_WEB', required_subtasks: clone(task.boloo.required_subtasks), discovery_close_evidence: clone(task.boloo.discovery_close_evidence) }, open_error_count: activeIssueCount(task), created_at: iso() };
    const verification = await verifyCurrent(dataRoot, task);
    return { accepted: true, duplicate: false, sku: id, subtask_id, source_id, status: finalStatus, reason_code: finalReason, stage_qa: verification.passed ? 'PASS' : 'FAIL', next_step: verification.task.current_step, current_pool: verification.task.activity_pool };
  });
}

export async function getHistory(dataRoot, sku) {
  const id = productId(sku);
  if (!acceptanceMode(dataRoot)) {
    const row = dbFor(dataRoot).prepare('SELECT payload FROM products WHERE sku=?').get(id);
    if (row && JSON.parse(row.payload).master?.product_facts?.acceptance_fixture === true) return [];
  }
  return dbFor(dataRoot).prepare('SELECT event_id, at, sku, type, current_step, pool, details FROM task_events WHERE sku=? ORDER BY seq')
    .all(id).map(row => ({ ...row, details: JSON.parse(row.details) }));
}

async function commitCompetitorResearch(dataRoot, task, type, details = {}) {
  assertBusinessDispatchEnabled('Competitor-research task state mutation');
  const db = dbFor(dataRoot);
  task.revision = Number(task.revision || 0) + 1;
  task.research_task_version = task.revision;
  task.updated_at = iso();
  const event = {
    event_id: crypto.randomUUID(), task_id: task.id, sku: task.sku, at: task.updated_at,
    type, current_step: task.current_step, current_pool: task.current_pool, details,
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO competitor_research_tasks (id, sku, revision, current_pool, status, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, current_pool=excluded.current_pool,
        status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload`)
      .run(task.id, task.sku, task.revision, task.current_pool, task.status, task.updated_at, JSON.stringify(task));
    db.prepare('INSERT INTO competitor_research_versions (task_id, version, at, payload) VALUES (?, ?, ?, ?)')
      .run(task.id, task.revision, task.updated_at, JSON.stringify(task));
    db.prepare(`INSERT INTO competitor_research_events (event_id, task_id, sku, at, type, current_step, current_pool, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.event_id, task.id, task.sku, event.at, event.type, event.current_step, event.current_pool, JSON.stringify(details));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const researchRoot = path.join(dataRoot, 'competitor-research');
  await fs.mkdir(path.join(researchRoot, 'events'), { recursive: true });
  await Promise.all([
    atomicJson(path.join(researchRoot, 'tasks', `${task.id}.json`), task),
    atomicJson(path.join(researchRoot, 'versions', task.id, `${String(task.revision).padStart(6, '0')}.json`), { version: task.revision, at: task.updated_at, snapshot: task }),
    serialize('__competitor_research_events__', () => fs.appendFile(path.join(researchRoot, 'events', 'tasks.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')),
  ]);
  return { task, event };
}

export async function listCompetitorResearchTasks(dataRoot) {
  await initialize(dataRoot);
  return dbFor(dataRoot).prepare('SELECT payload FROM competitor_research_tasks ORDER BY updated_at DESC')
    .all().map(row => JSON.parse(row.payload));
}

export async function createCompetitorResearchTask(dataRoot, sku, seedUrl) {
  assertBusinessDispatchEnabled('Competitor-research task creation');
  await initialize(dataRoot);
  const id = productId(sku);
  const masterTask = await readTask(dataRoot, id);
  if (!masterTask) throw Object.assign(new Error(`SKU ${id} 不存在于 Product Master。`), { code: 'SKU_NOT_FOUND' });
  const seed = cleanText(seedUrl);
  let parsed;
  try { parsed = new URL(seed); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:') throw Object.assign(new Error('种子竞品必须是完整的 HTTPS URL。'), { code: 'RESEARCH_SEED_URL_INVALID' });
  const prior = (await listCompetitorResearchTasks(dataRoot)).find(item => item.sku === id && item.status !== 'ARCHIVED');
  if (prior) throw Object.assign(new Error(`SKU ${id} 已有独立竞品调研任务 ${prior.id}；不会覆盖现有调研历史。`), { code: 'RESEARCH_TASK_ALREADY_EXISTS' });
  const now = iso();
  const taskId = crypto.randomUUID();
  const task = {
    id: taskId, sku: id, revision: 0, research_task_version: 0, created_at: now, updated_at: now,
    seed_competitor_url: seed,
    product_baseline: {
      name: masterTask.master?.name || '', ean: masterTask.master?.ean || '', brand: masterTask.master?.brand || '',
      weight_kg: masterTask.master?.weight_kg ?? null,
      confirmed_core_terms: clone(masterTask.master?.confirmed_core_terms || []),
      product_facts: clone(masterTask.master?.product_facts || {}),
      fact_version: Number(masterTask.master?.fact_version || 1), source_refs: clone(masterTask.master?.source_refs || []),
    },
    current_step: COMPETITOR_RESEARCH_STEPS[0][0],
    current_pool: COMPETITOR_RESEARCH_STEPS[0][2],
    status: 'WAITING_DEPENDENCY', dependency: 'COMPETITOR_RESEARCH_ENGINE',
    stage_qa_status: 'NOT_RUN', resume_point: COMPETITOR_RESEARCH_STEPS[0][0], last_success_step: null,
    retry_count: 0, error_code: null, error_message: null, open_error_count: 0,
    qa: Object.fromEntries(COMPETITOR_RESEARCH_STEPS.map(([step]) => [step, { status: 'NOT_RUN', checked_at: null }])),
    stages: Object.fromEntries(COMPETITOR_RESEARCH_STEPS.map(([step, label, pool]) => [step, { label, pool, status: 'NOT_STARTED' }])),
    outputs: {}, final_archive: null,
  };
  task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'WAITING_DEPENDENCY' };
  const { task: saved } = await commitCompetitorResearch(dataRoot, task, 'COMPETITOR_RESEARCH_TASK_ADDED', {
    seed_competitor_url: seed, product_fact_version: task.product_baseline.fact_version,
    dependency: 'COMPETITOR_RESEARCH_ENGINE', stage_qa_status: 'NOT_RUN',
  });
  return saved;
}

export async function getCompetitorResearchHistory(dataRoot, taskId) {
  await initialize(dataRoot);
  return dbFor(dataRoot).prepare(`SELECT event_id, task_id, sku, at, type, current_step, current_pool, details
    FROM competitor_research_events WHERE task_id=? ORDER BY seq`).all(String(taskId))
    .map(row => ({ ...row, details: JSON.parse(row.details) }));
}

export async function exportTasks(dataRoot) {
  const rows = await listTasks(dataRoot);
  const header = ['sku', 'name', 'current_step', 'activity_pool', 'status', 'mabang_status', 'art_status', 'keywords_status', 'listing_status', 'verification_status', 'upload_status', 'updated_at'];
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [header, ...rows.map(task => [task.sku, task.master?.name, task.current_step, task.activity_pool, task.status, task.sidecars?.mabang?.status, task.sidecars?.art?.status, task.sidecars?.keywords?.status, task.sidecars?.listing?.status, task.sidecars?.verification?.status, task.sidecars?.upload?.status, task.updated_at])].map(row => row.map(quote).join(',')).join('\r\n');
  const directory = path.join(dataRoot, 'exports');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `BOL_SKU看板_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  await fs.writeFile(file, `\uFEFF${lines}\r\n`, 'utf8');
  return { file, rows: rows.length };
}

async function editMaster(task, patch) {
  const allowed = new Set(['ean', 'name', 'brand', 'brand_name', 'weight_kg', 'source_refs', 'product_facts', 'confirmed_core_terms']);
  const changed = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowed.has(key)) continue;
    if (key === 'weight_kg') task.master[key] = value === '' || value == null ? null : Number(value);
    else if (key === 'source_refs') task.master[key] = Array.isArray(value) ? value.map(cleanText).filter(Boolean) : cleanText(value).split(/[\n;,]/).map(cleanText).filter(Boolean);
    else if (key === 'product_facts') task.master[key] = typeof value === 'object' && value ? clone(value) : {};
    else if (key === 'confirmed_core_terms') task.master[key] = (Array.isArray(value) ? value : cleanText(value).split(/[\n;]/)).map(cleanText).filter(Boolean).slice(0, 3);
    else if (key === 'brand' || key === 'brand_name') {
      const brandName = cleanText(value);
      task.master.brand_name = brandName;
      task.master.brand = brandName;
    } else task.master[key] = cleanText(value);
    changed.push(key);
  }
  if (changed.length) {
    task.master.fact_version += 1;
    markDependentListingOutputsStale(task, task.master.fact_version, 'PRODUCT_MASTER_EDITED');
  }
  return changed;
}

export async function buildSop10RecoveryBindingContext(dataRoot, task, capabilityEvidenceRef = '') {
  const built = await buildSop10DeepSeekRecoveryIdentity(dataRoot, task);
  const state = await readAiGenerationState(dataRoot);
  const evidence = await readCapabilityEvidence(dataRoot, capabilityEvidenceRef || task.generation_recovery?.capability_evidence_ref);
  const plan = planDeepSeekProtocolMigration({ task, identity: built.identity, state });
  const config = (aiProviderConfig.providers || []).find(item => String(item.name).toLowerCase() === 'deepseek');
  const currentProviderIdentity = await buildProviderReadinessIdentity({ provider: 'DeepSeek', providerConfig: config,
    adapterMetadata: getAiProviderExecutionConfig('DeepSeek') });
  const qwenPartial = state.partial_results[built.qwen_identity.generation_key];
  return { built, evidence, probe: evidence.probe, ...plan, currentProviderIdentity,
    qwenPartial: isProviderPartialReusable(qwenPartial, built.qwen_identity) ? qwenPartial : null };
}

async function buildQwenSop10RecoveryBindingContext(dataRoot, task, capabilityEvidenceRef = '') {
  const inputs = await resolveSop10To17Inputs(dataRoot, task, 'LISTING_SOP_10');
  const config = getAiProviderExecutionConfig('Qwen');
  const identity = buildListingProviderGenerationIdentity({ task, step: 'LISTING_SOP_10', inputs, provider: 'Qwen', config });
  const state = await readAiGenerationState(dataRoot);
  const migrationPlan = planQwenSop10RequestContractMigration({ task, identity, state });
  const providerConfig = (aiProviderConfig.providers || []).find(item => String(item.name).toLowerCase() === 'qwen');
  const currentProviderIdentity = await buildProviderReadinessIdentity({ provider: 'Qwen', providerConfig,
    adapterMetadata: getAiProviderExecutionConfig('Qwen') });
  const evidence = capabilityEvidenceRef ? await readCapabilityEvidence(dataRoot, capabilityEvidenceRef) : null;
  return { identity, inputs, state, evidence, probe: evidence?.probe || null,
    ...migrationPlan, currentProviderIdentity, providerConfig };
}

async function buildDeepSeekListingStepRecoveryBindingContext(dataRoot, task, capabilityEvidenceRef = '') {
  const step = task?.current_step;
  if (step !== 'LISTING_SOP_14') throw Object.assign(new Error('Only the current SOP14 recovery step is enabled.'), { code: 'DEEPSEEK_LISTING_RECOVERY_STEP_NOT_ENABLED' });
  const inputs = await resolveSop10To17Inputs(dataRoot, task, step);
  const providerConfig = (aiProviderConfig.providers || []).find(item => String(item.name).toLowerCase() === 'deepseek');
  const identity = buildListingProviderGenerationIdentity({ task, step, inputs, provider: 'DeepSeek' });
  const qwenIdentity = buildListingProviderGenerationIdentity({ task, step, inputs, provider: 'Qwen' });
  const state = await readAiGenerationState(dataRoot);
  const migrationPlan = planDeepSeekPromptContractMigration({ task, identity, state });
  const currentProviderIdentity = await buildProviderReadinessIdentity({ provider: 'DeepSeek', providerConfig,
    adapterMetadata: getAiProviderExecutionConfig('DeepSeek') });
  const evidence = capabilityEvidenceRef ? await readCapabilityEvidence(dataRoot, capabilityEvidenceRef) : null;
  const qwenPartialRecord = state.partial_results?.[qwenIdentity.generation_key] || null;
  const qwenProviderConfig = (aiProviderConfig.providers || []).find(item => String(item.name).toLowerCase() === 'qwen');
  const qwenRoute = await resolveListingProviderRecoveryRouteReadiness({ dataRoot, provider: 'Qwen',
    identity: qwenIdentity, partialRecord: qwenPartialRecord, providerConfig: qwenProviderConfig,
    adapterMetadata: getAiProviderExecutionConfig('Qwen'), runtimeEnvironment: process.env.BOL_RUNTIME_ENVIRONMENT });
  return { step, inputs, identity, qwenIdentity, state, migrationPlan, wait: migrationPlan.wait,
    circuit: state.circuits?.[identity.generation_key] || migrationPlan.circuit, currentProviderIdentity,
    evidence, probe: evidence?.probe || null, qwenPartialRecord,
    qwenPartial: isProviderPartialReusable(qwenPartialRecord, qwenIdentity) ? qwenPartialRecord : null, qwenRoute };
}

async function buildDeepSeekListingStepRecoveryPreflight(dataRoot, task) {
  const checks = {};
  const check = (name, passed, details = null) => { checks[name] = { status: passed ? 'PASS' : 'FAIL', ...(details ? { details } : {}) }; };
  check('acceptance_scope', process.env.BOL_ACCEPTANCE_MODE === '1' && acceptanceMode(dataRoot)
    && task?.sku === 'SYNTHETIC-SKU-LEGACY-05' && task?.master?.source_product_id === 'SYNTHETIC_ACCEPTANCE_05');
  const step = task?.current_step;
  check('current_step_checkpoint', step === 'LISTING_SOP_14' && task?.resume_point === step && task?.last_success_step === 'LISTING_SOP_13');
  check('dependency_wait', task?.status === 'WAITING_DEPENDENCY' && task?.waiting_dependency_key === 'DEEPSEEK'
    && task?.ai_generation_waiting?.provider === 'DeepSeek' && task?.ai_generation_waiting?.step === step);
  check('no_open_errors', Number(task?.open_error_count || 0) === 0);
  check('no_sop14_success', !task?.outputs?.[sop10To17OutputKey(step)]?.version && task?.qa?.[step]?.status !== 'PASS');
  const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task?.sku)?.n || 0);
  check('no_active_lease', activeLeaseCount === 0);
  let context = null;
  const capabilityEvidenceRef = String(task?.generation_recovery?.capability_evidence_ref || '');
  try {
    context = await buildDeepSeekListingStepRecoveryBindingContext(dataRoot, task, capabilityEvidenceRef);
    const capabilityEvidenceValid = Boolean(capabilityEvidenceRef && context.evidence?.probe);
    check('current_identity_and_evidence', capabilityEvidenceValid, {
      code: capabilityEvidenceValid ? 'CAPABILITY_EVIDENCE_VALID'
        : capabilityEvidenceRef ? 'CAPABILITY_EVIDENCE_INVALID' : 'CAPABILITY_EVIDENCE_REF_REQUIRED' });
  } catch (error) { check('current_identity_and_evidence', false, { code: error?.code || 'DEEPSEEK_RECOVERY_CONTEXT_INVALID' }); }
  const { identity, qwenIdentity, wait, probe, circuit, currentProviderIdentity, qwenPartial, qwenRoute, state } = context || {};
  const recoveryWait = wait || task?.ai_generation_waiting;
  check('deepseek_recovery_context', Boolean(recoveryWait?.generation_key === identity?.generation_key
    && recoveryWait?.provider === 'DeepSeek' && recoveryWait?.effective_model === identity?.effective_model
    && recoveryWait?.input_version_hash === identity?.input_version_hash
    && recoveryWait?.prompt_hash === identity?.prompt_hash
    && recoveryWait?.prompt_contract_version === identity?.prompt_contract_version
    && recoveryWait?.identity_migration_version
    && Date.parse(String(recoveryWait?.generation_failed_at || '')) === Date.parse(String(task?.dependency_failed_at || ''))));
  check('qwen_route_ready', qwenRoute?.ready === true, { source: qwenRoute?.route_readiness_source || 'UNAVAILABLE',
    new_call_required: qwenRoute?.new_call_required !== false, reason: qwenRoute?.reason || null });
  let route = { allowed: false, reason: 'RECOVERY_CONTEXT_UNAVAILABLE', route_readiness_source: 'CONTROL_PLANE' };
  if (context && task?.generation_recovery?.status === 'RECOVERY_AUTHORIZED') {
    route = await evaluateGenerationRecoveryRoute(dataRoot, { wait: recoveryWait, identity,
      consumedProbeId: task.generation_recovery.probe_id, consumedCircuitState: task.generation_recovery.circuit_state });
  }
  check('deepseek_generation_recovery_route', route.allowed === true, { reason: route.reason || null,
    route_readiness_source: route.route_readiness_source || null });
  if (context) {
    const migration = state?.identity_migrations?.[recoveryWait.identity_migration_version];
    check('prompt_identity_migration_preserves_failure_history', Boolean(migration
      && migration.version === recoveryWait.identity_migration_version && migration.history_relabelled === false
      && migration.old_failure_barrier === recoveryWait.generation_failed_at
      && circuit?.identity_migration_version === migration.version
      && Number(circuit?.inherited_failure_count) >= 1));
    check('probe_current_provider_identity', Boolean(probe && currentProviderIdentity
      && probe.endpoint_identity_hash === currentProviderIdentity.endpoint_identity_hash
      && probe.provider_config_hash === currentProviderIdentity.provider_config_hash
      && probe.adapter_contract_hash === currentProviderIdentity.adapter_contract_hash
      && probe.network_config_hash === currentProviderIdentity.network_config_hash
      && probe.adapter_version === currentProviderIdentity.adapter_version
      && probe.adapter_contract_version === currentProviderIdentity.adapter_contract_version));
  }
  const failures = Object.entries(checks).filter(([, item]) => item.status !== 'PASS').map(([name]) => name);
  return { allowed: failures.length === 0, failures, checks, SOP_STEP_RECOVERY_ROUTE_READY: failures.length === 0,
    QWEN_ROUTE_SOURCE: qwenRoute?.route_readiness_source || 'UNAVAILABLE',
    QWEN_NEW_CALL_REQUIRED: qwenRoute?.new_call_required !== false,
    QWEN_CONTROL_PLANE_EVIDENCE: qwenRoute?.evidence || null,
    DEEPSEEK_ROUTE_SOURCE: route.allowed ? 'GENERATION_RECOVERY' : 'UNAVAILABLE',
    generation_key: identity?.generation_key || null, probe_id: probe?.probe_id || null,
    task_revision: task?.revision, task_status: task?.status, current_step: task?.current_step,
    external_requests: 0 };
}

async function buildQwenSop10RecoveryPreflight(dataRoot, task, capabilityEvidenceRef = '') {
  const checks = {};
  const check = (name, passed, details = null) => { checks[name] = { status: passed ? 'PASS' : 'FAIL', ...(details ? { details } : {}) }; };
  const acceptanceScope = process.env.BOL_ACCEPTANCE_MODE === '1' && acceptanceMode(dataRoot)
    && task?.sku === 'SYNTHETIC-SKU-LEGACY-05' && task?.master?.source_product_id === 'SYNTHETIC_ACCEPTANCE_05';
  check('acceptance_scope', acceptanceScope);
  check('current_sop10_checkpoint', task?.current_step === 'LISTING_SOP_10'
    && task?.resume_point === 'LISTING_SOP_10' && task?.last_success_step === 'LISTING_SOP_09');
  check('eligible_task_state', task?.status === 'PAUSED'
    || (task?.status === 'WAITING_DEPENDENCY' && task?.waiting_dependency_key === 'QWEN'));
  check('no_open_errors', Number(task?.open_error_count || 0) === 0);
  check('no_sop10_pass', !task?.outputs?.buyer_insights?.version && task?.qa?.LISTING_SOP_10?.status !== 'PASS');
  const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task?.sku)?.n || 0);
  check('no_active_lease', activeLeaseCount === 0);
  let context = null;
  try { context = await buildQwenSop10RecoveryBindingContext(dataRoot, task, capabilityEvidenceRef); }
  catch (error) { check('current_qwen_identity_and_evidence', false, { code: error?.code || 'QWEN_RECOVERY_CONTEXT_INVALID' }); }
  const { identity, wait, probe, circuit, migration, currentProviderIdentity } = context || {};
  check('qwen_recovery_wait', Boolean(wait?.provider === 'Qwen' && wait?.step === 'LISTING_SOP_10'
    && Date.parse(String(wait.generation_failed_at || '')) === Date.parse(String(task?.dependency_failed_at || ''))
    && Date.parse(String(wait.required_generation_readiness_after || '')) === Date.parse(String(wait.generation_failed_at || ''))));
  if (task?.generation_recovery?.status === 'RECOVERY_AUTHORIZED' && task?.generation_recovery?.provider === 'Qwen') {
    const route = await evaluateGenerationRecoveryRoute(dataRoot, {
      wait: task.ai_generation_waiting, identity: task.ai_generation_waiting,
      consumedProbeId: task.generation_recovery.probe_id,
      consumedCircuitState: task.generation_recovery.circuit_state,
    });
    check('qwen_generation_recovery_route_ready', route.allowed === true, { reason: route.reason || null,
      route_readiness_source: route.route_readiness_source || null });
    return {
      allowed: acceptanceScope && Object.values(checks).every(item => item.status === 'PASS'),
      checks, failures: Object.entries(checks).filter(([, item]) => item.status !== 'PASS').map(([name]) => name),
      QWEN_ROUTE_SOURCE: route.allowed ? 'GENERATION_RECOVERY' : 'UNAVAILABLE',
      SOP10_RECOVERY_ROUTE_READY: route.allowed === true, generation_key: identity?.generation_key || null,
      probe_id: task.generation_recovery.probe_id, external_requests: 0,
      task_revision: task.revision, task_status: task.status, current_step: task.current_step,
      resume_point: task.resume_point,
    };
  }
  const validation = validateQwenSop10RecoveryBinding({ task, activeLeaseCount, identity, wait, probe,
    currentProviderIdentity, circuit, migration });
  for (const [name, passed] of Object.entries(validation.checks)) check(`binding_${name}`, passed);
  return {
    allowed: acceptanceScope && Object.values(checks).every(item => item.status === 'PASS'),
    checks, failures: Object.entries(checks).filter(([, item]) => item.status !== 'PASS').map(([name]) => name),
    QWEN_ROUTE_SOURCE: validation.allowed ? 'GENERATION_RECOVERY' : 'UNAVAILABLE',
    SOP10_RECOVERY_ROUTE_READY: validation.allowed, generation_key: identity?.generation_key || null,
    probe_id: probe?.probe_id || null, external_requests: 0,
    task_revision: task.revision, task_status: task.status, current_step: task.current_step,
    resume_point: task.resume_point,
  };
}

async function buildSYNTHETIC_ACCEPTANCE_10Sop10RecoveryPreflight(dataRoot, task, capabilityEvidenceRef = '') {
  const checks = {};
  const failures = [];
  const check = (key, passed, details = null) => {
    checks[key] = { status: passed ? 'PASS' : 'FAIL', ...(details ? { details } : {}) };
    if (!passed) failures.push(key);
  };
  const acceptanceScope = process.env.BOL_ACCEPTANCE_MODE === '1' && acceptanceMode(dataRoot)
    && task?.sku === 'SYNTHETIC-SKU-LEGACY-10' && task?.master?.source_product_id === 'SYNTHETIC_ACCEPTANCE_10';
  check('acceptance_scope', acceptanceScope);
  check('current_sop10_resume_state', task?.current_step === 'LISTING_SOP_10'
    && task?.resume_point === 'LISTING_SOP_10' && task?.last_success_step === 'LISTING_SOP_09');
  const allowedTaskStatus = task?.status === 'PAUSED'
    || (task?.status === 'WAITING_DEPENDENCY' && task?.waiting_dependency_key === 'DEEPSEEK');
  check('allowed_current_task_status', allowedTaskStatus, {
    revision: task?.revision, status: task?.status, waiting_dependency_key: task?.waiting_dependency_key,
  });
  check('no_open_business_errors', Number(task?.open_error_count || 0) === 0);
  check('no_formal_sop10_pass', !task?.outputs?.buyer_insights?.version && task?.qa?.LISTING_SOP_10?.status !== 'PASS');
  const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task?.sku)?.n || 0);
  check('no_active_execution_lease', activeLeaseCount === 0);

  let built = null;
  let context = null;
  try { context = await buildSop10RecoveryBindingContext(dataRoot, task, capabilityEvidenceRef); built = context.built; }
  catch (error) { check('sop10_inputs_and_prompt_identity', false, { code: error?.code || 'INPUT_RESOLUTION_FAILED' }); }
  const inputs = built?.inputs;
  const identity = built?.identity;
  check('facts_v2', String(task?.outputs?.confirmed_product_facts?.version || '') === '2', {
    version: task?.outputs?.confirmed_product_facts?.version || null,
  });
  check('sop09_formal_pass', task?.last_success_step === 'LISTING_SOP_09'
    && task?.qa?.LISTING_SOP_09?.status === 'PASS'
    && task?.outputs?.competitor_analysis?.version === 'LISTING_COMPETITOR_ANALYSIS-deb1d3f9e9df46d43230', {
    version: task?.outputs?.competitor_analysis?.version || null,
  });
  check('sop09_source_and_version_readable', Boolean(inputs?.input_version_refs?.length === 1
    && inputs.input_version_refs[0]?.version === 'LISTING_COMPETITOR_ANALYSIS-deb1d3f9e9df46d43230'));
  check('deepseek_configured_effective_model', Boolean(built?.provider_config?.requested_model
    && built?.provider_config?.effective_request_model === identity?.effective_model
    && built?.provider_config?.adapter_contract_version === identity?.adapter_contract_version
    && built?.provider_config?.api_protocol === 'RESPONSES'
    && built?.provider_config?.structured_output === 'json_schema'));

  const currentIdentity = context?.currentProviderIdentity;
  check('deepseek_config_identity_available', Boolean(currentIdentity));
  const probe = context?.probe;
  const waitContext = context?.wait;
  const qwenPartial = context?.qwenPartial;
  const circuit = context?.circuit;
  const bindingValidation = validateSop10RecoveryBinding({
    task, activeLeaseCount, identity, wait: waitContext, probe,
    currentProviderIdentity: currentIdentity, circuit, qwenPartial, qwenIdentity: built?.qwen_identity,
  });
  for (const [name, passed] of Object.entries(bindingValidation.checks)) check(`binding_${name}`, passed);
  const qwenCachedRouteReady = Boolean(qwenPartial);
  check('qwen_cached_route_ready', qwenCachedRouteReady, {
    route_readiness_source: qwenCachedRouteReady ? 'CACHED_SUCCESS' : 'UNAVAILABLE',
    control_plane_probe_required: !qwenCachedRouteReady,
    provider_calls_required: qwenCachedRouteReady ? 0 : 1,
    probe_requests: 0,
  });

  const alreadyBound = task?.generation_recovery?.status === 'RECOVERY_AUTHORIZED'
    && task?.generation_recovery?.generation_key === identity?.generation_key
    && task?.generation_recovery?.probe_id === probe?.probe_id
    && task?.generation_recovery?.circuit_state === 'HALF_OPEN'
    && Boolean(task?.generation_recovery?.binding_version);
  let generationRoute = {
    allowed: bindingValidation.allowed,
    reason: bindingValidation.failures.join(',') || 'FRESH_MATCHED_PROBE_AND_CURRENT_CIRCUIT',
    route_readiness_source: 'GENERATION_RECOVERY',
  };
  if (alreadyBound) generationRoute = await evaluateGenerationRecoveryRoute(dataRoot, {
    wait: waitContext, identity, consumedProbeId: task.generation_recovery.probe_id,
    consumedCircuitState: task.generation_recovery.circuit_state,
  });
  check('sop09_not_reexecuted', task?.last_success_step === 'LISTING_SOP_09' && task?.current_step === 'LISTING_SOP_10');
  check('deepseek_generation_recovery_route_ready', generationRoute.allowed === true, {
    route_readiness_source: generationRoute.route_readiness_source || 'GENERATION_RECOVERY',
    reason: generationRoute.reason || null, probe_id: probe?.probe_id || null,
  });

  return {
    allowed: failures.length === 0, failures, checks,
    SOP10_RECOVERY_ROUTE_READY: failures.length === 0,
    QWEN_ROUTE_SOURCE: qwenCachedRouteReady ? 'CACHED_SUCCESS' : 'UNAVAILABLE',
    QWEN_NEW_CALL_REQUIRED: !qwenCachedRouteReady,
    DEEPSEEK_ROUTE_SOURCE: generationRoute.allowed ? 'GENERATION_RECOVERY' : 'UNAVAILABLE',
    api_protocol: identity?.execution_contract?.api_protocol || null,
    structured_output: identity?.execution_contract?.structured_output || null,
    generation_key: identity?.generation_key || null, input_version_refs: identity?.input_version_refs || [],
    facts_version: String(task?.outputs?.confirmed_product_facts?.version || ''),
    prompt_contract_version: identity?.prompt_contract_version || null, prompt_hash: identity?.prompt_hash || null,
    probe_id: probe?.probe_id || null, probe_checked_at: probe?.checked_at || null,
    route_readiness_source: generationRoute.route_readiness_source || null,
    external_requests: 0, wait_context: waitContext,
    current_identity_hashes: currentIdentity ? {
      endpoint_identity_hash: currentIdentity.endpoint_identity_hash, provider_config_hash: currentIdentity.provider_config_hash,
      adapter_contract_hash: currentIdentity.adapter_contract_hash, network_config_hash: currentIdentity.network_config_hash,
      adapter_version: currentIdentity.adapter_version, adapter_contract_version: currentIdentity.adapter_contract_version,
    } : null,
  };
}
function currentSop04AutomaticSeedDecision(task) {
  const sourceRows = task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
  const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version
    || task.listing_sop?.steps?.LISTING_SOP_03?.output_version || null;
  const facts = task.outputs?.confirmed_product_facts;
  return {
    result: selectSop04SeedFromFacts({ facts, sourceRows, sop03ArtifactVersion: sop03Version }),
    sourceRows, sop03Version, facts,
  };
}

function persistAutomaticSop04SeedSelection(task, selection, { now = iso() } = {}) {
  const sourceRefs = clone(selection.source_refs || []);
  for (const item of task.listing_executor?.waiting_items || []) {
    if (!item.decided_at && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04') {
      resolveExecutorWaitingItem(task, item.waiting_id, selection.exact_string, now);
    }
  }
  task.sop04_seed_selection = {
    exact_string: selection.exact_string,
    selected_by: 'SYSTEM_RULE',
    selected_at: now,
    selection_policy: SOP04_SEED_SELECTION_POLICY,
    seed_selection_reason: selection.seed_selection_reason,
    selected_concept: selection.selected_concept || null,
    specificity: selection.specificity,
    decision_scope: 'SKU_ONLY',
    reusable_as_global_rule: false,
    source_refs: sourceRefs,
    facts_evidence_refs: clone(selection.facts_evidence_refs || []),
    sop03_artifact_version: selection.sop03_artifact_version,
    confirmed_product_facts_version: Number(selection.confirmed_product_facts_version),
  };
  task.listing_sop.decisions ||= [];
  task.listing_sop.decisions.push({
    type: 'SOP04_SEARCH_TERMS_SEED_AUTO_SELECTED',
    exact_string: selection.exact_string,
    selected_by: 'SYSTEM_RULE', at: now,
    selection_policy: SOP04_SEED_SELECTION_POLICY,
    seed_selection_reason: selection.seed_selection_reason,
    decision_scope: 'SKU_ONLY', reusable_as_global_rule: false,
    source_refs: sourceRefs,
    facts_evidence_refs: clone(selection.facts_evidence_refs || []),
    sop03_artifact_version: selection.sop03_artifact_version,
    confirmed_product_facts_version: Number(selection.confirmed_product_facts_version),
  });
  task.current_step = 'LISTING_SOP_04';
  task.resume_point = 'LISTING_SOP_04';
  task.listing_sop.current_step_id = 'LISTING_SOP_04';
  task.error_code = null; task.error_message = null;
  task.open_error_count = activeIssueCount(task);
  task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
}

function setSop04SeedSelectorWait(task, decision, { now = iso() } = {}) {
  const reason = decision.status === 'WAITING_DECISION'
    ? decision.reason || '有多个同等合理的核心产品本体词，且对应不同市场方向。'
    : '当前证据无法将 SOP03 exact-string 候选可靠映射到已确认的核心产品本体词；选择器未生成或猜测关键词。';
  if (decision.status === 'WAITING_DECISION') {
    const unresolved = (task.listing_executor?.waiting_items || []).find(item => !item.decided_at
      && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04');
    if (!unresolved) {
      createExecutorWaitingItem(task, {
        type: 'WAITING_DECISION', originating_sop_step: 'LISTING_SOP_04',
        current_value: (decision.candidates || []).filter(item => decision.decision_candidates?.includes(item.exact_string)),
        proposed_value_or_action: '仅在不同核心本体候选同等合理且市场方向不同的情况下，由 Leon 确认方向。',
        reason,
        evidence: [{ type: 'SOP04_SEED_SELECTOR_RESULT', policy: SOP04_SEED_SELECTION_POLICY,
          confirmed_product_facts_version: task.outputs?.confirmed_product_facts?.version ?? null,
          sop03_artifact_version: task.listing_executor?.registry?.LISTING_SOP_03?.output_version || null,
          decision_candidates: decision.decision_candidates || [] }],
        affected_downstream_modules: ['LISTING_SOP_04', 'LISTING_SOP_05'],
      });
    }
    task.status = 'WAITING_DECISION';
    task.waiting_dependency_key = null;
    task.activity_pool = '待人工确认'; task.current_pool = task.activity_pool;
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'WAITING_DECISION', dependency: null, waiting_reason: reason, updated_at: now };
  } else {
    task.status = 'WAITING_DEPENDENCY';
    task.waiting_dependency_key = 'LISTING_SOP04_SEED_SELECTOR';
    task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
    task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'WAITING_DEPENDENCY', dependency: task.waiting_dependency_key, waiting_reason: reason, updated_at: now };
  }
  task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04';
  task.listing_sop.current_step_id = 'LISTING_SOP_04';
  task.qa.LISTING_SOP_04 = { ...task.qa.LISTING_SOP_04, status: 'NOT_RUN', checked_at: null, report: null };
  task.error_code = null; task.error_message = null;
  return reason;
}

const LOCAL_TASK_RECONCILIATION_EVENT = 'LOCAL_STATE_RECONCILIATION_APPLIED';
const LOCAL_RECONCILIATION_TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'TLS_HANDSHAKE_FAILED']);

function stableJsonForReconciliation(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonForReconciliation).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonForReconciliation(value[key])}`).join(',')}}`;
}

async function reconcileLocalTaskState(dataRoot, task, payload) {
  if (!ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot)) {
    throw Object.assign(new Error('本地状态校正只允许在隔离的 NORMAL ACCEPTANCE_4181 HOLD 中执行。'), { code: 'LOCAL_STATE_RECONCILIATION_SCOPE_REJECTED' });
  }
  const idempotencyKey = String(payload?.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    throw Object.assign(new Error('本地状态校正必须提供稳定 idempotency_key。'), { code: 'LOCAL_STATE_RECONCILIATION_IDEMPOTENCY_KEY_REQUIRED' });
  }
  const requestFingerprint = crypto.createHash('sha256').update(stableJsonForReconciliation({
    reason_code: payload?.reason_code, target_state: payload?.target_state,
    dependency_context: payload?.dependency_context, resolve_waiting_items: payload?.resolve_waiting_items,
    decision_artifact: payload?.decision_artifact,
  })).digest('hex');
  const prior = (task.local_state_reconciliations || []).find(item => item.idempotency_key === idempotencyKey);
  if (prior) {
    if (prior.request_fingerprint !== requestFingerprint) throw Object.assign(new Error('idempotency_key 已用于不同的校正请求。'), { code: 'LOCAL_STATE_RECONCILIATION_IDEMPOTENCY_CONFLICT' });
    const saved = JSON.parse(await fs.readFile(safeMaterialPath(dataRoot, prior.artifact_ref), 'utf8'));
    if (saved.version !== prior.artifact_version || saved.sku !== task.sku) throw Object.assign(new Error('既有本地决策 artifact 与任务引用不匹配。'), { code: 'LOCAL_STATE_RECONCILIATION_ARTIFACT_MISMATCH' });
    return { task, reconciliation: clone(prior), idempotent_replay: true, external_requests: 0, leases_created: 0, executor_dispatched: false, dependency_resume: false };
  }

  assertTaskRevisionCAS(payload?.expected_revision, task.revision);
  const target = payload?.target_state;
  const dependencyContext = payload?.dependency_context ? clone(payload.dependency_context) : null;
  const resolutionItems = Array.isArray(payload?.resolve_waiting_items) ? payload.resolve_waiting_items : [];
  const decisionInput = payload?.decision_artifact;
  const allowedKeys = new Set(['expected_revision', 'idempotency_key', 'reason_code', 'target_state', 'dependency_context', 'resolve_waiting_items', 'decision_artifact']);
  const targetKeys = new Set(['status', 'current_step', 'resume_point', 'last_success_step', 'waiting_dependency_key']);
  const dependencyKeys = new Set(['dependency_key', 'evidence_ref', 'failed_at', 'transport_code', 'request_id']);
  if (Object.keys(payload || {}).some(key => !allowedKeys.has(key))
    || !target || !['WAITING_DEPENDENCY', 'PAUSED'].includes(target.status)
    || Object.keys(target).some(key => !targetKeys.has(key))
    || target.current_step !== task.current_step || target.resume_point !== task.current_step
    || target.last_success_step !== task.last_success_step
    || !['WAITING_DECISION', 'WAITING_CONFIRMATION', 'WAITING_DEPENDENCY', 'PAUSED'].includes(task.status)
    || task.qa?.[task.current_step]?.status !== 'NOT_RUN'
    || Number(task.open_error_count || 0) !== 0 || activeIssueCount(task) !== 0
    || !decisionInput || Object.keys(decisionInput).some(key => !['artifact_type', 'payload'].includes(key))
    || !/^[A-Z][A-Z0-9_]{2,100}$/.test(String(decisionInput.artifact_type || ''))
    || !decisionInput.payload || typeof decisionInput.payload !== 'object' || Array.isArray(decisionInput.payload)
    || Buffer.byteLength(JSON.stringify(decisionInput.payload), 'utf8') > 128 * 1024
    || !/^[A-Z][A-Z0-9_]{2,100}$/.test(String(payload.reason_code || ''))
    || !Array.isArray(payload.resolve_waiting_items)) {
    throw Object.assign(new Error('本地状态校正 payload 不符合窄化的状态与决策 contract。'), { code: 'LOCAL_STATE_RECONCILIATION_CONTRACT_INVALID' });
  }
  if (target.status === 'WAITING_DEPENDENCY') {
    if (typeof target.waiting_dependency_key !== 'string' || !target.waiting_dependency_key
      || dependencyContext?.dependency_key !== target.waiting_dependency_key || typeof dependencyContext?.evidence_ref !== 'string'
      || Object.keys(dependencyContext || {}).some(key => !dependencyKeys.has(key))) {
      throw Object.assign(new Error('WAITING_DEPENDENCY 必须有精确 dependency key 与本地 readiness evidence ref。'), { code: 'LOCAL_STATE_RECONCILIATION_DEPENDENCY_CONTEXT_REQUIRED' });
    }
    const readiness = JSON.parse(await fs.readFile(safeMaterialPath(dataRoot, dependencyContext.evidence_ref), 'utf8'));
    const diagnostic = readiness.oauth_diagnostics || readiness.endpoint_diagnostics || {};
    const transportCode = String(diagnostic.transport_code || '');
    if (target.waiting_dependency_key !== 'BOL_API' || readiness.status !== 'FAIL' || readiness.oauth_status !== 'FAIL'
      || diagnostic.response_received !== false || diagnostic.http_status !== null
      || !LOCAL_RECONCILIATION_TRANSPORT_CODES.has(transportCode)) {
      throw Object.assign(new Error('本地 readiness evidence 未证明 BOL_API transport failure；拒绝写入依赖等待。'), { code: 'LOCAL_STATE_RECONCILIATION_DEPENDENCY_EVIDENCE_INVALID' });
    }
    dependencyContext.failed_at = diagnostic.finished_at || readiness.checked_at;
    dependencyContext.transport_code = transportCode;
    dependencyContext.request_id = diagnostic.request_id || null;
    if (!Number.isFinite(Date.parse(String(dependencyContext.failed_at || '')))) throw Object.assign(new Error('readiness failure 缺少有效时间。'), { code: 'LOCAL_STATE_RECONCILIATION_FAILURE_TIME_MISSING' });
  } else if (target.waiting_dependency_key) {
    throw Object.assign(new Error('PAUSED 状态不得保留 waiting_dependency_key。'), { code: 'LOCAL_STATE_RECONCILIATION_PAUSED_DEPENDENCY_INVALID' });
  }

  const db = dbFor(dataRoot);
  const activeLeases = Number(db.prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
  if (activeLeases !== 0) throw Object.assign(new Error('存在 active execution lease；拒绝本地状态校正。'), { code: 'LOCAL_STATE_RECONCILIATION_ACTIVE_LEASE' });
  if (task.final_archive || task.final_archive_ref) throw Object.assign(new Error('最终归档任务不可进行本地状态校正。'), { code: 'FINAL_VERSION_LOCKED' });

  const at = iso();
  const openItems = [];
  for (const request of resolutionItems) {
    const item = (task.listing_executor?.waiting_items || []).find(row => row.waiting_id === request.waiting_id && !row.decided_at);
    if (!item || item.type !== request.expected_type || !['WAITING_DECISION', 'WAITING_CONFIRMATION'].includes(item.type)
      || item.originating_sop_step !== task.current_step || !/^[A-Z][A-Z0-9_]{2,100}$/.test(String(request.resolution_code || ''))) {
      throw Object.assign(new Error('待处理事项不存在、类型不匹配或不属于当前步骤。'), { code: 'LOCAL_STATE_RECONCILIATION_WAITING_ITEM_INVALID' });
    }
    openItems.push({ waiting_id: item.waiting_id, previous_type: item.type, resolution_code: request.resolution_code, decision_code: item.decision_code || null });
  }

  let sop04Checkpoint = null;
  if (decisionInput.artifact_type === 'SOP04_MULTI_SEED_DECISION_CHECKPOINT_V1') {
    if (task.current_step !== 'LISTING_SOP_04' || target.status !== 'WAITING_DEPENDENCY' || target.waiting_dependency_key !== 'BOL_API' || resolutionItems.length !== 1) {
      throw Object.assign(new Error('SOP04 decision checkpoint 只允许在当前 SOP04 BOL_API wait 中建立。'), { code: 'SOP04_LOCAL_CHECKPOINT_SCOPE_INVALID' });
    }
    const decision = decisionInput.payload;
    const sop04DecisionKeys = new Set(['primary_seed_exact_string', 'adopted_exact_strings', 'rejected_exact_strings', 'supplemental_seed_sequence', 'target_minimum', 'target_maximum', 'selection_reason']);
    if (Object.keys(decision).some(key => !sop04DecisionKeys.has(key))) throw Object.assign(new Error('SOP04 decision payload 包含未允许字段。'), { code: 'SOP04_LOCAL_CHECKPOINT_DECISION_INVALID' });
    const primarySeed = String(task.sop04_seed_selection?.exact_string || '');
    const facts = task.outputs?.confirmed_product_facts;
    const factsVersion = Number(facts?.version || 0);
    const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version || task.listing_sop?.steps?.LISTING_SOP_03?.output_version;
    const primaryRef = task.outputs?.bol_keywords?.evidence?.artifact_ref;
    if (!primaryRef || task.listing_sop?.steps?.LISTING_SOP_03?.qa_status !== 'PASS' || task.qa?.LISTING_SOP_03?.status !== 'PASS'
      || facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || facts?.status === 'STALE' || !primarySeed) {
      throw Object.assign(new Error('Facts、SOP03 或首轮 Search Terms artifact 缺失或已 stale。'), { code: 'SOP04_LOCAL_CHECKPOINT_INPUT_INVALID' });
    }
    const primaryArtifact = JSON.parse(await fs.readFile(safeMaterialPath(dataRoot, primaryRef), 'utf8'));
    const rawRows = primaryArtifact?.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms;
    if (primaryArtifact.sku !== task.sku || primaryArtifact.seed_exact_string !== primarySeed
      || Number(primaryArtifact.confirmed_product_facts_version) !== factsVersion
      || String(primaryArtifact.sop03_artifact_version) !== String(sop03Version) || !Array.isArray(rawRows)) {
      throw Object.assign(new Error('首轮 artifact 与当前 SKU、seed、Facts 或 SOP03 version 不匹配。'), { code: 'SOP04_LOCAL_CHECKPOINT_PRIMARY_ARTIFACT_MISMATCH' });
    }
    const firstExact = [...new Set(rawRows.map(row => typeof row?.searchTerm === 'string' ? row.searchTerm : '').filter(Boolean))];
    const adopted = decision.adopted_exact_strings;
    const rejected = decision.rejected_exact_strings;
    if (decision.primary_seed_exact_string !== primarySeed || !Array.isArray(adopted) || !Array.isArray(rejected)
      || !Array.isArray(decision.supplemental_seed_sequence)
      || new Set([...adopted, ...rejected]).size !== firstExact.length
      || [...adopted, ...rejected].some(value => !firstExact.includes(value))
      || adopted.some(value => rejected.includes(value))
      || Number(decision.target_minimum) !== 5 || Number(decision.target_maximum) !== 7) {
      throw Object.assign(new Error('首轮 ADOPT/REJECT 必须互斥且完整覆盖 raw exact strings，目标需为5–7。'), { code: 'SOP04_LOCAL_CHECKPOINT_DECISION_INVALID' });
    }
    const sourceRows = task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || [];
    const seedPlan = buildSop04SupplementalSeedPlan({ facts, sourceRows, primarySeed, preferredExactStrings: decision.supplemental_seed_sequence });
    if (seedPlan.invalid_preferred_exact_strings.length
      || JSON.stringify(seedPlan.seed_plan.map(item => item.exact_string)) !== JSON.stringify(decision.supplemental_seed_sequence)
      || seedPlan.seed_plan.some(item => !item.source_refs?.length)) {
      throw Object.assign(new Error('补充 seed 必须与当前 confirmed Facts 和 SOP03 PASS exact candidates 匹配。'), { code: 'SOP04_LOCAL_CHECKPOINT_SEED_PLAN_INVALID' });
    }
    const waiting = openItems.map(row => (task.listing_executor?.waiting_items || []).find(item => item.waiting_id === row.waiting_id))[0];
    if (waiting?.decision_code !== 'SELECT_5_TO_7_RELATED_TERMS') throw Object.assign(new Error('开放事项不是当前 SOP04 相关词门禁。'), { code: 'SOP04_LOCAL_CHECKPOINT_WAITING_ITEM_INVALID' });
    const adoptedTerms = adopted.map(exact_string => ({ exact_string, source_seed_exact_string: primarySeed,
      relevance_reason: 'Leon明确批准按当前 SYNTHETIC_ACCEPTANCE_05 confirmed facts 保留的 SOP04 相关词。', selection_source: 'LEON_INSTRUCTION_FACT_RULE' }));
    const annotations = [
      ...adopted.map(exact_string => ({ raw_position: firstExact.indexOf(exact_string) + 1, exact_string, status: 'ADOPTED_BY_LEON_FACT_RULE', reason_code: 'LEON_CONFIRMED_FACT_MATCH', matched_anchor: null })),
      ...rejected.map(exact_string => ({ raw_position: firstExact.indexOf(exact_string) + 1, exact_string, status: 'REJECT_AS_IRRELEVANT', reason_code: 'LEON_CONFIRMED_PRODUCT_DIRECTION_MISMATCH', matched_anchor: null })),
    ].sort((a, b) => a.raw_position - b.raw_position);
    sop04Checkpoint = {
      policy: SOP04_MULTI_SEED_POLICY, status: 'WAITING_DEPENDENCY', primary_seed_exact_string: primarySeed,
      initial_adopted_terms: adoptedTerms, initial_classifications: annotations, seed_plan: clone(seedPlan.seed_plan),
      next_seed_index: 0, active_seed_exact_string: null, adopted_exact_strings: adopted.slice(), target_minimum: 5, target_maximum: 7,
      confirmed_product_facts_version: factsVersion, sop03_artifact_version: sop03Version,
      primary_query_artifact_ref: primaryRef, primary_query_artifact_version: primaryArtifact.version,
      primary_query_record: sop04QueryRecordFromArtifact(primaryArtifact, primaryRef), local_decision_waiting_id: waiting.waiting_id,
      external_requests: 0, created_at: at,
    };
  }

  const artifactBase = {
    schema_version: 1, artifact_type: decisionInput.artifact_type, sku: task.sku, created_at: at,
    reason_code: payload.reason_code, revision_before: task.revision, source_step: task.current_step,
    source_status: task.status, target_state: clone(target),
    dependency_context: target.status === 'WAITING_DEPENDENCY' ? clone(dependencyContext) : null,
    resolved_waiting_items: clone(openItems), payload: clone(decisionInput.payload),
    ...(sop04Checkpoint ? { validated_sop04_checkpoint: clone(sop04Checkpoint) } : {}),
  };
  const artifactVersion = `LOCAL-STATE-RECONCILIATION-${crypto.createHash('sha256').update(stableJsonForReconciliation(artifactBase)).digest('hex').slice(0, 20)}`;
  const artifact = { ...artifactBase, version: artifactVersion };
  const artifactRef = path.join('artifacts', 'listing', task.sku, 'local-state-reconciliation', `${artifactVersion}.json`).replace(/\\/g, '/');
  const artifactPath = safeMaterialPath(dataRoot, artifactRef);
  try {
    const existing = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    if (stableJsonForReconciliation(existing) !== stableJsonForReconciliation(artifact)) throw Object.assign(new Error('同版本本地决策 artifact 内容冲突。'), { code: 'LOCAL_STATE_RECONCILIATION_ARTIFACT_COLLISION' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeAtomicJson(artifactPath, artifact);
  }

  for (const row of openItems) resolveExecutorWaitingItem(task, row.waiting_id, row.resolution_code, at);
  if (sop04Checkpoint) {
    task.sop04_confirmed_related_terms = sop04Checkpoint.initial_adopted_terms.map(item => ({ ...clone(item), selected_at: at,
      source_artifact_version: sop04Checkpoint.primary_query_artifact_version, decision_scope: 'SKU_ONLY' }));
    task.sop04_excluded_related_terms = decisionInput.payload.rejected_exact_strings.map(exact_string => ({ exact_string,
      status: 'REJECT_AS_IRRELEVANT', exclusion_reason: 'Leon按SYNTHETIC_ACCEPTANCE_05 confirmed facts明确排除：属于支架、装饰蝴蝶结或其他不同产品方向。',
      source_artifact_version: sop04Checkpoint.primary_query_artifact_version, decided_at: at, decision_scope: 'SKU_ONLY' }));
    task.sop04_multi_seed_completion = { ...(task.sop04_multi_seed_completion || {}), ...clone(sop04Checkpoint),
      decision_artifact_ref: artifactRef, decision_artifact_version: artifactVersion,
      started_at: task.sop04_multi_seed_completion?.started_at || at };
    task.outputs.bol_keywords = { ...task.outputs.bol_keywords, adopted_terms: clone(task.sop04_confirmed_related_terms),
      excluded_terms: clone(task.sop04_excluded_related_terms), adoption_status: 'MULTI_SEED_CHECKPOINT_WAITING_DEPENDENCY',
      local_decision_artifact_ref: artifactRef, local_decision_artifact_version: artifactVersion };
    task.listing_sop.decisions ||= [];
    task.listing_sop.decisions.push({ type: 'SOP04_MULTI_SEED_FACT_DECISION_RECORDED', selected_by: 'Leon',
      at, decision_scope: 'SYNTHETIC_ACCEPTANCE_05_ONLY', primary_seed_exact_string: sop04Checkpoint.primary_seed_exact_string,
      adopted_exact_strings: sop04Checkpoint.initial_adopted_terms.map(item => item.exact_string),
      rejected_exact_strings: decisionInput.payload.rejected_exact_strings.slice(),
      supplemental_seed_sequence: sop04Checkpoint.seed_plan.map(item => item.exact_string),
      source_artifact_version: sop04Checkpoint.primary_query_artifact_version,
      decision_artifact_ref: artifactRef, reusable_as_global_rule: false });
  }
  task.local_state_reconciliations ||= [];
  const reconciliation = { idempotency_key: idempotencyKey, request_fingerprint: requestFingerprint,
    artifact_type: artifact.artifact_type, artifact_ref: artifactRef, artifact_version: artifactVersion,
    applied_at: at, revision_before: task.revision, revision_after: task.revision + 1,
    from_status: task.status, to_status: target.status, current_step: task.current_step,
    resume_point: task.current_step, resolved_waiting_items: clone(openItems), dependency_key: target.waiting_dependency_key || null };
  task.local_state_reconciliations.push(reconciliation);
  task.status = target.status; task.waiting_dependency_key = target.status === 'WAITING_DEPENDENCY' ? target.waiting_dependency_key : null;
  task.current_step = target.current_step; task.resume_point = target.resume_point; task.last_success_step = target.last_success_step;
  task.stage_qa_status = 'NOT_RUN'; task.error_code = null; task.error_message = null;
  task.dependency_failed_at = target.status === 'WAITING_DEPENDENCY' ? dependencyContext.failed_at : null;
  task.required_readiness_after = target.status === 'WAITING_DEPENDENCY' ? dependencyContext.failed_at : null;
  task.activity_pool = task.current_step === 'LISTING_SOP_04' ? '关键词池' : task.activity_pool; task.current_pool = task.activity_pool;
  task.qa ||= {}; task.qa[task.current_step] = { ...(task.qa[task.current_step] || {}), status: 'NOT_RUN', checked_at: null, report: null };
  task.stages ||= {}; task.stages[task.current_step] = { ...(task.stages[task.current_step] || {}), status: target.status,
    dependency: task.waiting_dependency_key, waiting_reason: payload.reason_code, updated_at: at };
  task.listing_sop ||= { steps: {} }; task.listing_sop.steps ||= {}; task.listing_sop.current_step_id = task.current_step;
  task.listing_sop.steps[task.current_step] = { ...(task.listing_sop.steps[task.current_step] || {}), status: target.status,
    qa_status: 'NOT_RUN', dependency: task.waiting_dependency_key, waiting_reason: payload.reason_code, updated_at: at };
  task.listing_executor ||= { registry: {}, waiting_items: [], artifacts: { listing_outputs: {} } }; task.listing_executor.registry ||= {};
  task.listing_executor.registry[task.current_step] = { ...(task.listing_executor.registry[task.current_step] || {}), status: target.status,
    qa_status: 'NOT_RUN', dependency: task.waiting_dependency_key, waiting_reason: payload.reason_code, resume_point: task.current_step, updated_at: at };
  if (sop04Checkpoint) { task.sop04_multi_seed_completion.status = 'WAITING_DEPENDENCY'; task.sop04_multi_seed_completion.next_seed_index = 0; }
  await commit(dataRoot, task, LOCAL_TASK_RECONCILIATION_EVENT, {
    action: 'RECONCILE_LOCAL_TASK_STATE', reason_code: payload.reason_code, revision_before: reconciliation.revision_before,
    revision_after: reconciliation.revision_after, artifact_ref: artifactRef, artifact_version: artifactVersion,
    resolved_waiting_items: openItems.map(item => item.waiting_id), waiting_dependency_key: task.waiting_dependency_key,
    executor_dispatched: false, dependency_resume: false, external_requests: 0, provider_requests: 0, bol_requests: 0, leases_created: 0,
  }, { expectedRevision: payload.expected_revision });
  return { task, reconciliation: clone(reconciliation), idempotent_replay: false,
    external_requests: 0, leases_created: 0, executor_dispatched: false, dependency_resume: false };
}

async function registerSop09InputBundle(dataRoot, task, payload) {
  if (!ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot)) {
    throw Object.assign(new Error('SOP09 input bundle registration is restricted to the isolated NORMAL acceptance runtime under HOLD.'), { code: 'SOP09_INPUT_BUNDLE_REGISTRATION_SCOPE_REJECTED' });
  }
  assertTaskRevisionCAS(payload?.expected_revision, task.revision);
  if (Object.keys(payload || {}).some(key => !['expected_revision', 'input_bundle_ref', 'input_bundle_version'].includes(key))
    || typeof payload?.input_bundle_ref !== 'string' || typeof payload?.input_bundle_version !== 'string') {
    throw Object.assign(new Error('SOP09 input bundle registration requires an exact reference, version, and revision CAS.'), { code: 'SOP09_INPUT_BUNDLE_REGISTRATION_CONTRACT_INVALID' });
  }
  const bundlePath = safeMaterialPath(dataRoot, payload.input_bundle_ref);
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'));
  if (bundle.artifact_type !== 'SOP09_INPUT_BUNDLE_VERSION' || bundle.version !== payload.input_bundle_version
    || bundle.sku !== task.sku || bundle.status !== 'READY' || bundle.qa?.status !== 'PASS'
    || !Array.isArray(bundle.qa?.checks) || bundle.qa.checks.some(item => item.pass !== true)) {
    throw Object.assign(new Error('SOP09 input bundle identity or QA gate is invalid.'), { code: 'SOP09_INPUT_BUNDLE_QA_OR_IDENTITY_INVALID' });
  }
  const { version: _ignoredVersion, created_at: _ignoredCreatedAt, ...versionPayload } = bundle;
  const recomputedVersion = `SOP09_INPUT_BUNDLE-${crypto.createHash('sha256').update(stableJsonForReconciliation(versionPayload)).digest('hex').slice(0, 20)}`;
  if (recomputedVersion !== bundle.version) throw Object.assign(new Error('SOP09 input bundle content hash does not match its version.'), { code: 'SOP09_INPUT_BUNDLE_VERSION_HASH_MISMATCH' });

  const requiredTypes = ['EFFECTIVE_COMPETITOR_POOL_VERSION', 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION', 'BOL_PAGE_FACTS_VERSION',
    'BOL_API_FACTS_VERSION', 'AMAZON_EVIDENCE_BUNDLE_VERSION', 'AMAZON_PAGE_FACTS_VERSION', 'CONFIRMED_PRODUCT_FACTS_VERSION'];
  const refs = Array.isArray(bundle.input_version_refs) ? bundle.input_version_refs : [];
  const refsByType = new Map(refs.map(item => [item?.artifact_type, item]));
  if (refs.length !== requiredTypes.length || refsByType.size !== requiredTypes.length
    || requiredTypes.some(type => !refsByType.has(type) || !String(refsByType.get(type)?.version || '').trim())) {
    throw Object.assign(new Error('SOP09 input bundle must lock each required source exactly once.'), { code: 'SOP09_INPUT_BUNDLE_VERSION_LOCKS_INVALID' });
  }
  if (task.current_step !== 'LISTING_SOP_09' || task.resume_point !== 'LISTING_SOP_09'
    || task.last_success_step !== 'LISTING_SOP_08' || task.status !== 'WAITING_DEPENDENCY'
    || task.waiting_dependency_key !== 'SOP09_INPUTS' || task.qa?.LISTING_SOP_09?.status !== 'NOT_RUN'
    || Number(task.open_error_count || 0) !== 0 || activeIssueCount(task) !== 0
    || task.qa?.LISTING_SOP_08?.status !== 'PASS' || task.listing_sop?.steps?.LISTING_SOP_08?.qa_status !== 'PASS'
    || task.outputs?.competitor_analysis?.version) {
    throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_05 is not at the expected unexecuted SOP09 input-wait checkpoint.'), { code: 'SOP09_INPUT_BUNDLE_TASK_CHECKPOINT_MISMATCH' });
  }
  const db = dbFor(dataRoot);
  ensureListingExecutionLeaseSchema(db);
  const runningLeases = Number(db.prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
  if (runningLeases !== 0) throw Object.assign(new Error('SOP09 input registration is blocked by an active execution lease.'), { code: 'SOP09_INPUT_BUNDLE_ACTIVE_LEASE' });

  const stagedTask = clone(task);
  stagedTask.listing_executor ||= { registry: {} };
  stagedTask.listing_executor.registry ||= {};
  stagedTask.listing_executor.registry.LISTING_SOP_09 ||= {};
  stagedTask.listing_executor.registry.LISTING_SOP_09.input_version_refs = refs;
  const expectedVersions = expectedSop09RuntimeVersions(stagedTask, dataRoot);
  const inputVersions = bundle.expected_versions || {};
  for (const [key, expected] of Object.entries(expectedVersions)) {
    if (String(inputVersions[key] ?? '') !== String(expected)) throw Object.assign(new Error(`SOP09 input bundle ${key} lock does not match the exact source reference.`), { code: 'SOP09_INPUT_BUNDLE_VERSION_LOCK_MISMATCH', lock: key });
  }
  const inputs = await resolveSop09RuntimeInputs({ dataRoot, task, expectedVersions });
  const manifestSources = Array.isArray(bundle.source_file_refs) ? bundle.source_file_refs : [];
  const runtimeSources = inputs.sourceFileRefs.filter(item => item.source !== 'PRODUCT_FACTS_V2_TASK_RECORD');
  if (manifestSources.length !== runtimeSources.length) throw Object.assign(new Error('SOP09 input bundle source manifest does not cover the exact resolved source set.'), { code: 'SOP09_INPUT_BUNDLE_SOURCE_COVERAGE_MISMATCH' });
  for (const actual of runtimeSources) {
    const saved = manifestSources.find(item => item.source === actual.source && item.reference === actual.reference && item.version === actual.version);
    if (!saved || saved.sha256 !== actual.sha256) throw Object.assign(new Error(`SOP09 input bundle source hash mismatch for ${actual.source}.`), { code: 'SOP09_INPUT_BUNDLE_SOURCE_HASH_MISMATCH', source: actual.source });
  }
  const productFactsHash = crypto.createHash('sha256').update(stableJsonForReconciliation(inputs.productFacts)).digest('hex');
  if (bundle.product_facts_content_sha256 !== productFactsHash
    || String(bundle.product_facts_version) !== String(inputs.productFacts.version)) {
    throw Object.assign(new Error('SOP09 Product Facts content hash/version mismatch.'), { code: 'SOP09_INPUT_BUNDLE_PRODUCT_FACTS_MISMATCH' });
  }
  for (const source of bundle.lineage_refs || []) {
    const file = safeMaterialPath(dataRoot, source.reference);
    const bytes = await fs.readFile(file);
    const savedHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (savedHash !== source.sha256) throw Object.assign(new Error(`SOP09 upstream lineage source is stale: ${source.artifact_type}.`), { code: 'SOP09_INPUT_BUNDLE_LINEAGE_HASH_MISMATCH' });
    const artifact = JSON.parse(bytes.toString('utf8'));
    const sop03Suffix = String(source.version || '').startsWith('SOP03-SOURCES-') ? String(source.version).slice('SOP03-SOURCES-'.length) : '';
    const exactSop03PathBinding = source.artifact_type === 'SOP03_SOURCE_DISCOVERY_VERSION'
      && source.version_binding === 'TASK_VERSION_SUFFIX_EQUALS_EXACT_FILENAME'
      && /^[a-f0-9]{20,64}$/i.test(sop03Suffix)
      && task.outputs?.keyword_source_discovery?.version === source.version
      && path.basename(source.reference, path.extname(source.reference)) === sop03Suffix
      && artifact.version == null;
    const versionMatches = artifact.version === source.version || exactSop03PathBinding;
    if (!versionMatches || artifact.sku !== task.sku || artifact.artifact_type !== source.artifact_type) {
      throw Object.assign(new Error(`SOP09 upstream lineage source identity mismatch: ${source.artifact_type}.`), { code: 'SOP09_INPUT_BUNDLE_LINEAGE_IDENTITY_MISMATCH' });
    }
  }

  const at = iso();
  task.outputs.sop09_input_bundle = { artifact_type: bundle.artifact_type, version: bundle.version,
    evidence: { artifact_ref: payload.input_bundle_ref, sha256: crypto.createHash('sha256').update(await fs.readFile(bundlePath)).digest('hex') },
    input_versions: clone(bundle.expected_versions), qa_status: 'PASS', registered_at: at };
  task.listing_executor.registry.LISTING_SOP_09 = { ...task.listing_executor.registry.LISTING_SOP_09,
    executor_id: LISTING_COMPETITOR_ANALYSIS_EXECUTOR.executor_id, input_version_refs: clone(refs), status: 'READY', qa_status: 'NOT_RUN',
    waiting_reason: null, evidence_refs: [payload.input_bundle_ref], input_bundle_version: bundle.version, resume_point: 'LISTING_SOP_09', updated_at: at };
  task.status = 'PAUSED'; task.waiting_dependency_key = null; task.current_step = 'LISTING_SOP_09'; task.resume_point = 'LISTING_SOP_09';
  task.last_success_step = 'LISTING_SOP_08'; task.error_code = null; task.error_message = null;
  task.stages.LISTING_SOP_09 = { ...task.stages.LISTING_SOP_09, status: 'PAUSED', dependency: null, waiting_reason: null, updated_at: at };
  task.listing_sop.steps.LISTING_SOP_09 = { ...task.listing_sop.steps.LISTING_SOP_09, status: 'PAUSED', qa_status: 'NOT_RUN', dependency: null, waiting_reason: null, updated_at: at };
  task.qa.LISTING_SOP_09 = { ...task.qa.LISTING_SOP_09, status: 'NOT_RUN', checked_at: null, report: null };
  task.listing_sop.current_step_id = 'LISTING_SOP_09';
  await commit(dataRoot, task, 'SOP09_INPUT_BUNDLE_REGISTERED', { action: 'register_sop09_input_bundle',
    input_bundle_ref: payload.input_bundle_ref, input_bundle_version: bundle.version, input_versions: clone(bundle.expected_versions),
    status: 'PAUSED', executor_dispatched: false, dependency_resume: false, provider_requests: 0, bol_requests: 0, external_requests: 0,
    lease_created: false }, { expectedRevision: payload.expected_revision });
  return { task, input_bundle_version: bundle.version, registered: true, status: 'PAUSED', executor_dispatched: false,
    dependency_resume: false, provider_requests: 0, bol_requests: 0, external_requests: 0, lease_created: false };
}

async function revalidateCachedSop09Qa(dataRoot, task, payload) {
  if (!ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1' || !acceptanceMode(dataRoot)) {
    throw Object.assign(new Error('Cached SOP09 QA revalidation is restricted to the isolated NORMAL acceptance runtime under HOLD.'), { code: 'SOP09_CACHED_QA_SCOPE_REJECTED' });
  }
  assertTaskRevisionCAS(payload?.expected_revision, task.revision);
  if (Object.keys(payload || {}).some(key => !['expected_revision', 'analysis_version'].includes(key))
    || typeof payload?.analysis_version !== 'string') {
    throw Object.assign(new Error('Cached SOP09 QA revalidation requires an exact analysis version and revision CAS.'), { code: 'SOP09_CACHED_QA_CONTRACT_INVALID' });
  }
  const output = task.outputs?.competitor_analysis;
  const open = (task.issues || []).filter(issue => issue.status === 'OPEN');
  if (task.current_step !== 'LISTING_SOP_09' || task.resume_point !== 'LISTING_SOP_09'
    || task.last_success_step !== 'LISTING_SOP_08' || task.status !== 'ERROR'
    || task.error_code !== 'BOL_API_TEMPORAL_CONTEXT_PRESERVED'
    || task.qa?.LISTING_SOP_09?.status !== 'FAIL'
    || output?.version !== payload.analysis_version || output?.status !== 'DONE_PENDING_QA'
    || open.length !== 1 || open[0].step !== 'LISTING_SOP_09' || open[0].code !== 'BOL_API_TEMPORAL_CONTEXT_PRESERVED'
    || Number(task.open_error_count || 0) !== 1) {
    throw Object.assign(new Error('Cached SOP09 revalidation does not match the single known temporal-context integration failure.'), { code: 'SOP09_CACHED_QA_PRECONDITION_FAILED' });
  }
  const db = dbFor(dataRoot);
  ensureListingExecutionLeaseSchema(db);
  const active = Number(db.prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state IN ('RUNNING','ACQUIRED','RECOVERING')").get(task.sku)?.n || 0);
  if (active !== 0) throw Object.assign(new Error('Cached SOP09 revalidation is blocked by an active execution lease.'), { code: 'SOP09_CACHED_QA_ACTIVE_LEASE' });

  const candidate = clone(task);
  const issue = candidate.issues.find(item => item.issue_id === open[0].issue_id);
  issue.status = 'CLOSED';
  issue.closed_at = iso();
  issue.close_reason = 'REVALIDATED_AFTER_SOP09_RESOLVED_EVIDENCE_HYDRATION_FIX';
  issue.recovered_version = output.version;
  candidate.open_error_count = activeIssueCount(candidate);
  const problems = await validateStage(candidate, 'LISTING_SOP_09', dataRoot);
  if (problems.length) throw Object.assign(new Error(`Persisted SOP09 artifact still fails strict Stage QA: ${problems.map(item => item[0]).join(', ')}`), {
    code: 'SOP09_CACHED_QA_REVALIDATION_FAILED', failures: problems.map(item => ({ code: item[0], message: item[1] })),
  });

  const versions = expectedSop09RuntimeVersions(candidate, dataRoot);
  const inputs = await resolveSop09RuntimeInputs({ dataRoot, task: candidate, expectedVersions: versions });
  const artifactPath = safeMaterialPath(dataRoot, output.evidence.artifact_ref);
  const persistedArtifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
  const hydratedInputs = { ...inputs, bolEvidenceBundle: inputs.bolEvidenceBundleForAnalysis || inputs.bolEvidenceBundle };
  const qa = qaListingCompetitorAnalysis({ artifact: persistedArtifact, inputs: hydratedInputs });
  if (qa.status !== 'PASS') throw Object.assign(new Error('Cached SOP09 executor QA does not pass after strict input re-resolution.'), {
    code: 'SOP09_CACHED_QA_REVALIDATION_FAILED', failures: qa.checks.filter(item => !item.pass),
  });

  const checkedAt = iso();
  const reportBody = {
    schema_version: 1, artifact_type: 'SOP09_STAGE_QA_REVALIDATION', sku: task.sku,
    step: 'LISTING_SOP_09', analysis_version: output.version,
    reason: 'FINAL_STAGE_QA_USED_REFERENCE_ONLY_BOL_BUNDLE_INSTEAD_OF_RESOLVED_FACTS',
    prior_failure_code: task.error_code, prior_issue_id: issue.issue_id,
    checks: qa.checks, checked_at: checkedAt, executor_rerun: false, external_requests: 0,
  };
  const reportVersion = `SOP09_STAGE_QA_REVALIDATION-${crypto.createHash('sha256').update(stableJsonForReconciliation(reportBody)).digest('hex').slice(0, 20)}`;
  const report = { ...reportBody, version: reportVersion };
  const reportRef = `artifacts/listing/${task.sku}/sop09/${output.version}/${reportVersion}.json`;
  await fs.writeFile(safeMaterialPath(dataRoot, reportRef), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });

  const at = iso();
  candidate.qa.LISTING_SOP_09 = { status: 'PASS', checked_at: at, report: qa.checks, revalidation_ref: reportRef };
  candidate.stages.LISTING_SOP_09 = { ...candidate.stages.LISTING_SOP_09, status: 'PASS', qa_status: 'PASS', updated_at: at };
  candidate.listing_sop.steps.LISTING_SOP_09 = { ...candidate.listing_sop.steps.LISTING_SOP_09, status: 'PASS', qa_status: 'PASS', checked_at: at, updated_at: at };
  candidate.listing_sop.current_step_id = 'LISTING_SOP_10';
  candidate.last_success_step = 'LISTING_SOP_09';
  candidate.current_step = 'LISTING_SOP_10';
  candidate.resume_point = 'LISTING_SOP_10';
  candidate.status = 'PAUSED';
  candidate.waiting_dependency_key = null;
  candidate.error_code = null;
  candidate.error_message = null;
  candidate.open_error_count = activeIssueCount(candidate);
  candidate.stage_qa_status = 'NOT_RUN';
  candidate.stages.LISTING_SOP_10 = { ...candidate.stages.LISTING_SOP_10, status: 'PAUSED', qa_status: 'NOT_RUN', updated_at: at };
  candidate.listing_sop.steps.LISTING_SOP_10 = { ...candidate.listing_sop.steps.LISTING_SOP_10, status: 'PAUSED', qa_status: 'NOT_RUN', updated_at: at };
  candidate.listing_executor.registry.LISTING_SOP_09 = { ...candidate.listing_executor.registry.LISTING_SOP_09,
    status: 'PASS', qa_status: 'PASS', execution_status: 'REAL_EXECUTOR_PASS',
    evidence_refs: [...new Set([...(candidate.listing_executor.registry.LISTING_SOP_09.evidence_refs || []), reportRef])], completed_at: at, updated_at: at };
  candidate.outputs.competitor_analysis = { ...candidate.outputs.competitor_analysis, status: 'PASS', qa_status: 'PASS',
    evidence: { ...candidate.outputs.competitor_analysis.evidence, qa_revalidation_ref: reportRef } };
  candidate.sidecars.verification = { status: 'PASS', updated_at: at };
  await commit(dataRoot, candidate, 'LISTING_SOP_09_CACHED_QA_REVALIDATED', {
    analysis_version: output.version, revalidation_version: reportVersion, revalidation_ref: reportRef,
    resolved_issue_ids: [issue.issue_id], next_step: 'LISTING_SOP_10', next_step_dispatched: false,
    executor_rerun: false, provider_requests: 0, bol_requests: 0, external_requests: 0,
  }, { expectedRevision: payload.expected_revision });
  return { task: candidate, status: 'PASS', analysis_version: output.version,
    qa_revalidation_version: reportVersion, qa_revalidation_ref: reportRef,
    next_step: 'LISTING_SOP_10', next_step_dispatched: false, provider_requests: 0, external_requests: 0 };
}

async function inspectRecoverableSop05InternalEngineFailure(dataRoot, task) {
  if (task?.current_step !== 'LISTING_SOP_05' || task?.resume_point !== 'LISTING_SOP_05'
    || task?.status !== 'ERROR' || task?.error_code !== 'ENGINE_NOT_CONNECTED'
    || task?.last_success_step !== 'LISTING_SOP_04' || task?.qa?.LISTING_SOP_05?.status !== 'NOT_RUN'
    || Number(task?.open_error_count) !== 1 || activeIssueCount(task) !== 1
    || task?.outputs?.keyword_candidate_pool || task?.listing_sop?.steps?.LISTING_SOP_05?.output_version
    || task?.listing_executor?.registry?.LISTING_SOP_05?.output_version
    || typeof executeListingSop05CandidatePool !== 'function') return null;
  const openIssues = (task.issues || []).filter(issue => issue.status === 'OPEN');
  if (openIssues.length !== 1 || openIssues[0].code !== 'ENGINE_NOT_CONNECTED' || openIssues[0].step !== 'LISTING_SOP_05') return null;
  const activeLeases = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
  if (activeLeases !== 0) return null;
  const history = await getHistory(dataRoot, task.sku);
  let failedEventIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.type === 'STEP_ENGINE_UNAVAILABLE' && event?.current_step === 'LISTING_SOP_05'
      && event?.details?.step === 'LISTING_SOP_05' && event?.details?.resume_point === 'LISTING_SOP_05') {
      failedEventIndex = index;
      break;
    }
  }
  if (failedEventIndex < 0) return null;
  const subsequentSop05Execution = history.slice(failedEventIndex + 1).some(event => event?.current_step === 'LISTING_SOP_05'
    && (event?.type === 'STEP_EXECUTION_STARTED' || String(event?.type || '').startsWith('LISTING_SOP_05_')));
  if (subsequentSop05Execution) return null;
  const failedEvent = history[failedEventIndex];
  return { issue_id: openIssues[0].issue_id, failed_event_id: failedEvent.event_id,
    task_revision: Number(task.revision), active_leases: 0, superseding_non_sop05_events: history.length - failedEventIndex - 1 };
}

export async function act(dataRoot, sku, action, payload = {}) {
  const id = productId(sku);
  const localControlAction = ACCEPTANCE_HOLD && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL' && acceptanceMode(dataRoot)
    && ['RECONCILE_LOCAL_TASK_STATE', 'RECONCILE_SOP06_PANE_TIMEOUT', 'finalize_sop08_persisted_artifact', 'register_sop09_input_bundle', 'revalidate_cached_sop09_qa'].includes(action);
  const cachedSop07RevalidationAction = ACCEPTANCE_HOLD && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL' && acceptanceMode(dataRoot) && action === 'finalize_cached_sop07_top20';
  const recoveryHoldAction = ACCEPTANCE_HOLD && process.env.BOL_ACCEPTANCE_MODE === '1'
    && acceptanceMode(dataRoot) && id === 'SYNTHETIC-SKU-LEGACY-10'
    && ['case_a_sop10_recovery_preflight', 'case_a_sop10_generation_recovery_probe_bind', 'recover_listing_transition', 'finalize_cached_listing_evidence_repair', 'finalize_cached_listing_step'].includes(action);
  const cachedListingRepairHoldAction = ACCEPTANCE_HOLD && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL' && acceptanceMode(dataRoot) && action === 'finalize_cached_listing_step'
    && isAcceptanceCachedFinalizeScopeAllowed({ sku: id, dataRoot, action });
  const qwenSop10RecoveryHoldAction = ACCEPTANCE_HOLD && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL' && acceptanceMode(dataRoot) && id === 'SYNTHETIC-SKU-LEGACY-05'
    && ['qwen_sop10_recovery_preflight', 'qwen_sop10_generation_recovery_probe_bind'].includes(action);
  const deepSeekListingStepRecoveryHoldAction = ACCEPTANCE_HOLD && process.env.BOL_ACCEPTANCE_MODE === '1'
    && RUNTIME_MODE === 'NORMAL' && acceptanceMode(dataRoot) && id === 'SYNTHETIC-SKU-LEGACY-05'
    && ['deepseek_listing_step_recovery_preflight', 'deepseek_listing_step_generation_recovery_probe_bind'].includes(action);
  const manualContinueSku = getEffectiveRuntimePolicy().manual_continue_sku || null;
  const explicitContinueAction = isManualContinueRequired() && process.env.BOL_ACCEPTANCE_MODE === '1'
    && acceptanceMode(dataRoot) && action === 'continue'
    && (manualContinueSku ? id === manualContinueSku : id === 'SYNTHETIC-SKU-LEGACY-10');
  const explicitManualPauseAction = isManualContinueRequired() && process.env.BOL_ACCEPTANCE_MODE === '1'
    && acceptanceMode(dataRoot) && action === 'pause' && Boolean(manualContinueSku) && id === manualContinueSku;
  if (!recoveryHoldAction && !cachedListingRepairHoldAction && !qwenSop10RecoveryHoldAction && !deepSeekListingStepRecoveryHoldAction && !explicitContinueAction && !explicitManualPauseAction && !localControlAction && !cachedSop07RevalidationAction) assertBusinessDispatchEnabled(`Task action: ${action}`);
  // HOLD startup defers crash recovery. Finish it before reading a mutable task
  // or releasing the manual-Continue latch; otherwise a background listTasks()
  // can misclassify this process's newly RUNNING execution as a crashed worker.
  if (!recoveryHoldAction && !cachedListingRepairHoldAction && !qwenSop10RecoveryHoldAction && !deepSeekListingStepRecoveryHoldAction && !localControlAction && !cachedSop07RevalidationAction && !explicitContinueAction && !explicitManualPauseAction) await initialize(dataRoot);
  const runAction = () => serialize(id, async () => {
    const task = await readTask(dataRoot, id);
    if (!task) throw Object.assign(new Error(`找不到 SKU ${id}`), { code: 'SKU_NOT_FOUND' });
    if (explicitContinueAction || explicitManualPauseAction) assertTaskRevisionCAS(payload.expected_revision, task.revision);
    if (action === 'RECONCILE_LOCAL_TASK_STATE') return reconcileLocalTaskState(dataRoot, task, payload);
    if (action === 'RECONCILE_SOP06_PANE_TIMEOUT') return reconcileSop06OrphanedPaneTimeout(dataRoot, id, payload);
    if (action === 'register_sop09_input_bundle') return registerSop09InputBundle(dataRoot, task, payload);
    if (action === 'revalidate_cached_sop09_qa') return revalidateCachedSop09Qa(dataRoot, task, payload);
    if (action === 'finalize_cached_sop07_top20') return finalizeCachedSop07Top20(dataRoot, task, payload);
    if (recoveryHoldAction && task.sku !== 'SYNTHETIC-SKU-LEGACY-10') throw Object.assign(new Error('Acceptance recovery control is restricted to SYNTHETIC_ACCEPTANCE_10.'), { code: 'ACCEPTANCE_RECOVERY_SCOPE_REJECTED' });
    if (qwenSop10RecoveryHoldAction && (task.sku !== 'SYNTHETIC-SKU-LEGACY-05' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_05')) throw Object.assign(new Error('Qwen SOP10 recovery control is restricted to SYNTHETIC_ACCEPTANCE_05.'), { code: 'QWEN_SOP10_RECOVERY_SCOPE_REJECTED' });
    if (deepSeekListingStepRecoveryHoldAction && (task.sku !== 'SYNTHETIC-SKU-LEGACY-05' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_05')) throw Object.assign(new Error('DeepSeek Listing-step recovery control is restricted to the active SYNTHETIC_ACCEPTANCE_05 acceptance task.'), { code: 'DEEPSEEK_LISTING_RECOVERY_SCOPE_REJECTED' });
    if (task.final_archive) throw Object.assign(new Error('该 SKU 已上传归档，Final 版本已锁定。'), { code: 'FINAL_VERSION_LOCKED' });
    if (action === 'continue' && task.current_step === 'LISTING_SOP_04'
      && payload.sop04_multi_seed_completion && typeof payload.sop04_multi_seed_completion === 'object') {
      assertTaskRevisionCAS(payload.expected_revision, task.revision);
      const decision = payload.sop04_multi_seed_completion;
      const unresolvedSop04Decision = (task.listing_executor?.waiting_items || []).some(item => !item.decided_at
        && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04');
      if (task.status !== 'WAITING_DECISION' || task.resume_point !== 'LISTING_SOP_04'
        || task.last_success_step !== 'LISTING_SOP_03' || task.qa?.LISTING_SOP_04?.status !== 'NOT_RUN'
        || task.open_error_count !== 0 || activeIssueCount(task) !== 0 || !unresolvedSop04Decision
        || !task.outputs?.bol_keywords?.evidence?.artifact_ref
        || task.outputs.bol_keywords.seed_exact_string !== task.sop04_seed_selection?.exact_string) {
        throw Object.assign(new Error('SOP04 multi-seed recovery preconditions do not match the saved current-SKU checkpoint.'), { code: 'SOP04_MULTI_SEED_RECOVERY_PRECONDITION_FAILED' });
      }
      const primaryArtifactRef = task.outputs.bol_keywords.evidence.artifact_ref;
      const primaryArtifactPath = safeMaterialPath(dataRoot, primaryArtifactRef);
      const primaryArtifact = JSON.parse(await fs.readFile(primaryArtifactPath, 'utf8'));
      const result = await runSop04MultiSeedCompletionWithLease(dataRoot, task, {
        primaryArtifact, primaryArtifactRef, explicitInitialDecision: decision,
      });
      return result;
    }
    if (action === 'finalize_cached_listing_step') {
      assertTaskRevisionCAS(payload.expected_revision, task.revision);
      if (payload.request_contract_recovery==='SOP17_FINAL_QA_EVIDENCE_PACK_V1') {
        if(!recoveryHoldAction || task.current_step!=='LISTING_SOP_17' || task.resume_point!==task.current_step
          || task.last_success_step!=='LISTING_SOP_16' || task.status!=='WAITING_DEPENDENCY'
          || task.open_error_count!==0 || task.outputs.final_qa?.version
          || Number(dbFor(dataRoot).prepare("SELECT COUNT(*) n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku).n))throw Error('REQUEST_CONTRACT_RECOVERY_REJECTED');
        const policyFile=safeMaterialPath(dataRoot,'integrations/listing-acceptance-closeout/authorization.json');
        const policyBytes=await fs.readFile(policyFile,'utf8'),policy=JSON.parse(policyBytes);
        if(policy.authorization!=='SYNTHETIC_ACCEPTANCE_10_LISTING_CLOSEOUT_CONTINUE_TO_SOP17'||policy.request_contract_replacements)throw Error('REQUEST_CONTRACT_RECOVERY_ALREADY_USED');
        const inputs=await resolveSop10To17Inputs(dataRoot,task,task.current_step),identities={},replacements={};
        for(const provider of ['Qwen','DeepSeek']){
          const priorRef=`integrations/listing-acceptance-closeout/${policy.run_id}/LISTING_SOP_17-${provider}.json`;
          const prior=JSON.parse(await fs.readFile(safeMaterialPath(dataRoot,priorRef),'utf8'));
          const identity=buildListingProviderGenerationIdentity({task,step:task.current_step,inputs,provider});
          if(prior.state!=='COMPLETED'||prior.result?.reason_code!=='PROVIDER_INVALID_REQUEST'
            || prior.result?.attempt_metadata?.http_status!==400 || prior.generation_key===identity.generation_key
            || !identity.prompt_contract_version.includes('SOP17_FINAL_QA_EVIDENCE_PACK_V1'))throw Error('REQUEST_CONTRACT_REPLACEMENT_IDENTITY_REJECTED');
          identities[provider]=identity;
          replacements[`LISTING_SOP_17-${provider}`]={previous_generation_key:prior.generation_key,new_generation_key:identity.generation_key,
            reason:'DETERMINISTIC_FINAL_QA_PACK_REPLACES_HTTP400_REQUEST',previous_failure_evidence_ref:priorRef,allowed_calls:1,created_at:iso()};
        }
        const auditRef=`reports/SOP17-REQUEST-CONTRACT-REPLACEMENT-${crypto.randomUUID()}.json`;
        await fs.writeFile(safeMaterialPath(dataRoot,auditRef),JSON.stringify({previous_revision:task.revision,old_wait:task.ai_generation_waiting,old_recovery:task.generation_recovery,old_policy:policy,new_identities:identities,replacements,provider_requests:0}),{flag:'wx'});
        policy.request_contract_replacements=replacements;policy.request_contract_replacement_audit_ref=auditRef;
        const temp=`${policyFile}.${process.pid}.tmp`;await fs.writeFile(temp,JSON.stringify(policy,null,2),{flag:'wx'});await fs.rename(temp,policyFile);
        task.generation_request_contract_history||=[];task.generation_request_contract_history.push({audit_ref:auditRef,prior_wait:clone(task.ai_generation_waiting),new_contract:'SOP17_FINAL_QA_EVIDENCE_PACK_V1',at:iso()});
        task.status='PAUSED';task.waiting_dependency_key=null;task.ai_generation_waiting=null;task.generation_recovery=null;task.dependency_failed_at=null;task.required_readiness_after=null;
        task.stages.LISTING_SOP_17={...task.stages.LISTING_SOP_17,status:'PAUSED',dependency:null,waiting_reason:'REQUEST_CONTRACT_CORRECTED',updated_at:iso()};
        task.listing_executor.registry.LISTING_SOP_17={...task.listing_executor.registry.LISTING_SOP_17,status:'PAUSED',qa_status:'NOT_RUN',waiting_reason:null};
        try{await commit(dataRoot,task,'LISTING_REQUEST_CONTRACT_RECOVERED',{operation:'HTTP400_REQUEST_CONTRACT_REPLACED',audit_ref:auditRef,replacements,external_requests:0,stage_qa:'NOT_RUN',previous_failures_preserved:true},{expectedRevision:payload.expected_revision});}
        catch(error){await fs.writeFile(policyFile,policyBytes);throw error;}
        return{status:'REQUEST_CONTRACT_READY',task_revision:task.revision,provider_requests:0,new_generation_keys:Object.fromEntries(Object.entries(identities).map(([p,i])=>[p,i.generation_key]))};
      }
      if (payload.copy_revalidation_plans) {
        const open=(task.issues||[]).filter(i=>i.status==='OPEN');
        if(!recoveryHoldAction || task.current_step!=='LISTING_SOP_16' || task.resume_point!==task.current_step
          || task.last_success_step!=='LISTING_SOP_15' || task.status!=='ERROR' || task.error_code!=='LISTING_STAGE_QA_FAIL'
          || open.length!==1 || open[0].step!=='LISTING_SOP_16' || task.outputs.description?.version
          || payload.copy_revalidation_plans.length!==2)throw Object.assign(Error('Copy revalidation preconditions failed'),{code:'LISTING_CACHED_REPAIR_PRECONDITION'});
        const acquired=acquireListingExecutionLease(dbFor(dataRoot),{skuId:task.sku,step:'LISTING_SOP_16',inputVersion:makeListingExecutionInputVersion(task.outputs.description.input_version_refs,[])});
        if(!acquired.acquired)return{status:'NOOP_ALREADY_RUNNING',task_revision:task.revision};
        activateListingExecution(acquired.lease.execution_id);
        try{
          const revisions=[];const originalTask=clone(task),working=clone(task);
          for(const[at,step]of ['LISTING_SOP_15','LISTING_SOP_16'].entries()){
            const ref=payload.copy_revalidation_plans[at];const plan=JSON.parse(await fs.readFile(safeMaterialPath(dataRoot,ref),'utf8'));
            if(plan.plan_ref!==ref||plan.step!==step)throw Error('COPY_PLAN_REF_MISMATCH');
            const result=await buildListingCopyRevision(dataRoot,working,step,plan);revisions.push(result);
            await persistListingCopyRevision(dataRoot,result);
            working.outputs[result.key]=clone(result.output);
          }
          for(const issue of open){issue.status='CLOSED';issue.closed_at=iso();issue.close_reason='LOCAL_COPY_EVIDENCE_REVALIDATION_PASS';}
          task.open_error_count=activeIssueCount(task);task.error_code=null;task.error_message=null;
          for(const result of revisions){
            task.outputs[result.key]=clone(result.output);
            applyListingExecutorStep(task,result.step,{status:'PASS',output:task.outputs[result.key],input_version_refs:result.inputs.input_version_refs,qa:{status:'PASS',report:result.qa.checks},resume_point:nextWorkflowStep(result.step)});
            task.listing_executor.registry[result.step].execution_status='REAL_EXECUTOR_PASS';
          }
          for(const{step}of revisions){const problems=await validateStage(task,step,dataRoot);if(problems.length)throw Object.assign(Error('Copy persisted QA failed'),{failures:problems});}
          task.status='PAUSED';task.current_step='LISTING_SOP_17';task.resume_point='LISTING_SOP_17';task.last_success_step='LISTING_SOP_16';task.waiting_dependency_key=null;task.stage_qa_status='NOT_RUN';task.return_pool=null;
          task.listing_sop.current_step_id=task.current_step;setPoolForStep(task,task.current_step);
          task.stages.LISTING_SOP_17={...task.stages.LISTING_SOP_17,status:'PAUSED',updated_at:iso()};
          const historyRef=`${revisions[1].dir}/pre-revalidation-task.json`;await fs.writeFile(safeMaterialPath(dataRoot,historyRef),JSON.stringify(originalTask),{flag:'wx'});
          await commit(dataRoot,task,'LISTING_CACHED_STAGE_QA_RECOVERED',{steps:revisions.map(r=>({step:r.step,version:r.version})),history_ref:historyRef,copy_revalidation_plans:payload.copy_revalidation_plans,external_requests:0,source_provider_results_unchanged:true,next_step_dispatched:false},{expectedRevision:payload.expected_revision});
          finishListingExecutionLease(dbFor(dataRoot),acquired.lease.lease_id,'PASS');
          return{status:'PASS',version:revisions[1].version,versions:revisions.map(r=>r.version),external_requests:0,task_revision:task.revision};
        }catch(error){finishListingExecutionLease(dbFor(dataRoot),acquired.lease.lease_id,'FAILED');throw error;}
        finally{deactivateListingExecution(acquired.lease.execution_id);}
      }
      const step = task.current_step;
      const open = (task.issues || []).filter(issue => issue.status === 'OPEN');
      if (!(recoveryHoldAction || cachedListingRepairHoldAction) || !/^LISTING_SOP_1[2-7]$/.test(step) || task.resume_point !== step
        || task.status !== 'ERROR' || open.length !== 1 || open[0].step !== step
        || open[0].code !== 'LISTING_STAGE_QA_FAIL' || task.qa[step]?.status !== 'FAIL'
        || task.outputs[sop10To17OutputKey(step)]?.version) throw Object.assign(new Error('Cached finalization preconditions failed'), {code:'LISTING_CACHED_REPAIR_PRECONDITION'});
      const inputs = await resolveSop10To17Inputs(dataRoot, task, step);
      const acquired = acquireListingExecutionLease(dbFor(dataRoot), {skuId:task.sku,step,inputVersion:makeListingExecutionInputVersion(inputs.input_version_refs,[])});
      if (!acquired.acquired) return {status:'NOOP_ALREADY_RUNNING',task_revision:task.revision};
      const {lease}=acquired; activateListingExecution(lease.execution_id);
      try {
        const outputAmendment=payload.amendment_ref ? JSON.parse(await fs.readFile(safeMaterialPath(dataRoot,payload.amendment_ref),'utf8')) : null;
        if(outputAmendment && outputAmendment.plan_ref!==payload.amendment_ref)throw Object.assign(new Error('Amendment ref mismatch'),{code:'LISTING_AMENDMENT_REJECTED'});
        const evidenceRepairPlan=payload.repair_plan_ref ? JSON.parse(await fs.readFile(safeMaterialPath(dataRoot,payload.repair_plan_ref),'utf8')) : null;
        if(evidenceRepairPlan && evidenceRepairPlan.plan_ref!==payload.repair_plan_ref)throw Object.assign(new Error('Repair plan ref mismatch'),{code:'LISTING_EVIDENCE_REPAIR_REJECTED'});
        // The sole prior QA failure is pending recovery, not an independent open business defect.
        // Close it only on the candidate copy. Persisted task/history stay unchanged unless all QA passes.
        const qaTask=structuredClone(task);
        for(const issue of qaTask.issues || [])if(open.some(old=>old.issue_id===issue.issue_id))issue.status='CLOSED';
        qaTask.open_error_count=activeIssueCount(qaTask);
        const result=await runListingSop10To17Step({dataRoot,task:qaTask,step,cachedOnly:true,outputAmendment,evidenceRepairPlan});
        if(result.status!=='PASS' || result.qa.status!=='PASS' || result.external_requests!==0) throw Object.assign(new Error('Cached Stage QA not passed'),{code:'LISTING_CACHED_REPAIR_QA_FAILED',failures:result.qa?.failures});
        const historyRef=`artifacts/listing/${task.sku}/${step.toLowerCase()}/${result.version}/pre_repair_history.json`;
        await fs.writeFile(safeMaterialPath(dataRoot,historyRef),JSON.stringify({revision:task.revision,qa:task.qa[step],issues:open,original_output:task.outputs[sop10To17OutputKey(step)]}),{flag:'wx'});
        task.outputs[sop10To17OutputKey(step)]=result.output;
        for(const issue of open){issue.status='CLOSED';issue.closed_at=iso();issue.close_reason='CACHED_EVIDENCE_RESOLUTION_STAGE_QA_PASS';issue.recovered_version=result.version;}
        task.open_error_count=activeIssueCount(task);task.error_code=null;task.error_message=null;
        const problems=await validateStage(task,step,dataRoot);
        if(problems.length) throw Object.assign(new Error('Persisted Stage QA not passed'),{code:'LISTING_CACHED_REPAIR_PERSISTED_QA_FAILED',failures:problems});
        const next=nextWorkflowStep(step);
        applyListingExecutorStep(task,step,{status:'PASS',output:result.output,input_version_refs:result.input_version_refs,qa:{status:'PASS',report:result.qa.checks},resume_point:next});
        task.listing_executor.registry[step].execution_status='REAL_EXECUTOR_PASS';
        task.status='PAUSED'; task.current_step=next;task.resume_point=next;task.last_success_step=step;
        task.waiting_dependency_key=null;task.stage_qa_status='NOT_RUN';task.return_pool=null;
        task.listing_sop.current_step_id=next;setPoolForStep(task,next);
        task.stages[next]={...task.stages[next],status:'PAUSED',updated_at:iso()};
        if(step==='LISTING_SOP_17'){task.current_step=step;task.stage_qa_status='PASS';task.listing_sop.current_step_id=step;applyAcceptanceStopAfterStep(task,{enabled:acceptanceMode(dataRoot),configuredStep:process.env.BOL_ACCEPTANCE_STOP_AFTER_STEP||'',acceptedAt:iso()});}
        await commit(dataRoot,task,'LISTING_CACHED_STAGE_QA_RECOVERED',{step,version:result.version,history_ref:historyRef,resolved_issue_ids:open.map(i=>i.issue_id),qa_status:'PASS',external_requests:0,next_step_dispatched:false},{expectedRevision:payload.expected_revision});
        if(task.acceptance_stop_gate?.stopped_after_step===step)await commit(dataRoot,task,'ACCEPTANCE_STOP_AFTER_STEP',{step,version:result.version,resume_point:task.resume_point,next_sop_started:false});
        finishListingExecutionLease(dbFor(dataRoot),lease.lease_id,'PASS');
        return {status:'PASS',version:result.version,qa:'PASS',external_requests:0,task_revision:task.revision,current_step:task.current_step,resume_point:task.resume_point};
      }catch(error){finishListingExecutionLease(dbFor(dataRoot),lease.lease_id,'FAILED');throw error;}
      finally{deactivateListingExecution(lease.execution_id);}
    }
    if (action === 'finalize_cached_listing_evidence_repair') {
      assertTaskRevisionCAS(payload.expected_revision, task.revision);
      const step = task.current_step;
      const open = (task.issues || []).filter(issue => issue.status !== 'CLOSED');
      const failures = task.qa?.[step]?.report || [];
      if (!recoveryHoldAction || step !== 'LISTING_SOP_11' || task.resume_point !== step
        || task.status !== 'ERROR' || task.last_success_step !== 'LISTING_SOP_10'
        || task.qa?.LISTING_SOP_10?.status !== 'PASS'
        || open.length !== 1 || open[0].step !== step || open[0].code !== 'LISTING_STAGE_QA_FAIL'
        || failures.length !== 1 || failures[0].code !== 'SOP11_EVIDENCE_LINKS'
        || task.outputs?.own_competitor_comparison?.version) {
        throw Object.assign(new Error('Cached evidence repair must target the isolated SOP11 evidence-link failure under HOLD.'), { code: 'LISTING_CACHED_REPAIR_PRECONDITION' });
      }
      if (Number(dbFor(dataRoot).prepare("SELECT COUNT(*) n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku).n)) {
        throw Object.assign(new Error('Active execution blocks repair.'), { code: 'NOOP_ALREADY_RUNNING' });
      }
      const planPath = safeMaterialPath(dataRoot, String(payload.repair_plan_ref || ''));
      const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
      if (plan.plan_ref !== String(payload.repair_plan_ref)) throw Object.assign(new Error('Explicit repair plan reference mismatch.'), { code: 'LISTING_EVIDENCE_REPAIR_REJECTED' });
      const inputs = await resolveSop10To17Inputs(dataRoot, task, step);
      const acquired = acquireListingExecutionLease(dbFor(dataRoot), { skuId: task.sku, step,
        inputVersion: makeListingExecutionInputVersion(inputs.input_version_refs, []) });
      if (!acquired.acquired) return { status: 'NOOP_ALREADY_RUNNING', task_revision: task.revision };
      const { lease } = acquired;
      activateListingExecution(lease.execution_id);
      try {
        const result = await runListingSop10To17Step({ dataRoot, task, step, cachedOnly: true, evidenceRepairPlan: plan });
        if (result.status !== 'PASS' || result.qa.status !== 'PASS' || result.external_requests !== 0) {
          throw Object.assign(new Error('Cached repair did not pass Stage QA.'), { code: 'LISTING_CACHED_REPAIR_QA_FAILED', failures: result.qa?.failures });
        }
        const auditRef = `artifacts/listing/${task.sku}/listing_sop_11/${result.version}/pre_repair_history.json`;
        await fs.writeFile(safeMaterialPath(dataRoot, auditRef), JSON.stringify({
          revision: task.revision, qa: task.qa[step], issues: open, original_output: task.outputs.own_competitor_comparison,
        }), { flag: 'wx' });
        task.outputs.own_competitor_comparison = result.output;
        open[0].status = 'CLOSED'; open[0].closed_at = iso(); open[0].close_reason = 'EVIDENCE_LINK_REPAIR_STAGE_QA_PASS';
        open[0].recovered_version = result.version;
        task.open_error_count = activeIssueCount(task);
        const problems = await validateStage(task, step, dataRoot);
        if (problems.length) throw Object.assign(new Error('Persisted artifact failed Stage QA.'), { code: 'LISTING_CACHED_REPAIR_PERSISTED_QA_FAILED', failures: problems });
        applyListingExecutorStep(task, step, { status: 'PASS', output: result.output,
          input_version_refs: result.input_version_refs, qa: { status: 'PASS', report: result.qa.checks }, resume_point: 'LISTING_SOP_12' });
        task.listing_executor.registry[step].execution_status = 'REAL_EXECUTOR_PASS';
        task.waiting_dependency_key = null;
        // The completed step stays PASS; the paused execution pointer must be
        // the next step so an explicit Continue cannot rerun SOP11.
        applyListingExecutorStep(task, 'LISTING_SOP_12', { status: 'PAUSED', resume_point: 'LISTING_SOP_12', qa: { status: 'NOT_RUN' } });
        task.stage_qa_status = 'NOT_RUN';
        task.return_pool = null; task.sidecars.verification = { status: 'PASS', updated_at: iso() };
        task.evidence_repair_control = { reason: 'CACHED_FINALIZATION_UNDER_ACCEPTANCE_HOLD',
          next_step: 'LISTING_SOP_12', provider_requests: 0, plan_ref: plan.plan_ref, history_ref: auditRef };
        await commit(dataRoot, task, 'LISTING_SOP_EVIDENCE_REPAIR_QA_PASS', {
          step, version: result.version, plan_ref: plan.plan_ref, history_ref: auditRef,
          resolved_issue_ids: open.map(issue => issue.issue_id), qa_status: 'PASS',
          real_executor_status: 'REAL_EXECUTOR_PASS', external_requests: 0, next_step_dispatched: false,
        }, { expectedRevision: payload.expected_revision });
        finishListingExecutionLease(dbFor(dataRoot), lease.lease_id, 'PASS');
        return { status: 'PASS', version: result.version, qa: result.qa.status, external_requests: 0,
          task_revision: task.revision, task_status: task.status, current_step: task.current_step, resume_point: task.resume_point };
      } catch (error) {
        finishListingExecutionLease(dbFor(dataRoot), lease.lease_id, 'FAILED');
        throw error;
      } finally { deactivateListingExecution(lease.execution_id); }
    }
    if (action === 'recover_listing_transition') {
      assertTaskRevisionCAS(payload.expected_revision, task.revision);
      const step = task.last_success_step;
      const output = task.outputs?.[sop10To17OutputKey(step)];
      const noLease = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku).n) === 0;
      const event = dbFor(dataRoot).prepare("SELECT details FROM task_events WHERE sku=? AND type='STAGE_QA_PASS' ORDER BY at DESC LIMIT 1").get(task.sku);
      const prior = event ? JSON.parse(event.details) : {};
      if (!/^LISTING_SOP_1[0-6]$/.test(step || '') || task.qa?.[step]?.status !== 'PASS'
          || task.listing_executor?.registry?.[step]?.qa_status !== 'PASS' || !output?.version
          || task.current_step !== 'product_master' || task.resume_point !== 'product_master'
          || task.status !== 'QUEUED' || !noLease || task.open_error_count !== 0
          || prior.step !== step || prior.next_step !== 'product_master') {
        throw Object.assign(new Error('No proven legacy Listing transition to repair.'), { code: 'LISTING_TRANSITION_RECOVERY_REJECTED' });
      }
      const persisted = JSON.parse(await fs.readFile(path.resolve(dataRoot, output.evidence.artifact_ref), 'utf8'));
      if (persisted.version !== output.version || persisted.qa_status !== 'PASS') throw Object.assign(new Error('Passed artifact mismatch.'), { code: 'LISTING_TRANSITION_ARTIFACT_MISMATCH' });
      const nextStep = nextWorkflowStep(step);
      task.current_step = nextStep; task.resume_point = nextStep; task.status = 'PAUSED';
      task.listing_sop.current_step_id = nextStep; task.waiting_dependency_key = null;
      setPoolForStep(task, nextStep);
      task.stages[nextStep] = { ...task.stages[nextStep], status: 'PAUSED', updated_at: iso() };
      await commit(dataRoot, task, 'LEGACY_LISTING_TRANSITION_RECOVERED', {
        completed_step: step, preserved_version: output.version, previous_pointer: 'product_master',
        restored_step: nextStep, provider_requests: 0, previous_steps_reexecuted: false,
      }, { expectedRevision: payload.expected_revision });
      return { task_revision: task.revision, status: task.status, current_step: nextStep, resume_point: nextStep, recovered: true };
    }
    if (action === 'case_a_sop10_recovery_preflight') {
      const report = await buildSYNTHETIC_ACCEPTANCE_10Sop10RecoveryPreflight(dataRoot, task, String(payload.capability_evidence_ref || ''));
      const { wait_context: _waitContext, current_identity_hashes: _identityHashes, ...safeReport } = report;
      return { recovery_preflight: safeReport, task_revision: task.revision, task_status: task.status, current_step: task.current_step, resume_point: task.resume_point };
    }
    if (action === 'qwen_sop10_recovery_preflight') {
      const report = await buildQwenSop10RecoveryPreflight(dataRoot, task, String(payload.capability_evidence_ref || ''));
      return { recovery_preflight: report, task_revision: task.revision, task_status: task.status,
        current_step: task.current_step, resume_point: task.resume_point };
    }
    if (action === 'deepseek_listing_step_recovery_preflight') {
      const report = await buildDeepSeekListingStepRecoveryPreflight(dataRoot, task);
      return { recovery_preflight: report, task_revision: task.revision, task_status: task.status,
        current_step: task.current_step, resume_point: task.resume_point };
    }
    if (action === 'deepseek_listing_step_generation_recovery_probe_bind') {
      if (!Number.isSafeInteger(Number(payload.expected_revision))) throw Object.assign(new Error('Dynamic expected_revision is required for DeepSeek Listing-step recovery binding.'), { code: 'TASK_REVISION_CAS_REQUIRED' });
      const readRevision = Number(task.revision);
      assertTaskRevisionCAS(Number(payload.expected_revision), readRevision);
      if (!payload.capability_evidence_ref) throw Object.assign(new Error('Explicit capability_evidence_ref is required.'), { code: 'CAPABILITY_EVIDENCE_REF_REQUIRED' });
      const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
      const context = await buildDeepSeekListingStepRecoveryBindingContext(dataRoot, task, String(payload.capability_evidence_ref || ''));
      const { identity, qwenIdentity, wait: plannedWait, circuit, migrationPlan, probe, evidence,
        currentProviderIdentity, qwenPartial, qwenRoute, state } = context;
      const migration = migrationPlan?.migration;
      const barrier = String(plannedWait?.generation_failed_at || '');
      const barrierMs = Date.parse(barrier);
      const same = (a, b) => String(a ?? '') === String(b ?? '');
      const probeCurrentProviderMatches = Boolean(probe && currentProviderIdentity
        && probe.endpoint_identity_hash === currentProviderIdentity.endpoint_identity_hash
        && probe.provider_config_hash === currentProviderIdentity.provider_config_hash
        && probe.adapter_contract_hash === currentProviderIdentity.adapter_contract_hash
        && probe.network_config_hash === currentProviderIdentity.network_config_hash
        && probe.adapter_version === currentProviderIdentity.adapter_version
        && probe.adapter_contract_version === currentProviderIdentity.adapter_contract_version);
      const qualifying = findQualifyingGenerationProbe(state, { ...plannedWait,
        probe_id: probe?.probe_id || null, capability_evidence_ref: payload.capability_evidence_ref });
      const taskEligible = task.sku === 'SYNTHETIC-SKU-LEGACY-05' && task.master?.source_product_id === 'SYNTHETIC_ACCEPTANCE_05'
        && task.current_step === 'LISTING_SOP_14' && task.resume_point === 'LISTING_SOP_14'
        && task.last_success_step === 'LISTING_SOP_13' && task.status === 'WAITING_DEPENDENCY'
        && task.waiting_dependency_key === 'DEEPSEEK' && task.ai_generation_waiting?.provider === 'DeepSeek'
        && task.ai_generation_waiting?.generation_key !== identity?.generation_key
        && Number(task.open_error_count || 0) === 0 && activeLeaseCount === 0
        && task.qa?.LISTING_SOP_14?.status !== 'PASS' && !task.outputs?.[sop10To17OutputKey('LISTING_SOP_14')]?.version;
      const probeMatches = Boolean(probe && evidence && evidence.reference === String(payload.capability_evidence_ref)
        && qualifying?.probe_id === probe.probe_id && probe.status === 'PASS' && probe.synthetic_only === true
        && probe.provider === 'DeepSeek' && probe.effective_model === identity?.effective_model
        && probe.returned_model === identity?.effective_model && probe.target_generation_key === identity?.generation_key
        && probe.target_step === identity?.step && probe.target_input_version_hash === identity?.input_version_hash
        && probe.target_prompt_hash === identity?.prompt_hash && probe.target_prompt_contract_version === identity?.prompt_contract_version
        && probe.target_execution_contract_sha256 === crypto.createHash('sha256').update(JSON.stringify(identity?.execution_contract ?? null)).digest('hex')
        && probe.schema_sha256 === identity?.execution_contract?.schema_sha256
        && probe.target_identity_migration_version === migration?.version
        && same(probe.failure_barrier_at, barrier) && Date.parse(String(probe.checked_at || '')) > barrierMs
        && Date.now() - Date.parse(String(probe.checked_at || '')) <= 30 * 60 * 1000
        && probe.api_protocol === 'RESPONSES' && probe.structured_output === 'json_schema'
        && probe.reasoning_effort === 'none' && probe.response_status === 'completed'
        && Number(probe.max_output_tokens) >= 16384 && probe.structured_parse === true && probe.schema_result === true
        && Number(probe.attempt_count) === 1 && Number(probe.retry_count) === 0 && Number(probe.external_requests) === 1);
      const migrationMatches = Boolean(migration && migration.version === plannedWait?.identity_migration_version
        && migration.old_failure_barrier === barrier && migration.history_relabelled === false
        && migration.new_identity?.generation_key === identity?.generation_key
        && migration.old_circuit_sha256 === crypto.createHash('sha256').update(JSON.stringify(state.circuits?.[task.ai_generation_waiting?.generation_key])).digest('hex'));
      const qwenReusable = Boolean(qwenIdentity?.sku === task.sku && qwenIdentity?.step === task.current_step
        && qwenIdentity?.input_version_hash === identity?.input_version_hash && qwenPartial
        && isProviderPartialReusable(qwenPartial, qwenIdentity));
      const qwenRouteReady = qwenRoute?.ready === true
        && (qwenReusable ? qwenRoute.route_readiness_source === 'CACHED_SUCCESS'
          : qwenRoute.route_readiness_source === 'CONTROL_PLANE' && qwenRoute.new_call_required === true);
      if (!deepSeekListingStepRecoveryHoldAction || !taskEligible || !migrationMatches || !probeMatches
        || !probeCurrentProviderMatches || !qwenRouteReady || !currentProviderIdentity
        || !Number.isFinite(barrierMs) || barrierMs !== Date.parse(String(task.dependency_failed_at || ''))
        || barrierMs !== Date.parse(String(task.required_readiness_after || ''))
        || circuit?.state !== 'OPEN' || circuit?.last_generation_failed_at !== barrier
        || Number(circuit?.inherited_failure_count || 0) < 1) {
        throw Object.assign(new Error('DeepSeek SOP14 prompt-identity recovery binding failed closed; task was not resumed.'), {
          code: 'DEEPSEEK_LISTING_STEP_RECOVERY_BIND_REJECTED',
          details: { revision: readRevision, active_lease_count: activeLeaseCount, probe_id: probe?.probe_id || null,
            task_status: task.status, current_step: task.current_step, circuit_state: circuit?.state || null,
            qwen_partial_reusable: qwenReusable, qwen_route_ready: qwenRouteReady,
            qwen_route_source: qwenRoute?.route_readiness_source || 'UNAVAILABLE',
            provider_hashes_match: probeCurrentProviderMatches,
            probe_match: probeMatches, migration_match: migrationMatches },
        });
      }
      const artifactDirectory = `artifacts/listing/${task.sku}/generation-recovery`;
      const snapshotRef = await persistCapabilitySnapshot(dataRoot, evidence, artifactDirectory);
      const snapshotEvidence = await readCapabilityEvidence(dataRoot, snapshotRef);
      const migrationRef = `${artifactDirectory}/${migration.version}.json`;
      await writeImmutableRecoveryArtifact(dataRoot, migrationRef, migration);
      const boundWait = { ...structuredClone(plannedWait), capability_evidence_ref: snapshotRef,
        capability_evidence_sha256: snapshotEvidence.sha256, probe_id: probe.probe_id };
      const consumed = await consumeGenerationRecoveryGate(dataRoot, boundWait, {
        probeId: probe.probe_id, expectedCircuitState: circuit.state, identityMigration: migration,
      });
      if (!consumed.allowed || consumed.probe_id !== probe.probe_id || consumed.circuit_state !== 'HALF_OPEN') {
        throw Object.assign(new Error('Exact DeepSeek SOP14 recovery permit could not be consumed.'), {
          code: 'DEEPSEEK_LISTING_STEP_RECOVERY_PERMIT_REJECTED', reason: consumed.reason || null,
        });
      }
      const route = await evaluateGenerationRecoveryRoute(dataRoot, { wait: boundWait, identity,
        consumedProbeId: probe.probe_id, consumedCircuitState: 'HALF_OPEN' });
      if (!route.allowed) {
        await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: identity.generation_key,
          probeId: probe.probe_id, priorState: 'OPEN' });
        throw Object.assign(new Error('DeepSeek SOP14 recovery route did not pass post-binding validation.'), {
          code: 'DEEPSEEK_LISTING_STEP_RECOVERY_ROUTE_REJECTED', reason: route.reason || null,
        });
      }
      const now = iso();
      const bindingCore = { sku: task.sku, step: task.current_step, task_revision: readRevision,
        recovery_key: identity.generation_key, probe_evidence_ref: snapshotRef,
        capability_evidence_source_ref: evidence.reference, capability_evidence_source_sha256: evidence.sha256,
        identity_migration_ref: migrationRef, identity_migration_version: migration.version,
        old_recovery_key: migration.old_identity.generation_key, old_failure_barrier: barrier,
        probe_id: probe.probe_id, probe_contract_version: probe.probe_contract_version, probe_checked_at: probe.checked_at,
        provider: 'DeepSeek', configured_model: probe.configured_model, effective_model: probe.effective_model,
        returned_model: probe.returned_model, api_protocol: probe.api_protocol, structured_output: probe.structured_output,
        reasoning_effort: probe.reasoning_effort, max_output_tokens: probe.max_output_tokens,
        execution_contract: identity.execution_contract, input_version_refs: identity.input_version_refs,
        input_version_hash: identity.input_version_hash, prompt_contract_version: identity.prompt_contract_version,
        prompt_hash: identity.prompt_hash, endpoint_identity_hash: currentProviderIdentity.endpoint_identity_hash,
        provider_config_hash: currentProviderIdentity.provider_config_hash,
        adapter_contract_version: currentProviderIdentity.adapter_contract_version,
        adapter_contract_hash: currentProviderIdentity.adapter_contract_hash,
        adapter_version: currentProviderIdentity.adapter_version, network_config_hash: currentProviderIdentity.network_config_hash,
        qwen_partial_status: qwenReusable ? 'SUCCESS' : 'NONE', qwen_partial_key: qwenIdentity.generation_key,
        qwen_route_source: qwenRoute.route_readiness_source,
        qwen_control_plane_evidence: qwenRoute.route_readiness_source === 'CONTROL_PLANE' ? qwenRoute.evidence : null,
        inherited_failure_count: Number(circuit.inherited_failure_count), validation: 'PASS', validated_at: now,
        original_probe_mutated: false, external_provider_requests_at_bind: 0 };
      const bindingVersion = `GENERATION_RECOVERY_EVIDENCE_BINDING-${crypto.createHash('sha256').update(JSON.stringify(bindingCore)).digest('hex').slice(0, 20)}`;
      const bindingRef = `${artifactDirectory}/${bindingVersion}.json`;
      const bindingPath = safeMaterialPath(dataRoot, bindingRef);
      const bindingBytes = `${JSON.stringify({ ...bindingCore, version: bindingVersion, artifact_type: 'GENERATION_RECOVERY_EVIDENCE_BINDING' }, null, 2)}\n`;
      let createdBinding = false;
      try {
        await fs.mkdir(path.dirname(bindingPath), { recursive: true });
        await fs.writeFile(bindingPath, bindingBytes, { encoding: 'utf8', flag: 'wx' });
        createdBinding = true;
      } catch (error) {
        if (error?.code !== 'EEXIST' || await fs.readFile(bindingPath, 'utf8') !== bindingBytes) {
          await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: identity.generation_key, probeId: probe.probe_id, priorState: 'OPEN' });
          throw error;
        }
      }
      boundWait.probe_checked_at = probe.checked_at;
      boundWait.probe_evidence_ref = snapshotRef;
      boundWait.recovery_binding_version = bindingVersion;
      boundWait.recovery_binding_ref = bindingRef;
      boundWait.recovery_evidence_binding = 'EXACT_SOP_STEP_INPUT_PROMPT_SCHEMA_AND_FAILURE_BARRIER';
      task.ai_generation_waiting = boundWait;
      task.generation_recovery = { ...(task.generation_recovery || {}), status: 'RECOVERY_AUTHORIZED',
        recovery_gate: 'ONE_CONTROLLED_GENERATION_ATTEMPT', capability_evidence_ref: snapshotRef,
        identity_migration_ref: migrationRef, identity_migration_version: migration.version,
        generation_key: identity.generation_key, provider: 'DeepSeek', effective_model: identity.effective_model,
        generation_failed_at: barrier, required_generation_readiness_after: barrier,
        circuit_state: 'HALF_OPEN', probe_id: probe.probe_id, probe_checked_at: probe.checked_at,
        probe_evidence_ref: snapshotRef, binding_version: bindingVersion, binding_artifact_ref: bindingRef,
        probe_identity_match: true, business_dispatch_allowed: true, remaining_business_attempts: 1,
        updated_at: now, wait_context: structuredClone(boundWait) };
      try {
        await commit(dataRoot, task, 'DEEPSEEK_LISTING_STEP_RECOVERY_EVIDENCE_BOUND', {
          recovery_key: identity.generation_key, old_recovery_key: migration.old_identity.generation_key,
          identity_migration_version: migration.version, failure_barrier: barrier,
          probe_id: probe.probe_id, probe_checked_at: probe.checked_at, circuit_state: 'HALF_OPEN',
          inherited_failure_count: Number(circuit.inherited_failure_count),
          qwen_partial_status: qwenReusable ? 'SUCCESS' : 'NONE', qwen_route_source: qwenRoute.route_readiness_source,
          qwen_provider_calls_added: 0, recovery_binding_version: bindingVersion,
          recovery_binding_ref: bindingRef, task_status_preserved: true, task_revision_expected: readRevision,
          external_provider_requests: 0,
        }, { expectedRevision: readRevision });
      } catch (error) {
        if (createdBinding) await fs.rm(bindingPath, { force: true });
        await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: identity.generation_key,
          probeId: probe.probe_id, priorState: 'OPEN' });
        throw error;
      }
      const preflight = await buildDeepSeekListingStepRecoveryPreflight(dataRoot, task);
      return { binding: preflight.SOP_STEP_RECOVERY_ROUTE_READY ? 'PASS' : 'FAIL', task_revision: task.revision,
        task_status: task.status, current_step: task.current_step, recovery_key: identity.generation_key,
        identity_migration_version: migration.version, probe_id: probe.probe_id,
        recovery_binding_version: bindingVersion, recovery_binding_ref: bindingRef,
        QWEN_ROUTE_SOURCE: qwenRoute.route_readiness_source,
        QWEN_NEW_CALL_REQUIRED: qwenRoute.new_call_required,
        DEEPSEEK_ROUTE_SOURCE: preflight.DEEPSEEK_ROUTE_SOURCE,
        SOP_STEP_RECOVERY_ROUTE_READY: preflight.SOP_STEP_RECOVERY_ROUTE_READY,
        external_requests: 0, preflight };
    }
    if (action === 'qwen_sop10_generation_recovery_probe_bind') {
      if (!Number.isSafeInteger(Number(payload.expected_revision))) throw Object.assign(new Error('Dynamic expected_revision is required for Qwen SOP10 recovery binding.'), { code: 'TASK_REVISION_CAS_REQUIRED' });
      const readRevision = Number(task.revision);
      assertTaskRevisionCAS(Number(payload.expected_revision), readRevision);
      const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
      if (!payload.capability_evidence_ref) throw Object.assign(new Error('Explicit capability_evidence_ref is required.'), { code: 'CAPABILITY_EVIDENCE_REF_REQUIRED' });
      const context = await buildQwenSop10RecoveryBindingContext(dataRoot, task, String(payload.capability_evidence_ref));
      const { identity, probe, wait, circuit, migration, evidence, currentProviderIdentity } = context;
      const validation = validateQwenSop10RecoveryBinding({ task, activeLeaseCount, identity, wait, probe,
        currentProviderIdentity, circuit, migration });
      if (!qwenSop10RecoveryHoldAction || task.sku !== 'SYNTHETIC-SKU-LEGACY-05' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_05'
          || !validation.allowed || !probe || !evidence || !currentProviderIdentity) {
        throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_05 Qwen SOP10 recovery binding failed closed; task was not changed.'), {
          code: 'QWEN_SOP10_RECOVERY_BIND_REJECTED', details: { revision: readRevision,
            active_lease_count: activeLeaseCount, recovery_key: identity?.generation_key || null,
            probe_id: probe?.probe_id || null, circuit_state: circuit?.state || null,
            failed_checks: validation.failures },
        });
      }
      const artifactDirectory = `artifacts/listing/${task.sku}/generation-recovery`;
      const snapshotRef = await persistCapabilitySnapshot(dataRoot, evidence, artifactDirectory);
      const snapshot = await readCapabilityEvidence(dataRoot, snapshotRef);
      const migrationRef = migration ? `${artifactDirectory}/${migration.version}.json` : null;
      if (migration) await writeImmutableRecoveryArtifact(dataRoot, migrationRef, migration);
      const consumed = await consumeGenerationRecoveryGate(dataRoot, wait, {
        probeId: probe.probe_id, expectedCircuitState: circuit.state, protocolMigration: migration,
      });
      if (!consumed.allowed || consumed.probe_id !== probe.probe_id || consumed.circuit_state !== 'HALF_OPEN') {
        throw Object.assign(new Error('Exact current-key Qwen recovery permit could not be consumed.'), {
          code: 'QWEN_SOP10_RECOVERY_PERMIT_REJECTED', reason: consumed.reason || null,
        });
      }
      const now = iso();
      const bindingCore = {
        sku: task.sku, step: 'LISTING_SOP_10', task_revision: readRevision,
        recovery_key: identity.generation_key, probe_evidence_ref: snapshotRef,
        capability_evidence_source_ref: evidence.reference, capability_evidence_source_sha256: evidence.sha256,
        protocol_migration_ref: migrationRef, protocol_migration_version: migration?.version || wait.protocol_migration_version || null,
        probe_id: probe.probe_id, probe_contract_version: probe.probe_contract_version,
        failure_barrier: wait.generation_failed_at, probe_checked_at: probe.checked_at,
        provider: 'Qwen', configured_model: probe.configured_model, effective_model: probe.effective_model,
        returned_model: probe.returned_model, api_protocol: probe.api_protocol,
        structured_output: probe.structured_output, reasoning_effort: probe.reasoning_effort,
        thinking_mode: probe.thinking_mode, preserve_thinking: probe.preserve_thinking,
        execution_contract: identity.execution_contract, synthetic_prompt_hash: probe.synthetic_prompt_hash,
        target_prompt_hash: identity.prompt_hash, target_input_version_hash: identity.input_version_hash,
        target_execution_contract_sha256: probe.target_execution_contract_sha256,
        endpoint_identity_hash: currentProviderIdentity.endpoint_identity_hash,
        provider_config_hash: currentProviderIdentity.provider_config_hash,
        adapter_contract_version: currentProviderIdentity.adapter_contract_version,
        adapter_contract_hash: currentProviderIdentity.adapter_contract_hash,
        adapter_version: currentProviderIdentity.adapter_version, network_config_hash: currentProviderIdentity.network_config_hash,
        prior_circuit_state: circuit.state, circuit_failure_count: circuit.failure_count,
        validation: 'PASS', validated_at: now, original_probe_mutated: false,
      };
      const bindingVersion = `GENERATION_RECOVERY_EVIDENCE_BINDING-${crypto.createHash('sha256').update(JSON.stringify(bindingCore)).digest('hex').slice(0, 20)}`;
      const bindingRef = `${artifactDirectory}/${bindingVersion}.json`;
      let createdBindingFile = false;
      try {
        const bindingPath = safeMaterialPath(dataRoot, bindingRef);
        await fs.mkdir(path.dirname(bindingPath), { recursive: true });
        const bytes = `${JSON.stringify({ ...bindingCore, version: bindingVersion, artifact_type: 'GENERATION_RECOVERY_EVIDENCE_BINDING' }, null, 2)}\n`;
        try { await fs.writeFile(bindingPath, bytes, { encoding: 'utf8', flag: 'wx' }); createdBindingFile = true; }
        catch (error) { if (error?.code !== 'EEXIST' || await fs.readFile(bindingPath, 'utf8') !== bytes) throw error; }
      } catch (error) {
        await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: identity.generation_key, probeId: probe.probe_id, priorState: circuit.state });
        throw error;
      }
      wait.capability_evidence_ref = snapshotRef; wait.capability_evidence_sha256 = snapshot.sha256;
      wait.probe_id = probe.probe_id; wait.probe_checked_at = probe.checked_at; wait.probe_evidence_ref = snapshotRef;
      wait.recovery_binding_version = bindingVersion; wait.recovery_binding_ref = bindingRef;
      wait.recovery_evidence_binding = 'QWEN_V2_TARGET_IDENTITY_AND_FAILURE_BARRIER';
      task.ai_generation_waiting = wait;
      task.generation_recovery = {
        status: 'RECOVERY_AUTHORIZED', recovery_gate: 'ONE_CONTROLLED_GENERATION_ATTEMPT',
        capability_evidence_ref: snapshotRef, protocol_migration_ref: migrationRef,
        generation_key: identity.generation_key, provider: 'Qwen', effective_model: identity.effective_model,
        generation_failed_at: wait.generation_failed_at, required_generation_readiness_after: wait.generation_failed_at,
        circuit_state: 'HALF_OPEN', probe_id: probe.probe_id, probe_checked_at: probe.checked_at,
        probe_evidence_ref: snapshotRef, binding_version: bindingVersion, binding_artifact_ref: bindingRef,
        probe_identity_match: true, business_dispatch_allowed: true, remaining_business_attempts: 1,
        updated_at: now, wait_context: clone(wait),
      };
      try {
        await commit(dataRoot, task, 'QWEN_SOP10_GENERATION_RECOVERY_EVIDENCE_BOUND', {
          generation_key: identity.generation_key, probe_id: probe.probe_id, probe_checked_at: probe.checked_at,
          capability_evidence_ref: snapshotRef, protocol_migration_ref: migrationRef,
          failure_barrier: wait.generation_failed_at, circuit_state: consumed.circuit_state,
          recovery_binding_version: bindingVersion, recovery_binding_ref: bindingRef,
          task_status_preserved: true, task_revision_expected: readRevision,
          sop10_artifact_created: false, external_provider_requests: 0,
        }, { expectedRevision: readRevision });
      } catch (error) {
        if (error?.code === 'TASK_REVISION_CAS_CONFLICT') {
          if (createdBindingFile) await fs.rm(safeMaterialPath(dataRoot, bindingRef), { force: true });
          await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: identity.generation_key, probeId: probe.probe_id, priorState: circuit.state });
        }
        throw error;
      }
      return { binding: 'PASS', task_revision: task.revision, task_status: task.status,
        current_step: task.current_step, resume_point: task.resume_point, recovery_key: identity.generation_key,
        probe_id: probe.probe_id, recovery_binding_version: bindingVersion, recovery_binding_ref: bindingRef,
        qwen_new_calls_at_bind: 0, sop10_artifact_created: false, external_requests: 0 };
    }
    if (action === 'case_a_sop10_generation_recovery_history_migrate') {
      const acceptanceRoot = acceptanceMode(dataRoot) && process.env.BOL_ACCEPTANCE_MODE === '1';
      const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
      if (!acceptanceRoot || task.sku !== 'SYNTHETIC-SKU-LEGACY-10' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_10'
        || task.revision !== 1150 || task.status !== 'PAUSED' || task.current_step !== 'LISTING_SOP_10'
        || task.resume_point !== 'LISTING_SOP_10' || task.last_success_step !== 'LISTING_SOP_09'
        || task.waiting_dependency_key !== 'DEEPSEEK' || Number(task.open_error_count || 0) !== 0
        || activeLeaseCount !== 0 || task.outputs?.buyer_insights?.version) {
        throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 legacy generation history migration preconditions failed closed.'), {
          code: 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_HISTORY_MIGRATION_PRECONDITION_FAILED',
          details: { acceptance_root: acceptanceRoot, revision: task.revision, status: task.status, step: task.current_step, active_lease_count: activeLeaseCount },
        });
      }
      const built = await buildSop10DeepSeekRecoveryIdentity(dataRoot, task);
      const stateBefore = await readAiGenerationState(dataRoot);
      const deepseekRecord = stateBefore.partial_results?.[built.identity.generation_key];
      const attempts = Array.isArray(deepseekRecord?.attempts) ? deepseekRecord.attempts : [];
      const validFailures = attempts.length === 10 && deepseekRecord?.status === 'FAILED'
        && attempts.every(attempt => String(attempt.status).toUpperCase() === 'FAILED'
          && attempt.failure_type === 'PROVIDER_EMPTY_CONTENT'
          && Number(attempt.http_status) === 200
          && Date.parse(String(attempt.request_finished_at || '')) > 0);
      const latestFailureMs = attempts.reduce((latest, attempt) => Math.max(latest, Date.parse(String(attempt.request_finished_at || '')) || 0), 0);
      const latestFailureAt = latestFailureMs ? new Date(latestFailureMs).toISOString() : null;
      const qwenRecord = Object.values(stateBefore.partial_results || {}).find(record => {
        const identity = record?.identity || {};
        return identity.sku === task.sku && identity.step === 'LISTING_SOP_10' && identity.provider === 'Qwen'
          && record.status === 'SUCCESS' && typeof record.content === 'string' && record.content.length > 0
          && identity.input_version_hash === built.identity.input_version_hash
          && identity.prompt_contract_version === built.identity.prompt_contract_version
          && identity.prompt_hash === built.identity.prompt_hash
          && identity.adapter_contract_version === built.identity.adapter_contract_version;
      });
      if (!validFailures || !latestFailureAt || !qwenRecord
        || (deepseekRecord?.identity?.generation_key && deepseekRecord.identity.generation_key !== built.identity.generation_key)) {
        throw Object.assign(new Error('Legacy failures or Qwen partial do not match the current SOP10 recovery identity.'), {
          code: 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_HISTORY_IDENTITY_MISMATCH',
          details: { generation_key_match: Boolean(deepseekRecord), legacy_failure_count: attempts.length, valid_empty_content_failures: validFailures, qwen_partial_success: Boolean(qwenRecord) },
        });
      }
      const circuit = await getGenerationCircuit(dataRoot, built.identity);
      if (circuit.state !== 'OPEN' || Number(circuit.failure_count) < 2) {
        throw Object.assign(new Error('Migrated legacy generation circuit did not open as required by the current two-failure threshold.'), {
          code: 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_CIRCUIT_MIGRATION_FAILED', details: { circuit_state: circuit.state, failure_count: circuit.failure_count },
        });
      }
      const now = iso();
      const wait = {
        ...clone(built.identity), dependency: 'DEEPSEEK', generation_failed_at: latestFailureAt,
        required_generation_readiness_after: latestFailureAt, source: 'LEGACY_FAILURE_HISTORY_MIGRATION',
        recorded_at: now, failure_type: 'PROVIDER_EMPTY_CONTENT', historical_failure_count: attempts.length,
      };
      task.ai_generation_waiting = wait;
      task.generation_recovery = {
        status: 'WAITING_CAPABILITY_PROBE', generation_key: built.identity.generation_key,
        provider: 'DeepSeek', effective_model: built.identity.effective_model,
        generation_failed_at: latestFailureAt, required_generation_readiness_after: latestFailureAt,
        failure_type: 'PROVIDER_EMPTY_CONTENT', historical_failure_count: attempts.length,
        circuit_state: circuit.state, recovery_gate: 'NEW_POST_FAILURE_GENERATION_CAPABILITY_PROBE_REQUIRED',
        legacy_failure_evidence_ref: `integrations/ai-generation-recovery/state.json#partial_results/${built.identity.generation_key}`,
        qwen_partial_status: 'SUCCESS', qwen_partial_generation_key: qwenRecord.identity?.generation_key || null,
        qwen_partial_evidence_ref: `integrations/ai-generation-recovery/state.json#partial_results/${qwenRecord.identity?.generation_key || ''}`,
        probe_id: null, business_dispatch_allowed: false, updated_at: now,
      };
      task.generation_recovery_bootstrap = {
        ...(task.generation_recovery_bootstrap || {}),
        status: 'SUPERSEDED_BY_LEGACY_FAILURE_HISTORY_MIGRATION', authorized: false,
        superseded_at: now, superseded_reason: 'The previously bound probe predates ten subsequent empty-content generation failures.',
        generation_key: built.identity.generation_key, circuit_state: circuit.state,
        failure_count: circuit.failure_count, generation_failed_at: latestFailureAt,
      };
      task.status = 'PAUSED'; task.current_step = 'LISTING_SOP_10'; task.resume_point = 'LISTING_SOP_10';
      task.last_success_step = 'LISTING_SOP_09'; task.waiting_dependency_key = 'DEEPSEEK'; task.open_error_count = 0;
      await commit(dataRoot, task, 'SYNTHETIC_ACCEPTANCE_10_LEGACY_EMPTY_CONTENT_FAILURES_MIGRATED', {
        generation_key: built.identity.generation_key, historical_failure_count: attempts.length,
        failure_type: 'PROVIDER_EMPTY_CONTENT', latest_historical_failure_at: latestFailureAt,
        circuit_state: circuit.state, circuit_failure_count: circuit.failure_count,
        qwen_partial_status: 'SUCCESS', qwen_provider_calls_added: 0,
        generation_capability_probe_required: true, business_dispatch_allowed: false,
        sop10_artifact_created: false, external_provider_requests: 0,
      });
      return {
        migration: 'PASS', task_revision: task.revision, task_status: task.status,
        current_step: task.current_step, resume_point: task.resume_point,
        generation_key: built.identity.generation_key, historical_failure_count: attempts.length,
        latest_historical_failure_at: latestFailureAt,
        circuit_state: circuit.state, circuit_failure_count: circuit.failure_count,
        qwen_partial_status: 'SUCCESS', qwen_partial_key: qwenRecord.identity?.generation_key || null,
        generation_recovery_status: 'WAITING_CAPABILITY_PROBE', generation_probe_required: true,
        sop10_artifact_created: false, external_provider_requests: 0,
      };
    }
    if (action === 'case_a_sop10_generation_recovery_probe_bind') {
      const acceptanceRoot = acceptanceMode(dataRoot) && process.env.BOL_ACCEPTANCE_MODE === '1';
      const readRevision = Number(task.revision);
      const expectedRevision = payload.expected_revision == null ? readRevision : Number(payload.expected_revision);
      if (expectedRevision !== readRevision) assertTaskRevisionCAS(expectedRevision, readRevision);
      const activeLeaseCount = Number(dbFor(dataRoot).prepare("SELECT COUNT(*) AS n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(task.sku)?.n || 0);
      if (!payload.capability_evidence_ref) throw Object.assign(new Error('Explicit capability_evidence_ref is required.'), { code: 'CAPABILITY_EVIDENCE_REF_REQUIRED' });
      const context = await buildSop10RecoveryBindingContext(dataRoot, task, String(payload.capability_evidence_ref || ''));
      const { built, probe, wait, circuit, qwenPartial, migration, evidence } = context;
      const currentIdentity = context.currentProviderIdentity;
      const recoveryKey = built.identity.generation_key;
      const barrier = wait.generation_failed_at;
      const bindingValidation = validateSop10RecoveryBinding({
        task, activeLeaseCount, identity: built?.identity, wait, probe,
        currentProviderIdentity: currentIdentity, circuit, qwenPartial, qwenIdentity: built?.qwen_identity,
      });
      if (!acceptanceRoot || task.sku !== 'SYNTHETIC-SKU-LEGACY-10' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_10'
        || !bindingValidation.allowed || !currentIdentity || !probe || !wait) {
        throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 current-state generation recovery binding failed closed; task was not changed.'), {
          code: 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_BIND_REJECTED',
          details: { acceptance_root: acceptanceRoot, revision: readRevision, expected_revision: expectedRevision,
            active_lease_count: activeLeaseCount, probe_id: probe?.probe_id || null,
            current_status: task.status, waiting_dependency_key: task.waiting_dependency_key || null,
            recovery_key: recoveryKey || null, circuit_state: circuit?.state || null,
            probe_match: bindingValidation.checks.probe_exact_identity === true,
            qwen_partial_match: bindingValidation.checks.qwen_cached_partial_reusable === true,
            failed_checks: bindingValidation.failures },
        });
      }
      const artifactDirectory = `artifacts/listing/${task.sku}/generation-recovery`;
      const snapshotRef = await persistCapabilitySnapshot(dataRoot, evidence, artifactDirectory);
      const snapshot = await readCapabilityEvidence(dataRoot, snapshotRef);
      wait.capability_evidence_ref = snapshotRef;
      wait.capability_evidence_sha256 = snapshot.sha256;
      wait.probe_id = probe.probe_id;
      const migrationRef = migration ? `${artifactDirectory}/${migration.version}.json` : null;
      if (migration) await writeImmutableRecoveryArtifact(dataRoot, migrationRef, migration);
      const consumed = await consumeGenerationRecoveryGate(dataRoot, wait, {
        probeId: probe.probe_id, expectedCircuitState: circuit.state, protocolMigration: migration,
      });
      if (!consumed.allowed || consumed.probe_id !== probe.probe_id || consumed.circuit_state !== 'HALF_OPEN') {
        throw Object.assign(new Error('Exact current-key generation recovery permit could not be consumed.'), {
          code: 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_PERMIT_REJECTED', reason: consumed.reason || null,
        });
      }
      const now = iso();
      const bindingCore = {
        sku: task.sku, step: 'LISTING_SOP_10', task_revision: readRevision,
        recovery_key: recoveryKey,
        probe_evidence_ref: snapshotRef, capability_evidence_source_ref: evidence.reference, capability_evidence_source_sha256: evidence.sha256,
        protocol_migration_ref: migrationRef, protocol_migration_version: migration?.version || wait.protocol_migration_version || null,
        probe_id: probe.probe_id, probe_contract_version: probe.probe_contract_version,
        failure_barrier: barrier, probe_checked_at: probe.checked_at,
        provider: probe.provider, configured_model: probe.configured_model,
        effective_model: probe.effective_model, returned_model: probe.returned_model,
        thinking_mode: probe.thinking_mode, execution_contract: built.identity.execution_contract,
        qwen_identity: built.qwen_identity,
        input_version_refs: built.identity.input_version_refs, input_version_hash: built.identity.input_version_hash,
        prompt_contract_version: built.identity.prompt_contract_version, prompt_hash: built.identity.prompt_hash,
        endpoint_identity_hash: currentIdentity.endpoint_identity_hash,
        provider_config_hash: currentIdentity.provider_config_hash,
        adapter_contract_version: currentIdentity.adapter_contract_version,
        adapter_contract_hash: currentIdentity.adapter_contract_hash,
        adapter_version: currentIdentity.adapter_version, network_config_hash: currentIdentity.network_config_hash,
        prior_circuit_state: circuit.state, circuit_failure_count: circuit.failure_count,
        validation: 'PASS', validated_at: now, original_probe_mutated: false,
      };
      const bindingVersion = `GENERATION_RECOVERY_EVIDENCE_BINDING-${crypto.createHash('sha256').update(JSON.stringify(bindingCore)).digest('hex').slice(0, 20)}`;
      const bindingRef = `artifacts/listing/${task.sku}/generation-recovery/${bindingVersion}.json`;
      const bindingPath = path.resolve(dataRoot, bindingRef);
      if (!bindingPath.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw Object.assign(new Error('Recovery binding path escaped acceptance dataRoot.'), { code: 'SYNTHETIC_ACCEPTANCE_10_RECOVERY_BINDING_PATH_INVALID' });
      await fs.mkdir(path.dirname(bindingPath), { recursive: true });
      const bindingBytes = `${JSON.stringify({ ...bindingCore, version: bindingVersion, artifact_type: 'GENERATION_RECOVERY_EVIDENCE_BINDING' }, null, 2)}\n`;
      let createdBindingFile = false;
      try { await fs.writeFile(bindingPath, bindingBytes, { encoding: 'utf8', flag: 'wx' }); createdBindingFile = true; }
      catch (error) {
        if (error?.code !== 'EEXIST' || await fs.readFile(bindingPath, 'utf8') !== bindingBytes) {
          await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: recoveryKey, probeId: probe.probe_id, priorState: circuit.state });
          throw error;
        }
      }
      wait.probe_id = probe.probe_id;
      wait.probe_checked_at = probe.checked_at;
      wait.probe_evidence_ref = snapshotRef;
      wait.recovery_binding_version = bindingVersion;
      wait.recovery_binding_ref = bindingRef;
      wait.recovery_evidence_binding = 'EXACT_GENERATION_KEY_AND_FAILURE_BARRIER';
      const recovery = {
        ...(task.generation_recovery || {}),
        status: 'RECOVERY_AUTHORIZED', recovery_gate: 'ONE_CONTROLLED_GENERATION_ATTEMPT',
        capability_evidence_ref: snapshotRef, protocol_migration_ref: migrationRef,
        generation_key: recoveryKey, provider: 'DeepSeek', effective_model: built.provider_config.effective_request_model,
        generation_failed_at: barrier, required_generation_readiness_after: barrier,
        circuit_state: 'HALF_OPEN', probe_id: probe.probe_id, probe_checked_at: probe.checked_at,
        probe_evidence_ref: wait.probe_evidence_ref, binding_version: bindingVersion, binding_artifact_ref: bindingRef,
        probe_identity_match: true, business_dispatch_allowed: true, remaining_business_attempts: 1, updated_at: now,
        wait_context: clone(wait),
      };
      task.ai_generation_waiting = wait;
      task.generation_recovery = recovery;
      // Preserve the live PAUSED or WAITING_DEPENDENCY status. Binding never resumes work.
      try {
        await commit(dataRoot, task, 'SYNTHETIC_ACCEPTANCE_10_GENERATION_RECOVERY_EVIDENCE_BOUND', {
          generation_key: recoveryKey, probe_id: probe.probe_id, probe_checked_at: probe.checked_at,
          capability_evidence_ref: snapshotRef, protocol_migration_ref: migrationRef,
          generation_failed_at: barrier, prior_circuit_state: circuit.state, circuit_state: consumed.circuit_state,
          circuit_failure_count: circuit.failure_count, probe_identity_match: true,
          qwen_partial_status: 'SUCCESS', qwen_provider_calls_added: 0,
          recovery_binding_version: bindingVersion, recovery_binding_ref: bindingRef,
          task_status_preserved: true, task_revision_expected: readRevision,
          sop10_artifact_created: false, external_provider_requests: 0,
        }, { expectedRevision: readRevision });
      } catch (error) {
        if (error?.code === 'TASK_REVISION_CAS_CONFLICT') {
          if (createdBindingFile) await fs.rm(bindingPath, { force: true });
          await rollbackGenerationRecoveryConsumption(dataRoot, { generationKey: recoveryKey, probeId: probe.probe_id, priorState: circuit.state });
        }
        throw error;
      }
      return {
        binding: 'PASS', task_revision: task.revision, task_status: task.status,
        current_step: task.current_step, resume_point: task.resume_point,
        generation_key: recoveryKey, probe_id: probe.probe_id, probe_checked_at: probe.checked_at,
        generation_failed_at: barrier, prior_circuit_state: circuit.state, circuit_state: consumed.circuit_state,
        circuit_failure_count: circuit.failure_count, recovery_binding_version: bindingVersion,
        recovery_binding_ref: bindingRef, qwen_partial_status: 'SUCCESS',
        qwen_provider_calls_added: 0, business_dispatch_allowed: true,
        sop10_artifact_created: false, external_provider_requests: 0,
      };
    }    if (action === 'case_a_generation_recovery_bootstrap') {
      if (task.generation_recovery_bootstrap?.source === 'LEGACY_RECOVERY_BOOTSTRAP') {
        const existing = await buildSYNTHETIC_ACCEPTANCE_10Sop10RecoveryPreflight(dataRoot, task, String(payload.capability_evidence_ref || task.generation_recovery?.capability_evidence_ref || ''));
        if (!existing.allowed || existing.generation_key !== task.generation_recovery_bootstrap.generation_key) {
          throw Object.assign(new Error('Existing legacy recovery context no longer matches live inputs or evidence.'), { code: 'SYNTHETIC_ACCEPTANCE_10_LEGACY_RECOVERY_BOOTSTRAP_MISMATCH', failures: existing.failures });
        }
        return { bootstrap: 'ALREADY_BOUND', recovery_key: existing.generation_key, probe_id: existing.probe_id, task };
      }
      if (task.revision !== 1115 || task.status !== 'PAUSED' || task.current_step !== 'LISTING_SOP_10'
        || task.resume_point !== 'LISTING_SOP_10' || task.last_success_step !== 'LISTING_SOP_09'
        || task.waiting_dependency_key !== 'DEEPSEEK' || Number(task.open_error_count || 0) !== 0) {
        throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 task no longer matches the authorized legacy recovery baseline.'), { code: 'SYNTHETIC_ACCEPTANCE_10_LEGACY_RECOVERY_BASELINE_MISMATCH' });
      }
      const report = await buildSYNTHETIC_ACCEPTANCE_10Sop10RecoveryPreflight(dataRoot, task, String(payload.capability_evidence_ref || ''));
      if (!report.allowed) throw Object.assign(new Error('Legacy recovery bootstrap failed closed.'), { code: 'SYNTHETIC_ACCEPTANCE_10_LEGACY_RECOVERY_BOOTSTRAP_REJECTED', failures: report.failures, checks: report.checks });
      const wait = clone(report.wait_context);
      task.ai_generation_waiting = { ...wait, recorded_at: iso(), bootstrap_source: 'LEGACY_RECOVERY_BOOTSTRAP' };
      task.generation_recovery_bootstrap = {
        source: 'LEGACY_RECOVERY_BOOTSTRAP', generation_key: report.generation_key,
        probe_id: report.probe_id, probe_checked_at: report.probe_checked_at,
        circuit_state: 'CLOSED', authorized: true, bound_at: iso(),
        facts_version: report.facts_version, prompt_contract_version: report.prompt_contract_version,
        prompt_hash: report.prompt_hash, input_version_refs: clone(report.input_version_refs),
        current_identity_hashes: clone(report.current_identity_hashes), external_requests: 0,
      };
      task.status = 'PAUSED'; task.current_step = 'LISTING_SOP_10'; task.resume_point = 'LISTING_SOP_10';
      task.waiting_dependency_key = 'DEEPSEEK'; task.last_success_step = 'LISTING_SOP_09';
      task.open_error_count = 0;
      await commit(dataRoot, task, 'LEGACY_RECOVERY_BOOTSTRAP_BOUND', {
        source: 'LEGACY_RECOVERY_BOOTSTRAP', recovery_key: report.generation_key,
        probe_id: report.probe_id, probe_checked_at: report.probe_checked_at,
        provider: 'DeepSeek', requested_model: 'deepseek-v4-flash', effective_model: 'deepseek-flash', returned_model: 'deepseek-flash',
        current_step: 'LISTING_SOP_10', resume_point: 'LISTING_SOP_10', task_remains_paused: true,
        facts_version: report.facts_version, prompt_contract_version: report.prompt_contract_version,
        prompt_hash: report.prompt_hash, input_version_refs: report.input_version_refs,
        current_identity_hashes: report.current_identity_hashes, external_requests: 0,
      });
      const { wait_context: _waitContext, current_identity_hashes: _identityHashes, ...safeReport } = report;
      return { bootstrap: 'PASS', recovery_preflight: safeReport, task };
    }
    if (action === 'finalize_sop08_persisted_artifact') {
      return finalizeSop08PersistedArtifact(dataRoot, task);
    }
    if (action === 'wait_sop04_seed_decision') {
      const sop03 = task.listing_sop?.steps?.LISTING_SOP_03;
      if (task.current_step !== 'LISTING_SOP_04' || sop03?.status !== 'PASS' || sop03?.qa_status !== 'PASS') {
        throw Object.assign(new Error('只有 SOP03 已 PASS 且当前停在 SOP04 时，才能登记 seed 决策。'), { code: 'SOP04_SEED_DECISION_PRECONDITION_FAILED' });
      }
      syncListingExecutorFramework(task, LISTING_SOP_STEPS);
      const { result, sop03Version, facts } = currentSop04AutomaticSeedDecision(task);
      if (result.status === 'SELECTED') {
        persistAutomaticSop04SeedSelection(task, result.selected);
        applyListingExecutorStep(task, 'LISTING_SOP_04', {
          status: 'QUEUED', resume_point: 'LISTING_SOP_04',
          input_version_refs: [{ artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
            { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: facts?.version ?? null }],
        });
        task.status = 'QUEUED';
        await commit(dataRoot, task, 'LISTING_SOP_04_SEED_AUTO_SELECTED', {
          exact_string: result.selected.exact_string, policy: result.policy,
          seed_selection_reason: result.selected.seed_selection_reason,
          source_refs: result.selected.source_refs, facts_evidence_refs: result.selected.facts_evidence_refs,
          sop03_artifact_version: sop03Version, confirmed_product_facts_version: facts?.version ?? null,
          external_requests: 0,
        });
        const executed = await dispatchCurrent(dataRoot, task);
        return { task: executed, seed_selection: clone(task.sop04_seed_selection), selector_result: result, external_requests: null };
      }
      const reason = setSop04SeedSelectorWait(task, result);
      applyListingExecutorStep(task, 'LISTING_SOP_04', {
        status: task.status, waiting_reason: reason, resume_point: 'LISTING_SOP_04',
        input_version_refs: [{ artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
          { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: facts?.version ?? null }],
      });
      const waiting = (task.listing_executor?.waiting_items || []).find(item => !item.decided_at
        && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04') || null;
      await commit(dataRoot, task, result.status === 'WAITING_DECISION' ? 'LISTING_SOP_04_SEED_SELECTION_AMBIGUOUS' : 'LISTING_SOP_04_SEED_SELECTOR_UNRESOLVED', {
        policy: result.policy, reason_code: result.reason_code, reason,
        decision_candidates: result.decision_candidates || [],
        sop03_artifact_version: sop03Version, confirmed_product_facts_version: facts?.version ?? null,
        external_requests: 0,
      });
      return { task, waiting_item: waiting, selector_result: result, external_requests: 0 };
    }
    if (action === 'select_sop04_seed') {
      const exact = typeof payload.exact_string === 'string' ? payload.exact_string : '';
      const openWaiting = (task.listing_executor?.waiting_items || []).find(item => !item.decided_at
        && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04'
        && (!payload.waiting_id || item.waiting_id === payload.waiting_id));
      const candidates = openWaiting?.current_value;
      const chosen = Array.isArray(candidates) ? candidates.find(item => item?.exact_string === exact) : null;
      if (task.current_step !== 'LISTING_SOP_04' || !openWaiting || !exact || /[\u3400-\u9fff]/.test(exact) || !chosen) {
        throw Object.assign(new Error('所选 seed 必须精确匹配当前 SKU SOP04 待决定列表中的已验证荷兰语字符串。'), { code: 'SOP04_SEED_SELECTION_INVALID' });
      }
      const decidedAt = iso();
      resolveExecutorWaitingItem(task, openWaiting.waiting_id, exact, decidedAt);
      const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version || task.listing_sop?.steps?.LISTING_SOP_03?.output_version;
      const factsVersion = Number(task.outputs?.confirmed_product_facts?.version || 0);
      task.sop04_seed_selection = {
        exact_string: exact,
        selected_by: 'Leon', selected_at: decidedAt, waiting_id: openWaiting.waiting_id,
        decision_scope: 'SKU_ONLY', reusable_as_global_rule: false,
        selection_policy: 'LEON_DECISION_AFTER_EQUAL_CORE_CANDIDATES',
        seed_selection_reason: `Leon 在同等合理且对应不同市场方向的核心本体候选中确认 exact string：${exact}`,
        source_refs: clone(chosen.source_refs || []), sop03_artifact_version: sop03Version,
        confirmed_product_facts_version: factsVersion,
      };
      task.listing_sop.decisions ||= [];
      task.listing_sop.decisions.push({ type: 'SOP04_SEARCH_TERMS_SEED_SELECTED', exact_string: exact, selected_by: 'Leon', at: decidedAt, decision_scope: 'SKU_ONLY', reusable_as_global_rule: false, source_refs: clone(chosen.source_refs || []), sop03_artifact_version: sop03Version, confirmed_product_facts_version: factsVersion });
      task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.listing_sop.current_step_id = 'LISTING_SOP_04';
      task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
      task.open_error_count = activeIssueCount(task);
      applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'QUEUED', resume_point: 'LISTING_SOP_04' });
      task.status = 'QUEUED'; task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
      await commit(dataRoot, task, 'LISTING_SOP_04_SEED_DECISION_RECORDED', { waiting_id: openWaiting.waiting_id, exact_string: exact, selected_by: 'Leon', decision_scope: 'SKU_ONLY', external_requests: 0, reusable_as_global_rule: false });
      const executed = await dispatchCurrent(dataRoot, task);
      return { task: executed, decision: clone(task.sop04_seed_selection) };
    }
    if (action === 'reconcile_sop04_automatic_selection') {
      const prior = task.outputs?.bol_keywords;
      const priorArtifactRef = prior?.evidence?.artifact_ref;
      if (task.current_step !== 'LISTING_SOP_04' || task.qa?.LISTING_SOP_04?.status !== 'PASS'
        || !priorArtifactRef || prior.seed_exact_string !== task.sop04_seed_selection?.exact_string) {
        throw Object.assign(new Error('只允许修正当前 SOP04 中由旧自动 selector 产生的已通过结果。'), { code: 'SOP04_SELECTOR_RECONCILIATION_PRECONDITION_FAILED' });
      }
      const priorArtifactPath = path.resolve(dataRoot, priorArtifactRef);
      if (!priorArtifactPath.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw Object.assign(new Error('SOP04 artifact 路径越出验收数据根。'), { code: 'SOP04_ARTIFACT_PATH_INVALID' });
      const priorArtifact = JSON.parse(await fs.readFile(priorArtifactPath, 'utf8'));
      const rawTerms = priorArtifact.api_evidence?.raw_response?.searchTerms?.relatedSearchTerms;
      if (!Array.isArray(rawTerms)) throw Object.assign(new Error('旧 SOP04 artifact 没有完整 raw Search Terms 响应，拒绝自动猜测候选。'), { code: 'SOP04_RAW_RESPONSE_MISSING' });
      const prepared = prepareSop04RelatedTermSelection(rawTerms, priorArtifact.seed_exact_string);
      if (prepared.decisionCode !== 'SELECT_5_TO_7_RELATED_TERMS') throw Object.assign(new Error('原始唯一词数并未超过7个，不符合该旧 selector 违规修正条件。'), { code: 'SOP04_SELECTOR_RECONCILIATION_NOT_REQUIRED' });
      const correctedSeed = {
        artifact_type: 'BOL_RELATED_TERMS_SET', sku: task.sku,
        parent_artifact_version: priorArtifact.version,
        seed_exact_string: priorArtifact.seed_exact_string,
        returned_raw_terms: clone(rawTerms),
        candidate_exact_strings: prepared.candidateTerms.map(item => item.exact_string),
        adopted_terms: [], adoption_status: 'WAITING_DECISION:SELECT_5_TO_7_RELATED_TERMS',
        api_evidence: clone(priorArtifact.api_evidence), queried_at: priorArtifact.queried_at,
        confirmed_product_facts_version: priorArtifact.confirmed_product_facts_version,
        sop03_artifact_version: priorArtifact.sop03_artifact_version,
        policy_reconciliation: { reason: 'PREVIOUS_SELECTOR_AUTOMATICALLY_SELECTED_TERMS; Leon requires no unapproved ranking or selection.', corrected_at: iso(), external_requests: 0 },
      };
      const version = `SOP04-${crypto.createHash('sha256').update(JSON.stringify(correctedSeed)).digest('hex').slice(0, 20)}`;
      const artifact = { ...correctedSeed, version, saved_at: iso() };
      const artifactPath = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop04', `${version}.json`);
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      const artifactJson = JSON.stringify(artifact, null, 2);
      try { await fs.writeFile(artifactPath, artifactJson, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST' || await fs.readFile(artifactPath, 'utf8') !== artifactJson) throw Object.assign(new Error('SOP04 修正版本无法以不可覆盖方式保存。'), { code: 'SOP04_ARTIFACT_VERSION_COLLISION' });
      }
      const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
      const output = {
        ...artifact,
        evidence: {
          ...clone(prior.evidence), evidence_refs: [priorArtifactRef, relativeArtifact],
          artifact_ref: relativeArtifact, parent_artifact_ref: priorArtifactRef,
          confirmed_product_facts_version: artifact.confirmed_product_facts_version,
          sop03_artifact_version: artifact.sop03_artifact_version,
          no_formal_boloo_volume_written: true,
        },
        open_error_count: activeIssueCount(task), created_at: artifact.saved_at,
      };
      const waiting = createExecutorWaitingItem(task, {
        type: 'WAITING_DECISION', originating_sop_step: 'LISTING_SOP_04',
        current_value: { seed_exact_string: artifact.seed_exact_string, candidate_exact_strings: artifact.candidate_exact_strings, unique_count: artifact.candidate_exact_strings.length, superseded_auto_selection: (priorArtifact.adopted_terms || []).map(item => item.exact_string), source_artifact_version: priorArtifact.version },
        proposed_value_or_action: '请从全部原始顺序候选中选择5–7个exact string；不排序、不打分、不自动选择。',
        reason: '旧 selector 曾自动从超过7个原始候选中挑选7个。现已保留其历史版本并保存完整候选，按 Leon 最新规则等待人工选择。',
        evidence: [{ type: 'SOP04_RAW_SEARCH_TERMS', version, artifact_ref: relativeArtifact, parent_artifact_ref: priorArtifactRef, candidate_count: artifact.candidate_exact_strings.length, http_status: artifact.api_evidence.http_status }],
        affected_downstream_modules: ['LISTING_SOP_04', 'LISTING_SOP_05'],
      });
      waiting.decision_code = 'SELECT_5_TO_7_RELATED_TERMS';
      const oldVersion = String(priorArtifact.version || '');
      for (const item of task.listing_sop.sop04_artifact_versions || []) if (String(item.version) === oldVersion) {
        item.current = false; item.superseded_reason = 'UNAPPROVED_AUTOMATIC_SELECTION_RETAINED_AS_HISTORY'; item.superseded_by = version;
      }
      task.listing_sop.sop04_artifact_versions ||= [];
      task.listing_sop.sop04_artifact_versions.push({ version, artifact_ref: relativeArtifact, parent_version: oldVersion, created_at: artifact.saved_at, status: 'WAITING_DECISION', decision_code: waiting.decision_code });
      task.outputs.bol_keywords = output;
      task.open_error_count = activeIssueCount(task);
      applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'WAITING_DECISION', waiting_reason: waiting.reason, resume_point: 'LISTING_SOP_04', output, qa: { status: 'NOT_RUN', report: { candidate_count: artifact.candidate_exact_strings.length, selector_used: false, external_requests: 0 } } });
      task.qa.LISTING_SOP_04 = { status: 'NOT_RUN', checked_at: null, report: { candidate_count: artifact.candidate_exact_strings.length, selector_used: false, external_requests: 0 } };
      task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'WAITING_DECISION', waiting_reason: waiting.reason, updated_at: iso() };
      task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.listing_sop.current_step_id = 'LISTING_SOP_04';
      task.last_success_step = 'LISTING_SOP_03'; task.status = 'WAITING_DECISION';
      task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
      task.activity_pool = '待人工确认'; task.current_pool = task.activity_pool;
      task.sidecars.keywords = { ...task.sidecars.keywords, status: 'WAITING_DECISION', updated_at: iso() };
      await commit(dataRoot, task, 'SOP04_SELECTOR_RESULT_RECONCILED_TO_WAITING_DECISION', { previous_version: oldVersion, corrected_version: version, candidate_count: artifact.candidate_exact_strings.length, previous_auto_selected_count: priorArtifact.adopted_terms?.length || 0, decision_code: waiting.decision_code, external_requests: 0, previous_result_retained: true });
      return { task, waiting_item: waiting, corrected_version: version, candidate_exact_strings: artifact.candidate_exact_strings, external_requests: 0 };
    }
    if (action === 'supplement_sop04_search_terms') {
      const seed = typeof payload.seed_exact_string === 'string' ? payload.seed_exact_string : '';
      const confirmedExact = Array.isArray(payload.confirmed_exact_strings) ? payload.confirmed_exact_strings : [];
      const currentWaiting = [...(task.listing_executor?.waiting_items || [])].reverse().find(item => !item.decided_at
        && item.status === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04'
        && item.decision_code === 'SELECT_5_TO_7_RELATED_TERMS');
      const currentOutput = task.outputs?.bol_keywords;
      const currentArtifactRef = currentOutput?.evidence?.artifact_ref;
      if (task.current_step !== 'LISTING_SOP_04' || task.status !== 'WAITING_DECISION' || !currentWaiting || !currentArtifactRef
        || seed !== 'kerstverpakking' || /[\u3400-\u9fff]/.test(seed)
        || confirmedExact.length !== 2 || new Set(confirmedExact).size !== 2
        || confirmedExact.some(value => typeof value !== 'string' || !currentWaiting.current_value?.candidate_exact_strings?.includes(value))) {
        throw Object.assign(new Error('SOP04补充查询必须使用本次获批的 SYNTHETIC_ACCEPTANCE_10 seed，并携带 Leon 从既有候选中确认的两个 exact string。'), { code: 'SOP04_SUPPLEMENT_REQUEST_INVALID' });
      }
      if ((task.sop04_supplemental_queries || []).some(item => item.seed_exact_string === seed)) {
        throw Object.assign(new Error('该补充 seed 已有持久化尝试；为避免重复请求，拒绝再次执行。'), { code: 'SOP04_SUPPLEMENT_SEED_ALREADY_ATTEMPTED' });
      }
      const currentArtifactPath = path.resolve(dataRoot, currentArtifactRef);
      if (!currentArtifactPath.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw Object.assign(new Error('SOP04 artifact 路径越出验收数据根。'), { code: 'SOP04_ARTIFACT_PATH_INVALID' });
      const currentArtifact = JSON.parse(await fs.readFile(currentArtifactPath, 'utf8'));
      if (currentArtifact.seed_exact_string !== 'cadeauzakjes'
        || confirmedExact.some(value => !currentArtifact.candidate_exact_strings?.includes(value))) {
        throw Object.assign(new Error('已确认词与原 Search Terms artifact 不匹配。'), { code: 'SOP04_CONFIRMED_TERM_ARTIFACT_MISMATCH' });
      }
      const source = (task.listing_sop?.sop03_sources?.BOLOO_COMPETITOR_EXTRACTOR?.required_subtasks || []).find(item => item.status === 'PASS'
        && (item.exact_strings || []).some(value => (typeof value === 'string' ? value : String(value?.keyword ?? '').trim()) === seed));
      if (!source?.source_id || !source.result_version || !source.provider_request_id) {
        throw Object.assign(new Error('补充 seed 不在当前 SOP03 已通过的 Boloo Extractor 证据中。'), { code: 'SOP04_SUPPLEMENT_SEED_SOURCE_MISSING' });
      }
      const readiness = await bolApiReadiness(dataRoot);
      const override = readinessOverride('BOL_API_READY');
      const dependencyReady = typeof override === 'boolean' ? override : readiness.status === 'PASS';
      if (!dependencyReady) {
        task.status = 'WAITING_DEPENDENCY'; task.waiting_dependency_key = 'BOL_API';
        task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.error_code = null; task.error_message = null;
        task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'WAITING_DEPENDENCY', dependency: 'BOL_API', waiting_reason: 'BOL API readiness 未通过；补充 Search Terms 请求未发送。', updated_at: iso() };
        await commit(dataRoot, task, 'SOP04_SUPPLEMENT_PREFLIGHT_BLOCKED', { dependency: 'BOL_API', seed_exact_string: seed, external_requests: 0 });
        return { task, external_requests: 0 };
      }
      const factVersion = Number(task.outputs?.confirmed_product_facts?.version || 0);
      const sop03Version = task.listing_executor?.registry?.LISTING_SOP_03?.output_version || task.listing_sop?.steps?.LISTING_SOP_03?.output_version;
      if (factVersion !== 1 || String(sop03Version) !== 'SOP03-SOURCES-71b89be91e17d2d5719d') {
        throw Object.assign(new Error('SYNTHETIC_ACCEPTANCE_10 补充查询的事实版本或 SOP03 artifact 已变化。'), { code: 'SOP04_SUPPLEMENT_INPUT_VERSION_MISMATCH' });
      }
      const previousSeedSelection = clone(task.sop04_seed_selection);
      const previousConfirmed = clone(task.sop04_confirmed_related_terms || []);
      if (previousConfirmed.length && JSON.stringify(previousConfirmed.map(item => item.exact_string)) !== JSON.stringify(confirmedExact)) {
        throw Object.assign(new Error('SOP04 已确认的部分关联词与本次确认不一致。'), { code: 'SOP04_PARTIAL_CONFIRMATION_CONFLICT' });
      }
      const priorApiEvidence = clone(currentArtifact.api_evidence);
      const priorQueryRecord = {
        seed_exact_string: currentArtifact.seed_exact_string,
        version: currentArtifact.version,
        artifact_ref: currentArtifactRef,
        queried_at: currentArtifact.queried_at,
        api_evidence: priorApiEvidence,
      };
      const decisionAt = iso();
      task.sop04_confirmed_related_terms = confirmedExact.map(exact_string => ({
        exact_string, selected_by: 'Leon', selected_at: decisionAt,
        source_seed_exact_string: currentArtifact.seed_exact_string,
        source_artifact_version: currentArtifact.version,
        decision_scope: 'SYNTHETIC_ACCEPTANCE_10_ONLY',
      }));
      task.sop04_excluded_related_terms = currentArtifact.candidate_exact_strings
        .filter(exact_string => !confirmedExact.includes(exact_string))
        .map(exact_string => ({ exact_string, status: 'EXCLUDED', exclusion_reason: 'Leon已确认与SYNTHETIC_ACCEPTANCE_10产品事实不匹配；不参与本次补充选择。', decided_at: decisionAt }));
      task.sop04_prior_query_records = [...(task.sop04_prior_query_records || []), priorQueryRecord];
      task.sop04_seed_history ||= [];
      if (previousSeedSelection) task.sop04_seed_history.push(previousSeedSelection);
      resolveExecutorWaitingItem(task, currentWaiting.waiting_id, confirmedExact.join('\n'), decisionAt);
      task.listing_sop.decisions ||= [];
      task.listing_sop.decisions.push({ type: 'SOP04_PARTIAL_RELATED_TERMS_CONFIRMED', exact_strings: confirmedExact, selected_by: 'Leon', at: decisionAt, decision_scope: 'SYNTHETIC_ACCEPTANCE_10_ONLY', source_artifact_version: currentArtifact.version });
      task.sop04_seed_selection = {
        exact_string: seed, selected_by: 'Leon', selected_at: decisionAt, decision_scope: 'SYNTHETIC_ACCEPTANCE_10_ONLY', reusable_as_global_rule: false,
        source_refs: [{ source_id: source.source_id, result_version: source.result_version, provider_request_id: source.provider_request_id, evidence_refs: clone(source.evidence_refs || []) }],
        sop03_artifact_version: sop03Version, confirmed_product_facts_version: factVersion,
      };
      task.listing_sop.decisions.push({ type: 'SOP04_SUPPLEMENTAL_SEARCH_TERMS_SEED_SELECTED', exact_string: seed, selected_by: 'Leon', at: decisionAt, decision_scope: 'SYNTHETIC_ACCEPTANCE_10_ONLY', reusable_as_global_rule: false, source_id: source.source_id, source_result_version: source.result_version });
      const queryAttempt = { seed_exact_string: seed, status: 'RUNNING', request_id: crypto.randomUUID(), started_at: iso(), decision_scope: 'SYNTHETIC_ACCEPTANCE_10_ONLY' };
      task.sop04_supplemental_queries ||= [];
      task.sop04_supplemental_queries.push(queryAttempt);
      task.status = 'RUNNING'; task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04';
      task.last_success_step = 'LISTING_SOP_03'; task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
      task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
      task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'RUNNING', dependency: 'BOL_API', dependency_status: 'READY', waiting_reason: null, updated_at: iso() };
      task.qa.LISTING_SOP_04 = { ...task.qa.LISTING_SOP_04, status: 'NOT_RUN', checked_at: null, report: null };
      applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'RUNNING', resume_point: 'LISTING_SOP_04' });
      await commit(dataRoot, task, 'SOP04_SUPPLEMENT_SEARCH_TERMS_STARTED', { seed_exact_string: seed, request_id: queryAttempt.request_id, facts_version: factVersion, sop03_artifact_version: sop03Version, confirmed_partial_count: confirmedExact.length });
      try {
        const requestedAt = iso();
        const response = await bolClientFor(dataRoot).getSearchTerms({ searchTerm: seed, period: 'WEEK', numberOfPeriods: 52, related: true });
        const httpMatch = String(response.source || '').match(/HTTP\s+(\d{3})/i);
        const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
        const rawSearchTerms = response.rawResponse?.searchTerms || null;
        const returnedRawTerms = Array.isArray(rawSearchTerms?.relatedSearchTerms) ? clone(rawSearchTerms.relatedSearchTerms) : [];
        const supplemental = prepareSop04SupplementalCandidates(
          returnedRawTerms, seed, confirmedExact, task.sop04_excluded_related_terms.map(item => item.exact_string),
        );
        const newCandidates = supplemental.newCandidateExactStrings;
        const combinedCandidates = supplemental.combinedCandidateExactStrings;
        const apiEvidence = {
          source: 'BOL Retailer API v10 · Search Terms', endpoint: '/retailer/insights/search-terms', provider_method: 'BOL_RETAILER_API_V10_SEARCH_TERMS',
          seed_exact_string: seed, requested_at: requestedAt, queried_at: response.createdAt || requestedAt,
          cache_expires_at: response.expiresAt || null, cache_hit: response.cacheHit === true, cache_source: response.source || null,
          http_status: httpStatus, raw_response: clone(response.rawResponse), returned_raw_terms: returnedRawTerms,
          auxiliary_search_terms_total: rawSearchTerms?.total ?? null,
        };
        const sourceQueryRecords = [...task.sop04_prior_query_records];
        const artifactSeed = {
          artifact_type: 'BOL_RELATED_TERMS_SET', sku: task.sku, parent_version: currentArtifact.version,
          seed_exact_string: seed, returned_raw_terms: returnedRawTerms, new_candidate_exact_strings: newCandidates,
          candidate_exact_strings: combinedCandidates, confirmed_partial_terms: task.sop04_confirmed_related_terms,
          excluded_prior_terms: task.sop04_excluded_related_terms, adopted_terms: [], adoption_status: 'WAITING_DECISION',
          source_query_artifacts: sourceQueryRecords, api_evidence: apiEvidence, queried_at: requestedAt,
          confirmed_product_facts_version: factVersion, sop03_artifact_version: sop03Version,
          provider_seed_evidence: { source_id: source.source_id, result_version: source.result_version, provider_request_id: source.provider_request_id, evidence_refs: clone(source.evidence_refs || []) },
        };
        const version = `SOP04-${crypto.createHash('sha256').update(JSON.stringify(artifactSeed)).digest('hex').slice(0, 20)}`;
        const artifact = { ...artifactSeed, version, saved_at: iso() };
        const artifactPath = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop04', `${version}.json`);
        await fs.mkdir(path.dirname(artifactPath), { recursive: true });
        const json = JSON.stringify(artifact, null, 2);
        try { await fs.writeFile(artifactPath, json, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(artifactPath, 'utf8') !== json) throw Object.assign(new Error('SOP04补充结果版本无法以不可覆盖方式保存。'), { code: 'SOP04_ARTIFACT_VERSION_COLLISION' }); }
        const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
        const output = {
          ...artifact, evidence: {
            evidence_refs: [...sourceQueryRecords.map(item => item.artifact_ref).filter(Boolean)], artifact_ref: relativeArtifact,
            api_evidence: apiEvidence, confirmed_product_facts_version: factVersion, sop03_artifact_version: sop03Version,
            no_formal_boloo_volume_written: true,
          }, open_error_count: activeIssueCount(task), created_at: artifact.saved_at,
        };
        const enoughToSelect = combinedCandidates.length >= 5;
        const decisionCode = supplemental.decisionCode;
        const waiting = createExecutorWaitingItem(task, {
          type: 'WAITING_DECISION', originating_sop_step: 'LISTING_SOP_04',
          current_value: { seed_exact_string: seed, confirmed_exact_strings: confirmedExact, candidate_exact_strings: combinedCandidates, new_candidate_exact_strings: newCandidates, unique_count: combinedCandidates.length, source_artifact_versions: sourceQueryRecords.map(item => item.version), raw_count: returnedRawTerms.length },
          proposed_value_or_action: enoughToSelect ? '请检查补充查询候选与SYNTHETIC_ACCEPTANCE_10事实，并确认最终5–7个exact string（必须保留已确认的2个）；系统不排名、不打分、不自动选择。' : '当前有效候选不足5个；请从本次补充查询候选中确认符合SYNTHETIC_ACCEPTANCE_10事实的词，不补造关键词。',
          reason: enoughToSelect ? '补充 Search Terms 结果已保存。新返回词尚未经过Leon事实匹配确认，因此保持待决定。' : '两条已确认词加本次新候选仍少于5个；已保存完整原始响应，不补造词。',
          evidence: [{ type: 'SOP04_SUPPLEMENTAL_SEARCH_TERMS', version, artifact_ref: relativeArtifact, http_status: httpStatus, seed_source_result_version: source.result_version }],
          affected_downstream_modules: ['LISTING_SOP_04', 'LISTING_SOP_05'],
        });
        waiting.decision_code = decisionCode;
        task.outputs.bol_keywords = output;
        queryAttempt.status = httpStatus === 200 ? 'PASS_PENDING_LEON_SELECTION' : 'ERROR';
        queryAttempt.version = version; queryAttempt.artifact_ref = relativeArtifact; queryAttempt.queried_at = apiEvidence.queried_at; queryAttempt.http_status = httpStatus;
        task.listing_sop.sop04_artifact_versions ||= [];
        task.listing_sop.sop04_artifact_versions.push({ version, artifact_ref: relativeArtifact, parent_version: currentArtifact.version, seed_exact_string: seed, created_at: artifact.saved_at, status: 'WAITING_DECISION', decision_code: decisionCode, current: true });
        for (const item of task.listing_sop.sop04_artifact_versions) if (item.version === currentArtifact.version) item.current = false;
        applyListingExecutorStep(task, 'LISTING_SOP_04', { status: 'WAITING_DECISION', waiting_reason: waiting.reason, resume_point: 'LISTING_SOP_04', output, qa: { status: 'NOT_RUN', report: { candidate_count: combinedCandidates.length, confirmed_partial_count: confirmedExact.length, new_candidate_count: newCandidates.length, selector_used: false, external_requests: 1 } } });
        task.qa.LISTING_SOP_04 = { status: 'NOT_RUN', checked_at: null, report: { candidate_count: combinedCandidates.length, confirmed_partial_count: confirmedExact.length, new_candidate_count: newCandidates.length, selector_used: false, external_requests: 1 } };
        task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'WAITING_DECISION', waiting_reason: waiting.reason, updated_at: iso() };
        task.status = 'WAITING_DECISION'; task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04'; task.last_success_step = 'LISTING_SOP_03';
        task.activity_pool = '待人工确认'; task.current_pool = task.activity_pool; task.waiting_dependency_key = null; task.error_code = null; task.error_message = null;
        await commit(dataRoot, task, 'SOP04_SUPPLEMENT_SEARCH_TERMS_RESULT_SAVED', { seed_exact_string: seed, version, http_status: httpStatus, candidate_count: combinedCandidates.length, confirmed_partial_count: confirmedExact.length, new_candidate_count: newCandidates.length, decision_code: decisionCode, external_requests: 1, selector_used: false, no_formal_volume_written: true });
        return { task, waiting_item: waiting, supplemental_result: { version, seed_exact_string: seed, candidate_exact_strings: newCandidates, confirmed_exact_strings: confirmedExact, http_status: httpStatus, queried_at: apiEvidence.queried_at }, external_requests: 1 };
      } catch (error) {
        const code = error instanceof AdapterError ? error.code : 'BOL_SEARCH_TERMS_EXECUTION_FAILED';
        const reason = error instanceof AdapterError ? error.message : 'BOL Search Terms 补充执行失败，错误内容已脱敏。';
        if (await waitForProviderDependency(dataRoot, task, {
          step: 'LISTING_SOP_04', dependencyKey: 'BOL_API', error, attempt: queryAttempt,
          providerMethod: 'BOL_RETAILER_API_V10_SEARCH_TERMS', seed,
          sourceEvidence: { source_refs: clone(task.sop04_seed_selection?.source_refs || []), facts_version: factVersion, sop03_artifact_version: sop03Version },
          location: 'outputs.bol_keywords.supplemental_query',
        })) return { task, external_requests: 1 };
        issueFor(task, code, reason, 'outputs.bol_keywords.supplemental_query', '保存第二个 seed 的真实 Search Terms evidence', '检查依赖并从 SOP04 精确断点恢复。');
        queryAttempt.status = 'ERROR'; queryAttempt.error_code = code; queryAttempt.completed_at = iso();
        task.open_error_count = activeIssueCount(task); task.return_pool = '关键词池'; task.activity_pool = '异常池'; task.current_pool = task.activity_pool; task.status = 'ERROR';
        task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'ERROR', updated_at: iso() };
        task.qa.LISTING_SOP_04 = { status: 'NOT_RUN', checked_at: null, report: ['SUPPLEMENTAL_SEARCH_TERMS_FAILED'] };
        await commit(dataRoot, task, 'SOP04_SUPPLEMENT_SEARCH_TERMS_FAILED', { seed_exact_string: seed, code, external_requests: 1 });
        return { task, external_requests: 1 };
      }
    }
    if (action === 'reclassify_provider_runtime_dependency_failure') {
      const issue = task.issues.find(item => item.issue_id === payload.issue_id
        && (item.status === 'OPEN' || (item.status === 'CLOSED' && item.close_reason === 'RECLASSIFIED_AS_WAITING_DEPENDENCY')));
      if (!issue || !isBolRuntimeDependencyError({ code: issue.code, status: issue.http_status })) {
        throw Object.assign(new Error('找不到可重分类为运行时依赖等待的 BOL 调用异常。'), { code: 'RUNTIME_DEPENDENCY_RECLASSIFY_NOT_APPLICABLE' });
      }
      const attempt = [...(task.sop04_supplemental_queries || []), ...(task.sop04_search_terms_attempts || []), ...(task.provider_attempts || [])]
        .reverse().find(item => item.error_code === issue.code && (!item.step || item.step === issue.step)
          && (item.status === 'ERROR' || item.failure?.error_code === issue.code));
      if (!attempt) throw Object.assign(new Error('缺少可关联的远程 attempt 记录，拒绝关闭异常。'), { code: 'RUNTIME_DEPENDENCY_ATTEMPT_MISSING' });
      const history = await getHistory(dataRoot, task.sku);
      const failedEvent = history.find(item => item.type === 'SOP04_SUPPLEMENT_SEARCH_TERMS_FAILED'
        && item.details?.seed_exact_string === attempt.seed_exact_string && item.details?.code === issue.code);
      const transitioned = await waitForProviderDependency(dataRoot, task, {
        step: issue.step, dependencyKey: 'BOL_API', error: { code: issue.code, status: attempt.http_status || issue.http_status },
        attempt, providerMethod: attempt.provider_method || 'BOL_RETAILER_API_V10_SEARCH_TERMS',
        seed: attempt.seed_exact_string, sourceEvidence: attempt.provider_evidence || attempt.source_evidence || null,
        location: issue.location, originalFailureAt: failedEvent?.at || attempt.completed_at || null,
      });
      if (!transitioned) throw Object.assign(new Error('该错误码不属于 BOL runtime dependency error。'), { code: 'RUNTIME_DEPENDENCY_RECLASSIFY_NOT_APPLICABLE' });
      return { task, reclassified_issue_id: issue.issue_id };
    }
    if (action === 'select_sop04_related_terms') {
      const exactStrings = Array.isArray(payload.exact_strings) ? payload.exact_strings : [];
      const waiting = (task.listing_executor?.waiting_items || []).find(item => !item.decided_at
        && item.type === 'WAITING_DECISION' && item.originating_sop_step === 'LISTING_SOP_04'
        && item.decision_code === 'SELECT_5_TO_7_RELATED_TERMS'
        && (!payload.waiting_id || item.waiting_id === payload.waiting_id));
      const candidates = waiting?.current_value?.candidate_exact_strings || [];
      const confirmedPartial = waiting?.current_value?.confirmed_exact_strings || [];
      if (task.current_step !== 'LISTING_SOP_04' || !waiting || exactStrings.length < 5 || exactStrings.length > 7
        || exactStrings.some(value => typeof value !== 'string' || /[\u3400-\u9fff]/.test(value) || !candidates.includes(value))
        || confirmedPartial.some(value => !exactStrings.includes(value))
        || new Set(exactStrings).size !== exactStrings.length) {
        throw Object.assign(new Error('只能从已保存的 Search Terms 候选中选择 5–7 个；必须保留已确认词，且不得重复。'), { code: 'SOP04_RELATED_TERMS_SELECTION_INVALID' });
      }
      const prior = task.outputs?.bol_keywords;
      const priorArtifactRef = prior?.evidence?.artifact_ref;
      if (!priorArtifactRef) throw Object.assign(new Error('缺少已持久化的 SOP04 Search Terms 原始响应。'), { code: 'SOP04_RAW_ARTIFACT_MISSING' });
      const priorArtifactPath = path.resolve(dataRoot, priorArtifactRef);
      if (!priorArtifactPath.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw Object.assign(new Error('SOP04 artifact 路径越出验收数据根。'), { code: 'SOP04_ARTIFACT_PATH_INVALID' });
      const priorArtifact = JSON.parse(await fs.readFile(priorArtifactPath, 'utf8'));
      if (!Array.isArray(priorArtifact.candidate_exact_strings) || exactStrings.some(value => !priorArtifact.candidate_exact_strings.includes(value))) throw Object.assign(new Error('选择值与不可变 Search Terms 候选 artifact 不匹配。'), { code: 'SOP04_CANDIDATE_ARTIFACT_MISMATCH' });
      const decidedAt = iso();
      const derivedSeed = {
        parent_version: priorArtifact.version,
        adopted_terms: exactStrings.map(exact_string => ({ exact_string, source_seed_exact_string: task.sop04_confirmed_related_terms?.find(item => item.exact_string === exact_string)?.source_seed_exact_string || priorArtifact.seed_exact_string })),
        selection: { selected_by: 'Leon', selected_at: decidedAt, exact_strings: exactStrings },
      };
      const version = `SOP04-${crypto.createHash('sha256').update(JSON.stringify(derivedSeed)).digest('hex').slice(0, 20)}`;
      const artifact = { ...priorArtifact, ...derivedSeed, version, adoption_status: 'LEON_SELECTED', saved_at: decidedAt };
      const artifactPath = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop04', `${version}.json`);
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      const artifactJson = JSON.stringify(artifact, null, 2);
      try { await fs.writeFile(artifactPath, artifactJson, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST' || await fs.readFile(artifactPath, 'utf8') !== artifactJson) throw Object.assign(new Error('SOP04 派生版本无法以不可覆盖方式保存。'), { code: 'SOP04_ARTIFACT_VERSION_COLLISION' });
      }
      const relativeArtifact = path.relative(dataRoot, artifactPath).replace(/\\/g, '/');
      const output = { ...artifact, evidence: { ...clone(prior.evidence), evidence_refs: [priorArtifactRef, relativeArtifact], artifact_ref: relativeArtifact, parent_artifact_ref: priorArtifactRef, no_formal_boloo_volume_written: true }, open_error_count: activeIssueCount(task), created_at: decidedAt };
      const checks = [
        { code: 'SOP04_LEON_SELECTED_5_TO_7', pass: exactStrings.length >= 5 && exactStrings.length <= 7 },
        { code: 'SOP04_SELECTION_FROM_RAW_CANDIDATES', pass: exactStrings.every(value => priorArtifact.candidate_exact_strings.includes(value)) },
        { code: 'SOP04_EXACT_STRINGS_UNIQUE', pass: new Set(exactStrings).size === exactStrings.length },
        { code: 'SOP04_RAW_RESPONSE_RETAINED', pass: Boolean(priorArtifact.api_evidence?.raw_response) && JSON.stringify(artifact.api_evidence) === JSON.stringify(priorArtifact.api_evidence) && (priorArtifact.source_query_artifacts || []).every(query => Boolean(query.api_evidence?.raw_response)) },
        { code: 'SOP04_NO_OFFICIAL_VOLUME_CONTAMINATION', pass: exactStrings.every(value => {
          const item = artifact.adopted_terms.find(row => row.exact_string === value);
          return item && !Object.hasOwn(item, 'search_volume') && !Object.hasOwn(item, 'boloo_search_volume') && !Object.hasOwn(item, 'total');
        }) },
        { code: 'SOP04_NO_OPEN_ERRORS', pass: activeIssueCount(task) === 0 },
      ];
      const qaReport = { checks, failures: checks.filter(item => !item.pass).map(item => item.code), decision: 'Leon selected the final 5–7 terms; no ranking or automatic selection applied.' };
      if (checks.some(item => !item.pass)) throw Object.assign(new Error('SOP04 人工选择结果未通过确定性 QA。'), { code: 'SOP04_SELECTION_QA_FAILED' });
      resolveExecutorWaitingItem(task, waiting.waiting_id, exactStrings.join('\n'), decidedAt);
      task.listing_sop.decisions ||= [];
      task.listing_sop.decisions.push({ type: 'SOP04_RELATED_TERMS_SELECTED', selected_by: 'Leon', at: decidedAt, exact_strings: exactStrings, original_candidate_count: candidates.length, original_artifact_version: priorArtifact.version, new_artifact_version: version });
      task.outputs.bol_keywords = output;
      task.listing_sop.sop04_artifact_versions ||= [];
      task.listing_sop.sop04_artifact_versions.push({ version, artifact_ref: relativeArtifact, parent_version: priorArtifact.version, selected_by: 'Leon', created_at: decidedAt });
      task.open_error_count = activeIssueCount(task);
      applyListingExecutorStep(task, 'LISTING_SOP_04', {
        status: 'PASS', output,
        input_version_refs: [
          { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: artifact.sop03_artifact_version },
          { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: artifact.confirmed_product_facts_version },
        ],
        qa: { status: 'PASS', checked_at: decidedAt, report: qaReport },
      });
      task.qa.LISTING_SOP_04 = { status: 'PASS', checked_at: decidedAt, report: qaReport };
      task.stages.LISTING_SOP_04 = { ...task.stages.LISTING_SOP_04, status: 'PASS', dependency: null, completed_at: decidedAt, updated_at: decidedAt };
      task.last_success_step = 'LISTING_SOP_04'; task.current_step = 'LISTING_SOP_04'; task.resume_point = 'LISTING_SOP_04';
      task.listing_sop.current_step_id = 'LISTING_SOP_04'; task.status = 'PASS';
      task.activity_pool = '关键词池'; task.current_pool = task.activity_pool;
      await commit(dataRoot, task, 'LISTING_SOP_04_STAGE_QA_PASS_STOPPED', { version, selected_by: 'Leon', adopted_term_count: exactStrings.length, stopped_before_sop05: true });
      return { task, selected_terms: exactStrings, version };
    }
    if (action === 'discover_competitor_candidates') {
      const result = await discoverCompetitorSources(dataRoot, task);
      return { task: result.task, discovery: result.discovery };
    }
    if (action === 'retry_competitor_candidate_url_resolution') {
      const candidate = task.competitor_candidates?.find(item => item.candidate_id === payload.candidate_id);
      if (!candidate || !['WAITING_CONFIRMATION', 'WAITING_DEPENDENCY'].includes(candidate.status) || candidate.url_resolution_status === 'RESOLVED') throw Object.assign(new Error('找不到可自动重试 URL 解析的候选。'), { code: 'COMPETITOR_CANDIDATE_NOT_OPEN' });
      await attemptCandidateUrlResolution(dataRoot, task, candidate);
      await commit(dataRoot, task, 'COMPETITOR_CANDIDATE_URL_RESOLUTION_RETRIED', { candidate_id: candidate.candidate_id, url_resolution_status: candidate.url_resolution_status, attempt_count: candidate.url_resolution_attempts.length });
      return { task, candidate };
    }
    if (action === 'confirm_competitor_candidate' || action === 'reject_competitor_candidate') {
      const candidate = task.competitor_candidates?.find(item => item.candidate_id === payload.candidate_id);
      if (!candidate || candidate.status !== 'WAITING_CONFIRMATION') throw Object.assign(new Error('找不到待确认的竞品来源候选。'), { code: 'COMPETITOR_CANDIDATE_NOT_OPEN' });
      if (action === 'confirm_competitor_candidate') {
        const confirmedUrl = String(candidate.product_url || '').trim();
        if (candidate.url_resolution_status !== 'RESOLVED' || !isBolProductDetailUrl(confirmedUrl)) throw Object.assign(new Error('该候选尚未解析到真实 BOL 商品详情页 URL，不能确认采用。'), { code: 'COMPETITOR_PRODUCT_URL_REQUIRED' });
        candidate.product_url = confirmedUrl;
        candidate.status = 'CONFIRMED'; candidate.candidate_status = 'CANDIDATE_DISCOVERED'; candidate.decision_status = 'CONFIRMED'; candidate.confirmed_at = iso(); candidate.confirmed_by = 'Leon';
        const sourceId = `AUTO_${candidate.candidate_id}`;
        const formal = { source_id: sourceId, exact_url: confirmedUrl, product_id: candidate.bol_product_id || null, ean: candidate.ean || null, title: candidate.title || '', proposed_type: candidate.proposed_type, source: 'BOL_API_PRODUCT_LIST', origin: 'AUTO_DISCOVERY', facts_version: candidate.facts_version, confirmed_at: candidate.confirmed_at, confirmed_by: 'Leon', usable_for_boloo_extractor: true };
        task.competitor_url_list ||= [];
        if (!task.competitor_url_list.some(item => item.exact_url === confirmedUrl)) task.competitor_url_list.push(formal);
        task.competitor_source_records ||= [];
        task.competitor_source_records.push({ ...clone(formal), record_status: 'CONFIRMED', created_at: candidate.discovered_at });
        task.competitor_discovery.status = 'CANDIDATE_CONFIRMED';
        task.competitor_discovery.updated_at = iso();
        await commit(dataRoot, task, 'COMPETITOR_SOURCE_CANDIDATE_CONFIRMED', { candidate_id: candidate.candidate_id, source_id: sourceId, facts_version: candidate.facts_version, usable_for_boloo_extractor: true });
      } else {
        candidate.status = 'REJECTED'; candidate.decision_status = 'REJECTED'; candidate.rejected_at = iso(); candidate.rejected_by = 'Leon'; candidate.rejection_reason = String(payload.reason || '').trim() || null;
        task.competitor_discovery.status = 'CANDIDATE_REJECTED'; task.competitor_discovery.updated_at = iso();
        await commit(dataRoot, task, 'COMPETITOR_SOURCE_CANDIDATE_REJECTED', { candidate_id: candidate.candidate_id, reason: candidate.rejection_reason });
      }
      return { task, candidate };
    }
    if (action === 'resolve_competitor_candidate_url') {
      const candidate = task.competitor_candidates?.find(item => item.candidate_id === payload.candidate_id);
      if (!candidate || !['WAITING_CONFIRMATION', 'URL_RESOLUTION_FAILED'].includes(candidate.status)) throw Object.assign(new Error('找不到可解析商品页 URL 的候选。'), { code: 'COMPETITOR_CANDIDATE_NOT_OPEN' });
      const submittedUrl = String(payload.product_url || '').trim();
      const checkedAt = iso();
      candidate.url_resolution ||= {};
      candidate.url_resolution.attempted_url = submittedUrl || null;
      candidate.url_resolution.updated_at = checkedAt;
      candidate.url_resolution.source = 'LEON_MANUAL_URL_RESOLUTION';
      if (!isBolProductDetailUrl(submittedUrl)) {
        candidate.url_resolution_status = 'FAILED';
        candidate.url_resolution.status = 'FAILED';
        candidate.url_resolution.reason_code = 'URL_RESOLUTION_REQUIRED';
        candidate.url_resolution.error = 'URL 不是可接受的 BOL 商品详情页路径；搜索结果页不能作为商品页。';
        candidate.status = 'WAITING_CONFIRMATION'; candidate.decision_status = 'WAITING_CONFIRMATION';
        task.competitor_discovery.status = 'WAITING_CONFIRMATION: URL_RESOLUTION_REQUIRED'; task.competitor_discovery.updated_at = checkedAt;
        await commit(dataRoot, task, 'COMPETITOR_CANDIDATE_URL_RESOLUTION_FAILED', { candidate_id: candidate.candidate_id, reason_code: candidate.url_resolution.reason_code });
      } else {
        candidate.product_url = submittedUrl;
        candidate.view_url = submittedUrl;
        candidate.url_resolution_status = 'RESOLVED';
        candidate.url_resolution.status = 'RESOLVED'; candidate.url_resolution.reason_code = null; candidate.url_resolution.resolved_at = checkedAt; candidate.url_resolution.resolved_by = 'Leon'; candidate.url_resolution.error = null;
        candidate.status = 'WAITING_CONFIRMATION'; candidate.decision_status = 'WAITING_CONFIRMATION';
        task.competitor_discovery.status = 'URL_RESOLVED_WAITING_CONFIRMATION'; task.competitor_discovery.updated_at = checkedAt;
        await commit(dataRoot, task, 'COMPETITOR_CANDIDATE_URL_RESOLVED', { candidate_id: candidate.candidate_id, url_resolution_status: 'RESOLVED', resolved_by: 'Leon' });
      }
      return { task, candidate };
    }
    if (action.startsWith('artwork_')) {
      const artwork = task.sidecars.artwork ||= { status: 'NOT_STARTED', images: [], suite_qa: { status: 'NOT_RUN', evidence: null }, final_confirmed_at: null };
      const categories = ['主图', '卖点图', '规格图', '尺寸图', '配件 / 包装图', '场景图'];
      const image = artwork.images.find(item => item.image_id === payload.image_id);
      if (action === 'artwork_add_image') {
        if (!categories.includes(payload.category)) throw Object.assign(new Error('图片分类无效。'), { code: 'ARTWORK_CATEGORY_INVALID' });
        const item = { image_id: crypto.randomUUID(), category: payload.category, status: '待制作', versions: [], active_version: null, logo_action: 'KEEP', logo: { confirmed: false }, updated_at: iso() };
        artwork.images.push(item); artwork.status = '进行中'; artwork.updated_at = iso();
        task.sidecars.art = { ...task.sidecars.art, status: artwork.status, current_step: 'IMAGE_TASKS', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_IMAGE_TASK_CREATED', { image_id: item.image_id, category: item.category });
        return { task, image: item };
      }
      if (action === 'artwork_submit_rework') {
        if (!image) throw Object.assign(new Error('找不到图片任务。'), { code: 'ARTWORK_IMAGE_NOT_FOUND' });
        const previous = image.versions.find(version => Number(version.version) === Number(payload.restore_version)) || image.versions.find(version => version.version === image.active_version) || {};
        const versionNumber = Math.max(0, ...image.versions.map(version => Number(version.version) || 0)) + 1;
        const workStatus = versionNumber === 1 ? '生成中' : '复修中';
        const version = { ...clone(previous), version: versionNumber, status: workStatus, executor_status: 'WAITING_DEPENDENCY', dependency: 'ARTWORK_EXECUTOR', prompt_extra: cleanText(payload.prompt_extra), quick_actions: Array.isArray(payload.quick_actions) ? payload.quick_actions.map(cleanText).filter(Boolean) : [], image_ref: payload.restore_version ? previous.image_ref || null : null, created_at: iso(), qwen_review: null, deepseek_review: null, qa: { status: 'NOT_RUN', evidence: null }, leon_confirmed_at: null };
        image.versions.push(version); image.active_version = versionNumber; image.status = workStatus; image.updated_at = iso();
        artwork.status = '进行中'; artwork.updated_at = iso(); task.sidecars.art = { ...task.sidecars.art, status: 'WAITING_DEPENDENCY', current_step: 'WAIT_IMAGE_GENERATION', dependency: 'ARTWORK_EXECUTOR', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_IMAGE_VERSION_SUBMITTED', { image_id: image.image_id, version: versionNumber, restored_from: payload.restore_version || null });
        return { task, image, version };
      }
      if (action === 'artwork_update_review') {
        if (!image) throw Object.assign(new Error('找不到图片任务。'), { code: 'ARTWORK_IMAGE_NOT_FOUND' });
        const version = image.versions.find(item => Number(item.version) === Number(image.active_version));
        if (!version) throw Object.assign(new Error('图片尚无待审核版本。'), { code: 'ARTWORK_VERSION_NOT_FOUND' });
        if (payload.image_ref !== undefined) version.image_ref = cleanText(payload.image_ref);
        if (payload.logo_action && ['KEEP', 'ADD', 'REMOVE'].includes(payload.logo_action)) image.logo_action = payload.logo_action;
        if (payload.logo) image.logo = { ...image.logo, ...clone(payload.logo) };
        if (payload.qwen_review !== undefined) version.qwen_review = clone(payload.qwen_review);
        if (payload.deepseek_review !== undefined) version.deepseek_review = clone(payload.deepseek_review);
        if (payload.qa !== undefined) version.qa = clone(payload.qa);
        version.updated_at = iso();
        const logoNeedsConfirmation = image.logo_action === 'ADD' && (!image.logo?.confirmed || !image.logo?.source_file || !image.logo?.brand || image.logo.brand !== task.master?.brand)
          || image.logo_action === 'REMOVE' && image.logo?.removes_product_brand === true && !image.logo?.confirmed;
        const providerNeedsConfirmation = ['WAITING_CONFIRMATION', 'FAIL'].includes(version.qwen_review?.status) || ['WAITING_CONFIRMATION', 'FAIL'].includes(version.deepseek_review?.status);
        image.status = logoNeedsConfirmation || providerNeedsConfirmation ? 'WAITING_CONFIRMATION' : 'AI审核'; image.updated_at = iso();
        const pendingConfirmation = (artwork.images || []).some(item => item.status === 'WAITING_CONFIRMATION');
        artwork.status = pendingConfirmation ? 'WAITING_CONFIRMATION' : '进行中'; artwork.updated_at = iso();
        task.sidecars.art = { ...task.sidecars.art, status: image.status, current_step: 'IMAGE_REVIEW', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_REVIEW_RESULT_RECORDED', { image_id: image.image_id, version: version.version });
        return { task, image, version };
      }
      if (action === 'artwork_fact_decision') {
        if (!image) throw Object.assign(new Error('找不到图片任务。'), { code: 'ARTWORK_IMAGE_NOT_FOUND' });
        const version = image.versions.find(item => Number(item.version) === Number(image.active_version));
        if (!version?.qwen_review || version.qwen_review.status !== 'WAITING_CONFIRMATION') throw Object.assign(new Error('当前图片没有待 Leon 确认的 Qwen 事实。'), { code: 'ARTWORK_FACT_CONFIRMATION_NOT_OPEN' });
        const decision = String(payload.decision || '');
        if (!['CONFIRM_WRITE', 'IGNORE', 'NEED_MORE_INFO'].includes(decision)) throw Object.assign(new Error('Qwen 事实确认决定无效。'), { code: 'ARTWORK_FACT_DECISION_INVALID' });
        let proposed = payload.proposed_facts ?? version.qwen_review.proposed_facts ?? {};
        if (typeof proposed === 'string') {
          try { proposed = JSON.parse(proposed); } catch { throw Object.assign(new Error('拟新增事实必须是有效 JSON。'), { code: 'ARTWORK_PROPOSED_FACTS_INVALID' }); }
        }
        if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw Object.assign(new Error('拟新增事实必须是 JSON 对象。'), { code: 'ARTWORK_PROPOSED_FACTS_INVALID' });
        version.qwen_review.proposed_facts = clone(proposed);
        version.qwen_review.leon_decision = decision;
        version.qwen_review.leon_decided_at = iso();
        if (decision === 'CONFIRM_WRITE') {
          if (!Object.keys(proposed).length) throw Object.assign(new Error('没有可确认写入的拟新增事实。'), { code: 'ARTWORK_PROPOSED_FACTS_EMPTY' });
          task.master.product_facts = { ...(task.master.product_facts || {}), ...clone(proposed) };
          task.master.fact_version = Number(task.master.fact_version || 0) + 1;
          version.qwen_review.status = 'PASS';
          version.qa = { status: 'NOT_RUN', evidence: null };
          image.status = '重新审核';
        } else if (decision === 'IGNORE') {
          version.qwen_review.status = 'PASS';
          version.qa = { status: 'NOT_RUN', evidence: null };
          image.status = '重新审核';
        } else image.status = 'WAITING_CONFIRMATION';
        image.updated_at = iso();
        const pendingConfirmation = (artwork.images || []).some(item => item.status === 'WAITING_CONFIRMATION');
        artwork.status = pendingConfirmation ? 'WAITING_CONFIRMATION' : '进行中'; artwork.updated_at = iso();
        task.sidecars.art = { ...task.sidecars.art, status: image.status, current_step: 'IMAGE_RE_REVIEW', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_QWEN_FACT_DECISION_RECORDED', { image_id: image.image_id, version: version.version, decision, written_fact_keys: decision === 'CONFIRM_WRITE' ? Object.keys(proposed) : [] });
        return { task, image, version };
      }
      if (action === 'artwork_text_decision') {
        if (!image) throw Object.assign(new Error('找不到图片任务。'), { code: 'ARTWORK_IMAGE_NOT_FOUND' });
        const version = image.versions.find(item => Number(item.version) === Number(image.active_version));
        if (!version?.deepseek_review) throw Object.assign(new Error('当前图片版本没有 DeepSeek 文字审核记录。'), { code: 'ARTWORK_TEXT_REVIEW_NOT_FOUND' });
        const decision = String(payload.decision || '');
        if (!['CONFIRM_CHANGE', 'DECLINE_CHANGE', 'MANUAL_EDIT'].includes(decision)) throw Object.assign(new Error('文字审核决定无效。'), { code: 'ARTWORK_TEXT_DECISION_INVALID' });
        if (decision === 'CONFIRM_CHANGE') {
          if (!version.deepseek_review.suggested_text) throw Object.assign(new Error('没有完整建议版本可确认。'), { code: 'ARTWORK_TEXT_SUGGESTION_MISSING' });
          version.deepseek_review.current_text = version.deepseek_review.suggested_text;
        }
        if (decision === 'MANUAL_EDIT') version.deepseek_review.current_text = cleanText(payload.current_text);
        version.deepseek_review.decision = decision;
        version.deepseek_review.status = decision === 'DECLINE_CHANGE' ? 'DECLINED' : 'NOT_RUN';
        version.qa = { status: 'NOT_RUN', evidence: null };
        version.updated_at = iso(); image.status = '重新审核'; image.updated_at = iso(); artwork.updated_at = iso();
        task.sidecars.art = { ...task.sidecars.art, status: image.status, current_step: 'IMAGE_RE_REVIEW', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_TEXT_CHANGE_DECIDED', { image_id: image.image_id, version: version.version, decision });
        return { task, image, version };
      }
      if (action === 'artwork_confirm_image') {
        if (!image) throw Object.assign(new Error('找不到图片任务。'), { code: 'ARTWORK_IMAGE_NOT_FOUND' });
        const version = image.versions.find(item => Number(item.version) === Number(image.active_version));
        if (!version || version.qa?.status !== 'PASS') throw Object.assign(new Error('当前图片版本必须先通过单图 QA 才能由 Leon 确认为 FINAL。'), { code: 'ARTWORK_IMAGE_QA_REQUIRED' });
        if (version.qwen_review?.status !== 'PASS' || version.deepseek_review?.status !== 'PASS') throw Object.assign(new Error('Qwen 视觉审核和 DeepSeek 文字审核都必须记录 PASS 后才能由 Leon 确认为 FINAL。'), { code: 'ARTWORK_IMAGE_AI_REVIEW_REQUIRED' });
        if (image.status === 'WAITING_CONFIRMATION' || image.logo_action === 'ADD' && (!image.logo?.confirmed || !image.logo?.source_file || !image.logo?.brand || image.logo.brand !== task.master?.brand) || image.logo_action === 'REMOVE' && image.logo?.removes_product_brand === true && !image.logo?.confirmed) throw Object.assign(new Error('Logo/品牌操作或 AI 审核仍需 Leon 确认，不能进入 FINAL。'), { code: 'ARTWORK_CONFIRMATION_REQUIRED' });
        version.status = 'FINAL'; version.leon_confirmed_at = iso(); image.status = 'FINAL'; image.updated_at = iso(); artwork.updated_at = iso();
        task.sidecars.art = { ...task.sidecars.art, status: '进行中', current_step: 'SUITE_QA', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_IMAGE_CONFIRMED_FINAL', { image_id: image.image_id, version: version.version });
        return { task, image, version };
      }
      if (action === 'artwork_update_suite_qa') {
        artwork.suite_qa = clone(payload.suite_qa || { status: 'NOT_RUN', evidence: null }); artwork.updated_at = iso();
        await commit(dataRoot, task, 'ARTWORK_SUITE_QA_UPDATED', { status: artwork.suite_qa.status || 'NOT_RUN' });
        return { task };
      }
      if (action === 'artwork_confirm_final') {
        const images = artwork.images || [];
        if (!images.length || images.some(item => item.status !== 'FINAL' || !item.versions.some(version => Number(version.version) === Number(item.active_version) && version.qa?.status === 'PASS' && version.qwen_review?.status === 'PASS' && version.deepseek_review?.status === 'PASS')) || artwork.suite_qa?.status !== 'PASS') {
          throw Object.assign(new Error('所有图片的单图 QA、Qwen 视觉审核、DeepSeek 文字审核必须 PASS，且 Leon 逐张确认、整套图片 QA 通过后才能确认 FINAL。'), { code: 'ARTWORK_FINAL_GATE_BLOCKED' });
        }
        artwork.status = 'FINAL'; artwork.final_confirmed_at = iso(); artwork.updated_at = iso(); task.sidecars.art = { ...task.sidecars.art, status: 'FINAL', current_step: 'ARTWORK_FINAL', updated_at: iso() };
        await commit(dataRoot, task, 'ARTWORK_SIDECAR_CONFIRMED_FINAL', { image_count: images.length });
        return { task };
      }
      throw Object.assign(new Error(`不支持的美工操作：${action}`), { code: 'ARTWORK_ACTION_UNKNOWN' });
    }
    if (action === 'attach_own_material') {
      if (!['LISTING_SOP_01', 'LISTING_SOP_02', 'LISTING_SOP_03'].includes(task.current_step)) throw Object.assign(new Error('当前只允许在 SOP01–03 阶段补充并重核自有资料。'), { code: 'OWN_MATERIAL_STAGE_LOCKED' });
      const result = await persistOwnedMaterial(dataRoot, task, payload);
      const executed = await dispatchCurrent(dataRoot, result.task);
      return { task: executed, material: result.material };
    }
    if (action === 'confirm_product_facts' || action === 'ignore_product_facts') {
      if (task.current_step !== 'LISTING_SOP_02' || task.status !== 'WAITING_CONFIRMATION' || task.confirmation?.status !== 'OPEN' || task.confirmation?.source_module !== 'LISTING_SOP_02') throw Object.assign(new Error('当前 SKU 没有开放的 SOP02 产品事实确认。'), { code: 'PRODUCT_FACT_CONFIRMATION_NOT_OPEN' });
      const proposals = task.confirmation.proposals || [];
      const decisionAt = iso();
      task.listing_sop.decisions ||= [];
      if (action === 'confirm_product_facts') {
        const resolutions = payload.resolutions && typeof payload.resolutions === 'object' ? payload.resolutions : {};
        const missing = proposals.filter(proposal => !Object.hasOwn(resolutions, proposal.field));
        if (missing.length) throw Object.assign(new Error(`还需为这些事实选择确认值：${missing.map(item => item.label).join('、')}`), { code: 'PRODUCT_FACT_RESOLUTION_REQUIRED' });
        task.master.confirmed_facts ||= {};
        for (const proposal of proposals) {
          const selection = resolutions[proposal.field];
          const candidateIndex = Number.isInteger(selection) ? selection : Number.isInteger(selection?.candidate_index) ? selection.candidate_index : -1;
          let candidate = candidateIndex >= 0 ? proposal.candidates[candidateIndex] : null;
          if (!candidate) candidate = proposal.candidates.find(item => canonicalFact(item.value) === canonicalFact(selection?.value ?? selection));
          if (!candidate && proposal.reason === 'BRAND_MISSING' && typeof selection?.value === 'string' && cleanText(selection.value)) {
            const importVersion = Number(task.master.excel_source_import?.version || task.master.fact_version || 1);
            candidate = { value: cleanText(selection.value), source: 'Leon manual brand confirmation', source_type: 'PRODUCT_MASTER', source_reference: `product-master://${encodeURIComponent(task.sku)}/brand-confirmation/v${importVersion}`, source_version: importVersion };
          }
          if (!candidate) throw Object.assign(new Error(`字段 ${proposal.label} 的确认值必须选择有效自有来源候选，或为缺失品牌输入 Leon 确认值。`), { code: 'PRODUCT_FACT_RESOLUTION_INVALID' });
          task.master.confirmed_facts[proposal.field] = { value: clone(candidate.value), source: candidate.source, source_type: candidate.source_type, source_reference: candidate.source_reference, source_version: candidate.source_version, confirmed_by: 'Leon', confirmed_at: decisionAt, proposal_id: task.confirmation.proposal_id };
          if (proposal.field === 'brand_name') { task.master.brand_name = cleanText(candidate.value); task.master.brand = task.master.brand_name; }
        }
        const previousFactVersion = Number(task.master.fact_version || 1);
        task.master.fact_version = previousFactVersion + 1;
        const stale = markDependentListingOutputsStale(task, task.master.fact_version, 'LEON_CONFIRMED_PRODUCT_FACT_VERSION_CHANGED');
        task.listing_sop.decisions.push({ type: 'CONFIRM_PRODUCT_FACTS', proposal_id: task.confirmation.proposal_id, resolutions: clone(task.master.confirmed_facts), at: decisionAt, new_product_master_version: task.master.fact_version, stale_outputs: stale });
        task.confirmation.status = 'CONFIRMED'; task.confirmation.closed_at = decisionAt; task.confirmation.decided_by = 'Leon';
        await commit(dataRoot, task, 'LISTING_SOP_02_FACTS_CONFIRMED', { proposal_id: task.confirmation.proposal_id, confirmed_fields: proposals.map(item => item.field), product_master_version: task.master.fact_version, stale_outputs: stale });
      } else {
        task.listing_sop.ignored_facts ||= {};
        for (const proposal of proposals) task.listing_sop.ignored_facts[proposal.field] = { proposal_id: task.confirmation.proposal_id, reason: cleanText(payload.reason) || 'Leon ignored proposal; no fact written to Product Master.', decided_by: 'Leon', decided_at: decisionAt };
        task.listing_sop.decisions.push({ type: 'IGNORE_PRODUCT_FACT_PROPOSALS', proposal_id: task.confirmation.proposal_id, ignored_fields: proposals.map(item => item.field), at: decisionAt, wrote_product_master: false });
        task.confirmation.status = 'IGNORED'; task.confirmation.closed_at = decisionAt; task.confirmation.decided_by = 'Leon';
        await commit(dataRoot, task, 'LISTING_SOP_02_FACTS_IGNORED', { proposal_id: task.confirmation.proposal_id, ignored_fields: proposals.map(item => item.field), product_master_written: false });
      }
      task.confirmation = null;
      const restartStep = action === 'confirm_product_facts' ? 'LISTING_SOP_01' : 'LISTING_SOP_02';
      task.status = 'QUEUED'; task.activity_pool = '资料处理池'; task.resume_point = restartStep; task.current_step = restartStep; task.listing_sop.current_step_id = restartStep;
      task.stages[restartStep] = { ...task.stages[restartStep], status: 'QUEUED', updated_at: iso() };
      await commit(dataRoot, task, 'LISTING_SOP_02_DECISION_RECHECK_QUEUED', { decision: action === 'confirm_product_facts' ? 'CONFIRM' : 'IGNORE', step_id: restartStep, confirmed_product_facts_decision_step_id: 'LISTING_SOP_02' });
      await dispatchCurrent(dataRoot, task);
      return { task };
    }
    if (action === 'history') return { task, history: await getHistory(dataRoot, id) };
    if (action === 'view_error') return { task, errors: task.issues };
    if (action === 'prioritize') {
      const prior = Number(task.priority?.value || 0);
      task.priority = { value: prior + 1, updated_at: iso(), applies_to: 'NEXT_QUEUED_TASK_ONLY' };
      await commit(dataRoot, task, 'TASK_PRIORITY_RAISED', { previous_priority: prior, priority: task.priority.value, running_work_interrupted: false });
      return { task, priority: task.priority };
    }
    if (action === 'pause') {
      task.status = 'PAUSED'; task.resume_point = task.current_step;
      task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'PAUSED', updated_at: iso() };
      await commit(dataRoot, task, 'TASK_PAUSED', { resume_point: task.resume_point });
      return { task };
    }
    if (action === 'change') {
      const changed = await editMaster(task, payload.patch);
      if (!changed.length) throw Object.assign(new Error('没有可修改的 Product Master 字段。'), { code: 'NO_FIELDS_CHANGED' });
      if (task.activity_pool === '异常池') {
        for (const issue of task.issues) if (issue.status === 'OPEN') { issue.status = 'FIXED_PENDING_QA'; issue.fixed_at = iso(); issue.updated_at = iso(); }
        task.status = 'FIXED_PENDING_QA';
        task.activity_pool = '异常池';
      }
      task.open_error_count = activeIssueCount(task);
      await commit(dataRoot, task, 'PRODUCT_MASTER_CHANGED', { changed_fields: changed, stale_outputs: task.listing_sop?.stale_dependencies?.at(-1)?.outputs || [] });
      if (['LISTING_SOP_01', 'LISTING_SOP_02', 'LISTING_SOP_03'].includes(task.current_step)) {
        task.current_step = 'LISTING_SOP_01'; task.resume_point = task.current_step; task.listing_sop.current_step_id = task.current_step;
        task.status = 'QUEUED'; task.activity_pool = '资料处理池';
        task.qa.LISTING_SOP_01 = { status: 'NOT_RUN', checked_at: null, report: null };
        task.qa.LISTING_SOP_02 = { status: 'NOT_RUN', checked_at: null, report: null };
        task.stages.LISTING_SOP_01 = { ...task.stages.LISTING_SOP_01, status: 'QUEUED', updated_at: iso() };
        await dispatchCurrent(dataRoot, task);
      }
      return { task };
    }
    if (action === 'fix' || action === 'auto_fix') {
      const issue = task.issues.find(item => item.issue_id === payload.issue_id && item.status !== 'CLOSED');
      if (!issue) throw Object.assign(new Error('找不到可修复的异常。'), { code: 'ISSUE_NOT_FOUND' });
      let patch = payload.patch || {};
      if (action === 'auto_fix') {
        if (issue.code === 'WEIGHT_UNIT_NOT_KG') patch = { weight_unit: 'kg' };
        else throw Object.assign(new Error('此异常没有安全且无歧义的自动修复规则。'), { code: 'AUTO_FIX_UNAVAILABLE' });
      }
      if (patch.weight_unit != null) task.master.weight_unit = 'kg';
      const changed = await editMaster(task, patch);
      issue.status = 'FIXED_PENDING_QA'; issue.fixed_at = iso(); issue.updated_at = iso();
      task.status = 'FIXED_PENDING_QA'; task.activity_pool = '异常池';
      task.open_error_count = activeIssueCount(task);
      await commit(dataRoot, task, action === 'auto_fix' ? 'ISSUE_AUTO_FIXED_PENDING_QA' : 'ISSUE_FIXED_PENDING_QA', { issue_id: issue.issue_id, changed_fields: changed });
      return { task };
    }
    if (action === 'reverify') {
      if (!['异常池', '待处理池', '资料处理池', '关键词池', 'Listing 生成池', 'QA 池'].includes(task.activity_pool)) throw Object.assign(new Error('当前活动池不允许重新核验。'), { code: 'REVERIFY_STATE_INVALID' });
      if (task.current_step === 'boloo_keywords' && task.boloo?.current_subtask_id) {
        const index = task.boloo.required_subtasks?.findIndex(item => item.subtask_id === task.boloo.current_subtask_id) ?? -1;
        const subtask = task.boloo.required_subtasks?.[index];
        const fixedIssue = task.issues.some(issue => issue.step === 'boloo_keywords' && issue.location === `boloo.required_subtasks.${index}` && issue.status === 'FIXED_PENDING_QA');
        if (subtask?.status === 'ERROR' && fixedIssue) {
          subtask.status = 'NOT_STARTED';
          subtask.result = null;
          subtask.error_code = null;
          subtask.updated_at = iso();
          task.status = 'RUNNING';
          task.stages.boloo_keywords = { ...task.stages.boloo_keywords, status: 'WAITING_PROVIDER_RECHECK', updated_at: iso() };
          await commit(dataRoot, task, 'BOLOO_RECHECK_READY', { step: 'boloo_keywords', source_id: subtask.source_id, subtask_id: subtask.subtask_id, next_attempt: Number(subtask.attempt_count || 0) + 1 });
          return { passed: false, provider_recheck_required: true, task };
        }
      }
      if (task.provider_child_task?.parent_sop_step === 'LISTING_SOP_03'
        && task.provider_child_task?.provider_stage === 'boloo_keywords'
        && task.provider_child_task?.task_type === 'KEYWORD_EXTRACTOR') {
        return await verifyBolooProviderChild(dataRoot, task);
      }
      if (task.current_step === 'boloo_keywords') syncBolooCandidatePool(task);
      const result = await verifyCurrent(dataRoot, task);
      return { ...result };
    }
    if (action === 'continue' || action === 'retry') {
      if (task.issues.some(item => item.status === 'FIXED_PENDING_QA')) throw Object.assign(new Error('存在修复待核验项，先重新核验。'), { code: 'FIXED_PENDING_QA_BLOCKS_CONTINUE' });
      const revisionBeforeContinue = Number(task.revision);
      const internalEngineRecovery = action === 'continue' ? await inspectRecoverableSop05InternalEngineFailure(dataRoot, task) : null;
      if (action === 'continue' && task.current_step === 'LISTING_SOP_04' && !task.sop04_seed_selection?.exact_string) {
        const { result, sop03Version, facts } = currentSop04AutomaticSeedDecision(task);
        if (result.status === 'SELECTED') {
          persistAutomaticSop04SeedSelection(task, result.selected);
          if (task.status === 'WAITING_DECISION') task.status = 'PAUSED';
          await commit(dataRoot, task, 'LISTING_SOP_04_SEED_AUTO_SELECTED', {
            exact_string: result.selected.exact_string, policy: result.policy,
            seed_selection_reason: result.selected.seed_selection_reason,
            source_refs: result.selected.source_refs, facts_evidence_refs: result.selected.facts_evidence_refs,
            sop03_artifact_version: sop03Version, confirmed_product_facts_version: facts?.version ?? null,
            external_requests: 0,
          });
        } else {
          const reason = setSop04SeedSelectorWait(task, result);
          applyListingExecutorStep(task, 'LISTING_SOP_04', {
            status: task.status, waiting_reason: reason, resume_point: 'LISTING_SOP_04',
            input_version_refs: [{ artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: sop03Version },
              { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: facts?.version ?? null }],
          });
          await commit(dataRoot, task, result.status === 'WAITING_DECISION' ? 'LISTING_SOP_04_SEED_SELECTION_AMBIGUOUS' : 'LISTING_SOP_04_SEED_SELECTOR_UNRESOLVED', {
            policy: result.policy, reason_code: result.reason_code, reason,
            decision_candidates: result.decision_candidates || [], external_requests: 0,
          });
          return { task, selector_result: result, external_requests: 0 };
        }
      }
      if (action === 'continue' && Object.hasOwn(SOP10_17_EXECUTOR_IDS, task.current_step)
        && ['QWEN', 'DEEPSEEK'].includes(String(task.waiting_dependency_key || '').toUpperCase())
        && !task.ai_generation_waiting?.generation_key) {
        const legacyWaitReason = [task.stages?.[task.current_step]?.waiting_reason, task.listing_executor?.registry?.[task.current_step]?.waiting_reason]
          .filter(Boolean).join(' ');
        if (/PROVIDER_TIMEOUT|EMPTY_CONTENT|TRUNCAT|JSON_INVALID|JSON_PARSE|SCHEMA_INVALID|ECONNRESET|NETWORK_ERROR|NETWORK_TIMEOUT|TRANSPORT_FAILURE/i.test(legacyWaitReason)) {
          throw Object.assign(new Error('历史生成失败缺少精确 recovery context；拒绝仅凭 control-plane readiness 重新派发。'), { code: 'GENERATION_RECOVERY_CONTEXT_MISSING' });
        }
      }
      const reclassifiedEngineIssueIds = [];
      if (internalEngineRecovery) {
        const issue = (task.issues || []).find(item => item.issue_id === internalEngineRecovery.issue_id);
        issue.status = 'CLOSED'; issue.closed_at = iso(); issue.updated_at = issue.closed_at;
        issue.close_reason = 'RECOVERED_AFTER_SOP05_EXECUTOR_REGISTRATION';
        reclassifiedEngineIssueIds.push(issue.issue_id);
        task.open_error_count = activeIssueCount(task);
        if (task.open_error_count === 0) { task.error_code = null; task.error_message = null; task.status = 'PAUSED'; }
      }
      if (Object.hasOwn(SOP10_17_EXECUTOR_IDS, task.current_step)) {
        for (const issue of task.issues || []) {
          if (issue.step === task.current_step && issue.code === 'ENGINE_NOT_CONNECTED' && issue.status === 'OPEN') {
            issue.status = 'CLOSED'; issue.closed_at = iso(); issue.close_reason = 'INTERNAL_EXECUTOR_REGISTERED_RECLASSIFIED_AS_PROVIDER_DEPENDENCY'; issue.updated_at = issue.closed_at;
            reclassifiedEngineIssueIds.push(issue.issue_id);
          }
        }
        if (reclassifiedEngineIssueIds.length) {
          task.open_error_count = activeIssueCount(task);
          if (task.open_error_count === 0) { task.error_code = null; task.error_message = null; }
        }
      }
      if (action === 'continue' && !['PAUSED', 'WAITING_DEPENDENCY'].includes(task.status) && !internalEngineRecovery) throw Object.assign(new Error('【继续】只用于暂停/重启或依赖就绪后的恢复。'), { code: 'CONTINUE_REQUIRES_PAUSED' });
      const acceptanceResumeStep = action === 'continue' ? acceptanceStopResumeStep(task) : null;
      const expectedDependency = action === 'continue' && task.ai_generation_waiting?.generation_key
        ? String(task.ai_generation_waiting.provider || '').toUpperCase()
        : action === 'continue' && task.status === 'WAITING_DEPENDENCY' ? listingExecutionDependencyForTask(task) : null;
      let generationRecovery = null;
      let acceptanceRetry = false;
      let providerDependencyReadiness = null;
      if (action === 'continue' && task.current_step === 'LISTING_SOP_12' && task.ai_generation_waiting?.provider === 'Qwen') {
        const inputs = await resolveSop10To17Inputs(dataRoot, task, task.current_step);
        const identity = buildListingProviderGenerationIdentity({task,step:task.current_step,inputs,provider:'Qwen'});
        acceptanceRetry = await acceptanceControlledRetry(dataRoot, identity);
      }
      if (action === 'continue' && task.ai_generation_waiting?.generation_key) {
        generationRecovery = acceptanceRetry ? {allowed:true,source:'LEON_ACCEPTANCE_CONTROLLED_RETRY'} : await evaluateGenerationRecoveryGate(dataRoot, task.ai_generation_waiting);
        if (!generationRecovery.allowed) throw Object.assign(new Error('Generation recovery probe must PASS after the saved failure before continuing.'), { code: 'GENERATION_RECOVERY_GATE_CLOSED' });
      }
      if (action === 'continue' && task.status === 'WAITING_DEPENDENCY') {
        if (!expectedDependency || task.waiting_dependency_key !== expectedDependency) {
          throw Object.assign(new Error('等待依赖与当前步骤不精确匹配；拒绝恢复。'), { code: 'DEPENDENCY_KEY_MISMATCH', expected_dependency_key: expectedDependency || null, actual_dependency_key: task.waiting_dependency_key || null });
        }
        let ready = expectedDependency === 'BOL_API'
          ? (typeof readinessOverride('BOL_API_READY') === 'boolean' ? readinessOverride('BOL_API_READY') : (await bolApiReadiness(dataRoot)).status === 'PASS')
          : expectedDependency === 'QWEN' || expectedDependency === 'DEEPSEEK' ? false
          : expectedDependency === 'BOLOO_WEBVIEW2_PANE'
            ? isSop06PaneDependencyReadyForContinue({ expectedDependency,
              paneReadiness: await readFreshBolooPaneRuntimeReadiness(), officialWebReady: isOfficialWebBolooReady() })
          : task.current_step === 'boloo_keywords' ? isOfficialWebBolooReady()
            : task.current_step === 'top20' || task.current_step === 'LISTING_SOP_07' ? isTop20ExecutorReady() : false;
        if (expectedDependency === 'AI_PROVIDER_ADAPTER' && Object.hasOwn(SOP10_17_EXECUTOR_IDS, task.current_step)
          && !task.ai_generation_waiting?.generation_key) {
          // Legacy router registration/control-plane wait; no generation barrier is bypassed.
          ready = (await getAiProviderReadiness(dataRoot)).primary_ready === true;
        }
        if ((expectedDependency === 'QWEN' || expectedDependency === 'DEEPSEEK') && task.ai_generation_waiting?.generation_key) {
          ready = generationRecovery?.allowed === true;
        } else if (expectedDependency === 'QWEN' || expectedDependency === 'DEEPSEEK') {
          const aiReadiness = await getAiProviderReadiness(dataRoot);
          const provider = expectedDependency === 'QWEN' ? aiReadiness.providers?.QWEN : aiReadiness.providers?.DEEPSEEK;
          const barrier = resolveAiProviderDependencyBarrier({ task, history: await getHistory(dataRoot, id), dependency: expectedDependency });
          ready = provider?.ready === true && isProviderReadinessAfterBarrier(provider?.checked_at, barrier?.at);
          if (ready) providerDependencyReadiness = {
            dependency: expectedDependency, checked_at: provider.checked_at, required_readiness_after: barrier.at,
            barrier_source: barrier.source, readiness_source: provider.readiness_evidence_status || provider.readiness_source || 'NOT_REPORTED',
          };
        }
        if (!ready) throw Object.assign(new Error('当前阶段依赖尚未就绪；没有发送生产请求。'), { code: 'DEPENDENCY_NOT_READY' });
      }
      if (acceptanceRetry) {
        task.generation_recovery = null;
        await commit(dataRoot, task, 'ACCEPTANCE_CONTROLLED_GENERATION_RETRY_AUTHORIZED', {step:task.current_step,provider:'Qwen',generation_key:task.ai_generation_waiting.generation_key,timeout_ms:120000,max_retries:0,max_business_calls:1,source:'SYNTHETIC_ACCEPTANCE_10_6H_REAL_LISTING_CLOSEOUT'});
      }
      if (generationRecovery?.allowed && !acceptanceRetry) {
        const boundRecovery = task.generation_recovery?.status === 'RECOVERY_AUTHORIZED'
          && task.generation_recovery.generation_key === task.ai_generation_waiting?.generation_key
          && task.generation_recovery.probe_id === task.ai_generation_waiting?.probe_id
          && task.generation_recovery.circuit_state === 'HALF_OPEN';
        if (boundRecovery) {
          const route = await evaluateGenerationRecoveryRoute(dataRoot, {
            wait: task.ai_generation_waiting,
            identity: task.generation_recovery.wait_context ? {
              ...task.generation_recovery.wait_context,
              generation_key: task.generation_recovery.generation_key,
              provider: task.generation_recovery.provider,
              effective_model: task.generation_recovery.effective_model,
            } : null,
            consumedProbeId: task.generation_recovery.probe_id,
            consumedCircuitState: task.generation_recovery.circuit_state,
          });
          if (!route.allowed) throw Object.assign(new Error('Bound generation recovery permit is no longer valid.'), { code: 'GENERATION_RECOVERY_GATE_CLOSED', reason: route.reason });
        } else {
          const consumed = await consumeGenerationRecoveryGate(dataRoot, task.ai_generation_waiting);
          if (!consumed.allowed) throw Object.assign(new Error('Generation recovery gate changed before dispatch.'), { code: 'GENERATION_RECOVERY_GATE_CLOSED' });
          task.generation_recovery = {
            probe_id: consumed.probe_id,
            circuit_state: consumed.circuit_state,
            consumed_at: iso(),
            wait_context: clone(task.ai_generation_waiting),
          };
        }
      }
      if (action === 'continue' && task.open_error_count > 0) throw Object.assign(new Error('仍有未关闭异常；先修复并重新核验，再从恢复点继续。'), { code: 'OPEN_ERRORS_BLOCK_CONTINUE' });
      if (action === 'retry' && task.activity_pool !== '异常池') throw Object.assign(new Error('【重新执行】只对异常池中的当前 SKU 开放。'), { code: 'RETRY_REQUIRES_EXCEPTION' });
      if (task.qa[task.current_step]?.status === 'PASS' && !acceptanceResumeStep) throw Object.assign(new Error('当前步骤已通过 QA；任务已在下一步或下一池，拒绝重复执行。'), { code: 'STEP_ALREADY_PASSED' });
      if (acceptanceResumeStep) releaseAcceptanceStop(task);
      else task.current_step = task.resume_point || task.current_step;
      if (expectedDependency === 'QWEN' || expectedDependency === 'DEEPSEEK') {
        task.dependency_failed_at = null;
        task.required_readiness_after = null;
        task.ai_generation_waiting = null;
      }
      task.activity_pool = task.activity_pool === '异常池' ? (task.return_pool || STEPS.find(item => item[0] === task.current_step)?.[2] || '资料处理池') : task.activity_pool;
      task.return_pool = null;
      if (task.listing_sop && /^LISTING_SOP_\d{2}$/.test(String(task.current_step || ''))) task.listing_sop.current_step_id = task.current_step;
      setPoolForStep(task, task.current_step);
      task.resume_point = task.current_step;
      if (action === 'retry') task.retry_count += 1;
      task.status = 'RUNNING';
      task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'RUNNING', updated_at: iso() };
      const isTestFixture = acceptanceMode(dataRoot) && task.master?.product_facts?.acceptance_fixture === true;
      const problems = isTestFixture ? [] : (task.current_step === 'product_master' ? await validateStage(task, task.current_step, dataRoot) : []);
      if (problems.length) {
        task.qa[task.current_step] = { status: 'FAIL', checked_at: iso(), report: problems.map(item => item[1]) };
        task.stages[task.current_step] = { ...task.stages[task.current_step], status: 'QA_FAIL', updated_at: iso() };
        for (const [code, reason, field, standard, suggestion] of problems) issueFor(task, code, reason, field, standard, suggestion);
        task.return_pool = task.return_pool || task.activity_pool;
        task.activity_pool = '异常池'; task.status = 'ERROR'; task.open_error_count = activeIssueCount(task);
        await commit(dataRoot, task, 'STEP_RETRY_BLOCKED', { step: task.current_step, retry_count: task.retry_count, codes: problems.map(item => item[0]) });
        return { task };
      }
      await commit(dataRoot, task, action === 'continue' ? 'TASK_CONTINUED' : 'TASK_RETRY_STARTED', {
        step: task.current_step, resume_point: task.resume_point, retry_count: task.retry_count,
        ...(providerDependencyReadiness ? { provider_dependency_readiness: providerDependencyReadiness } : {}),
        ...(reclassifiedEngineIssueIds.length ? { reclassified_engine_issue_ids: reclassifiedEngineIssueIds } : {}),
        ...(internalEngineRecovery ? { internal_executor_error_recovered: 'ENGINE_NOT_CONNECTED', recovered_from_event_id: internalEngineRecovery.failed_event_id, recovery_reason: 'SOP05_EXECUTOR_REGISTERED_NO_PRIOR_OUTPUT_OR_REMOTE_ATTEMPT' } : {}),
        ...(acceptanceResumeStep ? { acceptance_stop_released: true, stopped_after_step: task.acceptance_stop_gate?.stopped_after_step } : {}),
      }, { expectedRevision: internalEngineRecovery ? revisionBeforeContinue : null });
      await dispatchCurrent(dataRoot, task);
      return { task };
    }
    if (action === 'mark_uploaded') {
      const allPass = STEPS.every(([step]) => task.qa[step]?.status === 'PASS');
      if (task.activity_pool !== '待上传池' || !allPass || task.open_error_count !== 0 || task.status !== 'READY_FOR_UPLOAD') throw Object.assign(new Error('Final QA、Excel QA、OPEN_ERROR_COUNT=0 或待上传池条件未满足。'), { code: 'UPLOAD_GATE_BLOCKED' });
      const outputs = clone(task.outputs || {});
      const final = {
        final_version_id: `${task.sku}:final:v${String(Number(task.revision || 0) + 1).padStart(6, '0')}`,
        immutable: true, archived_at: iso(), sku: task.sku,
        product_master_version: task.master.fact_version,
        versions: {
          product_facts: task.master.fact_version,
          keywords: outputs.boloo_keywords?.evidence?.version ?? outputs.top20?.evidence?.version ?? null,
          listing_competitor_data_version: outputs.competitors?.evidence?.version ?? null,
          image: outputs.art_review?.evidence?.version ?? null,
        },
        keyword_snapshot: {
          captured_at: iso(),
          candidates: clone(task.boloo?.candidates || []),
          required_subtasks: clone(task.boloo?.required_subtasks || []),
          outputs: clone(Object.fromEntries(Object.entries(outputs).filter(([key]) => ['bol_keywords', 'boloo_keywords', 'top20', 'selling_matrix', 'title', 'anchors', 'description', 'attributes', 'packaging', 'keyword_layout'].includes(key)))),
          versions: {
            top20: outputs.top20?.evidence?.version ?? null,
            listing_competitor_data_version: outputs.competitors?.evidence?.version ?? null,
            selling_matrix: outputs.selling_matrix?.evidence?.version ?? null,
          },
        },
        listing_outputs: outputs, qa: clone(task.qa), sidecars: clone(task.sidecars || {}),
        source_facts: clone(task.master), upload_date: cleanText(payload.upload_date) || new Date().toISOString().slice(0, 10),
        uploaded_by: 'Leon', status: 'UPLOADED_ARCHIVED',
      };
      task.final_archive = final; task.activity_pool = '已上传存档池'; task.status = 'UPLOADED_ARCHIVED';
      task.sidecars.upload = { status: 'UPLOADED', updated_at: iso(), upload_date: final.upload_date };
      await atomicJson(path.join(dataRoot, 'uploads', `${task.id}.final.json`), final);
      await commit(dataRoot, task, 'PRODUCT_MARKED_UPLOADED', { upload_date: final.upload_date });
      return { task };
    }
    throw Object.assign(new Error(`不支持的操作：${action}`), { code: 'ACTION_UNKNOWN' });
  });
  if (explicitContinueAction || explicitManualPauseAction) {
    return withAcceptanceManualContinueScope(dataRoot, id, action, runAction);
  }
  return recoveryHoldAction || qwenSop10RecoveryHoldAction || deepSeekListingStepRecoveryHoldAction
    || localControlAction || cachedSop07RevalidationAction || cachedListingRepairHoldAction
    ? acceptanceRecoveryControlScope.run({ sku: id, action,
      acceptance_data_root: qwenSop10RecoveryHoldAction || deepSeekListingStepRecoveryHoldAction
        || localControlAction || cachedSop07RevalidationAction || cachedListingRepairHoldAction,
      ...(cachedListingRepairHoldAction ? { data_root: path.resolve(dataRoot) } : {}) }, runAction)
    : runAction();
}
