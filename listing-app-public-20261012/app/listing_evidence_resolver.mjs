import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Strict, read-only resolver for version-locked Listing evidence. */
export const LISTING_EVIDENCE_RESOLVER_VERSION = 'LISTING_EVIDENCE_RESOLVER_V2';
const layers = new Set(['OWN_FACTS', 'PAGE_FACTS', 'BOL_API_FACTS', 'AMAZON_PAGE_FACTS', 'SOP08_CONTEXT', 'SOP09_ANALYSIS', 'LISTING_ARTIFACT', 'SOURCE_EVIDENCE']);
const BAD_REF = status => ({ exists: false, status });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
export const listingEvidenceValueSha256 = value => sha256(canonical(value));

/**
 * Load exact legacy-reference bindings from an immutable reconciliation artifact.
 * A binding is usable only after the manifest version and target file bytes,
 * SKU, artifact type, and version have been verified. It never searches for a
 * similar file or falls back to another layer.
 */
export async function loadVerifiedLegacyEvidenceArtifacts({ dataRoot, manifestReference, sku }) {
  if (!dataRoot || !manifestReference || !sku) throw new TypeError('dataRoot, manifestReference, and sku are required.');
  const root = path.resolve(dataRoot);
  const manifestPath = path.resolve(root, manifestReference);
  if (!manifestPath.startsWith(`${root}${path.sep}`)) throw new Error('Reconciliation manifest escapes dataRoot.');
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.artifact_type !== 'SYNTHETIC_ACCEPTANCE_10_LEGACY_EVIDENCE_RECONCILIATION' || manifest.sku !== sku
    || !Array.isArray(manifest.reference_bindings) || typeof manifest.version !== 'string') {
    throw new Error('Legacy evidence reconciliation identity/contract mismatch.');
  }
  const versionBody = { ...manifest };
  delete versionBody.version;
  const expectedVersion = `SYNTHETIC_ACCEPTANCE_10_LEGACY_EVIDENCE_RECONCILIATION-${sha256(canonical(versionBody)).slice(0, 20)}`;
  if (manifest.version !== expectedVersion) throw new Error('Reconciliation version does not match its content.');
  const seenAliases = new Set();
  const result = [];
  for (const binding of manifest.reference_bindings) {
    const alias = binding?.legacy_reference;
    const targetReference = binding?.target_reference;
    if (typeof alias !== 'string' || !alias.trim() || seenAliases.has(alias)
      || typeof targetReference !== 'string' || !targetReference || targetReference.startsWith('task:')
      || typeof binding.target_sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(binding.target_sha256)
      || binding.target_version == null || typeof binding.target_artifact_type !== 'string') {
      throw new Error('Malformed or duplicate legacy evidence binding.');
    }
    seenAliases.add(alias);
    const targetPath = path.resolve(root, targetReference);
    if (!targetPath.startsWith(`${root}${path.sep}`)) throw new Error('Legacy evidence target escapes dataRoot.');
    const bytes = await fs.readFile(targetPath);
    if (sha256(bytes) !== binding.target_sha256.toLowerCase()) throw new Error(`Legacy evidence target SHA mismatch: ${targetReference}`);
    const data = JSON.parse(bytes.toString('utf8'));
    if (data?.sku !== sku || data?.artifact_type !== binding.target_artifact_type) throw new Error(`Legacy evidence target identity mismatch: ${targetReference}`);
    if (data?.version != null && String(data.version) !== String(binding.target_version)) throw new Error(`Legacy evidence target version mismatch: ${targetReference}`);
    result.push({ step_id: binding.target_layer === 'OWN_FACTS' ? 'LISTING_SOP_02' : 'LISTING_SOP_03',
      artifact_type: binding.target_artifact_type, version: String(binding.target_version),
      reference: targetReference.replace(/\\/g, '/'), reference_aliases: [alias], artifact_ref: targetReference.replace(/\\/g, '/'),
      sha256: binding.target_sha256.toLowerCase(), sku, layer: binding.target_layer, data });
  }
  return result;
}

