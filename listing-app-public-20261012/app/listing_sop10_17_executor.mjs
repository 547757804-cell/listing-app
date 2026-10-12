import { applyListingOutputAmendment } from './listing_output_amendment.mjs';
import { buildFinalQaEvidencePack, SOP17_EVIDENCE_PACK_VERSION } from './listing_final_qa_evidence_pack.mjs';
import { acceptanceCloseoutWindow, readAcceptanceCloseout, acceptanceControlledRetry, acceptanceFailureResult, readAcceptanceCall } from './listing_acceptance_closeout.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { routeAiRequest, getAiProviderExecutionConfig, getAiProviderReadiness } from './ai_router.mjs';
import { ACCEPTANCE_MODE, RUNTIME_MODE } from './runtime_mode.mjs';
import { AI_SOP10_DEEPSEEK_MAX_TOKENS } from './ai_generation_recovery.mjs';
import {
  AI_PROVIDER_RESULT_CONTRACT_VERSION, beginProviderGenerationAttempt, createAiGenerationIdentity,
  evaluateGenerationRecoveryRoute, getGenerationCircuit, getProviderPartialResult, markStaleMismatchedPartials,
  recordProviderGenerationResult, resolveAiTimeoutConfiguration, resolveProviderGenerationAttemptPolicy,
} from './ai_generation_recovery.mjs';
import { buildAiModelProvenance, qaAiModelProvenance } from './ai_model_provenance_contract.mjs';
import { getListingSopJsonSchema, validateListingSopJsonSchema } from './listing_sop_json_schemas.mjs';
import { indexLockedListingEvidence } from './listing_evidence_reference_index.mjs';
import { createListingEvidenceResolver, validateListingEvidence, readEvidencePointer, listingEvidenceValueSha256 } from './listing_evidence_resolver.mjs';
import { applyListingEvidenceRepair } from './listing_evidence_repair.mjs';
import {
  qaListingSop10Contract, qaListingSop11Contract, qaListingSop12Contract, qaListingSop13Contract,
  qaListingSop14Title, qaListingSop15Anchors, qaListingSop16Description, qaListingSop17Final,
} from './listing_executor_framework.mjs';
import { buildSop14TitleContractInstructions, SOP14_TITLE_PROMPT_CONTRACT_VERSION } from './sop14_title_contract.mjs';

export const SOP10_17_EXECUTOR_IDS = Object.freeze(Object.fromEntries(
  Array.from({ length: 8 }, (_, index) => {
    const step = `LISTING_SOP_${String(index + 10).padStart(2, '0')}`;
    return [step, `LISTING_SOP_${String(index + 10).padStart(2, '0')}_EXECUTOR`];
  }),
));

