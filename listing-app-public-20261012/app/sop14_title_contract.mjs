/** Shared SOP14 title-generation contract used by production and recovery probes. */
export const SOP14_TITLE_PROMPT_CONTRACT_VERSION = 'SOP10_17_SOP14_TITLE_LENGTH_V4';

export const SOP14_TITLE_LENGTH = Object.freeze({
  minimum: 230,
  maximum: 260,
  targetMinimum: 240,
  targetMaximum: 250,
  countUnit: 'UTF16_CODE_UNITS',
});

export function buildSop14TitleContractInstructions({ confirmedBrand = null } = {}) {
  const brand = typeof confirmedBrand === 'string' && confirmedBrand.trim()
    ? `品牌字段只允许使用已确认值“${confirmedBrand.trim()}”。`
    : '品牌字段仅在当前 SKU 的事实中明确为 CONFIRMED 时使用。';
  return [
    'SOP14 TITLE CONTRACT: title_nl must be Dutch and must contain 230–260 characters, including spaces and punctuation; target 240–250.',
    'Before returning JSON, count title_nl with JavaScript string length semantics (UTF-16 code units). If the count is outside 230–260, revise the title before returning.',
    'Build a complete, readable title only from the current SKU confirmed facts and exact approved keyword decisions: confirmed brand, core product noun, confirmed set/quantity, distinct confirmed product features or material, and an evidence-supported use context, using only applicable parts.',
    'Reach the required length with additional distinct, confirmed buyer-relevant information. Never pad, repeat a keyword, stack synonyms, add unsupported claims, or borrow competitor facts to meet the count.',
    'Do not include EAN/GTIN, internal identifiers, evidence refs, or QA labels in the buyer-facing title.',
    'Never return a title outside the required character range. Do not use a shorter title as a substitute and do not ask downstream QA to accept a known non-compliant result. If the locked facts and approved exact strings do not support a natural, fact-safe title in range, do not fabricate or pad buyer-facing text; treat that as a generation failure, not a title result.',
    brand,
    'Return the complete Chinese title with the same facts and meaning. Keep keyword_layout_refs as exact source references, not copied keyword objects.',
  ].join('\n');
}
