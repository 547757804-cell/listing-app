import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const reject = code => { throw Object.assign(new Error(code), { code }); };

async function readScopedJson(root, reference) {
  if (typeof reference !== 'string' || !reference || reference.includes('://')) reject('CAPABILITY_EVIDENCE_REF_REQUIRED');
  const rootAbsolute = path.resolve(root);
  const absolute = path.resolve(rootAbsolute, reference);
  const relative = path.relative(rootAbsolute, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reject('CAPABILITY_EVIDENCE_PATH_REJECTED');
  // The Windows host sandbox returns EPERM for realpath on newly created
  // directories. Preserve fail-closed symlink protection by lstat'ing every
  // component from the volume root through the target; no reference component
  // may be a symbolic link or junction.
  const volumeRoot = path.parse(rootAbsolute).root;
  const rootParts = rootAbsolute.slice(volumeRoot.length).split(/[\\/]+/).filter(Boolean);
  let cursor = volumeRoot;
  for (const part of rootParts) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) reject('CAPABILITY_EVIDENCE_PATH_REJECTED');
  }
  for (const part of relative.split(/[\\/]+/)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) reject('CAPABILITY_EVIDENCE_PATH_REJECTED');
  }
  const bytes = await fs.readFile(absolute);
  return { value: JSON.parse(bytes), sha256: hash(bytes) };
}

/** Exact caller-supplied reference only. Never select a latest probe. */
export async function readCapabilityEvidence(root, reference) {
  if (!reference) reject('CAPABILITY_EVIDENCE_REF_REQUIRED');
  const [file, fragment] = String(reference).split('#');
  const source = await readScopedJson(root, file);
  let probe;
  if (fragment) {
    const match = /^capability_probes\/([^/]+)$/.exec(fragment);
    if (!match || file.replaceAll('\\', '/') !== 'integrations/ai-generation-recovery/state.json') reject('CAPABILITY_EVIDENCE_FRAGMENT_INVALID');
    probe = source.value.capability_probes?.find(item => item.probe_id === match[1]);
  } else if (source.value.artifact_type === 'GENERATION_CAPABILITY_BINDING_SNAPSHOT') {
    probe = source.value.probe;
    if (hash(JSON.stringify(probe)) !== source.value.probe_sha256) reject('CAPABILITY_EVIDENCE_HASH_MISMATCH');
  } else if (source.value.artifact_type === 'DEEPSEEK_RESPONSES_CAPABILITY_NORMALIZED_EVIDENCE') {
    const normalized = source.value;
    const raw = await readScopedJson(root, normalized.raw_evidence_ref);
    if (raw.sha256 !== normalized.raw_evidence_sha256) reject('CAPABILITY_EVIDENCE_HASH_MISMATCH');
    const prior = await readCapabilityEvidence(root, normalized.source_probe_record_ref);
    const result = raw.value;
    if (normalized.normalized_result !== 'PASS' || result.test_id !== normalized.source_probe_id
      || result.http_status !== 200 || result.response_status !== 'completed'
      || result.json_parse !== 'PASS' || result.schema_validation !== 'PASS'
      || !result.attempts?.some(item => item.http_status === 200 && item.response_status === 'completed'
        && item.json_parse === 'PASS' && item.schema_validation === 'PASS' && !item.failure_code)) reject('NORMALIZED_CAPABILITY_NOT_PROVEN');
    for (const field of ['checked_at', 'effective_model', 'returned_model', 'endpoint_identity_hash', 'provider_config_hash',
      'adapter_contract_hash', 'adapter_contract_version', 'adapter_version', 'network_config_hash']) {
      if (normalized[field] !== prior.probe[field]) reject('NORMALIZED_CAPABILITY_IDENTITY_MISMATCH');
    }
    // Correct only the documented wrapper status defect. Keep original timestamps and source records.
    probe = { ...prior.probe, status: 'PASS', thinking_mode: 'disabled', max_output_tokens: normalized.max_output_tokens,
      attempts: prior.probe.attempts.map(item => ({ ...item, attempt_status: item.http_status === 200
        && item.response_status === 'completed' && item.json_parse === 'PASS' && item.schema_validation === 'PASS'
        && !item.failure_code ? 'PASS' : item.attempt_status })) };
  } else if (source.value.test_id) {
    const exact = await readCapabilityEvidence(root, `integrations/ai-generation-recovery/state.json#capability_probes/${source.value.test_id}`);
    probe = exact.probe;
    if (source.value.status !== probe.status || source.value.http_status !== probe.http_status
      || source.value.response_status !== probe.response_status || source.value.returned_model !== probe.returned_model)
      reject('CAPABILITY_REPORT_RECORD_MISMATCH');
  } else if (source.value.probe_id) probe = source.value;
  if (!probe) reject('CAPABILITY_EVIDENCE_NOT_FOUND');
  return { probe: clone(probe), reference, sha256: fragment ? hash(JSON.stringify(probe)) : source.sha256 };
}

