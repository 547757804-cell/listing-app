import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAiRoutingSettings, routeAiRequest } from './ai_router.mjs';
import { READINESS_ONLY, assertBusinessDispatchEnabled } from './runtime_mode.mjs';

const stores = new Map();
const fileFor = root => path.join(root, 'ai-workbench', 'state.json');

function newStore(root) {
  return { root, file: fileFor(root), jobs: [], confirmations: [], inFlight: new Map(), lock: Promise.resolve(), loaded: false };
}
function storeFor(root) {
  const key = path.resolve(root);
  if (!stores.has(key)) stores.set(key, newStore(key));
  return stores.get(key);
}
async function withLock(store, action) {
  const previous = store.lock;
  let release;
  store.lock = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
}
async function persist(store) {
  await fs.mkdir(path.dirname(store.file), { recursive: true });
  const temp = `${store.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const publicState = { schema_version: 1, jobs: store.jobs, confirmations: store.confirmations, updated_at: new Date().toISOString() };
  await fs.writeFile(temp, `${JSON.stringify(publicState, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, store.file);
}
async function ensureLoaded(store) {
  if (store.loaded) return;
  if (!READINESS_ONLY) await fs.mkdir(path.dirname(store.file), { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(store.file, 'utf8'));
    store.jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    store.confirmations = Array.isArray(saved.confirmations) ? saved.confirmations : [];
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const job of store.jobs) {
    if (!READINESS_ONLY && job.status === 'RUNNING') {
      job.status = 'QUEUED';
      job.recovery_point = job.current_step || 'AI_PROVIDER_ROUTING';
      job.events ||= [];
      job.events.push({ at: new Date().toISOString(), event: 'AI_JOB_RECOVERED_AFTER_RESTART', recovery_point: job.recovery_point });
    }
  }
  store.loaded = true;
  if (!READINESS_ONLY) await persist(store);
}

function cleanJobInput(input = {}) {
  const sku = String(input.sku || '').trim();
  const module = String(input.module || '').trim();
  const prompt = String(input.prompt || '');
  if (!sku || !module || !prompt.trim()) throw Object.assign(new Error('AI 任务需要 SKU、模块和 prompt。'), { code: 'AI_JOB_INPUT_INVALID' });
  return {
    sku, module, task_type: String(input.task_type || module).trim(), system: String(input.system || ''), prompt,
    context: input.context && typeof input.context === 'object' ? input.context : {},
    proposal: input.proposal && typeof input.proposal === 'object' ? input.proposal : {},
    sop_independent: input.sop_independent === true,
    mutation_target: input.mutation_target === true,
    manual_gpt: input.manual_gpt === true,
  };
}

function conflictActive(store, job) {
  for (const active of store.jobs) {
    if (active.status !== 'RUNNING' || active.sku !== job.sku) continue;
    if (!job.sop_independent || !active.sop_independent || active.module === job.module) return true;
    if (job.mutation_target && active.mutation_target) return true;
  }
  return false;
}

async function executeJob(store, job) {
  assertBusinessDispatchEnabled('AI Worker execution');
  let result;
  try {
    result = await routeAiRequest(store.root, {
      sku: job.sku, module: job.module, system: job.system, prompt: job.prompt, context: job.context, manual_gpt: job.manual_gpt,
    });
  } catch (error) {
    result = { status: 'ERROR', reason_code: error?.code || 'AI_ROUTING_FAILED', error_message: error?.message || 'AI Router 执行失败。' };
  }
  await withLock(store, async () => {
    const current = store.jobs.find(item => item.job_id === job.job_id);
    if (!current) return;
    current.result = result;
    current.provider = result.gpt_result?.provider || result.primary_results?.find(item => item.status === 'PASS')?.provider || null;
    current.current_worker = null;
    current.updated_at = new Date().toISOString();
    current.events.push({ at: current.updated_at, event: 'AI_JOB_RESULT', status: result.status, request_id: result.request_id || null });
    if (result.status === 'WAITING_DEPENDENCY') current.status = 'WAITING_DEPENDENCY';
    else if (result.status === 'ERROR') current.status = 'ERROR';
    else {
      current.status = 'WAITING_CONFIRMATION';
      const confirmation = {
        confirmation_id: crypto.randomUUID(), job_id: current.job_id, sku: current.sku,
        source_module: current.module, problem_type: current.proposal.problem_type || current.task_type,
        evidence: current.proposal.evidence || current.context.evidence || [],
        current_value: current.proposal.current_value ?? null,
        suggested_value: current.proposal.suggested_value ?? result.gpt_result?.content ?? result.primary_results?.filter(item => item.status === 'PASS').map(item => ({ provider: item.provider, content: item.content })) ?? null,
        impact: current.proposal.impact || current.context.impact || [],
        result_status: result.status, decision: null, status: 'OPEN', created_at: current.updated_at, updated_at: current.updated_at,
        actions: ['confirm_pending_qa', 'ignore', 'need_more_info'],
      };
      store.confirmations.push(confirmation);
      current.confirmation_id = confirmation.confirmation_id;
      current.events.push({ at: current.updated_at, event: 'AI_CONFIRMATION_CREATED', confirmation_id: confirmation.confirmation_id });
    }
    store.inFlight.delete(current.job_id);
    await persist(store);
  });
  void drain(store);
}

async function drain(store) {
  if (READINESS_ONLY) return { dispatched: 0, runtime_mode: 'READINESS_ONLY' };
  const launches = await withLock(store, async () => {
    await ensureLoaded(store);
    const jobs = store.jobs.filter(job => job.status === 'RUNNING' || store.inFlight.has(job.job_id));
    const activeSkus = new Set(jobs.map(job => job.sku));
    const settings = (await getAiRoutingSettings(store.root)).settings;
    const capacity = settings.max_active_skus;
    const queue = store.jobs.filter(job => job.status === 'QUEUED').sort((a, b) => Number(b.priority) - Number(a.priority) || Date.parse(a.created_at) - Date.parse(b.created_at));
    const selected = [];
    for (const job of queue) {
      if (conflictActive(store, job)) continue;
      if (!activeSkus.has(job.sku) && activeSkus.size >= capacity) continue;
      job.status = 'RUNNING'; job.current_step = 'AI_PROVIDER_ROUTING'; job.started_at ||= new Date().toISOString();
      job.current_worker = job.manual_gpt ? 'GPT' : 'Qwen + DeepSeek'; job.queue_position = null; job.updated_at = new Date().toISOString();
      job.events.push({ at: job.updated_at, event: 'AI_JOB_STARTED', worker: job.current_worker, priority: job.priority });
      store.inFlight.set(job.job_id, true);
      activeSkus.add(job.sku);
      selected.push(job);
    }
    let position = 0;
    for (const job of store.jobs.filter(item => item.status === 'QUEUED').sort((a, b) => Number(b.priority) - Number(a.priority) || Date.parse(a.created_at) - Date.parse(b.created_at))) job.queue_position = ++position;
    if (selected.length) await persist(store);
    return selected;
  });
  for (const job of launches) void executeJob(store, job);
}

export async function initializeAiWorkbench(dataRoot) {
  const store = storeFor(dataRoot);
  await withLock(store, async () => ensureLoaded(store));
  if (!READINESS_ONLY) await drain(store);
}

export async function enqueueAiJob(dataRoot, input) {
  assertBusinessDispatchEnabled('AI task enqueue');
  const store = storeFor(dataRoot);
  const clean = cleanJobInput(input);
  const job = await withLock(store, async () => {
    await ensureLoaded(store);
    const created = {
      job_id: crypto.randomUUID(), ...clean, status: 'QUEUED', current_step: 'QUEUED', current_worker: null,
      queue_position: null, priority: input.priority === true, retry_count: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      events: [{ at: new Date().toISOString(), event: 'AI_JOB_QUEUED', priority: input.priority === true }], result: null,
    };
    store.jobs.push(created);
    await persist(store);
    return structuredClone(created);
  });
  void drain(store);
  return job;
}

export async function setAiJobPriority(dataRoot, jobId, priority = true) {
  assertBusinessDispatchEnabled('AI queue priority mutation');
  const store = storeFor(dataRoot);
  const job = await withLock(store, async () => {
    await ensureLoaded(store);
    const row = store.jobs.find(item => item.job_id === jobId);
    if (!row) throw Object.assign(new Error('AI 任务不存在。'), { code: 'AI_JOB_NOT_FOUND' });
    if (row.status !== 'QUEUED') throw Object.assign(new Error('优先级只对等待执行的 AI 任务生效。'), { code: 'AI_PRIORITY_REQUIRES_QUEUED' });
    row.priority = Boolean(priority); row.updated_at = new Date().toISOString();
    row.events.push({ at: row.updated_at, event: row.priority ? 'AI_JOB_PRIORITY_RAISED' : 'AI_JOB_PRIORITY_CLEARED' });
    await persist(store);
    return structuredClone(row);
  });
  void drain(store);
  return job;
}

export async function listAiJobs(dataRoot) {
  const store = storeFor(dataRoot); await ensureLoaded(store);
  return structuredClone(store.jobs.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)));
}

