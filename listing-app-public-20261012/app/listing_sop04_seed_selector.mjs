/**
 * Conservative SOP04 seed selector.
 *
 * It only selects an exact string already emitted by a PASS SOP03 extractor.
 * The selector never translates or creates a query. It matches confirmed own
 * product nouns to that closed candidate set and prefers an explicitly
 * confirmed product form (for example, a set/kit) over the bare noun.
 */

export const SOP04_SEED_SELECTION_POLICY = 'SOP04_CORE_PRODUCT_NOUN_V1';

// A small, explicit concept bridge for confirmed Chinese product facts to
// Dutch candidate strings. This is a matching aid only; it cannot emit text.
const FACT_TO_DUTCH_CORE_NOUN = Object.freeze([
  { concept: 'christmas_tree', fact_cues: ['圣诞树'], dutch_nouns: ['kerstboom'] },
  // A confirmed DIY/craft product may have a second, narrower product noun.
  // This only matches exact Dutch candidates already present in SOP03.
  { concept: 'craft_kit', fact_cues: ['DIY', '手工制作', '手工', '串珠'], dutch_nouns: ['knutselset'] },
  { concept: 'gift_bag', fact_cues: ['礼品袋', '礼物袋', '礼品包装袋'], dutch_nouns: ['cadeauzak', 'cadeauzakje', 'cadeautas', 'cadeautasje', 'geschenkzak'] },
  { concept: 'lamp', fact_cues: ['灯具', '灯', '台灯'], dutch_nouns: ['lamp', 'tafellamp', 'bureaulamp'] },
  { concept: 'storage_box', fact_cues: ['收纳盒', '储物盒'], dutch_nouns: ['opbergdoos', 'opbergbox', 'bewaarbox'] },
  { concept: 'flower_pot', fact_cues: ['花盆'], dutch_nouns: ['bloempot', 'plantenpot'] },
  { concept: 'vase', fact_cues: ['花瓶'], dutch_nouns: ['vaas'] },
]);

const CONFIRMED_PRODUCT_FORM_CUES = Object.freeze(['套装', '套件', '组合', 'kit', 'set']);
const DUTCH_PRODUCT_FORM_SUFFIXES = Object.freeze(['set', 'pakket', 'kit']);
const NON_CORE_EXACT_TERMS = new Set([
  'kralen', 'lichtsnoer', 'ornament', 'ornamenten', 'tafeldecoratie', 'kerstdecoratie',
  'handgemaakt', 'doe-het-zelf', 'diy', 'verlichting', 'led', 'kleur', 'kleurrijk',
]);

function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function confirmedFactText(facts) {
  const fields = facts?.fields || {};
  const relevant = ['name', 'product_name', 'category', 'product_facts.category', 'product_facts.procurement_name'];
  return relevant
    .map(key => fields[key])
    .filter(item => item?.status === 'CONFIRMED')
    .map(item => asText(item.value))
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase();
}

