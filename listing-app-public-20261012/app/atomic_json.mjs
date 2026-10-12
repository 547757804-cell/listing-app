import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export async function renameWithTransientRetry(from,to,{rename=fs.rename,wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=6}={}){
  for(let n=0;;n++)try{return await rename(from,to);}catch(e){
    if(!['EPERM','EBUSY','EACCES'].includes(e.code)||n>=attempts-1)throw e;
    await wait(50*(n+1));
  }
}
export async function writeAtomicJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle=await fs.open(temp,'wx');try{await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,'utf8');await handle.sync();}finally{await handle.close();}
  // Never delete the old target to work around a persistent access failure.
  await renameWithTransientRetry(temp,file);
}