export async function persistCapabilitySnapshot(root, evidence, directory) {
  const probeHash = hash(JSON.stringify(evidence.probe));
  const record = { artifact_type: 'GENERATION_CAPABILITY_BINDING_SNAPSHOT', source_ref: evidence.reference,
    source_sha256: evidence.sha256, probe_sha256: probeHash, probe: evidence.probe };
  const reference = `${directory}/GENERATION_CAPABILITY_BINDING_SNAPSHOT-${hash(JSON.stringify(record)).slice(0, 20)}.json`;
  await writeImmutableRecoveryArtifact(root, reference, record);
  return reference;
}

export async function writeImmutableRecoveryArtifact(root, reference, record) {
  const target = path.resolve(root, reference);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) reject('RECOVERY_ARTIFACT_PATH_REJECTED');
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.writeFile(target, bytes, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(target, 'utf8') !== bytes) throw error; }
}

/** Read-only plan. Old history is referenced, never relabelled as V2 attempts. */
export function planDeepSeekProtocolMigration({ task, identity, state }) {
  const oldWait = task.ai_generation_waiting;
  const barrier = oldWait?.generation_failed_at;
  if (!oldWait?.generation_key || !barrier) reject('GENERATION_FAILURE_CONTEXT_MISSING');
  if (oldWait.generation_key === identity.generation_key) {
    return { wait: clone(oldWait), circuit: clone(state.circuits[identity.generation_key] || null), migration: null };
  }
  const oldCircuit = state.circuits[oldWait.generation_key];
  const oldIdentity = oldCircuit?.identity || state.partial_results?.[oldWait.generation_key]?.identity || oldWait;
  if (oldIdentity.provider !== 'DeepSeek' || oldIdentity.sku !== identity.sku || oldIdentity.step !== identity.step
    || oldIdentity.input_version_hash !== identity.input_version_hash || oldWait.effective_model !== identity.effective_model
    || !oldCircuit || oldCircuit.last_generation_failed_at !== barrier
    || !['OPEN', 'CLOSED'].includes(oldCircuit.state)
    || identity.execution_contract?.api_protocol !== 'RESPONSES'
    || identity.execution_contract?.structured_output !== 'json_schema') reject('RECOVERY_PROTOCOL_MIGRATION_IDENTITY_MISMATCH');
  const core = { artifact_type: 'DEEPSEEK_RECOVERY_PROTOCOL_MIGRATION', sku: task.sku, step: identity.step,
    old_protocol_identity: clone(oldIdentity), old_failure_barrier: barrier,
    old_circuit: clone(oldCircuit), old_circuit_sha256: hash(JSON.stringify(oldCircuit)),
    old_history_ref: `integrations/ai-generation-recovery/state.json#partial_results/${oldWait.generation_key}/attempts`,
    new_protocol_identity: clone(identity), migration_reason: 'CHAT_COMPLETIONS_TO_RESPONSES_JSON_SCHEMA',
    history_relabelled: false };
  const migration = { ...core, version: `DEEPSEEK_RECOVERY_PROTOCOL_MIGRATION-${hash(JSON.stringify(core)).slice(0, 20)}` };
  const existing = state.circuits[identity.generation_key];
  if (existing && existing.protocol_migration_version !== migration.version) reject('RECOVERY_PROTOCOL_TARGET_ALREADY_EXISTS');
  const circuit = existing || { generation_key: identity.generation_key, identity: clone(identity), state: 'OPEN', failure_count: 0,
    inherited_failure_count: Number(oldCircuit.failure_count), last_generation_failed_at: barrier,
    last_failure_type: 'LEGACY_PROTOCOL_FAILURE_BARRIER', protocol_migration_version: migration.version,
    last_probe_ref: null };
  return { migration, circuit: clone(circuit), wait: { ...clone(identity), dependency: 'DEEPSEEK',
    generation_failed_at: barrier, required_generation_readiness_after: barrier,
    generation_failure_type: oldWait.generation_failure_type,
    protocol_migration_version: migration.version, source: 'DEEPSEEK_RECOVERY_PROTOCOL_MIGRATION' } };
}

