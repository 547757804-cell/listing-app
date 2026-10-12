import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTask, submitBolooProviderResult } from './bol_core.mjs';
import { parseDisplayedVolume } from './boloo_volume_format.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE_ROOT = path.join(PROJECT_ROOT, 'BOL数据', '验收E2E');
const FORMAL_DATA_ROOT = path.join(PROJECT_ROOT, 'BOL数据');
const SHARED_PANE_BRIDGE_ROOT = path.join(FORMAL_DATA_ROOT, 'integrations', 'boloo-pane-bridge');
const PANE_BRIDGE_REQUEST_SCHEMA = 'boloo.pane.bridge-request.v1';
export const DEFAULT_BOLOO_PANE_REQUEST_TIMEOUT_MS = 135_000;
const EXPLORER_FIELD = 'Gemiddeld zoekvolume per maand';
const EXPLORER_URL = 'https://app.boloo.co/research/explorer/';
const EXTRACTOR_URL = 'https://app.boloo.co/ai/keyword-extractor/';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeChild(root, child) {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(child);
  if (!resolvedChild.toLowerCase().startsWith(`${resolvedRoot}${path.sep}`.toLowerCase())) {
    throw new Error('Boloo Web Provider test paths must remain inside the isolated acceptance directory.');
  }
  return resolvedChild;
}

function sameWindowsPath(left, right) {
  return path.resolve(left).normalize('NFC').toLowerCase() === path.resolve(right).normalize('NFC').toLowerCase();
}

export function resolveBolooPaneBridgePaths({ dataRoot, requestId }) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(requestId || ''))) throw new TypeError('A valid Pane request id is required.');
  const resolvedDataRoot = path.resolve(dataRoot || '');
  if (!resolvedDataRoot.toLowerCase().startsWith(`${ACCEPTANCE_ROOT}${path.sep}`.toLowerCase())) {
    throw new Error('Pane data root must be inside the isolated acceptance directory.');
  }
  const requestPath = path.join(SHARED_PANE_BRIDGE_ROOT, 'inbox', `pane-${requestId}.json`);
  const responsePath = path.join(resolvedDataRoot, 'integrations', 'boloo-pane', 'outbox', `response-${requestId}.json`);
  if (!responsePath.toLowerCase().startsWith(`${resolvedDataRoot}${path.sep}`.toLowerCase())) throw new Error('Pane response path escaped the SKU data root.');
  return { requestPath, responsePath, inboxPath: path.dirname(requestPath), outboxPath: path.dirname(responsePath) };
}

export function buildBolooPaneBridgeRequest({ dataRoot, requestId, responsePath, operation, attempt, script, url }) {
  const paths = resolveBolooPaneBridgePaths({ dataRoot, requestId });
  if (!sameWindowsPath(responsePath, paths.responsePath)) throw new Error('Pane response path must match the request-scoped SKU outbox path.');
  if (!['navigate', 'keyword_explorer', 'keyword_extractor'].includes(operation)) throw new TypeError('Unsupported Pane bridge operation.');
  if (!Number.isInteger(Number(attempt)) || Number(attempt) < 1) throw new TypeError('Pane bridge attempt must be a positive integer.');
  const request = {
    schema: PANE_BRIDGE_REQUEST_SCHEMA,
    request_id: requestId,
    data_root: path.resolve(dataRoot),
    response_path: paths.responsePath,
    operation,
    attempt: Number(attempt),
  };
  if (operation === 'navigate') {
    const target = new URL(String(url || ''));
    if (target.protocol !== 'https:' || target.hostname.toLowerCase() !== 'app.boloo.co') throw new Error('Pane navigation is restricted to https://app.boloo.co.');
    request.url = target.href;
  } else {
    if (typeof script !== 'string' || script.length === 0 || script.length > 200_000) throw new TypeError('Pane script is missing or exceeds the request limit.');
    request.script = script;
  }
  return request;
}