const OUTPUT_KEYS = Object.freeze({
  LISTING_SOP_10: 'buyer_insights', LISTING_SOP_11: 'own_competitor_comparison',
  LISTING_SOP_12: 'selling_matrix', LISTING_SOP_13: 'display_weighting',
  LISTING_SOP_14: 'title', LISTING_SOP_15: 'anchors', LISTING_SOP_16: 'description', LISTING_SOP_17: 'final_qa',
});
const REQUIRED_INPUTS = Object.freeze({
  LISTING_SOP_10: ['LISTING_SOP_09'],
  LISTING_SOP_11: ['LISTING_SOP_02', 'LISTING_SOP_09', 'LISTING_SOP_10'],
  LISTING_SOP_12: ['LISTING_SOP_07', 'LISTING_SOP_10', 'LISTING_SOP_11'],
  LISTING_SOP_13: ['LISTING_SOP_12'],
  LISTING_SOP_14: ['LISTING_SOP_02', 'LISTING_SOP_12', 'LISTING_SOP_13'],
  LISTING_SOP_15: ['LISTING_SOP_02', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14'],
  LISTING_SOP_16: ['LISTING_SOP_02', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14', 'LISTING_SOP_15'],
  LISTING_SOP_17: ['LISTING_SOP_02', 'LISTING_SOP_07', 'LISTING_SOP_08', 'LISTING_SOP_09', 'LISTING_SOP_10', 'LISTING_SOP_11', 'LISTING_SOP_12', 'LISTING_SOP_13', 'LISTING_SOP_14', 'LISTING_SOP_15', 'LISTING_SOP_16'],
});
const OUTPUT_SOURCE = Object.freeze({
  LISTING_SOP_02: 'confirmed_product_facts', LISTING_SOP_07: 'top20', LISTING_SOP_08: 'listing_competitor_pool',
  LISTING_SOP_09: 'competitor_analysis', LISTING_SOP_10: 'buyer_insights', LISTING_SOP_11: 'own_competitor_comparison',
  LISTING_SOP_12: 'selling_matrix', LISTING_SOP_13: 'display_weighting', LISTING_SOP_14: 'title',
  LISTING_SOP_15: 'anchors', LISTING_SOP_16: 'description',
});
const OUTPUT_TYPES = Object.freeze({
  LISTING_SOP_10: 'LISTING_BUYER_INSIGHTS_VERSION', LISTING_SOP_11: 'LISTING_OWN_COMPETITOR_COMPARISON_VERSION',
  LISTING_SOP_12: 'LISTING_SELLING_POINT_MATRIX_VERSION', LISTING_SOP_13: 'LISTING_DISPLAY_WEIGHTING_VERSION',
  LISTING_SOP_14: 'LISTING_TITLE_VERSION', LISTING_SOP_15: 'LISTING_ANCHORS_VERSION',
  LISTING_SOP_16: 'LISTING_DESCRIPTION_PACKAGE_ATTRIBUTES_VERSION', LISTING_SOP_17: 'LISTING_FINAL_QA_REPORT',
});
const FORBIDDEN_SCORE_KEYS = new Set(['volume_score', 'relevance_score', 'final_keyword_score', 'final_score', 'log_normalization']);
export const SOP10_DEEPSEEK_JSON_PROMPT_CONTRACT_VERSION = 'SOP10_DEEPSEEK_JSON_OUTPUT_CONTRACT_V1';
export const SOP10_17_DEEPSEEK_RESPONSES_PROMPT_CONTRACT_VERSION = 'SOP10_17_DEEPSEEK_RESPONSES_JSON_SCHEMA_V1';
export const SOP10_QWEN_JSON_SCHEMA_LOW_THINKING_CONTRACT_VERSION = 'SOP10_QWEN_JSON_SCHEMA_LOW_THINKING_V1';
export const SOP10_17_QWEN_JSON_SCHEMA_CONTRACT_VERSION = 'SOP10_17_QWEN_JSON_SCHEMA_V1';
export const SOP10_17_SOP14_TITLE_PROMPT_CONTRACT_VERSION = SOP14_TITLE_PROMPT_CONTRACT_VERSION;
export const DEEPSEEK_LISTING_MAX_OUTPUT_TOKENS = 16384;
export const QWEN_SOP10_MAX_COMPLETION_TOKENS = 16384;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonBytes = value => `${JSON.stringify(value)}\n`;
const clone = value => structuredClone(value);
const iso = () => new Date().toISOString();

function unwrap(task, step) {
  const key = OUTPUT_SOURCE[step];
  return key ? task?.outputs?.[key] || null : null;
}
function versionOf(output, step) {
  return output?.version || output?.evidence?.version || output?.artifact_version
    || (step === 'LISTING_SOP_02' ? String(output?.version ?? '') : '');
}
function outputRecord(task, step) {
  const raw = unwrap(task, step);
  return raw ? { output: raw, version: versionOf(raw, step) } : null;
}
function inputStatus(task, step) {
  const missing = [];
  for (const required of REQUIRED_INPUTS[step] || []) {
    const record = outputRecord(task, required);
    if (!record?.output || !record.version) { missing.push(`${required}:VERSION_MISSING`); continue; }
    const registry = task.listing_executor?.registry?.[required];
    const sop02Passed = required === 'LISTING_SOP_02'
      && task.qa?.LISTING_SOP_02?.status === 'PASS'
      && record.output?.artifact_type === 'CONFIRMED_PRODUCT_FACTS_VERSION';
    if (registry?.status === 'STALE' || record.output?.stale === true || record.output?.status === 'STALE') missing.push(`${required}:STALE`);
    else if (!sop02Passed && (registry?.status !== 'PASS' || registry?.qa_status !== 'PASS')) missing.push(`${required}:PASS_QA_REQUIRED`);
  }
  return missing;
}

async function sourceReference(dataRoot, task, step) {
  const source = outputRecord(task, step);
  if (!source) return null;
  const output = source.output;
  const ref = output?.evidence?.artifact_ref;
  if (typeof ref === 'string' && ref) {
    const full = path.resolve(dataRoot, ref);
    const root = path.resolve(dataRoot) + path.sep;
    if (!full.startsWith(root)) throw Object.assign(new Error(`上游 ${step} evidence ref 越出当前 dataRoot。`), { code: 'SOP10_17_INPUT_REF_OUTSIDE_ROOT' });
    const bytes = await fs.readFile(full);
    const persisted = JSON.parse(bytes.toString('utf8'));
    if (String(persisted.version || '') !== String(source.version)) throw Object.assign(new Error(`上游 ${step} 文件版本与任务引用不一致。`), { code: 'SOP10_17_INPUT_VERSION_MISMATCH' });
    return { step, artifact_type: persisted.artifact_type || step, version: source.version, reference: path.relative(dataRoot, full).replace(/\\/g, '/'), sha256: sha256(bytes), data: persisted };
  }
  const bytes = Buffer.from(jsonBytes(output));
  return { step, artifact_type: output.artifact_type || step, version: source.version, reference: `task:outputs.${OUTPUT_SOURCE[step]}`, sha256: sha256(bytes), data: output };
}

export async function resolveSop10To17Inputs(dataRoot, task, step) {
  if (!Object.hasOwn(REQUIRED_INPUTS, step)) throw Object.assign(new Error(`Unsupported Listing step: ${step}`), { code: 'SOP10_17_STEP_UNSUPPORTED' });
  const missing = inputStatus(task, step);
  if (missing.length) throw Object.assign(new Error(`缺少通过QA且版本明确的输入：${missing.join(', ')}`), { code: 'SOP10_17_INPUTS_NOT_READY', missing_inputs: missing });
  const refs = [];
  const inputs = {};
  for (const inputStep of REQUIRED_INPUTS[step]) {
    const item = await sourceReference(dataRoot, task, inputStep);
    refs.push(item);
    inputs[inputStep] = item.data;
  }
  // Load only immutable nested artifacts explicitly declared by a locked source
  // manifest and verify their declared SHA before making them resolvable.
  const evidenceArtifacts = [];
  const evidenceArtifactFailures = [];
  const seenEvidenceFiles = new Set();
  const seenTaskEvidence = new Set();
  const root = path.resolve(dataRoot);
  for (const [inputStep, artifact] of Object.entries(inputs)) {
    const manifests = [];
    const scan = (value, key = '') => {
      if (!value || typeof value !== 'object') return;
      if ((key === 'source_file_refs' || key === 'source_references') && Array.isArray(value)) manifests.push(...value);
      for (const [childKey, child] of Object.entries(value)) scan(child, childKey);
    };
    scan(artifact);
    for (const manifest of manifests) {
      const reference = manifest?.reference;
      const expectedHash = manifest?.sha256;
      const version = manifest?.version;
      if (typeof reference !== 'string' || !reference
        || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)
        || version == null || String(version) === '') continue;
      if (reference.startsWith('task:')) {
        // Task-backed facts are resolvable only for this exact allowlisted source
        // and only when a SHA/version/type manifest is present in a locked input.
        if (reference !== 'task:outputs.confirmed_product_facts') continue;
        const facts = task.outputs?.confirmed_product_facts;
        const factsHash = facts ? sha256(jsonBytes(facts)) : null;
        const expectedType = 'CONFIRMED_PRODUCT_FACTS_VERSION';
        if (!facts || facts.sku !== task.sku || facts.artifact_type !== expectedType
          || String(facts.version) !== String(version) || manifest.artifact_type !== expectedType) {
          evidenceArtifactFailures.push({ reference, status: 'VERSION_MISMATCH', version: String(version), reason: 'TASK_FACTS_IDENTITY_OR_VERSION_MISMATCH' });
          continue;
        }
        if (factsHash !== expectedHash.toLowerCase()) {
          evidenceArtifactFailures.push({ reference, status: 'STALE', version: String(version), sha256: expectedHash.toLowerCase(), reason: 'TASK_FACTS_LOCKED_SHA_MISMATCH' });
          continue;
        }
        const dedupeKey = `${reference}\u0000${version}\u0000${expectedHash.toLowerCase()}`;
        if (seenTaskEvidence.has(dedupeKey)) continue;
        seenTaskEvidence.add(dedupeKey);
        evidenceArtifacts.push({ step_id: 'LISTING_SOP_02', artifact_type: expectedType, version: String(version),
          reference, artifact_ref: reference, sha256: expectedHash.toLowerCase(), sku: task.sku, layer: 'OWN_FACTS', data: facts });
        continue;
      }
      const full = path.resolve(root, reference);
      if (!full.startsWith(`${root}${path.sep}`) || seenEvidenceFiles.has(full.toLowerCase())) continue;
      seenEvidenceFiles.add(full.toLowerCase());
      let bytes;
      try { bytes = await fs.readFile(full); } catch { evidenceArtifactFailures.push({ reference: reference.replace(/\\/g, '/'), status: 'MISSING', reason: 'DECLARED_ARTIFACT_FILE_NOT_READABLE' }); continue; }
      if (bytes.length > 50 * 1024 * 1024 || sha256(bytes) !== expectedHash.toLowerCase()) {
        evidenceArtifactFailures.push({ reference: reference.replace(/\\/g, '/'), version: String(version), sha256: expectedHash.toLowerCase(), status: 'STALE', reason: 'DECLARED_ARTIFACT_SHA_MISMATCH' });
        continue;
      }
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { continue; }
      if (data?.sku && data.sku !== task.sku) continue;
      if (data?.version != null && String(data.version) !== String(version)) continue;
      const layerBySource = { SOP08: 'SOP08_CONTEXT', BOL_PAGE_FACTS: 'PAGE_FACTS', BOL_API_FACTS: 'BOL_API_FACTS', AMAZON_PAGE_FACTS: 'AMAZON_PAGE_FACTS' };
      evidenceArtifacts.push({ step_id: inputStep, artifact_type: manifest.artifact_type || data.artifact_type || null,
        version: String(version), reference: path.relative(root, full).replace(/\\/g, '/'), sha256: expectedHash.toLowerCase(),
        sku: data?.sku || task.sku, layer: layerBySource[manifest.source] || null, data });
    }
  }
  const factVersion = String(task.outputs?.confirmed_product_facts?.version ?? '');
  const sop08 = inputs.LISTING_SOP_08 || task.outputs?.listing_competitor_pool;
  const sop08Context = {
    artifact_version: sop08?.version || null,
    classification: sop08?.main_comparison_pool?.[0]?.classification || sop08?.candidates?.find(item => item.classification === 'B_REFERENCE')?.classification || null,
    low_competitor_pool_confidence: sop08?.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE'
      || sop08?.low_competitor_pool_confidence === true,
    confidence_reason: sop08?.confidence_reason || null,
  };
  const allowedEvidenceRefs = [...new Set(refs.flatMap(item => [
    item.reference,
    ...(Array.isArray(item.data?.evidence_refs) ? item.data.evidence_refs : []),
    ...(Array.isArray(item.data?.source_file_refs) ? item.data.source_file_refs.map(ref => ref?.reference) : []),
  ].filter(Boolean)))];
  const sop09 = inputs.LISTING_SOP_09 || {};
  const amazon = sop09.amazon_reference_analysis || {};
  const facts = inputs.LISTING_SOP_02 || {};
  const currentSkuContext = {
    sku: task.sku,
    current_facts_version: factVersion || null,
    competitor_confidence: structuredClone(sop08Context),
    review_scope: amazon.inline_reviews?.review_scope || sop09.review_analysis?.amazon_scope || null,
    price_context: amazon.delivery_context ? structuredClone(amazon.delivery_context) : null,
    evidence_conflicts: structuredClone(sop09.source_conflicts || []),
    provider_provenance: refs.flatMap(item => item.data?.ai_model_provenance || item.data?.provider_provenance || []),
    product_unknowns: Object.entries(facts.fields || {}).filter(([, value]) => value?.status === 'UNKNOWN').map(([field]) => field),
  };
  return {
    step, sku: task.sku, facts_version: factVersion, sop08_context: sop08Context, current_sku_context: currentSkuContext,
    input_version_refs: refs.map(({ step: id, artifact_type, version, reference, sha256: hash }) => ({ artifact_type, step_id: id, version, reference, sha256: hash })),
    evidence_refs: allowedEvidenceRefs, inputs, evidence_artifacts: evidenceArtifacts, evidence_artifact_failures: evidenceArtifactFailures,
  };
}

function expectedSchema(step) {
  switch (step) {
    case 'LISTING_SOP_10': return 'JSON object with observed_selling_points[], pain_points[], buying_reasons[], why_competitor_appears_to_sell[], evidence_refs[], low_competitor_pool_confidence, and review_analysis.review_scope.';
    case 'LISTING_SOP_11': return 'JSON object with comparisons[] items containing relation ADVANTAGE|EQUAL|DISADVANTAGE|UNKNOWN, evidence_refs[], facts_version, competitor_pool_version.';
    case 'LISTING_SOP_12': return 'JSON object with matrix_items[] containing matrix_item_id, buyer_value, evidence_refs[], low_competitor_pool_confidence, competitor_influence_ceiling.';
    case 'LISTING_SOP_13': return 'JSON object with display_decisions[] containing target_ref, decision UPWEIGHT|KEEP|DOWNWEIGHT, reason, evidence_refs[], and no numeric scoring fields.';
    case 'LISTING_SOP_14': return 'JSON object with title_nl (Dutch, exactly 230–260 characters including spaces and punctuation), title_zh, language nl-NL, source_fact_version, keyword_layout_refs:string[], evidence_refs:string[].';
    case 'LISTING_SOP_15': return 'JSON object with anchors[5], each anchor_id, title_nl, title_zh, phrases_nl[4-5], phrases_zh[4-5] in corresponding order, text_nl, text_zh, source_fact_refs[], evidence_refs[].';
    case 'LISTING_SOP_16': return 'JSON object with description_nl, description_zh, package_contents_nl, product_attributes, language nl-NL, source_fact_version, keyword_layout_refs, evidence_refs.';
    case 'LISTING_SOP_17': return 'JSON object with semantic_qa status PASS or FAIL according to the evidence, evidence_refs[], unconfirmed_facts_included boolean, competitor_facts_in_own_listing boolean, title_anchors_description_consistency PASS or FAIL, findings[]; never default to PASS or claim unchecked evidence.';
    default: return '';
  }
}

export function compactListingGenerationEvidence(value) {
  if (Array.isArray(value)) return value.map(compactListingGenerationEvidence);
  if (!value || typeof value !== 'object') return value;
  const metadata=new Set(['provider_trace','ai_model_provenance','evidence_reference_index','evidence_resolution','evidence_repair_audit','local_amendment_audit']);
  return Object.fromEntries(Object.entries(value).filter(([key])=>!metadata.has(key)).map(([key,v])=>[key,compactListingGenerationEvidence(v)]));
}
export function promptFor(step, inputs) {
  const facts = inputs?.inputs?.LISTING_SOP_02 || {};
  const brandField = facts?.fields?.brand_name;
  const confirmedBrand = brandField?.status === 'CONFIRMED' ? (brandField.value?.value ?? brandField.value)
    : facts?.brand_name?.status === 'CONFIRMED' ? (facts.brand_name.value?.value ?? facts.brand_name.value) : null;
  const sop09 = inputs?.inputs?.LISTING_SOP_09 || {};
  const reviewAnalysis = sop09.review_analysis || {};
  const amazon = sop09.amazon_reference_analysis || {};
  const observedBoundaries = [];
  const reviewScope = amazon.inline_reviews?.review_scope || reviewAnalysis.amazon_scope;
  if (reviewScope) observedBoundaries.push(`保留当前来源的评论范围=${reviewScope}，不得扩大为未观察到的全集。`);
  if (amazon.ratings_summary?.rating_count != null) observedBoundaries.push('rating_count只表示评分计数，不得改写成文字评论数。');
  const pagination = amazon.inline_reviews?.pagination_status || reviewAnalysis.pagination_status;
  if (pagination) observedBoundaries.push(`保留当前来源分页状态=${pagination}。`);
  const packageConflict = amazon.package_contents?.conflict_status;
  if (packageConflict) observedBoundaries.push(`保留当前包装冲突状态=${packageConflict}，不自行裁决。`);
  if (amazon.delivery_context?.usable_for_amazon_de_local_price_comparison === false) observedBoundaries.push('该 Amazon 价格上下文不适用于德国本地价格比较。');
  const base = [
    `执行 ${step}，只输出符合指定结构的JSON对象，不输出Markdown代码围栏。`,
    '只使用下列输入与证据引用；不新增商品事实、不将竞品参数写成自有事实。',
    'UNKNOWN保持UNKNOWN；来源冲突照实标记，不裁决。每条结论必须带 evidence_refs。',
    '从当前 SKU context 读取竞品分类与置信度；不得把缺失字段默认成低置信，也不得提升竞品影响级别。',
    '只执行当前 SKU 输入明确支持的来源边界；未提供的评论、价格和冲突状态不得臆造。',
    ...observedBoundaries,
    `输出结构：${expectedSchema(step)}`,
    `锁定输入版本：${JSON.stringify(inputs.input_version_refs)}`,
    `输入数据：${JSON.stringify(step === 'LISTING_SOP_17' ? buildFinalQaEvidencePack(inputs) : step >= 'LISTING_SOP_13' ? compactListingGenerationEvidence(inputs.inputs) : inputs.inputs)}`,
  ];
  if (step === 'LISTING_SOP_13') base.push('不得使用60/40、volume_score、relevance_score、final_keyword_score、final_score、log normalization或其他数值评分。');
  if (step === 'LISTING_SOP_14') base.push(buildSop14TitleContractInstructions({ confirmedBrand }));
  if (step === 'LISTING_SOP_15') base.push('输出正好5个产品专属信息锚点，每项提供荷兰语与完整中文对照。');
  if (step === 'LISTING_SOP_16') base.push('荷兰语描述目标2500–2800字符，提供完整中文对照、包装内容和商品属性；不得填补UNKNOWN。');
  if (step >= 'LISTING_SOP_13') base.push('Evidence references must use an exact locked artifact reference or step+version, followed by an existing JSON pointer. Do not invent a path. Preserve all 20 exact keyword strings and qualitative decisions; no fabricated facts.');
  if (step === 'LISTING_SOP_13') {
    base.push('对当前正式TOP20全部exact string逐一输出decision；另列卖点决定。关键词exact_string保持原样；只按事实/矩阵文字理由，不计算分数。');
    if (inputs?.sop08_context?.low_competitor_pool_confidence === true) base.push('当前SKU低竞品池置信度必须继承；遵守当前SOP08明确的竞品影响边界。');
  }
  if (step === 'LISTING_SOP_14') base.push('标题结构按事实适用性组织：品牌 - 核心产品词 - 已确认套组/数量 - 不同的已确认功能或属性 - 有证据支持的使用场景。省略未确认或不适用的部分；不得为满足长度添加空话。');
  if (step === 'LISTING_SOP_15') base.push('每项必须提供独立title_nl/title_zh，phrases_nl和phrases_zh各4–5个对应短词，text_nl/text_zh为这些短词的可读展示。五组信息分工不同，无未知事实，无空泛营销词。');
  if (step === 'LISTING_SOP_16') base.push('description_nl字符数包含小标题、所有正文和末尾Inhoud pakket及Productspecificaties，合计2500–2800。约180–250字符生活化开头，约5–6个真正重要的不同主题，再含使用收益、包装、属性。description_zh完整翻译所有部分，末尾含包装内容及商品属性。另保存package_contents_zh和product_attributes_zh。只使用CONFIRMED事实；UNKNOWN字段不用于买家文案，不写审核状态/证据等内部话术。');
  if (step === 'LISTING_SOP_17') base.push(`Final QA deterministic pack ${SOP17_EVIDENCE_PACK_VERSION}: compare buyer_listing only against own_facts and retained source boundaries. Upstream observations are reference evidence, not own product claims. Unknown fields are omitted from buyer copy. References must point to the original locked artifact and existing field, not a fabricated pack path. Return all semantic_qa fields explicitly. Do not assume PASS.`);
  return base.join('\n');
}

function deepSeekSop10JsonContract(basePrompt, inputs) {
  const amazon = inputs?.inputs?.LISTING_SOP_09?.amazon_reference_analysis;
  const inlineReviews = amazon?.inline_reviews;
  const hasObservedInlineReviews = Array.isArray(inlineReviews) ? inlineReviews.length > 0
    : Array.isArray(inlineReviews?.items) ? inlineReviews.items.length > 0
      : Number(inlineReviews?.sample_count) > 0;
  const sourceScope = inlineReviews?.review_scope || inputs?.inputs?.LISTING_SOP_09?.review_analysis?.amazon_scope;
  const partialScope = hasObservedInlineReviews && ['INLINE_SAMPLE', 'INLINE_SAMPLE_ONLY', 'AVAILABLE_PARTIAL'].includes(sourceScope);
  const scope = partialScope ? 'INLINE_SAMPLE_ONLY' : sourceScope || (amazon?.bol_reviews_status === 'NO_REVIEWS' ? 'NO_REVIEWS' : null);
  const pagination = inlineReviews?.pagination_status || inputs?.inputs?.LISTING_SOP_09?.review_analysis?.pagination_status;
  const reviewFields = scope ? `,\n  "review_analysis": {
    "review_scope": ${JSON.stringify(scope)}${pagination ? `,\n    "pagination_status": ${JSON.stringify(pagination)}` : ''}${partialScope ? ',\n    "frequency_scope": "WITHIN_OBSERVED_SAMPLE"' : ''}${amazon?.ratings_summary?.rating_count != null ? ',\n    "rating_count_is_review_count": false' : ''}
  }` : '';
  const example = `{
  "observed_selling_points": [],
  "pain_points": [],
  "buying_reasons": [],
  "why_competitor_appears_to_sell": [],
  "evidence_refs": [],
  "low_competitor_pool_confidence": ${inputs?.sop08_context?.low_competitor_pool_confidence === true ? 'true' : 'false'}${reviewFields}
}`;
  const prompt = [
    basePrompt,
    'DeepSeek JSON Output contract:',
    'The response must be JSON.',
    'Return JSON only. Do not output prose before or after the JSON.',
    'Example JSON OUTPUT (shape only; populate every value from the locked evidence and preserve the actual confidence state):',
    example,
  ].join('\n');
  return { prompt, example };
}

function deepSeekSop10JsonPrompt(basePrompt, inputs) {
  return deepSeekSop10JsonContract(basePrompt, inputs).prompt;
}

/**
 * SOP09 keeps a normalized BOL review record in bol_competitor_analysis and
 * mirrors only status/items/pagination into review_analysis.bol_competitors.
 * Remove that second copy only after exact, one-to-one equality is proven.
 * All canonical review items, rating/count facts, evidence refs and other
 * analysis fields remain in the provider input.
 */
export function projectQwenSop10Inputs(inputs) {
  const projected = clone(inputs);
  const sop09 = projected?.inputs?.LISTING_SOP_09;
  if (!sop09 || typeof sop09 !== 'object') return { inputs: projected, compacted: false, removed_characters: 0 };

  const business = { ...sop09 };
  for (const key of ['schema_version', 'artifact_type', 'sku', 'created_at', 'input_versions', 'version',
    'source_file_refs', 'status', 'evidence', 'qa_status']) delete business[key];

  const canonical = Array.isArray(business.bol_competitor_analysis) ? business.bol_competitor_analysis : null;
  const review = business.review_analysis;
  const mirror = review?.bol_competitors;
  let verifiedMirror = Boolean(canonical && Array.isArray(mirror) && canonical.length === mirror.length);
  if (verifiedMirror) {
    const ids = new Set();
    for (const row of canonical) {
      const id = String(row?.competitor_id || '');
      if (!id || ids.has(id)) { verifiedMirror = false; break; }
      ids.add(id);
      const mirrorRow = mirror.find(item => item?.competitor_id === id);
      if (!mirrorRow || !row?.reviews || !Array.isArray(row.reviews.items)
        || JSON.stringify(row.reviews.items) !== JSON.stringify(mirrorRow.items)
        || row.reviews.reviews_status !== mirrorRow.reviews_status
        || row.reviews.pagination_status !== mirrorRow.pagination_status) {
        verifiedMirror = false; break;
      }
    }
  }
  const beforeChars = JSON.stringify(sop09).length;
  if (verifiedMirror) {
    business.review_analysis = { ...review };
    delete business.review_analysis.bol_competitors;
  }
  projected.inputs.LISTING_SOP_09 = business;
  const afterChars = JSON.stringify(business).length;
  return { inputs: projected, compacted: verifiedMirror, removed_characters: verifiedMirror ? beforeChars - afterChars : 0 };
}

function qwenSop10JsonPrompt(inputs) {
  const projection = projectQwenSop10Inputs(inputs);
  const prompt = promptFor('LISTING_SOP_10', projection.inputs);
  return { prompt, inputs: projection.inputs, compacted: projection.compacted, removed_characters: projection.removed_characters };
}

export function resolveQwenListingGenerationOptions({ acceptanceRuntime = false, effectiveModel = '', step = '' } = {}) {
  if (acceptanceRuntime !== true || String(effectiveModel).toLowerCase() !== 'qwen3.8-flash'
      || !/^LISTING_SOP_1[0-7]$/.test(String(step))) return {};
  return { reasoning_effort: 'none', preserve_thinking: false };
}

export function getSop10JsonRequestContractMetadata(inputs) {
  const basePrompt = promptFor('LISTING_SOP_10', inputs);
  const qwenContract = qwenSop10JsonPrompt(inputs);
  const deepSeekContract = deepSeekSop10JsonContract(basePrompt, inputs);
  const deepSeekPrompt = deepSeekContract.prompt;
  const deepSeekSchema = getListingSopJsonSchema('LISTING_SOP_10');
  const system = '你是BOL荷兰市场Listing执行助手。必须保留事实来源边界和精确证据引用。';
  const adapterStructuredSystem = `${system}\nReturn a JSON object only.`;
  return {
    prior_deepseek_request: {
      message_count: 2, system_prompt_chars: adapterStructuredSystem.length, user_prompt_chars: basePrompt.length,
      response_format: 'json_object', max_tokens: AI_SOP10_DEEPSEEK_MAX_TOKENS, thinking_mode: 'disabled',
      contains_json_literal: /json/i.test(`${system}\n${basePrompt}`),
      contains_json_only_instruction: basePrompt.includes('只输出符合指定结构的JSON对象'),
      contains_exact_json_only_instruction: false, contains_json_output_example: false,
      contains_target_schema: basePrompt.includes(expectedSchema('LISTING_SOP_10')),
    },
    qwen_after_fix: {
      message_count: 2, system_prompt_chars: system.length + '\nReturn a JSON object only.'.length,
      user_prompt_chars: qwenContract.prompt.length, response_format: 'json_schema',
      api_protocol: 'CHAT_COMPLETIONS', structured_output: 'json_schema', schema_name: 'listing_sop_10', schema: deepSeekSchema,
      schema_chars: JSON.stringify(deepSeekSchema).length, max_completion_tokens: QWEN_SOP10_MAX_COMPLETION_TOKENS,
      reasoning_effort: 'none', thinking_mode: 'disabled', preserve_thinking: false,
      evidence_projection_compacted: qwenContract.compacted, repeated_review_characters_removed: qwenContract.removed_characters,
      prompt_contract_version: SOP10_QWEN_JSON_SCHEMA_LOW_THINKING_CONTRACT_VERSION,
      provider_prompt_hash_changes: qwenContract.prompt !== basePrompt,
    },
    deepseek_after_fix: {
      message_count: 2, system_prompt_chars: adapterStructuredSystem.length, user_prompt_chars: deepSeekPrompt.length,
      api_protocol: 'RESPONSES', structured_output: 'json_schema', response_format: 'json_schema',
      max_output_tokens: DEEPSEEK_LISTING_MAX_OUTPUT_TOKENS, reasoning_effort: 'none',
      schema_name: 'listing_sop_10', schema: deepSeekSchema,
      contains_json_literal: /json/i.test(`${adapterStructuredSystem}\n${deepSeekPrompt}`),
      contains_json_only_instruction: true,
      contains_exact_json_only_instruction: deepSeekPrompt.includes('Return JSON only. Do not output prose before or after the JSON.'),
      contains_json_output_example: deepSeekPrompt.includes('Example JSON OUTPUT') && deepSeekPrompt.includes('"observed_selling_points"'),
      contains_target_schema: deepSeekPrompt.includes(expectedSchema('LISTING_SOP_10')),
      example_json_valid: (() => { try { return typeof JSON.parse(deepSeekContract.example) === 'object'; } catch { return false; } })(),
      example_schema_fields: Object.keys(JSON.parse(deepSeekContract.example)),
      prompt_contract_version: SOP10_17_DEEPSEEK_RESPONSES_PROMPT_CONTRACT_VERSION,
      provider_prompt_hash_changes: true,
    },
  };
}

/** Synthetic long-input request-shape fixture; contains no task or product data. */
export function buildSyntheticSop10ResponsesRequestShape() {
  const filler = 'SYNTHETIC FICTIONAL EVIDENCE TEXT FOR STRUCTURED OUTPUT SHAPE VALIDATION ONLY. '.repeat(168);
  const inputs = {
    step: 'LISTING_SOP_10', sku: 'SYNTHETIC-SKU-ONLY', facts_version: 'SYNTHETIC_FACTS_V1',
    sop08_context: { artifact_version: 'SYNTHETIC_SOP08_V1', classification: 'B_REFERENCE', low_competitor_pool_confidence: true },
    input_version_refs: [{ artifact_type: 'LISTING_COMPETITOR_ANALYSIS_VERSION', step_id: 'LISTING_SOP_09', version: 'SYNTHETIC_SOP09_V1', reference: 'synthetic://sop09', sha256: 'a'.repeat(64) }],
    evidence_refs: ['SYNTH-EVIDENCE-001'],
    inputs: { LISTING_SOP_09: {
      evidence_refs: ['SYNTH-EVIDENCE-001'], low_competitor_pool_confidence: true,
      bol_competitor_analysis: [{ competitor_id: 'SYNTH-BOL-1', classification: 'B_REFERENCE', title: 'Fictional paper gift bags', description: filler,
        specifications: { fictional_observation: filler }, package_set_content: filler, reviews_status: 'NO_REVIEWS', reviews: [], evidence_refs: ['SYNTH-EVIDENCE-001'] }],
      amazon_reference_analysis: { title: 'Fictional sample product', bullets: [filler], description: filler,
        inline_reviews: { items: [{ title: 'Synthetic sample', body: filler, date: '2026-01-01', rating: 5 }], sample_count: 1 },
        review_pagination: 'BLOCKED_LOGIN_REQUIRED', package_contents_status: 'SOURCE_CONFLICT_WITHIN_PAGE', evidence_refs: ['SYNTH-EVIDENCE-001'] },
      review_analysis: { review_scope: 'INLINE_SAMPLE_ONLY', pagination_status: 'BLOCKED_LOGIN_REQUIRED' },
    } },
  };
  const system = '你是合成请求形态验收助手。只根据虚构输入返回SOP10 schema结构，不得推断现实商品事实。';
  const prompt = deepSeekSop10JsonPrompt(promptFor('LISTING_SOP_10', inputs), inputs);
  return { sku: 'SYNTHETIC-SKU-ONLY', system, prompt, schema: getListingSopJsonSchema('LISTING_SOP_10'), input_character_count: prompt.length,
    input_versions: inputs.input_version_refs.map(item => ({ ...item })), prompt_contract_version: SOP10_17_DEEPSEEK_RESPONSES_PROMPT_CONTRACT_VERSION };
}

/** Synthetic, non-business Qwen probe input with the same SOP10 schema and a
 * long-context envelope. Padding is explicit test text, never SYNTHETIC_ACCEPTANCE_05 evidence. */
export function buildSyntheticSop10QwenRequestShape({ targetCharacters = 124000 } = {}) {
  const inputs = {
    step: 'LISTING_SOP_10', sku: 'SYNTHETIC-SKU-ONLY', facts_version: 'SYNTHETIC_FACTS_V1',
    sop08_context: { artifact_version: 'SYNTHETIC_SOP08_V1', classification: 'B_REFERENCE', low_competitor_pool_confidence: true },
    input_version_refs: [{ artifact_type: 'LISTING_COMPETITOR_ANALYSIS_VERSION', step_id: 'LISTING_SOP_09', version: 'SYNTHETIC_SOP09_V1', reference: 'synthetic://sop09', sha256: 'b'.repeat(64) }],
    evidence_refs: ['SYNTH-EVIDENCE-ONLY-001'],
    inputs: { LISTING_SOP_09: {
      evidence_refs: ['SYNTH-EVIDENCE-ONLY-001'], low_competitor_pool_confidence: true,
      bol_competitor_analysis: [{ competitor_id: 'SYNTH-BOL-1', classification: 'B_REFERENCE', title: 'Fictional comparator',
        description: 'SYNTHETIC FICTIONAL DESCRIPTION. '.repeat(80), specifications: { synthetic_note: 'No real product facts.' },
        package_or_set_content: 'Synthetic set only.', reviews: { reviews_status: 'AVAILABLE', rating: null, review_count: null,
          items: [{ title: 'Synthetic review', body: 'Synthetic review text only.', date: '2026-01-01', rating: 5 }], pagination_status: 'PAGINATION_UNVERIFIED' },
        evidence_refs: ['SYNTH-EVIDENCE-ONLY-001'] }],
      amazon_reference_analysis: { title: 'Synthetic reference', bullets: ['Synthetic example only.'], description: 'Synthetic reference description.',
        inline_reviews: { review_scope: 'INLINE_SAMPLE', sample_count: 1, items: [{ title: 'Synthetic sample', body: 'Synthetic sample review.', date: '2026-01-01', rating: 5 }], pagination_status: 'BLOCKED_LOGIN_REQUIRED' },
        package_contents: { conflict_status: 'SOURCE_CONFLICT_WITHIN_PAGE' }, evidence_refs: ['SYNTH-EVIDENCE-ONLY-001'] },
      review_analysis: { review_scope: 'INLINE_SAMPLE', pagination_status: 'BLOCKED_LOGIN_REQUIRED', frequency_scope: 'WITHIN_OBSERVED_SAMPLE',
        bol_competitors: [{ competitor_id: 'SYNTH-BOL-1', reviews_status: 'AVAILABLE', items: [{ title: 'Synthetic review', body: 'Synthetic review text only.', date: '2026-01-01', rating: 5 }], pagination_status: 'PAGINATION_UNVERIFIED' }] },
      source_completeness: { synthetic: 'fixture only' }, source_conflicts: [], unavailable_fields: [],
      synthetic_fixture_padding: '',
    } },
  };
  const system = '你是合成请求形态验收助手。只根据明确标记为虚构的输入返回SOP10 JSON Schema结构；不得推断现实商品事实。';
  const pad = 'SYNTHETIC LONG-CONTEXT PADDING; NOT A REAL PRODUCT FACT. ';
  let built = qwenSop10JsonPrompt(inputs);
  while (built.prompt.length < targetCharacters) {
    const remaining = targetCharacters - built.prompt.length;
    inputs.inputs.LISTING_SOP_09.synthetic_fixture_padding += pad.repeat(Math.max(1, Math.ceil(remaining / pad.length)));
    built = qwenSop10JsonPrompt(inputs);
    if (inputs.inputs.LISTING_SOP_09.synthetic_fixture_padding.length > targetCharacters) break;
  }
  return { sku: 'SYNTHETIC-SKU-ONLY', system, prompt: built.prompt,
    schema: getListingSopJsonSchema('LISTING_SOP_10'), input_character_count: built.prompt.length,
    input_versions: inputs.input_version_refs.map(item => ({ ...item })),
    prompt_contract_version: SOP10_QWEN_JSON_SCHEMA_LOW_THINKING_CONTRACT_VERSION,
    schema_sha256: sha256(JSON.stringify(getListingSopJsonSchema('LISTING_SOP_10'))),
    compacted_exact_review_mirror: built.compacted };
}

/** Build the exact recovery identity without dispatching a provider request. */
export function buildListingProviderGenerationIdentity({ task, step, inputs, provider, config = getAiProviderExecutionConfig(provider) }) {
  const basePrompt = promptFor(step, inputs);
  const deepseek = provider === 'DeepSeek';
  const qwen = provider === 'Qwen';
  const qwen38Flash = qwen && String(config?.effective_request_model || '').toLowerCase() === 'qwen3.8-flash';
  const qwenContract = qwen38Flash && step === 'LISTING_SOP_10' ? qwenSop10JsonPrompt(inputs) : null;
  const prompt = deepseek && step === 'LISTING_SOP_10' ? deepSeekSop10JsonPrompt(basePrompt, inputs)
    : qwenContract ? qwenContract.prompt : basePrompt;
  const qwenExecutionContract = qwen38Flash && step === 'LISTING_SOP_10' ? {
    api_protocol: 'CHAT_COMPLETIONS', structured_output: 'json_schema', reasoning_effort: 'none',
    preserve_thinking: false, max_completion_tokens: QWEN_SOP10_MAX_COMPLETION_TOKENS,
    schema_sha256: sha256(JSON.stringify(getListingSopJsonSchema(step))),
    evidence_projection: qwenContract?.compacted ? 'DEDUPLICATED_EXACT_REVIEW_MIRROR' : 'FULL_INPUT_RETAINED',
    request_contract_version: SOP10_QWEN_JSON_SCHEMA_LOW_THINKING_CONTRACT_VERSION,
  } : qwen && /^LISTING_SOP_1[0-7]$/.test(step) ? {
    api_protocol: 'CHAT_COMPLETIONS', structured_output: 'json_schema',
    schema_sha256: sha256(JSON.stringify(getListingSopJsonSchema(step))),
    request_contract_version: SOP10_17_QWEN_JSON_SCHEMA_CONTRACT_VERSION,
  } : null;
  if (!config.effective_request_model || !config.adapter_contract_version || !config.adapter_version)
    throw Object.assign(new Error('Provider execution contract is not registered.'), { code: 'AI_PROVIDER_EXECUTION_CONTRACT_MISSING' });
  return createAiGenerationIdentity({
    sku: task.sku, step, inputVersionRefs: inputs.input_version_refs, provider,
    promptContractVersion: step === 'LISTING_SOP_17' ? `${deepseek ? SOP10_17_DEEPSEEK_RESPONSES_PROMPT_CONTRACT_VERSION : 'SOP10_17_PROMPT_CONTRACT_V1'}:${SOP17_EVIDENCE_PACK_VERSION}`
      : step === 'LISTING_SOP_14' ? SOP10_17_SOP14_TITLE_PROMPT_CONTRACT_VERSION
        : deepseek ? SOP10_17_DEEPSEEK_RESPONSES_PROMPT_CONTRACT_VERSION
        : qwenExecutionContract ? (step === 'LISTING_SOP_10' && qwen38Flash ? SOP10_QWEN_JSON_SCHEMA_LOW_THINKING_CONTRACT_VERSION : SOP10_17_QWEN_JSON_SCHEMA_CONTRACT_VERSION) : 'SOP10_17_PROMPT_CONTRACT_V1',
    prompt, effectiveModel: config.effective_request_model,
    adapterContractVersion: config.adapter_contract_version, adapterVersion: config.adapter_version,
    executionContract: deepseek ? { api_protocol: 'RESPONSES', structured_output: 'json_schema', reasoning_effort: 'none',
      schema_sha256: sha256(JSON.stringify(getListingSopJsonSchema(step))), max_output_tokens: DEEPSEEK_LISTING_MAX_OUTPUT_TOKENS } : null,
    ...(qwenExecutionContract ? { executionContract: qwenExecutionContract } : {}),
  });
}

export async function buildSop10DeepSeekRecoveryIdentity(dataRoot, task) {
  const inputs = await resolveSop10To17Inputs(dataRoot, task, 'LISTING_SOP_10');
  const config = getAiProviderExecutionConfig('DeepSeek');
  if (!String(config.effective_request_model || '').trim()) {
    throw Object.assign(new Error('DeepSeek effective model is not registered.'), { code: 'AI_PROVIDER_EFFECTIVE_MODEL_MISSING' });
  }
  const identity = buildListingProviderGenerationIdentity({ task, step: 'LISTING_SOP_10', inputs, provider: 'DeepSeek', config });
  const qwenIdentity = buildListingProviderGenerationIdentity({ task, step: 'LISTING_SOP_10', inputs, provider: 'Qwen' });
  return { identity, qwen_identity: qwenIdentity, inputs, provider_config: {
    provider: config.provider, requested_model: config.requested_model,
    effective_request_model: config.effective_request_model,
    adapter_contract_version: config.adapter_contract_version || AI_PROVIDER_RESULT_CONTRACT_VERSION,
    adapter_version: config.adapter_version || 'NOT_REPORTED',
    ...identity.execution_contract,
  } };
}

export async function listingAiStepRoutePreflight(dataRoot, task, step, inputs) {
  const providers = {};
  let control = null;
  for (const provider of ['Qwen', 'DeepSeek']) {
    const identity = buildListingProviderGenerationIdentity({ task, step, inputs, provider });
    const cached = await getProviderPartialResult(dataRoot, identity);
    if (cached) { providers[provider] = { ready: true, route_readiness_source: 'CACHED_SUCCESS' }; continue; }
    if (await acceptanceControlledRetry(dataRoot, identity) || await acceptanceFailureResult(dataRoot, identity)) { providers[provider]={ready:true,route_readiness_source:'ACCEPTANCE_CONTROLLED_RECOVERY'}; continue; }
    const recovery = task.generation_recovery;
    if (recovery?.wait_context?.provider === provider && recovery.wait_context.step === step) {
      const route = await evaluateGenerationRecoveryRoute(dataRoot, { wait: recovery.wait_context, identity,
        consumedProbeId: recovery.probe_id, consumedCircuitState: recovery.circuit_state });
      providers[provider] = { ready: route.allowed, route_readiness_source: 'GENERATION_RECOVERY', reason_code: route.reason };
    } else {
      control ||= await getAiProviderReadiness(dataRoot);
      providers[provider] = { ...control.providers[provider.toUpperCase()], route_readiness_source: 'CONTROL_PLANE' };
    }
  }
  return { ready: Object.values(providers).every(item => item.ready === true), providers };
}

function parseObject(content, provider) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw Object.assign(new Error(`${provider} returned an invalid structured response.`), { code: 'AI_STRUCTURED_RESPONSE_INVALID', provider });
  }
}

