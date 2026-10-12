import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListingCompetitorAnalysis, qaListingCompetitorAnalysis, isFormalBolEvidenceBundleForPool, hydrateSop09BolEvidenceBundle } from '../app/listing_competitor_analysis_executor.mjs';

function fact(value, status = 'AVAILABLE_REAL', evidence_ref = 'fixture://source') {
  return { status, value, evidence_ref };
}

function fixture({ sku = 'SYNTH-SKU-C', count = 5, lowConfidence = false, reviewScope = 'INLINE_SAMPLE', packageConflict = false } = {}) {
  const sop08Version = 'SOP08-SYNTHETIC-V1';
  const candidates = Array.from({ length: count }, (_, index) => ({
    competitor_id: `BOL-SYNTH-${index + 1}`,
    bol_product_id: `930000000000000${index + 1}`,
    classification: index === 0 ? 'A_STRONG_EFFECTIVE' : 'B_REFERENCE',
  }));
  const pageRefs = candidates.map((candidate, index) => {
    const version = `BOL_PAGE_FACTS-SYNTH-${index + 1}`;
    const noReviews = index === 1;
    return {
      competitor_id: candidate.competitor_id,
      PAGE_FACTS: {
        status: 'READY', version, artifact_ref: `page-${index + 1}.json`,
        page_facts: {
          schema_version: 1, artifact_type: 'BOL_PAGE_FACTS_VERSION', version, sku,
          competitor_id: candidate.competitor_id, requested_product_id: candidate.bol_product_id,
          canonical_product_id: candidate.bol_product_id, product_id_match: true,
          ean_gtin: fact(null, 'NOT_PRESENT'), canonical_url: fact(`https://www.bol.com/nl/p/${candidate.bol_product_id}/`),
          fields: {
            title: fact(`Synthetic competitor ${index + 1}`),
            current_price: fact(12 + index),
            current_offer: fact(null, 'NOT_PRESENT'),
            main_image: fact(null, 'NOT_PRESENT'), image_list: fact([], 'AVAILABLE_PARTIAL'),
            description: fact(null, 'NOT_PRESENT'), specifications: fact({}, 'AVAILABLE_PARTIAL'),
            package_or_set_content: fact(null, 'UNKNOWN'), seller: fact(null, 'NOT_PRESENT'),
            seller_rating: fact(null, 'NOT_PRESENT'), fulfilment: fact(null, 'UNKNOWN'),
            delivery_text: fact(null, 'NOT_PRESENT'), rating: fact(null, 'NOT_PRESENT'), review_count: fact(null, 'NOT_PRESENT'),
          },
          reviews_status: noReviews ? 'NO_REVIEWS' : 'AVAILABLE',
          reviews: { items: [], pagination_status: noReviews ? 'NOT_APPLICABLE' : 'PAGINATION_UNVERIFIED' },
          dom_evidence_refs: [], checked_at: '2026-10-11T00:00:00.000Z',
        },
      },
      BOL_API_FACTS: {
        artifact_type: 'BOL_API_FACTS_VERSION', version: `BOL_API_FACTS-SYNTH-${index + 1}`,
        artifact_ref: `api-${index + 1}.json`, competitor_id: candidate.competitor_id,
        ean_gtin: null, offers: { status: 'NOT_RUN', temporal_relation_to_page_facts: 'NOT_APPLICABLE', usable_as_current: false, current_offers: [], availability_status: 'UNKNOWN' },
        ratings: { status: 'NOT_RUN', temporal_relation_to_page_facts: 'NOT_APPLICABLE', usable_as_current: false, rating_count: null, overall_rating: 'UNKNOWN', review_content: 'NOT_PROVIDED_BY_RATINGS_ENDPOINT' },
      },
      SOP08_CONTEXT: { artifact_version: sop08Version, classification: candidate.classification, low_competitor_pool_confidence: lowConfidence },
    };
  });
  const sop08Artifact = {
    artifact_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION', version: sop08Version, sku, status: 'PASS',
    main_comparison_pool: candidates.map(item => item.competitor_id), candidates,
    confidence_status: lowConfidence ? 'LOW_COMPETITOR_POOL_CONFIDENCE' : 'NORMAL',
    low_competitor_pool_confidence: lowConfidence,
    confidence_reason: lowConfidence ? 'Synthetic low-confidence fixture.' : null,
  };
  const bolEvidenceBundle = {
    artifact_type: 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION', version: 'BOL_COMPETITOR_BUNDLE-SYNTH-V1', sku,
    PAGE_FACTS: { status: 'READY', version: 'BOL_PAGE_FACTS_SET-SYNTH-V1', artifact_type: 'BOL_PAGE_FACTS_VERSION' },
    BOL_API_FACTS: { status: 'READY', version: 'BOL_API_FACTS_SET-SYNTH-V1', artifact_type: 'BOL_API_FACTS_VERSION' },
    SOP08_CONTEXT: { artifact_version: sop08Version, low_competitor_pool_confidence: lowConfidence },
    competitors: pageRefs,
  };
  const reviews = reviewScope === 'INLINE_SAMPLE'
    ? [{ title: fact('Useful craft kit'), body: fact('Easy to assemble'), date: fact('2026-09-20'), rating: fact(5) }]
    : [];
  const asin = 'B0SYNTHETIC1';
  const amazonFacts = {
    artifact_type: 'AMAZON_PAGE_FACTS_VERSION', version: 'AMAZON_PAGE_FACTS-SYNTH-V1', sku,
    identity: { marketplace: fact('Amazon.de'), requested_asin: fact(asin), canonical_asin: fact(asin), asin_match: fact(true), canonical_url: fact(`https://www.amazon.de/dp/${asin}`) },
    product_content: { title: fact('Synthetic Amazon title'), bullet_points: fact([]), description: fact(null, 'NOT_PRESENT') },
    images: { main_image: fact(null, 'NOT_PRESENT'), image_list: fact([], 'AVAILABLE_PARTIAL') },
    specifications: fact({}, 'AVAILABLE_PARTIAL'),
    package_contents: { conflict_status: packageConflict ? 'SOURCE_CONFLICT_WITHIN_PAGE' : 'NONE_REPORTED', auto_resolved: false, evidence_ref: 'amazon://package' },
    ratings_summary: { rating: fact(4.2), rating_count: fact(47), review_count: { status: 'NOT_CONFIRMED', value: null } },
    inline_reviews: { status: reviewScope === 'NO_REVIEWS' ? 'NO_REVIEWS' : 'AVAILABLE_PARTIAL', review_scope: reviewScope, items: reviews, saved_item_count: reviews.length, complete_review_set_claimed: false },
    review_pagination: { status: reviewScope === 'INLINE_SAMPLE' ? 'PAGINATION_UNVERIFIED' : 'NOT_PRESENT', value: { status: reviewScope === 'INLINE_SAMPLE' ? 'PAGINATION_UNVERIFIED' : 'NOT_PRESENT' }, login_performed: false, complete_review_set_claimed: false },
    seller_offer: {},
    delivery_context: { destination_country: fact('DE'), displayed_currency: fact('EUR'), displayed_price: fact(9.99), delivery: fact('Standard'), usable_for_amazon_de_local_price_comparison: false },
    checked_at: '2026-10-11T00:00:00.000Z', network_evidence: { status: 'AVAILABLE_PARTIAL', entries: [], body_values_saved: false, cookie_values_saved: false, authorization_values_saved: false, csrf_values_saved: false },
    source_capture_sha256: 'fixture-capture-hash', source_probe_ref: 'fixture://amazon-probe',
    sop03_context_ref: { artifact_type: 'SOP03_SOURCE_DISCOVERY_VERSION', version: 'SOP03-SYNTH-V1', sha256: 'fixture-sop03-hash' },
  };
  const amazonEvidenceBundle = {
    artifact_type: 'AMAZON_EVIDENCE_BUNDLE_VERSION', version: 'AMAZON_BUNDLE-SYNTH-V1', sku,
    AMAZON_PAGE_FACTS: { status: 'READY', version: amazonFacts.version, page_facts: amazonFacts },
    SOP03_AMAZON_CONTEXT: { status: 'LOCAL_SOURCE_AVAILABLE', source_url: `https://www.amazon.de/dp/${asin}`, candidate_only: false },
    SOP09_CONTEXT: { may_determine_own_product_facts: false, review_sample_scope: reviewScope },
  };
  const productFacts = { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: 1, sku, fields: {} };
  return { sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle, productFacts };
}

