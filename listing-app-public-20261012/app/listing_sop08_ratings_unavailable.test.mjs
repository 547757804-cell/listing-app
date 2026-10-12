import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySop08RatingsNotAvailable,
  classifyListingCompetitor,
  isSop08RatingsNotFoundForEan,
  resolveSop08SavedRatingsNotFound,
} from './listing_sop08_competitors.mjs';

const ean = '8714274170537';
const endpoint = `/retailer/products/${ean}/ratings`;
const diagnostic = {
  execution_id: 'execution-fixture',
  request_id: 'request-fixture',
  endpoint,
  method: 'GET',
  request_parameters: { ean, countryCode: 'NL' },
  started_at: '2026-10-09T09:06:53.000Z',
  finished_at: '2026-10-09T09:06:54.000Z',
  error_code: 'BOL_API_HTTP_ERROR',
  http_status: 404,
  response_received: true,
  response_body: JSON.stringify({ detail: `Product can't be found for EAN: ${ean}.` }),
};

test('only an exact-EAN Ratings HTTP 404 with a real response is field-level NOT_AVAILABLE', () => {
  assert.equal(isSop08RatingsNotFoundForEan(diagnostic, ean), true);
  assert.equal(isSop08RatingsNotFoundForEan(diagnostic, '8711111111111'), false);
  assert.equal(isSop08RatingsNotFoundForEan({ ...diagnostic, endpoint: `/retailer/products/${ean}/offers` }, ean), false);
  assert.equal(isSop08RatingsNotFoundForEan({ ...diagnostic, http_status: 400 }, ean), false);
  assert.equal(isSop08RatingsNotFoundForEan({ ...diagnostic, response_received: false }, ean), false);
  assert.equal(isSop08RatingsNotFoundForEan({ ...diagnostic, response_body: 'not found' }, ean), false);
});

test('saved task diagnostic is reusable only for the same exact EAN and Ratings endpoint', () => {
  const task = { http_client_error: {
    code: 'HTTP_CLIENT_BUSINESS_ERROR', provider: 'BOL_API', http_status: 404,
    endpoint, request_id: 'request-fixture', reason_code: 'HTTP_404', failed_at: diagnostic.finished_at,
    diagnostic,
  } };
  const reused = resolveSop08SavedRatingsNotFound(task, ean);
  assert.equal(reused.request_id, 'request-fixture');
  assert.equal(reused.http_status, 404);
  assert.equal(reused.endpoint, endpoint);
  assert.equal(resolveSop08SavedRatingsNotFound(task, '8711111111111'), null);
  assert.equal(resolveSop08SavedRatingsNotFound({ http_client_error: { ...task.http_client_error, endpoint: `/retailer/products/${ean}/offers` } }, ean), null);
});

test('candidate keeps missing Ratings distinct from NO_REVIEWS and retains error evidence', () => {
  const candidate = { ean, rating: 4.2, review_count: 3, rating_status: 'CONFIRMED', evidence_refs: ['evidence/product-list.json'],
    same_category: 'UNKNOWN', same_use_case: 'UNKNOWN', comparable_positioning: 'UNKNOWN',
    product_placement: { status: 'RESOLVED', evidence_ref: 'evidence/placement.json' },
    offers_evidence: { status: 'PASS', active_offer_count: 1, evidence_ref: 'evidence/offers.json' },
    sales_evidence: { status: 'NOT_AVAILABLE' }, heat_evidence: { status: 'NOT_AVAILABLE' },
    listing_stability: 'UNKNOWN' };
  assert.equal(applySop08RatingsNotAvailable(candidate, {
    failureRecord: diagnostic, evidenceRef: 'artifacts/listing/SYNTH/sop08/evidence/ratings-error.json',
  }), true);
  assert.equal(candidate.rating, null);
  assert.equal(candidate.review_count, null);
  assert.equal(candidate.rating_status, 'NOT_AVAILABLE');
  assert.equal(candidate.ratings_evidence.status, 'NOT_AVAILABLE');
  assert.equal(candidate.ratings_evidence.reason_code, 'RATINGS_PRODUCT_NOT_FOUND');
  assert.notEqual(candidate.ratings_evidence.status, 'NO_REVIEWS');
  assert.ok(candidate.evidence_refs.includes('artifacts/listing/SYNTH/sop08/evidence/ratings-error.json'));
  assert.equal(classifyListingCompetitor(candidate).competitor_conditions.real_reviews.status, 'UNKNOWN',
    'a Ratings 404 cannot be turned into zero reviews or a failed review condition');
});
