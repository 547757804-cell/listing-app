import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildSop09BolPageFacts,
  persistSop09BolPageFacts,
  buildSop09BolApiFacts,
  persistSop09BolApiFacts,
  persistSop09BolEvidenceBundle,
  qaSop09BolDataSourceIntegration,
} from '../app/sop09_bol_data_source.mjs';

const sku = 'SYNTH-BOL-SKU';
const competitorId = 'BOL-SYNTH-1';
const productId = '9300000000000001';
const url = `https://www.bol.com/nl/nl/p/synthetic-product/${productId}/`;
const sop08Artifact = {
  artifact_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION',
  version: 'SOP08-SYNTH-V1',
  sku,
  status: 'PASS',
  main_comparison_pool: [competitorId],
  low_competitor_pool_confidence: false,
  candidates: [{ competitor_id: competitorId, bol_product_id: productId, bol_url: url, classification: 'B_REFERENCE' }],
};

function field(value, status = 'AVAILABLE_REAL', evidence_ref = `dom://www.bol.com/nl/nl/p/synthetic-product/${productId}/#field`) {
  return { status, value, evidence_ref };
}

function pageProbeResult({ identityMatch = 'true', reviewsStatus = 'AVAILABLE_REAL', reviewCount = 1, items = [{ body: field('Synthetic review') }] } = {}) {
  return {
    requested_product_id: field(productId),
    canonical_product_id: field(productId),
    product_id_match: field(identityMatch),
    canonical_url: field(url),
    ean_gtin: field(null, 'UNKNOWN'),
    title: field('Synthetic product title'),
    current_price: field(null, 'UNKNOWN'),
    main_image: field(null, 'UNKNOWN'),
    image_list: field([], 'UNKNOWN'),
    description: field(null, 'UNKNOWN'),
    specifications: field(null, 'UNKNOWN'),
    package_or_set_content: field(null, 'UNKNOWN'),
    rating: field(null, 'UNKNOWN'),
    review_count: field(reviewCount, reviewCount === null ? 'UNKNOWN' : 'AVAILABLE_REAL'),
    reviews: {
      status: reviewsStatus === 'NO_REVIEWS' ? 'NOT_PRESENT' : 'AVAILABLE_REAL',
      reviews_status: reviewsStatus,
      review_count: field(reviewCount, reviewCount === null ? 'UNKNOWN' : 'AVAILABLE_REAL'),
      items,
      pagination_status: field(null, 'UNKNOWN'),
    },
    seller: field(null, 'UNKNOWN'),
    seller_rating: field(null, 'UNKNOWN'),
    delivery_text: field(null, 'UNKNOWN'),
    fulfilment: field(null, 'UNKNOWN'),
    current_offer: field(null, 'UNKNOWN'),
    checked_at: '2026-10-11T00:00:00.000Z',
    dom_evidence_refs: [{ field: 'title', selector: 'h1', ref: `dom://www.bol.com/nl/nl/p/synthetic-product/${productId}/#selector=h1` }],
  };
}

function build(result) {
  return buildSop09BolPageFacts({
    sku,
    competitor: { competitor_id: competitorId },
    sop08Artifact,
    pageProbeResult: result,
    expectedSop08Version: sop08Artifact.version,
  });
}

test('BOL identity gate accepts the contract boolean string only after independent ID and URL checks', () => {
  const built = build(pageProbeResult({ identityMatch: 'true' }));
  assert.equal(built.pageFacts.product_id_match, true);
  assert.equal(built.pageFacts.requested_product_id, productId);
  assert.equal(built.pageFacts.canonical_product_id, productId);

  assert.throws(() => build(pageProbeResult({ identityMatch: 'TRUE' })), { code: 'SOP09_PAGE_FACTS_IDENTITY_MISMATCH' });
  assert.throws(() => build(pageProbeResult({ identityMatch: 'false' })), { code: 'SOP09_PAGE_FACTS_IDENTITY_MISMATCH' });
});

