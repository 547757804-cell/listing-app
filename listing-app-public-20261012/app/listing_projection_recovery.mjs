import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {DatabaseSync}from'node:sqlite';import{writeAtomicJson}from'./atomic_json.mjs';
const demand=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
/** Restore derived files only from a proven SQLite commit. Does not run any Executor or modify business payload/revision. */
export async function recoverFinalListingProjection({dataRoot,sku,expectedRevision,runtime}){
 demand(runtime?.instance==='ACCEPTANCE_4181'&&runtime.acceptance_hold===true&&runtime.runtime_mode==='NORMAL','PROJECTION_RECOVERY_HOLD_REQUIRED');
 demand(path.resolve(runtime.data_root)===path.resolve(dataRoot),'PROJECTION_RECOVERY_ROOT_MISMATCH');
 const db=new DatabaseSync(path.join(dataRoot,'bol.sqlite3'));db.exec('BEGIN IMMEDIATE');
 try{
  const row=db.prepare('SELECT payload FROM products WHERE sku=?').get(sku);demand(row,'PROJECTION_TASK_MISSING');const task=JSON.parse(row.payload);
  demand(task.revision===expectedRevision,'PROJECTION_REVISION_CAS');
  demand(task.status==='PAUSED'&&task.current_step==='LISTING_SOP_17'&&task.last_success_step==='LISTING_SOP_17'&&task.resume_point==='await_upload'&&task.open_error_count===0,'PROJECTION_FINAL_STATE_INVALID');
  demand(task.qa.LISTING_SOP_17.status==='PASS'&&task.acceptance_stop_gate?.stopped_after_step==='LISTING_SOP_17','PROJECTION_FINAL_QA_REQUIRED');
  demand(db.prepare("SELECT COUNT(*) n FROM listing_execution_leases WHERE sku_id=? AND state='RUNNING'").get(sku).n===0,'PROJECTION_ACTIVE_LEASE');
  const output=task.outputs.final_qa;const artifactPath=path.resolve(dataRoot,output.evidence.artifact_ref);demand(artifactPath.startsWith(path.resolve(dataRoot)+path.sep),'PROJECTION_ARTIFACT_PATH');
  const artifact=JSON.parse(await fs.readFile(artifactPath,'utf8'));const qa=JSON.parse(await fs.readFile(path.resolve(dataRoot,output.evidence.qa_ref),'utf8'));
  demand(artifact.version===output.version&&artifact.sku===sku&&artifact.qa_status==='PASS'&&qa.version===output.version&&qa.status==='PASS'&&qa.checks.every(c=>c.pass),'PROJECTION_ARTIFACT_QA_MISMATCH');
  const committed=db.prepare("SELECT event_id,details FROM task_events WHERE sku=? AND type='LISTING_CACHED_STAGE_QA_RECOVERED' ORDER BY at DESC LIMIT 1").get(sku);
  demand(committed&&JSON.parse(committed.details).version===output.version,'PROJECTION_COMMIT_NOT_PROVEN');
  const mirrorFile=path.join(dataRoot,'products',`${sku}.json`);const prior=await fs.readFile(mirrorFile);const old=JSON.parse(prior);
  demand(old.revision<=task.revision,'PROJECTION_MIRROR_NEWER_THAN_DB');
  const auditRef=`reports/PROJECTION-RECOVERY-${sku}-${task.revision}.json`;const now=new Date().toISOString();
  const report={recovery_kind:'COMMITTED_SQLITE_PROJECTION_REPAIR',at:now,sku,revision:task.revision,version:output.version,source_event:committed.event_id,
   prior_mirror_revision:old.revision,prior_mirror_sha256:crypto.createHash('sha256').update(prior).digest('hex'),business_payload_unchanged:true,provider_requests:0,executor_runs:0,
   lease_history_preserved:true,reason:'Post-commit task mirror rename failed; SQLite payload and formal artifact had already passed QA.'};
  try{const saved=JSON.parse(await fs.readFile(path.join(dataRoot,auditRef),'utf8'));demand(saved.revision===task.revision&&saved.version===output.version,'PROJECTION_AUDIT_CONFLICT');}
  catch(e){if(e.code!=='ENOENT')throw e;await writeAtomicJson(path.join(dataRoot,auditRef),report);}
  await writeAtomicJson(mirrorFile,task);
  await writeAtomicJson(path.join(dataRoot,'versions',task.id,`${String(task.revision).padStart(6,'0')}.json`),{version:task.revision,at:task.updated_at,snapshot:task});
  const events=[];for(const type of['TASK_PROJECTION_RECOVERED','ACCEPTANCE_STOP_AFTER_STEP']){
   const id=`${type}:${sku}:${task.revision}`;
   if(!db.prepare('SELECT event_id FROM task_events WHERE event_id=?').get(id)){
    const event={event_id:id,at:now,sku,type,current_step:task.current_step,pool:task.activity_pool,details:{step:'LISTING_SOP_17',version:output.version,resume_point:'await_upload',next_sop_started:false,audit_ref:auditRef,projection_recovery:true}};
    db.prepare('INSERT INTO task_events (event_id,at,sku,type,current_step,pool,details) VALUES (?,?,?,?,?,?,?)').run(id,now,sku,type,task.current_step,task.activity_pool,JSON.stringify(event.details));events.push(event);
   }
  }
  db.exec('COMMIT');
  for(const event of events)await fs.appendFile(path.join(dataRoot,'events/tasks.jsonl'),JSON.stringify(event)+'\n');
  return{...report,audit_ref:auditRef,status:'PASS'};
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
