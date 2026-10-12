import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSop08CandidateSlots, shouldSupplementSop08, validateSop08Preflight } from '../app/listing_sop08_competitors.mjs';

const fields = [
  ['bol_direct_competitor', 'BOL直接竞品'],
  ['bol_similar_competitor_1', 'BOL同类竞品1'],
  ['bol_similar_competitor_2', 'BOL同类竞品2'],
  ['bol_similar_competitor_3', 'BOL同类竞品3'],
  ['bol_similar_competitor_4', 'BOL同类竞品4'],
];

function readyTask() {
  return {
    sku: 'SYNTH-SKU-01',
    outputs: {
      confirmed_product_facts: { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', sku: 'SYNTH-SKU-01', version: 2 },
      top20: { version: 'SOP07-SYNTH-1', records: [] },
    },
    listing_executor: { registry: {
      LISTING_SOP_03: { status: 'PASS', qa_status: 'PASS', output_version: 'SOP03-SYNTH-1' },
      LISTING_SOP_07: { status: 'PASS', qa_status: 'PASS', output_version: 'SOP07-SYNTH-1',
        input_version_refs: [{ artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: 2 }] },
    }, waiting_items: [] },
  };
}

function sourceArtifact(competitor_urls) {
  return { version: 'SOP03-SYNTH-1', bol_local_source: { competitor_urls } };
}

test('missing one or more initial competitor slots is auditable but does not create a human gate', () => {
  const rows = fields.filter(([field]) => field !== 'bol_similar_competitor_2').map(([source_field, source_header], index) => ({
    source_field, source_header, exact_url: `https://www.bol.com/nl/nl/p/example-${index}/930000000000000${index}/`,
  }));
  const result = validateSop08Preflight({ task: readyTask(), sop03Artifact: sourceArtifact(rows) });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.candidate_slot_statuses.find(slot => slot.source_field === 'bol_similar_competitor_2').status, 'NOT_PROVIDED');
});

test('zero initial candidates remains eligible for automatic supplement discovery', () => {
  const artifact = sourceArtifact([]);
  const result = validateSop08Preflight({ task: readyTask(), sop03Artifact: artifact });
  assert.equal(result.ready, true);
  assert.equal(result.candidate_slot_statuses.every(slot => slot.status === 'NOT_PROVIDED'), true);
  assert.equal(shouldSupplementSop08([]).should_supplement, true);
});

test('a malformed provided URL is reported as invalid input, not a confirmation gate', () => {
  const artifact = sourceArtifact([{ source_field: fields[0][0], source_header: fields[0][1], exact_url: 'https://example.com/not-a-bol-product' }]);
  const slots = inspectSop08CandidateSlots(artifact);
  assert.equal(slots[0].status, 'INVALID_URL');
  const result = validateSop08Preflight({ task: readyTask(), sop03Artifact: artifact });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test('real upstream version defects still block SOP08', () => {
  const task = readyTask();
  task.listing_executor.registry.LISTING_SOP_07.status = 'STALE';
  const result = validateSop08Preflight({ task, sop03Artifact: sourceArtifact([]) });
  assert.equal(result.ready, false);
  assert.equal(result.blockers.some(item => item.code === 'SOP08_SOP07_INPUT_STALE'), true);
});
