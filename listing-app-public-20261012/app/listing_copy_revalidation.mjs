import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import{resolveSop10To17Inputs,qaSop10To17Output,sop10To17OutputKey}from'./listing_sop10_17_executor.mjs';
import{applyListingOutputAmendment}from'./listing_output_amendment.mjs';
const bytes=x=>`${JSON.stringify(x)}\n`,hash=x=>crypto.createHash('sha256').update(x).digest('hex');
/** Revalidate persisted real AI output after an explicitly audited local copy correction. No adapter access. */
export async function buildListingCopyRevision(dataRoot,task,step,plan){
  if(!['LISTING_SOP_15','LISTING_SOP_16'].includes(step)||task.sku!=='SYNTHETIC-SKU-LEGACY-10')throw Error('COPY_REVALIDATION_SCOPE');
  const key=sop10To17OutputKey(step),prior=task.outputs[key];
  if(prior?.execution_kind!=='REAL_PROVIDER'||!prior.ai_model_provenance?.providers?.length)throw Error('REAL_PROVIDER_RESULT_REQUIRED');
  const inputs=await resolveSop10To17Inputs(dataRoot,task,step);
  const {version,evidence,status,qa_status,output_key,open_error_count,evidence_reference_index,...source}=prior;
  let output=applyListingOutputAmendment(source,inputs,plan);
  output={...output,input_version_refs:inputs.input_version_refs,provider_input_version_refs:prior.provider_input_version_refs||prior.input_version_refs,
    revalidation_kind:'LOCAL_COPY_EVIDENCE_REVALIDATION',revalidated_at:plan.reviewed_at,
    supersedes_version:prior.version||null,source_output_sha256:hash(bytes(prior)),generated_at:prior.generated_at};
  const qa=qaSop10To17Output(step,output,inputs,task);if(qa.status!=='PASS')throw Object.assign(Error('COPY_REVALIDATION_QA_FAILED'),{failures:qa.failures});
  const nextVersion=`${step.replace('LISTING_SOP_','')}-${hash(bytes({step,inputs:inputs.input_version_refs,output})).slice(0,20)}`;
  const formalVersion=`SOP${nextVersion}`;const dir=`artifacts/listing/${task.sku}/${step.toLowerCase()}/${formalVersion}`;
  output={...output,version:formalVersion,status:'PASS',qa_status:'PASS'};
  output.evidence={version:formalVersion,artifact_ref:`${dir}/result.json`,qa_ref:`${dir}/qa.json`,evidence_refs:inputs.evidence_refs,source_references:inputs.input_version_refs,sha256:hash(bytes(output)),ai_provider_requests:0,bol_amazon_external_requests:0,external_requests:0};
  return{step,key,version:formalVersion,output:{...output,output_key:key,open_error_count:0},qa:{...qa,version:formalVersion,evidence_ref:output.evidence.qa_ref},prior,inputs,dir};
}
export async function persistListingCopyRevision(dataRoot,result){
  const dir=path.resolve(dataRoot,result.dir);if(!dir.startsWith(path.resolve(dataRoot)+path.sep))throw Error('COPY_REF_OUTSIDE_ROOT');
  await fs.mkdir(dir,{recursive:true});
  for(const[name,value]of Object.entries({'result.json':result.output,'qa.json':result.qa,'prior-output.json':result.prior})){
    const file=path.join(dir,name),content=bytes(value);
    try{await fs.writeFile(file,content,{flag:'wx'});}catch(error){
      if(error.code!=='EEXIST'||await fs.readFile(file,'utf8')!==content)throw error;
    }
  }
}