export function qaSop10To17Output(step, output, inputs, task) {
  inputs = { ...inputs, evidence_refs: [...new Set([...(inputs.evidence_refs || []), ...Object.keys(indexLockedListingEvidence(inputs))])] };
  const resolution = step >= 'LISTING_SOP_11' ? validateListingEvidence(output, inputs) : null;
  if (resolution) inputs.evidence_refs = [...new Set([...inputs.evidence_refs, ...resolution.results.filter(r => r.status === 'EXISTS').map(r => r.evidence_ref)])];
  const qa = qaSop10To17BusinessOutput(step, output, inputs, task);
  if (!resolution) return qa;
  const check = { code: 'LISTING_EVIDENCE_RESOLVER', message: 'Every conclusion reference resolves in a locked input version and layer.', pass: resolution.status === 'PASS' };
  const checks = [...qa.checks, check];
  if(step==='LISTING_SOP_13' && Array.isArray(task.outputs?.top20?.records)) {
    const keywords=task.outputs.top20.records.map(r=>r.exact_string);
    const decisions=output.display_decisions || [];
    // SOP13's formal contract identifies both keyword and selling-point targets
    // through target_ref. Do not read a nonexistent exact_string property from
    // decisions: that made valid real outputs fail coverage QA.
    checks.push({code:'SOP13_EXACT_KEYWORD_COVERAGE',message:'Every formal TOP20 exact string has one independently preserved decision.',pass:keywords.every(word=>decisions.filter(r=>r.target_ref===word).length===1)});
  }
  return { ...qa, checks, failures: checks.filter(c => !c.pass), status: qa.status === 'PASS' && checks.every(c=>c.pass) ? 'PASS' : 'QA_FAIL', evidence_resolution: resolution };
}

