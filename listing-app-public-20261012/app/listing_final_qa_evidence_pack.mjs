// Deterministic projection for Final QA. Full originals stay immutable and version/SHA locked.
export const SOP17_EVIDENCE_PACK_VERSION='SOP17_FINAL_QA_EVIDENCE_PACK_V1';
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,structuredClone(o[k])]));
function currentSourceBoundaries(locked){
  const source=locked.inputs||{},sop08=source.LISTING_SOP_08||{},sop09=source.LISTING_SOP_09||{};
  const amazon=sop09.amazon_reference_analysis||{},reviews=sop09.review_analysis||amazon.inline_reviews||{};
  const delivery=amazon.delivery_context||{},ratings=amazon.ratings_summary||{},pkg=amazon.package_contents||{};
  const result={...pick(locked.sop08_context,['artifact_version','classification','low_competitor_pool_confidence','confidence_reason'])};
  const reviewScope=amazon.inline_reviews?.review_scope||reviews.review_scope||reviews.amazon_scope;
  const pagination=reviews.pagination_status||reviews.review_pagination?.status||amazon.review_pagination?.value?.status;
  if(reviewScope!==undefined)result.amazon_reviews_scope=reviewScope;
  if(pagination!==undefined)result.amazon_pagination=pagination;
  const ratingCount=ratings.rating_count?.value??ratings.rating_count;
  const textReviewCount=ratings.review_count?.value??ratings.review_count;
  if(ratingCount!==undefined)result.amazon_rating_count_is_text_review_count=Boolean(textReviewCount!==undefined&&textReviewCount===ratingCount);
  const conflict=pkg.conflict_status||pkg.consistency;
  if(conflict!==undefined)result.amazon_package_conflict=conflict;
  if(pkg.auto_resolved!==undefined)result.amazon_package_conflict_resolved=pkg.auto_resolved===true;
  const usable=delivery.usable_for_amazon_de_local_price_comparison;
  if(usable!==undefined)result.amazon_price_usable_for_de_local_comparison=usable===true;
  const destination=delivery.destination?.value??delivery.destination;
  const currency=delivery.currency?.value??delivery.currency;
  if(usable!==undefined) result.amazon_price_not_usable_for_de_local_comparison=usable===false;
  return result;
}
export function buildFinalQaEvidencePack(locked){
  const source=locked.inputs,facts=source.LISTING_SOP_02,pack={pack_version:SOP17_EVIDENCE_PACK_VERSION,input_version_refs:locked.input_version_refs,
    current_sku_context:locked.current_sku_context?structuredClone(locked.current_sku_context):undefined,
    own_facts:pick(facts,['version','artifact_type','sku']),
    own_fact_rules:{unknown_never_publish:true,raw_procurement_fields_are_internal:true},
    source_boundaries:currentSourceBoundaries(locked),
    formal_top20:(source.LISTING_SOP_07.records||[]).map(r=>pick(r,['rank','exact_string','Gemiddeld zoekvolume per maand','demand_status','keyword_category','facts_eligibility'])),
    sop08_context:pick(source.LISTING_SOP_08,['version','main_comparison_pool','counts','confidence_status','confidence_reason','low_competitor_pool_confidence']),
    upstream_analysis:{},buyer_listing:{},evidence_refs:locked.input_version_refs.map(r=>r.reference)};
  pack.own_facts.fields=Object.fromEntries(Object.entries(facts.fields||{}).filter(([k])=>!k.startsWith('product_facts.')||k==='product_facts.category').map(([k,v])=>[k,pick(v,['value','status','source_references'])]));
  const fields={LISTING_SOP_09:['source_completeness','source_conflicts','unavailable_fields','low_competitor_pool_confidence','analysis_confidence'],
    LISTING_SOP_10:['observed_selling_points','pain_points','buying_reasons','why_competitor_appears_to_sell','review_analysis'],
    LISTING_SOP_11:['comparisons'],LISTING_SOP_12:['matrix_items'],LISTING_SOP_13:['display_decisions']};
  for(const[step,keys]of Object.entries(fields))pack.upstream_analysis[step]={...pick(source[step],['version','status','qa_status','low_competitor_pool_confidence','competitor_influence_ceiling','evidence_refs']),...pick(source[step],keys)};
  pack.upstream_analysis.LISTING_SOP_09.review_analysis=pick(source.LISTING_SOP_09.review_analysis,['amazon_scope','sample_count','pagination_status','frequency_scope','sample_items','no_population_frequency_claim','bol_reviews_status','bol_reviews_items']);
  pack.upstream_analysis.LISTING_SOP_09.amazon_source_context=pick(source.LISTING_SOP_09.amazon_reference_analysis,['identity','package_contents','ratings_summary','delivery_context','evidence_refs']);
  pack.buyer_listing.title=pick(source.LISTING_SOP_14,['version','title_nl','title_zh','source_fact_version','keyword_layout_refs','evidence_refs']);
  pack.buyer_listing.anchors=pick(source.LISTING_SOP_15,['version','anchors','facts_version','evidence_refs']);
  pack.buyer_listing.description=pick(source.LISTING_SOP_16,['version','description_nl','description_zh','package_contents_nl','package_contents_zh','product_attributes','product_attributes_zh','source_fact_version','keyword_layout_refs','evidence_refs']);
  return pack;
}
