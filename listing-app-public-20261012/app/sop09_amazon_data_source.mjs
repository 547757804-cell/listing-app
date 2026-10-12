import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9._-]{1,140}$/;
const FIELD_STATUSES = new Set(['AVAILABLE_REAL', 'AVAILABLE_PARTIAL', 'NOT_PRESENT', 'UNKNOWN', 'BLOCKED']);
const AMAZON_PAGE_FACTS_MAPPING_CONTRACT = 'SOP09_AMAZON_PAGE_FACTS_V2';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : stable(value)).digest('hex');
}

function valueOf(field) {
  return field && typeof field === 'object' && Object.hasOwn(field, 'value') ? field.value : field;
}

function preserveField(field) {
  if (field && typeof field === 'object' && Object.hasOwn(field, 'value')) {
    return {
      status: FIELD_STATUSES.has(field.status) ? field.status : 'UNKNOWN',
      value: field.value ?? null,
      evidence_ref: field.evidence_ref ?? null,
      ...(field.note ? { note: field.note } : {}),
    };
  }
  return { status: 'UNKNOWN', value: field ?? null, evidence_ref: null };
}

function asinFromUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !/(^|\.)amazon\.de$/i.test(url.hostname)) return null;
    return url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase() || null;
  } catch { return null; }
}