/** Preserve the exact failure barrier and circuit history when only the
 * DeepSeek prompt contract/hash changes for the same Listing step inputs.
 * This is an explicit identity migration, never a fresh closed circuit. */
export function planDeepSeekPromptContractMigration({ task, identity, state }) {
  const oldWait = task?.ai_generation_waiting;
  const barrier = oldWait?.generation_failed_at;
  if (!oldWait?.generation_key || !barrier || !identity?.generation_key) reject('GENERATION_FAILURE_CONTEXT_MISSING');
  if (oldWait.generation_key === identity.generation_key) {
    return { wait: clone(oldWait), circuit: clone(state?.circuits?.[identity.generation_key] || null), migration: null };
  }
  const oldCircuit = state?.circuits?.[oldWait.generation_key];
  const oldIdentity = oldCircuit?.identity || state?.partial_results?.[oldWait.generation_key]?.identity || oldWait;
  const stripPromptIdentity = value => {
    const result = clone(value || {});
    delete result.generation_key;
    delete result.prompt_hash;
    delete result.prompt_contract_version;
    return result;
  };
  if (oldIdentity.provider !== 'DeepSeek' || identity.provider !== 'DeepSeek'
    || oldIdentity.sku !== task?.sku || oldIdentity.sku !== identity.sku
    || oldIdentity.step !== identity.step || !/^LISTING_SOP_1[0-7]$/.test(String(identity.step || ''))
    || oldWait.provider !== 'DeepSeek' || oldWait.step !== identity.step
    || oldIdentity.input_version_hash !== identity.input_version_hash
    || oldWait.effective_model !== identity.effective_model
    || oldIdentity.prompt_hash === identity.prompt_hash
    || oldIdentity.prompt_contract_version === identity.prompt_contract_version
    || JSON.stringify(stripPromptIdentity(oldIdentity)) !== JSON.stringify(stripPromptIdentity(identity))
    || !oldCircuit || oldCircuit.generation_key !== oldWait.generation_key
    || oldCircuit.last_generation_failed_at !== barrier || oldCircuit.state !== 'OPEN'
    || Number(oldCircuit.failure_count || 0) < 1) reject('DEEPSEEK_PROMPT_MIGRATION_IDENTITY_MISMATCH');
  const core = { artifact_type: 'DEEPSEEK_RECOVERY_PROMPT_CONTRACT_MIGRATION', sku: task.sku, step: identity.step,
    old_identity: clone(oldIdentity), old_failure_barrier: barrier,
    old_circuit: clone(oldCircuit), old_circuit_sha256: hash(JSON.stringify(oldCircuit)),
    old_history_ref: `integrations/ai-generation-recovery/state.json#partial_results/${oldWait.generation_key}/attempts`,
    new_identity: clone(identity), migration_reason: 'PROMPT_CONTRACT_CHANGED_WITH_INPUT_AND_EXECUTION_CONTRACT_LOCKED',
    history_relabelled: false };
  const migration = { ...core, version: `DEEPSEEK_RECOVERY_PROMPT_MIGRATION-${hash(JSON.stringify(core)).slice(0, 20)}` };
  const existing = state?.circuits?.[identity.generation_key];
  if (existing && existing.identity_migration_version !== migration.version) reject('RECOVERY_IDENTITY_TARGET_ALREADY_EXISTS');
  const circuit = existing || { generation_key: identity.generation_key, identity: clone(identity), state: 'OPEN', failure_count: 0,
    inherited_failure_count: Number(oldCircuit.failure_count), last_generation_failed_at: barrier,
    last_failure_type: 'INHERITED_PROMPT_CONTRACT_FAILURE_BARRIER', identity_migration_version: migration.version,
    last_probe_ref: null };
  return { migration, circuit: clone(circuit), wait: { ...clone(identity), dependency: 'DEEPSEEK',
    generation_failed_at: barrier, required_generation_readiness_after: barrier,
    generation_failure_type: oldWait.generation_failure_type || oldCircuit.last_failure_type,
    identity_migration_version: migration.version, source: 'DEEPSEEK_RECOVERY_PROMPT_CONTRACT_MIGRATION' } };
}