function featureScript(operation, queryText) {
  const query = JSON.stringify(queryText);
  return `(async()=>{
const wanted=${JSON.stringify(operation)}, query=${query};
const EXPLORER_FIELD='Gemiddeld zoekvolume per maand';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};
const text=e=>(e?.innerText||e?.textContent||'').replace(/\\s+/g,' ').trim();
const meta=e=>[e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('name'),e.id,e.labels?[...e.labels].map(text).join(' '):''].filter(Boolean).join(' ').toLowerCase();
const errorPage=()=>/ERR_(?:CONNECTION|NAME|INTERNET|NETWORK)|this site can.t be reached|webpagina is niet beschikbaar/i.test((document.body?.innerText||'').slice(0,5000));
const loginExpired=()=>/\\/(?:login|signin|sign-in)(?:[/?#]|$)/i.test(location.href)||[...document.querySelectorAll('input[type=password]')].some(vis);
const fail=(reason,stage,extra={})=>({status:'ERROR',reason_code:reason,stage,page_url:location.href,title:document.title,error_page:errorPage(),login_expired:loginExpired(),...extra});
if(location.hostname!=='app.boloo.co')return fail('NAVIGATION_FAILED','origin',{reason:'当前不是 Boloo 官方应用域名。'});
if(errorPage())return fail('NETWORK_FAILED','document',{reason:'浏览器页面显示网络错误。'});
if(loginExpired())return fail('LOGIN_EXPIRED','login',{reason:'Boloo 登录已失效。'});

const featureRe=wanted==='keyword_explorer'?/keyword\\s*(?:explorer|verkenner)/i:/keyword\\s*extractor/i;
const urlRe=wanted==='keyword_explorer'?/\\/research\\/explorer(?:[/?#]|$)|keyword[-_/]?(?:explorer|verkenner)/i:/keyword[-_/]?extractor/i;
const isFeature=()=>urlRe.test(location.href)||[...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')].filter(vis).some(e=>featureRe.test(text(e)));
const visibleControls=()=>[...document.querySelectorAll('a,button,[role=button],[role=menuitem]')].filter(vis);
const visibleActions=()=>[...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(vis).filter(e=>!e.disabled);
const actionLabel=e=>text(e)||e.value||e.getAttribute('aria-label')||e.title||'';
const scopedActions=(field,pattern,exactLabels=[])=>{
  const candidates=visibleActions().filter(e=>pattern.test(actionLabel(e))&&!/⌘|ctrl\\s*\\+|keyboard shortcut/i.test(actionLabel(e)));
  const form=field.form;
  if(form){const inForm=candidates.filter(e=>form.contains(e));if(inForm.length)return inForm;}
  for(let parent=field.parentElement,depth=0;parent&&depth<7;parent=parent.parentElement,depth++){
    const inSection=candidates.filter(e=>parent.contains(e));
    const exact=inSection.filter(e=>exactLabels.includes(actionLabel(e).replace(/\s+/g,' ').trim().toLowerCase()));
    if(exact.length===1)return exact;
    if(inSection.length===1)return inSection;
  }
  const exact=candidates.filter(e=>exactLabels.includes(actionLabel(e).replace(/\s+/g,' ').trim().toLowerCase()));
  return exact.length?exact:candidates;
};
const navEvidence=[];
for(let pass=0;pass<8&&!isFeature();pass++){
  const controls=visibleControls();
  const target=controls.find(e=>{
    const href=e.getAttribute('href')||'';
    if(wanted==='keyword_explorer'&&/\\/research\\/explorer\\/?$/i.test(href))return true;
    return featureRe.test(text(e)+' '+href+' '+(e.getAttribute('aria-label')||'')+' '+(e.title||''));
  });
  if(target){navEvidence.push({text:text(target),href:target.getAttribute('href')||'',tag:target.tagName});target.click();await sleep(700);continue;}
  const parent=controls.find(e=>/product research|research tools|keyword research|onderzoek/i.test(text(e)+' '+(e.getAttribute('aria-label')||''))&&!/keyword\\s*explorer|keyword\\s*extractor/i.test(text(e)));
  if(parent&&pass<2){navEvidence.push({text:text(parent),href:parent.getAttribute('href')||'',tag:parent.tagName});parent.click();await sleep(350);continue;}
  await sleep(350);
}
if(!isFeature())return fail('NAVIGATION_FAILED','feature-navigation',{reason:'在可见 Boloo 导航 DOM 中未能自动打开所需功能页。',navigation_candidates:visibleControls().map(e=>({text:text(e).slice(0,120),href:e.getAttribute('href')||'',tag:e.tagName})).slice(0,100),navigation_actions:navEvidence});
if(loginExpired())return fail('LOGIN_EXPIRED','login');

if(wanted==='keyword_explorer'){
  const fields=[...document.querySelectorAll('input:not([type=hidden]),textarea,[role=combobox]')].filter(vis).filter(e=>/(keyword|zoekwoord|zoek|search|term)/i.test(meta(e)));
  if(fields.length!==1)return fail('DOM_FIELD_MISSING','explorer-input',{candidate_count:fields.length,candidates:fields.map(e=>({tag:e.tagName,meta:meta(e)}))});
  const field=fields[0],proto=Object.getPrototypeOf(field),setter=Object.getOwnPropertyDescriptor(proto,'value');
  if(setter?.set)setter.set.call(field,query);else field.value=query;
  field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));field.dispatchEvent(new Event('keyup',{bubbles:true}));
  if(field.value!==query)return fail('INPUT_RESULT_MISMATCH','explorer-fill',{matched_query:field.value,expected_query:query,field_meta:meta(field)});
  const buttons=scopedActions(field,/(search|zoek|explore|find|generate|analyse|analyze)/i,['zoeken','search']);
  if(buttons.length!==1)return fail('DOM_FIELD_MISSING','explorer-submit',{candidate_count:buttons.length,candidates:buttons.map(e=>({tag:e.tagName,text:actionLabel(e).slice(0,100),type:e.type||'',in_form:!!field.form&&field.form.contains(e)})),input_filled:true,field_form:!!field.form});
  buttons[0].click();
  let prior='',stable=0,body='',resultCard=null,valueNode=null;const until=Date.now()+45000;
  while(Date.now()<until){
    await sleep(500);body=document.body?.innerText||'';
    const current=location.href+'\\n'+body.slice(-12000);if(current===prior)stable++;else stable=0;prior=current;
    resultCard=[...document.querySelectorAll('.ant-card')].filter(vis).find(card=>[...card.querySelectorAll('.ant-card-head-title')].some(title=>text(title).toLowerCase()===EXPLORER_FIELD.toLowerCase()))||null;
    valueNode=resultCard?.querySelector('.ant-statistic-content-value')||null;
    if(stable>=2&&resultCard&&!resultCard.querySelector('.ant-skeleton')&&valueNode&&text(valueNode))break;
  }
  if(errorPage())return fail('NETWORK_FAILED','explorer-result');
  if(loginExpired())return fail('LOGIN_EXPIRED','login');
  const pageQuery=new URL(location.href).searchParams.get('keyword');
  if(field.value!==query||pageQuery!==query)return fail('INPUT_RESULT_MISMATCH','explorer-match',{matched_query:pageQuery,expected_query:query,input_value:field.value,visible_text:body.slice(-12000)});
  if(!resultCard||resultCard.querySelector('.ant-skeleton')||!valueNode)return fail('DOM_FIELD_MISSING','explorer-volume',{query_input:field.value,field_name:EXPLORER_FIELD,visible_text:body.slice(-12000),result_card_html:(resultCard?.outerHTML||'').slice(0,12000)});
  const rowText=text(resultCard),displayed=text(valueNode);
  if(!displayed)return fail('DOM_FIELD_MISSING','explorer-volume-value',{row_text:rowText.slice(0,1500),field_name:EXPLORER_FIELD,matched_query:query});
  return {status:'RESULT_FOUND',page_url:location.href,matched_query:pageQuery,field_name:EXPLORER_FIELD,displayed_value:displayed,observed_at_utc:new Date().toISOString(),input_value:field.value,result_text:rowText,dom_evidence:{title:document.title,result_text:rowText,result_html:(resultCard.outerHTML||'').slice(0,16000),input_meta:meta(field),input_value:field.value,page_query:pageQuery,navigation_actions:navEvidence}};
}

const fields=[...document.querySelectorAll('input:not([type=hidden]),textarea,[role=combobox]')].filter(vis).filter(e=>/(url|link|product|bol\\.com|ean)/i.test(meta(e)));
if(fields.length!==1)return fail('DOM_FIELD_MISSING','extractor-url-input',{candidate_count:fields.length,candidates:fields.map(e=>({tag:e.tagName,meta:meta(e)}))});
const field=fields[0],proto=Object.getPrototypeOf(field),setter=Object.getOwnPropertyDescriptor(proto,'value');
if(setter?.set)setter.set.call(field,query);else field.value=query;
field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));field.dispatchEvent(new Event('keyup',{bubbles:true}));
if(field.value!==query)return fail('INPUT_RESULT_MISMATCH','extractor-fill',{matched_query:field.value,expected_query:query,field_meta:meta(field)});
const buttons=scopedActions(field,/(extract|import|parse|scan|analyse|analyze|zoekwoorden|ophalen)/i,['zoekwoorden ophalen','zoekwoorden extracten','extract keywords','ophalen']);
if(buttons.length!==1)return fail('DOM_FIELD_MISSING','extractor-submit',{candidate_count:buttons.length,candidates:buttons.map(e=>({tag:e.tagName,text:actionLabel(e).slice(0,100),type:e.type||'',in_form:!!field.form&&field.form.contains(e)})),input_filled:true,field_form:!!field.form});
buttons[0].click();
let prior='',stable=0,body='',busySeen=false;const minStableAt=Date.now()+5000,until=Date.now()+45000;
const isBusy=()=>[...document.querySelectorAll('[aria-busy=true],.ant-spin-spinning,.ant-skeleton')].some(vis)||[...document.querySelectorAll('button[type=submit]')].some(e=>vis(e)&&e.disabled);
while(Date.now()<until){await sleep(500);body=document.body?.innerText||'';const current=location.href+'\\n'+body.slice(-16000);if(current===prior)stable++;else stable=0;prior=current;if(isBusy())busySeen=true;if(Date.now()>=minStableAt&&stable>=2&&!isBusy())break;}
if(errorPage())return fail('NETWORK_FAILED','extractor-result');
if(loginExpired())return fail('LOGIN_EXPIRED','login');
const visibleText=body.slice(-16000);
if(isBusy())return fail('NETWORK_FAILED','extractor-result',{reason:'Keyword Extractor bleef na提交保持加载状态。',busy_seen:busySeen,visible_text:visibleText});
const promptMatch=visibleText.match(/[^\\n]{0,100}we konden geen zoekwoorden[^\\n]{0,240}(?:probeer het opnieuw)?[^\\n]{0,100}/i);
const explicitPrompt=!!promptMatch&&/probeer het opnieuw/i.test(promptMatch[0]);
if(explicitPrompt){
  if(field.value!==query)return fail('INPUT_RESULT_MISMATCH','extractor-match',{matched_query:field.value,expected_query:query,visible_text:visibleText});
  const prompt=promptMatch[0].trim();
  const emptyList=document.querySelector('.keyword-extractor-list');
  return {status:'NO_RESULT',reason_code:'EXTRACTOR_NO_KEYWORDS',page_url:location.href,matched_query:field.value,input_value:field.value,field_name:'Keyword Extractor · Keywords',displayed_value:prompt,observed_at_utc:new Date().toISOString(),no_result_confirmed:true,dom_evidence:{title:document.title,visible_text:visibleText,prompt,count_text:'',empty_text:emptyList?text(emptyList.querySelector('.ant-list-empty-text')):'',result_html:(emptyList?.outerHTML||'').slice(0,20000),input_value:field.value,busy_seen:busySeen,navigation_actions:navEvidence}};
}
const resultList=document.querySelector('.keyword-extractor-list');
if(!resultList)return fail('DOM_FIELD_MISSING','extractor-results-list',{visible_text:visibleText,matched_query:field.value});
const countText=text(resultList.querySelector('.keyword-extractor-list-subtitle'));
const emptyNode=resultList.querySelector('.ant-list-empty-text');
const emptyText=text(emptyNode);
const visibleEmpty=/geen (?:keywords|zoekwoorden) gevonden/i.test(emptyText)&&/\\b0\\s+(?:termen|keywords?|zoekwoorden) gevonden\\b/i.test(countText);
if(explicitPrompt||visibleEmpty){const prompt=(promptMatch?.[0]||(countText+' · '+emptyText)).trim();return {status:'NO_RESULT',reason_code:'EXTRACTOR_NO_KEYWORDS',page_url:location.href,matched_query:field.value,input_value:field.value,field_name:'Keyword Extractor · Keywords',displayed_value:prompt,observed_at_utc:new Date().toISOString(),no_result_confirmed:true,dom_evidence:{title:document.title,visible_text:visibleText,prompt,count_text:countText,empty_text:emptyText,result_html:(resultList.outerHTML||'').slice(0,20000),input_value:field.value,busy_seen:busySeen,navigation_actions:navEvidence}};}
const rowNodes=[...resultList.querySelectorAll('.ant-list-item,[role=row]')].filter(vis).map(e=>({element:e,text:text(e),leaf_texts:[...e.querySelectorAll('span,div')].filter(n=>n.children.length===0&&vis(n)).map(text).filter(Boolean)})).filter(x=>x.text&&x.text.length<1200);
const keywords=[];
for(const row of rowNodes){
  const labelNode=row.element.querySelector('.keyword-extractor-keyword-label');
  const volumeNode=row.element.querySelector('.keyword-extractor-keyword-volume');
  const rankNode=row.element.querySelector('.keyword-extractor-keyword-rank');
  const values=row.leaf_texts.filter(value=>!/^(keyword|zoekwoord|zoekwoorden|keywords|trend|positie)$/i.test(value));
  const candidate=text(labelNode)||(values.find(value=>!/^\\d[\\d.,\\s]*$/.test(value))||'');
  if(!candidate)continue;
  const metric=text(volumeNode)||(values.slice(values.indexOf(candidate)+1).find(value=>/\\d/.test(value))||'');
  keywords.push({keyword:candidate,displayed_volume:metric||null,rank:text(rankNode)||null,row_text:row.text});
}
if(!keywords.length)return fail('DOM_FIELD_MISSING','extractor-keywords',{page_text:visibleText,result_html:(resultList.outerHTML||'').slice(0,20000),count_text:countText,empty_text:emptyText,query_input:field.value});
const resultText=keywords.map(item=>item.row_text).join('\\n');
if(field.value!==query)return fail('INPUT_RESULT_MISMATCH','extractor-match',{matched_query:field.value,expected_query:query,result_text:resultText});
return {status:'KEYWORDS_FOUND',reason_code:'KEYWORDS_FOUND',page_url:location.href,matched_query:query,field_name:'Keyword Extractor results',displayed_value:resultText,observed_at_utc:new Date().toISOString(),input_value:field.value,keywords,dom_evidence:{title:document.title,count_text:countText,rows:keywords,result_html:(resultList.outerHTML||'').slice(0,20000),input_value:field.value,busy_seen:busySeen,navigation_actions:navEvidence}};
})()`;
}

