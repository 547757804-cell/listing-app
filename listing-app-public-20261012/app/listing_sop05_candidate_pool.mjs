import crypto from 'node:crypto';
import { selectSop04SeedFromFacts } from './listing_sop04_seed_selector.mjs';

export const LISTING_SOP05_EXECUTOR_ID = 'SOP05_KEYWORD_CANDIDATE_POOL_EXECUTOR';
export const LISTING_SOP05_POLICY_VERSION = 'SOP05_RULE_BASED_EXACT_CANDIDATE_FILTER_V1';

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'volume', 'total', 'displayed_volume', 'search_volume', 'boloo_search_volume',
  'volume_score', 'relevance_score', 'final_score', 'final_keyword_score', 'rank_score',
]);

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value : '';
const isUrl = value => /^https?:\/\//iu.test(value) || /^(?:www\.)?bol\.com\//iu.test(value);
const hasCjk = value => /[\u3400-\u9fff]/u.test(value);
const localDutchLanguage = value => ['nl', 'nl-nl', 'dutch', 'nederlands'].includes(String(value || '').trim().toLocaleLowerCase());

function sourceExact(raw) {
  if (typeof raw === 'string') return raw;
  return text(raw?.exact_string ?? raw?.keyword ?? raw?.searchTerm);
}

function confirmedFactFields(facts) {
  return Object.fromEntries(Object.entries(facts?.fields || {}).filter(([, item]) => item?.status === 'CONFIRMED'));
}

function factTextFor(fields, fieldIds) {
  return fieldIds.map(id => text(fields[id]?.value)).filter(Boolean).join('\n').toLocaleLowerCase();
}

// These bridges only classify an exact expression already returned by a
// Netherlands-market source. They never translate or create a query string.
const EXISTING_EXACT_FACT_BRIDGES = Object.freeze([
  { exact: 'kralen', cues: ['串珠', '珠子', '珠串'], fields: ['name', 'product_facts.procurement_name'], category: 'ATTRIBUTE_MATERIAL', reason: '已有荷兰语 exact string 与已确认串珠事实相符。' },
  { exact: 'lichtsnoer', cues: ['灯串', '带灯串', '灯带'], fields: ['product_facts.procurement_name'], category: 'ATTRIBUTE_MATERIAL', reason: '已有荷兰语 exact string 与已确认包装/配置中的灯串事实相符。' },
  { exact: 'kerstdecoratie', cues: ['圣诞树', '圣诞装饰'], fields: ['name', 'product_facts.category', 'product_facts.procurement_name'], category: 'CHRISTMAS_SCENARIO', reason: '已有荷兰语 exact string 与已确认圣诞产品场景相符。' },
  { exact: 'doe-het-zelf', cues: ['diy', '手工制作', '手工'], fields: ['name', 'product_facts.procurement_name'], category: 'GENERIC', reason: '已有荷兰语 exact string 与已确认 DIY/手工套装事实相符。' },
]);

function exactFactBridge(exact, fields) {
  const candidate = exact.toLocaleLowerCase();
  const bridge = EXISTING_EXACT_FACT_BRIDGES.find(item => item.exact === candidate);
  if (!bridge) return null;
  const sourceText = factTextFor(fields, bridge.fields);
  const matchedCue = bridge.cues.find(cue => sourceText.includes(cue.toLocaleLowerCase()));
  return matchedCue ? { category: bridge.category, reason: bridge.reason, fact_ids: bridge.fields.filter(id => fields[id]?.status === 'CONFIRMED'), matched_fact_cue: matchedCue } : null;
}

function sourcePointerLink({ descriptor, pointer, evidenceLayer }) {
  return {
    evidence_ref: `${descriptor.reference}#${pointer}`,
    artifact_version: String(descriptor.version),
    artifact_type: descriptor.artifact_type,
    artifact_sha256: descriptor.sha256,
    evidence_layer: evidenceLayer,
  };
}

