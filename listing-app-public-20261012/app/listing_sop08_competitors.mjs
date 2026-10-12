import crypto from 'node:crypto';

const SOURCE_SLOTS = Object.freeze([
  ['bol_direct_competitor', 'BOL直接竞品', 'DIRECT'],
  ['bol_similar_competitor_1', 'BOL同类竞品1', 'SIMILAR'],
  ['bol_similar_competitor_2', 'BOL同类竞品2', 'SIMILAR'],
  ['bol_similar_competitor_3', 'BOL同类竞品3', 'SIMILAR'],
  ['bol_similar_competitor_4', 'BOL同类竞品4', 'SIMILAR'],
]);

export function canonicalizeSop08BolUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !['www.bol.com', 'bol.com'].includes(url.hostname.toLowerCase())
      || url.username || url.password) return { canonical_url: null, bol_product_id: null, reason: 'INVALID_BOL_DETAIL_URL' };
    const match = url.pathname.match(/^\/nl\/nl\/p\/[^/]+\/(\d+)\/?$/i);
    if (!match) return { canonical_url: null, bol_product_id: null, reason: 'BOL_PRODUCT_ID_NOT_PARSEABLE' };
    url.hostname = 'www.bol.com';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    url.search = '';
    url.hash = '';
    return { canonical_url: url.toString(), bol_product_id: match[1], reason: null };
  } catch { return { canonical_url: null, bol_product_id: null, reason: 'INVALID_BOL_DETAIL_URL' }; }
}

function stableCompetitorId(sku, url) {
  return `BOL-${crypto.createHash('sha256').update(`${sku}\0${url}`).digest('hex').slice(0, 20)}`;
}

const SOP08_CONDITIONS = Object.freeze([
  'same_category', 'same_use_case', 'price_band_fit', 'sales_or_heat',
  'real_reviews', 'recent_activity', 'listing_stability', 'comparable_positioning',
]);

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO']);

export function isBolBusinessNetworkFailure(error) {
  const status = Number(error?.http_status ?? error?.status ?? error?.httpStatus ?? 0) || null;
  if (status != null || error?.response_received === true || error?.responseReceived === true) return false;
  const codes = [error?.code, error?.transport_code, error?.transportCode, error?.cause?.code, error?.cause?.cause?.code]
    .filter(Boolean).map(String);
  return codes.some(code => ['BOL_NETWORK_ERROR', 'BOL_NETWORK_TIMEOUT', ...NETWORK_CODES].includes(code)
    || /^(?:ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED_CERT)/i.test(code));
}

export function readinessIsAfterDependencyFailure(readiness, task) {
  const barrier = task?.required_readiness_after || task?.dependency_failed_at;
  if (!barrier) return true;
  const failedMs = Date.parse(barrier);
  const checkedMs = Date.parse(readiness?.checked_at || '');
  return Number.isFinite(failedMs) && Number.isFinite(checkedMs) && checkedMs > failedMs;
}

export function applyBolNetworkFailureBarrier(task, { error, failedAt, dependencyKey = 'BOL_API' } = {}) {
  if (!task || dependencyKey !== 'BOL_API' || !isBolBusinessNetworkFailure(error)) return false;
  const timestamp = failedAt || new Date().toISOString();
  task.status = 'WAITING_DEPENDENCY';
  task.waiting_dependency_key = 'BOL_API';
  task.dependency_failed_at = timestamp;
  task.required_readiness_after = timestamp;
  task.error_code = null;
  task.error_message = null;
  task.qa ||= {};
  if (task.current_step) task.qa[task.current_step] = { ...(task.qa[task.current_step] || {}), status: 'NOT_RUN', checked_at: null };
  return true;
}

function sop08HttpStatus(error) {
  const status = Number(error?.http_status ?? error?.status ?? error?.httpStatus ?? 0);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/** A Ratings 404 for this exact EAN is a field-level absence, not a task-level error. */
export function isSop08RatingsNotFoundForEan(error, ean) {
  const exactEan = String(ean ?? '').trim();
  if (!exactEan) return false;
  const nested = error?.diagnostic && typeof error.diagnostic === 'object' ? error.diagnostic : null;
  const status = Number(error?.http_status ?? error?.status ?? error?.httpStatus
    ?? nested?.http_status ?? nested?.status ?? 0);
  const responseReceived = error?.response_received ?? error?.responseReceived
    ?? nested?.response_received ?? nested?.responseReceived ?? (status === 404 ? true : null);
  const endpoint = String(error?.endpoint || nested?.endpoint || '').split('?')[0];
  const expectedEndpoint = `/retailer/products/${encodeURIComponent(exactEan)}/ratings`;
  const body = String(error?.response_body ?? error?.responseBody ?? error?.safe_body
    ?? nested?.response_body ?? nested?.responseBody ?? nested?.safe_body ?? '');
  return status === 404 && responseReceived === true && endpoint === expectedEndpoint && body.includes(exactEan);
}

/** Reuses only an already-persisted, exact-EAN Ratings 404 from the current task. */
export function resolveSop08SavedRatingsNotFound(task, ean) {
  const saved = task?.http_client_error;
  if (!saved || saved.provider !== 'BOL_API' || Number(saved.http_status) !== 404) return null;
  const failure = saved.diagnostic && typeof saved.diagnostic === 'object' ? saved.diagnostic : {};
  const combined = {
    ...failure,
    endpoint: saved.endpoint || failure.endpoint || null,
    http_status: saved.http_status,
    response_received: failure.response_received ?? true,
    response_body: failure.response_body ?? null,
  };
  if (!isSop08RatingsNotFoundForEan(combined, ean)) return null;
  return {
    ...combined,
    execution_id: failure.execution_id || null,
    request_id: saved.request_id || failure.request_id || null,
    method: failure.method || 'GET',
    request_parameters: failure.request_parameters || { ean: String(ean), countryCode: 'NL' },
    started_at: failure.started_at || null,
    finished_at: saved.failed_at || failure.finished_at || null,
    error_code: failure.error_code || saved.reason_code || 'BOL_API_HTTP_ERROR',
  };
}

/** Preserve a Ratings 404 as unavailable evidence without asserting NO_REVIEWS. */
export function applySop08RatingsNotAvailable(candidate, { failureRecord, evidenceRef, observedAt } = {}) {
  if (!candidate || !isSop08RatingsNotFoundForEan(failureRecord, candidate.ean) || !evidenceRef) return false;
  candidate.rating = null;
  candidate.review_count = null;
  candidate.rating_status = 'NOT_AVAILABLE';
  candidate.ratings_evidence = {
    status: 'NOT_AVAILABLE', reason_code: 'RATINGS_PRODUCT_NOT_FOUND', http_status: 404,
    response_received: true, observed_at: observedAt || failureRecord.finished_at || null,
    reason: 'Ratings endpoint returned HTTP 404 for this EAN; review presence and counts remain unknown.',
    evidence_ref: evidenceRef,
  };
  candidate.latest_review_or_activity = {
    status: 'NOT_AVAILABLE', reason: 'Ratings endpoint 404 provides no review date or activity evidence.', evidence_ref: evidenceRef,
  };
  candidate.evidence_refs = [...new Set([...(candidate.evidence_refs || []), evidenceRef])];
  return true;
}

function retryAfterValue(error) {
  const headers = error?.response_headers || error?.responseHeaders || error?.headers || {};
  if (typeof headers.get === 'function') return headers.get('retry-after') || headers.get('Retry-After') || null;
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'retry-after');
  return key ? String(headers[key]) : null;
}

export function classifySop08BolFailure(error) {
  const status = sop08HttpStatus(error);
  const responseReceived = error?.response_received === true || error?.responseReceived === true || status !== null;
  if (status === 429) {
    return { route: 'RATE_LIMIT_WAIT', reason_code: 'HTTP_429', http_status: status || 429, retry_after: retryAfterValue(error) };
  }
  if (status >= 500 && status <= 599) return { route: 'UPSTREAM_WAIT', reason_code: 'HTTP_5XX', http_status: status };
  if (status >= 400 && status <= 499) return { route: 'PAUSE_HTTP_CLIENT_ERROR', reason_code: `HTTP_${status}`, http_status: status };
  if (!responseReceived && isBolBusinessNetworkFailure(error)) return { route: 'TRANSPORT_WAIT', reason_code: 'TRANSPORT_FAILURE', http_status: null };
  return { route: 'UNCLASSIFIED', reason_code: 'ERROR_CLASSIFICATION_INCOMPLETE', http_status: status };
}