export function readEvidencePointer(data, pointer = '') {
  if (pointer === '') return { exists: data !== undefined, value: data };
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return BAD_REF('MALFORMED_REF');
  let value = data;
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(encoded)) return BAD_REF('MALFORMED_REF');
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return BAD_REF('MISSING');
    value = value[key];
  }
  return { exists: true, value };
}

function layerFor(source, pointer) {
  if (source.step_id === 'LISTING_SOP_02') return 'OWN_FACTS';
  if (source.step_id === 'LISTING_SOP_08' || /^\/(?:sop08_context|SOP08_CONTEXT)(?:\/|$)/.test(pointer)) return 'SOP08_CONTEXT';
  if (source.step_id === 'LISTING_SOP_09') {
    if (/^\/amazon_reference_analysis(?:\/|$)/.test(pointer)) return 'AMAZON_PAGE_FACTS';
    if (/^\/bol_competitor_analysis\/\d+\/api_/.test(pointer)) return 'BOL_API_FACTS';
    if (/^\/bol_competitor_analysis\/\d+\//.test(pointer)) return 'PAGE_FACTS';
    return 'SOP09_ANALYSIS';
  }
  return 'LISTING_ARTIFACT';
}

function parseReference(ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref !== ref.trim() || ref.includes('\0')) return null;
  const hashAt = ref.indexOf('#');
  if (hashAt >= 0 && ref.indexOf('#', hashAt + 1) >= 0) return null;
  const base = hashAt < 0 ? ref : ref.slice(0, hashAt);
  let pointer = hashAt < 0 ? '' : ref.slice(hashAt + 1);
  if (!base) return null;
  try { pointer = decodeURIComponent(pointer); } catch { return null; }
  if (pointer && !pointer.startsWith('/')) return null;
  if (base.split(/[\\/]/).some(part => part === '..') || pointer.split('/').some(part => part === '..')) return null;
  return { base, pointer };
}

function sourceIsStale(source, data, spec) {
  return source.stale === true || data?.stale === true || data?.status === 'STALE'
    || (spec.artifact_sha256 && String(spec.artifact_sha256).toLowerCase() !== String(source.sha256 || '').toLowerCase());
}

/**
 * Only exact locked source records or separately loaded, SHA-verified artifacts count.
 * Evidence-reference strings found in prose/indexes are deliberately never dereferenced.
 */
