import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicJson as writeJsonWithTransientRetry } from './atomic_json.mjs';

const PAGE_FIELD_NAMES = [
  'requested_product_id', 'canonical_product_id', 'product_id_match', 'canonical_url', 'ean_gtin', 'title',
  'current_price', 'main_image', 'image_list', 'description', 'specifications', 'package_or_set_content',
  'rating', 'review_count', 'seller', 'seller_rating', 'delivery_text', 'fulfilment', 'current_offer',
];
const PAGE_STATUS = new Set(['AVAILABLE_REAL', 'AVAILABLE_PARTIAL', 'NOT_PRESENT', 'UNKNOWN']);
const VALID_REVIEWS_STATUS = new Set(['NO_REVIEWS', 'AVAILABLE', 'UNKNOWN']);
const SAFE_ID = /^[A-Za-z0-9._-]{1,140}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function field(input, fallback = 'UNKNOWN') {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'value')) {
    const status = PAGE_STATUS.has(input.status) ? input.status : fallback;
    return { status, value: input.value ?? null, evidence_ref: input.evidence_ref ?? null, note: input.note ?? null };
  }
  return { status: fallback, value: input ?? null, evidence_ref: null, note: null };
}

function valueOf(input) {
  return input && typeof input === 'object' && Object.hasOwn(input, 'value') ? input.value : input;
}

function isConfirmedIdentityMatch(value) {
  const match = valueOf(value);
  // The persisted BOL page-probe contract serializes this comparison as the
  // lowercase string "true". Accept only that exact representation or a
  // native boolean, while the caller still independently checks both IDs and
  // the canonical product URL below.
  return match === true || match === 'true';
}

function normalizeReviewsStatus(reviews) {
  const rawStatus = valueOf(reviews?.reviews_status);
  if (VALID_REVIEWS_STATUS.has(rawStatus)) return rawStatus;
  const items = Array.isArray(reviews?.items) ? reviews.items : [];
  const count = Number(valueOf(reviews?.review_count));
  if (rawStatus === 'AVAILABLE_REAL' && (items.length > 0 || (Number.isFinite(count) && count > 0))) return 'AVAILABLE';
  return 'UNKNOWN';
}

function productIdFromUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !(url.hostname === 'bol.com' || url.hostname.endsWith('.bol.com'))) return null;
    return url.pathname.match(/\/(\d{8,16})\/?$/)?.[1] || null;
  } catch { return null; }
}

function canonicalBolUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !(url.hostname === 'bol.com' || url.hostname.endsWith('.bol.com'))) return null;
    if (!productIdFromUrl(url.href)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
  } catch { return null; }
}

function normalizedUrl(raw) {
  const canonical = canonicalBolUrl(raw);
  return canonical ? canonical.replace(/\/$/, '') : null;
}

function requiredField(value, label) {
  const unwrapped = valueOf(value);
  if (unwrapped == null || String(unwrapped).trim() === '') throw Object.assign(new Error(`${label} is required.`), { code: 'SOP09_PAGE_FACTS_IDENTITY_MISSING' });
  return String(unwrapped).trim();
}

function validateContext({ sku, competitor, sop08Artifact, expectedSop08Version }) {
  if (!SAFE_ID.test(String(sku || ''))) throw Object.assign(new Error('Invalid SKU.'), { code: 'SOP09_PAGE_FACTS_SKU_INVALID' });
  if (!competitor || !SAFE_ID.test(String(competitor.competitor_id || ''))) throw Object.assign(new Error('Invalid competitor identity.'), { code: 'SOP09_PAGE_FACTS_COMPETITOR_INVALID' });
  if (!sop08Artifact || sop08Artifact.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION' || sop08Artifact.status !== 'PASS') {
    throw Object.assign(new Error('SOP08 PASS artifact is required.'), { code: 'SOP09_PAGE_FACTS_SOP08_ARTIFACT_INVALID' });
  }
  if (expectedSop08Version && sop08Artifact.version !== expectedSop08Version) throw Object.assign(new Error('SOP08 artifact version mismatch.'), { code: 'SOP09_PAGE_FACTS_SOP08_VERSION_MISMATCH' });
  if (sop08Artifact.sku !== sku) throw Object.assign(new Error('SOP08 artifact SKU mismatch.'), { code: 'SOP09_PAGE_FACTS_SOP08_SKU_MISMATCH' });
  if (!Array.isArray(sop08Artifact.main_comparison_pool) || !sop08Artifact.main_comparison_pool.includes(competitor.competitor_id)) {
    throw Object.assign(new Error('Competitor is not in the SOP08 main comparison pool.'), { code: 'SOP09_PAGE_FACTS_COMPETITOR_NOT_IN_POOL' });
  }
  const candidate = (sop08Artifact.candidates || []).find(row => row.competitor_id === competitor.competitor_id);
  if (!candidate || !['A_STRONG_EFFECTIVE', 'B_REFERENCE'].includes(candidate.classification)) throw Object.assign(new Error('SOP08 candidate is not eligible for the formal comparison pool.'), { code: 'SOP09_PAGE_FACTS_CLASSIFICATION_MISMATCH' });
  const lowConfidence = sop08Artifact.low_competitor_pool_confidence === true
    || sop08Artifact.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE';
  const productId = String(candidate.bol_product_id || '').trim();
  if (!productId) throw Object.assign(new Error('SOP08 candidate has no product ID.'), { code: 'SOP09_PAGE_FACTS_PRODUCT_ID_MISSING' });
  const candidateUrl = candidate.bol_url || candidate.canonical_url;
  if (!candidateUrl || productIdFromUrl(candidateUrl) !== productId) throw Object.assign(new Error('SOP08 candidate URL does not match product ID.'), { code: 'SOP09_PAGE_FACTS_SOP08_URL_MISMATCH' });
  return { candidate, productId, candidateUrl, lowConfidence };
}