export function retryAfterTimestamp(value, now = new Date().toISOString()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  const nowMs = Date.parse(now);
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(nowMs)) return new Date(nowMs + seconds * 1000).toISOString();
  const absoluteMs = Date.parse(String(value));
  return Number.isFinite(absoluteMs) ? new Date(absoluteMs).toISOString() : null;
}

export function applySop08HttpClientErrorPause(task, { error, failureRecord, failedAt } = {}) {
  const classification = classifySop08BolFailure(error);
  if (!task || task.current_step !== 'LISTING_SOP_08' || classification.route !== 'PAUSE_HTTP_CLIENT_ERROR') return false;
  const at = failedAt || new Date().toISOString();
  task.status = 'PAUSED';
  task.current_step = 'LISTING_SOP_08';
  task.resume_point = 'LISTING_SOP_08';
  task.waiting_dependency_key = null;
  task.listing_sop ||= {};
  task.listing_sop.current_step_id = 'LISTING_SOP_08';
  delete task.dependency_failed_at;
  delete task.required_readiness_after;
  task.http_client_error = {
    code: 'HTTP_CLIENT_BUSINESS_ERROR', reason_code: classification.reason_code, http_status: classification.http_status,
    provider: 'BOL_API', endpoint: failureRecord?.endpoint || error?.endpoint || null,
    request_id: failureRecord?.request_id || error?.request_id || error?.requestId || null,
    diagnostic: failureRecord || null,
    failed_at: at,
  };
  task.error_code = null;
  task.error_message = null;
  task.stage_qa_status = 'NOT_RUN';
  task.qa ||= {};
  task.qa.LISTING_SOP_08 = { ...(task.qa.LISTING_SOP_08 || {}), status: 'NOT_RUN', checked_at: null };
  task.stages ||= {};
  task.stages.LISTING_SOP_08 = { ...(task.stages.LISTING_SOP_08 || {}), status: 'PAUSED', dependency: null,
    waiting_reason: `${classification.reason_code} 确定性 HTTP 客户端/业务错误；修复请求后仅允许人工继续。`, updated_at: at };
  if (task.listing_sop?.steps?.LISTING_SOP_08) task.listing_sop.steps.LISTING_SOP_08 = {
    ...task.listing_sop.steps.LISTING_SOP_08, status: 'PAUSED', qa_status: 'NOT_RUN',
    waiting_reason: task.stages.LISTING_SOP_08.waiting_reason, updated_at: at,
  };
  if (task.listing_executor?.registry?.LISTING_SOP_08) task.listing_executor.registry.LISTING_SOP_08 = {
    ...task.listing_executor.registry.LISTING_SOP_08, status: 'PAUSED', qa_status: 'NOT_RUN',
    waiting_reason: task.stages.LISTING_SOP_08.waiting_reason, updated_at: at,
  };
  return true;
}

export function applySop08RateLimitWait(task, { error, failureRecord, failedAt } = {}) {
  const classification = classifySop08BolFailure(error);
  if (!task || task.current_step !== 'LISTING_SOP_08' || classification.route !== 'RATE_LIMIT_WAIT') return false;
  const at = failedAt || new Date().toISOString();
  const retryAt = retryAfterTimestamp(classification.retry_after, at);
  task.status = 'WAITING_DEPENDENCY';
  task.current_step = 'LISTING_SOP_08';
  task.resume_point = 'LISTING_SOP_08';
  task.waiting_dependency_key = 'BOL_API_RATE_LIMIT';
  delete task.dependency_failed_at;
  delete task.required_readiness_after;
  task.rate_limit_wait = { provider: 'BOL_API', reason_code: 'HTTP_429', http_status: 429,
    retry_after: classification.retry_after, retry_after_at: retryAt, failed_at: at, diagnostic: failureRecord || null };
  task.error_code = null; task.error_message = null; task.stage_qa_status = 'NOT_RUN';
  task.qa ||= {}; task.qa.LISTING_SOP_08 = { ...(task.qa.LISTING_SOP_08 || {}), status: 'NOT_RUN', checked_at: null };
  task.stages ||= {}; task.stages.LISTING_SOP_08 = { ...(task.stages.LISTING_SOP_08 || {}), status: 'WAITING_DEPENDENCY',
    dependency: 'BOL_API_RATE_LIMIT', waiting_reason: retryAt ? `HTTP_429_RATE_LIMITED; retry_after_at=${retryAt}` : 'HTTP_429_RATE_LIMITED', updated_at: at };
  return true;
}

export function applySop08UpstreamHttpWait(task, { error, failureRecord, failedAt } = {}) {
  const classification = classifySop08BolFailure(error);
  if (!task || task.current_step !== 'LISTING_SOP_08' || classification.route !== 'UPSTREAM_WAIT') return false;
  const at = failedAt || new Date().toISOString();
  task.status = 'WAITING_DEPENDENCY'; task.current_step = 'LISTING_SOP_08'; task.resume_point = 'LISTING_SOP_08';
  task.waiting_dependency_key = 'BOL_API'; task.dependency_failed_at = at; task.required_readiness_after = at;
  task.provider_wait_classification = { reason_code: 'HTTP_5XX', http_status: classification.http_status,
    response_received: true, transport_failure: false, diagnostic: failureRecord || null, failed_at: at };
  task.error_code = null; task.error_message = null; task.stage_qa_status = 'NOT_RUN';
  task.qa ||= {}; task.qa.LISTING_SOP_08 = { ...(task.qa.LISTING_SOP_08 || {}), status: 'NOT_RUN', checked_at: null };
  task.stages ||= {}; task.stages.LISTING_SOP_08 = { ...(task.stages.LISTING_SOP_08 || {}), status: 'WAITING_DEPENDENCY',
    dependency: 'BOL_API', waiting_reason: `上游 BOL API HTTP ${classification.http_status}；分类为 HTTP_5XX，不是传输错误。`, updated_at: at };
  return true;
}

const TERMINAL_REMOTE_ENRICHMENT = new Set(['PASS', 'UNKNOWN', 'NOT_AVAILABLE', 'NOT_APPLICABLE']);

export function completeSop08ExistingCandidateEvaluation(candidate, { completedAt = new Date().toISOString() } = {}) {
  if (!candidate || candidate.evaluation_type !== 'EXISTING_COMPETITOR_EVALUATION') return false;
  if (candidate.local_evidence_mapping_status !== 'COMPLETE') return false;
  const pending = [
    ...(Array.isArray(candidate.remote_subtasks) ? candidate.remote_subtasks : []),
    ...(Array.isArray(candidate.required_remote_subtasks) ? candidate.required_remote_subtasks : []),
    ...(Array.isArray(candidate.pending_remote_subtasks) ? candidate.pending_remote_subtasks : []),
  ].some(item =>
    !['PASS', 'UNKNOWN', 'NOT_AVAILABLE', 'NOT_APPLICABLE'].includes(String(item?.status || item)));
  if (pending) return false;
  const remoteFields = candidate.remote_enrichment_fields || {};
  if (!Object.keys(remoteFields).length || Object.values(remoteFields).some(value =>
    !TERMINAL_REMOTE_ENRICHMENT.has(String(typeof value === 'string' ? value : value?.status)))) return false;
  candidate.remote_enrichment_status = 'COMPLETE';
  candidate.existing_evaluation_complete = true;
  candidate.existing_evaluation_status = 'EXISTING_CANDIDATE_EVALUATION_COMPLETE';
  candidate.existing_evaluation_completed_at = completedAt;
  return true;
}