export async function listAiConfirmations(dataRoot) {
  const store = storeFor(dataRoot); await ensureLoaded(store);
  return structuredClone(store.confirmations.filter(item => item.status === 'OPEN' || item.status === 'WAITING_INPUT'));
}

export async function decideAiConfirmation(dataRoot, confirmationId, action, note = '') {
  assertBusinessDispatchEnabled('AI confirmation mutation');
  const store = storeFor(dataRoot);
  if (!['confirm_pending_qa', 'ignore', 'need_more_info'].includes(action)) throw Object.assign(new Error('人工确认操作无效。'), { code: 'AI_CONFIRMATION_ACTION_INVALID' });
  return withLock(store, async () => {
    await ensureLoaded(store);
    const item = store.confirmations.find(row => row.confirmation_id === confirmationId);
    if (!item || !['OPEN', 'WAITING_INPUT'].includes(item.status)) throw Object.assign(new Error('人工确认项不存在或已处理。'), { code: 'AI_CONFIRMATION_NOT_OPEN' });
    const now = new Date().toISOString(); item.updated_at = now; item.decision = action; item.decision_note = String(note || '').slice(0, 2000);
    if (action === 'confirm_pending_qa') item.status = 'CONFIRMED_PENDING_QA';
    else if (action === 'ignore') item.status = 'IGNORED';
    else item.status = 'WAITING_INPUT';
    const job = store.jobs.find(row => row.job_id === item.job_id);
    if (job) { job.status = action === 'confirm_pending_qa' ? 'CONFIRMED_PENDING_QA' : action === 'ignore' ? 'IGNORED' : 'WAITING_CONFIRMATION'; job.updated_at = now; job.events.push({ at: now, event: `AI_CONFIRMATION_${action.toUpperCase()}`, confirmation_id: item.confirmation_id }); }
    await persist(store);
    return structuredClone(item);
  });
}