function normalizeEvidenceRef(row, dataRoot) {
  const evidence = row?.evidence_refs;
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(item => item && item.persisted === true && item.matches_request === true && typeof item.reference === 'string')
    .map(item => {
      const rawDescriptor = dataRoot?.rawEvidenceBySource?.[row.source_id];
      if (!rawDescriptor) return null;
      return {
        reference: rawDescriptor.reference,
        version: String(row.result_version || row.provider_request_id || ''),
        artifact_type: 'BOLOO_RAW_DOM_EVIDENCE',
        sha256: rawDescriptor.sha256,
        layer: 'SOURCE_EVIDENCE',
        data: rawDescriptor.data,
        source_row: row,
      };
    }).filter(Boolean);
}

function createCandidateSource({ sourceType, sourceId, sourceVersion, sourceUrl = null, sourceSeed = null, sourceLanguage = 'nl-NL', evidenceLinks, factIds = [], category, sourceOrder, rationale }) {
  return {
    source_type: sourceType,
    source_id: sourceId || null,
    source_version: String(sourceVersion || ''),
    source_url: sourceUrl,
    source_seed: sourceSeed,
    source_language: sourceLanguage,
    category,
    source_order: sourceOrder,
    selection_reason: rationale || null,
    fact_ids: [...new Set(factIds)],
    evidence_links: evidenceLinks,
  };
}

function candidateDecision(exact, sources, { adopted, seedCore, bridge, explicitExclusion } = {}) {
  if (explicitExclusion) return {
    status: 'EXCLUDED', eligibility_status: 'EXCLUDED', keyword_category: null,
    selection_reason: null, exclusion_reason: explicitExclusion,
  };
  if (adopted) return {
    status: 'ACTIVE', eligibility_status: 'ELIGIBLE_FOR_SOP06',
    keyword_category: seedCore ? 'CORE_PRODUCT' : (bridge?.category || 'CORE_PRODUCT'),
    selection_reason: `已正式采用于当前 SKU 的 SOP04 关联词集合；保留原 exact string。${seedCore ? '当前确认产品事实支持其核心产品表达。' : bridge?.reason || 'SOP04 已按当前产品事实确认其相关性。'}`,
    exclusion_reason: null,
  };
  if (seedCore) return {
    status: 'ACTIVE', eligibility_status: 'ELIGIBLE_FOR_SOP06', keyword_category: 'CORE_PRODUCT',
    selection_reason: seedCore.classification_reason,
    exclusion_reason: null,
  };
  if (bridge) return {
    status: 'ACTIVE', eligibility_status: 'ELIGIBLE_FOR_SOP06', keyword_category: bridge.category,
    selection_reason: bridge.reason,
    exclusion_reason: null,
  };
  const lower = exact.toLocaleLowerCase();
  const reason = lower === 'handgemaakt'
    ? 'EXCLUDED_UNCONFIRMED_MANUFACTURING_CLAIM: 当前确认事实没有证明该产品由人工制作。'
    : lower === 'tafeldecoratie'
      ? 'EXCLUDED_UNCONFIRMED_USE_CASE: 当前确认事实没有证明该商品专用于桌面装饰。'
      : lower === 'ornamenten'
        ? 'EXCLUDED_UNCONFIRMED_PRODUCT_FORM: 当前确认事实没有证明包装包含独立装饰挂件/饰品。'
        : 'EXCLUDED_NO_VERIFIABLE_FACT_LINK: 现有确认事实无法支持该来源表达用于当前商品。';
  return { status: 'EXCLUDED', eligibility_status: 'EXCLUDED', keyword_category: null, selection_reason: null, exclusion_reason: reason };
}

