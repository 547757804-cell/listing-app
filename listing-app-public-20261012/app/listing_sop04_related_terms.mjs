import { selectSop04SeedFromFacts } from './listing_sop04_seed_selector.mjs';

export const SOP04_MULTI_SEED_POLICY = 'SOP04_MULTI_SEED_RELATED_TERM_COMPLETION_V1';

const SUPPLEMENTAL_FACT_SEED_BRIDGES = Object.freeze([
  { concept: 'beaded_construction', fact_cues: ['串珠', '珠子', '珠串'], exact_candidates: ['kralen'] },
]);

function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export function collectSop04SourceCandidates(sourceRows = []) {
  const byExact = new Map();
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    if (row?.status !== 'PASS' || !Array.isArray(row.exact_strings)) continue;
    for (const raw of row.exact_strings) {
      const exact = typeof raw === 'string' ? raw : text(raw?.exact_string ?? raw?.keyword);
      if (!exact || /[\u3400-\u9fff]/u.test(exact)) continue;
      const refs = byExact.get(exact) || [];
      refs.push({
        source_id: row.source_id,
        result_version: row.result_version,
        provider_request_id: row.provider_request_id || null,
        evidence_refs: structuredClone(row.evidence_refs || []),
      });
      byExact.set(exact, refs);
    }
  }
  return [...byExact].map(([exact_string, source_refs]) => ({ exact_string, source_refs }));
}

function confirmedFactText(facts) {
  const fields = facts?.fields || {};
  return ['name', 'product_name', 'category', 'product_facts.category', 'product_facts.procurement_name']
    .map(key => fields[key])
    .filter(field => field?.status === 'CONFIRMED')
    .map(field => text(field.value).toLocaleLowerCase())
    .filter(Boolean)
    .join('\n');
}

/**
 * Selects only existing SOP03 exact strings that match confirmed product facts.
 * Core product nouns precede fact-supported construction/material seeds. No
 * keyword is translated, normalized, ranked, or created here.
 */
export function buildSop04SupplementalSeedPlan({ facts, sourceRows = [], primarySeed, preferredExactStrings = [] } = {}) {
  const sourceCandidates = collectSop04SourceCandidates(sourceRows);
  const sourceByExact = new Map(sourceCandidates.map(item => [item.exact_string, item]));
  const primary = String(primarySeed || '');
  const primaryDecision = selectSop04SeedFromFacts({ facts, sourceRows });
  const primaryMatch = primaryDecision.candidates?.find(item => item.exact_string === primary);
  const primaryConcepts = new Set((primaryMatch?.core_matches || []).map(item => item.concept));

  const core = (primaryDecision.candidates || [])
    .filter(item => item.exact_string !== primary && item.eligibility === 'CORE_PRODUCT_NOUN'
      && (item.core_matches || []).some(match => !primaryConcepts.has(match.concept)))
    .map(item => ({
      exact_string: item.exact_string, seed_role: 'CORE_PRODUCT_NOUN',
      concept: (item.core_matches || []).find(match => !primaryConcepts.has(match.concept))?.concept || null,
      seed_selection_reason: item.classification_reason,
      source_refs: structuredClone(sourceByExact.get(item.exact_string)?.source_refs || item.source_refs || []),
    }));

  const factText = confirmedFactText(facts);
  const supplemental = [];
  for (const bridge of SUPPLEMENTAL_FACT_SEED_BRIDGES) {
    if (!bridge.fact_cues.some(cue => factText.includes(cue.toLocaleLowerCase()))) continue;
    for (const exact of bridge.exact_candidates) {
      const source = sourceByExact.get(exact);
      if (!source || exact === primary || core.some(item => item.exact_string === exact)) continue;
      supplemental.push({
        exact_string: exact, seed_role: 'FACT_SUPPORTED_SUPPLEMENTAL_EXPRESSION',
        concept: bridge.concept,
        seed_selection_reason: `confirmed product facts contain a beading cue and SOP03 already emitted exact string ${exact}.`,
        source_refs: structuredClone(source.source_refs),
      });
    }
  }

  const preferred = new Map((Array.isArray(preferredExactStrings) ? preferredExactStrings : [])
    .filter(value => typeof value === 'string').map((value, index) => [value, index]));
  const sourceOrder = new Map(sourceCandidates.map((item, index) => [item.exact_string, index]));
  const stableSort = (a, b) => {
    const ap = preferred.has(a.exact_string) ? preferred.get(a.exact_string) : Number.MAX_SAFE_INTEGER;
    const bp = preferred.has(b.exact_string) ? preferred.get(b.exact_string) : Number.MAX_SAFE_INTEGER;
    return ap - bp || (sourceOrder.get(a.exact_string) ?? 0) - (sourceOrder.get(b.exact_string) ?? 0);
  };
  core.sort(stableSort);
  supplemental.sort(stableSort);

  const unique = new Set([primary]);
  const plan = [];
  for (const seed of [...core, ...supplemental]) {
    if (unique.has(seed.exact_string)) continue;
    unique.add(seed.exact_string);
    plan.push(seed);
    if (plan.length >= 2) break;
  }
  const invalidPreferred = [...preferred.keys()].filter(exact => !plan.some(seed => seed.exact_string === exact));
  return {
    policy: SOP04_MULTI_SEED_POLICY,
    primary_seed_exact_string: primary,
    seed_plan: plan,
    invalid_preferred_exact_strings: invalidPreferred,
    source_candidates: sourceCandidates,
  };
}