/**
 * Verify exact SOP12 ref replacements against their real source bytes before
 * applying a cached-only repair. This does not broaden the resolver catalog:
 * replacements must point into the current locked SOP07 or Facts source.
 */
export async function verifySop12EvidenceRepairSources({ dataRoot, task, inputs, plan }) {
  const reject = reason => { throw Object.assign(new Error(reason), { code: 'LISTING_EVIDENCE_REPAIR_REJECTED' }); };
  if (plan?.step !== 'LISTING_SOP_12' || plan.sku !== task.sku || !Array.isArray(plan.repairs)) reject('SOP12 repair identity mismatch.');
  const root = path.resolve(dataRoot);
  const top20 = inputs.inputs?.LISTING_SOP_07;
  const resolver = createListingEvidenceResolver(inputs);
  const seen = new Set();
  for (const row of plan.repairs) {
    if (!row || typeof row.from !== 'string' || typeof row.to !== 'string' || seen.has(row.from)) reject('SOP12 repair row is malformed or duplicated.');
    seen.add(row.from);
    const hashAt = row.from.indexOf('#');
    if (hashAt < 1) reject('SOP12 source reference must include an exact pointer.');
    const sourceRef = row.from.slice(0, hashAt);
    const pointerText = decodeURIComponent(row.from.slice(hashAt + 1));
    const sourcePath = path.resolve(root, sourceRef);
    if (!sourcePath.startsWith(`${root}${path.sep}`)) reject('SOP12 source ref escapes dataRoot.');
    let bytes, source;
    try { bytes = await fs.readFile(sourcePath); source = JSON.parse(bytes.toString('utf8')); }
    catch { reject('SOP12 source ref is not readable JSON.'); }
    const sourceSha = sha256(bytes);
    if (sourceSha !== row.source_artifact_sha256) reject('SOP12 source artifact SHA mismatch.');
    const sourcePointer = readEvidencePointer(source, pointerText);
    if (!sourcePointer.exists || listingEvidenceValueSha256(sourcePointer.value) !== row.source_value_sha256) reject('SOP12 source pointer/value hash mismatch.');

    if (/\/sop03\//i.test(sourceRef)) {
      const lockedVersion = String(top20?.input_versions?.sop03 || '');
      const suffix = lockedVersion.startsWith('SOP03-SOURCES-') ? lockedVersion.slice('SOP03-SOURCES-'.length) : '';
      const expectedRef = `artifacts/listing/${task.sku}/sop03/${suffix}.json`;
      if (!suffix || sourceRef !== expectedRef || source.sku !== task.sku
        || source.artifact_type !== 'SOP03_SOURCE_DISCOVERY_VERSION') reject('SOP03 source does not match the exact version recorded by locked SOP07.');
    } else if (/\/sop04\//i.test(sourceRef)) {
      const lockedVersion = String(top20?.input_versions?.sop04 || '');
      const expectedRef = `artifacts/listing/${task.sku}/sop04/${lockedVersion}.json`;
      if (!lockedVersion || sourceRef !== expectedRef || source.sku !== task.sku
        || source.artifact_type !== 'BOL_RELATED_TERMS_SET' || String(source.version) !== lockedVersion) reject('SOP04 source does not match the exact version recorded by locked SOP07.');
    } else if (/^versions\//i.test(sourceRef)) {
      const match = sourceRef.match(new RegExp(`^versions/${task.sku}/(\\d{6})\\.json$`));
      const facts = source?.snapshot?.outputs?.confirmed_product_facts;
      const lockedFacts = inputs.evidence_artifacts?.find(item => item.reference === 'task:outputs.confirmed_product_facts'
        && item.sku === task.sku && item.layer === 'OWN_FACTS');
      if (!match || Number(source.version) !== Number(match[1]) || source.snapshot?.sku !== task.sku
        || !facts || !lockedFacts || listingEvidenceValueSha256(facts) !== listingEvidenceValueSha256(lockedFacts.data)
        || !pointerText.startsWith('/snapshot/outputs/confirmed_product_facts/')) reject('Historical Facts snapshot is not identical to the current SHA-locked Facts version.');
    } else reject('SOP12 repair source type is not allowed.');

    const target = resolver.resolve(row.to);
    if (target.status !== 'EXISTS' || target.resolved_value_sha256 !== row.target_value_sha256
      || row.source_value_sha256 !== row.target_value_sha256) reject('SOP12 replacement is not the same value in a verified locked input.');
  }
  return { verified: true, source_count: seen.size };
}