function candidateVersionBody(artifact) {
  return {
    schema_version: artifact.schema_version,
    artifact_type: artifact.artifact_type,
    sop_step_id: artifact.sop_step_id,
    sku: artifact.sku,
    input_versions: artifact.input_versions,
    candidate_pool_status: artifact.candidate_pool_status,
    selection_policy: artifact.selection_policy,
    source_coverage: artifact.source_coverage,
    candidates: artifact.candidates,
    selected_for_sop06_count: artifact.selected_for_sop06_count,
  };
}

/**
 * Build a rule-only SOP05 pool from already persisted source artifacts.
 * Strings are never normalized, translated, merged semantically, or scored.
 */
export function buildListingSop05CandidatePool({
  sku, facts, sop03, sop04, factsSnapshotRef, sop03Ref, sop04Ref,
  rawEvidenceBySource = {}, createdAt = new Date().toISOString(),
} = {}) {
  if (!sku || facts?.sku !== sku || facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION'
    || sop03?.sku !== sku || sop03?.artifact_type !== 'SOP03_SOURCE_DISCOVERY_VERSION'
    || sop04?.sku !== sku || sop04?.artifact_type !== 'BOL_RELATED_TERMS_SET') {
    throw Object.assign(new Error('SOP05 inputs must be the current SKU facts, SOP03 and SOP04 artifacts.'), { code: 'SOP05_INPUT_IDENTITY_INVALID' });
  }
  if (!factsSnapshotRef?.reference || !factsSnapshotRef?.sha256 || !sop03Ref?.reference || !sop03Ref?.sha256
    || !sop04Ref?.reference || !sop04Ref?.sha256) {
    throw Object.assign(new Error('SOP05 requires verified immutable input references.'), { code: 'SOP05_INPUT_EVIDENCE_MISSING' });
  }

  const factsFields = confirmedFactFields(facts);
  const factSelector = selectSop04SeedFromFacts({ facts, sourceRows: sop03.boloo_competitor_extractor || [], sop03ArtifactVersion: sop03Ref.version });
  const coreByExact = new Map((factSelector.candidates || []).filter(item => item.eligibility === 'CORE_PRODUCT_NOUN')
    .map(item => [item.exact_string, item]));
  const adoptedTerms = Array.isArray(sop04.adopted_terms) ? sop04.adopted_terms : [];
  const adoptedByExact = new Map(adoptedTerms.map((term, index) => [text(term?.exact_string), { ...term, adopted_index: index }]).filter(([exact]) => exact));
  const excludedByExact = new Map((sop04.excluded_terms || []).map(item => [text(item?.exact_string), item]).filter(([exact]) => exact));
  const draft = new Map();
  const sourceCoverage = {
    bol_local_keyword_mining: { status: sop03.bol_local_source?.keyword_mining?.status || 'NOT_RUN', source_count: Number(sop03.bol_local_source?.keyword_mining?.source_count || 0), expression_count: 0 },
    boloo_extractor: { source_count: Array.isArray(sop03.boloo_competitor_extractor) ? sop03.boloo_competitor_extractor.length : 0, pass_sources: 0, pass_no_result_sources: 0, exact_expression_count: 0 },
    amazon_source: { status: sop03.amazon_local_source?.status || 'UNKNOWN', language: sop03.amazon_local_source?.language || null, expression_count: 0, non_dutch_evidence_only_count: 0 },
    sop04_search_terms: { adopted_count: adoptedTerms.length, raw_terms_seen: 0, raw_not_adopted_count: 0 },
    invalid_or_non_candidate_expressions: 0,
  };

  const add = (exact, source, order) => {
    if (typeof exact !== 'string' || !exact || exact.trim() !== exact || isUrl(exact) || hasCjk(exact)) {
      sourceCoverage.invalid_or_non_candidate_expressions += 1;
      return;
    }
    const current = draft.get(exact) || { exact_string: exact, sources: [], order: draft.size };
    const sourceKey = canonical({ source_type: source.source_type, source_id: source.source_id, source_version: source.source_version, source_seed: source.source_seed, evidence_links: source.evidence_links });
    if (!current.sources.some(item => canonical({ source_type: item.source_type, source_id: item.source_id, source_version: item.source_version, source_seed: item.source_seed, evidence_links: item.evidence_links }) === sourceKey)) current.sources.push({ ...source, source_order: order });
    draft.set(exact, current);
  };

  let order = 0;
  const localMining = sop03.bol_local_source?.keyword_mining;
  for (let i = 0; i < (Array.isArray(localMining?.exact_strings) ? localMining.exact_strings.length : 0); i += 1) {
    const row = localMining.exact_strings[i];
    const exact = sourceExact(row);
    const evidenceLinks = [];
    if (sop03Ref?.reference && exact) evidenceLinks.push(sourcePointerLink({ descriptor: sop03Ref, pointer: `/bol_local_source/keyword_mining/exact_strings/${i}${typeof row === 'string' ? '' : '/exact_string'}`, evidenceLayer: 'SOURCE_EVIDENCE' }));
    const sourceUrl = row?.source_url || sop03.bol_local_source?.source_url || null;
    add(exact, createCandidateSource({ sourceType: 'BOL_LOCAL_MINING', sourceId: row?.source_id || `BOL_LOCAL_MINING_${i + 1}`, sourceVersion: sop03Ref.version, sourceUrl, sourceLanguage: 'nl-NL', evidenceLinks, category: 'BOL_LOCAL', sourceOrder: order++, rationale: '已存在的荷兰语 BOL 本地 keyword-mining 表达；按 exact string 保留。' }), order);
    if (exact) sourceCoverage.bol_local_keyword_mining.expression_count += 1;
  }

  const extractorRows = Array.isArray(sop03.boloo_competitor_extractor) ? sop03.boloo_competitor_extractor : [];
  for (let sourceIndex = 0; sourceIndex < extractorRows.length; sourceIndex += 1) {
    const row = extractorRows[sourceIndex];
    if (row?.status === 'PASS_NO_RESULT') { sourceCoverage.boloo_extractor.pass_no_result_sources += 1; continue; }
    if (row?.status !== 'PASS') continue;
    sourceCoverage.boloo_extractor.pass_sources += 1;
    const raw = rawEvidenceBySource[row.source_id];
    const terms = Array.isArray(row.exact_strings) ? row.exact_strings : [];
    const rawTerms = raw?.data?.raw_response?.keywords;
    if (!raw || !Array.isArray(rawTerms) || raw.data?.request_id !== row.provider_request_id
      || raw.data?.query_text !== row.source_url || terms.length !== rawTerms.length) {
      throw Object.assign(new Error(`PASS Boloo Extractor ${row.source_id} lacks matching persisted RAW/DOM evidence.`), { code: 'SOP05_EXTRACTOR_EVIDENCE_MISMATCH', source_id: row.source_id });
    }
    for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
      const term = terms[termIndex];
      const exact = sourceExact(term);
      const rawExact = sourceExact(rawTerms[termIndex]);
      if (!exact || rawExact !== exact) throw Object.assign(new Error(`Extractor exact string does not match persisted RAW/DOM result for ${row.source_id}.`), { code: 'SOP05_EXTRACTOR_TERM_MISMATCH', source_id: row.source_id });
      const sourcePointer = `/boloo_competitor_extractor/${sourceIndex}/exact_strings/${termIndex}${typeof term === 'string' ? '' : (Object.hasOwn(term, 'keyword') ? '/keyword' : '/exact_string')}`;
      const rawPointer = `/raw_response/keywords/${termIndex}/keyword`;
      const links = [
        sourcePointerLink({ descriptor: sop03Ref, pointer: sourcePointer, evidenceLayer: 'SOURCE_EVIDENCE' }),
        sourcePointerLink({ descriptor: raw, pointer: rawPointer, evidenceLayer: 'SOURCE_EVIDENCE' }),
      ];
      add(exact, createCandidateSource({ sourceType: 'BOLOO_EXTRACTOR', sourceId: row.source_id, sourceVersion: row.result_version,
        sourceUrl: row.source_url, sourceLanguage: 'nl-NL', evidenceLinks: links, category: 'BOLOO_COMPETITOR',
        sourceOrder: order++, rationale: '已存在的 BOL NL 商品页 Boloo Extractor exact string；只复用原始词，不读取或使用页面数字。' }), order);
      sourceCoverage.boloo_extractor.exact_expression_count += 1;
    }
  }

  const amazon = sop03.amazon_local_source || {};
  const amazonExpressions = Array.isArray(amazon.expressions) ? amazon.expressions : [];
  if (!localDutchLanguage(amazon.language)) sourceCoverage.amazon_source.non_dutch_evidence_only_count = amazonExpressions.length;
  else {
    for (let i = 0; i < amazonExpressions.length; i += 1) {
      const row = amazonExpressions[i];
      const exact = sourceExact(row);
      const links = sop03Ref?.reference && exact
        ? [sourcePointerLink({ descriptor: sop03Ref, pointer: `/amazon_local_source/expressions/${i}${typeof row === 'string' ? '' : '/exact_string'}`, evidenceLayer: 'SOURCE_EVIDENCE' })]
        : [];
      add(exact, createCandidateSource({ sourceType: 'AMAZON_SOURCE', sourceId: row?.source_id || `AMAZON_DUTCH_${i + 1}`, sourceVersion: sop03Ref.version,
        sourceUrl: row?.source_url || amazon.source_url || null, sourceLanguage: amazon.language, evidenceLinks: links, category: 'AMAZON_LOCAL',
        sourceOrder: order++, rationale: '来源明确为荷兰语表达；作为 source candidate 保存，未从 Amazon 派生搜索量。' }), order);
      if (exact) sourceCoverage.amazon_source.expression_count += 1;
    }
  }

  const allRawTerms = [
    ...(sop04.source_query_artifacts || []).flatMap(item => Array.isArray(item.returned_raw_terms) ? item.returned_raw_terms : []),
    ...(Array.isArray(sop04.returned_raw_terms) ? sop04.returned_raw_terms : []),
  ];
  sourceCoverage.sop04_search_terms.raw_terms_seen = allRawTerms.length;
  sourceCoverage.sop04_search_terms.raw_not_adopted_count = Math.max(0, allRawTerms.length - adoptedTerms.length);
  const queryArtifacts = [
    ...(sop04.source_query_artifacts || []),
    { seed_exact_string: sop04.last_seed_exact_string || sop04.seed_exact_string, returned_raw_terms: sop04.returned_raw_terms || [] },
  ];
  for (const [exact, adopted] of adoptedByExact) {
    const seed = text(adopted.source_seed_exact_string || adopted.seed_exact_string);
    const query = queryArtifacts.find(item => item.seed_exact_string === seed);
    const termIndex = (query?.returned_raw_terms || []).findIndex(item => item?.searchTerm === exact);
    if (!seed || !query || termIndex < 0) throw Object.assign(new Error(`SOP04 adopted exact string lacks a matching saved raw response or source seed: ${exact}`), { code: 'SOP05_SOP04_ADOPTED_TERM_UNTRACEABLE', exact_string: exact });
    const links = [sourcePointerLink({ descriptor: sop04Ref, pointer: `/adopted_terms/${adopted.adopted_index}/exact_string`, evidenceLayer: 'LISTING_ARTIFACT' })];
    const queryIndex = (sop04.source_query_artifacts || []).indexOf(query);
    const rawPointer = queryIndex >= 0
      ? `/source_query_artifacts/${queryIndex}/returned_raw_terms/${termIndex}/searchTerm`
      : `/returned_raw_terms/${termIndex}/searchTerm`;
    links.push(sourcePointerLink({ descriptor: sop04Ref, pointer: rawPointer, evidenceLayer: 'LISTING_ARTIFACT' }));
    add(exact, createCandidateSource({ sourceType: 'BOL_SEARCH_TERMS', sourceId: `SOP04_${seed}`, sourceVersion: sop04Ref.version,
      sourceUrl: null, sourceSeed: seed, sourceLanguage: 'nl-NL', evidenceLinks: links,
      category: (coreByExact.has(exact) || /(?:kerstboom|knutselset)/u.test(exact)) ? 'CORE_PRODUCT' : 'BOL_RELATED_TERM',
      sourceOrder: order++, rationale: adopted.relevance_reason || 'Leon在当前SKU的正式SOP04结果中采用该 exact string。' }), order);
  }

  const factsManifest = factsSnapshotRef;
  const candidateList = [...draft.values()].sort((a, b) => a.order - b.order).map((item, index) => {
    const coreMatch = coreByExact.get(item.exact_string);
    const bridge = exactFactBridge(item.exact_string, factsFields);
    const adopted = adoptedByExact.has(item.exact_string);
    const explicitExclusion = excludedByExact.has(item.exact_string)
      ? `SOP04 已明确排除：${excludedByExact.get(item.exact_string).exclusion_reason || excludedByExact.get(item.exact_string).reason || '按当前SKU事实不匹配。'}`
      : null;
    const decision = candidateDecision(item.exact_string, item.sources, { adopted, seedCore: coreMatch, bridge, explicitExclusion });
    const selectedFactIds = adopted
      ? (coreMatch?.core_matches?.length ? ['name', 'product_facts.category', 'product_facts.procurement_name'] : (bridge?.fact_ids || ['name', 'product_facts.procurement_name']))
      : (coreMatch ? ['name', 'product_facts.category', 'product_facts.procurement_name'] : (bridge?.fact_ids || []));
    const factLinks = [...new Set(selectedFactIds)].filter(id => factsFields[id]).map(id => {
      const pointer = `/snapshot/outputs/confirmed_product_facts/fields/${id.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      const link = sourcePointerLink({ descriptor: factsManifest, pointer, evidenceLayer: 'OWN_FACTS' });
      return { ...link, fact_id: id };
    });
    const sourceRefs = item.sources.map(source => ({ ...source, evidence_links: [...source.evidence_links, ...factLinks] }));
    const evidenceRefs = [...new Set(sourceRefs.flatMap(source => source.evidence_links.map(link => link.evidence_ref)))];
    const candidateId = `${sku}:SOP05:${sha256(`${item.exact_string}\n${canonical(sourceRefs.map(source => [source.source_type, source.source_id, source.source_version]))}`).slice(0, 16)}`;
    return {
      candidate_id: candidateId,
      ordinal: index + 1,
      exact_string: item.exact_string,
      status: decision.status,
      eligibility_status: decision.eligibility_status,
      keyword_category: decision.keyword_category,
      sources: sourceRefs,
      source_refs: sourceRefs.map(source => ({ source_type: source.source_type, source_id: source.source_id, source_version: source.source_version, source_url: source.source_url, source_seed: source.source_seed })),
      evidence_refs: evidenceRefs,
      selection_reason: decision.selection_reason,
      exclusion_reason: decision.exclusion_reason,
    };
  });

  const active = candidateList.filter(item => item.status === 'ACTIVE' && item.eligibility_status === 'ELIGIBLE_FOR_SOP06');
  const artifact = {
    schema_version: 1,
    artifact_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL',
    sop_step_id: 'LISTING_SOP_05',
    sku,
    status: 'PENDING_QA',
    qa_status: 'NOT_RUN',
    candidate_pool_status: 'CLOSED_FROM_CURRENT_APPROVED_SOURCES',
    selection_policy: LISTING_SOP05_POLICY_VERSION,
    input_versions: {
      confirmed_product_facts_version: facts.version,
      facts_snapshot_revision: factsManifest.version,
      sop03_artifact_version: sop03Ref.version,
      sop04_artifact_version: sop04Ref.version,
    },
    input_artifacts: [factsManifest, sop03Ref, sop04Ref].map(item => ({
      reference: item.reference, version: String(item.version), artifact_type: item.artifact_type,
      sha256: item.sha256, layer: item.layer,
    })),
    candidates: candidateList,
    candidate_count: candidateList.length,
    selected_for_sop06_count: active.length,
    excluded_count: candidateList.length - active.length,
    source_coverage: sourceCoverage,
    no_scores_or_search_volume: true,
    evidence: { evidence_refs: [...new Set(candidateList.flatMap(item => item.evidence_refs))], artifact_ref: null },
    created_at: createdAt,
  };
  artifact.version = `SOP05-${sha256(canonical(candidateVersionBody(artifact))).slice(0, 20)}`;
  return artifact;
}

function forbiddenKeys(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { for (const item of value) forbiddenKeys(item, found); return found; }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) found.push(key);
    forbiddenKeys(child, found);
  }
  return found;
}

function check(code, pass, message) { return { code, pass: Boolean(pass), message }; }

/** Revalidate the persisted SOP05 source and exact-string contract. */
export function qaListingSop05Contract({ artifact, facts, sop03, sop04, expectedVersions = {}, evidenceResolver = null } = {}) {
  const candidates = Array.isArray(artifact?.candidates) ? artifact.candidates : [];
  const active = candidates.filter(item => item?.status === 'ACTIVE' && item?.eligibility_status === 'ELIGIBLE_FOR_SOP06');
  const exacts = candidates.map(item => item?.exact_string);
  const sourceEntries = candidates.flatMap(item => Array.isArray(item?.sources) ? item.sources.map(source => ({ exact: item.exact_string, item, source })) : []);
  const resolutionFailures = [];
  if (evidenceResolver) for (const { exact, source } of sourceEntries) for (const link of source.evidence_links || []) {
    const result = evidenceResolver.resolve({ evidence_ref: link.evidence_ref, artifact_version: link.artifact_version,
      artifact_type: link.artifact_type, artifact_sha256: link.artifact_sha256, evidence_layer: link.evidence_layer });
    if (result.status !== 'EXISTS') resolutionFailures.push({ exact_string: exact, ref: link.evidence_ref, status: result.status });
  }
  const adopted = new Set((sop04?.adopted_terms || []).map(item => item?.exact_string).filter(Boolean));
  const allRawSop04 = new Set([
    ...(sop04?.source_query_artifacts || []).flatMap(item => (item.returned_raw_terms || []).map(term => term?.searchTerm).filter(Boolean)),
    ...(sop04?.returned_raw_terms || []).map(term => term?.searchTerm).filter(Boolean),
  ]);
  const sop04Candidates = candidates.filter(item => item.sources?.some(source => source.source_type === 'BOL_SEARCH_TERMS'));
  const termsViolatingSop04Adoption = sop04Candidates.filter(item => !adopted.has(item.exact_string) || !allRawSop04.has(item.exact_string));
  const extractorSources = sop03?.boloo_competitor_extractor || [];
  const rawExtractorCandidates = new Set(extractorSources.filter(row => row.status === 'PASS').flatMap(row => (row.exact_strings || []).map(sourceExact)));
  const missingExtractorSource = candidates.filter(item => item.sources?.some(source => source.source_type === 'BOLOO_EXTRACTOR') && !rawExtractorCandidates.has(item.exact_string));
  const unsupportedUrl = candidates.filter(item => isUrl(text(item.exact_string)));
  const invalidCandidateStatus = candidates.filter(item => item.status === 'ACTIVE'
    ? item.eligibility_status !== 'ELIGIBLE_FOR_SOP06' || !item.selection_reason || item.exclusion_reason
    : item.status === 'EXCLUDED' ? item.eligibility_status !== 'EXCLUDED' || !item.exclusion_reason : true);
  const versionsMatch = Number(artifact?.input_versions?.confirmed_product_facts_version) === Number(expectedVersions.facts)
    && String(artifact?.input_versions?.sop03_artifact_version) === String(expectedVersions.sop03)
    && String(artifact?.input_versions?.sop04_artifact_version) === String(expectedVersions.sop04)
    && Number(facts?.version) === Number(expectedVersions.facts);
  const versionValid = artifact?.version === `SOP05-${sha256(canonical(candidateVersionBody(artifact))).slice(0, 20)}`;
  const checks = [
    check('ARTIFACT_IDENTITY', artifact?.artifact_type === 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL' && artifact?.sop_step_id === 'LISTING_SOP_05' && artifact?.sku === facts?.sku && artifact?.sku === sop03?.sku && artifact?.sku === sop04?.sku, '正式SOP05 artifact、step、facts、SOP03、SOP04的SKU身份一致。'),
    check('INPUT_VERSION_LOCK', versionsMatch, 'Product Facts、SOP03、SOP04输入版本与当前正式版本一致。'),
    check('CONTENT_VERSION_HASH', versionValid, 'SOP05版本号与候选池内容SHA一致。'),
    check('EXACT_STRING_UNIQUE', exacts.length > 0 && new Set(exacts).size === exacts.length && exacts.every(value => typeof value === 'string' && value.length > 0 && value.trim() === value), '候选exact strings非空、原样保留，且只按完全相同字符串去重。'),
    check('URL_NOT_KEYWORD', unsupportedUrl.length === 0, 'URL没有作为keyword exact string。'),
    check('NON_DUTCH_NOT_PROMOTED', candidates.every(item => !hasCjk(item.exact_string)), '中文/非荷兰语源表达未进入正式荷兰语候选。'),
    check('PROVENANCE_PRESENT', sourceEntries.length > 0 && sourceEntries.every(({ source }) => source.source_type && source.source_version && Array.isArray(source.evidence_links) && source.evidence_links.length > 0), '每条候选均有来源类型、版本和至少一个证据链接。'),
    check('EXTRACTOR_RAW_MATCH', missingExtractorSource.length === 0, 'Boloo Extractor候选均来自PASS结果中的exact strings。'),
    check('SOP04_ADOPTED_ONLY', termsViolatingSop04Adoption.length === 0, 'SOP04来源候选仅使用正式ADOPT词，不从raw response提升未采用词。'),
    check('CANDIDATE_DECISIONS_COMPLETE', invalidCandidateStatus.length === 0 && artifact?.candidate_pool_status === 'CLOSED_FROM_CURRENT_APPROVED_SOURCES', '每个候选均有可审计的保留或排除理由，来源池已明确收口。'),
    check('NO_SCORE_OR_VOLUME_CONTAMINATION', forbiddenKeys(artifact).length === 0 && artifact?.no_scores_or_search_volume === true, '正式SOP05未保存Search Terms/Extractor数字或任何数值评分字段。'),
    check('EVIDENCE_RESOLVES', Boolean(evidenceResolver) && resolutionFailures.length === 0, 'facts、SOP03、SOP04及RAW/DOM引用均由strict resolver验证为实际存在。'),
    check('SOP06_EXACT_COUNT_MATCH', Number(artifact?.selected_for_sop06_count) === active.length && artifact?.candidate_count === candidates.length && artifact?.excluded_count === candidates.length - active.length, 'SOP06待查数量与正式ACTIVE候选数量一致，未为凑数添加字符串。'),
  ];
  const failures = checks.filter(item => !item.pass);
  return { status: failures.length ? 'FAIL' : 'PASS', checks, failures, failure_count: failures.length, selected_for_sop06_count: active.length,
    evidence_resolution_failures: resolutionFailures, external_requests: 0 };
}