function normalizeError(error) {
  const message = String(error?.message || error || 'Unknown Boloo Provider failure').slice(0, 500);
  const code = String(error?.code || '');
  const reasonCode = ['BOLOO_WEBVIEW2_BRIDGE_TIMEOUT', 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', 'BOLOO_WEBVIEW2_BRIDGE_NOT_READY'].includes(code)
    ? code : 'UNKNOWN_PROVIDER_ERROR';
  return { status: 'ERROR', reason_code: reasonCode, error_code: code || null, error: message, request_id: error?.request_id || null };
}

export class BolooWebProvider {
  constructor({ dataRoot, bridgeDir, evidenceDir, requestTimeoutMs = DEFAULT_BOLOO_PANE_REQUEST_TIMEOUT_MS, clock = () => new Date() } = {}) {
    if (!dataRoot || !bridgeDir || !evidenceDir) throw new TypeError('dataRoot, bridgeDir, and evidenceDir are required.');
    this.dataRoot = path.resolve(dataRoot);
    this.taskBridgeDir = safeChild(this.dataRoot, bridgeDir);
    this.evidenceDir = safeChild(this.dataRoot, evidenceDir);
    if (!this.dataRoot.toLowerCase().startsWith(`${ACCEPTANCE_ROOT}${path.sep}`.toLowerCase())) throw new Error('E2E runs must use an isolated BOL数据\\验收E2E dataRoot.');
    this.requestTimeoutMs = requestTimeoutMs;
    this.clock = clock;
  }

  async #assertPaneTaskContext() {
    const rootInfo = await fs.lstat(this.dataRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Object.assign(new Error('Acceptance task root is missing or redirected.'), { code: 'BOLOO_PANE_TASK_CONTEXT_INVALID' });
    const markerPath = path.join(this.dataRoot, 'run', 'runtime-instance.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (marker.schema !== 'bol.runtime.instance.v1' || marker.instance_key !== 'ACCEPTANCE_4181'
      || !sameWindowsPath(marker.data_root, this.dataRoot)) {
      throw Object.assign(new Error('Acceptance task runtime marker does not match the Pane request data root.'), { code: 'BOLOO_PANE_TASK_CONTEXT_INVALID' });
    }
    const inbox = await fs.stat(path.join(SHARED_PANE_BRIDGE_ROOT, 'inbox')).catch(() => null);
    if (!inbox?.isDirectory()) throw Object.assign(new Error('Shared Boloo Pane inbox is not initialized.'), { code: 'BOLOO_WEBVIEW2_BRIDGE_NOT_READY' });
  }

  async #sendPaneRequest({ requestId = crypto.randomUUID(), operation, attempt, script, url }) {
    await this.#assertPaneTaskContext();
    const paths = resolveBolooPaneBridgePaths({ dataRoot: this.dataRoot, requestId });
    await fs.mkdir(paths.outboxPath, { recursive: true });
    const request = buildBolooPaneBridgeRequest({ dataRoot: this.dataRoot, requestId, responsePath: paths.responsePath, operation, attempt, script, url });
    const temporary = `${paths.requestPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, paths.requestPath);
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await fs.readFile(paths.responsePath, 'utf8'));
        if (response.request_id !== requestId || !response.result || typeof response.result !== 'object') {
          throw Object.assign(new Error('WebView2 Pane response did not match the request id or result contract.'), { code: 'BOLOO_WEBVIEW2_BRIDGE_RESPONSE_INVALID', request_id: requestId });
        }
        await fs.rm(paths.responsePath, { force: true });
        return response.result;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(200);
    }
    // If the Pane has not claimed this request, remove it so a late restart
    // cannot execute an already timed-out business query a second time.
    await fs.rm(paths.requestPath, { force: true }).catch(() => {});
    throw Object.assign(new Error('Timed out waiting for a response from the shared Boloo WebView2 Pane.'), {
      code: 'BOLOO_WEBVIEW2_BRIDGE_TIMEOUT', request_id: requestId,
    });
  }

  async #requestDom(operation, queryText, attempt) {
    const script = featureScript(operation, queryText);
    return this.#sendPaneRequest({ operation, attempt, script });
  }

  async #navigate(url) {
    const result = await this.#sendPaneRequest({ operation: 'navigate', attempt: 1, url });
    if (result.status === 'ERROR' && /Timed out waiting for Boloo NavigationCompleted/i.test(String(result.error || ''))) {
      return { ...result, reason_code: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT', error_code: 'BOLOO_WEBVIEW2_NAVIGATION_TIMEOUT' };
    }
    return result;
  }

  async #saveEvidence({ sku, requestId, operation, queryText, attempt, observedAtUtc, domEvidence, response }) {
    const directory = safeChild(this.evidenceDir, path.join(this.evidenceDir, sku));
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${operation}-${String(attempt).padStart(2, '0')}-${requestId}.json`);
    const record = { schema_version: 1, provider: 'BOL_AUTO_WEBVIEW2', operation, query_text: queryText, request_id: requestId, attempt, observed_at_utc: observedAtUtc, page_url: response.page_url || '', raw_response: response, dom_evidence: domEvidence || null };
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
    return { kind: 'RAW', reference: file };
  }

  async runCurrentSubtask(sku) {
    let task = await getTask(this.dataRoot, sku);
    if (!task || task.current_step !== 'boloo_keywords' || !['RUNNING', 'PENDING_RECHECK'].includes(task.status)) throw new Error('The isolated acceptance task is not waiting for a Boloo provider result.');
    const submitted = [];
    while (true) {
      task = await getTask(this.dataRoot, sku);
      const subtask = task?.boloo?.required_subtasks?.find(item => item.subtask_id === task.boloo.current_subtask_id);
      if (!subtask) break;
      const operation = subtask.provider_source === 'keyword_explorer' ? 'keyword_explorer' : subtask.provider_source === 'keyword_extractor' ? 'keyword_extractor' : null;
      if (!operation) throw new Error(`Unsupported Boloo provider source: ${subtask.provider_source}`);
      const nextAttempt = Number(subtask.attempt_count || 0) + 1;
      const requestId = crypto.randomUUID();
      let pageResult, navigationEvidence = null;
      try {
        if (operation === 'keyword_extractor') {
          const navigation = await this.#navigate(EXTRACTOR_URL);
          if (navigation.status !== 'NAVIGATION_COMPLETED') pageResult = navigation;
          else navigationEvidence = navigation.dom_evidence || null;
        } else if (operation === 'keyword_explorer') {
          const navigation = await this.#navigate(EXPLORER_URL);
          if (navigation.status !== 'NAVIGATION_COMPLETED') pageResult = navigation;
          else navigationEvidence = navigation.dom_evidence || null;
        }
        if (!pageResult) pageResult = await this.#requestDom(operation, subtask.query_text, nextAttempt);
        if (navigationEvidence && pageResult && typeof pageResult === 'object') pageResult.dom_evidence = { ...(pageResult.dom_evidence || {}), navigation: navigationEvidence };
      }
      catch (error) { pageResult = normalizeError(error); }
      const observedAtUtc = pageResult.observed_at_utc || this.clock().toISOString();
      const evidenceRef = await this.#saveEvidence({ sku, requestId, operation, queryText: subtask.query_text, attempt: nextAttempt, observedAtUtc, domEvidence: pageResult.dom_evidence, response: pageResult });
      let status = 'ERROR';
      let reasonCode = pageResult.reason_code || 'UNKNOWN_PROVIDER_ERROR';
      let result = null;
      let error = null;
      if (pageResult.status === 'RESULT_FOUND' && operation === 'keyword_explorer') {
        const volume = parseDisplayedVolume(pageResult.displayed_value);
        if (pageResult.matched_query !== subtask.query_text || pageResult.input_value !== subtask.query_text) { reasonCode = 'INPUT_RESULT_MISMATCH'; error = { message: '页面实际输入或结果查询词与请求 exact string 不匹配。' }; }
        else if (volume == null) { reasonCode = 'DOM_FIELD_MISSING'; error = { message: '页面搜索量字段无法解析为非负数值。' }; }
        else { status = 'PASS'; reasonCode = volume === 0 ? 'EXPLORER_ZERO_VOLUME' : 'RESULT_FOUND'; result = { search_volume: volume }; }
      } else if (pageResult.status === 'PASS_NO_RESULT' && operation === 'keyword_explorer' && pageResult.matched_query === subtask.query_text) {
        status = 'PASS_NO_RESULT'; reasonCode = 'EXPLORER_NO_RESULTS';
      } else if (pageResult.status === 'KEYWORDS_FOUND' && operation === 'keyword_extractor') {
        if (pageResult.matched_query !== subtask.query_text || pageResult.input_value !== subtask.query_text) { reasonCode = 'INPUT_RESULT_MISMATCH'; error = { message: 'Extractor 当前结果无法与本次测试 URL 精确匹配。' }; }
        else { status = 'PASS'; reasonCode = 'KEYWORDS_FOUND'; result = { keywords: pageResult.keywords }; }
      } else if (pageResult.status === 'NO_RESULT' && operation === 'keyword_extractor') {
        status = nextAttempt === 1 ? 'PENDING_RECHECK' : 'PASS_NO_RESULT';
        reasonCode = 'EXTRACTOR_NO_KEYWORDS';
        if (pageResult.matched_query !== subtask.query_text || pageResult.input_value !== subtask.query_text) { status = 'ERROR'; reasonCode = 'INPUT_RESULT_MISMATCH'; error = { message: 'Extractor 页面输入 URL 与本次请求不一致。' }; }
      } else if (pageResult.status === 'ERROR') {
        status = 'ERROR'; reasonCode = pageResult.reason_code || 'UNKNOWN_PROVIDER_ERROR'; error = { message: pageResult.error || pageResult.reason || 'Boloo 页面技术错误。' };
      } else {
        status = 'ERROR'; reasonCode = pageResult.reason_code || 'DOM_FIELD_MISSING'; error = { message: pageResult.error || 'Boloo 页面返回结构不符合 Provider 契约。' };
      }
      const observed = this.clock().toISOString();
      const providerResult = {
        schema_version: 1, provider: 'BOL_AUTO_WEBVIEW2', provider_source: subtask.provider_source,
        subtask_id: subtask.subtask_id, source_id: subtask.source_id, request_id: requestId,
        attempt: nextAttempt, status, reason_code: reasonCode, query_text: subtask.query_text,
        observed_at: observed,
        evidence: {
          page_url: pageResult.page_url || '', matched_query: pageResult.matched_query || subtask.query_text,
          field_name: pageResult.field_name || (operation === 'keyword_explorer' ? EXPLORER_FIELD : 'Keyword Extractor results'),
          displayed_value: String(pageResult.displayed_value ?? pageResult.error ?? ''), observed_at_utc: observedAtUtc,
          dom_evidence_ref: evidenceRef, dom_evidence: pageResult.dom_evidence || null,
          ...(pageResult.no_result_confirmed ? { no_result_confirmed: true } : {}),
        },
        result, error,
      };
      const accepted = await submitBolooProviderResult(this.dataRoot, sku, providerResult);
      submitted.push({ operation, request_id: requestId, attempt: nextAttempt, submitted_status: status, accepted, evidence_ref: evidenceRef.reference });
      if (status === 'PENDING_RECHECK') continue;
      const latest = await getTask(this.dataRoot, sku);
      const current = latest?.boloo?.required_subtasks?.find(item => item.subtask_id === subtask.subtask_id);
      if (operation === 'keyword_extractor' && pageResult.status === 'NO_RESULT' && current?.status === 'PENDING_RECHECK' && Number(current.extractor_no_keyword_attempts) < 2) continue;
      if (!latest?.boloo?.current_subtask_id || latest.boloo.current_subtask_id === subtask.subtask_id) break;
    }
    return { sku, submissions: submitted, task: await getTask(this.dataRoot, sku) };
  }
}

export { EXPLORER_FIELD, parseDisplayedVolume, PANE_BRIDGE_REQUEST_SCHEMA };