export function sop08OwnProductPlacementDisposition(error = null) {
  const status = Number(error?.http_status ?? error?.status ?? error?.httpStatus) || null;
  const notFound = status === 404 || error?.code === 'PRODUCT_PLACEMENT_NOT_FOUND'
    || ['NOT_FOUND', 'NOT_LISTED'].includes(String(error?.status || '').toUpperCase())
    || error?.reason_code === 'PRODUCT_PLACEMENT_NOT_FOUND';
  return {
    status: notFound ? 'NOT_FOUND' : 'NOT_APPLICABLE',
    reason_code: notFound ? 'PRODUCT_PLACEMENT_NOT_FOUND' : null,
    applicability: 'NOT_APPLICABLE_FOR_COMPETITOR_POOL',
    affects_competitor_pool: false,
    category_ids: [], evidence_ref: null,
    own_product_placement: notFound ? 'NOT_FOUND' : 'NOT_APPLICABLE',
  };
}

function evidenceFor(candidate, ...refs) {
  const defaults = [candidate.source_ref?.sop03_artifact_ref, candidate.source_ref?.exact_url];
  return [...new Set([...refs.flat(), ...defaults, ...(candidate.evidence_refs || [])].filter(Boolean))];
}

function normalizedEvidenceStatus(value) {
  if (value === true || value === 'PASS' || value === 'CONFIRMED' || value === 'CLEAR_CONFIRMED' || value === 'STABLE') return 'PASS';
  if (value === false || value === 'FAIL' || value === 'CONFIRMED_FAIL' || value === 'CLEAR_NONE' || value === 'UNSTABLE') return 'FAIL';
  return 'UNKNOWN';
}

function confirmedFactText(facts, names) {
  const fields = facts?.fields || {};
  return names.map(name => {
    const fact = fields[name];
    return fact?.status === 'CONFIRMED' && typeof fact.value === 'string' ? fact.value : '';
  }).filter(Boolean).join(' ').toLocaleLowerCase();
}

/** Uses only saved facts/local BOL evidence; it does not infer market metrics or call a provider. */
export function mapSop08LocalCompetitorEvidence(candidate, factsVersionRecord = null) {
  const result = structuredClone(candidate || {});
  const facts = factsVersionRecord?.fields ? factsVersionRecord : null;
  const ownText = confirmedFactText(facts, ['name', 'product_facts.category', 'packaging_contents', 'product_facts.packaging_contents', 'functions', 'product_facts.functions']);
  const local = result.local_evidence || {};
  const mined = Array.isArray(local.mined_expressions) ? local.mined_expressions : [];
  const localRow = result.local_source_row || {};
  const title = [result.title, localRow.local_title, localRow.title, localRow.product_title,
    ...(mined.map(item => item.exact_string || '')),
    result.bol_url ? (() => { try { return new URL(result.bol_url).pathname.split('/').filter(Boolean).at(-2) || ''; } catch { return ''; } })() : '',
  ].filter(Boolean).join(' ').toLocaleLowerCase().replace(/[-_]+/g, ' ');
  const ownFactRefs = ['name', 'product_facts.category', 'packaging_contents', 'product_facts.packaging_contents', 'functions', 'product_facts.functions']
    .flatMap(key => (facts?.fields?.[key]?.status === 'CONFIRMED' ? facts.fields[key].source_references || [] : []))
    .map(ref => ref.source_reference).filter(Boolean);
  const localRefs = [...new Set([result.source_ref?.exact_url, result.source_ref?.sop03_artifact_ref,
    ...mined.map(item => item.evidence_ref), ...(local.extractor?.evidence_refs || []).map(item => item.reference)].filter(Boolean))];
  const ownIsGiftBag = /礼品袋|纸袋|gift\s*bags?|gift\s*bags?|geschenkzakjes|geschenkzakken|cadeauzakjes|cadeautasjes/i.test(ownText);
  const competitorIsGiftBag = /(?:geschenk|cadeau)[ -]?(?:zakjes|zakken|tasjes|tassen)|kersttassen|papieren\s+(?:zakjes|tassen)/i.test(title);
  const ownSeasonal = /圣诞|kerst|christmas/i.test(ownText);
  const competitorSeasonal = /kerst|christmas/i.test(title);
  const ownGiftUse = /礼品|赠礼|包装|cadeau|geschenk|gift/i.test(ownText);
  const competitorGiftUse = /cadeau|geschenk|gift/i.test(title);
  const ownDiyBeadedTreeKit = /\bdiy\b/i.test(ownText)
    && /串珠|珠子|bead(?:ed|s)?|kralen/i.test(ownText)
    && /圣诞树|kerstboom|christmas\s+tree/i.test(ownText)
    && /套装|set|kit|pakket/i.test(ownText);
  const competitorDiyBeadedTreeKit = /\bdiy\b/i.test(title)
    && /bead(?:ed|s)?|kralen/i.test(title)
    && /kerstboom|christmas\s+tree/i.test(title)
    && /set|kit|pakket|knutselpakket/i.test(title);
  const competitorClearlyFinishedTree = /kunstkerstboom|artificial\s+christmas\s+tree/i.test(title)
    && !competitorDiyBeadedTreeKit;
  const competitorTreeAccessory = /kerstboom\s*(?:standaard|strikken)|christmas\s+tree\s*(?:stand|bows?)/i.test(title);
  const categoryPass = (ownIsGiftBag && competitorIsGiftBag)
    || (ownDiyBeadedTreeKit && competitorDiyBeadedTreeKit);
  const usePass = (ownIsGiftBag && competitorIsGiftBag
      && ((ownSeasonal && competitorSeasonal) || (ownGiftUse && competitorGiftUse)))
    || (ownDiyBeadedTreeKit && competitorDiyBeadedTreeKit && competitorSeasonal);
  const ownPack = `${facts?.fields?.packaging_contents?.status === 'CONFIRMED' ? facts.fields.packaging_contents.value : facts?.fields?.['product_facts.packaging_contents']?.value || ''}`.toLocaleLowerCase();
  const competitorCount = title.match(/\b(\d+)\s*(?:stuks|st\.?|x)\b/i)?.[1] || null;
  const ownCount = ownPack.match(/(\d{1,3})\s*纸袋/i)?.[1] || ownPack.match(/(?:纸袋|袋)[^\d]{0,8}(\d{1,3})/i)?.[1] || ownPack.match(/\b(\d{1,3})\s*(?:paper\s*)?(?:bags?|zakjes|tassen)\b/i)?.[1] || null;
  const ownHasStickers = /贴纸|stickers?/i.test(ownPack);
  const competitorHasStickers = /stickers?/i.test(title);
  const positioningPass = (usePass && ownCount && competitorCount === ownCount && ownHasStickers === competitorHasStickers)
    || (ownDiyBeadedTreeKit && competitorDiyBeadedTreeKit);
  const condition = (status, reason, refs) => ({ status, reason, evidence_refs: [...new Set(refs.filter(Boolean))] });
  result.local_fact_mapping = {
    facts_version: facts?.version ?? null,
    competitor_title_evidence: title || null,
    package_comparison_observation: { own_bag_count: ownCount, competitor_bag_count: competitorCount, own_includes_stickers: ownHasStickers, competitor_title_mentions_stickers: competitorHasStickers },
    own_fact_evidence_refs: [...new Set(ownFactRefs)],
    local_source_evidence_refs: localRefs,
  };
  result.competitor_conditions = { ...(result.competitor_conditions || {}) };
  if (categoryPass) {
    const reason = ownDiyBeadedTreeKit && competitorDiyBeadedTreeKit
      ? '已确认的自有产品事实指向DIY串珠圣诞树套装；BOL来源标题/URL表达也指向DIY串珠圣诞树套装，支持同品类判断。未据此推断包装数量、材质或其他未确认属性。'
      : '确认产品事实表明我方为礼品袋/纸袋；已保存的BOL标题或本地关键词明确属于礼品袋/纸袋。';
    result.competitor_conditions.same_category = condition('PASS', reason, [...ownFactRefs, ...localRefs]);
    result.same_category = true;
  }
  if (usePass) {
    const reason = ownDiyBeadedTreeKit && competitorDiyBeadedTreeKit && competitorSeasonal
      ? '已确认的自有产品是DIY串珠圣诞树套装；BOL来源标题/URL表达同时支持DIY串珠圣诞树套装和圣诞场景，匹配手工制作与节日装饰用途。未据此推断包装或材质。'
      : ownSeasonal && competitorSeasonal
        ? '我方确认资料包含圣诞礼品包装用途，BOL本地标题/表达明确包含 kerst 圣诞场景及礼品用途。'
        : '我方确认资料与BOL本地标题均明确指向礼品用途。';
    result.competitor_conditions.same_use_case = condition('PASS', reason, [...ownFactRefs, ...localRefs]);
    result.same_use_case = true;
  }
  if (positioningPass) {
    result.competitor_conditions.comparable_positioning = condition('PASS', ownDiyBeadedTreeKit && competitorDiyBeadedTreeKit
      ? '已确认自有产品名称是DIY串珠圣诞树套装；来源标题明确为DIY/kralen或beaded kerstboom kit/set，产品形式和手工圣诞树用途直接匹配。包装、材质细节未据此推断。'
      : '本地证据同时支持相同产品用途、包装数量和贴纸配置，可直接比较套装定位。', [...ownFactRefs, ...localRefs]);
    result.comparable_positioning = true;
  }
  if (ownDiyBeadedTreeKit && !competitorDiyBeadedTreeKit && (competitorClearlyFinishedTree || competitorTreeAccessory)) {
    const refs = [...ownFactRefs, ...localRefs];
    if (competitorTreeAccessory) {
      result.competitor_conditions.same_category = condition('FAIL', '来源标题明确指向圣诞树支架/蝴蝶结配件，与已确认的DIY串珠圣诞树套装产品形式不同。', refs);
      result.competitor_conditions.same_use_case = condition('FAIL', '来源标题是树架或装饰配件用途，不是DIY手工制作圣诞树套装。', refs);
    } else {
      result.competitor_conditions.same_category = condition('PASS', '来源标题明确是完整的人造圣诞树，仍属圣诞树品类；产品形态与已确认的DIY串珠套装不同。', refs);
      result.competitor_conditions.same_use_case = condition('FAIL', '来源标题描述成品人造树而非DIY手工套装，不能证明相同的手工活动用途。', refs);
    }
    result.competitor_conditions.comparable_positioning = condition('FAIL', '来源标题明确显示为成品树或树用配件，不是可直接比较的DIY串珠圣诞树套装。', refs);
  }
  return result;
}