export async function resumeReadyAiJobs(dataRoot) {
  if (READINESS_ONLY) return { resumed: 0, observed_only: true, runtime_mode: 'READINESS_ONLY' };
  const store = storeFor(dataRoot); await ensureLoaded(store);
  const state = await getAiRoutingSettings(dataRoot);
  const primary = state.settings.primary_providers;
  const ready = primary.length > 0 && primary.every(name => state.settings.providers[name].enabled && state.providers[name].ready);
  if (!ready) return { resumed: 0, waiting: store.jobs.filter(job => job.status === 'WAITING_DEPENDENCY').length };
  await withLock(store, async () => {
    for (const job of store.jobs) if (job.status === 'WAITING_DEPENDENCY') {
      job.status = 'QUEUED'; job.updated_at = new Date().toISOString(); job.queue_position = null;
      job.events.push({ at: job.updated_at, event: 'AI_PROVIDER_BECAME_READY', recovery_point: job.current_step });
    }
    await persist(store);
  });
  await drain(store);
  return { resumed: store.jobs.filter(job => job.status === 'RUNNING' || job.status === 'WAITING_CONFIRMATION').length, waiting: 0 };
}

export async function getAiWorkbenchSummary(dataRoot) {
  const [jobs, confirmations, providerData] = await Promise.all([listAiJobs(dataRoot), listAiConfirmations(dataRoot), getAiRoutingSettings(dataRoot)]);
  const counts = Object.fromEntries(['QUEUED', 'RUNNING', 'WAITING_DEPENDENCY', 'WAITING_CONFIRMATION', 'CONFIRMED_PENDING_QA', 'ERROR'].map(status => [status, jobs.filter(job => job.status === status).length]));
  return { jobs, counts, pending_confirmation_count: confirmations.length, max_active_skus: providerData.settings.max_active_skus, providers: providerData.providers };
}
