import crypto from 'node:crypto';
import { createListingEvidenceResolver, validateListingEvidence } from './listing_evidence_resolver.mjs';

export const evidenceRepairHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reject = reason => { throw Object.assign(new Error(reason), { code: 'LISTING_EVIDENCE_REPAIR_REJECTED' }); };

/** Applies an explicit, input-locked audit plan to a derived result, never to Provider evidence. */
export function applyListingEvidenceRepair(output, inputs, plan) {
  if (plan?.step === 'LISTING_SOP_12') {
    if (output.sop_step_id !== plan.step || output.sku !== plan.sku
      || plan.input_refs_hash !== evidenceRepairHash(inputs.input_version_refs)
      || plan.original_matrix_hash !== evidenceRepairHash(output.matrix_items)
      || !plan.plan_ref || plan.reason !== 'SOP12_EXACT_LOCKED_INPUT_EQUIVALENCE'
      || !Array.isArray(plan.repairs) || !plan.repairs.length) reject('SOP12 evidence repair identity mismatch.');
    const resolver = createListingEvidenceResolver(inputs), replacements = new Map(), audit = [];
    for (const row of plan.repairs) {
      const source = resolver.resolve(row?.from), target = resolver.resolve(row?.to);
      if (!row.reason || replacements.has(row.from) || source.status !== 'MISSING' || target.status !== 'EXISTS'
        || !/^[a-f0-9]{64}$/iu.test(String(row.source_artifact_sha256 || ''))
        || row.source_value_sha256 !== target.resolved_value_sha256
        || row.target_value_sha256 !== target.resolved_value_sha256) reject('Only exact-value replacements to verified locked SOP12 evidence are allowed.');
      replacements.set(row.from, row.to);
      audit.push({ ...row, resolved_target: target });
    }
    const repaired = structuredClone(output), used = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'evidence_refs' && Array.isArray(child)) value[key] = child.map(ref => {
          if (replacements.has(ref)) { used.add(ref); return replacements.get(ref); }
          return ref;
        });
        else if (!['provider_trace', 'ai_model_provenance', 'input_version_refs', 'evidence_reference_index'].includes(key)) walk(child);
      }
    }
    walk(repaired);
    if (used.size !== replacements.size || validateListingEvidence(repaired, inputs).status !== 'PASS') reject('SOP12 evidence repair is incomplete.');
    const stripRefs = value => Array.isArray(value) ? value.map(stripRefs)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'evidence_refs').map(([key, child]) => [key, stripRefs(child)])) : value;
    if (evidenceRepairHash(stripRefs(repaired.matrix_items)) !== evidenceRepairHash(stripRefs(output.matrix_items))) reject('SOP12 business conclusions changed during evidence repair.');
    repaired.evidence_repair_audit = { version: plan.version, plan_ref: plan.plan_ref,
      original_matrix_hash: plan.original_matrix_hash, input_refs_hash: plan.input_refs_hash,
      repairs: audit, business_conclusions_unchanged: true, provider_results_modified: false, provider_requests_added: 0 };
    return repaired;
  }
  if (plan?.step === 'LISTING_SOP_17') {
    if (output.sop_step_id !== plan.step || output.sku !== plan.sku
      || plan.input_refs_hash !== evidenceRepairHash(inputs.input_version_refs)
      || plan.original_semantic_hash !== evidenceRepairHash(output.semantic_qa)
      || !plan.plan_ref || plan.reason !== 'EVIDENCE_PACK_POINTER_TO_ORIGINAL_ARTIFACT'
      || !Array.isArray(plan.repairs) || !plan.repairs.length) reject('Final QA reference repair identity mismatch.');
    const resolver = createListingEvidenceResolver(inputs), replacements = new Map(), audit = [];
    for (const row of plan.repairs) {
      if (!row.reason || replacements.has(row.from) || resolver.resolve(row.from).status !== 'MISSING'
        || resolver.resolve(row.to).status !== 'EXISTS') reject('Only missing references with verified real replacements may be repaired.');
      replacements.set(row.from, row.to);
      audit.push({ ...row, resolved: resolver.resolve(row.to) });
    }
    const repaired = structuredClone(output), used = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'evidence_refs' && Array.isArray(child)) value[key] = child.map(ref => {
          if (replacements.has(ref)) { used.add(ref); return replacements.get(ref); }
          return ref;
        });
        else if (!['provider_trace', 'ai_model_provenance', 'input_version_refs', 'evidence_reference_index'].includes(key)) walk(child);
      }
    }
    walk(repaired);
    if (used.size !== replacements.size || validateListingEvidence(repaired, inputs).status !== 'PASS') reject('Final QA reference repair is incomplete.');
    repaired.evidence_repair_audit = { version: plan.version, plan_ref: plan.plan_ref,
      original_semantic_hash: plan.original_semantic_hash, input_refs_hash: plan.input_refs_hash,
      repairs: audit, semantic_findings_unchanged: true, provider_results_modified: false, provider_requests_added: 0 };
    return repaired;
  }
  if (plan?.step !== 'LISTING_SOP_11' || output.sop_step_id !== plan.step || plan.sku !== output.sku
    || plan.input_refs_hash !== evidenceRepairHash(inputs.input_version_refs)
    || plan.original_comparisons_hash !== evidenceRepairHash(output.comparisons)) reject('Repair plan does not match current locked inputs and Provider conclusions.');
  const resolver = createListingEvidenceResolver(inputs);
  const audit = [];
  if (plan.conclusions?.length !== output.comparisons?.length) reject('Every conclusion must have an audit entry.');
  const repaired = structuredClone(output);
  for (let i = 0; i < repaired.comparisons.length; i++) {
    const row = repaired.comparisons[i], edit = plan.conclusions[i];
    if (edit.index !== i || edit.dimension !== row.dimension || edit.original_hash !== evidenceRepairHash(row)) reject('Conclusion identity mismatch.');
    if (!['SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'CONTEXT_ONLY'].includes(edit.support)) reject('Missing support audit.');
    const refs = row.evidence_refs.map(ref => edit.ref_replacements?.[ref] || ref);
    if (!refs.length || refs.some(ref => resolver.resolve(ref).status !== 'EXISTS')) reject('Replacement evidence must exist in locked artifacts.');
    if (edit.relation && edit.relation !== row.relation && edit.relation !== 'UNKNOWN') reject('Repairs cannot strengthen a conclusion.');
    if (edit.support !== 'SUPPORTED' && (edit.relation || row.relation) !== 'UNKNOWN') reject('Unsupported comparison must be UNKNOWN.');
    row.conclusion_id = edit.conclusion_id;
    row.evidence_refs = [...new Set(refs)];
    row.relation = edit.relation || row.relation;
    if (edit.note) row.note = edit.note;
    row.evidence_support = edit.support;
    row.comparison_scope = 'REFERENCE_ONLY';
    if (edit.competitor_level) {
      if (!['B_REFERENCE', 'AMAZON_REFERENCE_ONLY'].includes(edit.competitor_level)) reject('Invalid influence level.');
      row.competitor_level = edit.competitor_level;
    }
    audit.push({ ...edit, before_evidence: output.comparisons[i].evidence_refs.map(ref => resolver.resolve(ref)),
      after_evidence: row.evidence_refs.map(ref => resolver.resolve(ref)), original_relation: output.comparisons[i].relation,
      final_relation: row.relation });
  }
  const replacements = plan.top_level_ref_replacements || {};
  repaired.evidence_refs = [...new Set(repaired.evidence_refs.map(ref => replacements[ref] || ref))];
  repaired.low_competitor_pool_confidence = inputs.sop08_context.low_competitor_pool_confidence === true;
  repaired.competitor_influence_ceiling = 'B_REFERENCE_LIMITED';
  repaired.evidence_repair_audit = { version: plan.version, plan_ref: plan.plan_ref, input_refs_hash: plan.input_refs_hash,
    original_comparisons_hash: plan.original_comparisons_hash, conclusions: audit,
    provider_results_modified: false, provider_requests_added: 0 };
  const resolution = validateListingEvidence(repaired, inputs);
  if (resolution.status !== 'PASS') reject('Repaired output still contains unresolved evidence.');
  return repaired;
}