/** Map observations to the eight SOP facts. Unavailable API fields remain UNKNOWN. */
export function sop08CompetitorConditions(candidate) {
  const explicit = candidate.competitor_conditions || {};
  const reviewCount = candidate.ratings_evidence?.status === 'PASS'
    && Number.isFinite(Number(candidate.review_count)) ? Number(candidate.review_count) : null;
  const criteria = {
    same_category: [candidate.competitor_conditions?.same_category?.status || candidate.same_category, evidenceFor(candidate, candidate.competitor_conditions?.same_category?.evidence_refs, candidate.product_placement?.evidence_ref), candidate.competitor_conditions?.same_category?.reason || '基于已确认自有事实和竞品本地资料判断品类；自有商品 Placement 不属于竞品池门禁。'],
    same_use_case: [candidate.competitor_conditions?.same_use_case?.status || candidate.same_use_case, evidenceFor(candidate, candidate.competitor_conditions?.same_use_case?.evidence_refs, candidate.product_list_evidence?.evidence_ref, candidate.source_ref?.sop03_artifact_ref), candidate.competitor_conditions?.same_use_case?.reason || '我方确认用途与竞品标题/本地资料对照。'],
    price_band_fit: [candidate.price_band_fit, evidenceFor(candidate, candidate.offers_evidence?.evidence_ref, candidate.own_price_evidence_ref), '我方价格带与竞品有效 Offer 对照。'],
    sales_or_heat: [candidate.heat_evidence?.condition_status ?? candidate.sales_evidence?.condition_status, evidenceFor(candidate, candidate.heat_evidence?.evidence_refs, candidate.sales_evidence?.evidence_ref), '只接受明确销量或其他已验证热度证据；排名、评论数、页面存在和 Offer 数量不代替销量/热度。'],
    real_reviews: [reviewCount == null ? explicit.real_reviews?.status : reviewCount > 0, evidenceFor(candidate, candidate.ratings_evidence?.evidence_ref, explicit.real_reviews?.evidence_refs), reviewCount == null ? '尚无可读取的真实评论数量。' : `Ratings 已验证 ${reviewCount} 条真实评论记录。`],
    recent_activity: [candidate.latest_review_or_activity?.condition_status ?? candidate.latest_review_or_activity?.status, evidenceFor(candidate, candidate.latest_review_or_activity?.evidence_ref, candidate.ratings_evidence?.evidence_ref), candidate.latest_review_or_activity?.reason || '没有近期评论或市场活跃时间证据。'],
    listing_stability: [candidate.listing_stability, evidenceFor(candidate, candidate.product_placement?.evidence_ref, candidate.listing_stability_evidence_ref), '一次页面/Placement存在只证明当前可解析，不足以证明 Listing 长期稳定。'],
    comparable_positioning: [candidate.competitor_conditions?.comparable_positioning?.status || candidate.comparable_positioning, evidenceFor(candidate, candidate.competitor_conditions?.comparable_positioning?.evidence_refs, candidate.product_list_evidence?.evidence_ref, candidate.product_placement?.evidence_ref, candidate.source_ref?.sop03_artifact_ref), candidate.competitor_conditions?.comparable_positioning?.reason || '按已确认核心配置、套装及产品定位判断直接可比性。'],
  };
  const conditions = {};
  for (const key of SOP08_CONDITIONS) {
    const [raw, refs, reason] = criteria[key];
    const explicitStatus = explicit[key]?.status;
    const status = ['PASS', 'FAIL', 'UNKNOWN'].includes(explicitStatus)
      ? explicitStatus : normalizedEvidenceStatus(raw);
    conditions[key] = { status, evidence_refs: refs, reason: explicit[key]?.reason || reason };
  }
  return conditions;
}