export function buildSop09BolPageFacts({ sku, competitor, sop08Artifact, pageProbeResult, expectedSop08Version }) {
  const context = validateContext({ sku, competitor, sop08Artifact, expectedSop08Version });
  if (!pageProbeResult || typeof pageProbeResult !== 'object') throw Object.assign(new Error('Page Probe result is required.'), { code: 'SOP09_PAGE_FACTS_RESULT_MISSING' });

  const requestedId = requiredField(pageProbeResult.requested_product_id, 'requested_product_id');
  const canonicalId = requiredField(pageProbeResult.canonical_product_id, 'canonical_product_id');
  const match = isConfirmedIdentityMatch(pageProbeResult.product_id_match);
  const pageUrl = requiredField(pageProbeResult.canonical_url, 'canonical_url');
  const eanField = field(pageProbeResult.ean_gtin);
  const ean = valueOf(eanField);
  const expectedPageUrl = normalizedUrl(context.candidateUrl);
  if (requestedId !== context.productId || canonicalId !== context.productId || match !== true || productIdFromUrl(pageUrl) !== context.productId || normalizedUrl(pageUrl) !== expectedPageUrl) {
    throw Object.assign(new Error('Page Probe identity does not match the SOP08 competitor.'), { code: 'SOP09_PAGE_FACTS_IDENTITY_MISMATCH' });
  }
  if (eanField.status === 'AVAILABLE_REAL' && !/^\d{8,14}$/.test(String(ean || ''))) throw Object.assign(new Error('Page Probe marks EAN/GTIN real but the value is invalid.'), { code: 'SOP09_PAGE_FACTS_EAN_INVALID' });

  const fields = {};
  for (const name of PAGE_FIELD_NAMES) fields[name] = field(pageProbeResult[name]);
  fields.requested_product_id = field(pageProbeResult.requested_product_id);
  fields.canonical_product_id = field(pageProbeResult.canonical_product_id);
  fields.product_id_match = field(pageProbeResult.product_id_match);
  fields.canonical_url = field(pageProbeResult.canonical_url);
  fields.ean_gtin = eanField;
  fields.images = {
    status: fields.image_list.status === 'AVAILABLE_REAL' ? 'AVAILABLE_REAL' :
      (fields.image_list.status === 'AVAILABLE_PARTIAL' || fields.main_image.status === 'AVAILABLE_REAL' ? 'AVAILABLE_PARTIAL' : fields.image_list.status),
    main_image: fields.main_image,
    image_list: fields.image_list,
  };
  const rawReviewsStatus = pageProbeResult.reviews?.reviews_status;
  fields.reviews = {
    reviews_status: normalizeReviewsStatus(pageProbeResult.reviews),
    raw_reviews_status: {
      status: PAGE_STATUS.has(pageProbeResult.reviews?.status) ? pageProbeResult.reviews.status : 'UNKNOWN',
      value: rawReviewsStatus ?? null,
      evidence_ref: pageProbeResult.reviews?.review_count?.evidence_ref || pageProbeResult.reviews?.pagination_status?.evidence_ref || null,
    },
    items: Array.isArray(pageProbeResult.reviews?.items) ? pageProbeResult.reviews.items : [],
    review_count: field(pageProbeResult.reviews?.review_count || pageProbeResult.review_count),
    pagination_status: 'PAGINATION_UNVERIFIED',
    raw_pagination_status: field(pageProbeResult.reviews?.pagination_status),
  };
  if (fields.reviews.reviews_status === 'NO_REVIEWS') {
    fields.reviews.items = [];
    fields.reviews.review_count = { status: 'NOT_PRESENT', value: null, evidence_ref: pageProbeResult.reviews?.review_count?.evidence_ref || pageProbeResult.reviews?.status?.evidence_ref || null, note: '页面明确显示无评论。' };
    fields.rating = { status: 'NOT_PRESENT', value: null, evidence_ref: pageProbeResult.rating?.evidence_ref || null, note: '页面明确显示无评论。' };
    fields.review_count = structuredClone(fields.reviews.review_count);
    fields.reviews.pagination_status = 'NOT_APPLICABLE';
  } else if (fields.reviews.reviews_status === 'AVAILABLE') {
    const pageReviewStatus = pageProbeResult.reviews?.pagination_status?.status;
    const pageSaysComplete = pageProbeResult.reviews?.pagination_complete === true;
    fields.reviews.pagination_status = pageSaysComplete ? 'AVAILABLE' :
      (pageReviewStatus === 'AVAILABLE_REAL' && pageProbeResult.reviews?.pagination_complete === true ? 'AVAILABLE' : 'PAGINATION_UNVERIFIED');
  }

  const domEvidenceRefs = Array.isArray(pageProbeResult.dom_evidence_refs) ? pageProbeResult.dom_evidence_refs : [];
  const rawEvidence = structuredClone(pageProbeResult);
  const captureHash = hash(rawEvidence);
  const checkedAt = requiredField(pageProbeResult.checked_at, 'checked_at');
  const pageFactsVersion = `BOL_PAGE_FACTS-${hash({ sku, competitorId: competitor.competitor_id, sop08: sop08Artifact.version, captureHash }).slice(0, 20)}`;
  const pageFacts = {
    schema_version: 1,
    artifact_type: 'BOL_PAGE_FACTS_VERSION',
    version: pageFactsVersion,
    sku,
    competitor_id: competitor.competitor_id,
    source: 'BOL_PAGE_PROBE_CONTRACT',
    requested_product_id: requestedId,
    canonical_product_id: canonicalId,
    product_id_match: true,
    canonical_url: pageUrl,
    ean_gtin: ean == null ? null : String(ean),
    ...Object.fromEntries(PAGE_FIELD_NAMES.filter(name => !['requested_product_id', 'canonical_product_id', 'product_id_match', 'canonical_url', 'ean_gtin'].includes(name)).map(name => [name, fields[name]])),
    images: fields.images,
    reviews_status: fields.reviews.reviews_status,
    reviews: fields.reviews,
    seller: fields.seller,
    seller_rating: fields.seller_rating,
    delivery_text: fields.delivery_text,
    fulfilment: fields.fulfilment,
    current_offer: fields.current_offer,
    fields,
    dom_evidence_refs: domEvidenceRefs,
    checked_at: checkedAt,
    source_capture_sha256: captureHash,
    sop08_context_ref: { artifact_type: sop08Artifact.artifact_type, version: sop08Artifact.version },
  };
  const bundleVersion = `BOL_COMPETITOR_EVIDENCE-${hash({ pageFactsVersion, sop08: sop08Artifact.version, ean }).slice(0, 20)}`;
  const bundle = {
    schema_version: 1,
    artifact_type: 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION',
    version: bundleVersion,
    sku,
    competitor_id: competitor.competitor_id,
    PAGE_FACTS: { status: 'READY', artifact_type: pageFacts.artifact_type, version: pageFacts.version, page_facts: pageFacts },
    BOL_API_FACTS: {
      status: 'NOT_RUN', ean_gtin: ean == null ? null : String(ean),
      offers: { status: 'NOT_RUN', adapter_method: 'getOffers', country_code: 'NL', evidence_refs: [] },
      ratings: { status: 'NOT_RUN', adapter_method: 'getRatings', evidence_refs: [] },
    },
    SOP08_CONTEXT: {
      artifact_type: sop08Artifact.artifact_type,
      artifact_version: sop08Artifact.version,
      classification: context.candidate.classification,
      low_competitor_pool_confidence: context.lowConfidence,
      confidence_reason: sop08Artifact.confidence_reason || null,
    },
    created_at: new Date().toISOString(),
  };
  return { pageFacts, bundle, rawEvidence, captureHash };
}