function canonicalAmazonUrl(raw) {
  const asin = asinFromUrl(raw);
  if (!asin) return null;
  try {
    const url = new URL(raw);
    return `https://www.amazon.de${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

function cleanNetworkEvidence(input) {
  const entries = Array.isArray(valueOf(input)) ? valueOf(input) : [];
  return entries.map(row => ({
    host: typeof row?.host === 'string' ? row.host : null,
    path: typeof row?.path === 'string' ? row.path.split('?')[0] : null,
    method: typeof row?.method === 'string' ? row.method : null,
    status: Number.isFinite(Number(row?.status)) ? Number(row.status) : null,
    content_type: typeof row?.content_type === 'string' ? row.content_type : null,
    query_parameter_names: Array.isArray(row?.query_parameter_names) ? row.query_parameter_names.filter(name => typeof name === 'string') : [],
    body_saved: row?.body_saved === true,
    cookie_saved: row?.cookie_saved === true,
    authorization_saved: row?.authorization_saved === true,
  }));
}

function reviewItems(inlineReviews) {
  const source = valueOf(inlineReviews);
  const rows = Array.isArray(source?.items) ? source.items : [];
  return rows.map((row, index) => ({
    sample_index: index + 1,
    title: preserveField(row?.title),
    body: preserveField(row?.body),
    date: preserveField(row?.date),
    rating: preserveField(row?.rating),
  }));
}

function validateProbe({ probe, expectedAsin, expectedMarketplace }) {
  if (!probe || probe.schema !== 'AMAZON_PAGE_PROBE_PERSISTED_RESULT' || probe.result_status !== 'PASS') {
    throw Object.assign(new Error('正式 Amazon Page Probe JSON 未标记 PASS。'), { code: 'SOP09_AMAZON_PROBE_NOT_PASS' });
  }
  const identity = probe.identity || {};
  const marketplace = String(valueOf(identity.marketplace) || '');
  const requestedAsin = String(valueOf(identity.requested_asin) || '').toUpperCase();
  const canonicalAsin = String(valueOf(identity.canonical_asin) || '').toUpperCase();
  const asinMatch = valueOf(identity.asin_match) === true;
  const canonicalUrl = String(valueOf(identity.canonical_url) || '');
  if (marketplace !== expectedMarketplace || marketplace !== 'Amazon.de' || requestedAsin !== expectedAsin || canonicalAsin !== expectedAsin || !asinMatch || asinFromUrl(canonicalUrl) !== expectedAsin) {
    throw Object.assign(new Error('Amazon ASIN / marketplace identity gate failed.'), { code: 'SOP09_AMAZON_IDENTITY_MISMATCH' });
  }
  if (probe.safety?.amazon_login_performed === true || probe.safety?.cookie_values_saved === true || probe.safety?.authorization_saved === true || probe.safety?.request_response_bodies_saved === true) {
    throw Object.assign(new Error('Probe safety metadata does not meet no-login/no-secret persistence requirements.'), { code: 'SOP09_AMAZON_PROBE_SAFETY_GATE_FAILED' });
  }
  return { marketplace, requestedAsin, canonicalAsin, canonicalUrl };
}

export function buildSop09AmazonPageFacts({ probe, sop03Artifact, sop03ArtifactVersion, sourceCaptureSha256 = null, expectedAsin = null, expectedMarketplace = null }) {
  if (!sop03Artifact || !sop03Artifact.artifact_type || sop03Artifact.amazon_local_source?.status !== 'PASS') {
    throw Object.assign(new Error('对应 SKU 的正式 SOP03 Amazon 本地来源不可用。'), { code: 'SOP09_AMAZON_SOP03_CONTEXT_INVALID' });
  }
  const amazonSource = sop03Artifact.amazon_local_source;
  const sourceAsin = asinFromUrl(amazonSource.source_url);
  let sourceMarketplace = null;
  try { sourceMarketplace = new URL(amazonSource.source_url).hostname.toLowerCase().endsWith('amazon.de') ? 'Amazon.de' : null; } catch { }
  const lockedAsin = expectedAsin || sourceAsin;
  const lockedMarketplace = expectedMarketplace || sourceMarketplace;
  if (!sourceAsin || !lockedAsin || sourceAsin !== lockedAsin || !lockedMarketplace) {
    throw Object.assign(new Error('SOP03 Amazon URL 与页面采集 ASIN 不一致。'), { code: 'SOP09_AMAZON_SOP03_ASIN_MISMATCH' });
  }
  const identity = validateProbe({ probe, expectedAsin: lockedAsin, expectedMarketplace: lockedMarketplace });
  const packageValue = preserveField(probe.package_contents);
  const packageConsistency = valueOf(probe.package_contents)?.consistency || 'UNKNOWN';
  const ratingsCount = preserveField(probe.ratings_summary?.rating_count);
  const inline = preserveField(probe.inline_reviews);
  const pagination = preserveField(probe.review_pagination);
  const inlineValue = valueOf(probe.inline_reviews) || {};
  const sourceReviewScope = inlineValue.review_scope || 'UNKNOWN';
  const observedReviewNodes = Number.isInteger(inlineValue.observed_dom_review_nodes)
    ? inlineValue.observed_dom_review_nodes : null;
  const noReviewsClaimContradicted = sourceReviewScope === 'NO_REVIEWS' && observedReviewNodes > 0;
  const reviewScope = noReviewsClaimContradicted ? 'UNKNOWN' : sourceReviewScope;

  const facts = {
    schema_version: 1,
    artifact_type: 'AMAZON_PAGE_FACTS_VERSION',
    mapping_contract_version: AMAZON_PAGE_FACTS_MAPPING_CONTRACT,
    sku: sop03Artifact.sku,
    identity: {
      marketplace: preserveField(probe.identity.marketplace),
      requested_asin: preserveField(probe.identity.requested_asin),
      canonical_asin: preserveField(probe.identity.canonical_asin),
      asin_match: preserveField(probe.identity.asin_match),
      canonical_url: preserveField(probe.identity.canonical_url),
    },
    product_content: {
      title: preserveField(probe.product_content?.title),
      bullet_points: preserveField(probe.product_content?.bullet_points),
      description: preserveField(probe.product_content?.description),
    },
    images: {
      main_image: preserveField(probe.images?.main_image),
      image_list: preserveField(probe.images?.image_list),
    },
    specifications: preserveField(probe.specifications?.technical_details),
    package_contents: {
      ...packageValue,
      consistency: valueOf(probe.package_contents)?.consistency || 'UNKNOWN',
      bullet_quantity_expression: valueOf(probe.package_contents)?.bullet_quantity_expression ?? null,
      spec_quantity_expressions: valueOf(probe.package_contents)?.spec_quantity_expressions ?? [],
      conflict_status: ['SOURCE_CONFLICT_WITHIN_PAGE', 'SOURCE_CONFLICT'].includes(packageConsistency) ? packageConsistency : 'NONE_REPORTED',
      auto_resolved: false,
    },
    ratings_summary: {
      rating: preserveField(probe.ratings_summary?.rating),
      rating_count: ratingsCount,
      count_semantics: String(probe.ratings_summary?.count_semantics || 'rating_count; not confirmed text review_count'),
      review_count: { status: 'NOT_CONFIRMED', value: null, note: 'rating_count is not confirmed text review_count.' },
    },
    inline_reviews: {
      status: noReviewsClaimContradicted ? 'UNKNOWN' : inline.status,
      review_scope: reviewScope,
      source_status: inline.status,
      source_review_scope: sourceReviewScope,
      observed_dom_review_nodes: observedReviewNodes,
      saved_item_count: inlineValue.saved_item_count ?? reviewItems(probe.inline_reviews).length,
      items: reviewItems(probe.inline_reviews),
      complete_review_set_claimed: inlineValue.complete_review_set_claimed === true,
      evidence_ref: inline.evidence_ref,
      scope_warning: noReviewsClaimContradicted
        ? 'The source claims NO_REVIEWS but reports review DOM nodes; no review text was extracted, so review scope remains UNKNOWN.'
        : null,
    },
    review_pagination: {
      status: pagination.status,
      value: structuredClone(valueOf(probe.review_pagination)),
      evidence_ref: pagination.evidence_ref,
      login_performed: false,
      complete_review_set_claimed: valueOf(probe.inline_reviews)?.complete_review_set_claimed === true,
    },
    seller_offer: {
      seller: preserveField(probe.seller_offer?.seller),
      current_buy_box: preserveField(probe.seller_offer?.current_buy_box),
    },
    delivery_context: {
      destination_country: preserveField(probe.delivery_context?.destination_country),
      displayed_currency: preserveField(probe.delivery_context?.displayed_currency),
      displayed_price: preserveField(probe.delivery_context?.displayed_price),
      delivery: preserveField(probe.delivery_context?.delivery),
      usable_for_amazon_de_local_price_comparison: valueOf(probe.delivery_context?.displayed_price)?.usable_for_amazon_de_local_price_comparison === true,
    },
    network_evidence: {
      status: preserveField(probe.network_evidence).status,
      entries: cleanNetworkEvidence(probe.network_evidence),
      body_values_saved: false,
      cookie_values_saved: false,
      authorization_values_saved: false,
      csrf_values_saved: false,
      source_evidence_ref: probe.network_evidence?.evidence_ref ?? null,
    },
    checked_at: preserveField(probe.checked_at),
    source_capture: {
      source_schema: probe.schema,
      result_status: probe.result_status,
      sop03_amazon_context_version: sop03ArtifactVersion,
    },
  };
  const captureSha = sourceCaptureSha256 || sha256(probe);
  const sop03Sha = sha256(sop03Artifact);
  const factsVersion = `AMAZON_PAGE_FACTS-${sha256({ mappingContract: AMAZON_PAGE_FACTS_MAPPING_CONTRACT, asin: identity.canonicalAsin, captureSha, sop03Sha }).slice(0, 20)}`;
  facts.version = factsVersion;
  facts.source_capture_sha256 = captureSha;
  facts.sop03_context_ref = { artifact_type: sop03Artifact.artifact_type, version: sop03ArtifactVersion, sha256: sop03Sha };

  const bundleVersion = `AMAZON_EVIDENCE_BUNDLE-${sha256({ factsVersion, sop03Sha }).slice(0, 20)}`;
  const bundle = {
    schema_version: 1,
    artifact_type: 'AMAZON_EVIDENCE_BUNDLE_VERSION',
    version: bundleVersion,
    sku: sop03Artifact.sku,
    AMAZON_PAGE_FACTS: { status: 'READY', artifact_type: facts.artifact_type, version: facts.version, page_facts: facts },
    SOP03_AMAZON_CONTEXT: {
      status: 'LOCAL_SOURCE_AVAILABLE',
      source_url: amazonSource.source_url,
      source_language: amazonSource.source_language,
      expressions: structuredClone(amazonSource.expressions || []),
      candidate_only: amazonSource.candidate_only === true,
      evidence_cells: structuredClone(amazonSource.evidence_cells || []),
      sop03_artifact_version: sop03ArtifactVersion,
      sop03_artifact_sha256: sop03Sha,
      never_own_product_fact: amazonSource.never_own_product_fact === true,
    },
    SOP09_CONTEXT: {
      usage: ['EXPRESSION_REFERENCE', 'SCENARIO_REFERENCE', 'USER_BENEFIT_REFERENCE', 'REVIEW_REFERENCE'],
      may_determine_own_product_facts: false,
      review_sample_scope: reviewScope,
      review_pagination_status: valueOf(probe.review_pagination)?.status,
      package_conflict_status: ['SOURCE_CONFLICT_WITHIN_PAGE', 'SOURCE_CONFLICT'].includes(packageConsistency) ? packageConsistency : 'NONE_REPORTED',
      price_context: {
        destination: valueOf(probe.delivery_context?.destination_country) ?? null,
        currency: valueOf(probe.delivery_context?.displayed_currency) ?? null,
        usable_for_amazon_de_local_price_comparison: valueOf(probe.delivery_context?.displayed_price)?.usable_for_amazon_de_local_price_comparison === true,
      },
    },
    created_at: new Date().toISOString(),
  };
  return { facts, bundle, captureSha, sop03Sha };
}

function qaCheck(code, pass, message) { return { code, pass: Boolean(pass), message }; }

export function qaSop09AmazonPageFacts({ facts, bundle, sourceReadable, sourceHashMatches, sop03HashMatches, taskHashMatches }) {
  const network = facts?.network_evidence?.entries || [];
  const reviewRows = facts?.inline_reviews?.items || [];
  const checks = [
    qaCheck('ASIN_IDENTITY_GATE', Boolean(facts?.identity?.marketplace?.value) && /^[A-Z0-9]{10}$/.test(String(facts?.identity?.requested_asin?.value || '')) && facts?.identity?.canonical_asin?.value === facts?.identity?.requested_asin?.value && facts?.identity?.asin_match?.value === true && asinFromUrl(facts?.identity?.canonical_url?.value) === facts?.identity?.requested_asin?.value, 'Current SKU marketplace, ASIN, and canonical URL agree.'),
    qaCheck('PERSISTED_SOURCE_READABLE', sourceReadable === true && sourceHashMatches === true && facts?.source_capture_sha256, 'Formal persisted Probe source is readable and matches its recorded hash.'),
    qaCheck('RATING_COUNT_DISTINCT_FROM_REVIEW_COUNT', facts?.ratings_summary?.review_count?.status === 'NOT_CONFIRMED', 'rating_count is never promoted to confirmed text review_count.'),
    qaCheck('INLINE_REVIEW_SCOPE_RETAINED', facts?.inline_reviews?.review_scope === 'NO_REVIEWS'
      ? (reviewRows.length === 0 && facts.inline_reviews.status === 'NOT_PRESENT' && facts.inline_reviews.observed_dom_review_nodes === 0)
      : facts?.inline_reviews?.review_scope === 'INLINE_SAMPLE'
        ? (reviewRows.length === facts.inline_reviews.saved_item_count && facts.inline_reviews.status === 'AVAILABLE_PARTIAL' && facts.inline_reviews.complete_review_set_claimed === false)
        : facts?.inline_reviews?.review_scope === 'UNKNOWN'
          ? (reviewRows.length === facts?.inline_reviews?.saved_item_count && facts.inline_reviews.complete_review_set_claimed === false)
          : reviewRows.length === facts?.inline_reviews?.saved_item_count,
    'Current review scope and observed item count are preserved.'),
    qaCheck('CONTRADICTORY_NO_REVIEWS_NOT_PROMOTED', facts?.inline_reviews?.source_review_scope !== 'NO_REVIEWS'
      || !(Number(facts?.inline_reviews?.observed_dom_review_nodes) > 0)
      || (facts.inline_reviews.review_scope === 'UNKNOWN' && facts.inline_reviews.status === 'UNKNOWN' && Boolean(facts.inline_reviews.scope_warning)),
    'A NO_REVIEWS claim with observed review DOM nodes remains UNKNOWN until content is actually captured.'),
    qaCheck('REVIEW_PAGINATION_SEMANTICS', facts?.review_pagination?.login_performed === false
      && (facts?.inline_reviews?.review_scope !== 'INLINE_SAMPLE' || facts.review_pagination.complete_review_set_claimed === false), 'Pagination state is preserved without login or an unsupported full-set claim.'),
    qaCheck('PACKAGE_CONFLICT_NOT_AUTO_RESOLVED', !['SOURCE_CONFLICT_WITHIN_PAGE', 'SOURCE_CONFLICT'].includes(facts?.package_contents?.conflict_status) || facts.package_contents.auto_resolved === false, 'Any source-declared package conflict remains unresolved.'),
    qaCheck('PRICE_CONTEXT_PRESERVED', facts?.delivery_context?.usable_for_amazon_de_local_price_comparison !== true
      || (Boolean(facts?.delivery_context?.destination_country?.value) && Boolean(facts?.delivery_context?.displayed_currency?.value)), 'Price comparability is only enabled when explicitly supported by the source and context is present.'),
    qaCheck('NETWORK_METADATA_SANITIZED', facts?.network_evidence?.body_values_saved === false && facts.network_evidence.cookie_values_saved === false && facts.network_evidence.authorization_values_saved === false && facts.network_evidence.csrf_values_saved === false && network.every(row => row.body_saved === false && row.cookie_saved === false && row.authorization_saved === false), 'No cookie/auth/CSRF values or request/response bodies are persisted.'),
    qaCheck('SOP03_SOURCE_SEPARATE', bundle?.SOP03_AMAZON_CONTEXT?.status === 'LOCAL_SOURCE_AVAILABLE'
      && bundle.SOP03_AMAZON_CONTEXT.sop03_artifact_sha256 === facts?.sop03_context_ref?.sha256
      && typeof bundle.SOP03_AMAZON_CONTEXT.candidate_only === 'boolean'
      && sop03HashMatches === true, 'SOP03 local Amazon source remains a separate immutable layer with its original eligibility state.'),
    qaCheck('CURRENT_SKU_TASK_UNCHANGED', taskHashMatches === true, 'Current SKU task record is unchanged.'),
    qaCheck('LAYERED_BUNDLE', bundle?.AMAZON_PAGE_FACTS?.version === facts?.version && bundle?.SOP09_CONTEXT?.may_determine_own_product_facts === false, 'Amazon page facts and SOP09 use context remain separate.'),
  ];
  return { status: checks.every(row => row.pass) ? 'PASS' : 'FAIL', checked_at: new Date().toISOString(), checks };
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, filePath);
}

export async function persistSop09AmazonPageFacts({ dataRoot, sku, probePath, sop03ArtifactPath, sop03ArtifactVersion }) {
  const [probeBytes, sop03Bytes, taskBytes] = await Promise.all([
    fs.readFile(probePath),
    fs.readFile(sop03ArtifactPath),
    fs.readFile(path.join(dataRoot, 'products', `${sku}.json`)),
  ]);
  const probe = JSON.parse(probeBytes.toString('utf8'));
  const sop03Artifact = JSON.parse(sop03Bytes.toString('utf8'));
  if (sop03Artifact.sku !== sku) throw Object.assign(new Error('SOP03 artifact SKU mismatch.'), { code: 'SOP09_AMAZON_SOP03_SKU_MISMATCH' });
  const built = buildSop09AmazonPageFacts({ probe, sop03Artifact, sop03ArtifactVersion, sourceCaptureSha256: sha256(probeBytes) });
  const base = path.resolve(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources');
  const target = path.join(base, built.facts.version);
  if (!target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) throw Object.assign(new Error('Amazon artifact path escaped data root.'), { code: 'SOP09_AMAZON_ARTIFACT_PATH_INVALID' });
  await fs.mkdir(base, { recursive: true });
  const pageFactsPath = path.join(target, 'amazon-page-facts.json');
  const bundlePath = path.join(target, 'amazon-evidence-bundle.json');
  const qaPath = path.join(target, 'qa.json');
  try {
    const oldBundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'));
    if (oldBundle.version !== built.bundle.version || oldBundle.AMAZON_PAGE_FACTS.page_facts.source_capture_sha256 !== built.captureSha) throw Object.assign(new Error('Amazon evidence version path collision.'), { code: 'SOP09_AMAZON_VERSION_COLLISION' });
    return { facts: oldBundle.AMAZON_PAGE_FACTS.page_facts, bundle: oldBundle, qa: JSON.parse(await fs.readFile(qaPath, 'utf8')), artifact_dir: target, idempotent_reuse: true };
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const stage = await fs.mkdtemp(path.join(base, '.amazon-sop09-stage-'));
  try {
    const safeEvidence = {
      schema: probe.schema,
      schema_version: probe.schema_version,
      result_status: probe.result_status,
      checked_at: probe.checked_at,
      identity: probe.identity,
      network_evidence: built.facts.network_evidence,
      safety: { amazon_login_performed: false, cookie_values_saved: false, authorization_saved: false, request_response_bodies_saved: false },
      source_capture_sha256: built.captureSha,
    };
    const facts = { ...built.facts, source_probe_ref: path.basename(probePath) };
    const bundle = { ...built.bundle, AMAZON_PAGE_FACTS: { ...built.bundle.AMAZON_PAGE_FACTS, artifact_ref: 'amazon-page-facts.json', page_facts: facts } };
    await atomicJson(path.join(stage, 'amazon-page-facts.json'), facts);
    await atomicJson(path.join(stage, 'amazon-evidence-bundle.json'), bundle);
    await atomicJson(path.join(stage, 'evidence', 'probe-metadata-sanitized.json'), safeEvidence);
    const [probeAfter, sop03After, taskAfter] = await Promise.all([fs.readFile(probePath), fs.readFile(sop03ArtifactPath), fs.readFile(path.join(dataRoot, 'products', `${sku}.json`))]);
    const qa = qaSop09AmazonPageFacts({ facts, bundle, sourceReadable: true, sourceHashMatches: sha256(probeAfter) === built.captureSha, sop03HashMatches: sha256(sop03After) === sha256(sop03Bytes), taskHashMatches: sha256(taskAfter) === sha256(taskBytes) });
    await atomicJson(path.join(stage, 'qa.json'), qa);
    await fs.rename(stage, target);
    return { facts, bundle, qa, artifact_dir: target, idempotent_reuse: false };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
