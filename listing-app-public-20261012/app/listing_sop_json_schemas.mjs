const refArray = { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } };
const text = { type: 'string' };
const nonEmptyText = { type: 'string', minLength: 1 };
const versionValue = { anyOf: [{ type: 'string' }, { type: 'number' }] };
const object = properties => ({ type: 'object', properties, additionalProperties: true });

const schemas = {
  LISTING_SOP_10: {
    type: 'object', additionalProperties: true,
    required: ['observed_selling_points', 'pain_points', 'buying_reasons', 'why_competitor_appears_to_sell', 'evidence_refs', 'low_competitor_pool_confidence'],
    properties: {
      observed_selling_points: { type: 'array', items: object({ evidence_refs: refArray }) },
      pain_points: { type: 'array', items: object({ evidence_refs: refArray }) },
      buying_reasons: { type: 'array', items: object({ evidence_refs: refArray }) },
      why_competitor_appears_to_sell: { type: 'array', items: object({ evidence_refs: refArray }) },
      evidence_refs: refArray,
      low_competitor_pool_confidence: { type: 'boolean' },
      review_analysis: object({
        review_scope: { type: 'string' },
        pagination_status: { type: 'string' },
        frequency_scope: { type: 'string' },
        rating_count_is_review_count: { type: 'boolean' },
      }),
    },
  },
  LISTING_SOP_11: {
    type: 'object', additionalProperties: true,
    required: ['comparisons', 'evidence_refs', 'facts_version', 'competitor_pool_version'],
    properties: {
      comparisons: { type: 'array', minItems: 1, items: object({
        relation: { type: 'string', enum: ['ADVANTAGE', 'EQUAL', 'DISADVANTAGE', 'UNKNOWN'] }, evidence_refs: refArray,
      }) }, evidence_refs: refArray, facts_version: versionValue, competitor_pool_version: nonEmptyText,
    },
  },
  LISTING_SOP_12: {
    type: 'object', additionalProperties: true,
    required: ['matrix_items', 'evidence_refs', 'low_competitor_pool_confidence'],
    properties: {
      matrix_items: { type: 'array', minItems: 1, items: object({ matrix_item_id: nonEmptyText, buyer_value: text, evidence_refs: refArray }) },
      evidence_refs: refArray, low_competitor_pool_confidence: { type: 'boolean' },
      competitor_influence_ceiling: { type: 'string' },
    },
  },
  LISTING_SOP_13: {
    type: 'object', additionalProperties: true,
    required: ['display_decisions', 'evidence_refs'],
    properties: {
      display_decisions: { type: 'array', minItems: 1, items: object({
        target_ref: nonEmptyText, decision: { type: 'string', enum: ['UPWEIGHT', 'KEEP', 'DOWNWEIGHT'] }, reason: nonEmptyText, evidence_refs: refArray,
      }) }, evidence_refs: refArray,
    },
  },
  LISTING_SOP_14: {
    type: 'object', additionalProperties: true,
    required: ['title_nl', 'title_zh', 'language', 'source_fact_version', 'keyword_layout_refs', 'evidence_refs'],
    properties: {
      title_nl: { type: 'string', minLength: 230, maxLength: 260 }, title_zh: nonEmptyText,
      language: { type: 'string', enum: ['nl-NL', 'nl'] }, source_fact_version: versionValue,
      keyword_layout_refs: { type: 'array', items: text }, evidence_refs: refArray,
    },
  },
  LISTING_SOP_15: {
    type: 'object', additionalProperties: true,
    required: ['anchors', 'evidence_refs'],
    properties: {
      anchors: { type: 'array', minItems: 5, maxItems: 5, items: object({
        anchor_id: nonEmptyText, title_nl:nonEmptyText, title_zh:nonEmptyText, phrases_nl:{type:'array',minItems:4,maxItems:5,items:nonEmptyText}, phrases_zh:{type:'array',minItems:4,maxItems:5,items:nonEmptyText}, text_nl: nonEmptyText, text_zh: text,
        source_fact_refs: refArray, evidence_refs: refArray,
      }) }, evidence_refs: refArray,
    },
  },
  LISTING_SOP_16: {
    type: 'object', additionalProperties: true,
    required: ['description_nl', 'description_zh', 'package_contents_nl', 'product_attributes', 'language', 'source_fact_version', 'keyword_layout_refs', 'evidence_refs'],
    properties: {
      description_nl: { type: 'string', minLength: 2500, maxLength: 2800 }, description_zh: nonEmptyText,
      package_contents_nl: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', minItems: 1 }] },
      product_attributes: { type: 'object', minProperties: 1, additionalProperties: true },
      language: { type: 'string', enum: ['nl-NL', 'nl'] }, source_fact_version: versionValue,
      keyword_layout_refs: { type: 'array', items: text }, evidence_refs: refArray,
    },
  },
  LISTING_SOP_17: {
    type: 'object', additionalProperties: true,
    required: ['semantic_qa', 'evidence_refs'],
    properties: {
      semantic_qa: object({
        status: { type: 'string', enum: ['PASS','FAIL'] }, evidence_refs: refArray,
        unconfirmed_facts_included: { type: 'boolean' },
        competitor_facts_in_own_listing: { type: 'boolean' },
        title_anchors_description_consistency: { type: 'string', enum: ['PASS','FAIL'] },
      }), evidence_refs: refArray,
    },
  },
};