function qaCheck(code, pass, message) { return { code, pass: Boolean(pass), message }; }

export function qaSop09BolDataSourceIntegration({ pageFacts, bundle, rawEvidencePathExists, sop08BytesBefore, sop08BytesAfter }) {
  const eanEvidence = pageFacts?.fields?.ean_gtin?.evidence_ref;
  const eanEvidenceMatchesProduct = typeof eanEvidence === 'string' && eanEvidence.startsWith('dom://www.bol.com/') && eanEvidence.includes(`/${pageFacts?.canonical_product_id}/`);
  const checks = [
    qaCheck('PRODUCT_ID_MATCH', pageFacts?.product_id_match === true && pageFacts.requested_product_id === pageFacts.canonical_product_id, 'requested/canonical product ID match.'),
    qaCheck('CANONICAL_URL_MATCH', pageFacts?.canonical_url && productIdFromUrl(pageFacts.canonical_url) === pageFacts.canonical_product_id, 'canonical URL belongs to the verified product ID.'),
    qaCheck('PAGE_FACTS_EVIDENCE_READABLE', rawEvidencePathExists === true && (pageFacts?.dom_evidence_refs || []).length > 0, 'raw capture and DOM evidence references are present.'),
    qaCheck('EAN_HAS_PAGE_EVIDENCE', pageFacts?.fields?.ean_gtin?.status !== 'AVAILABLE_REAL' || (/^\d{8,14}$/.test(String(pageFacts?.ean_gtin || '')) && eanEvidenceMatchesProduct && (pageFacts.dom_evidence_refs || []).some(item => item.ref === eanEvidence && item.field === 'ean_gtin')), 'A reported real EAN is sourced from a DOM evidence reference; unavailable EAN remains explicit.'),
    qaCheck('SOP08_CLASSIFICATION_PRESERVED', ['A_STRONG_EFFECTIVE', 'B_REFERENCE'].includes(bundle?.SOP08_CONTEXT?.classification), 'The current eligible SOP08 classification is preserved.'),
    qaCheck('LOW_CONFIDENCE_CONTEXT_PRESERVED', typeof bundle?.SOP08_CONTEXT?.low_competitor_pool_confidence === 'boolean', 'The current SKU confidence flag is preserved without imposing a fixed value.'),
    qaCheck('NO_REVIEWS_SEMANTICS', pageFacts?.fields?.reviews?.reviews_status !== 'NO_REVIEWS' ||
      (pageFacts.fields.rating.status === 'NOT_PRESENT' && pageFacts.fields.review_count.status === 'NOT_PRESENT' && pageFacts.fields.reviews.items.length === 0), 'NO_REVIEWS remains a valid terminal page result.'),
    qaCheck('LAYERED_DATA_SEPARATION', bundle?.PAGE_FACTS?.page_facts?.artifact_type === 'BOL_PAGE_FACTS_VERSION' && bundle?.BOL_API_FACTS?.offers?.status === 'NOT_RUN' && bundle?.BOL_API_FACTS?.ratings?.status === 'NOT_RUN' && bundle?.SOP08_CONTEXT?.artifact_version === pageFacts?.sop08_context_ref?.version && bundle?.competitor_id === pageFacts?.competitor_id, 'PAGE_FACTS, BOL_API_FACTS, and SOP08_CONTEXT remain separate and tied to the same competitor.'),
    qaCheck('SOP08_IMMUTABLE', Buffer.isBuffer(sop08BytesBefore) && Buffer.isBuffer(sop08BytesAfter) && sop08BytesBefore.equals(sop08BytesAfter), 'SOP08 artifact bytes are unchanged.'),
  ];
  return { status: checks.every(item => item.pass) ? 'PASS' : 'FAIL', checked_at: new Date().toISOString(), checks };
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temp, filePath);
}

