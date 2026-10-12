/** QA-only index of references already present in SHA-locked input artifacts.
 * It does not modify the AI prompt, Provider result or cache identity.
 */
export function indexLockedListingEvidence(inputs) {
  const index = new Map();
  const add = (ref, source, pointer) => {
    if (typeof ref !== 'string' || !ref) return;
    const item = { input_step: source.step_id, input_version: source.version,
      artifact_ref: source.reference, artifact_sha256: source.sha256, json_pointer: pointer };
    const rows = index.get(ref) || [];
    if (!rows.some(row => JSON.stringify(row) === JSON.stringify(item))) rows.push(item);
    index.set(ref, rows);
  };
  const pointerKey = key => String(key).replace(/~/g,'~0').replace(/\//g,'~1');
  for (const source of inputs.input_version_refs || []) {
    const data = inputs.inputs?.[source.step_id];
    add(source.reference, source, '');
    add(source.version, source, '/version');
    function walk(value, pointer = '', inEvidence = false) {
      if (typeof value === 'string') { if (inEvidence) add(value, source, pointer); return; }
      if (!value || typeof value !== 'object') return;
      if (inEvidence && !Array.isArray(value) && value.source && value.command && value.request_id
          && value.id_match === true && value.request_id === value.response_id) {
        const prefix = `${value.source} ${value.command}`;
        add(`${prefix} request_id ${value.request_id}`, source, pointer);
        if (typeof value.selector === 'string') add(`${prefix} ${value.selector} request_id ${value.request_id}`, source, pointer);
      }
      if (!Array.isArray(value) && typeof value.version === 'string') {
        add(value.version, source, `${pointer}/version`);
        if (typeof value.artifact_type === 'string') add(`${value.artifact_type} ${value.version}`, source, pointer);
      }
      for (const [key, child] of Object.entries(value)) {
        // Derived indexes and Provider copies are not new source evidence.
        // Recursing into them expands the same references at each SOP boundary.
        if (['provider_trace','ai_model_provenance','evidence_reference_index','evidence_resolution','evidence_repair_audit', 'local_amendment_audit'].includes(key)) continue;
        // Only reference fields enter the index, never ordinary page text.
        const explicit = /^(?:evidence_ref|evidence_refs|source_evidence_ref|artifact_ref|reference|dom_evidence_refs)$/.test(key);
        const dictionaryReference = inEvidence && (Array.isArray(value) || /(?:_ref|_facts|_bundle|_artifact)$/.test(key));
        walk(child, `${pointer}/${pointerKey(key)}`, explicit || dictionaryReference);
      }
    }
    walk(data);
  }
  return Object.fromEntries(index);
}