export function getListingSopJsonSchema(step) {
  const schema = schemas[String(step || '')];
  return schema ? structuredClone(schema) : null;
}

export function listListingSopJsonSchemaSteps() { return Object.keys(schemas); }

export function validateListingSopJsonSchema(value, schema, path = '$') {
  const errors = [];
  const details = [];
  const check = (item, rule, at) => {
    if (!rule || typeof rule !== 'object') return;
    if (Array.isArray(rule.anyOf)) {
      if (!rule.anyOf.some(option => validateListingSopJsonSchema(item, option).valid)) errors.push(`${at}:ANY_OF`);
      return;
    }
    const typeOk = rule.type === 'object' ? item !== null && typeof item === 'object' && !Array.isArray(item)
      : rule.type === 'array' ? Array.isArray(item)
        : rule.type === 'integer' ? Number.isInteger(item)
          : rule.type === 'number' ? typeof item === 'number' && Number.isFinite(item)
            : rule.type === 'boolean' ? typeof item === 'boolean'
              : rule.type === 'string' ? typeof item === 'string' : true;
    if (!typeOk) { errors.push(`${at}:TYPE`); return; }
    if (Array.isArray(rule.enum) && !rule.enum.includes(item)) errors.push(`${at}:ENUM`);
    if (typeof item === 'string') {
      if (Number.isInteger(rule.minLength) && item.length < rule.minLength) {
        errors.push(`${at}:MIN_LENGTH`);
        details.push({ path: at, keyword: 'minLength', actual: item.length, expected: rule.minLength });
      }
      if (Number.isInteger(rule.maxLength) && item.length > rule.maxLength) {
        errors.push(`${at}:MAX_LENGTH`);
        details.push({ path: at, keyword: 'maxLength', actual: item.length, expected: rule.maxLength });
      }
    }
    if (Array.isArray(item)) {
      if (Number.isInteger(rule.minItems) && item.length < rule.minItems) errors.push(`${at}:MIN_ITEMS`);
      if (Number.isInteger(rule.maxItems) && item.length > rule.maxItems) errors.push(`${at}:MAX_ITEMS`);
      if (rule.items) item.forEach((child, index) => check(child, rule.items, `${at}[${index}]`));
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of rule.required || []) if (!Object.hasOwn(item, key)) errors.push(`${at}.${key}:REQUIRED`);
      if (Number.isInteger(rule.minProperties) && Object.keys(item).length < rule.minProperties) errors.push(`${at}:MIN_PROPERTIES`);
      for (const [key, childRule] of Object.entries(rule.properties || {})) if (Object.hasOwn(item, key)) check(item[key], childRule, `${at}.${key}`);
    }
  };
  check(value, schema, path);
  return { valid: errors.length === 0, errors, details };
}