test('BOL AVAILABLE_REAL review status is normalized without losing the raw status', () => {
  const built = build(pageProbeResult({ reviewsStatus: 'AVAILABLE_REAL', reviewCount: 1 }));
  assert.equal(built.pageFacts.reviews_status, 'AVAILABLE');
  assert.equal(built.pageFacts.reviews.reviews_status, 'AVAILABLE');
  assert.equal(built.pageFacts.fields.reviews.raw_reviews_status.value, 'AVAILABLE_REAL');
  assert.equal(built.pageFacts.fields.reviews.items.length, 1);

  const qa = qaSop09BolDataSourceIntegration({
    pageFacts: built.pageFacts,
    bundle: built.bundle,
    rawEvidencePathExists: true,
    sop08BytesBefore: Buffer.from('immutable SOP08'),
    sop08BytesAfter: Buffer.from('immutable SOP08'),
  });
  assert.equal(qa.status, 'PASS', JSON.stringify(qa.checks.filter(row => !row.pass)));
});

test('BOL NO_REVIEWS is preserved as a valid terminal state', () => {
  const built = build(pageProbeResult({ reviewsStatus: 'NO_REVIEWS', reviewCount: 0, items: [] }));
  assert.equal(built.pageFacts.reviews_status, 'NO_REVIEWS');
  assert.deepEqual(built.pageFacts.reviews.items, []);
  assert.equal(built.pageFacts.fields.rating.status, 'NOT_PRESENT');
  assert.equal(built.pageFacts.fields.review_count.status, 'NOT_PRESENT');
});

test('BOL AVAILABLE_REAL without any evidence of reviews is not promoted to AVAILABLE', () => {
  const built = build(pageProbeResult({ reviewsStatus: 'AVAILABLE_REAL', reviewCount: 0, items: [] }));
  assert.equal(built.pageFacts.reviews_status, 'UNKNOWN');
  assert.equal(built.pageFacts.fields.reviews.raw_reviews_status.value, 'AVAILABLE_REAL');
});

test('BOL API facts preserve independent Offers/Ratings semantics and never infer review text count', async t => {
  const scratch = path.resolve(process.cwd(), '_offline_tmp');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'sop09-bol-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const probe = pageProbeResult();
  probe.ean_gtin = field('2222222222222', 'AVAILABLE_REAL', `dom://${url}#ean`);
  const persistedPage = await persistSop09BolPageFacts({ dataRoot: root, sku, competitor: { competitor_id: competitorId }, sop08Artifact,
    pageProbeResult: probe, expectedSop08Version: sop08Artifact.version });
  const pageFacts = persistedPage.pageFacts;
  const offersResult = { createdAt: '2026-10-11T10:00:00.000Z', source: 'bol_offers:HTTP 200', cacheHit: false,
    rawResponse: { offers: [{ offerId: 'O1', countryCode: 'NL', price: 17.99 }] },
    structuredResult: { offers: [{ offerId: 'O1', countryCode: 'NL', price: 17.99 }] } };
  const ratingsResult = { createdAt: '2026-10-11T10:00:01.000Z', source: 'bol_ratings:HTTP 200', cacheHit: false,
    rawResponse: { ratings: [{ rating: 5, count: 2 }, { rating: 1, count: 1 }] },
    structuredResult: { ratings: [{ rating: 5, count: 2 }, { rating: 1, count: 1 }] } };
  const facts = buildSop09BolApiFacts({ sku, competitor: { competitor_id: competitorId }, pageFacts,
    offersResult, ratingsResult, checkedAt: '2026-10-11T10:00:02.000Z' });
  assert.equal(facts.status, 'READY');
  assert.equal(facts.offers.status, 'AVAILABLE_REAL');
  assert.equal(facts.offers.current_offers[0].price, 17.99);
  assert.equal(facts.ratings.rating_count, 3);
  assert.equal(facts.ratings.review_count, 'NOT_INFERRED_FROM_RATING_COUNT');
  assert.equal(facts.ratings.review_content, 'NOT_PROVIDED_BY_RATINGS_ENDPOINT');
  assert.equal(facts.ratings.request_id, 'NOT_REPORTED_BY_ADAPTER');

  const persisted = await persistSop09BolApiFacts({ dataRoot: root, sku, competitor: { competitor_id: competitorId }, pageFacts,
    offersResult, ratingsResult, checkedAt: '2026-10-11T10:00:02.000Z' });
  const saved = JSON.parse(await fs.readFile(path.join(root, persisted.artifact_ref), 'utf8'));
  assert.equal(saved.version, persisted.apiFacts.version);
  assert.equal((await fs.stat(path.join(path.dirname(path.join(root, persisted.artifact_ref)), 'evidence', 'offers-response.json'))).isFile(), true);
  const bundle = await persistSop09BolEvidenceBundle({ dataRoot: root, sku, sop08Artifact: { ...sop08Artifact,
    main_comparison_pool: [competitorId], candidates: [{ competitor_id: competitorId, bol_product_id: productId, classification: 'B_REFERENCE' }] },
    competitors: [{ competitor_id: competitorId, pageFacts, apiFacts: saved }] });
  assert.equal(bundle.bundle.competitors[0].BOL_API_FACTS.version, saved.version);
  assert.equal(bundle.bundle.SOP08_CONTEXT.artifact_version, sop08Artifact.version);
});