test('SOP09 accepts the current SKU five-member normal-confidence pool without SYNTHETIC_ACCEPTANCE_10-only assumptions', () => {
  const inputs = fixture({ count: 5, lowConfidence: false, reviewScope: 'INLINE_SAMPLE' });
  const artifact = buildListingCompetitorAnalysis(inputs);
  const qa = qaListingCompetitorAnalysis({ artifact, inputs });
  assert.equal(artifact.bol_competitor_analysis.length, 5);
  assert.equal(artifact.sop08_context.low_competitor_pool_confidence, false);
  assert.equal(artifact.amazon_reference_analysis.inline_reviews.sample_count, 1);
  assert.equal(artifact.amazon_reference_analysis.ratings_summary.rating_count.value, 47);
  assert.notEqual(artifact.amazon_reference_analysis.ratings_summary.review_count.value, 47);
  assert.equal(qa.status, 'PASS', JSON.stringify(qa.checks.filter(check => !check.pass)));
});

test('SOP09 keeps a current SKU low-confidence B_REFERENCE boundary when the context requires it', () => {
  const inputs = fixture({ count: 1, lowConfidence: true, reviewScope: 'NO_REVIEWS', packageConflict: true });
  inputs.sop08Artifact.candidates[0].classification = 'B_REFERENCE';
  inputs.bolEvidenceBundle.competitors[0].SOP08_CONTEXT.classification = 'B_REFERENCE';
  inputs.bolEvidenceBundle.competitors[0].PAGE_FACTS.page_facts.reviews_status = 'NO_REVIEWS';
  inputs.bolEvidenceBundle.competitors[0].PAGE_FACTS.page_facts.reviews = { items: [], pagination_status: 'NOT_APPLICABLE' };
  const artifact = buildListingCompetitorAnalysis(inputs);
  const qa = qaListingCompetitorAnalysis({ artifact, inputs });
  assert.equal(artifact.sop08_context.low_competitor_pool_confidence, true);
  assert.equal(artifact.sop08_context.influence_boundary, 'LIMITED_BY_CURRENT_LOW_POOL_CONFIDENCE');
  assert.equal(artifact.bol_competitor_analysis[0].reviews.reviews_status, 'NO_REVIEWS');
  assert.equal(artifact.amazon_reference_analysis.package_contents.auto_resolved, false);
  assert.equal(qa.status, 'PASS', JSON.stringify(qa.checks.filter(check => !check.pass)));
});