/** Preserve a closed/open Qwen generation barrier while changing only the
 * SOP10 request contract. The old key and attempt history are never renamed. */
export function planQwenSop10RequestContractMigration({ task, identity, state }) {
  const oldWait = task?.ai_generation_waiting;
  const barrier = oldWait?.generation_failed_at;
  if (!oldWait?.generation_key || !barrier) reject('GENERATION_FAILURE_CONTEXT_MISSING');
  if (oldWait.generation_key === identity?.generation_key) {
    return { wait: clone(oldWait), circuit: clone(state?.circuits?.[identity.generation_key] || null), migration: null };
  }
  const oldCircuit = state?.circuits?.[oldWait.generation_key];
  const oldIdentity = oldCircuit?.identity || state?.partial_results?.[oldWait.generation_key]?.identity || oldWait;
  if (oldIdentity.provider !== 'Qwen' || identity?.provider !== 'Qwen' || oldIdentity.sku !== identity.sku
    || oldIdentity.step !== 'LISTING_SOP_10' || identity.step !== 'LISTING_SOP_10'
    || oldIdentity.input_version_hash !== identity.input_version_hash
    || oldWait.effective_model !== identity.effective_model
    || !oldCircuit || oldCircuit.last_generation_failed_at !== barrier || oldCircuit.state !== 'OPEN'
    || identity.execution_contract?.api_protocol !== 'CHAT_COMPLETIONS'
    || identity.execution_contract?.structured_output !== 'json_schema'
    || identity.execution_contract?.reasoning_effort !== 'none'
    || identity.execution_contract?.preserve_thinking !== false
    || identity.execution_contract?.max_completion_tokens !== 16384
    || identity.effective_model !== 'qwen3.8-flash') reject('QWEN_REQUEST_CONTRACT_MIGRATION_IDENTITY_MISMATCH');
  const core = { artifact_type: 'QWEN_SOP10_REQUEST_CONTRACT_MIGRATION', sku: task.sku, step: identity.step,
    old_protocol_identity: clone(oldIdentity), old_failure_barrier: barrier,
    old_circuit: clone(oldCircuit), old_circuit_sha256: hash(JSON.stringify(oldCircuit)),
    old_history_ref: `integrations/ai-generation-recovery/state.json#partial_results/${oldWait.generation_key}/attempts`,
    new_protocol_identity: clone(identity), migration_reason: 'QWEN_SOP10_LOW_THINKING_STRICT_SCHEMA_AND_DEDUPLICATED_EVIDENCE',
    history_relabelled: false };
  const migration = { ...core, version: `QWEN_SOP10_REQUEST_CONTRACT_MIGRATION-${hash(JSON.stringify(core)).slice(0, 20)}` };
  const existing = state?.circuits?.[identity.generation_key];
  if (existing && existing.protocol_migration_version !== migration.version) reject('RECOVERY_PROTOCOL_TARGET_ALREADY_EXISTS');
  const circuit = existing || { generation_key: identity.generation_key, identity: clone(identity), state: 'OPEN', failure_count: 0,
    inherited_failure_count: Number(oldCircuit.failure_count), last_generation_failed_at: barrier,
    last_failure_type: 'LEGACY_REQUEST_CONTRACT_FAILURE_BARRIER', protocol_migration_version: migration.version,
    last_probe_ref: null };
  return { migration, circuit: clone(circuit), wait: { ...clone(identity), dependency: 'QWEN',
    generation_failed_at: barrier, required_generation_readiness_after: barrier,
    generation_failure_type: oldWait.generation_failure_type || oldCircuit.last_failure_type,
    protocol_migration_version: migration.version, source: 'QWEN_SOP10_REQUEST_CONTRACT_MIGRATION' } };
}
