import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCEPTANCE_MODE, RUNTIME_MODE } from './runtime_mode.mjs';

const policyRef = 'integrations/listing-acceptance-closeout/authorization.json';
const codeError = code => Object.assign(new Error(code), { code });
export async function acceptanceCloseoutWindow(dataRoot, sku, step, now = Date.now()) {
  if (!ACCEPTANCE_MODE || RUNTIME_MODE !== 'NORMAL' || sku !== 'SYNTHETIC-SKU-LEGACY-10' || !/^LISTING_SOP_1[2-7]$/.test(step || '')) return {status:'NOT_APPLICABLE',policy:null};
  let p; try { p = JSON.parse(await fs.readFile(path.join(dataRoot, policyRef), 'utf8')); }
  catch(error) { return {status:error.code==='ENOENT'?'NOT_APPLICABLE':'INVALID',policy:null}; }
  const continuation=p.authorization==='SYNTHETIC_ACCEPTANCE_10_LISTING_CLOSEOUT_CONTINUE_TO_SOP17';
  const supported=p.authorization==='SYNTHETIC_ACCEPTANCE_10_6H_REAL_LISTING_CLOSEOUT'||continuation;
  const hasDeadline=p.expires_at!=null;
  if (!supported || p.sku !== sku || p.runtime_instance !== 'ACCEPTANCE_4181'
    || path.resolve(p.data_root) !== path.resolve(dataRoot) || p.degraded_ai_mode !== true
    || !Number.isFinite(Date.parse(p.started_at)) || (!continuation&&!hasDeadline)
    || (hasDeadline&&(!Number.isFinite(Date.parse(p.expires_at)) || Date.parse(p.expires_at) <= Date.parse(p.started_at)
      || Date.parse(p.expires_at) - Date.parse(p.started_at) > 6 * 3600000))
    || (continuation&&(p.completion_target!=='LISTING_SOP_17'||JSON.stringify(p.authorized_steps)!==JSON.stringify(['LISTING_SOP_14','LISTING_SOP_15','LISTING_SOP_16','LISTING_SOP_17'])||!p.authorized_steps.includes(step)))
    || !/^[a-zA-Z0-9_-]+$/.test(p.run_id || '')) return {status:'INVALID',policy:null};
  const policy={ ...p, authorization_ref: policyRef };
  return {status:now < Date.parse(p.started_at)?'NOT_STARTED':hasDeadline&&now >= Date.parse(p.expires_at)?'EXPIRED':'ACTIVE',policy};
}
export async function readAcceptanceCloseout(dataRoot, sku, step) {
  const window=await acceptanceCloseoutWindow(dataRoot,sku,step);
  return window.status==='ACTIVE'?window.policy:null;
}
const claimRef = (p, step, provider, identity) => {
  const replacement=p.request_contract_replacements?.[`${step}-${provider}`];
  const suffix=step==='LISTING_SOP_17' && replacement?.reason==='DETERMINISTIC_FINAL_QA_PACK_REPLACES_HTTP400_REQUEST'
    && replacement.allowed_calls===1 && /^[a-f0-9]{64}$/.test(replacement.new_generation_key||'')
    && replacement.new_generation_key===identity?.generation_key ? `-contract-${replacement.new_generation_key.slice(0,20)}` : '';
  return `integrations/listing-acceptance-closeout/${p.run_id}/${step}-${provider}${suffix}.json`;
};
export async function readAcceptanceCall(dataRoot, identity, {allowExpired=false} = {}) {
  const window=await acceptanceCloseoutWindow(dataRoot,identity?.sku,identity?.step);
  const p=window.status==='ACTIVE'||(allowExpired&&window.status==='EXPIRED')?window.policy:null;
  if (!p || !['Qwen','DeepSeek'].includes(identity.provider)) return null;
  try { const record = JSON.parse(await fs.readFile(path.join(dataRoot, claimRef(p, identity.step, identity.provider, identity)), 'utf8'));
    return { ...record, identity_matches: record.generation_key === identity.generation_key };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function acceptanceControlledRetry(dataRoot, identity) {
  const p = await readAcceptanceCloseout(dataRoot, identity?.sku, identity?.step);
  if (!p || identity.step !== 'LISTING_SOP_12' || identity.provider !== 'Qwen' || identity.generation_key !== p.sop12_qwen_generation_key) return false;
  const call = await readAcceptanceCall(dataRoot, identity);
  if (call) return false;
  const state = JSON.parse(await fs.readFile(path.join(dataRoot, 'integrations/ai-generation-recovery/state.json'), 'utf8'));
  const row = state.partial_results[identity.generation_key];
  return JSON.stringify(row?.identity) === JSON.stringify(identity) && ['TIMEOUT','RUNNING'].includes(row?.status)
    && row.attempts?.filter(a=>a.status !== 'RUNNING').at(-1)?.generation_failed_at === p.sop12_qwen_failure_barrier;
}
export async function claimAcceptanceCall(dataRoot, identity) {
  const p = await readAcceptanceCloseout(dataRoot, identity?.sku, identity?.step);
  if (!p) return null;
  if (!['Qwen','DeepSeek'].includes(identity.provider)) throw codeError('ACCEPTANCE_GPT_FORBIDDEN');
  const ref = claimRef(p, identity.step, identity.provider, identity);
  const record = { authorization_ref: policyRef, run_id: p.run_id, generation_key: identity.generation_key,
    sku: identity.sku, step: identity.step, provider: identity.provider, state: 'CLAIMED', started_at: new Date().toISOString(), evidence_ref: ref };
  await fs.mkdir(path.dirname(path.join(dataRoot, ref)), { recursive: true });
  try { await fs.writeFile(path.join(dataRoot, ref), JSON.stringify(record), { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') throw codeError('ACCEPTANCE_SINGLE_CALL_ALREADY_CLAIMED'); throw e; }
  return record;
}
export async function finishAcceptanceCall(dataRoot, identity, result) {
  // A call admitted before expiry must still persist its terminal evidence after expiry.
  const record = await readAcceptanceCall(dataRoot, identity, {allowExpired:true});
  if (!record?.identity_matches || record.state !== 'CLAIMED') throw codeError('ACCEPTANCE_CALL_CLAIM_MISMATCH');
  const { content, structured_response, ...safeResult } = result;
  const file = path.join(dataRoot, record.evidence_ref);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...record, state: 'COMPLETED', finished_at: new Date().toISOString(), result: safeResult }), { flag: 'wx' });
  await fs.rename(temp, file);
}
export async function acceptanceFailureResult(dataRoot, identity) {
  const r = await readAcceptanceCall(dataRoot, identity);
  return r?.identity_matches && r.state === 'COMPLETED' && r.result?.status === 'ERROR' && r.result?.request_id
    ? { ...r.result, acceptance_failure_evidence_ref: r.evidence_ref } : null;
}