test('SOP09 refuses an evidence row that crosses the current SKU boundary', () => {
  const inputs = fixture({ count: 1 });
  inputs.bolEvidenceBundle.competitors[0].PAGE_FACTS.page_facts.sku = 'OTHER-SKU';
  assert.throws(() => buildListingCompetitorAnalysis(inputs), { code: 'SOP09_BOL_SKU_MISMATCH' });
});

test('SOP09 persisted-input resolver can distinguish the whole-pool BOL bundle from per-competitor siblings', () => {
  const inputs = fixture({ count: 5 });
  assert.equal(isFormalBolEvidenceBundleForPool(inputs.bolEvidenceBundle, inputs.sop08Artifact), true);
  const perCompetitor = {
    ...inputs.bolEvidenceBundle,
    competitors: undefined,
    competitor_id: inputs.sop08Artifact.main_comparison_pool[0],
  };
  assert.equal(isFormalBolEvidenceBundleForPool(perCompetitor, inputs.sop08Artifact), false);
});

test('SOP09 hydrates immutable resolved page/API facts without mutating the persisted reference-only bundle', () => {
  const inputs = fixture({ count: 5 });
  const referenceOnly = structuredClone(inputs.bolEvidenceBundle);
  const resolvedEntries = referenceOnly.competitors.map(entry => ({ page: entry.PAGE_FACTS.page_facts, api: entry.BOL_API_FACTS }));
  for (const entry of referenceOnly.competitors) {
    delete entry.PAGE_FACTS.page_facts;
    delete entry.BOL_API_FACTS.api_facts;
  }
  const hydrated = hydrateSop09BolEvidenceBundle(referenceOnly, resolvedEntries);
  assert.equal(referenceOnly.competitors[0].PAGE_FACTS.page_facts, undefined);
  assert.equal(hydrated.competitors[0].PAGE_FACTS.page_facts.sku, inputs.sop08Artifact.sku);
  const analysis = buildListingCompetitorAnalysis({ ...inputs, bolEvidenceBundle: hydrated });
  assert.equal(analysis.bol_competitor_analysis.length, 5);
});