function confirmedSourceRefs(facts) {
  const fields = facts?.fields || {};
  const refs = [];
  for (const key of ['name', 'product_name', 'category', 'product_facts.category', 'product_facts.procurement_name']) {
    const item = fields[key];
    if (item?.status !== 'CONFIRMED') continue;
    for (const ref of item.source_references || []) {
      refs.push({ fact_id: key, source_type: ref.source_type, source_reference: ref.source_reference, source_version: ref.source_version });
    }
  }
  const seen = new Set();
  return refs.filter(ref => {
    const key = JSON.stringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectCandidates(sourceRows = []) {
  const map = new Map();
  for (const source of sourceRows) {
    if (source?.status !== 'PASS' || !Array.isArray(source.exact_strings)) continue;
    for (const raw of source.exact_strings) {
      const exact = typeof raw === 'string' ? raw : asText(raw?.keyword ?? raw?.exact_string);
      if (!exact || /[\u3400-\u9fff]/u.test(exact)) continue;
      const row = map.get(exact) || { exact_string: exact, source_refs: [] };
      row.source_refs.push({
        source_id: source.source_id,
        result_version: source.result_version,
        provider_request_id: source.provider_request_id || null,
        evidence_refs: structuredClone(source.evidence_refs || []),
      });
      map.set(exact, row);
    }
  }
  return [...map.values()];
}

function factNounConcepts(factText) {
  const concepts = [];
  for (const entry of FACT_TO_DUTCH_CORE_NOUN) {
    if (!entry.fact_cues.some(cue => factText.includes(cue.toLocaleLowerCase()))) continue;
    concepts.push(entry);
  }
  // Where the confirmed fact itself contains a Dutch core noun candidate,
  // permit exact-source matching without a translation bridge.
  const dutchTerms = new Set();
  for (const entry of FACT_TO_DUTCH_CORE_NOUN) {
    for (const noun of entry.dutch_nouns) {
      if (factText.includes(noun)) dutchTerms.add(noun);
    }
  }
  return { concepts, dutchTerms };
}

function isConfirmedSetForm(factText) {
  return CONFIRMED_PRODUCT_FORM_CUES.some(cue => factText.includes(cue.toLocaleLowerCase()));
}

function nounMatch(candidateLower, noun, setFormConfirmed) {
  if (candidateLower === noun) return { match: true, specificity: 'CORE_NOUN' };
  if (!setFormConfirmed) return { match: false };
  for (const suffix of DUTCH_PRODUCT_FORM_SUFFIXES) {
    if (candidateLower === `${noun}${suffix}` || candidateLower === `${noun} ${suffix}`) {
      return { match: true, specificity: 'CORE_NOUN_WITH_CONFIRMED_PRODUCT_FORM', product_form: suffix };
    }
  }
  return { match: false };
}

/**
 * Returns a conservative, auditable SOP04 seed decision from current facts and
 * already-persisted SOP03 exact-string candidates.
 */
export function selectSop04SeedFromFacts({ facts, sourceRows = [], sop03ArtifactVersion = null } = {}) {
  const candidates = collectCandidates(sourceRows);
  const factText = confirmedFactText(facts);
  const forms = factNounConcepts(factText);
  const setFormConfirmed = isConfirmedSetForm(factText);
  const factRefs = confirmedSourceRefs(facts);

  const classifications = candidates.map(candidate => {
    const lower = candidate.exact_string.toLocaleLowerCase();
    const matches = [];
    for (const concept of forms.concepts) {
      for (const noun of concept.dutch_nouns) {
        const matched = nounMatch(lower, noun, setFormConfirmed);
        if (matched.match) matches.push({ concept: concept.concept, noun, ...matched });
      }
    }
    for (const noun of forms.dutchTerms) {
      const matched = nounMatch(lower, noun, setFormConfirmed);
      if (matched.match) matches.push({ concept: `confirmed_dutch:${noun}`, noun, ...matched });
    }
    if (!matches.length) {
      if (NON_CORE_EXACT_TERMS.has(lower)) {
        return { ...candidate, eligibility: 'EXCLUDED_NON_CORE', classification_reason: '该 exact string 未匹配已确认产品本体，且属于部件、场景、风格或属性表达。' };
      }
      return { ...candidate, eligibility: 'NOT_MATCHED_TO_CONFIRMED_CORE_FACT', classification_reason: '无法从当前已确认产品本体事实中建立核心名词匹配。' };
    }
    const distinct = [...new Map(matches.map(match => [JSON.stringify(match), match])).values()];
    return {
      ...candidate,
      eligibility: 'CORE_PRODUCT_NOUN',
      core_matches: distinct,
      specificity: distinct.some(item => item.specificity === 'CORE_NOUN_WITH_CONFIRMED_PRODUCT_FORM')
        ? 'CORE_NOUN_WITH_CONFIRMED_PRODUCT_FORM' : 'CORE_NOUN',
      classification_reason: distinct.some(item => item.specificity === 'CORE_NOUN_WITH_CONFIRMED_PRODUCT_FORM')
        ? 'exact string 同时匹配已确认核心产品本体词和已确认套装形态。'
        : 'exact string 匹配已确认的核心产品本体词。',
    };
  });

  const eligible = classifications.filter(item => item.eligibility === 'CORE_PRODUCT_NOUN');
  if (!facts || facts.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || facts.status === 'STALE') {
    return { status: 'NO_ELIGIBLE_CANDIDATE', reason_code: 'CONFIRMED_FACTS_UNAVAILABLE_OR_STALE', policy: SOP04_SEED_SELECTION_POLICY, candidates: classifications };
  }
  if (!eligible.length) {
    return { status: 'NO_ELIGIBLE_CANDIDATE', reason_code: 'NO_CONFIRMED_CORE_NOUN_MATCH', policy: SOP04_SEED_SELECTION_POLICY, candidates: classifications };
  }

  // A confirmed product-form compound dominates its bare head noun. No score
  // or relevance ranking is calculated.
  const specific = eligible.filter(item => item.specificity === 'CORE_NOUN_WITH_CONFIRMED_PRODUCT_FORM');
  const frontier = specific.length ? specific : eligible;
  const concepts = new Set(frontier.flatMap(item => (item.core_matches || []).map(match => match.concept)));
  if (frontier.length > 1 && concepts.size > 1) {
    return {
      status: 'WAITING_DECISION', reason_code: 'EQUALLY_REASONABLE_CORE_NOUNS_DIFFERENT_MARKET_DIRECTIONS',
      policy: SOP04_SEED_SELECTION_POLICY, candidates: classifications,
      decision_candidates: frontier.map(item => item.exact_string),
      reason: '存在同等合理且对应不同核心市场方向的本体词。',
    };
  }

  // For same-direction exact variants at equal specificity, keep the earliest
  // SOP03 source/extractor order; the exact string itself is never normalized.
  const chosen = frontier[0];
  const dominated = eligible.filter(item => item !== chosen && item.specificity === 'CORE_NOUN');
  const selectionReason = [
    `按 ${SOP04_SEED_SELECTION_POLICY}，仅从 SOP03 PASS 的原始 exact strings 中选择。`,
    `confirmed facts v${facts.version} 支持核心本体“${chosen.core_matches?.[0]?.noun || chosen.exact_string}”。`,
    chosen.specificity === 'CORE_NOUN_WITH_CONFIRMED_PRODUCT_FORM'
      ? `facts 明确包含套装形态，${chosen.exact_string} 同时保留本体词与套装形态；比裸本体候选更具体。`
      : '该候选是已确认事实支持的最具体核心本体表达。',
    dominated.length ? `更宽的本体候选被具体表达支配：${dominated.map(item => item.exact_string).join('、')}。` : '',
    '未使用属性、材质、场景、风格词作为优先 seed；没有生成或改写关键词。',
  ].filter(Boolean).join(' ');
  return {
    status: 'SELECTED', policy: SOP04_SEED_SELECTION_POLICY,
    selected: {
      exact_string: chosen.exact_string,
      source_refs: structuredClone(chosen.source_refs),
      confirmed_product_facts_version: facts.version,
      sop03_artifact_version: sop03ArtifactVersion,
      facts_evidence_refs: factRefs,
      seed_selection_reason: selectionReason,
      selected_concept: chosen.core_matches?.[0]?.concept || null,
      specificity: chosen.specificity,
    },
    candidates: classifications,
  };
}