/** Build source-only candidates. This function never treats a supplied URL as an effective competitor. */
export function buildListingSop08Candidates({ sku, sop03Artifact, factsVersion, top20Version }) {
  if (!sku || !sop03Artifact || !factsVersion || !top20Version) {
    throw Object.assign(new Error('SOP08 缺少 SKU 或正式上游版本。'), { code: 'SOP08_REQUIRED_VERSION_MISSING' });
  }
  const rows = Array.isArray(sop03Artifact.bol_local_source?.competitor_urls)
    ? sop03Artifact.bol_local_source.competitor_urls : [];
  const byField = new Map(rows.map(row => [row.source_field, row]));
  const candidates = [];
  for (const [sourceField, expectedHeader, proposedType] of SOURCE_SLOTS) {
    const row = byField.get(sourceField);
    if (!row) continue;
    const rawSourceUrl = String(row.exact_url || '').trim();
    const canonical = canonicalizeSop08BolUrl(rawSourceUrl);
    const sourceUrl = canonical.canonical_url;
    const extractor = (sop03Artifact.boloo_competitor_extractor || []).find(item => {
      const itemCanonical = canonicalizeSop08BolUrl(item.source_url).canonical_url;
      return itemCanonical && itemCanonical === sourceUrl;
    }) || null;
    const minedExpressions = (sop03Artifact.bol_local_source?.keyword_mining?.exact_strings || [])
      .filter(item => canonicalizeSop08BolUrl(item.source_url).canonical_url === sourceUrl);
    const evidenceMap = (sop03Artifact.bol_local_source?.evidence_map || [])
      .filter(item => item.mapped_competitor_field === sourceField);
    const evidenceRefs = [...new Set([
      ...minedExpressions.map(item => item.evidence_ref),
      ...(extractor?.evidence_refs || []).map(item => item.reference),
    ].filter(Boolean))];
    candidates.push({
      competitor_id: stableCompetitorId(sku, sourceUrl || `${sourceField}:${row.source_cell || ''}`),
      candidate_status: 'COMPETITOR_CANDIDATE',
      evaluation_type: 'EXISTING_COMPETITOR_EVALUATION',
      source_field: sourceField,
      source_header: row.source_header || expectedHeader,
      source_cell: row.source_cell || null,
      proposed_type: proposedType,
      raw_bol_url: rawSourceUrl || null,
      bol_url: sourceUrl || null,
      bol_product_id: canonical.bol_product_id,
      url_status: sourceUrl ? 'CANONICALIZED_EXISTING_URL' : 'INVALID_SOURCE_URL',
      url_resolution_reason: canonical.reason,
      discovery_query: null,
      product_list_query: null,
      ean: row.ean || null,
      ean_status: row.ean ? 'CONFIRMED_FROM_SOURCE' : 'UNKNOWN',
      title: row.local_title || row.title || row.product_title || null,
      title_source: row.local_title ? 'SOP03_LOCAL_TITLE' : row.title ? 'SOP03_SOURCE_TITLE' : row.product_title ? 'SOP03_PRODUCT_TITLE' : 'UNKNOWN',
      local_evidence: {
        mined_expressions: minedExpressions.map(item => ({ exact_string: item.exact_string, category: item.category, evidence_ref: item.evidence_ref, source_version: item.import_version || sop03Artifact.import_version || null })),
        extractor: extractor ? { status: extractor.status, provider_method: extractor.provider_method, provider_request_id: extractor.provider_request_id, result_version: extractor.result_version, exact_strings: extractor.exact_strings || [], evidence_refs: extractor.evidence_refs || [] } : null,
        source_evidence: evidenceMap.map(item => ({ evidence_id: item.evidence_id, evidence_kind: item.evidence_kind, source_field: item.source_field, header_name: item.header_name, source_cell: item.cell })),
      },
      current_sale_status: 'NOT_CONFIRMED',
      same_category: 'UNKNOWN',
      same_use_case: 'UNKNOWN',
      price_band_fit: 'UNKNOWN',
      comparable_positioning: 'UNKNOWN',
      listing_stability: 'NOT_CONFIRMED',
      competitor_conditions: null,
      classification: null,
      classification_reason: null,
      current_price: null,
      price_status: 'NOT_AVAILABLE',
      rating: null,
      rating_status: 'NOT_AVAILABLE',
      review_count: null,
      latest_review_or_activity: { status: 'NOT_AVAILABLE', reason: '现有 Retailer API Ratings/Offers/Placement 不提供最近评论日期；单次读取也不能证明长期稳定。' },
      sales_evidence: { status: 'NOT_AVAILABLE', reason: '当前来源未提供可验证销量数值。' },
      heat_evidence: { status: 'NOT_CONFIRMED', items: [] },
      price_band: null,
      product_placement: null,
      offers_evidence: null,
      ratings_evidence: null,
      source_ref: {
        sop03_artifact_type: sop03Artifact.artifact_type,
        sop03_artifact_version: sop03Artifact.version || null,
        source_file: sop03Artifact.source_file || null,
        source_file_hash: sop03Artifact.source_file_hash || null,
        import_version: sop03Artifact.import_version || null,
        source_field: row.source_field,
        source_header: row.source_header || expectedHeader,
        source_cell: row.source_cell || null,
        raw_url: rawSourceUrl || null,
        exact_url: sourceUrl || null,
        url_resolution_reason: canonical.reason,
        extractor_status: row.extractor_status || null,
        extractor_result_version: row.extractor_result_version || null,
        extractor_request_id: extractor?.provider_request_id || null,
      },
      input_versions: { facts: factsVersion, sop03: sop03Artifact.version || null, top20: top20Version },
      evidence_refs: evidenceRefs,
      checked_at: null,
    });
  }
  return candidates;
}

export function inspectSop08CandidateSlots(sop03Artifact) {
  const rows = Array.isArray(sop03Artifact?.bol_local_source?.competitor_urls)
    ? sop03Artifact.bol_local_source.competitor_urls : [];
  const byField = new Map(rows.map(row => [row.source_field, row]));
  return SOURCE_SLOTS.map(([sourceField, sourceHeader]) => {
    const row = byField.get(sourceField);
    if (!row) return { source_field: sourceField, source_header: sourceHeader, status: 'NOT_PROVIDED', candidate_created: false };
    const canonical = canonicalizeSop08BolUrl(row.exact_url);
    return canonical.bol_product_id
      ? { source_field: sourceField, source_header: sourceHeader, status: 'AVAILABLE', candidate_created: true,
        bol_product_id: canonical.bol_product_id }
      : { source_field: sourceField, source_header: sourceHeader, status: 'INVALID_URL', candidate_created: true,
        reason_code: canonical.reason };
  });
}

/** Existing J12-N12 sources are evaluated from saved evidence and never generate Product List queries. */
export function buildSop08ExistingEvaluationPlan(candidates) {
  return {
    type: 'EXISTING_COMPETITOR_EVALUATION',
    candidates: (candidates || []).map(candidate => ({
      competitor_id: candidate.competitor_id,
      source_field: candidate.source_field,
      raw_url: candidate.raw_bol_url || candidate.source_ref?.raw_url || null,
      canonical_url: candidate.bol_url || null,
      bol_product_id: candidate.bol_product_id || null,
      ean: candidate.ean || null,
      ean_status: candidate.ean_status || 'UNKNOWN',
      local_evidence_refs: [...new Set(candidate.evidence_refs || [])],
      product_list_query: null,
    })),
    remote_product_list_requests: [],
  };
}

const SAFE_ERROR_HEADERS = new Set(['content-type', 'date', 'retry-after', 'x-request-id', 'request-id', 'traceparent']);
const ERROR_BODY_MAX_LENGTH = 8192;

function sanitizeErrorText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/ig, '$1[REDACTED]')
    .slice(0, ERROR_BODY_MAX_LENGTH);
}

function safeErrorBodyText(value) {
  if (value == null) return null;
  try { return sanitizeErrorText(typeof value === 'string' ? value : JSON.stringify(value)); }
  catch { return '[UNSERIALIZABLE_ERROR_BODY]'; }
}

/** Persist only fields exposed by the Adapter; absent transport/HTTP evidence remains null. */
export function buildSop08RemoteFailureRecord({ error, executionId = null, requestId = null, endpoint, method, requestParameters, startedAt, finishedAt }) {
  const rawStatus = error?.status ?? error?.http_status ?? error?.httpStatus ?? null;
  const numericStatus = rawStatus == null ? null : Number(rawStatus);
  const httpStatus = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599 ? numericStatus : null;
  const explicitResponseReceived = error?.response_received ?? error?.responseReceived;
  const responseReceived = typeof explicitResponseReceived === 'boolean' ? explicitResponseReceived : httpStatus != null ? true : null;
  const sourceHeaders = error?.response_headers || error?.responseHeaders || error?.headers || null;
  const safeHeaders = {};
  if (sourceHeaders && typeof sourceHeaders === 'object') {
    const entries = typeof sourceHeaders.entries === 'function' ? [...sourceHeaders.entries()] : Object.entries(sourceHeaders);
    for (const [key, value] of entries) if (SAFE_ERROR_HEADERS.has(String(key).toLowerCase())) safeHeaders[String(key).toLowerCase()] = sanitizeErrorText(value);
  }
  const body = error?.response_body ?? error?.responseBody ?? error?.error_body ?? error?.errorBody ?? null;
  const transportCode = responseReceived === true ? null : error?.transport_code || error?.transportCode || error?.cause?.code || null;
  const classification = httpStatus != null ? 'HTTP_FAILURE'
    : responseReceived === false && transportCode ? 'TRANSPORT_FAILURE'
      : 'ADAPTER_EVIDENCE_INCOMPLETE';
  return {
    execution_id: executionId || error?.execution_id || error?.executionId || null,
    request_id: error?.request_id || error?.requestId || requestId || null,
    adapter_request_id: error?.request_id || error?.requestId || null,
    workbench_request_id: requestId || null,
    endpoint: endpoint || null,
    method: method || null,
    request_parameters: requestParameters || null,
    started_at: startedAt || null,
    finished_at: finishedAt || null,
    error_class: error?.name || error?.constructor?.name || 'Error',
    error_code: error?.code || null,
    transport_code: transportCode,
    classification,
    http_status: httpStatus,
    response_received: responseReceived,
    response_headers: responseReceived && Object.keys(safeHeaders).length ? safeHeaders : null,
    response_body: responseReceived ? safeErrorBodyText(body) : null,
    adapter_original_message: sanitizeErrorText(error?.message),
    mapped_business_error: error?.mapped_business_error || error?.mappedBusinessError
      || (classification !== 'ADAPTER_EVIDENCE_INCOMPLETE' ? error?.code || null : null),
  };
}