test('SOP09 Stage QA must use hydrated API facts for NOT_RUN and historical temporal semantics', () => {
  const inputs = fixture({ count: 5 });
  const persisted = structuredClone(inputs.bolEvidenceBundle);
  const resolved = persisted.competitors.map((entry, index) => ({
    page: entry.PAGE_FACTS.page_facts,
    api: index === 4 ? {
      ...entry.BOL_API_FACTS,
      offers: { status: 'AVAILABLE_REAL', temporal_relation_to_page_facts: 'BEFORE_PAGE_CAPTURE', usable_as_current: false, current_offers: [] },
      ratings: { status: 'AVAILABLE_REAL', temporal_relation_to_page_facts: 'BEFORE_PAGE_CAPTURE', usable_as_current: false, rating_count: 3 },
    } : structuredClone(entry.BOL_API_FACTS),
  }));
  for (const entry of persisted.competitors) {
    delete entry.PAGE_FACTS.page_facts;
    delete entry.BOL_API_FACTS.offers;
    delete entry.BOL_API_FACTS.ratings;
  }
  const hydrated = hydrateSop09BolEvidenceBundle(persisted, resolved);
  const artifact = buildListingCompetitorAnalysis({ ...inputs, bolEvidenceBundle: hydrated, sourceBolEvidenceBundle: persisted });
  const rawQa = qaListingCompetitorAnalysis({ artifact, inputs: { ...inputs, bolEvidenceBundle: persisted } });
  const hydratedQa = qaListingCompetitorAnalysis({ artifact, inputs: { ...inputs, bolEvidenceBundle: hydrated } });
  assert.ok(rawQa.checks.some(check => check.code === 'BOL_API_TEMPORAL_CONTEXT_PRESERVED' && !check.pass));
  assert.equal(hydratedQa.status, 'PASS', JSON.stringify(hydratedQa.checks.filter(check => !check.pass)));
  assert.equal(artifact.bol_competitor_analysis[0].api_offer.status, 'NOT_RUN');
  assert.equal(artifact.bol_competitor_analysis[0].api_offer.usable_as_current, false);
  assert.equal(artifact.bol_competitor_analysis[4].api_offer.temporal_relation_to_page_facts, 'BEFORE_PAGE_CAPTURE');
  assert.equal(artifact.bol_competitor_analysis[4].api_offer.usable_as_current, false);
});
