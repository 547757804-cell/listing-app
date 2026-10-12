import crypto from 'node:crypto';

export const LISTING_EXECUTOR_STATUS_VALUES = Object.freeze([
  'NOT_STARTED', 'QUEUED', 'RUNNING', 'DONE_PENDING_QA', 'PASS', 'QA_FAIL',
  'WAITING_DEPENDENCY', 'WAITING_CONFIRMATION', 'WAITING_DECISION', 'PAUSED', 'ERROR', 'STALE',
]);
const STATUS_SET = new Set(LISTING_EXECUTOR_STATUS_VALUES);

export const LISTING_ARTIFACT_DEPENDENCY_DAG = Object.freeze({
  CONFIRMED_PRODUCT_FACTS_VERSION: ['LISTING_SOP_03', 'LISTING_SOP_04'],
  LISTING_SOP_03: ['LISTING_SOP_04', 'LISTING_SOP_05'],
  LISTING_SOP_04: ['LISTING_SOP_05'],
  LISTING_SOP_05: ['LISTING_SOP_06'],
  LISTING_SOP_06: ['LISTING_SOP_07'],
  LISTING_SOP_07: ['LISTING_SOP_08', 'LISTING_SOP_12'],
  LISTING_SOP_08: ['LISTING_SOP_09'],
  LISTING_SOP_09: ['LISTING_SOP_10', 'LISTING_SOP_11'],
  LISTING_SOP_10: ['LISTING_SOP_12'],
  LISTING_SOP_11: ['LISTING_SOP_12'],
  LISTING_SOP_12: ['LISTING_SOP_13'],
  LISTING_SOP_13: ['LISTING_SOP_14', 'LISTING_SOP_15', 'LISTING_SOP_16'],
  LISTING_SOP_14: ['LISTING_SOP_15', 'LISTING_SOP_16', 'LISTING_SOP_17'],
  LISTING_SOP_15: ['LISTING_SOP_16', 'LISTING_SOP_17'],
  LISTING_SOP_16: ['LISTING_SOP_17'],
  LISTING_SOP_17: ['EXCEL_WRITE'],
  EXCEL_WRITE: ['EXCEL_READBACK_QA'],
  EXCEL_READBACK_QA: ['AWAIT_UPLOAD'],
  AWAIT_UPLOAD: ['UPLOAD_INTEGRATION'],
  UPLOAD_INTEGRATION: ['FINAL_ARCHIVE'],
});

