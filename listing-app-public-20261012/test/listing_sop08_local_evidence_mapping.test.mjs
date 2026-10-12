import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyListingCompetitor, mapSop08LocalCompetitorEvidence } from '../app/listing_sop08_competitors.mjs';

function confirmedFacts(name, category) {
  return {
    version: 1,
    fields: {
      name: { status: 'CONFIRMED', value: name, source_references: [{ source_reference: 'facts.json#/fields/name' }] },
      'product_facts.category': { status: 'CONFIRMED', value: category, source_references: [{ source_reference: 'facts.json#/fields/category' }] },
    },
  };
}

function candidate(url, title = null) {
  return {
    competitor_id: 'SYNTH-COMP-1',
    bol_url: url,
    title,
    source_ref: { exact_url: url, sop03_artifact_ref: 'artifacts/sop03.json' },
    evidence_refs: ['artifacts/sop03.json', 'artifacts/source-evidence.json'],
    competitor_conditions: {},
    ratings_evidence: { status: 'NOT_AVAILABLE' },
    offers_evidence: { status: 'NOT_AVAILABLE' },
    sales_evidence: { status: 'NOT_AVAILABLE' },
    heat_evidence: { status: 'NOT_AVAILABLE' },
    latest_review_or_activity: { status: 'NOT_AVAILABLE' },
    listing_stability: 'UNKNOWN',
  };
}

test('confirmed DIY beaded Christmas tree facts map to directly comparable local kit evidence', () => {
  const facts = confirmedFacts('DIY串珠圣诞树套装', '人造圣诞树');
  const source = candidate('https://www.bol.com/nl/nl/p/diy-kralen-kerstboom-knutselpakket-3d-kristal-kralen/9300000000000001/');
  const mapped = mapSop08LocalCompetitorEvidence(source, facts);
  const classified = classifyListingCompetitor(mapped);

  assert.equal(mapped.competitor_conditions.same_category.status, 'PASS');
  assert.equal(mapped.competitor_conditions.same_use_case.status, 'PASS');
  assert.equal(mapped.competitor_conditions.comparable_positioning.status, 'PASS');
  assert.match(mapped.competitor_conditions.same_category.reason, /DIY串珠圣诞树套装/);
  assert.doesNotMatch(mapped.competitor_conditions.same_category.reason, /礼品袋|纸袋/);
  assert.match(mapped.competitor_conditions.same_use_case.reason, /手工制作与节日装饰用途/);
  assert.doesNotMatch(mapped.competitor_conditions.same_use_case.reason, /礼品包装用途/);
  assert.equal(classified.classification, 'B_REFERENCE');
  assert.match(classified.classification_reason, /销量\/评论/);
});

test('finished artificial trees and tree accessories are not mapped as DIY kit comparables', () => {
  const facts = confirmedFacts('DIY串珠圣诞树套装', '人造圣诞树');
  const finishedTree = classifyListingCompetitor(mapSop08LocalCompetitorEvidence(
    candidate('https://www.bol.com/nl/nl/p/kunstkerstboom-180-cm-met-metalen-standaard/9300000000000002/'), facts,
  ));
  assert.equal(finishedTree.classification, 'C_WEAK_INVALID');
  assert.equal(finishedTree.competitor_conditions.comparable_positioning.status, 'FAIL');

  const accessory = classifyListingCompetitor(mapSop08LocalCompetitorEvidence(
    candidate('https://www.bol.com/nl/nl/p/kerstboomstandaard-metalen-voet/9300000000000003/'), facts,
  ));
  assert.equal(accessory.classification, 'C_WEAK_INVALID');
  assert.equal(accessory.competitor_conditions.same_category.status, 'FAIL');
});

test('the existing gift bag mapper remains fact-bound and market fields stay unknown', () => {
  const facts = confirmedFacts('圣诞礼品袋套装', '纸质礼品袋');
  const source = candidate('https://www.bol.com/nl/nl/p/kerst-cadeauzakjes-papier/9300000000000004/');
  const mapped = mapSop08LocalCompetitorEvidence(source, facts);
  const classified = classifyListingCompetitor(mapped);

  assert.equal(mapped.competitor_conditions.same_category.status, 'PASS');
  assert.equal(mapped.competitor_conditions.same_use_case.status, 'PASS');
  assert.equal(mapped.competitor_conditions.price_band_fit?.status, undefined);
  assert.equal(classified.competitor_conditions.sales_or_heat.status, 'UNKNOWN');
});