test('unqueried BOL API methods remain NOT_RUN and identity mismatches fail closed', () => {
  const pageFacts = build(pageProbeResult()).pageFacts;
  pageFacts.ean_gtin = '2222222222222';
  const facts = buildSop09BolApiFacts({ sku, competitor: { competitor_id: competitorId }, pageFacts,
    checkedAt: '2026-10-11T10:00:02.000Z' });
  assert.equal(facts.offers.status, 'NOT_RUN');
  assert.equal(facts.ratings.status, 'NOT_RUN');
  assert.equal(facts.status, 'PARTIAL');
  assert.equal(facts.offers.checked_at, null);
  assert.equal(facts.offers.temporal_relation_to_page_facts, 'NOT_APPLICABLE');
  assert.equal(facts.offers.usable_as_current, false);
  assert.equal(facts.ratings.temporal_relation_to_page_facts, 'NOT_APPLICABLE');
  assert.equal(facts.ratings.usable_as_current, false);
  assert.throws(() => buildSop09BolApiFacts({ sku: 'OTHER-SKU', competitor: { competitor_id: competitorId }, pageFacts }),
    { code: 'SOP09_API_IDENTITY_GATE_FAILED' });
});

test('historical API evidence remains real but cannot be represented as current', () => {
  const pageFacts = build(pageProbeResult()).pageFacts;
  pageFacts.ean_gtin = '2222222222222';
  pageFacts.checked_at = '2026-10-11T10:00:00.000Z';
  const historical = { createdAt: '2026-10-09T10:00:00.000Z', source: 'bol_offers:HTTP 200', cacheHit: false,
    rawResponse: { offers: [{ offerId: 'HIST-1', countryCode: 'NL', price: 15.99 }] },
    structuredResult: { offers: [{ offerId: 'HIST-1', countryCode: 'NL', price: 15.99 }] } };
  const facts = buildSop09BolApiFacts({ sku, competitor: { competitor_id: competitorId }, pageFacts,
    offersResult: historical, checkedAt: '2026-10-11T10:05:00.000Z' });
  assert.equal(facts.offers.status, 'AVAILABLE_REAL');
  assert.equal(facts.offers.temporal_relation_to_page_facts, 'BEFORE_PAGE_CAPTURE');
  assert.equal(facts.offers.usable_as_current, false);
  assert.equal(facts.status, 'PARTIAL');
  assert.equal(facts.ratings.status, 'NOT_RUN');
});