function qaSop10To17BusinessOutput(step, output, inputs, task) {
  if (step === 'LISTING_SOP_10') return qaListingSop10Contract(output, inputs);
  if (step === 'LISTING_SOP_11') return qaListingSop11Contract(output, inputs);
  if (step === 'LISTING_SOP_12') return qaListingSop12Contract(output, inputs);
  if (step === 'LISTING_SOP_13') return qaListingSop13Contract(output, inputs);
  if (step === 'LISTING_SOP_14') return qaListingSop14Title(output, task.outputs.confirmed_product_facts);
  if (step === 'LISTING_SOP_15') return qaListingSop15Anchors(output);
  if (step === 'LISTING_SOP_16') return qaListingSop16Description(output, task.outputs.confirmed_product_facts);
  if (step === 'LISTING_SOP_17') return qaListingSop17Final(task, output.semantic_qa || null);
  throw Object.assign(new Error(`QA missing for ${step}`), { code: 'SOP10_17_QA_NOT_REGISTERED' });
}

function hasForbiddenScoreKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenScoreKey);
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase();
    return FORBIDDEN_SCORE_KEYS.has(normalized) || /(^|_)score($|_)/.test(normalized)
      || (normalized.includes('weight') && typeof child === 'number') || normalized === 'weight_formula'
      || hasForbiddenScoreKey(child);
  });
}