function matchesAnchor(exact, anchor) {
  const candidate = exact.toLocaleLowerCase();
  const value = anchor.toLocaleLowerCase();
  if (candidate.includes(value)) return true;
  for (const suffix of ['set', 'pakket', 'kit']) {
    if (!value.endsWith(suffix) || value.length <= suffix.length) continue;
    const head = value.slice(0, -suffix.length);
    for (const variant of [`${head} ${suffix}`, `${head}-${suffix}`]) {
      if (candidate === variant || candidate.startsWith(`${variant} `) || candidate.startsWith(`${variant}-`)
        || candidate.includes(` ${variant} `) || candidate.endsWith(` ${variant}`)) return true;
    }
  }
  return false;
}

/** Classifies raw Search Terms in provider order using only fact-linked anchors. */
export function classifySop04RelatedTerms({ rawTerms = [], seed, anchors = [], alreadyAdopted = [], explicitlyRejected = [] } = {}) {
  const seen = new Set();
  const adopted = new Set(Array.isArray(alreadyAdopted) ? alreadyAdopted : []);
  const rejected = new Set(Array.isArray(explicitlyRejected) ? explicitlyRejected : []);
  const exactAnchors = [...new Set([seed, ...(Array.isArray(anchors) ? anchors : [])]
    .filter(value => typeof value === 'string' && value))];
  const classifications = [];
  for (let index = 0; index < (Array.isArray(rawTerms) ? rawTerms : []).length; index += 1) {
    const row = rawTerms[index];
    const exact = typeof row?.searchTerm === 'string' ? row.searchTerm : '';
    if (!exact || seen.has(exact)) continue;
    seen.add(exact);
    if (adopted.has(exact)) {
      classifications.push({ raw_position: index + 1, exact_string: exact, status: 'DUPLICATE_ALREADY_ADOPTED', reason_code: 'EXACT_STRING_ALREADY_ADOPTED', matched_anchor: exact });
      continue;
    }
    if (rejected.has(exact)) {
      classifications.push({ raw_position: index + 1, exact_string: exact, status: 'REJECT_AS_IRRELEVANT', reason_code: 'EXPLICIT_FACT_MISMATCH', matched_anchor: null });
      continue;
    }
    const matched = exactAnchors.find(anchor => matchesAnchor(exact, anchor));
    if (matched) {
      classifications.push({ raw_position: index + 1, exact_string: exact, status: 'RELEVANT_FACT_SUPPORTED', reason_code: 'MATCHES_FACT_LINKED_SOP03_EXACT_ANCHOR', matched_anchor: matched });
    } else {
      classifications.push({ raw_position: index + 1, exact_string: exact, status: 'UNQUALIFIED_NO_FACT_LINK', reason_code: 'NO_MATCH_TO_FACT_LINKED_SOP03_EXACT_ANCHOR', matched_anchor: null });
    }
  }
  return { classifications, unique_exact_strings: [...seen] };
}