/** Classify from the eight explicit SOP conditions. There is no score or hidden weighting. */
export function classifyListingCompetitor(candidate) {
  const result = structuredClone(candidate);
  const conditions = sop08CompetitorConditions(result);
  result.competitor_conditions = conditions;
  const status = key => conditions[key].status;
  const explicitMismatch = ['same_category', 'same_use_case', 'comparable_positioning'].some(key => status(key) === 'FAIL');
  const explicitWeakEvidence = ['price_band_fit', 'sales_or_heat', 'real_reviews', 'recent_activity', 'listing_stability'].some(key => status(key) === 'FAIL');
  const noValidPage = ['NOT_FOUND', 'URL_MISMATCH'].includes(result.product_placement?.status)
    || (result.product_placement?.status === 'RESOLVED' && result.offers_evidence?.status === 'PASS' && result.offers_evidence.active_offer_count === 0);

  if (explicitMismatch || explicitWeakEvidence || noValidPage) {
    result.classification = 'C_WEAK_INVALID';
    result.comparison_role = 'EXCLUDED_FROM_MAIN_POOL';
    const reasons = [
      ...['same_category', 'same_use_case', 'comparable_positioning'].filter(key => status(key) === 'FAIL').map(key => `${key} 有明确不匹配证据`),
      ...['price_band_fit', 'sales_or_heat', 'real_reviews', 'recent_activity', 'listing_stability'].filter(key => status(key) === 'FAIL').map(key => `${key} 命中 SOP 弱竞品条件`),
      ...(noValidPage ? ['官方商品页失效或没有当前有效 Offer'] : []),
    ];
    result.classification_reason = `${reasons.join('；')}。`;
    return result;
  }

  const passCount = SOP08_CONDITIONS.filter(key => status(key) === 'PASS').length;
  if (passCount >= 5) {
    result.classification = 'A_STRONG_EFFECTIVE';
    result.comparison_role = 'PRIMARY_EFFECTIVE';
    result.classification_reason = `SOP八项条件中有 ${passCount} 项获得真实证据 PASS，达到至少5项要求；其余 UNKNOWN 未计作 PASS。`;
    return result;
  }

  const highlySimilar = status('same_category') === 'PASS' && status('same_use_case') === 'PASS'
    && status('comparable_positioning') === 'PASS';
  const missingMarketFeedback = ['sales_or_heat', 'real_reviews', 'recent_activity'].some(key => status(key) === 'UNKNOWN');
  if (highlySimilar && missingMarketFeedback) {
    result.classification = 'B_REFERENCE';
    result.comparison_role = 'REFERENCE_ONLY';
    result.classification_reason = '品类、核心用途和直接可比定位均有证据；销量/评论/近期活跃等市场反馈缺失或不可获得，按 SOP 作为参考竞品，不将 UNKNOWN 当作弱竞品证据。';
    return result;
  }

  result.classification = 'UNQUALIFIED_INSUFFICIENT_EVIDENCE';
  result.assessment_status = 'UNQUALIFIED_INSUFFICIENT_EVIDENCE';
  result.comparison_role = 'UNQUALIFIED_NOT_IN_PRIMARY_POOL';
  result.classification_reason = '当前证据不足以证明该候选与自有产品直接可比；保留记录但不计入可用竞品池，也不要求 Leon 人工裁决。';
  result.status = 'UNQUALIFIED_INSUFFICIENT_EVIDENCE';
  result.waiting_reason = null;
  return result;
}

function isUsablePrimaryCandidate(item) {
  const pass = key => ['PASS', 'CONFIRMED', 'true'].includes(String(item?.competitor_conditions?.[key]?.status || item?.[key]));
  return item?.classification === 'A_STRONG_EFFECTIVE'
    || (item?.classification === 'B_REFERENCE' && pass('same_category') && pass('same_use_case') && pass('comparable_positioning'));
}

export function shouldSupplementSop08(candidates) {
  const existingCandidates = (candidates || []).filter(item => item?.evaluation_type === 'EXISTING_COMPETITOR_EVALUATION');
  const incompleteExisting = existingCandidates.filter(item => item.existing_evaluation_status !== 'EXISTING_CANDIDATE_EVALUATION_COMPLETE');
  if (incompleteExisting.length) return {
    should_supplement: false, effective_count: null, usable_primary_pool_count: null, target_count: 3,
    reason: 'EXISTING_CANDIDATE_EVALUATION_INCOMPLETE', incomplete_existing_count: incompleteExisting.length,
  };
  const usable = (candidates || []).filter(isUsablePrimaryCandidate);
  return { should_supplement: usable.length < 3, effective_count: usable.length, usable_primary_pool_count: usable.length, target_count: 3 };
}

export function validateSop08Preflight({ task, sop03Artifact }) {
  const blockers = [];
  const facts = task?.outputs?.confirmed_product_facts;
  const sop03 = task?.listing_executor?.registry?.LISTING_SOP_03;
  const sop07 = task?.listing_executor?.registry?.LISTING_SOP_07;
  const top20 = task?.outputs?.top20;
  const sop07FactsVersion = (sop07?.input_version_refs || []).find(item => item.artifact_type === 'CONFIRMED_PRODUCT_FACTS_VERSION')?.version;
  if (facts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || !Number.isInteger(Number(facts.version))
      || facts.sku !== task?.sku || Number(facts.version) !== Number(sop07FactsVersion)) {
    blockers.push({ code: 'SOP08_FACTS_VERSION_INVALID', reason: '当前确认事实版本必须有效，并与已通过SOP07使用的事实版本一致。', status: 'WAITING_DEPENDENCY' });
  }
  if (sop03?.status !== 'PASS' || sop03?.qa_status !== 'PASS' || sop03?.output_version !== sop03Artifact?.version) {
    blockers.push({ code: 'SOP08_SOP03_INPUT_STALE', reason: 'SOP03必须PASS且来源artifact版本必须与当前任务一致。', status: 'WAITING_DEPENDENCY' });
  }
  if (sop07?.status !== 'PASS' || sop07?.qa_status !== 'PASS' || !sop07?.output_version || top20?.version !== sop07?.output_version) {
    blockers.push({ code: 'SOP08_SOP07_INPUT_STALE', reason: 'SOP07当前正式版本必须PASS，并与TOP20产物版本一致。', status: 'WAITING_DEPENDENCY' });
  }
  // Candidate slots are optional inputs. Missing/invalid candidates are
  // recorded for audit and skipped; SOP08 supplements from the positive-volume
  // SOP07 core terms if the usable pool is below three. They are not human gates.
  const candidateSlotStatuses = inspectSop08CandidateSlots(sop03Artifact);
  const unresolved = (task?.listing_executor?.waiting_items || []).filter(item => !item.decided_at
    && item.originating_sop_step === 'LISTING_SOP_08' && ['WAITING_CONFIRMATION', 'WAITING_DECISION'].includes(item.type));
  if (unresolved.length || task?.confirmation?.status === 'OPEN') blockers.push({ code: 'SOP08_UNRESOLVED_DECISION', reason: 'SOP08仍有未关闭的人工确认或业务决策。', status: unresolved.some(item => item.type === 'WAITING_DECISION') ? 'WAITING_DECISION' : 'WAITING_CONFIRMATION' });
  // Execution concurrency is owned by the durable executor lease. Candidate/query
  // RUNNING markers are evidence of work state, not business decisions and must
  // never route an SKU into WAITING_DECISION.
  return { ready: blockers.length === 0, blockers, candidate_slot_statuses: candidateSlotStatuses };
}

/** Queries are taken only from the already-ranked formal SOP07 output. */
export function selectSop08DiscoveryQueries(top20Artifact, { alreadyQueried = [] } = {}) {
  const prior = new Set(alreadyQueried);
  return (top20Artifact?.records || [])
    .filter(record => record?.keyword_category === 'CORE_PRODUCT'
      && record?.demand_status === 'POSITIVE'
      && Number(record?.boloo_search_volume) > 0
      && record?.facts_eligibility?.status === 'ELIGIBLE_FOR_SOP06'
      && typeof record?.exact_string === 'string' && record.exact_string.trim())
    .slice()
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .filter(record => !prior.has(record.exact_string))
    .map(record => ({ rank: record.rank, exact_string: record.exact_string, boloo_search_volume: record.boloo_search_volume, keyword_category: record.keyword_category, sop07_version: top20Artifact.version }));
}

