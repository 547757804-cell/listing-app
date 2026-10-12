import crypto from 'node:crypto';
import { validateListingEvidence } from './listing_evidence_resolver.mjs';
export const listingAmendmentHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentFields = Object.freeze({
  LISTING_SOP_14: ['title_nl','title_zh','language','source_fact_version','keyword_layout_refs','evidence_refs'],
  LISTING_SOP_15: ['anchors','evidence_refs'],
  LISTING_SOP_16: ['description_nl','description_zh','package_contents_nl','package_contents_zh','product_attributes','product_attributes_zh','language','source_fact_version','keyword_layout_refs','evidence_refs'],
});
export function listingEditableContent(output) {
  return Object.fromEntries((contentFields[output.sop_step_id] || []).map(key=>[key,output[key]]).filter(([,v])=>v!==undefined));
}
/** Audited, offline-reviewed correction; preserves the original Provider result. */
export function applyListingOutputAmendment(output, inputs, plan) {
  if (contentFields[plan?.step]) {
    const allowed=contentFields[plan.step];
    if(output.sop_step_id!==plan.step || output.sku!==plan.sku
      || listingAmendmentHash(inputs.input_version_refs)!==plan.input_versions_hash
      || listingAmendmentHash(listingEditableContent(output))!==plan.original_content_hash
      || plan.reason!=='FIXED_SOP_FACTS_AND_EVIDENCE_CONTENT_CORRECTION'
      || !plan.plan_ref || !plan.review?.facts_only || !plan.review?.no_new_product_facts
      || !Array.isArray(plan.review?.change_reasons) || !plan.review.change_reasons.length
      || !plan.replacement || Object.keys(plan.replacement).some(k=>!allowed.includes(k)))
      throw Object.assign(new Error('Content amendment identity mismatch'),{code:'LISTING_AMENDMENT_REJECTED'});
    const amended={...output,...structuredClone(plan.replacement)};
    if(validateListingEvidence(amended,inputs).status!=='PASS')
      throw Object.assign(new Error('Content amendment evidence is unresolved'),{code:'LISTING_AMENDMENT_REJECTED'});
    return {...amended,local_amendment_audit:{plan_ref:plan.plan_ref,reason:plan.reason,
      original_content:listingEditableContent(output),review:structuredClone(plan.review),
      provider_requests:0,original_provider_results_unchanged:true}};
  }
  if (!plan || plan.step !== 'LISTING_SOP_13' || output.sop_step_id !== plan.step || output.sku !== plan.sku
    || listingAmendmentHash(inputs.input_version_refs) !== plan.input_versions_hash
    || listingAmendmentHash(output.display_decisions) !== plan.original_decisions_hash
    || plan.reason !== 'FIXED_SOP_EVIDENCE_AND_EXACT_STRING_CORRECTION') throw Object.assign(new Error('Listing amendment identity mismatch'),{code:'LISTING_AMENDMENT_REJECTED'});
  const rows=structuredClone(output.display_decisions), changes=[];
  for(const update of plan.updates || []) {
    const row=rows.find(r=>r.target_ref===update.target_ref);
    if(!row || listingAmendmentHash(row)!==update.original_hash || update.decision!=='KEEP' || !update.exact_string || !update.reason || !update.evidence_refs?.length)
      throw Object.assign(new Error('Listing amendment row mismatch'),{code:'LISTING_AMENDMENT_REJECTED'});
    changes.push({target_ref:row.target_ref,previous:structuredClone(row),corrected:structuredClone(update)});
    Object.assign(row,{decision:update.decision,exact_string:update.exact_string,reason:update.reason,evidence_refs:update.evidence_refs,
      downweight_basis:'NOT_APPLICABLE',comparison_result:'UNKNOWN',comparison_scope:'B_REFERENCE_LIMITED'});
  }
  return {...output,display_decisions:rows,local_amendment_audit:{plan_ref:plan.plan_ref,reason:plan.reason,changes,provider_requests:0,original_provider_results_unchanged:true}};
}