export async function runListingSop10To17Step({ dataRoot, task, step, aiRequest = routeAiRequest, now = iso(), cachedOnly = false, evidenceRepairPlan = null, outputAmendment = null }) {
  const executorId = SOP10_17_EXECUTOR_IDS[step];
  if (!executorId) throw Object.assign(new Error(`No executor registered for ${step}.`), { code: 'LISTING_EXECUTOR_NOT_REGISTERED' });
  if(aiRequest===routeAiRequest) {
    const window=await acceptanceCloseoutWindow(dataRoot,task.sku,step);
    if(!['ACTIVE','NOT_APPLICABLE'].includes(window.status)) return {status:'PAUSED',reason:`ACCEPTANCE_AUTHORIZATION_${window.status}`,ai_provider_requests:0,external_requests:0};
  }
  const inputs = await resolveSop10To17Inputs(dataRoot, task, step);
  const system = '你是BOL荷兰市场Listing执行助手。必须保留事实来源边界和精确证据引用。';
  const prompt = promptFor(step, inputs);
  const qwenModel = String(getAiProviderExecutionConfig('Qwen').effective_request_model || '').toLowerCase();
  const qwenSop10 = step === 'LISTING_SOP_10' && qwenModel === 'qwen3.8-flash' ? qwenSop10JsonPrompt(inputs) : null;
  const qwenListingSchema = /^LISTING_SOP_1[0-7]$/.test(step) ? getListingSopJsonSchema(step) : null;
  const deepSeekPrompt = step === 'LISTING_SOP_10' ? deepSeekSop10JsonPrompt(prompt, inputs) : prompt;
  const realProviderExecution = aiRequest === routeAiRequest;
  const acceptancePolicy = realProviderExecution ? await readAcceptanceCloseout(dataRoot, task.sku, step) : null;
  const acceptanceRuntime = realProviderExecution && ACCEPTANCE_MODE && RUNTIME_MODE === 'NORMAL';
  const acceptanceFailures = {};
  const cachedPrimaryResults = {};
  const generationIdentities = {};
  const recordedGenerationResults = {};
  const generationRecoveryContext = {};
  const providerAttemptPolicies = {};
  const qwenAcceptanceGenerationOptions = resolveQwenListingGenerationOptions({
    acceptanceRuntime, effectiveModel: qwenModel, step,
  });
  if (realProviderExecution) {
    for (const provider of ['Qwen', 'DeepSeek']) {
      const config = getAiProviderExecutionConfig(provider);
      if (!String(config.effective_request_model || '').trim()) return {
        status: 'WAITING_DEPENDENCY', dependency: 'AI_PROVIDER_ADAPTER', reason: `${provider}:EFFECTIVE_MODEL_NOT_REGISTERED`,
        ai_provider_requests: 0, external_requests: 0,
      };
      const identity = buildListingProviderGenerationIdentity({ task, step, inputs, provider, config });
      if (!cachedOnly) await markStaleMismatchedPartials(dataRoot, identity);
      generationIdentities[provider] = identity;
      const cached = await getProviderPartialResult(dataRoot, identity);
      if (cached) {
        cachedPrimaryResults[provider] = { ...cached, identity };
        continue; // Local finalization needs neither a probe nor another generation permit.
      }
      const savedFailure = acceptancePolicy ? await acceptanceFailureResult(dataRoot, identity) : null;
      if(savedFailure){acceptanceFailures[provider]=savedFailure;continue;}
      if (cachedOnly) throw Object.assign(new Error(`${provider} has no reusable complete SUCCESS partial; Provider dispatch is forbidden.`), { code: 'LISTING_CACHED_FINALIZE_MISSING_PARTIAL', provider });
      const controlledRetry = acceptancePolicy && await acceptanceControlledRetry(dataRoot, identity);
      if (acceptancePolicy && await readAcceptanceCall(dataRoot, identity)) throw Object.assign(new Error('Controlled call already claimed'),{code:'ACCEPTANCE_SINGLE_CALL_ALREADY_CLAIMED'});
      const circuit = await getGenerationCircuit(dataRoot, identity);
      if (circuit.state === 'OPEN' && !controlledRetry) return {
        status: 'WAITING_DEPENDENCY', dependency: provider.toUpperCase(), reason: 'AI_GENERATION_CIRCUIT_OPEN',
        generation_wait: { generation_key: identity.generation_key, provider, effective_model: identity.effective_model,
          generation_failed_at: circuit.last_generation_failed_at, generation_failure_type: circuit.last_failure_type,
          required_generation_readiness_after: circuit.last_generation_failed_at, input_version_hash: identity.input_version_hash,
          prompt_contract_version: identity.prompt_contract_version, prompt_hash: identity.prompt_hash, sku: task.sku, step },
        ai_provider_requests: 0, external_requests: 0,
      };
      const recoveryWait = task.generation_recovery?.wait_context;
      if (!controlledRetry && recoveryWait?.provider === provider && recoveryWait?.step === step) {
        const recovery = await evaluateGenerationRecoveryRoute(dataRoot, {
          wait: recoveryWait, identity, consumedProbeId: task.generation_recovery?.probe_id,
          consumedCircuitState: task.generation_recovery?.circuit_state,
        });
        if (!recovery.allowed) return {
          status: 'WAITING_DEPENDENCY', dependency: provider.toUpperCase(), reason: recovery.reason || 'GENERATION_RECOVERY_GATE_CLOSED',
          ai_provider_requests: 0, external_requests: 0,
        };
        generationRecoveryContext[provider] = {
          wait: recoveryWait, identity, consumedProbeId: task.generation_recovery.probe_id,
          consumedCircuitState: task.generation_recovery.circuit_state,
          generation_timeout_ms: recovery.generation_timeout_ms,
        };
      }
      const timeoutDefaults = resolveAiTimeoutConfiguration();
      const providerAttemptPolicy = resolveProviderGenerationAttemptPolicy({
        provider, acceptancePolicy: Boolean(acceptancePolicy), acceptanceRuntime,
        recoveryTimeoutMs: generationRecoveryContext[provider]?.generation_timeout_ms,
        defaultTimeoutMs: timeoutDefaults.provider_generation_timeout_ms,
        defaultRetryLimit: acceptanceRuntime ? 0 : timeoutDefaults.adapter_transport_retry_limit,
      });
      providerAttemptPolicies[provider] = providerAttemptPolicy;
      await beginProviderGenerationAttempt(dataRoot, identity, {
        clientTimeoutMs: providerAttemptPolicy.timeout_ms,
        transportRetryLimit: providerAttemptPolicy.max_retries,
      });
    }
  }
  if (cachedOnly && !realProviderExecution) throw Object.assign(new Error('Cached finalization only accepts persisted real Provider results.'), { code: 'LISTING_CACHED_FINALIZE_REAL_REQUIRED' });
  const qwenRequestOptions = {
    ...(providerAttemptPolicies.Qwen || {}),
    ...qwenAcceptanceGenerationOptions,
    ...(qwenListingSchema ? {
      api_protocol: 'CHAT_COMPLETIONS', json_schema: qwenListingSchema, json_schema_name: step.toLowerCase(),
    } : {}),
    ...(qwenSop10 ? {
      ...(providerAttemptPolicies.Qwen || resolveProviderGenerationAttemptPolicy({ provider: 'Qwen', recoveryTimeoutMs: generationRecoveryContext.Qwen?.generation_timeout_ms })),
      api_protocol: 'CHAT_COMPLETIONS', json_schema: getListingSopJsonSchema(step), json_schema_name: step.toLowerCase(),
      reasoning_effort: 'none', preserve_thinking: false, max_completion_tokens: QWEN_SOP10_MAX_COMPLETION_TOKENS, max_retries: 0,
    } : {}),
  };
  const providerResult = cachedOnly ? {
    status: 'ROUTED', request_id: null, ai_request_count: 0,
    primary_results: ['Qwen', 'DeepSeek'].map(provider => acceptanceFailures[provider] || ({ ...cachedPrimaryResults[provider], status: 'PASS' })),
  } : await aiRequest(dataRoot, {
    sku: task.sku, module: step,
    system, prompt,
    provider_prompts: step === 'LISTING_SOP_10' ? { Qwen: qwenSop10?.prompt || prompt, DeepSeek: deepSeekPrompt }
      : step === 'LISTING_SOP_14' ? { DeepSeek: deepSeekPrompt } : {},
    context: { structured_response: true, evidence_refs: inputs.evidence_refs, sop08_context: inputs.sop08_context, low_competitor_pool_confidence: inputs.sop08_context.low_competitor_pool_confidence },
    max_output_tokens_by_provider: { DeepSeek: DEEPSEEK_LISTING_MAX_OUTPUT_TOKENS },
    acceptance_identities: acceptancePolicy ? generationIdentities : {},
    request_options_by_provider: {
      ...(Object.keys(qwenRequestOptions).length ? { Qwen: qwenRequestOptions } : {}),
      DeepSeek: {
      ...(providerAttemptPolicies.DeepSeek || {}),
      ...(acceptancePolicy ? {max_retries:0} : {}),
      api_protocol: 'RESPONSES', reasoning_effort: 'none', json_schema: getListingSopJsonSchema(step),
      json_schema_name: step.toLowerCase(),
      },
    },
    ...(realProviderExecution ? {
      cached_primary_results: cachedPrimaryResults,
      generation_recovery_context: generationRecoveryContext,
      on_provider_result: async result => {
        const identity = generationIdentities[result?.provider];
        if (!identity || result?.cache_status === 'CACHED_SUCCESS' || result?.status === 'CACHED_SUCCESS') return;
        recordedGenerationResults[result.provider] = await recordProviderGenerationResult(dataRoot, identity, result, { executionId: task.active_execution_id });
      },
    } : {}),
  });
  let degraded = null;
  if(acceptancePolicy && providerResult.primary_results){
    const passed=providerResult.primary_results.filter(r=>r.status==='PASS'), failed=providerResult.primary_results.filter(r=>r.status==='ERROR');
    if(passed.length===1 && failed.length===1){
      const failure=await acceptanceFailureResult(dataRoot,generationIdentities[failed[0].provider]);
      const schema=validateListingSopJsonSchema(parseObject(passed[0].content,passed[0].provider),getListingSopJsonSchema(step));
      if(failure && schema.valid){
        degraded={degraded_ai_mode:true,acceptance_only:true,runtime_instance:'ACCEPTANCE_4181',sku:task.sku,authorization_ref:acceptancePolicy.authorization_ref,run_id:acceptancePolicy.run_id,active_provider:passed[0].provider,failed_provider:failed[0].provider,failure_evidence_ref:failure.acceptance_failure_evidence_ref,dual_provider_production_pass:false};
        providerResult.status='ROUTED';
      }
    }
  }
  const aiRequestCount = Number.isInteger(providerResult?.ai_request_count) ? providerResult.ai_request_count : 0;
  const requestCounts = { ai_provider_requests: aiRequestCount, bol_amazon_external_requests: 0, external_requests: aiRequestCount };
  if(providerResult?.status==='PAUSED') return {status:'PAUSED',reason:providerResult.reason_code,provider_results:providerResult.primary_results||[],...requestCounts};
  if (providerResult?.status === 'WAITING_DEPENDENCY') {
    const failed = providerResult.primary_results?.find(item => item.status === 'ERROR' || item.status === 'WAITING_DEPENDENCY');
    const identity = generationIdentities[failed?.provider];
    const attemptMeta = failed?.attempt_metadata || {};
    const recorded = recordedGenerationResults[failed?.provider];
    const generationFailedAt = recorded?.generation_failed_at || attemptMeta.request_finished_at || null;
    const generationFailureType = recorded?.failure_type || null;
    return { status: 'WAITING_DEPENDENCY', dependency: failed?.provider?.toUpperCase() || providerResult.dependency || 'AI_PROVIDER_ADAPTER', reason: failed?.reason_code || providerResult.reason_code || 'AI_PROVIDER_NOT_READY',
      generation_wait: recorded && identity ? { sku: task.sku, step, input_version_hash: identity.input_version_hash,
        prompt_contract_version: identity.prompt_contract_version, prompt_hash: identity.prompt_hash, provider: identity.provider,
        effective_model: identity.effective_model, generation_key: identity.generation_key, generation_failed_at: generationFailedAt,
        generation_failure_type: generationFailureType, required_generation_readiness_after: generationFailedAt,
        configured_model: failed.requested_model || null, adapter_version: failed.adapter_version || identity.adapter_version,
        adapter_contract_version: identity.adapter_contract_version,
        request_trace_id: failed.request_id || null, attempt_metadata: recorded.attempt || attemptMeta } : null,
      provider_results: providerResult.primary_results || [], ...requestCounts };
  }
  if (providerResult?.status === 'WAITING_CONFIRMATION') return { status: 'WAITING_CONFIRMATION', reason: providerResult.reason_code || 'AI_ROUTER_CONFIRMATION_REQUIRED', ...requestCounts };
  if (providerResult?.status === 'ERROR') return { status: 'WAITING_DEPENDENCY', dependency: providerResult.dependency || 'AI_PROVIDER_ADAPTER', reason: providerResult.reason_code || 'AI_ROUTER_FAILED', ...requestCounts };
  if (!['ROUTED', 'ENHANCED'].includes(providerResult?.status)) throw Object.assign(new Error('AI Router did not produce a completed primary result.'), { code: providerResult?.reason_code || 'AI_ROUTER_FAILED' });
  const qwen = providerResult.primary_results?.find(item => item.provider === 'Qwen');
  const deepseek = providerResult.primary_results?.find(item => item.provider === 'DeepSeek');
  if (!degraded && (qwen?.status === 'WAITING_DEPENDENCY' || deepseek?.status === 'WAITING_DEPENDENCY' || !qwen || !deepseek)) {
    return { status: 'WAITING_DEPENDENCY', dependency: 'AI_PROVIDER_ADAPTER', reason: 'Qwen与DeepSeek主流程必须都可用。', provider_status: { Qwen: qwen?.status || 'NOT_CONFIGURED', DeepSeek: deepseek?.status || 'NOT_CONFIGURED' }, ...requestCounts };
  }
  if (!degraded && (qwen.status !== 'PASS' || deepseek.status !== 'PASS')) {
    const failures = [qwen, deepseek].filter(item => item.status !== 'PASS');
    const configFailure = failures.some(item => /CONFIG|CREDENTIAL|AUTH/.test(String(item.reason_code || '')));
    const dependency = configFailure ? 'AI_PROVIDER_CONFIG' : failures.length === 1 ? String(failures[0].provider).toUpperCase() : 'AI_PROVIDER_ADAPTER';
    const failed = failures[0];
    const identity = generationIdentities[failed.provider];
    const attemptMeta = failed.attempt_metadata || {};
    const recorded = recordedGenerationResults[failed.provider];
    const failureAt = recorded?.generation_failed_at || attemptMeta.request_finished_at || null;
    return { status: 'WAITING_DEPENDENCY', dependency, reason: failures.map(item => `${item.provider}:${item.reason_code || item.status}`).join(', '),
      provider_status: { Qwen: qwen.status, DeepSeek: deepseek.status }, provider_results: providerResult.primary_results || [],
      generation_wait: recorded && identity ? { sku: task.sku, step, input_version_hash: identity.input_version_hash,
        prompt_contract_version: identity.prompt_contract_version, prompt_hash: identity.prompt_hash, provider: identity.provider,
        effective_model: identity.effective_model, generation_key: identity.generation_key, generation_failed_at: failureAt,
        generation_failure_type: recorded.failure_type, required_generation_readiness_after: failureAt,
        configured_model: failed.requested_model || null, adapter_version: failed.adapter_version || identity.adapter_version,
        adapter_contract_version: identity.adapter_contract_version,
        request_trace_id: failed.request_id || null, attempt_metadata: recorded.attempt || attemptMeta } : null,
      ...requestCounts };
  }
  if (realProviderExecution) {
    const failedRecordProvider = [qwen, deepseek].filter(r=>r.status==='PASS').find(item => !cachedPrimaryResults[item.provider]
      && recordedGenerationResults[item.provider]?.partial_status !== 'SUCCESS');
    if (failedRecordProvider) {
      const identity = generationIdentities[failedRecordProvider.provider];
      const recorded = recordedGenerationResults[failedRecordProvider.provider];
      const generationFailedAt = recorded?.generation_failed_at || recorded?.attempt?.request_finished_at || iso();
      return { status: 'WAITING_DEPENDENCY', dependency: failedRecordProvider.provider.toUpperCase(),
        reason: recorded?.failure_type || 'PROVIDER_STRUCTURED_RESULT_INVALID', provider_results: providerResult.primary_results || [],
        generation_wait: { sku: task.sku, step, input_version_hash: identity.input_version_hash,
          prompt_contract_version: identity.prompt_contract_version, prompt_hash: identity.prompt_hash, provider: identity.provider,
          effective_model: identity.effective_model, generation_key: identity.generation_key, generation_failed_at: generationFailedAt,
          generation_failure_type: recorded?.failure_type || 'PROVIDER_SCHEMA_INVALID', required_generation_readiness_after: generationFailedAt,
          configured_model: failedRecordProvider.requested_model || null, adapter_version: failedRecordProvider.adapter_version || identity.adapter_version,
          adapter_contract_version: identity.adapter_contract_version, request_trace_id: failedRecordProvider.request_id || null,
          attempt_metadata: recorded?.attempt || failedRecordProvider.attempt_metadata || {} },
        ...requestCounts };
    }
  }
  const qwenObject = qwen.status==='PASS' ? parseObject(qwen.content,'Qwen') : null;
  const deepseekObject = deepseek.status==='PASS' ? parseObject(deepseek.content,'DeepSeek') : qwenObject;
  if (hasForbiddenScoreKey(deepseekObject)) throw Object.assign(new Error('SOP13 deprecated scoring fields are forbidden.'), { code: 'SOP13_FORBIDDEN_SCORING_FIELD' });

  const aiModelProvenance = await buildAiModelProvenance({
    step, providerResults: [qwen, deepseek].filter(r=>r.status==='PASS'), acceptanceDegraded:degraded, requestTraceId: providerResult.request_id || null,
    executionKind: realProviderExecution ? 'REAL_PROVIDER' : 'OFFLINE_FIXTURE',
  });
  const provenanceQa = qaAiModelProvenance(aiModelProvenance, { requireReal: realProviderExecution, expectedStep: step, acceptanceDegraded:degraded });

  let output = {
    ...deepseekObject,
    ...(degraded ? {acceptance_degraded_ai:degraded,degraded_ai_mode:true,production_dual_provider_accepted:false} : {}),
    artifact_type: OUTPUT_TYPES[step], sku: task.sku, sop_step_id: step,
    execution_kind: realProviderExecution ? 'REAL_PROVIDER' : 'OFFLINE_FIXTURE',
    provider_trace: {
      request_id: providerResult.request_id || null,
      providers: [qwen, deepseek].map(item => ({ provider: item.provider, model: item.model || null, version: item.version || null, request_id: item.request_id || null })),
      qwen_extraction: qwenObject,
    },
    ...(realProviderExecution ? { ai_model_provenance: aiModelProvenance } : {}),
    input_version_refs: inputs.input_version_refs,
    facts_version: inputs.facts_version,
    low_competitor_pool_confidence: inputs.sop08_context.low_competitor_pool_confidence === true,
    competitor_influence_ceiling: inputs.sop08_context.low_competitor_pool_confidence === true ? 'B_REFERENCE_LIMITED' : (deepseekObject.competitor_influence_ceiling || null),
    // Formal output may cite only the evidence the provider actually used.
    // The locked-input inventory is available in the prompt/index, but copying
    // every input reference into the conclusion would falsely imply support
    // (and would make unrelated missing source files look like cited evidence).
    evidence_refs: [...new Set(deepseekObject.evidence_refs || [])],
    generated_at: now,
  };
  if (step === 'LISTING_SOP_17') output.semantic_qa = deepseekObject.semantic_qa || deepseekObject;
  if (outputAmendment) {
    if (!cachedOnly || !acceptancePolicy) throw Object.assign(new Error('Local amendment requires authorized cached finalization'),{code:'LISTING_AMENDMENT_REJECTED'});
    output = applyListingOutputAmendment(output, inputs, outputAmendment);
  }
  if (evidenceRepairPlan) {
    if (!cachedOnly) throw Object.assign(new Error('Evidence repair requires cached-only finalization.'), { code: 'LISTING_EVIDENCE_REPAIR_REQUIRES_CACHED_ONLY' });
    if (step === 'LISTING_SOP_12') await verifySop12EvidenceRepairSources({ dataRoot, task, inputs, plan: evidenceRepairPlan });
    output = applyListingEvidenceRepair(output, inputs, evidenceRepairPlan);
  }
  output.evidence_reference_index = indexLockedListingEvidence(inputs);
  const businessQa = qaSop10To17Output(step, output, inputs, task);
  const provenanceChecks = realProviderExecution
    ? provenanceQa.checks
    : [{ code: 'AI_PROVENANCE_OFFLINE_FIXTURE_ISOLATED', message: 'Offline fixture output is test-only and carries no formal real-AI provenance.', pass: true }];
  const qa = {
    ...businessQa,
    checks: [...(businessQa.checks || []), ...provenanceChecks],
    failures: [...(businessQa.failures || []), ...provenanceQa.failures],
    status: businessQa.status === 'PASS' && provenanceQa.status === 'PASS' ? 'PASS' : (businessQa.status === 'WAITING_DEPENDENCY' ? 'WAITING_DEPENDENCY' : 'QA_FAIL'),
  };
  if (qa.status !== 'PASS') return { status: qa.status === 'WAITING_DEPENDENCY' ? 'WAITING_DEPENDENCY' : 'QA_FAIL', output, qa, inputs, ...requestCounts };

  const digestPayload = { step, inputs: inputs.input_version_refs, output };
  const version = `${step.replace('LISTING_SOP_', 'SOP')}-${sha256(jsonBytes(digestPayload)).slice(0, 20)}`;
  output.version = version;
  output.status = 'PASS';
  output.qa_status = 'PASS';
  const outputKey = OUTPUT_KEYS[step];
  const safeSku = String(task.sku).replace(/[^A-Za-z0-9_-]/g, '_');
  const outDir = path.join(dataRoot, 'artifacts', 'listing', safeSku, step.toLowerCase(), version);
  await fs.mkdir(outDir, { recursive: true });
  const resultRef = path.join('artifacts', 'listing', safeSku, step.toLowerCase(), version, 'result.json').replace(/\\/g, '/');
  const qaRef = path.join('artifacts', 'listing', safeSku, step.toLowerCase(), version, 'qa.json').replace(/\\/g, '/');
  const resultFile = path.join(dataRoot, resultRef);
  const qaFile = path.join(dataRoot, qaRef);
  const resultArtifact = { ...output, evidence: { version, artifact_ref: resultRef, qa_ref: qaRef,
    // Keep the input manifest separate from the evidence actually cited by
    // conclusions. Stage QA resolves conclusion refs; input inventory belongs
    // only in source_references and must not be promoted to claimed support.
    evidence_refs: output.evidence_refs || [], source_references: inputs.input_version_refs,
    sha256: sha256(jsonBytes(output)), ...requestCounts } };
  await fs.writeFile(resultFile, jsonBytes(resultArtifact), { flag: 'wx' });
  await fs.writeFile(qaFile, jsonBytes({ ...qa, version, ...requestCounts }), { flag: 'wx' });
  const taskOutput = { ...resultArtifact, output_key: outputKey, open_error_count: 0 };
  return { status: 'PASS', step, executor_id: executorId, version, output: taskOutput, qa: { ...qa, version, evidence_ref: qaRef }, input_version_refs: inputs.input_version_refs, ...requestCounts, provider_trace_id: providerResult.request_id || null };
}

export function sop10To17OutputKey(step) { return OUTPUT_KEYS[step] || null; }