const CONTRACTS = {
  LISTING_SOP_03: { required_inputs: ['CONFIRMED_PRODUCT_FACTS_VERSION', 'LEON_BOL_COMPETITOR_URLS', 'AMAZON_REFERENCE_IF_PRESENT'], required_dependencies: ['BOLOO_OFFICIAL_WEB', 'AMAZON_SOURCE_IF_CONNECTED'], output_type: 'LISTING_KEYWORD_SOURCE_SET', output_fields: ['source_type', 'exact_string', 'source_url', 'source_title', 'source_evidence', 'language', 'discovered_at', 'facts_version'], qa_executor: 'qaListingSop03Contract' },
  LISTING_SOP_04: { required_inputs: ['LISTING_SOP_03', 'CONFIRMED_DUTCH_MARKET_TERMS'], required_dependencies: ['BOL_API'], output_type: 'BOL_RELATED_TERMS_SET', output_fields: ['seed_exact_string', 'returned_raw_terms', 'adopted_terms', 'api_evidence', 'queried_at'], qa_executor: 'qaListingSop04Contract' },
  LISTING_SOP_05: { executor_id: 'SOP05_KEYWORD_CANDIDATE_POOL_EXECUTOR', required_inputs: ['CONFIRMED_PRODUCT_FACTS_VERSION', 'LISTING_SOP_03', 'LISTING_SOP_04'], required_dependencies: [], output_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL', output_fields: ['exact_string', 'status', 'source_refs', 'evidence_refs', 'selection_reason', 'exclusion_reason'], qa_executor: 'qaListingSop05Contract' },
  LISTING_SOP_06: { required_inputs: ['LISTING_SOP_05', 'REQUIRED_EXACT_KEYWORDS', 'REQUIRED_COMPETITOR_URLS'], required_dependencies: ['BOLOO_OFFICIAL_WEB'], output_type: 'BOLOO_KEYWORD_VOLUME_RESULTS', output_fields: ['subtask_id', 'source_id', 'exact_string', 'status', 'reason_code', 'attempt', 'request_id', 'volume', 'provider_method', 'evidence_refs', 'queried_at'], qa_executor: 'qaListingSop06Contract' },
  LISTING_SOP_07: { required_inputs: ['CONFIRMED_PRODUCT_FACTS_VERSION', 'LISTING_SOP_03', 'LISTING_SOP_04', 'LISTING_SOP_05', 'LISTING_SOP_06'], required_dependencies: [], output_type: 'LISTING_TOP20_VERSION', output_fields: ['rank', 'exact_string', 'boloo_search_volume', 'demand_status', 'keyword_category', 'sop05_provenance', 'sop06_result_version', 'sop06_evidence_version', 'facts_eligibility'], qa_executor: 'qaListingSop07Contract' },
  LISTING_SOP_08: { executor_id: 'LISTING_COMPETITOR_EXECUTOR', required_inputs: ['CONFIRMED_PRODUCT_FACTS_VERSION', 'LISTING_SOP_03', 'LISTING_SOP_07'], required_dependencies: [], output_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION', output_fields: ['competitor_id', 'candidate_status', 'bol_url', 'ean', 'bol_product_id', 'current_price', 'rating', 'review_count', 'latest_review_or_activity', 'sales_evidence', 'same_category', 'same_use_case', 'price_band_fit', 'comparable_positioning', 'competitor_conditions.PASS|FAIL|UNKNOWN', 'classification', 'classification_reason', 'evidence_refs', 'checked_at', 'discovery_query'], constraints: { preferred_effective_count_min: 3, max_comparison_count: 5, supplement_when_usable_primary_pool_below: 3, supplement_source: 'SOP07 CORE_PRODUCT positive-volume exact strings in rank order', stop_when_usable_primary_pool_reaches: 3, low_count_behavior: 'LOW_COMPETITOR_POOL_CONFIDENCE', scores_or_weights: false, execution_phases: ['SOP08_LOCAL_CONVERGENCE', 'SOP08_REMOTE_SUPPLEMENT'] }, qa_executor: 'qaListingSop08Contract' },
  LISTING_SOP_09: { executor_id: 'LISTING_COMPETITOR_ANALYSIS_EXECUTOR', required_inputs: ['LISTING_SOP_08', 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION', 'AMAZON_EVIDENCE_BUNDLE_VERSION', 'CONFIRMED_PRODUCT_FACTS_VERSION'], required_dependencies: [], output_type: 'LISTING_COMPETITOR_ANALYSIS_VERSION', output_fields: ['input_versions', 'bol_competitor_analysis', 'amazon_reference_analysis', 'review_analysis', 'evidence_refs', 'source_completeness', 'source_conflicts', 'unavailable_fields', 'low_competitor_pool_confidence', 'analysis_confidence'], qa_executor: 'qaListingCompetitorAnalysis' },
  LISTING_SOP_10: { required_inputs: ['LISTING_SOP_09'], required_dependencies: ['AI_WORKER_POOL'], output_type: 'LISTING_BUYER_INSIGHTS_VERSION', qa_executor: 'qaListingSop10Contract' },
  LISTING_SOP_11: { required_inputs: ['LISTING_SOP_02', 'LISTING_SOP_09', 'LISTING_SOP_10'], required_dependencies: ['AI_WORKER_POOL'], output_type: 'LISTING_OWN_COMPETITOR_COMPARISON_VERSION', qa_executor: 'qaListingSop11Contract' },
  LISTING_SOP_12: { required_inputs: ['LISTING_SOP_07', 'LISTING_SOP_10', 'LISTING_SOP_11'], required_dependencies: ['AI_WORKER_POOL'], output_type: 'LISTING_SELLING_POINT_MATRIX_VERSION', qa_executor: 'qaListingSop12Contract' },
  LISTING_SOP_13: { required_inputs: ['LISTING_SOP_12'], required_dependencies: [], output_type: 'LISTING_DISPLAY_WEIGHTING_VERSION', qa_executor: 'qaListingSop13Contract' },
  LISTING_SOP_14: { required_inputs: ['LISTING_SOP_02', 'LISTING_SOP_12', 'LISTING_SOP_13'], required_dependencies: ['AI_WORKER_POOL'], output_type: 'LISTING_TITLE_VERSION', qa_executor: 'qaListingSop14Title' },
  LISTING_SOP_15: { required_inputs: ['LISTING_SOP_02', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14'], required_dependencies: ['AI_WORKER_POOL'], output_type: 'LISTING_ANCHORS_VERSION', qa_executor: 'qaListingSop15Anchors' },
  LISTING_SOP_16: { required_inputs: ['LISTING_SOP_02', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14', 'LISTING_SOP_15'], required_dependencies: ['AI_WORKER_POOL'], output_type: 'LISTING_DESCRIPTION_PACKAGE_ATTRIBUTES_VERSION', qa_executor: 'qaListingSop16Description' },
  LISTING_SOP_17: { required_inputs: ['LISTING_SOP_02', 'LISTING_SOP_07', 'LISTING_SOP_08', 'LISTING_SOP_09', 'LISTING_SOP_10', 'LISTING_SOP_11', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14', 'LISTING_SOP_15', 'LISTING_SOP_16'], required_dependencies: ['AI_SEMANTIC_QA_IF_CONFIGURED'], output_type: 'LISTING_FINAL_QA_REPORT', qa_executor: 'qaListingSop17Final' },
};

const RELEASE_GATES = [
  ['EXCEL_WRITE', 'LISTING_EXCEL_WRITE', ['LISTING_SOP_17'], 'LISTING_EXCEL_FILE'],
  ['EXCEL_READBACK_QA', 'LISTING_EXCEL_READBACK_QA', ['EXCEL_WRITE'], 'LISTING_EXCEL_QA_REPORT'],
  ['AWAIT_UPLOAD', 'AWAIT_UPLOAD', ['LISTING_SOP_17', 'EXCEL_READBACK_QA'], 'LISTING_AWAIT_UPLOAD_RECORD'],
  ['UPLOAD_INTEGRATION', 'UPLOAD_INTEGRATION', ['LISTING_SOP_17', 'EXCEL_READBACK_QA', 'ARTWORK_FINAL_IF_REQUIRED'], 'LISTING_UPLOAD_INTEGRATION_REPORT'],
  ['FINAL_ARCHIVE', 'FINAL_ARCHIVE', ['UPLOAD_INTEGRATION'], 'LISTING_FINAL_ARCHIVE'],
];

const OUTPUT_KEYS = {
  LISTING_SOP_03: ['keyword_source_discovery', 'competitor_discovery'], LISTING_SOP_04: ['bol_keywords'],
  LISTING_SOP_05: ['keyword_candidate_pool'], LISTING_SOP_06: ['boloo_keywords'], LISTING_SOP_07: ['top20'],
  LISTING_SOP_08: ['listing_competitor_pool', 'competitors'], LISTING_SOP_09: ['competitor_analysis'],
  LISTING_SOP_10: ['buyer_insights'], LISTING_SOP_11: ['own_competitor_comparison'], LISTING_SOP_12: ['selling_matrix'],
  LISTING_SOP_13: ['display_weighting'], LISTING_SOP_14: ['title'], LISTING_SOP_15: ['anchors'],
  LISTING_SOP_16: ['description'], LISTING_SOP_17: ['final_qa', 'qa'],
};

export function createListingExecutorFramework(steps, now = new Date().toISOString()) {
  const registry = {};
  for (const step of steps.filter(item => /^LISTING_SOP_(0[3-9]|1[0-7])$/.test(item.id))) {
    const contract = CONTRACTS[step.id] || {};
    registry[step.id] = {
      sop_step_id: step.id, sop_step_name: step.label, executor_id: contract.executor_id || step.executor,
      required_inputs: [...(contract.required_inputs || [])], input_version_refs: [], required_dependencies: [...(contract.required_dependencies || [])],
      output_fields: [...(contract.output_fields || [])], constraints: structuredClone(contract.constraints || (contract.cardinality ? { cardinality: contract.cardinality } : {})),
      output_type: contract.output_type || `${step.id}_OUTPUT`, output_version: null, evidence_refs: [],
      qa_executor: contract.qa_executor || `qa${step.id}`, qa_status: 'NOT_RUN', status: 'NOT_STARTED', waiting_reason: null,
      resume_point: step.id, last_success_step: null, stale_reason: null, started_at: null, completed_at: null,
    };
  }
  return {
    schema_version: 1, registry_version: 'SOP03-17-OFFLINE-FRAMEWORK-1', registry,
    artifacts: { keyword_sources: [], keyword_candidates: [], competitor_candidates: [], formal_competitors: [], comparison_results: [], selling_point_matrices: [], listing_outputs: {} },
    waiting_items: [], release_gates: Object.fromEntries(RELEASE_GATES.map(([id, name, inputs, output]) => [id, { gate_id: id, gate_name: name, required_inputs: [...inputs], output_type: output, status: 'NOT_STARTED', qa_status: 'NOT_RUN', evidence_refs: [], output_version: null, waiting_reason: null, ...(id === 'UPLOAD_INTEGRATION' ? { configurable_requirements: { artwork_required: null, mabang_required: null } } : {}), updated_at: now }])),
    final_archive_ref: null,
  };
}

export function syncListingExecutorFramework(task, steps, now = new Date().toISOString()) {
  task.listing_executor ||= createListingExecutorFramework(steps, now);
  const framework = task.listing_executor;
  framework.registry ||= {};
  framework.artifacts ||= { keyword_sources: [], keyword_candidates: [], competitor_candidates: [], formal_competitors: [], comparison_results: [], selling_point_matrices: [], listing_outputs: {} };
  framework.artifacts.listing_outputs ||= {};
  const defaults = createListingExecutorFramework(steps, now).registry;
  for (const [id, base] of Object.entries(defaults)) {
    const entry = framework.registry[id] ||= structuredClone(base);
    const stage = task.stages?.[id];
    const qa = task.qa?.[id];
    if (stage?.status && LISTING_EXECUTOR_STATUS_VALUES.includes(stage.status)) entry.status = stage.status;
    if (qa?.status === 'PASS') { entry.qa_status = 'PASS'; entry.status = 'PASS'; }
    else if (qa?.status === 'FAIL') { entry.qa_status = 'FAIL'; entry.status = 'QA_FAIL'; }
    entry.sop_step_id = id;
    entry.sop_step_name ||= base.sop_step_name;
    entry.executor_id = ['LISTING_SOP_05', 'LISTING_SOP_08', 'LISTING_SOP_09'].includes(id) ? base.executor_id : (entry.executor_id || base.executor_id);
    entry.required_inputs = ['LISTING_SOP_07', 'LISTING_SOP_08'].includes(id) ? [...base.required_inputs] : (entry.required_inputs || [...base.required_inputs]);
    entry.input_version_refs ||= [];
    entry.required_dependencies = ['LISTING_SOP_07', 'LISTING_SOP_08', 'LISTING_SOP_09'].includes(id) ? [...base.required_dependencies] : (entry.required_dependencies || [...base.required_dependencies]);
    entry.required_inputs = ['LISTING_SOP_05', 'LISTING_SOP_09'].includes(id) ? [...base.required_inputs] : (entry.required_inputs || [...base.required_inputs]);
    entry.output_fields = ['LISTING_SOP_05', 'LISTING_SOP_07', 'LISTING_SOP_08', 'LISTING_SOP_09'].includes(id) ? [...base.output_fields] : (entry.output_fields || [...base.output_fields]);
    entry.output_type = ['LISTING_SOP_05', 'LISTING_SOP_07', 'LISTING_SOP_08', 'LISTING_SOP_09'].includes(id) ? base.output_type : (entry.output_type || base.output_type);
    if (id === 'LISTING_SOP_09') { entry.executor_id = base.executor_id; entry.qa_executor = base.qa_executor; }
    entry.evidence_refs ||= [];
    entry.qa_executor ||= base.qa_executor;
    const output = (OUTPUT_KEYS[id] || []).map(key => task.outputs?.[key]).find(Boolean);
    if (output) {
      const evidence = output.evidence || {};
      entry.output_version = evidence.version ?? evidence.output_version ?? evidence.artifact_version ?? entry.output_version;
      entry.evidence_refs = uniqueStrings([...(entry.evidence_refs || []), ...(Array.isArray(evidence.evidence_refs) ? evidence.evidence_refs : []), ...(Array.isArray(evidence.source_references) ? evidence.source_references.map(item => item.source_reference).filter(Boolean) : [])]);
      if (output.stale) { entry.status = 'STALE'; entry.stale_reason = output.stale_reason || 'INPUT_VERSION_CHANGED'; }
    }
    entry.qa_status = qa?.status === 'PASS' ? 'PASS' : qa?.status === 'FAIL' ? 'FAIL' : entry.qa_status || 'NOT_RUN';
    entry.waiting_reason = qa?.status === 'PASS' ? null : stage?.waiting_reason || stage?.reason || stage?.dependency || entry.waiting_reason || null;
    entry.resume_point = task.resume_point || entry.resume_point || id;
    entry.last_success_step = task.last_success_step || entry.last_success_step || null;
    entry.stale_reason ||= stage?.stale_reason || null;
    entry.started_at ||= stage?.started_at || null;
    entry.completed_at ||= stage?.completed_at || qa?.checked_at || null;
  }
  framework.release_gates ||= Object.fromEntries(RELEASE_GATES.map(([id, name, inputs, output]) => [id, { gate_id: id, gate_name: name, required_inputs: [...inputs], output_type: output, status: 'NOT_STARTED', qa_status: 'NOT_RUN', evidence_refs: [], output_version: null, waiting_reason: null, ...(id === 'UPLOAD_INTEGRATION' ? { configurable_requirements: { artwork_required: null, mabang_required: null } } : {}), updated_at: now }]));
  framework.waiting_items ||= [];
  task.listing_sop ||= {};
  task.listing_sop.executor_registry = { schema_version: framework.schema_version, registry_version: framework.registry_version, steps: framework.registry };
  return framework;
}

function uniqueStrings(values) { return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))]; }

export function updateListingExecutorStep(task, stepId, patch, now = new Date().toISOString()) {
  const entry = task.listing_executor?.registry?.[stepId];
  if (!entry) throw Object.assign(new Error(`未知 Listing SOP Executor 步骤：${stepId}`), { code: 'LISTING_EXECUTOR_STEP_UNKNOWN' });
  const status = String(patch.status || entry.status);
  if (!STATUS_SET.has(status)) throw Object.assign(new Error(`非法 Executor 状态：${status}`), { code: 'LISTING_EXECUTOR_STATUS_INVALID' });
  if (status === 'PASS' && (patch.qa?.status !== 'PASS' || !patch.output?.evidence || typeof patch.output.evidence !== 'object')) {
    throw Object.assign(new Error('只有产物证据存在且 Stage QA=PASS 才能登记 PASS。'), { code: 'LISTING_EXECUTOR_PASS_GATE_BLOCKED' });
  }
  if (status === 'PASS' && Number(task.open_error_count || 0) > 0) throw Object.assign(new Error('存在未关闭异常，当前 Stage 不允许 PASS。'), { code: 'LISTING_EXECUTOR_OPEN_ERROR_BLOCKED' });
  if (status === 'PASS') {
    const requiredStageInputs = entry.required_inputs.filter(value => /^LISTING_SOP_\d{2}$/.test(value));
    if (entry.required_inputs.includes('CONFIRMED_PRODUCT_FACTS_VERSION')) requiredStageInputs.push('LISTING_SOP_02');
    const unmet = [...new Set(requiredStageInputs)].filter(inputId => {
      if (inputId === 'LISTING_SOP_02') return task.qa?.[inputId]?.status !== 'PASS' || task.outputs?.confirmed_product_facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION';
      const source = task.listing_executor?.registry?.[inputId];
      return source?.status !== 'PASS' || source?.qa_status !== 'PASS';
    });
    if (unmet.length) throw Object.assign(new Error(`上游 SOP Stage 尚未 QA PASS：${unmet.join(', ')}`), { code: 'LISTING_EXECUTOR_DEPENDENCY_BLOCKED', missing_steps: unmet });
    if (stepId === 'LISTING_SOP_07') {
      const subtasks = task.boloo?.required_subtasks || [];
      const unfinished = subtasks.filter(item => !['PASS', 'PASS_NO_RESULT'].includes(item.status));
      const sop05 = task.listing_executor?.registry?.LISTING_SOP_05;
      const sop06 = task.listing_executor?.registry?.LISTING_SOP_06;
      const sealedDiscovery = sop05?.status === 'PASS' && sop05?.qa_status === 'PASS'
        && sop06?.status === 'PASS' && sop06?.qa_status === 'PASS'
        && Boolean(sop05?.output_version) && Boolean(sop06?.output_version);
      if ((!sealedDiscovery && task.boloo?.keyword_discovery_closed !== true) || unfinished.length) {
        throw Object.assign(new Error('TOP20只能在正式SOP05候选池与SOP06全部查询封板，或显式keyword discovery关闭，且无未完成必需子任务后通过。'), {
          code: 'LISTING_TOP20_DISCOVERY_GATE_BLOCKED', unfinished_subtask_ids: unfinished.map(item => item.subtask_id), sealed_discovery: sealedDiscovery,
        });
      }
    }
  }
  if (status === 'DONE_PENDING_QA' && (!patch.output || !patch.output.evidence)) throw Object.assign(new Error('DONE_PENDING_QA 必须有产物和证据，但不得视为 PASS。'), { code: 'LISTING_EXECUTOR_OUTPUT_REQUIRED' });
  if (['WAITING_DEPENDENCY', 'WAITING_CONFIRMATION', 'WAITING_DECISION', 'ERROR', 'QA_FAIL'].includes(status) && !String(patch.waiting_reason || patch.reason || patch.qa?.reason || '').trim()) {
    throw Object.assign(new Error(`${status} 必须记录原因。`), { code: 'LISTING_EXECUTOR_REASON_REQUIRED' });
  }
  const previous = { ...entry };
  const priorOutputVersion = entry.output_version;
  Object.assign(entry, {
    status, qa_status: patch.qa?.status || (status === 'PASS' ? 'PASS' : status === 'QA_FAIL' ? 'FAIL' : status === 'RUNNING' ? 'NOT_RUN' : entry.qa_status),
    waiting_reason: patch.waiting_reason || patch.reason || (status === 'PASS' ? null : entry.waiting_reason),
    input_version_refs: patch.input_version_refs ? structuredClone(patch.input_version_refs) : entry.input_version_refs,
    resume_point: patch.resume_point || stepId, started_at: status === 'RUNNING' ? now : entry.started_at || null,
    completed_at: status === 'RUNNING' ? null : ['DONE_PENDING_QA', 'PASS', 'QA_FAIL'].includes(status) ? now : entry.completed_at,
    stale_reason: status === 'STALE' ? patch.stale_reason || entry.stale_reason : null,
  });
  if (patch.output) {
    entry.output_version = patch.output.version ?? patch.output.evidence?.version ?? patch.output.evidence?.output_version ?? entry.output_version;
    entry.evidence_refs = uniqueStrings([...(entry.evidence_refs || []), ...(patch.output.evidence.evidence_refs || [])]);
    task.listing_executor.artifacts.listing_outputs[stepId] = structuredClone(patch.output);
    if (priorOutputVersion != null && entry.output_version != null && String(priorOutputVersion) !== String(entry.output_version)) {
      propagateListingStale(task, stepId, 'UPSTREAM_OUTPUT_VERSION_CHANGED', now);
    }
  }
  task.stages ||= {}; task.qa ||= {}; task.listing_sop ||= { steps: {} };
  task.stages[stepId] = { ...(task.stages[stepId] || {}), label: entry.sop_step_name, status, waiting_reason: entry.waiting_reason, stale_reason: entry.stale_reason, started_at: entry.started_at, completed_at: entry.completed_at, updated_at: now };
  task.qa[stepId] = { ...(task.qa[stepId] || {}), status: entry.qa_status, checked_at: patch.qa?.checked_at || (status === 'PASS' || status === 'QA_FAIL' ? now : null), report: patch.qa?.report || null };
  task.listing_sop.steps ||= {};
  task.listing_sop.steps[stepId] = { ...(task.listing_sop.steps[stepId] || {}), label: entry.sop_step_name, status, qa_status: entry.qa_status, output_version: entry.output_version, waiting_reason: entry.waiting_reason, stale_reason: entry.stale_reason, updated_at: now };
  task.current_step = stepId;
  task.listing_sop.current_step_id = stepId;
  task.resume_point = entry.resume_point;
  task.activity_pool = stepId <= 'LISTING_SOP_07' ? '关键词池' : stepId === 'LISTING_SOP_17' ? 'QA 池' : 'Listing 生成池';
  task.current_pool = task.activity_pool;
  if (status === 'PASS') { task.last_success_step = stepId; task.error_code = null; task.error_message = null; }
  else if (status === 'WAITING_CONFIRMATION' || status === 'WAITING_DECISION') { task.error_code = null; task.error_message = null; task.status = status; }
  else if (status === 'WAITING_DEPENDENCY') { task.error_code = null; task.error_message = null; task.status = status; }
  else if (status === 'PAUSED') task.status = 'PAUSED';
  else if (status === 'QA_FAIL' || status === 'ERROR') task.status = 'ERROR';
  else if (status === 'RUNNING') task.status = 'RUNNING';
  else if (status === 'QUEUED') task.status = 'QUEUED';
  else if (status === 'STALE') task.status = 'STALE';
  else if (status === 'DONE_PENDING_QA') task.status = 'DONE_PENDING_QA';
  return { task, previous, step: entry, can_advance: status === 'PASS' && entry.qa_status === 'PASS' && Number(task.open_error_count || 0) === 0 };
}

export function createListingWaitingItem(task, item, now = new Date().toISOString()) {
  if (!['WAITING_CONFIRMATION', 'WAITING_DECISION'].includes(item.type)) throw Object.assign(new Error('待处理事项类型无效。'), { code: 'LISTING_WAITING_TYPE_INVALID' });
  if (!item.originating_sop_step || !item.reason) throw Object.assign(new Error('待处理事项必须有来源步骤和原因。'), { code: 'LISTING_WAITING_FIELDS_REQUIRED' });
  task.listing_executor ||= { waiting_items: [], registry: {}, artifacts: { listing_outputs: {} } };
  task.listing_executor.waiting_items ||= [];
  const record = {
    waiting_id: item.waiting_id || crypto.randomUUID(), sku: task.sku,
    originating_sop_step: item.originating_sop_step, type: item.type,
    current_value: item.current_value ?? null, proposed_value_or_action: item.proposed_value_or_action ?? null,
    reason: String(item.reason), evidence: structuredClone(item.evidence || []),
    affected_downstream_modules: uniqueStrings(item.affected_downstream_modules || []),
    status: item.type, created_at: now, decision: null, decided_at: null,
  };
  task.listing_executor.waiting_items.push(record);
  task.current_step = record.originating_sop_step;
  task.resume_point = record.originating_sop_step;
  task.status = record.type;
  task.error_code = null; task.error_message = null;
  return record;
}

export function resolveListingWaitingItem(task, waitingId, decision, now = new Date().toISOString()) {
  const item = task.listing_executor?.waiting_items?.find(row => row.waiting_id === waitingId && !row.decided_at);
  if (!item) throw Object.assign(new Error('找不到开放的 Listing 待处理事项。'), { code: 'LISTING_WAITING_ITEM_NOT_FOUND' });
  if (!String(decision || '').trim()) throw Object.assign(new Error('必须记录明确决定。'), { code: 'LISTING_WAITING_DECISION_REQUIRED' });
  item.decision = String(decision); item.decided_at = now; item.status = 'RESOLVED';
  return item;
}

function descendantsOf(node) {
  const found = new Set(); const queue = [...(LISTING_ARTIFACT_DEPENDENCY_DAG[node] || [])];
  while (queue.length) { const current = queue.shift(); if (found.has(current)) continue; found.add(current); queue.push(...(LISTING_ARTIFACT_DEPENDENCY_DAG[current] || [])); }
  return found;
}

export function propagateListingStale(task, changedNode, reason, now = new Date().toISOString(), { recordHistory = true } = {}) {
  if (task.final_archive || task.final_archive_ref) return [];
  const affected = descendantsOf(changedNode);
  const marked = [];
  for (const stepId of affected) {
    if (!/^LISTING_SOP_/.test(stepId)) {
      const gate = task.listing_executor?.release_gates?.[stepId];
      if (gate && (gate.output_version != null || gate.status === 'PASS' || gate.status === 'DONE_PENDING_QA')) {
        gate.previous_status = gate.status;
        gate.status = 'STALE'; gate.qa_status = 'NOT_RUN'; gate.waiting_reason = reason; gate.stale_at = now; gate.updated_at = now;
        marked.push(stepId);
      }
      continue;
    }
    const entry = task.listing_executor?.registry?.[stepId];
    const output = task.listing_executor?.artifacts?.listing_outputs?.[stepId];
    const stored = output || (OUTPUT_KEYS[stepId] || []).map(key => task.outputs?.[key]).find(Boolean);
    if (!entry || !stored) continue;
    stored.stale = true; stored.stale_reason = reason; stored.stale_at = now;
    entry.status = 'STALE'; entry.stale_reason = reason; entry.qa_status = 'NOT_RUN';
    if (task.qa?.[stepId]?.status === 'PASS') task.qa[stepId] = { ...task.qa[stepId], previous_status: 'PASS', status: 'NOT_RUN', stale: true, stale_reason: reason, stale_at: now };
    if (task.stages?.[stepId]) task.stages[stepId] = { ...task.stages[stepId], status: 'STALE', stale_reason: reason, updated_at: now };
    if (task.listing_sop?.steps?.[stepId]) task.listing_sop.steps[stepId] = { ...task.listing_sop.steps[stepId], status: 'STALE', qa_status: 'NOT_RUN', stale_reason: reason, updated_at: now };
    marked.push(stepId);
  }
  task.listing_sop ||= {};
  task.listing_sop.stale_dependencies ||= [];
  if (recordHistory && marked.length) task.listing_sop.stale_dependencies.push({ changed_node: changedNode, affected_steps: marked, reason, at: now });
  return marked;
}

export function recordReleaseGate(task, gateId, patch, now = new Date().toISOString()) {
  const gate = task.listing_executor?.release_gates?.[gateId];
  if (!gate) throw Object.assign(new Error(`未知 Release Gate：${gateId}`), { code: 'LISTING_RELEASE_GATE_UNKNOWN' });
  if (!STATUS_SET.has(patch.status)) throw Object.assign(new Error('Release Gate 状态无效。'), { code: 'LISTING_RELEASE_GATE_STATUS_INVALID' });
  if (patch.status === 'PASS') {
    if (patch.qa_status !== 'PASS' || !patch.evidence_refs?.length || Number(task.open_error_count || 0) !== 0) {
      throw Object.assign(new Error('Release Gate PASS 必须有 QA PASS、证据引用且 OPEN_ERROR_COUNT=0。'), { code: 'LISTING_RELEASE_GATE_PASS_BLOCKED' });
    }
    const release = task.listing_executor.release_gates || {};
    const registry = task.listing_executor.registry || {};
    const inputPass = (inputId) => {
      if (inputId === 'ARTWORK_FINAL_IF_REQUIRED') {
        const req = release.UPLOAD_INTEGRATION?.configurable_requirements?.artwork_required;
        return req === false || (req === true && task.sidecars?.artwork?.status === 'FINAL');
      }
      const candidate = registry[inputId] || release[inputId];
      return candidate?.status === 'PASS' && candidate?.qa_status === 'PASS';
    };
    const missing = (gate.required_inputs || []).filter(inputId => !inputPass(inputId));
    if (missing.length) throw Object.assign(new Error(`Release Gate 缺少已核验输入：${missing.join(', ')}`), { code: 'LISTING_RELEASE_GATE_INPUTS_BLOCKED', missing_inputs: missing });
  }
  Object.assign(gate, structuredClone(patch), { updated_at: now });
  if (gateId === 'FINAL_ARCHIVE' && patch.status === 'PASS') task.listing_executor.final_archive_ref = patch.output_version || patch.evidence_refs[0];
  return gate;
}

const qaResult = (checks) => {
  const failures = checks.filter(item => !item.pass).map(({ code, message }) => ({ code, message }));
  return { status: failures.length ? 'QA_FAIL' : 'PASS', checked_at: new Date().toISOString(), checks: checks.map(({ code, message, pass }) => ({ code, message, pass })), failures };
};
function factValue(facts, key) {
  const item = facts?.fields?.[key] || facts?.[key];
  if (item?.status && item.status !== 'CONFIRMED') return null;
  return item && Object.hasOwn(item, 'value') ? item.value : item ?? null;
}

export function qaListingSop14Title(output, facts) {
  const title = String(output?.title_nl || output?.text_nl || '');
  const brand = String(factValue(facts, 'brand_name') || '');
  const ean = String(factValue(facts, 'ean') || '');
  const factsVersion = facts?.version ?? facts?.product_master_version ?? facts?.evidence?.product_master_version;
  return qaResult([
    { code: 'TITLE_DUTCH_FIELD', message: '荷兰语标题字段存在且语言标记为 nl-NL。', pass: Boolean(title.trim()) && (output?.language === 'nl-NL' || output?.language === 'nl') },
    { code: 'TITLE_LENGTH_230_260', message: '标题字符数在 230–260。', pass: title.length >= 230 && title.length <= 260 },
    { code: 'TITLE_BRAND_CONFIRMED', message: '品牌来自确认事实且出现在标题中。', pass: Boolean(brand) && title.includes(brand) && output?.source_fact_version != null },
    { code: 'TITLE_EAN_EXCLUDED', message: 'EAN 未写入标题。', pass: !ean || !title.includes(ean) },
    { code: 'TITLE_FACT_VERSION', message: '标题引用确认事实版本。', pass: Number(output?.source_fact_version) === Number(factsVersion) },
  ]);
}

const allowedEvidence = (output, inputRefs) => {
  const valid = new Set(Array.isArray(inputRefs) ? inputRefs : []);
  const refs = Array.isArray(output?.evidence_refs) ? output.evidence_refs : [];
  return refs.length > 0 && refs.every(ref => valid.has(ref));
};
const hasNoForbiddenScores = value => {
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(hasNoForbiddenScores);
  const banned = new Set(['volume_score', 'relevance_score', 'final_keyword_score', 'final_score', 'numeric_relevance_score', 'log_normalization', 'weight_formula', 'volume_weight', 'relevance_weight']);
  return Object.entries(value).every(([key, item]) => {
    const normalized = key.toLowerCase();
    const scoreField = /(^|_)score($|_)/.test(normalized) || (/weight/.test(normalized) && typeof item === 'number');
    return !banned.has(normalized) && !scoreField && hasNoForbiddenScores(item);
  });
};

export function qaListingSop10Contract(output, { evidence_refs = [], sop08_context = {}, inputs = {} } = {}) {
  const arrays = ['observed_selling_points', 'pain_points', 'buying_reasons', 'why_competitor_appears_to_sell'];
  const rows = arrays.flatMap(key => Array.isArray(output?.[key]) ? output[key] : []);
  const amazon = (inputs?.LISTING_SOP_09 || inputs?.inputs?.LISTING_SOP_09)?.amazon_reference_analysis;
  const inlineReviews = amazon?.inline_reviews;
  const observedInlineReviews = Array.isArray(inlineReviews) ? inlineReviews.length
    : Array.isArray(inlineReviews?.items) ? inlineReviews.items.length
      : Number(inlineReviews?.sample_count) || 0;
  const sourceReviewScope = inlineReviews?.review_scope || amazon?.review_analysis?.amazon_scope || null;
  const sourceReviewStatus = inlineReviews?.status || amazon?.review_analysis?.status || null;
  const reviewAnalysis = output?.review_analysis;
  const isNoReviews = sourceReviewStatus === 'NO_REVIEWS' || amazon?.bol_reviews_status === 'NO_REVIEWS';
  let reviewScopePass = true;
  if (!amazon) reviewScopePass = !reviewAnalysis || ['UNKNOWN', 'NOT_APPLICABLE', 'NO_SOURCE'].includes(reviewAnalysis.review_scope);
  else if (isNoReviews) reviewScopePass = !reviewAnalysis || ['NO_REVIEWS', 'NOT_APPLICABLE'].includes(reviewAnalysis.review_scope);
  else if (observedInlineReviews > 0 && ['INLINE_SAMPLE', 'INLINE_SAMPLE_ONLY', 'AVAILABLE_PARTIAL'].includes(sourceReviewScope)) {
    reviewScopePass = reviewAnalysis?.review_scope === 'INLINE_SAMPLE_ONLY'
      && reviewAnalysis.frequency_scope === 'WITHIN_OBSERVED_SAMPLE'
      && reviewAnalysis.rating_count_is_review_count !== true;
    if (inlineReviews?.pagination_status || amazon?.review_analysis?.pagination_status) {
      reviewScopePass &&= reviewAnalysis?.pagination_status === (inlineReviews?.pagination_status || amazon.review_analysis.pagination_status);
    }
  } else if (sourceReviewScope) {
    reviewScopePass = !reviewAnalysis || reviewAnalysis.review_scope === sourceReviewScope;
  }
  return qaResult([
    { code: 'SOP10_OUTPUT_SHAPE', message: 'SOP10四类结构化分析字段均存在。', pass: arrays.every(key => Array.isArray(output?.[key])) },
    { code: 'SOP10_EVIDENCE_LINKS', message: 'SOP10每条观察均可追溯到输入证据。', pass: rows.every(row => Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0 && row.evidence_refs.every(ref => evidence_refs.includes(ref))) && allowedEvidence(output, evidence_refs) },
    { code: 'SOP10_LOW_POOL_CONFIDENCE', message: 'SOP08低置信状态完整继承。', pass: output?.low_competitor_pool_confidence === (sop08_context?.low_competitor_pool_confidence === true) },
    { code: 'SOP10_REVIEW_SCOPE', message: '评论范围按当前SKU来源状态保持，不扩大样本或全集声明。', pass: reviewScopePass },
  ]);
}

export function qaListingSop11Contract(output, { evidence_refs = [], sop08_context = {} } = {}) {
  const rows = Array.isArray(output?.comparisons) ? output.comparisons : [];
  const allowed = new Set(['ADVANTAGE', 'EQUAL', 'DISADVANTAGE', 'UNKNOWN']);
  return qaResult([
    { code: 'SOP11_OUTPUT_SHAPE', message: 'SOP11包含结构化优势/持平/劣势/未知比较项。', pass: rows.length > 0 && rows.every(row => allowed.has(row.relation)) },
    { code: 'SOP11_EVIDENCE_LINKS', message: 'SOP11每项结论均引用输入证据。', pass: rows.every(row => Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0 && row.evidence_refs.every(ref => evidence_refs.includes(ref))) && allowedEvidence(output, evidence_refs) },
    { code: 'SOP11_B_REFERENCE_LIMIT', message: '单个B级竞品未被当作A级强竞品。', pass: sop08_context?.low_competitor_pool_confidence !== true || rows.every(row => row.competitor_level !== 'A_STRONG_EFFECTIVE' && (row.relation !== 'DISADVANTAGE' || row.comparison_scope === 'REFERENCE_ONLY')) },
    { code: 'SOP11_FACT_SCOPE', message: '比较项声明了自有事实版本及竞品来源级别。', pass: Boolean(output?.facts_version) && Boolean(output?.competitor_pool_version) },
  ]);
}

export function qaListingSop12Contract(output, { evidence_refs = [], sop08_context = {} } = {}) {
  const rows = Array.isArray(output?.matrix_items) ? output.matrix_items : [];
  return qaResult([
    { code: 'SOP12_OUTPUT_SHAPE', message: '竞争卖点矩阵包含至少一个结构化矩阵项。', pass: rows.length > 0 && rows.every(row => typeof row.matrix_item_id === 'string' && typeof row.buyer_value === 'string') },
    { code: 'SOP12_EVIDENCE_LINKS', message: '矩阵项引用关键词、事实或竞品证据。', pass: rows.every(row => Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0 && row.evidence_refs.every(ref => evidence_refs.includes(ref))) && allowedEvidence(output, evidence_refs) },
    { code: 'SOP12_LOW_POOL_CONFIDENCE', message: '矩阵继承单个B级竞品及低池置信限制。', pass: output?.low_competitor_pool_confidence === (sop08_context?.low_competitor_pool_confidence === true) && (sop08_context?.low_competitor_pool_confidence !== true || output?.competitor_influence_ceiling === 'B_REFERENCE_LIMITED') },
    { code: 'SOP12_NO_SCORES', message: '矩阵没有加入被废弃的评分字段或数值权重。', pass: hasNoForbiddenScores(output) },
  ]);
}

export function qaListingSop13Contract(output, { evidence_refs = [], sop08_context = {} } = {}) {
  const rows = Array.isArray(output?.display_decisions) ? output.display_decisions : [];
  const allowed = new Set(['UPWEIGHT', 'KEEP', 'DOWNWEIGHT']);
  return qaResult([
    { code: 'SOP13_OUTPUT_SHAPE', message: 'SOP13对矩阵项目给出升权、保持或降权决定。', pass: rows.length > 0 && rows.every(row => allowed.has(row.decision) && typeof row.target_ref === 'string') },
    { code: 'SOP13_EVIDENCE_LINKS', message: '每项展示权重决定均有SOP证据引用。', pass: rows.every(row => Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0 && row.evidence_refs.every(ref => evidence_refs.includes(ref))) && allowedEvidence(output, evidence_refs) },
    { code: 'SOP13_B_REFERENCE_LIMIT', message: '单个B_REFERENCE没有单独触发降权。', pass: sop08_context?.low_competitor_pool_confidence !== true || rows.every(row => row.decision !== 'DOWNWEIGHT' || row.downweight_basis !== 'SINGLE_B_REFERENCE') },
    { code: 'SOP13_NO_MATH', message: 'SOP13未使用数值评分、60/40或log normalization。', pass: hasNoForbiddenScores(output) && !Object.hasOwn(output || {}, 'weight_formula') },
  ]);
}

export function qaListingSop15Anchors(output) {
  const anchors = output?.anchors;
  const rows = Array.isArray(anchors) ? anchors : [];
  const ids = rows.map(item => item?.anchor_id).filter(Boolean);
  return qaResult([
    { code:'ANCHORS_BUYER_COPY_ONLY',message:'买家锚点不包含检索词管理或证据审核说明。',pass:rows.every(r=>![r.title_nl,r.title_zh,r.text_nl,r.text_zh,...(r.phrases_nl||[]),...(r.phrases_zh||[])].some(v=>/UNKNOWN|zoektermen|schrijfwijzen|taalgebruik|afzonderlijk.*behoud|检索词|连写|分写|组合词序|核心产品词|惯用表达/.test(String(v||'')))) },
    { code: 'ANCHORS_COUNT_5', message: '信息锚点正好 5 个。', pass: rows.length === 5 },
    { code: 'ANCHORS_UNIQUE_IDS', message: '每个锚点均有独立 ID。', pass: ids.length === 5 && new Set(ids).size === 5 },
    { code: 'ANCHORS_DUTCH_AND_CHINESE', message: '每个锚点同时具有荷兰语和中文对照。', pass: rows.length === 5 && rows.every(item => String(item.text_nl || '').trim() && (item.text_zh != null)) },
    { code: 'ANCHORS_TITLES_AND_MATCHED_PHRASES', message:'每个锚点独立中荷标题及4–5个逐项对应短语。', pass: rows.length===5 && rows.every(r=>r.title_nl && r.title_zh && Array.isArray(r.phrases_nl) && Array.isArray(r.phrases_zh) && r.phrases_nl.length>=4 && r.phrases_nl.length<=5 && r.phrases_nl.length===r.phrases_zh.length && [...r.phrases_nl,...r.phrases_zh].every(v=>typeof v==='string'&&v.trim())) },
    { code: 'ANCHORS_SOURCE_REFS', message: '每个锚点引用事实或卖点来源。', pass: rows.length === 5 && rows.every(item => Array.isArray(item.source_fact_refs) && item.source_fact_refs.length > 0) },
  ]);
}

export function qaListingSop16Description(output, facts) {
  const description = String(output?.description_nl || '');
  const packageContents = output?.package_contents_nl;
  const attributes = output?.product_attributes;
  const factsVersion = facts?.version ?? facts?.product_master_version ?? facts?.evidence?.product_master_version;
  return qaResult([
    { code:'DESCRIPTION_BUYER_COPY_ONLY',message:'买家描述与属性不包含UNKNOWN或内部关键词管理说明。',pass:! /UNKNOWN|zoektermen|schrijfwijzen|taalgebruik|检索词|连写|分写/.test([description,output?.description_zh,JSON.stringify(attributes||{}),JSON.stringify(output?.product_attributes_zh||{})].join(' ')) },
    { code: 'DESCRIPTION_DUTCH_FIELD', message: '荷兰语描述存在且语言标记为 nl-NL。', pass: Boolean(description.trim()) && (output?.language === 'nl-NL' || output?.language === 'nl') },
    { code: 'DESCRIPTION_LENGTH_2500_2800', message: '荷兰语描述字符数在 2500–2800。', pass: description.length >= 2500 && description.length <= 2800 },
    { code: 'DESCRIPTION_PACKAGE_ATTRIBUTES_SECTIONS', message:'完整描述包含包装和属性末尾区，字符数包括这些区。', pass:/Inhoud pakket/i.test(description) && /Productspecificaties/i.test(description) && /包装内容/.test(String(output?.description_zh||'')) && /商品属性/.test(String(output?.description_zh||'')) },
    { code: 'DESCRIPTION_CHINESE_REFERENCE', message: '中文对照已提供。', pass: output?.description_zh != null && String(output.description_zh).trim().length > 0 },
    { code: 'PACKAGE_CONTENTS_PRESENT', message: '包装内容字段已提供。', pass: Array.isArray(packageContents) ? packageContents.length > 0 : Boolean(String(packageContents || '').trim()) },
    { code: 'PRODUCT_ATTRIBUTES_PRESENT', message: '商品属性字段已提供。', pass: attributes && typeof attributes === 'object' && Object.keys(attributes).length > 0 },
    { code: 'DESCRIPTION_FACT_VERSION', message: '描述引用当前确认事实版本。', pass: Number(output?.source_fact_version) === Number(factsVersion) },
    { code: 'DESCRIPTION_KEYWORD_LAYOUT_REFS', message: '描述保留关键词布局引用。', pass: Array.isArray(output?.keyword_layout_refs) },
  ]);
}

export function qaListingSop17Final(task, semanticQa = null) {
  const listing = task?.listing_executor;
  const steps = listing?.registry || {};
  const needed = ['LISTING_SOP_02', 'LISTING_SOP_07', 'LISTING_SOP_08', 'LISTING_SOP_09', 'LISTING_SOP_10', 'LISTING_SOP_11', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14', 'LISTING_SOP_15', 'LISTING_SOP_16'];
  const facts = task?.outputs?.confirmed_product_facts;
  const title = task?.outputs?.title;
  const anchors = task?.outputs?.anchors;
  const description = task?.outputs?.description;
  const factVersion = facts?.version;
  const factVersionMatches = output => Number(output?.source_fact_version ?? output?.facts_version) === Number(factVersion);
  const brandValue = facts?.fields?.brand_name?.value ?? facts?.fields?.brand_name ?? facts?.brand_name?.value ?? facts?.brand_name;
  const brandConfirmed = facts?.fields?.brand_name?.status === 'CONFIRMED' || facts?.brand_name?.status === 'CONFIRMED';
  const packageContents = description?.package_contents_nl;
  const productAttributes = description?.product_attributes;
  const observedChecklist = {
    facts_consistency: factVersion != null && factVersionMatches(title) && factVersionMatches(description),
    brand_consistency: brandConfirmed && Boolean(brandValue) && String(title?.title_nl || '').includes(String(brandValue)),
    package_contents: Array.isArray(packageContents) ? packageContents.length > 0 : Boolean(String(packageContents || '').trim()),
    product_attributes: Boolean(productAttributes && typeof productAttributes === 'object' && Object.keys(productAttributes).length > 0),
  };
  const semanticChecks = semanticQa?.checks || {};
  const stagePassed = id => id === 'LISTING_SOP_02'
    ? task.qa?.[id]?.status === 'PASS' && task.outputs?.confirmed_product_facts?.artifact_type === 'CONFIRMED_PRODUCT_FACTS_VERSION'
    : steps[id]?.status === 'PASS' && steps[id]?.qa_status === 'PASS';
  const waiting = (listing?.waiting_items || []).filter(item => !item.decided_at).length;
  const stale = Object.values(steps).filter(item => item.status === 'STALE').length;
  const checks = [
    { code: 'FACTS_CONSISTENCY', message: '确认事实版本与标题、描述引用一致。', pass: stagePassed('LISTING_SOP_02') && observedChecklist.facts_consistency },
    { code: 'BRAND_CONSISTENCY', message: '标题品牌来自已确认事实。', pass: observedChecklist.brand_consistency },
    { code: 'TITLE_QA', message: '标题 Stage QA 已通过。', pass: stagePassed('LISTING_SOP_14') },
    { code: 'ANCHORS_QA', message: '5 个信息锚点 Stage QA 已通过。', pass: stagePassed('LISTING_SOP_15') && Array.isArray(anchors?.anchors) && anchors.anchors.length === 5 },
    { code: 'DESCRIPTION_QA', message: '荷兰语描述 Stage QA 已通过。', pass: stagePassed('LISTING_SOP_16') },
    { code: 'PACKAGE_QA', message: '包装内容字段存在且 SOP16 QA 已通过。', pass: stagePassed('LISTING_SOP_16') && observedChecklist.package_contents },
    { code: 'ATTRIBUTES_QA', message: '商品属性字段存在且 SOP16 QA 已通过。', pass: stagePassed('LISTING_SOP_16') && observedChecklist.product_attributes },
    { code: 'FINAL_REQUIRED_STAGES_PASS', message: 'SOP07–SOP16 必需步骤均 Stage QA PASS。', pass: needed.filter(id => id !== 'LISTING_SOP_02').every(stagePassed) },
    { code: 'OPEN_CONFIRMATION_COUNT_ZERO', message: '未关闭的 WAITING_CONFIRMATION / WAITING_DECISION 为 0。', pass: waiting === 0 },
    { code: 'STALE_DEPENDENCIES_ZERO', message: '依赖旧版本的产物为 0。', pass: stale === 0 },
    { code: 'OPEN_ERROR_COUNT_ZERO', message: 'OPEN_ERROR_COUNT 为 0。', pass: Number(task?.open_error_count || 0) === 0 },
    { code: 'SEMANTIC_QA_EVIDENCE', message: '中文/荷兰语一致性与语义 QA 证据已挂接。', pass: semanticQa?.status === 'PASS' && Array.isArray(semanticQa.evidence_refs) && semanticQa.evidence_refs.length > 0 },
    { code: 'NO_UNCONFIRMED_FACTS', message: '语义 QA 未发现未确认事实进入买家可见内容。', pass: semanticQa?.unconfirmed_facts_included === false || semanticChecks.unconfirmed_facts_included === 'PASS' },
    { code: 'NO_COMPETITOR_FACT_POLLUTION', message: '语义 QA 未发现竞品事实写成我方事实。', pass: semanticQa?.competitor_facts_in_own_listing === false || semanticChecks.competitor_facts_in_own_listing === 'PASS' },
    { code: 'TITLE_ANCHOR_DESCRIPTION_CONSISTENCY', message: '语义 QA 已核验标题、锚点和描述一致。', pass: semanticQa?.title_anchors_description_consistency === 'PASS' || semanticChecks.title_anchors_description_consistency === 'PASS' },
  ];
  const result = qaResult(checks);
  if (semanticQa?.status !== 'PASS') result.status = 'WAITING_DEPENDENCY';
  return result;
}

export const LISTING_KEYWORD_CONTRACTS = Object.freeze({
  sop03_source_record_required_fields: ['source_type', 'exact_string', 'source_url', 'source_title', 'source_evidence', 'language', 'discovered_at', 'facts_version'],
  sop04_output_fields: ['seed_exact_string', 'returned_raw_terms', 'adopted_terms', 'api_evidence', 'queried_at'],
  sop05_candidate_statuses: ['ACTIVE', 'EXCLUDED', 'NO_RESULT', 'CONFIRMED_VOLUME', 'SELECTED_TOP20'],
  sop06_provider_statuses: ['PASS', 'PASS_NO_RESULT', 'PENDING_RECHECK', 'ERROR'],
  sop06_pass_allows_search_volume_zero: true,
  sop07_forbidden_fields: ['volume_score', 'relevance_score', 'final_keyword_score', 'log_normalization'],
});

export const LISTING_COMPETITOR_CONTRACT_FIELDS = Object.freeze([
  'competitor_source_version', 'candidate_or_formal', 'competitor_level', 'evidence', 'price', 'comparable_offer_evidence',
  'rating_evidence', 'review_evidence', 'sales_heat_evidence', 'hot_selling_points', 'pain_points', 'purchase_reasons',
  'current_sale_evidence', 'own_facts_version', 'own_advantage_tie_disadvantage', 'comparison_result',
  'selling_point_matrix_version', 'display_weight',
]);

export const LISTING_STAGE_QUALITY_CONTRACT = Object.freeze({
  done_is_pass: false, pass_requires_output_evidence: true, pass_requires_stage_qa: true, pass_requires_open_error_count_zero: true,
});