/** A persisted Product List response is unfinished until candidate assessment completes. */
export function planSop08DiscoveryQueryRecovery({ top20Artifact, queryAttempts = [], factsVersion, top20Version } = {}) {
  const sameInput = item => item?.input_versions?.facts === factsVersion
    && item?.input_versions?.top20 === top20Version;
  const completedExactStrings = [...new Set(queryAttempts
    .filter(item => sameInput(item) && item.status === 'PASS' && typeof item.exact_string === 'string')
    .map(item => item.exact_string))];
  const orderedQueries = selectSop08DiscoveryQueries(top20Artifact, { alreadyQueried: completedExactStrings });
  const eligibleExactStrings = new Set(orderedQueries.map(item => item.exact_string));
  const savedResultExactStrings = [...new Set(queryAttempts
    .filter(item => sameInput(item) && item.status === 'RESULT_SAVED' && item.evidence_ref
      && typeof item.exact_string === 'string' && eligibleExactStrings.has(item.exact_string))
    .map(item => item.exact_string))];
  return {
    completed_exact_strings: completedExactStrings,
    saved_result_exact_strings: savedResultExactStrings,
    ordered_queries: orderedQueries,
  };
}

/** Pick only the next SOP07-ranked query after the previous query has fully converged. */
export function nextSop08DiscoveryQuery(top20Artifact, { alreadyQueried = [], effectiveCount = 0 } = {}) {
  if (Number(effectiveCount) >= 3) return null;
  return selectSop08DiscoveryQueries(top20Artifact, { alreadyQueried })[0] || null;
}

export function sop08ShouldStopSupplementing({ effectiveCount, remainingQueryCount }) {
  return Number(effectiveCount) >= 3 || Number(remainingQueryCount) <= 0;
}

/**
 * SOP08 only needs BOL readiness after local evidence has converged and the
 * usable primary pool is still below three. The returned plan is deliberately
 * pure so the workbench can use the same rule in execution and offline tests.
 */
export function planSop08ExecutionPhase({ phase = 'LOCAL_CONVERGENCE', usablePoolCount = null, bolReady = false } = {}) {
  if (phase === 'COMPLETE') return { phase: 'COMPLETE', action: 'NOOP', run_local_convergence: false, requires_bol_api: false };
  if (phase === 'REMOTE_SUPPLEMENT') {
    return bolReady
      ? { phase: 'REMOTE_SUPPLEMENT', action: 'RUN_REMOTE_SUPPLEMENT', run_local_convergence: false, requires_bol_api: true }
      : { phase: 'REMOTE_SUPPLEMENT', action: 'WAITING_DEPENDENCY', run_local_convergence: false, requires_bol_api: true };
  }
  if (phase !== 'LOCAL_CONVERGENCE') throw new Error(`Unsupported SOP08 execution phase: ${phase}`);
  if (usablePoolCount == null) {
    return { phase: 'LOCAL_CONVERGENCE', action: 'RUN_LOCAL_CONVERGENCE', run_local_convergence: true, requires_bol_api: false };
  }
  if (Number(usablePoolCount) >= 3) {
    return { phase: 'LOCAL_CONVERGENCE', action: 'FINALIZE', run_local_convergence: true, requires_bol_api: false };
  }
  return bolReady
    ? { phase: 'REMOTE_SUPPLEMENT', action: 'RUN_REMOTE_SUPPLEMENT', run_local_convergence: true, requires_bol_api: true }
    : { phase: 'REMOTE_SUPPLEMENT', action: 'WAITING_DEPENDENCY', run_local_convergence: true, requires_bol_api: true };
}

export function buildSop08PhaseCheckpoint({ phase, versions, candidates = [], usablePoolCount = null,
  candidateManifestRef = null, remainingQueries = [], processedCandidateIds = [], updatedAt = new Date().toISOString() } = {}) {
  return {
    phase,
    input_versions: { ...(versions || {}) },
    candidate_manifest_ref: candidateManifestRef,
    processed_candidate_ids: [...new Set(processedCandidateIds.filter(Boolean))],
    processed_candidate_count: new Set(processedCandidateIds.filter(Boolean)).size,
    candidate_cursor: new Set(processedCandidateIds.filter(Boolean)).size,
    candidate_count: candidates.length,
    usable_primary_pool_count: usablePoolCount,
    remaining_discovery_queries: remainingQueries.map(item => typeof item === 'string' ? item : item.exact_string).filter(Boolean),
    updated_at: updatedAt,
  };
}

/** Deduplicate discovered products against supplied and already-discovered URL/product identities. */
export function dedupeSop08DiscoveredCandidates(candidates, existingCandidates = []) {
  const seen = [...(existingCandidates || [])];
  const kept = [];
  for (const item of candidates || []) {
    if (!sop08CandidateHasIdentity(item) || findSop08DuplicateCandidate(item, seen)) continue;
    kept.push(item);
    seen.push(item);
  }
  return kept;
}

function sop08CandidateIdentityKeys(item) {
  const ids = [item?.bol_product_id, item?.bolProductId, item?.productId].filter(Boolean).map(value => `id:${String(value).trim()}`);
  const eans = [item?.ean, item?.resolved_ean, ...(Array.isArray(item?.eans) ? item.eans : [])]
    .map(value => typeof value === 'object' ? value?.ean : value).filter(Boolean).map(value => `ean:${String(value).trim()}`);
  const rawUrls = [item?.bol_url, item?.canonical_url, item?.url].filter(Boolean);
  const urls = rawUrls.map(value => canonicalizeSop08BolUrl(value).canonical_url).filter(Boolean).map(value => `url:${value}`);
  return [...new Set([...ids, ...eans, ...urls])];
}

function sop08CandidateHasIdentity(item) {
  return sop08CandidateIdentityKeys(item).length > 0;
}

export function findSop08DuplicateCandidate(candidate, existingCandidates = []) {
  const keys = new Set(sop08CandidateIdentityKeys(candidate));
  if (!keys.size) return null;
  return (existingCandidates || []).find(item => sop08CandidateIdentityKeys(item).some(key => keys.has(key))) || null;
}

export function buildListingSop08Pool({ sku, factsVersion, sop03Version, top20Version, candidates, createdAt = new Date().toISOString() }) {
  const classified = candidates.map(classifyListingCompetitor);
  const primary = classified.filter(isUsablePrimaryCandidate).slice(0, 5);
  const references = classified.filter(item => item.classification === 'B_REFERENCE');
  // Directly comparable B records may join the usable pool while retaining their distinct class.
  const comparisonPool = primary;
  const counts = {
    A_STRONG_EFFECTIVE: classified.filter(item => item.classification === 'A_STRONG_EFFECTIVE').length,
    B_REFERENCE: classified.filter(item => item.classification === 'B_REFERENCE').length,
    C_WEAK_INVALID: classified.filter(item => item.classification === 'C_WEAK_INVALID').length,
    UNQUALIFIED_INSUFFICIENT_EVIDENCE: classified.filter(item => item.classification === 'UNQUALIFIED_INSUFFICIENT_EVIDENCE').length,
  };
  const lowConfidence = primary.length < 3;
  const version = `SOP08-${crypto.createHash('sha256').update(JSON.stringify({ sku, factsVersion, sop03Version, top20Version, classified, createdAt })).digest('hex').slice(0, 20)}`;
  return {
    schema_version: 1,
    artifact_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION',
    version,
    sku,
    status: 'DONE_PENDING_QA',
    input_versions: { confirmed_product_facts: factsVersion, sop03: sop03Version, top20: top20Version },
    counts,
    effective_count: primary.length,
    strong_effective_count: counts.A_STRONG_EFFECTIVE,
    usable_primary_pool_count: primary.length,
    reference_count: counts.B_REFERENCE,
    invalid_count: counts.C_WEAK_INVALID,
    main_comparison_pool: comparisonPool.map(item => item.competitor_id),
    reference_pool: references.map(item => item.competitor_id),
    confidence_status: lowConfidence ? 'LOW_COMPETITOR_POOL_CONFIDENCE' : 'NORMAL',
    confidence_reason: lowConfidence ? `仅确认 ${primary.length} 个可用主要比较对象（A类及满足直接可比条件的B类）；未以C类或无证据候选冒充有效对象。` : null,
    candidates: classified,
    evidence: {
      created_at: createdAt,
      evidence_refs: [...new Set(classified.flatMap(item => item.evidence_refs || []))],
      source: 'LEON_BOL_URLS + BOL_RETAILER_V10',
      sales_numbers_used_as_sales_evidence: false,
      numeric_scoring_used: false,
    },
  };
}