export function createListingEvidenceResolver(inputs = {}) {
  const taskSku = inputs.sku || inputs.current_sku_context?.sku || null;
  const catalog = [];
  for (const source of inputs.input_version_refs || []) {
    const data = inputs.inputs?.[source.step_id];
    if (data !== undefined) catalog.push({ ...source, data, layer: source.layer || null });
  }
  for (const item of inputs.evidence_artifacts || []) {
    if (item?.data !== undefined && item?.reference && item?.version && item?.sha256) catalog.push(item);
  }

  return {
    version: LISTING_EVIDENCE_RESOLVER_VERSION,
    resolve(request) {
      const spec = typeof request === 'string' ? { evidence_ref: request } : request || {};
      const ref = spec.evidence_ref ?? spec.evidence_id ?? spec.path;
      if (spec.evidence_layer && !layers.has(spec.evidence_layer)) return { status: 'INVALID_LAYER', evidence_ref: ref };
      const parsed = parseReference(ref);
      if (!parsed) return { status: 'MALFORMED_REF', evidence_ref: ref };
      // Explicit legacy aliases are permitted only when the caller loaded the
      // target artifact through a verified reconciliation binding. The source
      // keeps its real immutable `reference`; aliases are exact-match labels.
      const hits = catalog.filter(source => source.reference === parsed.base
        || (Array.isArray(source.reference_aliases) && source.reference_aliases.includes(parsed.base))
        || String(source.version) === parsed.base
        || (source.artifact_type && [`${source.artifact_type}:${source.version}`, `${source.artifact_type} ${source.version}`].includes(parsed.base))
        || (source.step_id && `${source.step_id} ${source.version}` === parsed.base));
      if (!hits.length) {
        const declaredFailure = (inputs.evidence_artifact_failures || []).find(item => item.reference === parsed.base);
        if (declaredFailure) return { status: declaredFailure.status, evidence_ref: ref, reason: declaredFailure.reason };
        return { status: 'MISSING', evidence_ref: ref, reason: 'ARTIFACT_NOT_IN_VERIFIED_CATALOG' };
      }

      const versionHits = hits.filter(source => !spec.artifact_version || String(source.version) === String(spec.artifact_version));
      if (!versionHits.length) return { status: 'VERSION_MISMATCH', evidence_ref: ref, reason: 'LOCKED_ARTIFACT_VERSION_DIFFERS' };
      const matchingLayer = versionHits.filter(source => !spec.evidence_layer || (source.layer || layerFor(source, parsed.pointer)) === spec.evidence_layer);
      if (!matchingLayer.length) return { status: 'INVALID_LAYER', evidence_ref: ref, reason: 'LAYER_NOT_PRESENT_ON_ARTIFACT_POINTER' };

      for (const source of matchingLayer) {
        const data = source.data;
        if (taskSku && source.sku && source.sku !== taskSku) continue;
        if (taskSku && data?.sku && data.sku !== taskSku) continue;
        if (sourceIsStale(source, data, spec)) return { status: 'STALE', evidence_ref: ref, artifact_version: source.version, reason: 'ARTIFACT_STALE_OR_SHA_MISMATCH' };
        if (spec.artifact_type && source.artifact_type !== spec.artifact_type && data?.artifact_type !== spec.artifact_type) continue;
        if (data?.version != null && String(data.version) !== String(source.version)) return { status: 'VERSION_MISMATCH', evidence_ref: ref, artifact_version: source.version, persisted_version: data.version };
        if (source.artifact_type && data?.artifact_type && data.artifact_type !== source.artifact_type) return { status: 'VERSION_MISMATCH', evidence_ref: ref, reason: 'ARTIFACT_TYPE_MISMATCH' };
        const pointer = readEvidencePointer(data, parsed.pointer);
        if (!pointer.exists) return { status: pointer.status === 'MALFORMED_REF' ? 'MALFORMED_REF' : 'MISSING', evidence_ref: ref, reason: 'JSON_POINTER_NOT_RESOLVABLE' };
        return { status: 'EXISTS', evidence_ref: ref, artifact_version: source.version, artifact_ref: source.artifact_ref || source.reference,
          artifact_sha256: source.sha256, input_step: source.step_id || null,
          evidence_layer: source.layer || layerFor(source, parsed.pointer), json_pointer: parsed.pointer,
          resolved_value_sha256: listingEvidenceValueSha256(pointer.value) };
      }
      return { status: 'MISSING', evidence_ref: ref, reason: 'CROSS_SKU_OR_ARTIFACT_IDENTITY_REJECTED' };
    },
  };
}

export function collectListingConclusionEvidence(output) {
  const refs = [];
  function walk(value, key = '') {
    if (!value || typeof value !== 'object') return;
    // The top-level `evidence` envelope stores artifact/input manifests. Those
    // references describe provenance inventory, not claims made by the output.
    // Conclusion refs remain collected from the output's explicit fields.
    if (key === 'evidence') return;
    if (['provider_trace', 'ai_model_provenance', 'evidence_reference_index', 'evidence_resolution', 'evidence_repair_audit', 'local_amendment_audit', 'input_version_refs'].includes(key)) return;
    for (const [name, child] of Object.entries(value)) {
      if (['evidence_refs', 'evidence_ref', 'source_evidence_ref', 'source_fact_refs'].includes(name)) {
        for (const ref of Array.isArray(child) ? child : [child]) if (typeof ref === 'string') refs.push(ref);
      } else walk(child, name);
    }
  }
  walk(output);
  return [...new Set(refs)];
}

export function validateListingEvidence(output, inputs) {
  const resolver = createListingEvidenceResolver(inputs);
  const results = collectListingConclusionEvidence(output).map(ref => resolver.resolve(ref));
  return { resolver_version: resolver.version, status: results.every(r => r.status === 'EXISTS') ? 'PASS' : 'FAIL', results };
}
