import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListingSop07Top20, qaListingSop07Top20 } from '../app/listing_sop07_top20.mjs';

const SKU = 'SYNTHETIC-SKU-LEGACY-05';
const versions = { facts: 2, sop03: 'SOP03-A', sop04: 'SOP04-A' };

function inputSet(count, { zeroLast = true } = {}) {
  const candidates = Array.from({ length: count }, (_, index) => ({
    candidate_id: `C-${index + 1}`,
    ordinal: index + 1,
    exact_string: ` exact term ${index + 1} `,
    status: 'ACTIVE',
    eligibility_status: 'ELIGIBLE_FOR_SOP06',
    selection_reason: 'Facts and SOP provenance permit formal query.',
    keyword_category: 'CORE_PRODUCT',
    sources: [{ category: 'BOL_LOCAL_MINING', facts_version: 2 }],
    source_refs: [],
    evidence_refs: [],
  }));
  const sop05 = {
    artifact_type: 'LISTING_SOP_05_KEYWORD_CANDIDATE_POOL',
    sop_step_id: 'LISTING_SOP_05', status: 'PASS', qa_status: 'PASS', sku: SKU,
    version: 'SOP05-A', selected_for_sop06_count: count, candidates,
    input_versions: { confirmed_product_facts_version: 2, sop03_artifact_version: 'SOP03-A', sop04_artifact_version: 'SOP04-A' },
  };
  const results = candidates.map((candidate, index) => ({
    exact_string: candidate.exact_string,
    volume: zeroLast && index === count - 1 ? 0 : (count - index) * 10,
    status: 'PASS', qa_status: 'PASS', provider_method: 'BOLOO_OFFICIAL_WEB',
    provider_request_id: `REQ-${index + 1}`, result_version: `SOP06-R-${index + 1}`,
    queried_at: '2026-10-09T00:00:00.000Z', evidence_refs_result: [{ persisted: true, matches_request: true, reference: `evidence-${index + 1}.json` }],
  }));
  const sop06 = {
    artifact_type: 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES',
    sop_step_id: 'LISTING_SOP_06', status: 'PASS', qa_status: 'PASS', sku: SKU,
    version: 'SOP06-A', sop05_version: 'SOP05-A', confirmed_product_facts_version: 2,
    sop03_artifact_version: 'SOP03-A', sop04_artifact_version: 'SOP04-A', results,
  };
  return { sop05, sop06 };
}

function build(count, options) {
  const { sop05, sop06 } = inputSet(count, options);
  const result = buildListingSop07Top20({
    sku: SKU, sop05, sop06,
    confirmedProductFactsVersion: versions.facts,
    sop03ArtifactVersion: versions.sop03,
    sop04ArtifactVersion: versions.sop04,
    createdAt: '2026-10-09T00:00:00.000Z',
  });
  return { ...result, sop05, sop06 };
}

test('uses all 12 legal candidates, records target shortfall, and passes reproducibility QA', () => {
  const { artifact, passed, sop05, sop06 } = build(12);
  assert.equal(passed, true);
  assert.equal(artifact.target_count, 20);
  assert.equal(artifact.item_count, 12);
  assert.equal(artifact.evaluated_candidate_count, 12);
  assert.equal(artifact.selection.status, 'BELOW_TARGET_ALL_ELIGIBLE_CANDIDATES_USED');
  assert.equal(artifact.selection.reason, 'ONLY_ELIGIBLE_CANDIDATES_AVAILABLE; NO_TERMS_INVENTED');
  assert.equal(artifact.records.length, 12);
  assert.equal(artifact.records.at(-1).demand_status, 'ZERO_VALID');
  assert.equal(qaListingSop07Top20({ artifact, sop05, sop06, expectedVersions: versions }).status, 'PASS');
});

test('exactly 20 candidates reaches the target without changing exact strings', () => {
  const { artifact, passed } = build(20);
  assert.equal(passed, true);
  assert.equal(artifact.item_count, 20);
  assert.equal(artifact.selection.status, 'TARGET_REACHED');
  assert.equal(artifact.not_selected_candidates.length, 0);
  assert.equal(artifact.records[0].exact_string, ' exact term 1 ');
});

test('more than 20 candidates are ranked by official volume and excess candidates are disclosed', () => {
  const { artifact, passed, sop05, sop06 } = build(23);
  assert.equal(passed, true);
  assert.equal(artifact.item_count, 20);
  assert.equal(artifact.evaluated_candidate_count, 23);
  assert.equal(artifact.not_selected_candidates.length, 3);
  assert.equal(artifact.records[0].exact_string, ' exact term 1 ');
  assert.equal(artifact.not_selected_candidates[0].reason, 'RANKED_BELOW_TOP20_BY_OFFICIAL_MONTHLY_VOLUME');
  assert.equal(qaListingSop07Top20({ artifact, sop05, sop06, expectedVersions: versions }).status, 'PASS');
});

test('fails closed when a SOP06 result is missing or candidate count metadata is inconsistent', () => {
  const input = inputSet(12);
  input.sop06.results.pop();
  const missing = buildListingSop07Top20({ sku: SKU, ...input, confirmedProductFactsVersion: 2, sop03ArtifactVersion: 'SOP03-A', sop04ArtifactVersion: 'SOP04-A' });
  assert.equal(missing.passed, false);
  assert.ok(missing.checks.some(check => check.code === 'SOP06_RESULT_COUNT_INVALID' && !check.pass));

  const inconsistent = inputSet(12);
  inconsistent.sop05.selected_for_sop06_count = 20;
  const invalidCount = buildListingSop07Top20({ sku: SKU, ...inconsistent, confirmedProductFactsVersion: 2, sop03ArtifactVersion: 'SOP03-A', sop04ArtifactVersion: 'SOP04-A' });
  assert.equal(invalidCount.passed, false);
  assert.ok(invalidCount.checks.some(check => check.code === 'SOP05_ELIGIBLE_COUNT_INVALID' && !check.pass));
});

test('does not emit forbidden scoring fields', () => {
  const { artifact } = build(12);
  const serialized = JSON.stringify(artifact);
  for (const forbidden of ['volume_score', 'relevance_score', 'final_score', 'final_keyword_score', 'log_normalization']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