export async function persistSop09BolPageFacts({ dataRoot, sku, competitor, sop08Artifact, sop08ArtifactPath, pageProbeResult, expectedSop08Version }) {
  const artifactBytesBefore = sop08ArtifactPath ? await fs.readFile(sop08ArtifactPath) : null;
  const built = buildSop09BolPageFacts({ sku, competitor, sop08Artifact, pageProbeResult, expectedSop08Version });
  const base = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources');
  const target = path.join(base, built.pageFacts.version);
  if (!target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('Artifact path escaped data root.'), { code: 'SOP09_ARTIFACT_PATH_INVALID' });
  await fs.mkdir(base, { recursive: true });
  try {
    const existing = JSON.parse(await fs.readFile(path.join(target, 'bundle.json'), 'utf8'));
    if (existing.version !== built.bundle.version || existing.PAGE_FACTS.page_facts.source_capture_sha256 !== built.captureHash) throw Object.assign(new Error('Version path already contains different evidence.'), { code: 'SOP09_PAGE_FACTS_VERSION_COLLISION' });
    return { pageFacts: existing.PAGE_FACTS.page_facts, bundle: existing, qa: JSON.parse(await fs.readFile(path.join(target, 'qa.json'), 'utf8')), artifact_dir: target, idempotent_reuse: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const stage = await fs.mkdtemp(path.join(base, '.sop09-stage-'));
  try {
    await fs.mkdir(path.join(stage, 'evidence'), { recursive: true });
    const rawEvidenceRef = `evidence/${built.pageFacts.version}-page-probe.json`;
    const pageFactsRef = `page-facts.json`;
    const bundleRef = `bundle.json`;
    const rawPath = path.join(stage, rawEvidenceRef);
    await writeJsonAtomic(rawPath, built.rawEvidence);
    const pageFacts = { ...built.pageFacts, raw_evidence_ref: rawEvidenceRef };
    const bundle = { ...built.bundle, PAGE_FACTS: { ...built.bundle.PAGE_FACTS, artifact_ref: pageFactsRef, page_facts: pageFacts } };
    await writeJsonAtomic(path.join(stage, pageFactsRef), pageFacts);
    await writeJsonAtomic(path.join(stage, bundleRef), bundle);
    const rawEvidencePathExists = (await fs.stat(rawPath)).isFile();
    const artifactBytesAfter = sop08ArtifactPath ? await fs.readFile(sop08ArtifactPath) : null;
    const qa = qaSop09BolDataSourceIntegration({ pageFacts, bundle, rawEvidencePathExists, sop08BytesBefore: artifactBytesBefore, sop08BytesAfter: artifactBytesAfter });
    await writeJsonAtomic(path.join(stage, 'qa.json'), qa);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(stage, target);
    return { pageFacts, bundle, qa, artifact_dir: target, idempotent_reuse: false };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function responseStatusFromSource(source) {
  const match = String(source || '').match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function safeAdapterError(error) {
  if (!error) return null;
  return {
    code: error.code || null,
    request_id: error.request_id || error.adapter_request_id || null,
    endpoint: error.endpoint || null,
    method: error.method || null,
    request_params: error.request_params || null,
    started_at: error.started_at || null,
    finished_at: error.finished_at || null,
    response_received: error.response_received ?? null,
    http_status: error.http_status ?? error.status ?? null,
    response_headers: error.safe_headers || error.response_headers || null,
    response_body: error.safe_body || error.response_body || null,
    transport_code: error.transport_code || null,
    transport_class: error.transport_class || null,
    adapter_original_message: error.adapter_original_message || error.message || null,
  };
}

function buildApiMethodFact({ method, result, error, ean, countryCode = 'NL', checkedAt, pageCapturedAt = null }) {
  const source = result?.source || null;
  const httpStatus = responseStatusFromSource(source) ?? error?.http_status ?? error?.status ?? null;
  const executed = Boolean(result || error);
  const observedAt = result?.createdAt || error?.finished_at || null;
  const observedTime = Date.parse(String(observedAt || ''));
  const pageCaptureTime = Date.parse(String(pageCapturedAt || ''));
  const temporalRelation = !executed ? 'NOT_APPLICABLE'
    : Number.isFinite(observedTime) && Number.isFinite(pageCaptureTime)
    ? (observedTime >= pageCaptureTime ? 'AT_OR_AFTER_PAGE_CAPTURE' : 'BEFORE_PAGE_CAPTURE')
    : 'TIME_UNKNOWN';
  const usableAsCurrent = executed && temporalRelation === 'AT_OR_AFTER_PAGE_CAPTURE';
  const evidenceRef = result ? `evidence/${method.toLowerCase()}-response.json` : null;
  const common = {
    provider: 'BOL_RETAILER_V10', method,
    checked_at: observedAt,
    consumed_at: checkedAt,
    request_id: result?.requestId || result?.request_id || error?.request_id || error?.adapter_request_id || 'NOT_REPORTED_BY_ADAPTER',
    request_id_status: result?.requestId || result?.request_id || error?.request_id || error?.adapter_request_id ? 'REPORTED' : 'NOT_REPORTED_BY_ADAPTER',
    endpoint: error?.endpoint || (method === 'OFFERS'
      ? `/retailer/products/${ean}/offers`
      : `/retailer/products/${ean}/ratings`),
    http_status: httpStatus,
    response_received: result ? true : (error?.response_received ?? null),
    cache_hit: result?.cacheHit === true,
    response_source: source,
    temporal_relation_to_page_facts: temporalRelation,
    usable_as_current: usableAsCurrent,
    evidence_refs: evidenceRef ? [evidenceRef] : [],
  };
  if (result) {
    const structured = result.structuredResult || {};
    if (method === 'OFFERS') {
      const offers = Array.isArray(structured.offers) ? structured.offers : [];
      return {
        ...common,
        status: httpStatus === 200 ? 'AVAILABLE_REAL' : 'UNKNOWN',
        country_code: countryCode,
        offer_count: offers.length,
        current_offers: offers,
        availability_status: offers.length ? 'OFFERS_RETURNED' : 'NO_OFFERS_RETURNED',
      };
    }
    const ratings = Array.isArray(structured.ratings) ? structured.ratings : [];
    const ratingCount = ratings.reduce((sum, row) => sum + (Number.isFinite(Number(row.count)) ? Number(row.count) : 0), 0);
    return {
      ...common,
      status: httpStatus === 200 ? 'AVAILABLE_REAL' : 'UNKNOWN',
      rating_distribution: ratings,
      rating_count: ratingCount,
      overall_rating: 'NOT_REPORTED_BY_ENDPOINT',
      review_count: 'NOT_INFERRED_FROM_RATING_COUNT',
      review_content: 'NOT_PROVIDED_BY_RATINGS_ENDPOINT',
    };
  }
  if (error) {
    const safe = safeAdapterError(error);
    const status = httpStatus === 404 ? 'NOT_AVAILABLE'
      : safe.response_received === false ? 'WAITING_DEPENDENCY'
        : (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) ? 'WAITING_DEPENDENCY'
          : httpStatus >= 400 && httpStatus <= 499 ? 'FAILED_REQUEST' : 'UNKNOWN';
    return { ...common, status, failure: safe, evidence_refs: [] };
  }
  return { ...common, status: 'NOT_RUN', reason: 'The method was not executed; no result or failure evidence was supplied.', evidence_refs: [] };
}

/** Build an immutable API layer without converting unqueried fields into unavailable values. */
export function buildSop09BolApiFacts({ sku, competitor, pageFacts, offersResult = null, ratingsResult = null,
  offersError = null, ratingsError = null, checkedAt = new Date().toISOString() }) {
  const ean = String(valueOf(pageFacts?.ean_gtin) ?? '').trim();
  if (!SAFE_ID.test(String(sku || '')) || pageFacts?.artifact_type !== 'BOL_PAGE_FACTS_VERSION'
    || pageFacts.sku !== sku || pageFacts.competitor_id !== competitor?.competitor_id
    || pageFacts.product_id_match !== true || pageFacts.requested_product_id !== pageFacts.canonical_product_id
    || !/^\d{8,14}$/.test(ean)) {
    throw Object.assign(new Error('BOL API enrichment requires a matching persisted page identity and EAN.'), { code: 'SOP09_API_IDENTITY_GATE_FAILED' });
  }
  const offers = buildApiMethodFact({ method: 'OFFERS', result: offersResult, error: offersError, ean, checkedAt, pageCapturedAt: pageFacts.checked_at });
  const ratings = buildApiMethodFact({ method: 'RATINGS', result: ratingsResult, error: ratingsError, ean, checkedAt, pageCapturedAt: pageFacts.checked_at });
  if (offersResult) offers.evidence_refs = ['evidence/offers-response.json'];
  if (ratingsResult) ratings.evidence_refs = ['evidence/ratings-response.json'];
  const identity = { sku, competitor_id: competitor.competitor_id, ean_gtin: ean, page_facts_version: pageFacts.version };
  const sourceDigests = {
    offers: offersResult ? hash({ rawResponse: offersResult.rawResponse, structuredResult: offersResult.structuredResult, source: offersResult.source, createdAt: offersResult.createdAt }) : hash(safeAdapterError(offersError)),
    ratings: ratingsResult ? hash({ rawResponse: ratingsResult.rawResponse, structuredResult: ratingsResult.structuredResult, source: ratingsResult.source, createdAt: ratingsResult.createdAt }) : hash(safeAdapterError(ratingsError)),
  };
  const version = `BOL_API_FACTS-${hash({ identity, offers, ratings, sourceDigests }).slice(0, 20)}`;
  return {
    schema_version: 1, artifact_type: 'BOL_API_FACTS_VERSION', version,
    sku, competitor_id: competitor.competitor_id, ean_gtin: ean,
    source: 'BOL_RETAILER_V10', identity,
    offers, ratings,
    checked_at: checkedAt,
    source_digests: sourceDigests,
    status: offers.status === 'AVAILABLE_REAL' && ratings.status === 'AVAILABLE_REAL'
      && offers.usable_as_current === true && ratings.usable_as_current === true ? 'READY'
      : offers.status === 'WAITING_DEPENDENCY' || ratings.status === 'WAITING_DEPENDENCY' ? 'WAITING_DEPENDENCY' : 'PARTIAL',
  };
}

export async function persistSop09BolApiFacts({ dataRoot, sku, competitor, pageFacts, offersResult = null, ratingsResult = null,
  offersError = null, ratingsError = null, checkedAt = new Date().toISOString() }) {
  const built = buildSop09BolApiFacts({ sku, competitor, pageFacts, offersResult, ratingsResult, offersError, ratingsError, checkedAt });
  const base = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources');
  const target = path.join(base, built.version);
  if (!target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('API artifact path escaped data root.'), { code: 'SOP09_ARTIFACT_PATH_INVALID' });
  const evidence = {};
  if (offersResult) evidence['offers-response.json'] = {
    artifact_type: 'BOL_API_RESPONSE_EVIDENCE', sku, competitor_id: competitor.competitor_id, ean_gtin: built.ean_gtin,
    method: 'OFFERS', checked_at: built.offers.checked_at, consumed_at: checkedAt, http_status: built.offers.http_status,
    request_id: built.offers.request_id, source: built.offers.response_source, cache_hit: built.offers.cache_hit,
    raw_response: offersResult.rawResponse, structured_result: offersResult.structuredResult,
  };
  else if (offersError) evidence['offers-error.json'] = { artifact_type: 'BOL_API_ERROR_EVIDENCE', sku, competitor_id: competitor.competitor_id, ean_gtin: built.ean_gtin, method: 'OFFERS', ...safeAdapterError(offersError) };
  if (ratingsResult) evidence['ratings-response.json'] = {
    artifact_type: 'BOL_API_RESPONSE_EVIDENCE', sku, competitor_id: competitor.competitor_id, ean_gtin: built.ean_gtin,
    method: 'RATINGS', checked_at: built.ratings.checked_at, consumed_at: checkedAt, http_status: built.ratings.http_status,
    request_id: built.ratings.request_id, source: built.ratings.response_source, cache_hit: built.ratings.cache_hit,
    raw_response: ratingsResult.rawResponse, structured_result: ratingsResult.structuredResult,
  };
  else if (ratingsError) evidence['ratings-error.json'] = { artifact_type: 'BOL_API_ERROR_EVIDENCE', sku, competitor_id: competitor.competitor_id, ean_gtin: built.ean_gtin, method: 'RATINGS', ...safeAdapterError(ratingsError) };
  await fs.mkdir(path.join(target, 'evidence'), { recursive: true });
  const apiPath = path.join(target, 'api-facts.json');
  try {
    const existing = JSON.parse(await fs.readFile(apiPath, 'utf8'));
    if (canonicalJson(existing) !== canonicalJson(built)) throw Object.assign(new Error('API facts version collision.'), { code: 'SOP09_API_FACTS_VERSION_COLLISION' });
    return { apiFacts: existing, artifact_ref: path.relative(dataRoot, apiPath).replace(/\\/g, '/'), idempotent_reuse: true };
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const [name, item] of Object.entries(evidence)) await writeJsonWithTransientRetry(path.join(target, 'evidence', name), item);
  await writeJsonWithTransientRetry(apiPath, built);
  return { apiFacts: built, artifact_ref: path.relative(dataRoot, apiPath).replace(/\\/g, '/'), idempotent_reuse: false };
}

function setVersion(layer, entries) {
  return `${layer}-${hash(entries.map(entry => ({ competitor_id: entry.competitor_id, version: entry.version }))).slice(0, 20)}`;
}

export async function persistSop09BolEvidenceBundle({ dataRoot, sku, sop08Artifact, competitors }) {
  const pool = Array.isArray(sop08Artifact?.main_comparison_pool) ? sop08Artifact.main_comparison_pool.map(item => typeof item === 'string' ? item : item?.competitor_id) : [];
  if (sop08Artifact?.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION' || sop08Artifact.status !== 'PASS'
    || sop08Artifact.sku !== sku || !pool.length || !Array.isArray(competitors)
    || competitors.length !== pool.length || new Set(competitors.map(item => item?.competitor_id)).size !== pool.length
    || pool.some(id => !competitors.some(item => item.competitor_id === id))) {
    throw Object.assign(new Error('SOP09 BOL bundle must cover the current passed SOP08 pool exactly once.'), { code: 'SOP09_BOL_BUNDLE_COVERAGE_INVALID' });
  }
  const pageSet = setVersion('BOL_PAGE_FACTS_SET', competitors.map(item => ({ competitor_id: item.competitor_id, version: item.pageFacts?.version })));
  const apiSet = setVersion('BOL_API_FACTS_SET', competitors.map(item => ({ competitor_id: item.competitor_id, version: item.apiFacts?.version })));
  const bundleCore = { sku, sop08_version: sop08Artifact.version, page_set: pageSet, api_set: apiSet,
    competitors: competitors.map(item => ({ competitor_id: item.competitor_id, page_version: item.pageFacts?.version, api_version: item.apiFacts?.version })) };
  const version = `BOL_COMPETITOR_EVIDENCE_BUNDLE-${hash(bundleCore).slice(0, 20)}`;
  const bundleDir = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources', version);
  const sourceRoot = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources');
  if (!bundleDir.toLowerCase().startsWith(`${sourceRoot.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('BOL bundle path escaped data root.'), { code: 'SOP09_ARTIFACT_PATH_INVALID' });
  const entries = [];
  for (const item of competitors) {
    const candidate = sop08Artifact.candidates?.find(row => row.competitor_id === item.competitor_id);
    if (!candidate || !['A_STRONG_EFFECTIVE', 'B_REFERENCE'].includes(candidate.classification)
      || item.pageFacts?.artifact_type !== 'BOL_PAGE_FACTS_VERSION' || item.pageFacts?.sku !== sku
      || item.pageFacts?.competitor_id !== item.competitor_id || item.pageFacts?.product_id_match !== true
      || item.pageFacts?.canonical_product_id !== candidate.bol_product_id
      || item.apiFacts?.artifact_type !== 'BOL_API_FACTS_VERSION' || item.apiFacts?.sku !== sku
      || item.apiFacts?.competitor_id !== item.competitor_id || item.apiFacts?.ean_gtin !== item.pageFacts?.ean_gtin) {
      throw Object.assign(new Error(`SOP09 BOL source identity mismatch for ${item.competitor_id}.`), { code: 'SOP09_BOL_BUNDLE_IDENTITY_MISMATCH', competitor_id: item.competitor_id });
    }
    for (const [version, filename, expectedType, source] of [
      [item.pageFacts.version, 'page-facts.json', 'BOL_PAGE_FACTS_VERSION', item.pageFacts],
      [item.apiFacts.version, 'api-facts.json', 'BOL_API_FACTS_VERSION', item.apiFacts],
    ]) {
      const sourcePath = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources', version, filename);
      const sourceRoot = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources');
      if (!sourcePath.toLowerCase().startsWith(`${sourceRoot.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('Linked SOP09 source path escapes the task data root.'), { code: 'SOP09_ARTIFACT_PATH_INVALID' });
      let persisted;
      try { persisted = JSON.parse(await fs.readFile(sourcePath, 'utf8')); }
      catch { throw Object.assign(new Error(`Linked ${expectedType} is not persisted: ${version}/${filename}.`), { code: 'SOP09_LINKED_SOURCE_NOT_PERSISTED', competitor_id: item.competitor_id, version }); }
      if (persisted.version !== version || persisted.artifact_type !== expectedType || persisted.sku !== sku
        || persisted.competitor_id !== item.competitor_id || canonicalJson(persisted) !== canonicalJson(source)) {
        throw Object.assign(new Error(`Persisted ${expectedType} does not match the supplied immutable source.`), { code: 'SOP09_LINKED_SOURCE_MISMATCH', competitor_id: item.competitor_id, version });
      }
    }
    entries.push({ competitor_id: item.competitor_id,
      PAGE_FACTS: { status: 'READY', artifact_type: item.pageFacts.artifact_type, version: item.pageFacts.version,
        artifact_ref: `../${item.pageFacts.version}/page-facts.json` },
      BOL_API_FACTS: { status: item.apiFacts.status, artifact_type: item.apiFacts.artifact_type, version: item.apiFacts.version,
        artifact_ref: `../${item.apiFacts.version}/api-facts.json` },
      SOP08_CONTEXT: { artifact_type: sop08Artifact.artifact_type, artifact_version: sop08Artifact.version,
        classification: candidate.classification,
        low_competitor_pool_confidence: sop08Artifact.low_competitor_pool_confidence === true || sop08Artifact.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE' },
    });
  }
  const bundle = {
    schema_version: 1, artifact_type: 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION', version, sku,
    PAGE_FACTS: { version: pageSet, status: 'READY', competitor_count: entries.length },
    BOL_API_FACTS: { version: apiSet, status: entries.every(item => item.BOL_API_FACTS.status === 'READY') ? 'READY' : 'PARTIAL', competitor_count: entries.length },
    SOP08_CONTEXT: { artifact_type: sop08Artifact.artifact_type, artifact_version: sop08Artifact.version,
      low_competitor_pool_confidence: sop08Artifact.low_competitor_pool_confidence === true || sop08Artifact.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE',
      main_comparison_pool: pool },
    competitors: entries,
    created_at: new Date().toISOString(),
  };
  await fs.mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, 'bundle.json');
  try {
    const existing = JSON.parse(await fs.readFile(bundlePath, 'utf8'));
    const withoutCreatedAt = value => { const copy = structuredClone(value); delete copy.created_at; return copy; };
    if (existing.version !== version || canonicalJson(withoutCreatedAt(existing)) !== canonicalJson(withoutCreatedAt(bundle))) throw Object.assign(new Error('BOL evidence bundle version collision.'), { code: 'SOP09_BOL_BUNDLE_VERSION_COLLISION' });
    return { bundle: existing, artifact_ref: path.relative(dataRoot, bundlePath).replace(/\\/g, '/'), idempotent_reuse: true };
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await writeJsonAtomic(bundlePath, bundle);
  return { bundle, artifact_ref: path.relative(dataRoot, bundlePath).replace(/\\/g, '/'), idempotent_reuse: false };
}

export function buildSop09BolApiEnrichmentPlan(bundle) {
  const ean = String(bundle?.PAGE_FACTS?.page_facts?.ean_gtin || '').trim();
  const identityReady = bundle?.PAGE_FACTS?.status === 'READY' && bundle.PAGE_FACTS.page_facts?.product_id_match === true && /^\d{8,14}$/.test(ean);
  if (!identityReady) return { status: 'BLOCKED_IDENTITY_GATE', requests: [] };
  return {
    status: 'READY_FOR_READINESS_PREFLIGHT',
    ean,
    requests: [
      { provider_method: 'getOffers', params: { ean, countryCode: 'NL' }, status: bundle.BOL_API_FACTS?.offers?.status || 'NOT_RUN' },
      { provider_method: 'getRatings', params: { ean }, status: bundle.BOL_API_FACTS?.ratings?.status || 'NOT_RUN' },
    ],
    business_requests_sent: 0,
  };
}

export function markSop09BolApiEnrichmentWaiting(bundle, { dependency = 'BOL_API', reason = 'WAITING_DEPENDENCY' } = {}) {
  if (!bundle?.PAGE_FACTS?.page_facts || bundle.PAGE_FACTS.status !== 'READY') throw Object.assign(new Error('PAGE_FACTS must remain ready before API enrichment can wait.'), { code: 'SOP09_PAGE_FACTS_NOT_READY' });
  if (!['BOL_API', 'BOL_API_RATE_LIMIT'].includes(dependency)) throw Object.assign(new Error('Unsupported BOL enrichment dependency.'), { code: 'SOP09_BOL_ENRICHMENT_DEPENDENCY_INVALID' });
  return {
    ...structuredClone(bundle),
    BOL_API_FACTS: {
      ...structuredClone(bundle.BOL_API_FACTS),
      status: 'WAITING_DEPENDENCY', dependency, waiting_reason: reason,
      offers: { ...structuredClone(bundle.BOL_API_FACTS?.offers || {}), status: 'WAITING_DEPENDENCY' },
      ratings: { ...structuredClone(bundle.BOL_API_FACTS?.ratings || {}), status: 'WAITING_DEPENDENCY' },
    },
  };
}