export function qaListingSop08Pool({ artifact, expectedVersions, minimumCandidates = 1 }) {
  const checks = [];
  const add = (code, pass, message) => checks.push({ code, pass: pass === true, message });
  const mainPool = new Set(artifact?.main_comparison_pool || []);
  const referencePool = new Set(artifact?.reference_pool || []);
  const traceableSource = item => {
    const ref = item?.source_ref || {};
    const versionsMatch = item?.input_versions?.facts === expectedVersions?.facts
      && item?.input_versions?.sop03 === expectedVersions?.sop03;
    const hasEvidence = Array.isArray(item?.evidence_refs) && item.evidence_refs.length > 0;
    const isDiscovery = ref.source_field === 'SOP07_CORE_PRODUCT_DISCOVERY';
    if (isDiscovery) return versionsMatch && hasEvidence
      && Boolean(ref.exact_url && ref.product_list_evidence_ref && ref.discovery_query);
    const validExactUrl = typeof ref.exact_url === 'string' && ref.exact_url.trim().length > 0;
    const auditableRejectedUrl = !validExactUrl
      && typeof ref.raw_url === 'string' && ref.raw_url.trim().length > 0
      && ['INVALID_BOL_DETAIL_URL', 'BOL_PRODUCT_ID_NOT_PARSEABLE'].includes(ref.url_resolution_reason)
      && ['C_WEAK_INVALID', 'UNQUALIFIED_INSUFFICIENT_EVIDENCE'].includes(item?.classification)
      && !mainPool.has(item?.competitor_id) && !referencePool.has(item?.competitor_id);
    return versionsMatch && hasEvidence && Boolean(ref.sop03_artifact_ref)
      && (validExactUrl || auditableRejectedUrl);
  };
  add('SOP08_ARTIFACT_TYPE', artifact?.artifact_type === 'EFFECTIVE_COMPETITOR_POOL_VERSION', '产物类型必须是 EFFECTIVE_COMPETITOR_POOL_VERSION。');
  add('SOP08_INPUT_VERSIONS', artifact?.input_versions?.confirmed_product_facts === expectedVersions?.facts
    && artifact?.input_versions?.sop03 === expectedVersions?.sop03 && artifact?.input_versions?.top20 === expectedVersions?.top20,
  'facts、SOP03、TOP20版本必须与当前正式输入一致。');
  add('SOP08_CANDIDATES_PRESENT', Array.isArray(artifact?.candidates) && artifact.candidates.length >= minimumCandidates, '必须保留至少一个可追溯候选记录。');
  add('SOP08_CLASSIFICATIONS_COMPLETE', (artifact?.candidates || []).every(item => ['A_STRONG_EFFECTIVE', 'B_REFERENCE', 'C_WEAK_INVALID', 'UNQUALIFIED_INSUFFICIENT_EVIDENCE'].includes(item.classification)
    && typeof item.classification_reason === 'string' && item.classification_reason.trim()
    && SOP08_CONDITIONS.every(key => ['PASS', 'FAIL', 'UNKNOWN'].includes(item.competitor_conditions?.[key]?.status)
      && Array.isArray(item.competitor_conditions?.[key]?.evidence_refs) && item.competitor_conditions[key].evidence_refs.length)), '每个最终候选均须有A/B/C文字理由，并为8项条件逐项保存PASS/FAIL/UNKNOWN及证据引用。');
  add('SOP08_A_MINIMUM_PASS', (artifact?.candidates || []).every(item => item.classification !== 'A_STRONG_EFFECTIVE'
    || SOP08_CONDITIONS.filter(key => item.competitor_conditions?.[key]?.status === 'PASS').length >= 5), 'A级竞品至少5/8项必须有真实证据PASS，UNKNOWN不计PASS。');
  add('SOP08_B_DIRECT_COMPARABILITY', (artifact?.candidates || []).every(item => item.classification !== 'B_REFERENCE'
    || ['same_category', 'same_use_case', 'comparable_positioning'].every(key => item.competitor_conditions?.[key]?.status === 'PASS'
      && (item.competitor_conditions?.[key]?.evidence_refs || []).length > 0)), 'B级必须有品类、用途和直接可比性的本地证据。');
  add('SOP08_EVIDENCE_TRACEABLE', (artifact?.candidates || []).every(traceableSource), '每条记录必须保留正式URL，或保留明确标为无效且未进入竞品池的原始URL，并锁定上游版本和实际来源证据。');
  add('SOP08_POOL_BOUND', (artifact?.main_comparison_pool || []).length <= 5, '主要比较池最多5个，C级弱/无效竞品不得进入。');
  add('SOP08_POOL_CLASS_BOUND', (artifact?.main_comparison_pool || []).every(id => artifact.candidates.some(item => item.competitor_id === id && isUsablePrimaryCandidate(item)))
    && (artifact?.reference_pool || []).every(id => artifact.candidates.some(item => item.competitor_id === id && item.classification === 'B_REFERENCE')), '主要比较池只收A类或满足直接可比要求的B类；B类保留独立类型，C类不得混入。');
  add('SOP08_LOW_CONFIDENCE_EXPLICIT', artifact?.usable_primary_pool_count >= 3 || artifact?.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE', '可用A+B主要比较对象不足3个时必须明确标记 LOW_COMPETITOR_POOL_CONFIDENCE。');
  add('SOP08_NO_SCORES', artifact?.evidence?.numeric_scoring_used === false
    && (artifact?.candidates || []).every(item => !Object.keys(item).some(key => /(^|_)(score|weight)(_|$)|rating_score/i.test(key))), '不得出现数值评分或隐藏权重字段。');
  add('SOP08_SALES_CLAIM_GUARD', artifact?.evidence?.sales_numbers_used_as_sales_evidence === false
    && (artifact?.candidates || []).every(item => item.sales_evidence?.status === 'NOT_AVAILABLE' || item.sales_evidence?.evidence_ref), '无真实销量接口证据时销量必须为 NOT_AVAILABLE。');
  add('SOP08_DISCOVERY_EVIDENCE', artifact?.discovery?.triggered !== true
    || (artifact?.discovery?.queries || []).every(item => item.status === 'PASS' && item.evidence_ref
      && item.keyword_category === 'CORE_PRODUCT' && Number(item.boloo_search_volume) > 0
      && !/[\u3400-\u9fff]/.test(item.exact_string || '')),
  '补充查询必须来自SOP07正式CORE_PRODUCT正搜索量exact string，且每次Product List结果均有持久证据。');
  add('SOP08_DISCOVERY_RANK_NOT_HEAT', artifact?.discovery?.triggered !== true
    || (artifact?.discovery?.product_list_rank_used_as_sales_or_heat === false
      && (artifact?.discovery?.unresolved_candidates || []).every(item => item.sales_evidence?.status === 'NOT_AVAILABLE'
        && item.heat_evidence?.status === 'NOT_AVAILABLE')),
  'Product List排名与页面出现不得作为销量或热度证据。');
  add('SOP08_DISCOVERED_CANDIDATE_TRACE', (artifact?.discovery?.discovered_candidates || []).every(item =>
    item.candidate_status === 'DISCOVERED_CANDIDATE' && item.product_list_evidence_ref
      && Number(item.facts_version) === Number(expectedVersions?.facts) && item.top20_version === expectedVersions?.top20
      && item.sales_evidence?.status === 'NOT_AVAILABLE' && item.heat_evidence?.status === 'NOT_AVAILABLE'
      && item.status !== 'RUNNING'), 'Product List结果必须保留为可追溯发现候选，版本明确，且排名不得冒充销量/热度。');
  return { status: checks.every(item => item.pass) ? 'PASS' : 'FAIL', checks, checked_at: new Date().toISOString() };
}

export function sop08SourceSlots() { return [...SOURCE_SLOTS]; }
