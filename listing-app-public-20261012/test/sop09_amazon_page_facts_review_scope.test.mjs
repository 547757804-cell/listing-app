import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSop09AmazonPageFacts, qaSop09AmazonPageFacts } from '../app/sop09_amazon_data_source.mjs';

const sku = 'SYNTH-AMAZON-SKU';
const asin = 'B0TST00001';
const sop03 = {
  artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION',
  sku,
  amazon_local_source: {
    status: 'PASS',
    source_url: `https://www.amazon.de/dp/${asin}`,
    source_language: 'de-DE',
    expressions: [],
    candidate_only: true,
    evidence_cells: [],
    never_own_product_fact: true,
  },
};

test('a NO_REVIEWS claim is not trusted when the probe observed review DOM nodes', () => {
  const probe = {
    schema: 'AMAZON_PAGE_PROBE_PERSISTED_RESULT',
    result_status: 'PASS',
    safety: { amazon_login_performed: false, cookie_values_saved: false, authorization_saved: false, request_response_bodies_saved: false },
    identity: {
      marketplace: { status: 'AVAILABLE_REAL', value: 'Amazon.de', evidence_ref: 'dom:url' },
      requested_asin: { status: 'AVAILABLE_REAL', value: asin, evidence_ref: 'dom:expected_asin' },
      canonical_asin: { status: 'AVAILABLE_REAL', value: asin, evidence_ref: 'dom:canonical' },
      asin_match: { status: 'AVAILABLE_REAL', value: true, evidence_ref: 'dom:identity' },
      canonical_url: { status: 'AVAILABLE_REAL', value: `https://www.amazon.de/dp/${asin}`, evidence_ref: 'dom:canonical' },
    },
    ratings_summary: {
      rating: { status: 'AVAILABLE_REAL', value: '1.5 out of 5 stars', evidence_ref: 'dom:rating' },
      rating_count: { status: 'AVAILABLE_REAL', value: '(36)', evidence_ref: 'dom:rating-count' },
    },
    inline_reviews: {
      status: 'NOT_PRESENT',
      value: { review_scope: 'NO_REVIEWS', items: [], observed_dom_review_nodes: 8, saved_item_count: 0, complete_review_set_claimed: false },
      evidence_ref: 'dom:[data-hook=review]',
    },
    review_pagination: {
      status: 'AVAILABLE_REAL',
      value: { status: 'UNKNOWN', login_performed: false, complete_review_set_claimed: false },
      evidence_ref: 'dom:#customer-reviews_feature_div',
    },
  };

  const built = buildSop09AmazonPageFacts({
    probe,
    sop03Artifact: sop03,
    sop03ArtifactVersion: 'SOP03-SYNTH-V1',
    sourceCaptureSha256: 'a'.repeat(64),
  });
  assert.equal(built.facts.inline_reviews.review_scope, 'UNKNOWN');
  assert.equal(built.facts.inline_reviews.source_review_scope, 'NO_REVIEWS');
  assert.equal(built.facts.inline_reviews.observed_dom_review_nodes, 8);
  assert.equal(built.facts.inline_reviews.items.length, 0);
  assert.match(built.facts.inline_reviews.scope_warning, /review DOM nodes/);
  assert.equal(built.facts.ratings_summary.rating_count.value, '(36)');
  assert.equal(built.facts.ratings_summary.review_count.status, 'NOT_CONFIRMED');

  const qa = qaSop09AmazonPageFacts({
    facts: built.facts,
    bundle: built.bundle,
    sourceReadable: true,
    sourceHashMatches: true,
    sop03HashMatches: true,
    taskHashMatches: true,
  });
  assert.equal(qa.status, 'PASS', JSON.stringify(qa.checks.filter(row => !row.pass)));
});
