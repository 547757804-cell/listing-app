const POOLS = ['全部产品', '待处理池', '资料处理池', '关键词池', 'Listing 生成池', 'QA 池', '待上传池', '异常池', '已上传存档池'];
const LISTING_ROADMAP = [
  ['product_master', '产品资料'], ['mabang', '马帮并行输出'], ['bol_keywords', 'BOL 联想词'], ['boloo_keywords', 'Boloo 关键词'], ['top20', 'TOP20'],
  ['competitors', 'Listing 内部有效竞品'], ['selling_matrix', '竞争卖点矩阵'], ['title', '标题'], ['anchors', '5 个信息锚点'],
  ['description', '荷兰语描述'], ['attributes', '商品属性'], ['packaging', '包装内容'], ['art_review', '美工审核'],
  ['stage_qa', 'Stage QA（逐步门禁）'], ['qa', 'Final QA'], ['excel_qa', 'Excel 文件核验'], ['await_upload', '待上传'], ['uploaded', '已上传存档'],
];
const RESEARCH_POOLS = [
  ['产品基准池', '产品基准 / Product Master 快照'], ['种子竞品池', 'Leon 提供的种子竞品'], ['自动扩搜池', '自动扩展有效竞品'], ['同款/OEM池', '同款与 OEM 识别'],
  ['低价竞品池', '低价竞品样本'], ['同价竞品池', '同价竞品样本'], ['高配竞品池', '高配竞品样本'], ['成熟竞品池', '成熟竞品样本'],
  ['Amazon完全同款池', 'Amazon 完全同款核实'], ['饱和搜索池', '两轮饱和搜索'], ['数据核验池', '参数 / 价格 / 评论 / 销量'], ['价格线池', '价格线判断'],
  ['采购风险池', '20 件采购风险'], ['采购动作池', '采购动作建议'], ['竞品 QA 池', '独立竞品 QA'], ['竞品调研导出池', 'SKU_竞品调研.xlsx'], ['竞品调研存档池', '独立历史存档'],
];
const $ = id => document.getElementById(id);
let tasks = [];
let researchTasks = [];
let integrations = {};
let pool = '全部产品';
let selectedSku = '';
let editingSku = '';
let activityFilter = 'ALL';
let detailReturnView = 'board';
let detailTask = null;
let activeDetailTab = 'basic';
let keywordDetailTab = 'top20';
let keywordViewMode = 'current';
let currentView = 'board';
let pendingImportFilename = 'manual_import.csv';
let sourceWorkbookPreview = null;
let toastTimer;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const statusText = value => ({ PASS: '已完成已核验', DONE_PENDING_QA: '已完成待核验', FAIL: '核验失败', NOT_RUN: '未核验', NOT_STARTED: '未完成', RUNNING: '运行中', QUEUED: '排队中', ERROR: '异常', 'ERROR/QA_FAIL': '异常 / QA 失败', PAUSED: '已暂停', READY: '待上传', UPLOADED: '已上传', UPLOADED_ARCHIVED: '已上传存档', NOT_CONNECTED: '待接入', WAITING_DEPENDENCY: '等待依赖', WAITING_FOR_DEPENDENCY: '等待依赖', WAITING_CONFIRMATION: '待人工确认', WAITING_DECISION: '等待人工决策', WAITING_DISCOVERY_INPUT: '等待发现输入', WAITING_FOR_READINESS_CHECK: '待接入/待验收', STALE_READINESS_CHECK: '依赖验收已过期', CREDENTIALS_CHANGED: '凭据变更待验收', CREDENTIALS_NOT_READY: '凭据未就绪', DISABLED: '功能未启用', WAITING_FOR_PRODUCT_QA: '等待资料 QA', ENGINE_NOT_CONNECTED: '待接入执行器', WAITING_FOR_ENGINE: '等待执行器', QUEUED_ENGINE_PENDING: '排队待接入', READY_FOR_KEYWORDS: '待关键词', NOT_READY: '未就绪', QA_FAIL: 'QA 未通过', OPTIONAL: '可选 / 不适用', NOT_APPLICABLE: '可选 / 不适用' })[value] || value || '—';

const acceptancePort = window.location.port;
if ($('environmentBadge')) $('environmentBadge').textContent = acceptancePort === '4181' ? '4181 ACCEPTANCE' : acceptancePort === '4180' ? '4180 PRODUCTION' : `${acceptancePort || 'LOCAL'} LOCAL`;

function toast(message, bad = false) {
  const node = $('toast'); node.textContent = message; node.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.className = 'toast'; }, 3600);
}

async function api(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message || `请求失败 ${response.status}`), { code: body.error?.code });
  return body;
}

function renderTabs() {
  $('poolTabs').innerHTML = POOLS.map(name => `<button class="pool-tab ${pool === name ? 'selected' : ''}" data-pool="${escapeHtml(name)}">${escapeHtml(name)}<b>${name === '全部产品' ? tasks.length : tasks.filter(task => task.activity_pool === name).length}</b></button>`).join('');
  $('poolTabs').querySelectorAll('[data-pool]').forEach(button => button.addEventListener('click', () => { pool = button.dataset.pool; render(); }));
}

function chip(value, kind = '') {
  const text = statusText(value);
  const cls = kind || (['PASS', 'UPLOADED', 'UPLOADED_ARCHIVED', 'READY'].includes(value) ? 'good' : ['FAIL', 'ERROR', 'ERROR/QA_FAIL', 'QA_FAIL'].includes(value) ? 'bad' : ['RUNNING', 'QUEUED', 'PAUSED', 'FIXED_PENDING_QA', 'DONE_PENDING_QA', 'WAITING_CONFIRMATION'].includes(value) ? 'work' : 'muted-chip');
  return `<span class="status-chip ${cls}"><i></i>${escapeHtml(text)}</span>`;
}

function stageStatus(task, key) { return task.qa?.[key]?.status === 'PASS' ? 'PASS' : task.stages?.[key]?.status || 'NOT_STARTED'; }

function discoveryWaitSummary(task) {
  const waiting = task.boloo?.discovery_waiting_decision;
  if (!waiting) return '';
  const confirmed = Number(waiting.confirmed_volume_count) || 0;
  const required = Number(waiting.required_count) || 20;
  const gap = Math.max(0, Number(waiting.candidate_gap) || required - confirmed);
  return `已确认搜索量候选 ${confirmed}/${required} · 还缺 ${gap}`;
}

function researchLaneSummary(sku) {
  const task = researchTasks.find(item => item.sku === sku);
  if (!task) return '竞品调研中心：未加入';
  const step = task.stages?.[task.current_step]?.label || task.current_step || '—';
  return `竞品调研中心：${step} · ${task.current_pool || '—'} · ${statusText(task.status)} · ${dateTime(task.updated_at)}`;
}

function openIssueSummary(task) {
  const issues = (task.issues || []).filter(issue => issue.status !== 'CLOSED');
  if (!issues.length) return '';
  const first = issues[0];
  const position = first.location || first.step || task.current_step || '—';
  const message = first.reason || first.message || first.code || '异常待查看';
  return `未关闭异常 ${issues.length} 项 · ${position} · ${message}`;
}

function renderRows() {
  const visible = tasks.filter(task => pool === '全部产品' || task.activity_pool === pool);
  $('rowCount').textContent = `${visible.length} 个产品`;
  $('pageDataCount').textContent = `共 ${visible.length} / ${tasks.length} 个 SKU`;
  if (!visible.length) {
    $('taskRows').innerHTML = `<tr><td colspan="11" class="empty">${tasks.length ? '这个活动池当前没有产品。' : '还没有 SKU 任务。先导入产品资料。'}</td></tr>`;
    return;
  }
  $('taskRows').innerHTML = visible.map(task => {
    const step = task.stages?.[task.current_step]?.label || (task.current_step === 'await_upload' ? '待上传' : task.current_step);
    const selected = task.sku === selectedSku ? ' selected-row' : '';
    const dependencyReady = task.current_step === 'bol_keywords' ? integrations.bol?.BOL_API_READY === true : task.current_step === 'boloo_keywords' ? integrations.boloo?.BOLOO_OFFICIAL_WEB_READY === true : false;
    const discoveryWait = discoveryWaitSummary(task);
    const action = task.final_archive ? `<button class="row-action" data-view-final="${escapeHtml(task.sku)}">查看 Final</button>` : task.activity_pool === '异常池' ? `<button class="row-action danger-text" data-open-issue="${escapeHtml(task.sku)}">处理异常</button>` : task.activity_pool === '待上传池' ? `<button class="row-action" data-upload="${escapeHtml(task.sku)}">标记已上传</button>` : ['WAITING_DECISION', 'WAITING_DISCOVERY_INPUT'].includes(task.status) ? `<button class="row-action" disabled title="${escapeHtml(discoveryWait || '等待补充发现输入')}">待补充候选</button>` : task.status === 'PAUSED' ? `<button class="row-action" data-action="continue" data-sku="${escapeHtml(task.sku)}">继续</button>` : task.status === 'WAITING_DEPENDENCY' ? dependencyReady ? `<button class="row-action" data-action="continue" data-sku="${escapeHtml(task.sku)}">继续</button>` : `<button class="row-action" disabled title="当前 Provider 依赖未就绪">等待依赖</button>` : `<button class="row-action" data-action="reverify" data-sku="${escapeHtml(task.sku)}">核验</button>`;
    const errorSummary = openIssueSummary(task) || (task.error_code ? `${task.error_code} · ${task.error_message || ''}` : '');
    return `<tr class="${selected}" data-task-row="${escapeHtml(task.sku)}"><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button><small>${escapeHtml(task.master?.name || '产品名待补')}</small><button class="row-action keyword-entry" data-keyword-detail="${escapeHtml(task.sku)}">关键词详情</button></td><td><span class="work-lane">Listing 制作中心</span><small><span class="step-label">${escapeHtml(step)}</span> · ${escapeHtml(statusText(task.status))}</small><small>Listing 活动池：${escapeHtml(task.current_pool || task.activity_pool || '—')}</small><small class="research-lane">${escapeHtml(researchLaneSummary(task.sku))}</small>${discoveryWait ? `<small class="task-wait">${escapeHtml(discoveryWait)}</small>` : ''}${errorSummary ? `<small class="task-error" title="${escapeHtml(errorSummary)}">${escapeHtml(errorSummary)}</small>` : ''}</td><td>${chip(task.current_pool || task.activity_pool, task.activity_pool === '异常池' ? 'bad' : task.activity_pool === '已上传存档池' ? 'good' : 'muted-chip')}</td><td>${chip(task.sidecars?.mabang?.status)}</td><td>${chip(task.sidecars?.artwork?.status || task.sidecars?.art?.status)}</td><td>${chip(task.sidecars?.keywords?.status)}</td><td>${chip(task.sidecars?.listing?.status)}</td><td>${chip(task.sidecars?.verification?.status)}</td><td>${chip(task.sidecars?.upload?.status)}</td><td class="timestamp">${dateTime(task.updated_at)}</td><td>${action}</td></tr>`;
  }).join('');
  $('taskRows').querySelectorAll('[data-task-row]').forEach(row => row.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    void openProductDetail(row.dataset.taskRow);
  }));
  $('taskRows').querySelectorAll('[data-open-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.openDetail, 'acceptance')));
  $('taskRows').querySelectorAll('[data-open-issue]').forEach(button => button.addEventListener('click', () => openException(button.dataset.openIssue)));
  $('taskRows').querySelectorAll('[data-upload]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.upload, 'mark_uploaded')));
  $('taskRows').querySelectorAll('[data-view-final]').forEach(button => button.addEventListener('click', () => showFinalArchive(button.dataset.viewFinal)));
  $('taskRows').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.sku, button.dataset.action)));
  $('taskRows').querySelectorAll('[data-keyword-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.keywordDetail, 'keywords')));
}

function activityRows() {
  const rows = [];
  for (const task of tasks) {
    const step = task.stages?.[task.current_step]?.label || task.current_step || '—';
    rows.push({ sku: task.sku, module: 'Listing 制作', step, status: task.status, worker: task.current_worker || task.current_provider || '—', priority: task.priority ? '高' : '普通', queue: task.queue_position ?? '—', updated_at: task.updated_at });
    const sidecars = [
      ['马帮', task.sidecars?.mabang], ['美工', task.sidecars?.artwork || task.sidecars?.art], ['关键词', task.sidecars?.keywords], ['Listing', task.sidecars?.listing], ['核验', task.sidecars?.verification], ['上传', task.sidecars?.upload], ['AI', task.sidecars?.ai],
    ];
    for (const [module, item] of sidecars) {
      if (!item?.status || ['NOT_CONNECTED', 'NOT_READY', 'WAITING_FOR_PRODUCT_QA', 'NOT_RUN'].includes(item.status)) continue;
      rows.push({ sku: task.sku, module, step: item.current_step || item.dependency || task.current_step || '—', status: item.status, worker: item.current_worker || item.provider || item.dependency || '—', priority: item.priority ? '高' : '普通', queue: item.queue_position ?? '—', updated_at: item.updated_at || task.updated_at });
    }
    for (const subtask of task.boloo?.required_subtasks || []) {
      if (!['RUNNING', 'QUEUED', 'PENDING_RECHECK', 'WAITING_DEPENDENCY'].includes(subtask.status)) continue;
      rows.push({ sku: task.sku, module: 'Boloo', step: subtask.source_id || subtask.subtask_id, status: subtask.status, worker: subtask.provider_method || 'Boloo Provider', priority: task.priority ? '高' : '普通', queue: subtask.queue_position ?? '—', updated_at: subtask.updated_at || task.updated_at });
    }
  }
  for (const task of researchTasks) rows.push({ sku: task.sku, module: '竞品调研', step: task.stages?.[task.current_step]?.label || task.current_step || '—', status: task.status, worker: task.current_worker || task.dependency || '—', priority: task.priority ? '高' : '普通', queue: task.queue_position ?? '—', updated_at: task.updated_at });
  return rows;
}

function renderPools() {
  const rows = activityRows();
  const visible = rows.filter(row => {
    if (activityFilter === 'ALL') return ['RUNNING', 'QUEUED', 'PAUSED', 'ERROR', 'WAITING_CONFIRMATION'].includes(row.status) || String(row.status).startsWith('WAITING');
    if (activityFilter === 'WAITING') return String(row.status).startsWith('WAITING') || row.status === 'PENDING_RECHECK';
    return row.status === activityFilter;
  });
  $('globalActivityRows').innerHTML = visible.length ? visible.map(row => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(row.sku)}">${escapeHtml(row.sku)}</button></td><td>${escapeHtml(row.module)}</td><td>${escapeHtml(row.step)}</td><td>${chip(row.status)}</td><td>${escapeHtml(row.worker || '—')}</td><td>${escapeHtml(row.priority)}</td><td>${escapeHtml(row.queue)}</td><td class="timestamp">${dateTime(row.updated_at)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">当前筛选没有活动任务。</td></tr>';
  document.querySelectorAll('[data-activity-filter]').forEach(button => button.classList.toggle('selected', button.dataset.activityFilter === activityFilter));
  document.querySelectorAll('[data-activity-filter]').forEach(button => button.onclick = () => { activityFilter = button.dataset.activityFilter; renderPools(); });
  $('globalActivityRows').querySelectorAll('[data-open-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.openDetail)));
}

function poolMarkup(definitions, sourceTasks, field, owner) {
  return definitions.map(([name, hint]) => {
    const items = sourceTasks.filter(task => task[field] === name);
    const tone = /异常|存档/.test(name) ? (name.includes('异常') ? 'pool-error' : 'pool-done') : '';
    return `<article class="pool-card ${tone}"><div><span>${escapeHtml(hint)}</span><b>${items.length}</b></div><h3>${escapeHtml(name)}</h3><div class="pool-skus">${items.length ? items.slice(0, 6).map(item => `<span class="pool-sku-tag">${escapeHtml(item.sku)}</span>`).join('') : '<span class="no-items">暂无任务</span>'}</div><small class="pool-owner">${owner}</small></article>`;
  }).join('');
}

function mabangSummary(task) {
  const item = task.sidecars?.mabang || {};
  const weight = item.weight_kg == null ? '重量待录入' : `${item.weight_kg} kg → ${item.weight_g == null ? '待生成' : `${item.weight_g} g`}`;
  return `${statusText(item.status)} · ${item.current_step || '—'} · ${weight}`;
}

const LISTING_PIPELINE = [
  ['待处理池', '待处理', 'listing-prep'], ['资料处理池', '资料', 'listing-prep'], ['关键词池', '关键词', 'listing-keywords'],
  ['Listing 生成池', 'Listing', 'listing-generation'], ['QA 池', 'QA', 'listing-qa'], ['待上传池', '待上传', 'listing-qa'], ['已上传存档池', '已上传', 'listing-archive'],
];
const PREP_STEPS = ['product_master'];
const KEYWORD_STEPS = ['bol_keywords', 'boloo_keywords', 'top20'];
const GENERATION_STEPS = ['competitors', 'selling_matrix', 'title', 'anchors', 'description', 'attributes', 'packaging', 'art_review'];
const QA_STEPS = ['stage_qa', 'qa', 'excel_qa', 'await_upload'];

function renderPipelineStrip() {
  const markup = LISTING_PIPELINE.map(([poolName, label, view]) => `<button class="pipeline-count" data-pipeline-view="${view}"><span>${escapeHtml(label)}</span><b>${tasks.filter(task => task.activity_pool === poolName).length}</b></button>`).join('');
  document.querySelectorAll('.listing-pipeline-strip').forEach(node => { node.innerHTML = markup; node.querySelectorAll('[data-pipeline-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.pipelineView))); });
}

function stepListHtml(keys) {
  return keys.map(key => {
    const row = LISTING_ROADMAP.find(item => item[0] === key);
    const active = tasks.filter(task => task.current_step === key && !task.final_archive).length;
    const passed = tasks.filter(task => task.qa?.[key]?.status === 'PASS').length;
    const waitingExecutor = tasks.some(task => task.stages?.[key]?.status === 'BLOCKED_ENGINE_NOT_CONNECTED');
    return `<article class="stage-list-row"><span class="stage-list-index">${String(Math.max(1, LISTING_ROADMAP.findIndex(item => item[0] === key) + 1)).padStart(2, '0')}</span><b>${escapeHtml(row?.[1] || key)}</b><span>${passed} PASS · ${active} 当前停留${waitingExecutor ? ' · 执行器待接入' : ''}</span></article>`;
  }).join('');
}

function listingActionButton(task, prefix = 'listing') {
  if (task.final_archive) return `<button class="row-action" data-${prefix}-final="${escapeHtml(task.sku)}">查看 Final</button>`;
  if (task.activity_pool === '待上传池') return `<button class="row-action" data-${prefix}-upload="${escapeHtml(task.sku)}">标记已上传</button>`;
  if (task.activity_pool === '异常池') return `<button class="row-action danger-text" data-${prefix}-issue="${escapeHtml(task.sku)}">处理异常</button>`;
  return `<button class="row-action" data-${prefix}-history="${escapeHtml(task.sku)}">查看历史</button>`;
}

function bindListingActions(tbody, prefix = 'listing') {
  tbody.querySelectorAll(`[data-${prefix}-upload]`).forEach(button => button.addEventListener('click', () => runAction(button.dataset[`${prefix}Upload`], 'mark_uploaded')));
  tbody.querySelectorAll(`[data-${prefix}-issue]`).forEach(button => button.addEventListener('click', () => openException(button.dataset[`${prefix}Issue`])));
  tbody.querySelectorAll(`[data-${prefix}-final]`).forEach(button => button.addEventListener('click', () => showFinalArchive(button.dataset[`${prefix}Final`])));
  tbody.querySelectorAll(`[data-${prefix}-history]`).forEach(button => button.addEventListener('click', () => showHistory(button.dataset[`${prefix}History`])));
  tbody.querySelectorAll('[data-open-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.openDetail)));
  tbody.querySelectorAll('[data-keyword-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.keywordDetail, 'keywords')));
}

function renderListingCenter() {
  renderPipelineStrip();
  const activeCount = tasks.filter(task => !['异常池', '待上传池', '已上传存档池'].includes(task.activity_pool)).length;
  $('listingOverviewCount').textContent = tasks.length;
  $('listingOverviewActive').textContent = activeCount;
  $('listingOverviewErrors').textContent = tasks.filter(task => task.status === 'ERROR' || task.activity_pool === '异常池').length;
  $('listingOverviewUpload').textContent = tasks.filter(task => task.activity_pool === '待上传池').length;
  $('listingRowCount').textContent = `${tasks.length} 个 SKU`;
  $('listingRows').innerHTML = tasks.length ? tasks.map(task => {
    const label = task.stages?.[task.current_step]?.label || task.current_step || '—';
    const qa = task.stage_qa_status || task.qa?.[task.current_step]?.status || 'NOT_RUN';
    return `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button><small>${escapeHtml(task.master?.name || '产品名待补')}</small><button class="row-action keyword-entry" data-keyword-detail="${escapeHtml(task.sku)}">关键词详情</button></td><td>${escapeHtml(label)}<small>${escapeHtml(task.current_step || '—')} · ${escapeHtml(task.current_pool || task.activity_pool || '—')}</small></td><td>${chip(task.status)}</td><td>${chip(task.sidecars?.mabang?.status)}</td><td>${chip(task.sidecars?.artwork?.status || task.sidecars?.art?.status)}</td><td>${chip(task.sidecars?.keywords?.status)}</td><td>${chip(task.sidecars?.listing?.status)}</td><td>${chip(qa)}</td><td>${chip(task.sidecars?.upload?.status)}</td><td class="timestamp">${dateTime(task.updated_at)}</td><td>${listingActionButton(task)}</td></tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">尚无 Listing SKU。请从产品资料导入。</td></tr>';
  bindListingActions($('listingRows'));

  $('listingPrepSteps').innerHTML = stepListHtml(PREP_STEPS);
  $('listingKeywordSteps').innerHTML = stepListHtml(KEYWORD_STEPS);
  $('listingGenerationSteps').innerHTML = stepListHtml(GENERATION_STEPS);
  $('listingQaSteps').innerHTML = stepListHtml(QA_STEPS);

  const prep = tasks.filter(task => !task.final_archive && (task.current_step === 'product_master' || (task.sidecars?.mabang?.status && !['COMPLETED', 'EXPORTED', 'NOT_CONNECTED'].includes(task.sidecars.mabang.status))));
  $('listingPrepRows').innerHTML = prep.length ? prep.map(task => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button></td><td>${chip(stageStatus(task, 'product_master'))}</td><td>${chip(task.sidecars?.mabang?.status)}</td><td>${escapeHtml(mabangSummary(task).split(' · ').at(-1) || '—')}</td><td>${chip(task.status)}</td><td class="timestamp">${dateTime(task.updated_at)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">当前没有资料或马帮任务。</td></tr>';
  const keywordRows = tasks.filter(task => KEYWORD_STEPS.includes(task.current_step));
  $('listingKeywordRows').innerHTML = keywordRows.length ? keywordRows.map(task => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button></td><td>${escapeHtml(task.stages?.[task.current_step]?.label || task.current_step)}</td><td>${chip(task.stages?.bol_keywords?.status || task.sidecars?.keywords?.status)}</td><td>${chip(task.stages?.boloo_keywords?.status || task.sidecars?.keywords?.status)}</td><td>${escapeHtml(discoveryWaitSummary(task) || `${task.boloo?.candidate_pool?.length || 0} 候选`)}</td><td>${chip(task.stage_qa_status || task.qa?.[task.current_step]?.status || 'NOT_RUN')}</td><td class="timestamp">${dateTime(task.updated_at)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">当前没有停留在关键词阶段的 SKU。</td></tr>';
  const generationRows = tasks.filter(task => GENERATION_STEPS.includes(task.current_step));
  $('listingGenerationRows').innerHTML = generationRows.length ? generationRows.map(task => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button></td><td>${escapeHtml(task.stages?.[task.current_step]?.label || task.current_step)}</td><td>${chip(task.status)}</td><td>${chip(task.sidecars?.listing?.status)}</td><td>${chip(task.stage_qa_status || task.qa?.[task.current_step]?.status || 'NOT_RUN')}</td><td class="timestamp">${dateTime(task.updated_at)}</td><td>${listingActionButton(task, 'generation')}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">当前没有停留在 Listing 生成阶段的 SKU。</td></tr>';
  bindListingActions($('listingGenerationRows'), 'generation');
  const qaRows = tasks.filter(task => !task.final_archive && (QA_STEPS.includes(task.current_step) || ['QA 池', '待上传池'].includes(task.activity_pool)));
  $('listingQaRows').innerHTML = qaRows.length ? qaRows.map(task => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button></td><td>${escapeHtml(task.stages?.[task.current_step]?.label || task.current_step || '—')}</td><td>${chip(task.stage_qa_status || task.qa?.[task.current_step]?.status || 'NOT_RUN')}</td><td>${chip(task.qa?.qa?.status || 'NOT_RUN')}</td><td>${chip(task.qa?.excel_qa?.status || 'NOT_RUN')}</td><td>${chip(task.sidecars?.upload?.status)}</td><td class="timestamp">${dateTime(task.updated_at)}</td><td>${listingActionButton(task, 'qa')}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">当前没有待核验或待上传 SKU。</td></tr>';
  bindListingActions($('listingQaRows'), 'qa');
  const archived = tasks.filter(task => !!task.final_archive);
  $('listingArchiveRows').innerHTML = archived.length ? archived.map(task => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button></td><td>${escapeHtml(task.final_archive?.listing_outputs?.title?.content || task.final_archive?.listing_outputs?.title || 'Final 已锁定')}</td><td>${escapeHtml(JSON.stringify(task.final_archive?.versions || {}))}</td><td>${dateTime(task.final_archive?.upload_date || task.final_archive?.archived_at)}</td><td>${chip('UPLOADED_ARCHIVED')}</td><td><button class="row-action" data-archive-final="${escapeHtml(task.sku)}">查看 Final</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">暂无已上传 Listing Final 存档。</td></tr>';
  bindListingActions($('listingArchiveRows'), 'archive');
  $('listingArchiveRows').querySelectorAll('[data-archive-final]').forEach(button => button.addEventListener('click', () => showFinalArchive(button.dataset.archiveFinal)));
}

function renderResearchCenter() {
  const selector = $('researchSku');
  const current = selector.value;
  selector.innerHTML = '<option value="">选择已有 Product Master SKU</option>' + tasks.map(task => `<option value="${escapeHtml(task.sku)}">${escapeHtml(task.sku)} · ${escapeHtml(task.master?.name || '')}</option>`).join('');
  if (tasks.some(task => task.sku === current)) selector.value = current;
  $('researchTaskCount').textContent = researchTasks.length;
  const poolCards = poolMarkup(RESEARCH_POOLS, researchTasks, 'current_pool', '独立竞品调研');
  $('researchPoolCards').innerHTML = poolCards;
  if ($('researchPoolCardsCompact')) $('researchPoolCardsCompact').innerHTML = poolCards;
  $('researchRowCount').textContent = `${researchTasks.length} 个独立任务`;
  $('researchRows').innerHTML = researchTasks.length ? researchTasks.map(task => `<tr><td><button class="sku-link" data-open-detail="${escapeHtml(task.sku)}">${escapeHtml(task.sku)}</button><small>${escapeHtml(task.id)}</small></td><td>Product Master v${escapeHtml(task.product_baseline?.fact_version || '—')}</td><td>research_task_version v${escapeHtml(task.research_task_version ?? task.revision ?? '—')}</td><td class="seed-cell" title="${escapeHtml(task.seed_competitor_url)}">${escapeHtml(task.seed_competitor_url)}</td><td><b>${escapeHtml(task.stages?.[task.current_step]?.label || task.current_step)}</b><small>${escapeHtml(task.current_step)}</small></td><td>${chip(task.current_pool)}</td><td>${chip(task.stage_qa_status)}</td><td>${chip(task.status)}<small>${escapeHtml(task.dependency || '')}</small></td><td class="timestamp">${dateTime(task.updated_at)}</td><td><button class="row-action" data-research-history="${escapeHtml(task.id)}">查看历史</button></td></tr>`).join('') : '<tr><td colspan="10" class="empty">还没有独立竞品调研任务。只有在上方明确加入后才会创建。</td></tr>';
  $('researchRows').querySelectorAll('[data-research-history]').forEach(button => button.addEventListener('click', () => showResearchHistory(button.dataset.researchHistory)));
  $('researchRows').querySelectorAll('[data-open-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.openDetail)));
}

function renderExceptions() {
  const abnormal = tasks.filter(task => task.activity_pool === '异常池' || task.status === 'ERROR');
  $('exceptionBadge').textContent = abnormal.length;
  $('globalErrorCount').textContent = abnormal.length;
  $('exceptionList').innerHTML = abnormal.length ? abnormal.map(task => {
    const issue = task.issues.find(item => item.status !== 'CLOSED');
    return `<button class="exception-item ${selectedSku === task.sku ? 'selected' : ''}" data-exception-sku="${escapeHtml(task.sku)}"><b>${escapeHtml(task.sku)}</b><span>${escapeHtml(issue?.code || '异常')}</span><small>${escapeHtml(issue?.reason || '无错误说明')}</small><em>${escapeHtml(task.master?.name || '产品名待补')}</em></button>`;
  }).join('') : '<div class="empty-detail">当前没有 SKU 异常。全局 Provider 未就绪时会停在“等待依赖”；实际执行或阶段核验失败后才进入异常池。</div>';
  $('exceptionList').querySelectorAll('[data-exception-sku]').forEach(button => button.addEventListener('click', () => openException(button.dataset.exceptionSku)));
  if (!abnormal.some(task => task.sku === selectedSku)) $('issueDetail').innerHTML = '<div class="empty-detail">选择左侧 SKU 查看异常细节和恢复点。</div>';
}

function renderConfirmations() {
  const pending = [];
  for (const task of tasks) {
    if (task.status === 'WAITING_CONFIRMATION' || task.confirmation?.status === 'OPEN' || task.ai_confirmation?.status === 'OPEN') {
      pending.push({ task, item: task.confirmation || task.ai_confirmation || {}, tab: 'basic' });
    }
    for (const image of task.sidecars?.artwork?.images || []) {
      if (image.status !== 'WAITING_CONFIRMATION') continue;
      const version = image.versions?.find(item => Number(item.version) === Number(image.active_version)) || {};
      pending.push({
        task, tab: 'images', image,
        item: {
          source_module: 'ARTWORK_SIDECAR', problem_type: `${image.category} · ${image.image_id}`,
          evidence: { qwen_review: version.qwen_review, deepseek_review: version.deepseek_review, logo_action: image.logo_action, logo: image.logo },
          current_value: version.qwen_review?.findings || version.deepseek_review?.current_text || null,
          suggested_value: version.deepseek_review?.suggested_text || null,
          impact: ['当前图片版本', '仅此图片任务；不进入 SKU ERROR 池'],
        },
      });
    }
  }
  $('globalConfirmationCount').textContent = pending.length;
  $('confirmationList').innerHTML = pending.length ? pending.map(({ task, item, image, tab }) => {
    const factDecision = item.source_module === 'LISTING_SOP_02' && task.confirmation?.status === 'OPEN';
    const factChoices = factDecision ? (item.proposals || []).map(proposal => `<label class="fact-resolution"><b>${escapeHtml(proposal.label || proposal.field)}</b><small>${escapeHtml(proposal.reason)} · 当前值：${escapeHtml(JSON.stringify(proposal.current_value))}</small>${proposal.requires_manual_value ? `<input type="text" data-fact-manual="${escapeHtml(proposal.field)}" placeholder="由 Leon 输入并确认品牌" autocomplete="off">` : `<select data-fact-resolution="${escapeHtml(proposal.field)}"><option value="">选择自有来源值</option>${(proposal.candidates || []).map((candidate, index) => `<option value="${index}">${escapeHtml(JSON.stringify(candidate.value))} · ${escapeHtml(candidate.source)} · ${escapeHtml(candidate.source_reference)} v${escapeHtml(candidate.source_version)}</option>`).join('')}</select>`}</label>`).join('') : '';
    const decisionButtons = factDecision ? `<div class="fact-decision-actions"><button class="button primary" data-product-fact-action="confirm" data-sku="${escapeHtml(task.sku)}">确认所选事实</button><button class="button secondary" data-product-fact-action="ignore" data-sku="${escapeHtml(task.sku)}">忽略提案</button></div>` : '';
    return `<article class="confirmation-card"><header><div><b>${escapeHtml(task.sku)}</b><span>${escapeHtml(item.source_module || task.current_step || '待确认事项')} · ${escapeHtml(item.problem_type || task.error_code || '人工确认')}</span></div>${chip('WAITING_CONFIRMATION')}</header><dl><div><dt>证据</dt><dd>${escapeHtml(JSON.stringify(item.evidence || task.master?.source_refs || []))}</dd></div><div><dt>当前值</dt><dd>${escapeHtml(JSON.stringify(item.current_value ?? null))}</dd></div><div><dt>建议值</dt><dd>${escapeHtml(JSON.stringify(item.suggested_value ?? item.proposal ?? null))}</dd></div><div><dt>影响范围</dt><dd>${escapeHtml(JSON.stringify(item.impact || []))}</dd></div></dl>${factChoices}${decisionButtons}<footer><span>${escapeHtml(image ? `${image.category} · ${image.status}` : (task.stages?.[task.current_step]?.label || task.current_step || '—'))} · ${dateTime(image?.updated_at || task.updated_at)}</span><button class="button secondary" data-confirmation-detail="${escapeHtml(task.sku)}" data-confirmation-tab="${tab}">查看产品</button></footer></article>`;
  }).join('') : '<div class="empty-detail">当前没有待人工确认事项。此中心与红色 ERROR 异常池分开统计。</div>';
  $('confirmationList').querySelectorAll('[data-confirmation-detail]').forEach(button => button.addEventListener('click', () => openProductDetail(button.dataset.confirmationDetail, button.dataset.confirmationTab || 'basic')));
  $('confirmationList').querySelectorAll('[data-product-fact-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.productFactAction === 'confirm' ? 'confirm_product_facts' : 'ignore_product_facts';
    const card = button.closest('.confirmation-card');
    const payload = action === 'confirm_product_facts'
      ? { resolutions: Object.fromEntries([
        ...[...card.querySelectorAll(`[data-fact-resolution]`)].map(select => [select.dataset.factResolution, select.value === '' ? '' : Number(select.value)]),
        ...[...card.querySelectorAll(`[data-fact-manual]`)].map(input => [input.dataset.factManual, { value: input.value }]),
      ]) }
      : {};
    await runAction(button.dataset.sku, action, payload);
  }));
}

function renderIssueDetail(task) {
  const issue = [...(task.issues || [])].reverse().find(item => item.status !== 'CLOSED');
  if (!issue) { $('issueDetail').innerHTML = '<div class="empty-detail">这个 SKU 没有开放异常。</div>'; return; }
  const fixed = issue.status === 'FIXED_PENDING_QA';
  $('issueDetail').innerHTML = `<div class="issue-top"><div><span class="eyebrow">${escapeHtml(task.sku)} · ${escapeHtml(issue.code)}</span><h3>${escapeHtml(issue.reason)}</h3></div>${chip(issue.status, fixed ? 'work' : 'bad')}</div>
    <dl class="issue-fields"><div><dt>具体错误位置</dt><dd>${escapeHtml(issue.location)}</dd></div><div><dt>当前值</dt><dd>${escapeHtml(JSON.stringify(issue.current_value ?? null))}</dd></div><div><dt>正确标准</dt><dd>${escapeHtml(issue.expected_standard)}</dd></div><div><dt>修复建议</dt><dd>${escapeHtml(issue.fix_suggestion)}</dd></div><div><dt>恢复点</dt><dd>${escapeHtml(issue.resume_point)} · 成功节点 ${escapeHtml(task.last_success_step || '尚无')}</dd></div><div><dt>重试次数 / 开放异常</dt><dd>${task.retry_count} / ${task.open_error_count}</dd></div></dl>
    ${fixed ? '<div class="pending-check">已修复待核验 · 重新核验通过前会停留在异常池</div>' : ''}
    <div class="issue-actions"><button class="button primary" data-issue-action="fix" data-sku="${escapeHtml(task.sku)}" data-issue="${escapeHtml(issue.issue_id)}">修复</button><button class="button secondary" data-issue-action="auto_fix" data-sku="${escapeHtml(task.sku)}" data-issue="${escapeHtml(issue.issue_id)}">自动修复</button><button class="button secondary" data-issue-action="reverify" data-sku="${escapeHtml(task.sku)}">重新核验</button><button class="button secondary" data-issue-action="retry" data-sku="${escapeHtml(task.sku)}">重新执行</button><button class="button secondary" data-issue-action="continue" data-sku="${escapeHtml(task.sku)}">继续</button><button class="button secondary" data-issue-action="change" data-sku="${escapeHtml(task.sku)}">修改</button><button class="button secondary" data-issue-action="pause" data-sku="${escapeHtml(task.sku)}">暂停</button><button class="button secondary" data-issue-action="view_error" data-sku="${escapeHtml(task.sku)}">查看错误</button><button class="button secondary" data-issue-action="history" data-sku="${escapeHtml(task.sku)}">查看历史</button></div>`;
  $('issueDetail').querySelectorAll('[data-issue-action]').forEach(button => button.addEventListener('click', () => issueAction(button)));
}

function render() {
  renderTabs(); renderRows(); renderPools(); renderExceptions(); renderConfirmations(); renderListingCenter(); renderResearchCenter();
  $('totalCount').textContent = tasks.length;
  $('activeCount').textContent = tasks.filter(task => !['已上传存档池', '异常池', '待上传池'].includes(task.activity_pool)).length;
  $('errorCount').textContent = tasks.filter(task => task.activity_pool === '异常池').length;
  $('uploadCount').textContent = tasks.filter(task => task.activity_pool === '待上传池').length;
  $('listingTaskCount').textContent = tasks.length;
}

async function refresh() {
  try {
    const [data, research] = await Promise.all([api('/api/dashboard'), api('/api/competitor-research/tasks').catch(() => ({ tasks: [] }))]);
    tasks = data.tasks || [];
    researchTasks = research.tasks || [];
    integrations = data.integrations || {};
    $('dataPath').textContent = data.data_root;
    const gates = data.module_gates || {};
    const gateNames = ['CORE/ISOLATION', 'BOL_API_PRODUCTION', 'BOLOO_MCP', 'BOLOO_OFFICIAL_WEB', 'MABANG_SCHEMA'];
    $('integrationStatus').textContent = gateNames.map(name => {
      const status = gates[name]?.status || 'UNKNOWN';
      return `${name}=${name === 'BOLOO_OFFICIAL_WEB' && status === 'PASS' ? 'READY' : status}`;
    }).join(' · ');
    $('updatedAt').textContent = `刷新 ${dateTime(data.last_updated)}`;
    render();
    if (selectedSku) { const task = tasks.find(item => item.sku === selectedSku); if (task && task.activity_pool === '异常池') renderIssueDetail(task); }
    if (currentView === 'productDetail' && detailTask?.sku) {
      detailTask = await api(`/api/tasks/${encodeURIComponent(detailTask.sku)}`).catch(() => detailTask);
      $('detailTitle').textContent = `${detailTask.sku} · ${detailTask.master?.name || '产品详情'}`;
      $('detailStatus').textContent = `${statusText(detailTask.status)} · ${detailTask.current_step || '—'} · ${detailTask.current_pool || detailTask.activity_pool || '—'} · 更新于 ${dateTime(detailTask.updated_at)}`;
      if (activeDetailTab !== 'images') await renderProductDetailTab(activeDetailTab);
    }
  } catch (error) { toast(`读取任务失败：${error.message}`, true); }
}

async function runAction(sku, action, payload = {}) {
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(sku)}/action`, { method: 'POST', body: JSON.stringify({ action, payload }) });
    await refresh();
    const updatedTask = tasks.find(item => item.sku === sku) || result.task;
    if (updatedTask?.activity_pool === '异常池') selectedSku = sku;
    if (action === 'mark_uploaded') toast(`${sku} 已进入已上传存档池，Final 版本已锁定。`);
    else toast(`${sku} · ${updatedTask?.activity_pool || '操作完成'}`);
    if (['reverify', 'retry', 'continue', 'fix', 'auto_fix', 'change'].includes(action)) {
      if (updatedTask?.activity_pool === '异常池') openException(sku);
      else if (action === 'reverify' || action === 'retry') {
        selectedSku = null;
        switchView('board');
        render();
      }
    }
  } catch (error) { toast(`${error.code ? `${error.code} · ` : ''}${error.message}`, true); }
}

async function issueAction(button) {
  const { sku, issue, issueAction: action } = button.dataset;
  if (action === 'view_error') {
    const task = tasks.find(item => item.sku === sku); renderIssueDetail(task);
    toast((task?.issues || []).map(item => `${item.code}: ${item.reason}`).join(' | ') || '没有错误记录'); return;
  }
  if (action === 'history') { await showHistory(sku); return; }
  if (action === 'fix' || action === 'change') { openEdit(sku, action, issue); return; }
  await runAction(sku, action, action === 'auto_fix' ? { issue_id: issue } : {});
}

async function openException(sku) {
  selectedSku = sku;
  const task = await api(`/api/tasks/${encodeURIComponent(sku)}`).catch(() => null);
  if (task) { switchView('exceptions'); render(); renderIssueDetail(task); }
}

function openEdit(sku, action, issueId = '') {
  editingSku = sku;
  const task = tasks.find(item => item.sku === sku);
  $('editTitle').textContent = action === 'fix' ? `修复 ${sku}` : `修改 ${sku}`;
  $('editPatch').value = JSON.stringify(action === 'fix' ? { issue_id: issueId, patch: {} } : { patch: { name: task?.master?.name || '', brand: task?.master?.brand || '', weight_kg: task?.master?.weight_kg, source_refs: task?.master?.source_refs || [], confirmed_core_terms: task?.master?.confirmed_core_terms || [] } }, null, 2);
  $('editDialog').dataset.action = action;
  $('editDialog').showModal();
}

async function showHistory(sku) {
  const data = await api(`/api/tasks/${encodeURIComponent(sku)}/history`);
  $('historyTitle').textContent = `${sku} · 修改与恢复历史`;
  $('historyItems').innerHTML = (data.history || []).length ? data.history.slice().reverse().map(item => `<article class="history-item"><time>${dateTime(item.at)}</time><b>${escapeHtml(item.type)}</b><span>${escapeHtml(item.current_step || '—')} · ${escapeHtml(item.pool || '—')}</span><small>${escapeHtml(JSON.stringify(item.details || {}))}</small></article>`).join('') : '<div class="empty-detail">暂无历史事件。</div>';
  $('historyDialog').showModal();
}

function detailJson(value) {
  return `<pre class="detail-json">${escapeHtml(value == null ? '暂无数据' : JSON.stringify(value, null, 2))}</pre>`;
}
function detailFields(entries) {
  return `<dl class="detail-fields">${entries.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value == null || value === '' ? '—' : typeof value === 'string' ? value : JSON.stringify(value))}</dd></div>`).join('')}</dl>`;
}
function keywordData(task) {
  const archived = keywordViewMode === 'snapshot' && !!task.final_archive;
  const snapshot = archived ? task.final_archive.keyword_snapshot : null;
  const outputs = archived ? (snapshot?.outputs || task.final_archive.listing_outputs || {}) : (task.outputs || {});
  return {
    archived, snapshot, outputs,
    candidates: archived ? snapshot?.candidates : (task.boloo?.candidates || task.boloo?.candidate_pool || []),
    subtasks: archived ? (snapshot?.required_subtasks || outputs.boloo_keywords?.evidence?.required_subtasks || []) : (task.boloo?.required_subtasks || []),
  };
}
const firstValue = (...values) => values.find(value => value !== undefined && value !== null && value !== '');
function selectedKeywordTerms(outputs) {
  const value = outputs.top20?.evidence?.selected_terms || outputs.top20?.selected_terms || [];
  return Array.isArray(value) ? value : [];
}
function keywordSource(item) {
  const sources = firstValue(item.origin_sources, item.sources, item.source, item.provider_source, item.source_id);
  return Array.isArray(sources) ? sources.join('、') : sources || '未记录';
}
function keywordPositions(term, outputs) {
  const explicit = outputs.keyword_layout?.terms?.find(item => firstValue(item.exact_string, item.query_text, item.keyword) === term);
  if (explicit) return firstValue(explicit.positions, explicit.placements, explicit.locations, explicit) || '未记录';
  const places = [];
  const textOf = value => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(textOf).join('\n');
    if (value && typeof value === 'object') return Object.entries(value).map(([key, child]) => ['content', 'text', 'value', 'nl', 'dutch'].includes(key) ? textOf(child) : textOf(child)).join('\n');
    return '';
  };
  const has = value => textOf(value).includes(term);
  if (has(outputs.title)) places.push('标题');
  const anchors = outputs.anchors?.content || outputs.anchors?.items || outputs.anchors;
  if (Array.isArray(anchors)) anchors.forEach((value, index) => { if (has(value)) places.push(`锚点 ${index + 1}`); });
  else if (has(anchors)) places.push('信息锚点');
  const description = textOf(outputs.description?.content || outputs.description);
  description.split(/\n\s*\n/).forEach((paragraph, index) => { if (paragraph.includes(term)) places.push(`描述第 ${index + 1} 段`); });
  if (has(outputs.attributes)) places.push('商品属性');
  if (has(outputs.packaging)) places.push('包装内容');
  return places.length ? `按文案原文匹配：${places.join('、')}` : '未找到原文匹配（位置数据未记录）';
}
function keywordMatrixItem(term, outputs) {
  const root = outputs.selling_matrix?.evidence?.items || outputs.selling_matrix?.items || outputs.selling_matrix?.content || outputs.selling_matrix;
  const visit = value => {
    if (!value) return null;
    if (Array.isArray(value)) { for (const item of value) { const found = visit(item); if (found) return found; } return null; }
    if (typeof value !== 'object') return null;
    if (firstValue(value.exact_string, value.query_text, value.keyword, value.term) === term) return value;
    for (const item of Object.values(value)) { const found = visit(item); if (found) return found; }
    return null;
  };
  return visit(root);
}
function renderKeywordDetail(task) {
  const data = keywordData(task);
  const outputs = data.outputs;
  const selected = selectedKeywordTerms(outputs);
  const candidates = data.candidates;
  const selectedMap = new Map(selected.map(item => [String(firstValue(item.exact_string, item.query_text, item.keyword, '')), item]));
  const sourceMap = new Map((Array.isArray(candidates) ? candidates : []).map(item => [String(firstValue(item.exact_string, item.query_text, item.keyword, '')), item]));
  const terms = [...new Set([...selectedMap.keys()].filter(Boolean))];
  const top20Rows = terms.length ? terms.map(term => {
    const item = selectedMap.get(term) || {};
    const candidate = sourceMap.get(term) || {};
    const matrix = keywordMatrixItem(term, outputs) || {};
    const chosen = item.selected === false ? '否' : '是';
    return `<tr><td><code>${escapeHtml(term)}</code></td><td>${escapeHtml(firstValue(item.boloo_search_volume, item.search_volume, item.confirmed_volume, candidate.confirmed_volume, candidate.confirmed_volume_evidence?.displayed_value, '未记录'))}</td><td>${escapeHtml(firstValue(item.relevance_explanation, item.relevance_basis, item.relevance_note, candidate.relevance_explanation, candidate.relevance_basis, '未记录'))}</td><td>${escapeHtml(keywordSource(item.origin_sources ? item : candidate))}</td><td>${escapeHtml(chosen)}</td><td>${escapeHtml(firstValue(item.selection_reason, item.inclusion_reason, candidate.selection_reason, candidate.exclusion_reason, '未记录'))}</td><td>${escapeHtml(firstValue(matrix.display_weight, matrix.weight_decision, matrix.priority_action, matrix.adjustment, matrix.decision, '未记录'))}</td><td>${escapeHtml(keywordPositions(term, outputs))}</td></tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">此版本尚无正式 TOP20 记录。</td></tr>';
  const candidateRows = Array.isArray(candidates) ? candidates.map(item => `<tr><td><code>${escapeHtml(firstValue(item.exact_string, item.query_text, item.keyword, '未记录'))}</code></td><td>${chip(item.candidate_status || item.status || '未记录')}</td><td>${escapeHtml(keywordSource(item))}</td><td>${escapeHtml(firstValue(item.confirmed_volume, item.confirmed_volume_evidence?.displayed_value, item.boloo_search_volume, item.search_volume, '未记录'))}</td><td>${escapeHtml(firstValue(item.exclusion_reason, item.selection_reason, item.reason, '—'))}</td><td>${escapeHtml(dateTime(item.updated_at))}</td></tr>`).join('') : '';
  const topVersion = firstValue(outputs.top20?.evidence?.version, outputs.top20?.version, data.snapshot?.versions?.top20, '未记录');
  const matrixVersion = firstValue(outputs.selling_matrix?.evidence?.version, outputs.selling_matrix?.version, data.snapshot?.versions?.selling_matrix, '未记录');
  const finalVersion = task.final_archive?.final_version_id || '尚未归档';
  const modeControl = task.final_archive ? `<div class="keyword-view-switch"><b>数据视图</b><button data-keyword-mode="snapshot" class="${data.archived ? 'selected' : ''}">上架时快照</button><button data-keyword-mode="current" class="${!data.archived ? 'selected' : ''}">当前工作数据</button></div>` : '';
  let content = '';
  if (keywordDetailTab === 'top20') content = `<div class="keyword-rule-note">TOP20 按《BOL 精品 Listing 固定 SOP》执行。此页只展示原始搜索量、相关性依据与已记录决策；不计算评分公式。</div><div class="table-scroll keyword-table"><table><thead><tr><th>Exact string</th><th>正式 Boloo 搜索量</th><th>相关性说明 / 依据</th><th>关键词来源</th><th>进入 TOP20</th><th>选入 / 排除原因</th><th>TOP20 后展示权重</th><th>实际使用位置</th></tr></thead><tbody>${top20Rows}</tbody></table></div><p class="keyword-footnote">TOP20 后的升权 / 保持 / 降权来自竞争卖点矩阵，与 TOP20 选词依据分开显示。评分字段（如历史遗留数据）不参与此页决策。</p>`;
  else if (keywordDetailTab === 'candidates') content = data.archived && !Array.isArray(candidates) ? '<div class="empty-detail">此历史 Final 未包含候选池快照；为避免把当前候选冒充历史数据，这里不展示实时池。</div>' : `<div class="table-scroll keyword-table"><table><thead><tr><th>Exact string</th><th>候选状态</th><th>来源</th><th>正式搜索量</th><th>排除 / 选择原因</th><th>最后更新</th></tr></thead><tbody>${candidateRows || '<tr><td colspan="6" class="empty">尚无候选词记录。</td></tr>'}</tbody></table></div>`;
  else if (keywordDetailTab === 'layout') content = `<div class="keyword-rule-note">布局位置按此 Listing 版本的原文定位；若显示“原文匹配”，代表精确字符串匹配，不代表语义判断。</div><div class="table-scroll keyword-table"><table><thead><tr><th>正式关键词</th><th>实际使用位置</th><th>Listing 版本</th></tr></thead><tbody>${terms.length ? terms.map(term => `<tr><td><code>${escapeHtml(term)}</code></td><td>${escapeHtml(keywordPositions(term, outputs))}</td><td>${escapeHtml(firstValue(outputs.title?.version, outputs.keyword_layout?.listing_version, data.archived ? finalVersion : '当前工作版本'))}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">此版本没有可追溯的正式关键词布局。</td></tr>'}</tbody></table></div>`;
  else {
    const subtaskRows = (data.subtasks || []).map(item => {
      const evidence = item.result?.evidence || item.evidence || {};
      return `<tr><td><code>${escapeHtml(firstValue(item.query_text, item.exact_string, item.competitor_url, '—'))}</code></td><td>${escapeHtml(item.source_id || item.provider_source || '—')}</td><td>${chip(item.status || item.result?.status)}</td><td>${escapeHtml(firstValue(evidence.observed_at, evidence.queried_at, item.updated_at, '—'))}</td><td>${escapeHtml(firstValue(evidence.business_date, evidence.amsterdam_business_date, '未记录'))}</td><td>${escapeHtml(firstValue(evidence.provider_method, item.provider_method, '—'))}</td><td>${escapeHtml(firstValue(evidence.displayed_value, evidence.value, '—'))}</td><td>${escapeHtml(firstValue(evidence.page_url, evidence.source_url, evidence.cache_record_id, '—'))}</td></tr>`;
    }).join('');
    content = `${detailFields([['查询日期 / 时间', firstValue(outputs.boloo_keywords?.created_at, data.snapshot?.captured_at)], ['Europe/Amsterdam 业务日期', firstValue(outputs.boloo_keywords?.evidence?.business_date, data.subtasks?.find(item => item.result?.evidence?.business_date)?.result?.evidence?.business_date)], ['Provider method', [...new Set((data.subtasks || []).map(item => item.result?.evidence?.provider_method || item.provider_method).filter(Boolean))].join('、')], ['TOP20 版本', topVersion], ['竞争卖点矩阵版本', matrixVersion], ['Final 版本', finalVersion], ['数据视图', data.archived ? '上架时不可变快照' : '当前工作数据']])}<h3>查询与来源证据</h3><div class="table-scroll keyword-table"><table><thead><tr><th>查询对象</th><th>来源 ID</th><th>状态</th><th>查询时间</th><th>业务日期</th><th>Provider method</th><th>页面结果</th><th>证据链接 / 缓存记录</th></tr></thead><tbody>${subtaskRows || '<tr><td colspan="8" class="empty">此视图没有查询证据记录。</td></tr>'}</tbody></table></div><h3>版本化输出</h3>${detailJson({ bol_keywords: outputs.bol_keywords || null, boloo_keywords: outputs.boloo_keywords || null, top20: outputs.top20 || null, selling_matrix: outputs.selling_matrix || null, keyword_layout: outputs.keyword_layout || null })}`;
  }
  return `${modeControl}<nav class="keyword-detail-tabs"><button data-keyword-tab="top20" class="${keywordDetailTab === 'top20' ? 'selected' : ''}">TOP20</button><button data-keyword-tab="candidates" class="${keywordDetailTab === 'candidates' ? 'selected' : ''}">完整候选池</button><button data-keyword-tab="layout" class="${keywordDetailTab === 'layout' ? 'selected' : ''}">Listing 布局</button><button data-keyword-tab="history" class="${keywordDetailTab === 'history' ? 'selected' : ''}">数据与历史</button></nav><div class="keyword-detail-content">${content}</div>`;
}
function bindKeywordDetail() {
  document.querySelectorAll('[data-keyword-tab]').forEach(button => button.addEventListener('click', () => { keywordDetailTab = button.dataset.keywordTab; void renderProductDetailTab('keywords'); }));
  document.querySelectorAll('[data-keyword-mode]').forEach(button => button.addEventListener('click', () => { keywordViewMode = button.dataset.keywordMode; void renderProductDetailTab('keywords'); }));
}
function renderCompetitorSourcePanel(task) {
  const candidates = task.competitor_candidates || [];
  const originals = task.competitor_source_records || [];
  const formal = task.competitor_url_list || [];
  const discovery = task.competitor_discovery || {};
  const candidateHtml = candidates.length ? candidates.slice().reverse().map(item => {
    const resolved = item.url_resolution_status === 'RESOLVED' && !!item.product_url;
    const placementFailed = item.url_resolution?.method === 'BOL_RETAILER_V10_PRODUCT_PLACEMENT' && item.url_resolution_status === 'FAILED';
    const evidence = item.product_list_evidence || {};
    const pendingReason = item.url_resolution?.method === 'BOL_RETAILER_V10_PRODUCT_PLACEMENT'
      ? (item.url_resolution?.error || item.url_resolution?.reason_code || 'URL_RESOLUTION_REQUIRED')
      : '等待 BOL Retailer API Product Placement 官方商品 URL';
    return `<article class="detail-history"><b>${escapeHtml(item.title || 'BOL 候选商品')} · ${escapeHtml(item.proposed_type || '—')}</b><span>候选状态：${escapeHtml(item.candidate_status || 'CANDIDATE_DISCOVERED')} · URL 解析：${escapeHtml(item.url_resolution_status || 'PENDING_RESOLUTION')} · 人工决定：${escapeHtml(item.decision_status || item.status || 'WAITING_CONFIRMATION')}</span><span>EAN：${escapeHtml(item.ean || '—')} · BOL 商品 ID：${escapeHtml(item.bol_product_id || '未提供')}</span><span>查询：${escapeHtml(item.discovery_query || '—')} · facts v${escapeHtml(item.facts_version || '—')}</span><small>匹配依据：${escapeHtml(JSON.stringify(item.match_basis || {}))}</small><small>Product List 证据：${escapeHtml(JSON.stringify({ provider: evidence.provider, request: evidence.request, response_source: evidence.response_source, cache_hit: evidence.cache_hit, observed_at: evidence.observed_at }))}</small>${resolved ? `<a href="${escapeHtml(item.product_url)}" target="_blank" rel="noopener">打开已解析的 BOL 商品详情页</a>` : `<p class="muted">${escapeHtml(pendingReason)} · 仅有 EAN/title，尚未取得并校验官方商品详情页；此候选不可确认采用，也不会进入 Boloo Extractor。</p>`}${item.status === 'WAITING_CONFIRMATION' ? `${resolved ? `<p><b>已解析商品页：</b><code>${escapeHtml(item.product_url)}</code></p>` : placementFailed ? `<label>真实 BOL 商品详情页 URL<input data-candidate-url="${escapeHtml(item.candidate_id)}" value="" placeholder="粘贴实际商品详情页链接（不能使用搜索结果页）" /></label>` : ''}<div class="art-text-actions">${resolved ? `<button class="button primary" data-competitor-decision="confirm" data-candidate-id="${escapeHtml(item.candidate_id)}">确认采用</button>` : placementFailed ? `<button class="button primary" data-competitor-url-resolve="true" data-candidate-id="${escapeHtml(item.candidate_id)}">提交商品页 URL 并解析</button>` : ''}<button class="button secondary" data-competitor-decision="reject" data-candidate-id="${escapeHtml(item.candidate_id)}">不采用</button></div>` : ''}<details><summary>Product List 返回证据</summary><pre>${escapeHtml(JSON.stringify(evidence.matched_product || {}, null, 2))}</pre></details></article>`;
  }).join('') : '<div class="empty-detail">暂无自动发现候选。</div>';
  const amazonStatus = discovery.amazon_status || (task.master?.product_facts?.amazon_reference ? 'EXISTING_SOURCE' : 'SOURCE_NOT_CONNECTED: AMAZON_DISCOVERY');
  return `<section class="detail-section competitor-source-panel"><h3>BOL 竞品来源补齐</h3><p>已有来源优先复用；只在字段缺失或 URL 格式无效时发现候选。Product List 的候选发现与商品详情页 URL 解析分开记录；未解析真实详情页的候选不能确认，也不能进入 Boloo Extractor。此处不做 SOP08 有效竞品判断。</p>${detailFields([['发现状态', discovery.status || 'NOT_STARTED'], ['已复用有效 URL', discovery.valid_existing_count ?? formal.filter(item => item.origin === 'USER_INPUT').length], ['本次 API 请求数', discovery.search_count ?? '—'], ['Amazon 来源', amazonStatus], ['正式 Extractor 来源数', formal.filter(item => item.usable_for_boloo_extractor).length]])}<button class="button secondary" id="discoverCompetitorCandidates">检查缺失并发现 BOL 候选</button><h4>正式来源 URL</h4>${formal.length ? `<div class="detail-file-list">${formal.map(item => `<article><span>${escapeHtml(item.source_header || item.proposed_type || item.source)} · ${escapeHtml(item.title || item.ean || '')}</span><a href="${escapeHtml(item.exact_url)}" target="_blank" rel="noopener">${escapeHtml(item.exact_url)}</a><small>${item.usable_for_boloo_extractor ? '已可作为后续 Boloo Extractor 输入' : '尚不可用'}</small></article>`).join('')}</div>` : '<div class="empty-detail">尚无有效 BOL 竞品 URL。</div>'}<h4>候选发现 / URL 解析 / 人工确认</h4>${candidateHtml}<details><summary>原始 URL 与校验历史（保留不覆盖）</summary>${originals.length ? `<div class="detail-file-list">${originals.map(item => `<article><span>${escapeHtml(item.source_header || '来源')} · ${escapeHtml(item.record_status || '—')}</span><code>${escapeHtml(item.raw_url || '')}</code><small>${escapeHtml(item.invalid_reason || `来源：${item.source_file || '—'} · ${item.source_cell || '—'} · checked ${item.checked_at || '—'}`)}</small></article>`).join('')}</div>` : '<div class="empty-detail">尚无来源检查记录。</div>'}</details></section>`;
}
const ART_CATEGORIES = ['主图', '卖点图', '规格图', '尺寸图', '配件 / 包装图', '场景图'];
const ART_SHORTCUTS = ['白底主图', '保持产品不变', '只修改文字', '只改背景', '突出配件', '突出尺寸', '删除物流/工厂信息', '保留包装文字', '沿用上一版布局', '添加 Logo', '移除 Logo'];
function renderArtworkBoard(task) {
  const archived = !!task.final_archive;
  const art = archived ? task.final_archive?.sidecars?.artwork : task.sidecars?.artwork;
  const rows = art?.images || [];
  const disabled = archived ? 'disabled' : '';
  const categories = ART_CATEGORIES.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  const cards = rows.map(image => {
    const current = image.versions?.find(item => Number(item.version) === Number(image.active_version)) || {};
    const versions = image.versions || [];
    return `<article class="art-image-card" data-art-card="${escapeHtml(image.image_id)}"><header><div><b>${escapeHtml(image.category)}</b><small>${escapeHtml(image.image_id)} · ${escapeHtml(image.status || '待制作')}</small></div>${chip(image.status || '待制作')}</header><div class="art-image-grid"><label>当前图片 / 文件引用<input data-art-image-ref value="${escapeHtml(current.image_ref || '')}" placeholder="美工回图后填写本地文件或版本引用" ${disabled}></label><label>查看版本<select data-art-version ${disabled}>${versions.map(version => `<option value="${escapeHtml(version.version)}" ${Number(version.version) === Number(image.active_version) ? 'selected' : ''}>V${escapeHtml(version.version)}${Number(version.version) === Number(image.active_version) ? ' · 当前' : ''}</option>`).join('') || '<option value="">暂无版本</option>'}</select></label></div><label class="art-wide">补充 / 复修要求<textarea data-art-prompt ${disabled}>${escapeHtml(current.prompt_extra || '')}</textarea></label><div class="art-shortcuts">${ART_SHORTCUTS.map(item => `<button type="button" data-art-shortcut="${escapeHtml(item)}" ${disabled}>${escapeHtml(item)}</button>`).join('')}</div><div class="art-image-grid"><label>Logo 操作<select data-art-logo-action ${disabled}><option value="KEEP" ${image.logo_action === 'KEEP' ? 'selected' : ''}>KEEP</option><option value="ADD" ${image.logo_action === 'ADD' ? 'selected' : ''}>ADD</option><option value="REMOVE" ${image.logo_action === 'REMOVE' ? 'selected' : ''}>REMOVE</option></select></label><label>品牌<input data-art-logo-brand value="${escapeHtml(image.logo?.brand || '')}" ${disabled}></label><label>Logo 来源文件<input data-art-logo-source value="${escapeHtml(image.logo?.source_file || '')}" ${disabled}></label><label class="art-wide">Logo 操作范围 / 位置 / 尺寸 / 透明度<input data-art-logo-spec value="${escapeHtml([image.logo?.scope, image.logo?.position, image.logo?.size, image.logo?.opacity].filter(Boolean).join(' / '))}" placeholder="逐张说明" ${disabled}></label><label class="art-check"><input type="checkbox" data-art-logo-confirmed ${image.logo?.confirmed ? 'checked' : ''} ${disabled}>Leon 已确认品牌与 Logo 素材</label><label class="art-check"><input type="checkbox" data-art-logo-real-brand ${image.logo?.removes_product_brand ? 'checked' : ''} ${disabled}>REMOVE 目标是产品 / 包装真实品牌标识</label></div><details class="art-review-details"><summary>审核结果与单图 QA</summary><div class="art-image-grid"><label>Qwen 视觉审核状态<select data-art-qwen-status ${disabled}>${['NOT_RUN', 'PASS', 'FAIL', 'WAITING_CONFIRMATION'].map(value => `<option ${current.qwen_review?.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Qwen 问题 / 事实确认点<input data-art-qwen-findings value="${escapeHtml(JSON.stringify(current.qwen_review?.findings || []))}" placeholder="审核结果摘要" ${disabled}></label><label class="art-wide">Qwen 拟新增事实（JSON，仅 Leon 确认写入时保存）<textarea data-art-qwen-proposed ${disabled}>${escapeHtml(JSON.stringify(current.qwen_review?.proposed_facts || {}, null, 2))}</textarea></label><div class="art-text-actions"><button class="button secondary" data-art-fact-decision="CONFIRM_WRITE" ${disabled}>确认写入</button><button class="button secondary" data-art-fact-decision="IGNORE" ${disabled}>忽略</button><button class="button secondary" data-art-fact-decision="NEED_MORE_INFO" ${disabled}>需要补资料</button></div><label>DeepSeek 文字审核状态<select data-art-deepseek-status ${disabled}>${['NOT_RUN', 'PASS', 'FAIL', 'WAITING_CONFIRMATION'].map(value => `<option ${current.deepseek_review?.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>DeepSeek 当前文字<input data-art-deepseek-current value="${escapeHtml(current.deepseek_review?.current_text || '')}" ${disabled}></label><label>中文原因<input data-art-deepseek-reason value="${escapeHtml(current.deepseek_review?.reason_zh || '')}" ${disabled}></label><label>建议完整版本<input data-art-deepseek-suggestion value="${escapeHtml(current.deepseek_review?.suggested_text || '')}" ${disabled}></label><div class="art-text-actions"><button class="button secondary" data-art-text-decision="CONFIRM_CHANGE" ${disabled}>确认修改</button><button class="button secondary" data-art-text-decision="DECLINE_CHANGE" ${disabled}>不修改</button><button class="button secondary" data-art-text-decision="MANUAL_EDIT" ${disabled}>人工编辑后重新审核</button></div><label>单图 QA<select data-art-qa ${disabled}>${['NOT_RUN', 'PASS', 'FAIL'].map(value => `<option ${current.qa?.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>QA / 审核证据<input data-art-qa-evidence value="${escapeHtml(JSON.stringify(current.qa?.evidence || {}))}" ${disabled}></label></div></details><div class="art-version-strip"><span>版本历史：${versions.map(version => `V${version.version}${version.image_ref ? ` (${version.image_ref})` : ''}`).map(escapeHtml).join(' → ') || '暂无'}</span><div><button class="button secondary" data-art-view-issues ${disabled}>查看审核问题</button><button class="button secondary" data-art-save ${disabled}>保存审核 / Logo</button><button class="button secondary" data-art-restore ${disabled}>恢复上一版</button><button class="button primary" data-art-rework ${disabled}>${versions.length ? '提交复修' : '提交制作'}</button><button class="button secondary" data-art-confirm ${disabled} ${current.qa?.status !== 'PASS' ? 'title="单图 QA 通过后可确认"' : ''}>确认通过</button></div></div></article>`;
  }).join('');
  const sourceRefs = task.master?.source_refs || [];
  const amazonRefs = task.outputs?.competitors?.evidence?.amazon_references || task.outputs?.competitors?.amazon_references || [];
  return `<div class="art-board-head"><div><h3>ARTWORK_SIDECAR 图片任务板</h3><small>${archived ? '已上传 Final 的图片快照（只读）' : '每张图片独立版本、审核和返工；图片生成和审核 Provider 由对应执行器接入'}</small>${!archived ? '<button class="row-action" id="artRefresh">刷新美工数据</button>' : ''}</div>${detailFields([['美工任务状态', art?.status || task.sidecars?.art?.status], ['单图数量', rows.length], ['整套图片 QA', art?.suite_qa?.status || 'NOT_RUN'], ['Leon 最终确认', art?.final_confirmed_at || '待确认']])}</div><div class="art-reference-columns"><section><b>Amazon 视觉参考区</b><p>只参考构图、信息层级、场景与收益表达，不作为商品事实来源。</p>${detailJson(amazonRefs)}</section><section><b>自家事实区</b><p>Prompt 事实仅可来自 Product Master、自家图片与确认资料。</p>${detailFields([['已确认事实', task.master?.product_facts], ['自家资料引用', sourceRefs], ['品牌', task.master?.brand]])}</section></div>${!archived ? `<div class="art-add-row"><label>新增图片分类<select id="artNewCategory">${categories}</select></label><button class="button primary" id="artAddImage">＋ 新建图片任务</button></div>` : ''}${cards || '<div class="empty-detail">还没有图片任务。按图片类别逐张创建。</div>'}<section class="art-suite"><header><div><b>整套图片一致性 QA</b><small>统一 SKU、颜色、配件数量、尺寸、参数、术语、Listing 文字与 Logo 规则</small></div>${chip(art?.suite_qa?.status || 'NOT_RUN')}</header><label>整套 QA 状态<select id="artSuiteStatus" ${disabled}>${['NOT_RUN', 'PASS', 'FAIL'].map(value => `<option ${art?.suite_qa?.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>证据 / 问题<textarea id="artSuiteEvidence" ${disabled}>${escapeHtml(JSON.stringify(art?.suite_qa?.evidence || {}) )}</textarea></label><div><button class="button secondary" id="artSaveSuite" ${disabled}>保存整套 QA</button><button class="button primary" id="artConfirmFinal" ${disabled}>Leon 确认美工 FINAL</button></div></section>`;
}
function bindOwnMaterialUpload() {
  const button = $('ownMaterialUpload');
  const input = $('ownMaterialFile');
  if (!button || !input) return;
  button.addEventListener('click', async () => {
    const file = input.files?.[0];
    if (!file) return toast('先选择当前 SKU 的自有资料文件。', true);
    if (file.size > 7 * 1024 * 1024) return toast('单份资料上限 7 MiB。', true);
    try {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const contentBase64 = dataUrl.split(',')[1] || '';
      await api(`/api/tasks/${encodeURIComponent(detailTask.sku)}/action`, { method: 'POST', body: JSON.stringify({ action: 'attach_own_material', payload: { filename: file.name, source_type: $('ownMaterialSourceType').value, source_label: $('ownMaterialSourceType').selectedOptions[0]?.textContent || '', content_type: file.type, content_base64: contentBase64 } }) });
      await refresh(); toast(`${detailTask.sku} · 自有资料已绑定，SOP01→SOP02 已重新执行。`);
    } catch (error) { toast(`${error.code ? `${error.code} · ` : ''}${error.message}`, true); }
  });
}

function bindCompetitorSources() {
  $('discoverCompetitorCandidates')?.addEventListener('click', () => runAction(detailTask.sku, 'discover_competitor_candidates'));
  document.querySelectorAll('[data-competitor-url-resolve]').forEach(button => button.addEventListener('click', async () => {
    const candidateId = button.dataset.candidateId;
    const urlInput = [...document.querySelectorAll('[data-candidate-url]')].find(input => input.dataset.candidateUrl === candidateId);
    await runAction(detailTask.sku, 'resolve_competitor_candidate_url', { candidate_id: candidateId, product_url: urlInput?.value || '' });
  }));
  document.querySelectorAll('[data-competitor-decision]').forEach(button => button.addEventListener('click', async () => {
    const candidateId = button.dataset.candidateId;
    const confirm = button.dataset.competitorDecision === 'confirm';
    const urlInput = [...document.querySelectorAll('[data-candidate-url]')].find(input => input.dataset.candidateUrl === candidateId);
    await runAction(detailTask.sku, confirm ? 'confirm_competitor_candidate' : 'reject_competitor_candidate', { candidate_id: candidateId, product_url: confirm ? urlInput?.value || '' : '' });
  }));
}

function bindArtworkBoard() {
  if (!detailTask || detailTask.final_archive) return;
  const saveAction = async (action, payload) => { await runAction(detailTask.sku, action, payload); detailTask = await api(`/api/tasks/${encodeURIComponent(detailTask.sku)}`).catch(() => detailTask); await renderProductDetailTab('images'); };
  $('artRefresh')?.addEventListener('click', async () => { detailTask = await api(`/api/tasks/${encodeURIComponent(detailTask.sku)}`).catch(() => detailTask); await renderProductDetailTab('images'); });
  $('artAddImage')?.addEventListener('click', () => saveAction('artwork_add_image', { category: $('artNewCategory').value }));
  document.querySelectorAll('[data-art-card]').forEach(card => {
    const image_id = card.dataset.artCard;
    const get = selector => card.querySelector(selector);
    const specLabel = get('[data-art-logo-spec]')?.closest('label');
    if (specLabel) {
      const fields = document.createElement('div'); fields.className = 'art-logo-fields';
      for (const [key, label] of [['scope', '操作范围'], ['position', '位置'], ['size', '尺寸'], ['opacity', '透明度']]) {
        const wrapper = document.createElement('label'); wrapper.textContent = label;
        const input = document.createElement('input'); input.dataset.artLogoField = key; input.value = detailTask.sidecars?.artwork?.images?.find(item => item.image_id === image_id)?.logo?.[key] || ''; input.disabled = !!detailTask.final_archive;
        wrapper.append(input); fields.append(wrapper);
      }
      specLabel.replaceWith(fields);
    }
    const versionSelect = get('[data-art-version]');
    const versionPreview = document.createElement('pre');
    versionPreview.className = 'art-version-preview';
    const versionGrid = versionSelect?.closest('.art-image-grid');
    versionGrid?.insertAdjacentElement('afterend', versionPreview);
    const renderVersionPreview = () => {
      const image = detailTask.sidecars?.artwork?.images?.find(item => item.image_id === image_id);
      const version = image?.versions?.find(item => Number(item.version) === Number(versionSelect?.value));
      versionPreview.textContent = JSON.stringify(version ? { version: version.version, status: version.status, executor_status: version.executor_status || '—', image_ref: version.image_ref, prompt_extra: version.prompt_extra, qwen_review: version.qwen_review, deepseek_review: version.deepseek_review, qa: version.qa } : { status: '无历史版本' }, null, 2);
    };
    versionSelect?.addEventListener('change', renderVersionPreview);
    renderVersionPreview();
    const versionActions = card.querySelector('.art-version-strip>div');
    if (versionActions && versionSelect) {
      const viewPrevious = document.createElement('button'); viewPrevious.type = 'button'; viewPrevious.className = 'button secondary'; viewPrevious.textContent = '查看上一版';
      viewPrevious.disabled = card.hasAttribute('disabled') || versionSelect.options.length < 2;
      viewPrevious.addEventListener('click', () => {
        const image = detailTask.sidecars?.artwork?.images?.find(item => item.image_id === image_id);
        const previous = [...(image?.versions || [])].filter(item => Number(item.version) < Number(image?.active_version)).sort((a, b) => Number(b.version) - Number(a.version))[0];
        if (previous) { versionSelect.value = previous.version; renderVersionPreview(); }
      });
      versionActions.prepend(viewPrevious);
    }
    const readLogo = () => ({ brand: get('[data-art-logo-brand]').value, source_file: get('[data-art-logo-source]').value, scope: get('[data-art-logo-field="scope"]').value, position: get('[data-art-logo-field="position"]').value, size: get('[data-art-logo-field="size"]').value, opacity: get('[data-art-logo-field="opacity"]').value, confirmed: get('[data-art-logo-confirmed]').checked, removes_product_brand: get('[data-art-logo-real-brand]').checked });
    const readReviews = () => {
      let proposed_facts = {};
      try { proposed_facts = JSON.parse(get('[data-art-qwen-proposed]').value || '{}'); }
      catch { toast('Qwen 拟新增事实必须是有效 JSON。', true); return null; }
      return { image_id, image_ref: get('[data-art-image-ref]').value, logo_action: get('[data-art-logo-action]').value, logo: readLogo(), qwen_review: { status: get('[data-art-qwen-status]').value, findings: get('[data-art-qwen-findings]').value, proposed_facts }, deepseek_review: { status: get('[data-art-deepseek-status]').value, current_text: get('[data-art-deepseek-current]').value, reason_zh: get('[data-art-deepseek-reason]').value, suggested_text: get('[data-art-deepseek-suggestion]').value }, qa: { status: get('[data-art-qa]').value, evidence: get('[data-art-qa-evidence]').value } };
    };
    card.querySelectorAll('[data-art-shortcut]').forEach(button => button.addEventListener('click', () => { const box = get('[data-art-prompt]'); box.value = `${box.value}${box.value ? '\n' : ''}${button.dataset.artShortcut}`; }));
    get('[data-art-view-issues]')?.addEventListener('click', () => { const panel = get('.art-review-details'); if (panel) { panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
    get('[data-art-save]')?.addEventListener('click', () => { const review = readReviews(); if (review) void saveAction('artwork_update_review', review); });
    card.querySelectorAll('[data-art-fact-decision]').forEach(button => button.addEventListener('click', () => {
      const review = readReviews();
      if (!review) return;
      void (async () => {
        await saveAction('artwork_update_review', review);
        await saveAction('artwork_fact_decision', { image_id, decision: button.dataset.artFactDecision, proposed_facts: review.qwen_review.proposed_facts });
      })();
    }));
    card.querySelectorAll('[data-art-text-decision]').forEach(button => button.addEventListener('click', () => saveAction('artwork_text_decision', { image_id, decision: button.dataset.artTextDecision, current_text: get('[data-art-deepseek-current]').value })));
    get('[data-art-rework]')?.addEventListener('click', () => saveAction('artwork_submit_rework', { image_id, prompt_extra: get('[data-art-prompt]').value }));
    get('[data-art-restore]')?.addEventListener('click', () => {
      const image = detailTask.sidecars?.artwork?.images?.find(item => item.image_id === image_id);
      const previous = [...(image?.versions || [])].filter(item => Number(item.version) < Number(image?.active_version)).sort((a, b) => Number(b.version) - Number(a.version))[0];
      if (previous) void saveAction('artwork_submit_rework', { image_id, prompt_extra: get('[data-art-prompt]').value, restore_version: Number(previous.version) });
      else toast('没有可恢复的上一版。', true);
    });
    get('[data-art-confirm]')?.addEventListener('click', () => saveAction('artwork_confirm_image', { image_id }));
  });
  $('artSaveSuite')?.addEventListener('click', () => saveAction('artwork_update_suite_qa', { suite_qa: { status: $('artSuiteStatus').value, evidence: $('artSuiteEvidence').value } }));
  $('artConfirmFinal')?.addEventListener('click', () => saveAction('artwork_confirm_final', {}));
}
function fileReferences(task) {
  const refs = new Set((task.master?.source_refs || []).map(String));
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && /file|path|output|workbook|image/i.test(key) && value.length < 1000) refs.add(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(item => visit(item, key));
    else for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(task.outputs || {});
  visit(task.files || {});
  visit(task.final_archive || {});
  return [...refs];
}
const ACCEPTANCE_LISTING_STEPS = [
  { id: 'LISTING_SOP_01', name: '01 · 读取自有资料', stage: 'LISTING_SOP_01', outputKey: 'own_materials_snapshot', tab: 'basic' },
  { id: 'LISTING_SOP_02', name: '02 · 确认真实产品事实', stage: 'LISTING_SOP_02', outputKey: 'confirmed_product_facts', tab: 'basic' },
  { id: 'LISTING_SOP_03', name: '03 · BOL / Amazon / Boloo 竞品关键词挖掘', stage: 'LISTING_SOP_03', tab: 'keywords' },
  { id: 'LISTING_SOP_04', name: '04 · 验证 5–7 个 BOL 关联/联想词', stage: 'bol_keywords', tab: 'keywords' },
  { id: 'LISTING_SOP_05', name: '05 · 建候选池并筛选约 20 个精确字符串', stage: 'LISTING_SOP_05', tab: 'keywords' },
  { id: 'LISTING_SOP_06', name: '06 · 查询 Boloo 月均搜索量', stage: 'boloo_keywords', tab: 'keywords' },
  { id: 'LISTING_SOP_07', name: '07 · 形成正式 TOP20', stage: 'top20', tab: 'keywords' },
  { id: 'LISTING_SOP_08', name: '08 · 建立 3–5 个有效竞品池', stage: 'LISTING_SOP_08', tab: 'listing' },
  { id: 'LISTING_SOP_09', name: '09 · BOL / Amazon 竞品深度及评论分析', stage: 'LISTING_SOP_09', tab: 'listing' },
  { id: 'LISTING_SOP_10', name: '10 · 提炼热卖点、痛点与购买理由', stage: 'LISTING_SOP_10', tab: 'listing' },
  { id: 'LISTING_SOP_11', name: '11 · 比较我方优势、持平和劣势', stage: 'LISTING_SOP_11', tab: 'listing' },
  { id: 'LISTING_SOP_12', name: '12 · 生成竞争卖点矩阵', stage: 'selling_matrix', tab: 'listing' },
  { id: 'LISTING_SOP_13', name: '13 · 关键词和卖点升权、保持或降权', stage: 'LISTING_SOP_13', tab: 'listing' },
  { id: 'LISTING_SOP_14', name: '14 · 输出最终标题', stage: 'title', tab: 'listing' },
  { id: 'LISTING_SOP_15', name: '15 · 输出 5 个产品专属信息锚点', stage: 'anchors', tab: 'listing' },
  { id: 'LISTING_SOP_16', name: '16 · 输出荷兰语描述、包装、属性及中文对照', stage: 'description', tab: 'listing' },
  { id: 'LISTING_SOP_17', name: '17 · 最终 QA 并交给 Codex 填表', stage: 'LISTING_SOP_17', tab: 'qa' },
];
function acceptanceState({ raw = 'NOT_STARTED', qa = 'NOT_RUN', hasOutput = false, final = false, current = false, taskStatus = '' } = {}) {
  const state = String(raw || '').toUpperCase();
  const qaState = String(qa || '').toUpperCase();
  const currentState = current ? String(taskStatus || '').toUpperCase() : '';
  if (qaState === 'FAIL' || state === 'QA_FAIL') return 'QA_FAIL';
  if (state === 'ERROR' || currentState === 'ERROR') return 'ERROR';
  if (state === 'WAITING_CONFIRMATION' || state === 'WAITING_DECISION' || currentState === 'WAITING_CONFIRMATION') return 'WAITING_CONFIRMATION';
  if (state === 'WAITING_DEPENDENCY' || state === 'WAITING_FOR_DEPENDENCY' || state === 'WAITING_FOR_PRODUCT_QA' || currentState === 'WAITING_DEPENDENCY') return 'WAITING_DEPENDENCY';
  if (state === 'PAUSED' || currentState === 'PAUSED') return 'PAUSED';
  if (qaState === 'PASS' || state === 'QA_PASS' || final || state === 'UPLOADED_ARCHIVED') return 'PASS';
  if (state === 'RUNNING' || state === 'GENERATING' || state === '生成中' || state === '复修中' || state === '重新审核' || state === 'AI审核' || currentState === 'RUNNING') return 'RUNNING';
  if (state === 'QUEUED') return 'QUEUED';
  if (hasOutput || ['DONE', 'COMPLETED', 'PASS', 'FINAL', 'READY', 'READY_FOR_UPLOAD'].includes(state)) return 'DONE_PENDING_QA';
  if (state === 'OPTIONAL' || state === 'NOT_APPLICABLE') return 'OPTIONAL';
  return 'NOT_STARTED';
}
function acceptanceRow(row) {
  const target = row.tab
    ? `<button class="acceptance-jump" data-acceptance-tab="${escapeHtml(row.tab)}">${escapeHtml(row.next || '打开处理页')} →</button>`
    : row.view ? `<button class="acceptance-jump" data-acceptance-view="${escapeHtml(row.view)}">${escapeHtml(row.next || '打开中心')} →</button>`
      : `<span class="acceptance-no-action">${escapeHtml(row.next || '无需操作')}</span>`;
  return `<tr><td><b>${escapeHtml(row.name)}</b>${row.step ? `<small>${escapeHtml(row.step)}</small>` : ''}</td><td>${row.required ? '是' : '否'}</td><td>${chip(row.status)}</td><td>${escapeHtml(row.progress || '—')}</td><td>${escapeHtml(dateTime(row.checkedAt))}</td><td>${escapeHtml(row.reason || '—')}</td><td>${target}</td></tr>`;
}
function acceptanceGroup(title, rows, hint = '') {
  return `<section class="acceptance-group"><header><b>${escapeHtml(title)}</b><span>${rows.length} 项</span></header>${hint ? `<p>${escapeHtml(hint)}</p>` : ''}<div class="table-scroll"><table class="acceptance-table"><thead><tr><th>模块 / 步骤</th><th>必需</th><th>当前状态</th><th>进度</th><th>最近核验</th><th>未完成原因</th><th>下一操作</th></tr></thead><tbody>${rows.map(acceptanceRow).join('')}</tbody></table></div></section>`;
}
function renderAcceptanceSummary(task) {
  const outputs = task.outputs || {};
  const qaMap = task.qa || {};
  const stages = task.stages || {};
  const issue = (task.issues || []).find(item => item.status !== 'CLOSED');
  const closeEvidenceSources = task.boloo?.discovery_close_evidence?.discovery_sources || {};
  const requiredSubtasks = task.boloo?.required_subtasks || [];
  const stepRows = ACCEPTANCE_LISTING_STEPS.map(spec => {
    const stage = spec.stage ? stages[spec.stage] || {} : {};
    const qa = spec.stage ? qaMap[spec.stage] || {} : (spec.sources || spec.discovery || spec.extractor ? qaMap.boloo_keywords || {} : {});
    const output = spec.outputKey ? outputs[spec.outputKey] : spec.stage ? outputs[spec.stage] || (spec.stage === 'qa' ? outputs.qa : null) : null;
    let hasOutput = !!output;
    let raw = stage.status || 'NOT_STARTED';
    let checkAt = qa.checked_at;
    let progress = output ? '1 / 1 产物' : '0 / 1 产物';
    let reason = '';
    if (spec.sources) {
      const sourceItems = spec.sources.map(key => closeEvidenceSources[key]);
      const completeCount = sourceItems.filter(item => item?.complete === true).length;
      hasOutput = completeCount > 0;
      raw = completeCount === sourceItems.length ? 'DONE' : completeCount ? 'DONE' : 'NOT_STARTED';
      progress = `${completeCount} / ${sourceItems.length} 来源完成`;
      reason = completeCount === sourceItems.length ? '来源记录齐全；此来源完成状态随 Boloo Stage QA 核验' : 'BOL / Amazon 发现来源尚未全部记录完成';
      checkAt = task.boloo?.discovery_close_evidence?.closed_at || null;
    } else if (spec.extractor) {
      const items = requiredSubtasks.filter(item => item.provider_source === 'keyword_extractor');
      const done = items.filter(item => ['PASS', 'PASS_NO_RESULT'].includes(item.status)).length;
      hasOutput = done > 0; raw = task.status === 'WAITING_DEPENDENCY' && task.current_step === 'boloo_keywords' ? 'WAITING_DEPENDENCY' : items.length && done === items.length ? 'DONE' : done ? 'DONE' : items.length ? (items.some(item => ['ERROR'].includes(item.status)) ? 'ERROR' : 'RUNNING') : 'NOT_STARTED';
      progress = `${done} / ${items.length} URL 查询完成`; checkAt = items.map(item => item.result?.observed_at || item.updated_at).filter(Boolean).sort().at(-1) || null;
      reason = items.length ? '按每个竞品 URL 独立展示 Provider Result；Stage QA 仍由完整 Boloo 阶段决定' : '尚无 Listing 内部竞品 URL 子任务';
    } else if (spec.discovery) {
      const active = (task.boloo?.candidates || []).filter(item => item.candidate_status === 'ACTIVE').length;
      hasOutput = !!task.boloo?.keyword_discovery_closed || (task.boloo?.candidates || []).length > 0;
      raw = task.boloo?.keyword_discovery_closed ? 'DONE' : hasOutput ? 'RUNNING' : 'NOT_STARTED';
      progress = `${(task.boloo?.candidates || []).length} 个候选 · ${active} 个待处理`;
      reason = task.boloo?.keyword_discovery_closed ? '发现已关闭；Boloo Stage QA 仍须 PASS' : '发现未关闭，继续处理或追加候选';
    } else if (spec.upload) {
      raw = task.final_archive ? 'UPLOADED_ARCHIVED' : task.status === 'READY_FOR_UPLOAD' ? 'WAITING_CONFIRMATION' : 'NOT_STARTED';
      hasOutput = !!task.final_archive || task.status === 'READY_FOR_UPLOAD';
      progress = task.final_archive ? 'Leon 已标记上传并归档' : task.status === 'READY_FOR_UPLOAD' ? '等待 Leon 完成上架后标记' : 'Listing 尚未进入待上传';
      reason = task.final_archive ? 'Final 已冻结' : task.status === 'READY_FOR_UPLOAD' ? '等待人工上架确认' : 'Listing QA / Excel QA 尚未全部通过';
      checkAt = task.final_archive?.archived_at || task.updated_at;
    } else if (spec.writeOnly) {
      const excel = outputs.excel || outputs.listing_excel || outputs.excel_qa;
      hasOutput = !!excel; raw = excel ? 'DONE' : (stages.excel_qa?.status || 'NOT_STARTED');
      progress = excel ? '文件已生成' : '0 / 1 文件'; reason = excel ? 'Excel 已写入，须再完成文件回读 QA' : '尚无生成的 Listing Excel';
    }
    const status = acceptanceState({ raw, qa: qa.status, hasOutput, final: raw === 'UPLOADED_ARCHIVED', current: !!spec.stage && task.current_step === spec.stage, taskStatus: task.status });
    if (!reason) reason = status === 'PASS' ? 'Stage QA 已通过' : status === 'ERROR' || status === 'QA_FAIL' ? (issue?.reason || task.error_message || qa.report?.join('；') || '当前步骤需要修复并重新核验')
      : status === 'WAITING_DEPENDENCY' ? (stage.dependency || task.waiting_dependency_key || '执行依赖未就绪')
        : status === 'WAITING_CONFIRMATION' ? '等待 Leon 确认' : status === 'PAUSED' ? '任务已暂停，可从保存的恢复点继续' : status === 'DONE_PENDING_QA' ? '产物已生成，Stage QA 尚未 PASS' : status === 'RUNNING' ? '当前步骤正在执行' : status === 'QUEUED' ? '等待 Worker 调度' : '尚未到达此步骤';
    return { name: spec.name, step: spec.id || spec.stage || 'SOP 映射项', required: true, status, progress, checkedAt: checkAt, reason, tab: spec.tab, next: status === 'PASS' ? '查看结果' : status === 'ERROR' || status === 'QA_FAIL' ? '查看核验' : '打开步骤' };
  });
  const masterQa = qaMap.LISTING_SOP_01 || qaMap.product_master || {};
  const sourceRefs = task.master?.source_refs || [];
  const productStatus = acceptanceState({ raw: stages.LISTING_SOP_01?.status || stages.product_master?.status, qa: masterQa.status, hasOutput: !!(task.outputs?.own_materials_snapshot || task.master?.name && sourceRefs.length), current: ['LISTING_SOP_01', 'product_master'].includes(task.current_step), taskStatus: task.status });
  const productRow = { name: 'Product Master / 产品资料', step: `事实版本 V${task.master?.fact_version || '—'}`, required: true, status: productStatus, progress: `${sourceRefs.length} 个来源资料`, checkedAt: masterQa.checked_at, reason: productStatus === 'PASS' ? '资料阶段 QA 已通过' : sourceRefs.length ? '产品资料尚未 Stage QA PASS' : '缺少自家产品资料来源', tab: 'basic', next: productStatus === 'PASS' ? '查看资料' : '补充资料' };
  const mabang = task.sidecars?.mabang || {};
  const mabangStatus = acceptanceState({ raw: mabang.status, qa: mabang.qa?.status, hasOutput: !!(mabang.output || mabang.export_file || mabang.status === 'EXPORTED'), current: false });
  const mabangRow = { name: '马帮 ERP 并行任务', step: mabang.current_step || mabang.dependency || '—', required: false, status: mabangStatus, progress: mabang.weight_conversion_status || mabang.schema_status || '—', checkedAt: mabang.qa?.checked_at, reason: mabang.blocking_reason || mabang.dependency_status || (mabangStatus === 'PASS' ? '单品 QA 已通过' : '并行任务状态'), tab: 'mabang', next: '查看马帮' };
  const artwork = task.final_archive?.sidecars?.artwork || task.sidecars?.artwork || {};
  const imageRows = (artwork.images || []).map(image => {
    const currentVersion = (image.versions || []).find(version => Number(version.version) === Number(image.active_version)) || {};
    const qa = currentVersion.qa || {};
    const status = acceptanceState({ raw: image.status, qa: qa.status, hasOutput: (image.versions || []).length > 0, final: image.status === 'FINAL', current: false });
    return { name: `美工 · ${image.category || '图片'}`, step: `${image.image_id || '—'} · V${image.active_version || '—'}`, required: false, status, progress: `${(image.versions || []).length} 个版本`, checkedAt: qa.checked_at || currentVersion.reviewed_at, reason: status === 'PASS' ? '该图片已由 Leon 确认 FINAL' : currentVersion.qwen_review?.status === 'WAITING_CONFIRMATION' ? 'Qwen 发现待确认的新事实' : status === 'DONE_PENDING_QA' ? '已生成，单图审核 / QA 或 Leon 确认未完成' : status === 'ERROR' || status === 'QA_FAIL' ? '当前图片需单独返工' : '图片任务尚未完成', tab: 'images', next: '打开图片任务' };
  });
  const artworkStatus = acceptanceState({ raw: artwork.status || task.sidecars?.art?.status, qa: artwork.suite_qa?.status, hasOutput: imageRows.length > 0, final: artwork.status === 'FINAL', current: false });
  imageRows.unshift({ name: 'ARTWORK_SIDECAR 整套', step: `${artwork.images?.length || 0} 张图片`, required: false, status: artworkStatus, progress: `整套 QA ${artwork.suite_qa?.status || 'NOT_RUN'}`, checkedAt: artwork.suite_qa?.checked_at || artwork.final_confirmed_at, reason: artworkStatus === 'PASS' ? '图片工作流已独立完成' : artworkStatus === 'WAITING_CONFIRMATION' ? '等待人工确认' : '美工与 Listing 并行，不作为 Listing 制作前置条件', tab: 'images', next: '打开美工任务板' });
  const research = researchTasks.find(item => item.sku === task.sku);
  const optionalRows = research ? [{ name: '独立竞品调研', step: research.current_step || '—', required: false, status: acceptanceState({ raw: research.status, qa: research.stage_qa_status, current: false }), progress: research.current_pool || '已创建', checkedAt: research.qa?.[research.current_step]?.checked_at, reason: '独立竞品调研与 Listing 制作分开运行', view: 'research', next: '打开竞品调研中心' }] : [{ name: '独立竞品调研', step: '未创建', required: false, status: 'OPTIONAL', progress: '未创建', checkedAt: null, reason: '仅在 Leon 主动加入竞品调研任务表后执行', view: 'research', next: '打开竞品调研中心' }];

  const openErrors = Number(task.open_error_count || (task.issues || []).filter(item => item.status !== 'CLOSED').length);
  const readyState = task.final_archive ? 'PASS' : task.status === 'READY_FOR_UPLOAD' || task.activity_pool === '待上传池' ? 'PASS' : acceptanceState({ raw: task.status === 'ERROR' ? 'ERROR' : stages.excel_qa?.status, qa: qaMap.excel_qa?.status, hasOutput: !!outputs.excel_qa, current: task.current_step === 'excel_qa', taskStatus: task.status });
  const excelState = acceptanceState({ raw: stages.excel_qa?.status, qa: qaMap.excel_qa?.status, hasOutput: !!outputs.excel_qa, current: task.current_step === 'excel_qa', taskStatus: task.status });
  const artRequirement = task.upload_requirements?.artwork_required ?? task.master?.product_facts?.artwork_required;
  const integrationRows = [
    { name: 'Listing Final / 可独立待上传', step: task.final_archive ? '已上传归档' : task.current_step || '—', required: true, status: task.final_archive ? 'PASS' : readyState, progress: task.final_archive ? 'Final 已冻结' : task.status === 'READY_FOR_UPLOAD' ? 'Listing_READY_FOR_UPLOAD' : 'Listing 尚未就绪', checkedAt: qaMap.qa?.checked_at, reason: readyState === 'PASS' ? 'Listing 与其 QA/Excel 流程已完成' : 'Listing 主流程未达到待上传状态', tab: 'qa', next: '查看 Listing QA' },
    { name: 'Excel 文件 QA', step: 'Excel QA', required: true, status: task.final_archive ? (task.final_archive.qa?.excel_qa?.status === 'PASS' || qaMap.excel_qa?.status === 'PASS' ? 'PASS' : excelState) : excelState, progress: qaMap.excel_qa?.status || '未核验', checkedAt: qaMap.excel_qa?.checked_at, reason: qaMap.excel_qa?.status === 'PASS' ? '文件回读核验通过' : outputs.excel_qa ? '文件已生成，回读 QA 尚未 PASS' : '尚无 Excel QA 通过记录', tab: 'qa', next: '查看文件 QA' },
    { name: 'SKU', step: task.sku || '缺失', required: true, status: task.sku ? 'PASS' : 'ERROR', progress: task.sku ? '已记录' : '缺失', checkedAt: masterQa.checked_at, reason: task.sku ? 'SKU 已记录' : '缺少 SKU', tab: 'basic', next: '查看资料' },
    { name: 'EAN', step: task.master?.ean || '缺失', required: true, status: task.master?.ean ? 'PASS' : 'NOT_STARTED', progress: task.master?.ean ? '已记录' : '缺失', checkedAt: masterQa.checked_at, reason: task.master?.ean ? 'EAN 已记录' : 'Product Master 尚未提供 EAN', tab: 'basic', next: '补充 EAN' },
    { name: '无未关闭异常', step: `OPEN_ERROR_COUNT=${openErrors}`, required: true, status: openErrors === 0 ? 'PASS' : 'ERROR', progress: openErrors === 0 ? '0' : `${openErrors} 项`, checkedAt: task.updated_at, reason: openErrors === 0 ? '无未关闭异常' : '先完成异常修复与重新核验', tab: openErrors ? 'qa' : 'history', next: openErrors ? '查看异常' : '查看历史' },
    { name: 'Artwork Final', step: artwork.status || task.sidecars?.art?.status || '未开始', required: artRequirement === true, status: artRequirement === false ? 'OPTIONAL' : artRequirement == null ? 'WAITING_CONFIRMATION' : artworkStatus, progress: `${artwork.images?.filter(image => image.status === 'FINAL').length || 0} / ${artwork.images?.length || 0} 张 FINAL`, checkedAt: artwork.final_confirmed_at, reason: artRequirement === false ? '该 SKU 已明确配置图片非必需' : artRequirement == null ? '未设置此 SKU 上架是否必须等待 Artwork Final；不会阻塞 Listing 主流程' : artworkStatus === 'PASS' ? '整套图片已通过 QA 并由 Leon 确认' : '此 SKU 要求 Artwork Final，当前尚未全部完成', tab: 'images', next: '查看图片状态' },
    { name: 'Product Master 来源资料', step: `${sourceRefs.length} 个来源`, required: true, status: sourceRefs.length && masterQa.status === 'PASS' ? 'PASS' : sourceRefs.length ? 'DONE_PENDING_QA' : 'NOT_STARTED', progress: sourceRefs.length ? '已提供' : '缺失', checkedAt: masterQa.checked_at, reason: sourceRefs.length && masterQa.status === 'PASS' ? '来源资料与产品资料 QA 均通过' : sourceRefs.length ? '产品资料 QA 尚未 PASS' : '缺少自有事实来源资料', tab: 'basic', next: '查看资料' },
  ];
  const mandatoryRows = integrationRows.filter(row => row.required);
  const unresolvedArtworkRequirement = artRequirement == null;
  const canUpload = mandatoryRows.every(row => row.status === 'PASS') && !unresolvedArtworkRequirement;
  const blockedRows = integrationRows.filter(row => row.required && row.status !== 'PASS');
  const aggregateStatus = canUpload ? 'PASS' : unresolvedArtworkRequirement ? 'WAITING_CONFIRMATION' : blockedRows.some(row => ['ERROR', 'QA_FAIL'].includes(row.status)) ? 'ERROR' : blockedRows.some(row => row.status === 'WAITING_DEPENDENCY') ? 'WAITING_DEPENDENCY' : 'DONE_PENDING_QA';
  const summary = `<div class="acceptance-summary-head"><div><span class="eyebrow">ACCEPTANCE SUMMARY</span><h3>${escapeHtml(task.sku)} · 验收总览</h3><small>PASS 只代表对应核验通过；产物生成但 Stage QA 未通过时显示“已完成待核验”。Listing 与美工独立运行。</small></div>${chip(aggregateStatus, canUpload ? 'good' : aggregateStatus === 'ERROR' ? 'bad' : 'work')}</div>`;
  const allRows = [...stepRows, productRow, mabangRow, ...imageRows, ...optionalRows, ...integrationRows];
  const countStatus = status => allRows.filter(row => row.status === status).length;
  const counts = `<div class="acceptance-counts"><span>已完成已核验 ${countStatus('PASS')}</span><span>已完成待核验 ${countStatus('DONE_PENDING_QA')}</span><span>正在处理 ${countStatus('RUNNING') + countStatus('QUEUED')}</span><span>待人工确认 ${countStatus('WAITING_CONFIRMATION')}</span><span>未完成 ${countStatus('NOT_STARTED')}</span><span>核验失败 / 异常 ${countStatus('QA_FAIL') + countStatus('ERROR')}</span><span>等待依赖 ${countStatus('WAITING_DEPENDENCY')}</span><span>已暂停 ${countStatus('PAUSED')}</span><span>可选 / 不适用 ${countStatus('OPTIONAL')}</span></div>`;
  const integration = `${acceptanceGroup('上传前整合', integrationRows, canUpload ? '所有已确认必需项通过，可以上架。' : `尚不可上架：${blockedRows.map(row => row.name).join('、') || '等待完成上架要求确认'}。该整合仅汇总状态，不改写 Listing 或美工工作流。`)}<div class="upload-readiness ${canUpload ? 'ready' : 'blocked'}"><b>${canUpload ? '可以上架' : `暂不可上架 · ${statusText(aggregateStatus)}`}</b><span>${canUpload ? 'Listing Final、Excel QA、SKU/EAN及已配置必需资料均通过。' : (blockedRows.map(row => `${row.name}：${row.reason}`).concat(unresolvedArtworkRequirement ? ['Artwork Final 是否必需尚未配置'] : []).join('；'))}</span></div>`;
  return `${summary}${counts}${acceptanceGroup('产品资料', [productRow])}${acceptanceGroup('马帮 ERP', [mabangRow], '马帮是 Listing 并行输出；其依赖或异常不阻塞 Listing。')}${acceptanceGroup('Listing', stepRows, '逐项读取当前 SKU 的实际 Stage 与 QA；只有 QA PASS 才显示已核验。')}${acceptanceGroup('美工', imageRows, 'ARTWORK_SIDECAR 独立于 Listing 文案，单图状态不会改变 Listing 阶段。')}${acceptanceGroup('可选任务', optionalRows, '独立竞品调研未创建时保持可选，不作为 Listing 前置条件。')}${integration}`;
}
async function renderProductDetailTab(tab = activeDetailTab) {
  if (!detailTask) return;
  activeDetailTab = tab;
  document.querySelectorAll('[data-detail-tab]').forEach(button => button.classList.toggle('selected', button.dataset.detailTab === tab));
  const task = detailTask;
  const master = task.master || {};
  const outputs = task.outputs || {};
  let html = '';
  if (tab === 'acceptance') html = renderAcceptanceSummary(task);
  else if (tab === 'basic') html = `<h3>Product Master v${escapeHtml(master.fact_version || '—')}</h3>${detailFields([['SKU', task.sku], ['产品名称', master.name], ['EAN', master.ean], ['品牌', master.brand], ['重量原值', master.weight_kg == null ? '—' : `${master.weight_kg} kg`], ['当前 SOP 步骤', task.listing_sop?.current_step_id || task.current_step], ['当前活动池', task.current_pool || task.activity_pool], ['来源资料', master.source_refs], ['绑定自有材料', (master.materials || []).map(item => `${item.original_name} · ${item.source_type} v${item.version}`)], ['确认核心词', master.confirmed_core_terms]])}<h3>绑定自有材料</h3><div class="material-upload"><select id="ownMaterialSourceType"><option value="OWN_PRODUCT">自家产品资料</option><option value="1688">1688 资料</option><option value="OWN_IMAGE">自家图片</option><option value="OWN_PHYSICAL">自家实物资料</option><option value="OWN_DOCUMENT">其他自有资料</option></select><input id="ownMaterialFile" type="file" accept=".json,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.pdf"><button class="button secondary" id="ownMaterialUpload">绑定并重新执行 SOP01→SOP02</button></div><small>只读取当前 SKU 的自有来源；BOL / Amazon 竞品材料不会成为产品事实。</small><h3>SOP01 自有资料快照</h3>${detailJson(task.outputs?.own_materials_snapshot || null)}<h3>SOP02 确认事实版本</h3>${detailJson(task.outputs?.confirmed_product_facts || task.outputs?.confirmed_product_facts_draft || null)}<h3>Product Master 原始事实</h3>${detailJson(master.product_facts)}`;
  else if (tab === 'mabang') html = `<h3>马帮并行任务</h3>${detailFields([['状态', task.sidecars?.mabang?.status], ['当前步骤', task.sidecars?.mabang?.current_step], ['依赖', task.sidecars?.mabang?.dependency], ['Schema', task.sidecars?.mabang?.schema_status], ['导出许可', task.sidecars?.mabang?.export_allowed], ['输入事实版本', task.sidecars?.mabang?.input_fact_version], ['重量换算', mabangSummary(task)]])}${detailJson(task.sidecars?.mabang)}`;
  else if (tab === 'images') html = renderArtworkBoard(task);
  else if (tab === 'keywords') html = renderKeywordDetail(task);
  else if (tab === 'listing') html = `<h3>Listing 产物</h3>${detailJson(Object.fromEntries(Object.entries(outputs).filter(([key]) => !['bol_keywords', 'boloo_keywords', 'top20', 'qa', 'excel_qa', 'art_review'].includes(key))))}`;
  else if (tab === 'qa') html = `<h3>阶段状态与核验</h3>${detailJson({ current_step: task.current_step, current_pool: task.current_pool || task.activity_pool, status: task.status, stage_qa_status: task.stage_qa_status, qa: task.qa, open_error_count: task.open_error_count, error_code: task.error_code, error_message: task.error_message, issues: task.issues })}`;
  else if (tab === 'history') {
    const data = await api(`/api/tasks/${encodeURIComponent(task.sku)}/history`);
    html = (data.history || []).length ? `<div class="detail-history">${data.history.slice().reverse().map(item => `<article><time>${dateTime(item.at)}</time><b>${escapeHtml(item.type)}</b><span>${escapeHtml(item.current_step || '—')} · ${escapeHtml(item.pool || '—')}</span><small>${escapeHtml(JSON.stringify(item.details || {}))}</small></article>`).join('')}</div>` : '<div class="empty-detail">暂无历史事件。</div>';
  } else if (tab === 'files') {
    const refs = fileReferences(task);
    html = refs.length ? `<div class="detail-file-list">${refs.map(ref => `<article><span>文件引用</span><code>${escapeHtml(ref)}</code></article>`).join('')}</div>` : '<div class="empty-detail">当前 SKU 尚无文件引用或输出文件。</div>';
  }
  if (tab === 'basic') html += renderCompetitorSourcePanel(task);
  $('detailPanel').innerHTML = html;
  document.querySelectorAll('[data-acceptance-tab]').forEach(button => button.addEventListener('click', () => { void renderProductDetailTab(button.dataset.acceptanceTab); }));
  document.querySelectorAll('[data-acceptance-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.acceptanceView)));
  if (tab === 'keywords') bindKeywordDetail();
  if (tab === 'images') bindArtworkBoard();
  if (tab === 'basic') { bindOwnMaterialUpload(); bindCompetitorSources(); }
  if (tab === 'keywords' && keywordDetailTab === 'history') {
    const data = await api(`/api/tasks/${encodeURIComponent(task.sku)}/history`).catch(() => ({ history: [] }));
    const snapshotMode = keywordViewMode === 'snapshot' && !!task.final_archive;
    const cutoff = snapshotMode && task.final_archive?.archived_at ? Date.parse(task.final_archive.archived_at) : Infinity;
    const items = (data.history || []).filter(item => !item.at || Date.parse(item.at) <= cutoff);
    const historyHtml = items.length ? `<h3>任务事件历史${snapshotMode ? '（截至上架时）' : ''}</h3><div class="detail-history">${items.slice().reverse().map(item => `<article><time>${dateTime(item.at)}</time><b>${escapeHtml(item.type)}</b><span>${escapeHtml(item.current_step || '—')} · ${escapeHtml(item.pool || '—')}</span><small>${escapeHtml(JSON.stringify(item.details || {}))}</small></article>`).join('')}</div>` : '<h3>任务事件历史</h3><div class="empty-detail">暂无任务历史。</div>';
    $('detailPanel').querySelector('.keyword-detail-content')?.insertAdjacentHTML('beforeend', historyHtml);
  }
}
async function openProductDetail(sku, initialTab = 'acceptance') {
  if (currentView !== 'productDetail') detailReturnView = currentView;
  detailTask = await api(`/api/tasks/${encodeURIComponent(sku)}`).catch(() => null);
  if (!detailTask) return toast(`找不到 SKU ${sku}。`, true);
  activeDetailTab = initialTab;
  keywordDetailTab = 'top20';
  keywordViewMode = detailTask.final_archive ? 'snapshot' : 'current';
  $('detailTitle').textContent = `${detailTask.sku} · ${detailTask.master?.name || '产品详情'}`;
  $('detailStatus').textContent = `${statusText(detailTask.status)} · ${detailTask.current_step || '—'} · ${detailTask.current_pool || detailTask.activity_pool || '—'} · 更新于 ${dateTime(detailTask.updated_at)}`;
  await renderProductDetailTab(initialTab);
  switchView('productDetail');
}

async function showResearchHistory(taskId) {
  const data = await api(`/api/competitor-research/tasks/${encodeURIComponent(taskId)}/history`);
  $('historyTitle').textContent = `竞品调研 · ${taskId} · 独立历史`;
  $('historyItems').innerHTML = (data.history || []).length ? data.history.slice().reverse().map(item => `<article class="history-item"><time>${dateTime(item.at)}</time><b>${escapeHtml(item.type)}</b><span>${escapeHtml(item.current_step)} · ${escapeHtml(item.current_pool)}</span><small>${escapeHtml(JSON.stringify(item.details || {}))}</small></article>`).join('') : '<div class="empty-detail">暂无独立调研历史。</div>';
  $('historyDialog').showModal();
}

function finalField(label, value) {
  const rendered = value == null || value === '' ? '尚未生成' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `<div class="final-field"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(rendered)}</dd></div>`;
}

async function showFinalArchive(sku) {
  const task = await api(`/api/tasks/${encodeURIComponent(sku)}`);
  const archive = task.final_archive;
  if (!archive) return toast('此 SKU 尚无已上传 Final 存档。', true);
  const out = archive.listing_outputs || {};
  const versions = archive.versions || {};
  $('finalTitle').textContent = `${sku} · 已上传 Final（锁定）`;
  $('finalItems').innerHTML = [
    finalField('Final 荷兰语标题', out.title?.content || out.title),
    finalField('5 个信息锚点', out.anchors?.content || out.anchors),
    finalField('荷兰语描述', out.description?.content || out.description),
    finalField('商品属性', out.attributes?.content || out.attributes),
    finalField('包装内容', out.packaging?.content || out.packaging),
    finalField('TOP20 关键词', out.top20?.content || out.top20),
    finalField('最终 Excel', out.excel_qa?.evidence?.file || out.excel_qa?.evidence),
    finalField('图片版本', versions.image || out.art_review?.evidence?.version),
    finalField('Product Master 事实版本', archive.product_master_version ?? archive.source_facts?.fact_version),
    finalField('关键词版本', versions.keywords || out.boloo_keywords?.evidence?.version),
    finalField('Listing 内部竞品数据版本（listing_competitor_data_version）', versions.listing_competitor_data_version ?? versions.competitors ?? out.competitors?.evidence?.version),
    finalField('QA 报告', archive.qa),
    finalField('上传日期 / 归档时间', `${archive.upload_date || '—'} / ${archive.archived_at || '—'}`),
    finalField('归档修改历史', `历史事件 ${task.revision || 0} 个版本；可从 SKU 历史查看完整操作事件。`),
  ].join('');
  $('finalDialog').showModal();
}

async function queueResearchTask() {
  const sku = $('researchSku').value;
  const seed = $('researchSeed').value.trim();
  if (!sku || !seed) return toast('请选择 SKU 并填写一个种子竞品 HTTPS URL。', true);
  try {
    const result = await api('/api/competitor-research/tasks', { method: 'POST', body: JSON.stringify({ sku, seed_competitor_url: seed }) });
    $('researchSeed').value = '';
    await refresh();
    toast(`${sku} 已加入独立竞品调研 · ${result.task.current_pool}；Listing 主任务未改变。`);
  } catch (error) { toast(`${error.code ? `${error.code} · ` : ''}${error.message}`, true); }
}

function switchView(name) {
  const labels = { board: '产品总看板', 'listing-overview': 'Listing 制作 · 总览', 'listing-prep': 'Listing 制作 · 资料与准备', 'listing-keywords': 'Listing 制作 · 关键词', 'listing-generation': 'Listing 制作 · Listing 生成', 'listing-qa': 'Listing 制作 · QA 与上传', 'listing-archive': 'Listing 制作 · 已上传存档', research: '竞品调研', pools: '全局活动池', exceptions: '异常中心', confirmations: '待人工确认', import: '导入产品', productDetail: `${detailTask?.sku || 'SKU'} · 产品详情` };
  document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
  $(`${name}View`).classList.add('active');
  document.querySelectorAll('.nav[data-view]').forEach(button => {
    const inListingSubnav = button.classList.contains('nav-sub');
    const active = inListingSubnav ? button.dataset.view === name : button.dataset.view === name || (button.dataset.view === 'listing-overview' && name.startsWith('listing-'));
    button.classList.toggle('active', active);
  });
  document.body.classList.toggle('listing-active', name.startsWith('listing-'));
  currentView = name;
  $('pageTitle').textContent = labels[name];
}

function csvRows(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const parse = line => { const values = []; let value = ''; let quoted = false; for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(value); value = ''; } else value += char; } values.push(value); return values; };
  const headers = parse(lines[0]).map(value => value.trim().toLowerCase());
  return lines.slice(1).map(line => Object.fromEntries(parse(line).map((value, index) => [headers[index] || '', value.trim()])));
}

async function importInput() {
  const input = $('importText').value.trim();
  if (!input) return toast('请先选择文件或粘贴 CSV / JSON 数据。', true);
  let products;
  try { products = input.startsWith('[') ? JSON.parse(input) : csvRows(input); }
  catch (error) { return toast(`导入格式错误：${error.message}`, true); }
  try {
    const result = await api('/api/products/import', { method: 'POST', body: JSON.stringify({ products, filename: pendingImportFilename, raw_content: input }) });
    const accepted = result.accepted; const rejected = result.rejected;
    $('importResult').classList.remove('hidden');
    $('importResult').innerHTML = `<div class="result-head"><b>导入完成</b><span>${accepted} 个已创建 · ${rejected} 个有错误</span></div><div class="result-list">${result.results.map(row => `<div class="result-row ${row.ok ? 'result-ok' : 'result-bad'}"><b>${escapeHtml(row.sku)}</b><span>${row.ok ? `${escapeHtml(row.task.activity_pool)} · 独立任务已建立` : escapeHtml(row.error.message)}</span></div>`).join('')}</div>`;
    $('importFeedback').textContent = `已接收 ${accepted} 个 SKU；失败 ${rejected} 个，其他 SKU 独立继续。`;
    await refresh();
    if (accepted) { pool = '全部产品'; switchView('board'); render(); toast(`${accepted} 个 SKU 独立任务已创建。`); }
  } catch (error) { toast(`导入失败：${error.message}`, true); }
}

function renderWorkbookPreview() {
  const target = $('sourceWorkbookPreview');
  if (!sourceWorkbookPreview) { target.innerHTML = ''; $('importValidatedWorkbook').disabled = true; return; }
  const report = sourceWorkbookPreview.validation;
  const rows = report.rows || [];
  const headerIssues = report.schema?.header_issues || [];
  const rowsHtml = rows.map(row => {
    const eligible = ['PASS', 'WAITING_CONFIRMATION'].includes(row.status);
    const issueText = (row.issues || []).map(item => `${item.code} · ${item.field || '行'} · ${item.message}`).join('；');
    const vals = ['品牌名','产品sku','产品EAN','中文名称','包装尺寸','1688采购链接','BOL直接竞品','BOL同类竞品1','BOL同类竞品2','BOL同类竞品3','BOL同类竞品4','Amazon参考']
      .map(header => row.raw_values?.[header] == null || String(row.raw_values[header]).trim() === '' ? '' : `${header}=${String(row.raw_values[header]).replace(/https?:\/\/([^/?#]+)[^\s]*/gi, 'URL:$1').slice(0, 100)}`)
      .filter(Boolean).join(' · ');
    const checked = eligible ? 'checked' : 'disabled';
    return `<tr class="${row.status === 'WAITING_CONFIRMATION' ? 'waiting-row' : eligible ? '' : 'blocked-row'}"><td><input type="checkbox" data-source-import-sku="${escapeHtml(row.sku)}" ${checked}></td><td>${escapeHtml(row.product_id || '—')}<small>${escapeHtml(row.sku || '无 SKU')} · 行 ${row.row_number}</small></td><td>${chip(row.status)}</td><td class="preview-values">${escapeHtml(vals || '无映射字段值')}</td><td class="preview-issues">${escapeHtml(issueText || (row.status === 'WAITING_CONFIRMATION' ? '品牌缺失；导入后进入人工确认' : '字段通过'))}</td></tr>`;
  }).join('');
  target.innerHTML = `<div class="table-card"><div class="table-heading"><div><b>SOURCE_SCHEMA_VALIDATION</b><span>${escapeHtml(report.schema?.sheet || '未识别工作表')} · 表头行 ${escapeHtml(report.schema?.header_row || '—')} · ${rows.length} 行在本次检查范围内</span></div>${chip(report.status, report.status === 'PASS' ? 'good' : 'bad')}</div>${headerIssues.length ? `<div class="preview-issues">${escapeHtml(headerIssues.map(item => `${item.code}:${item.header_name || item.canonical_field || item.header_index}`).join('；'))}</div>` : ''}<div class="table-scroll"><table><thead><tr><th>导入</th><th>产品ID / SKU</th><th>Schema状态</th><th>原始字段摘要</th><th>检测结果</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="5" class="empty">当前范围没有可检查的产品行。</td></tr>'}</tbody></table></div><small>表头位置按名称映射；列移动会记录为 Schema Drift。任何错位行不自动移动数据。</small></div>`;
  $('sourceWorkbookFeedback').textContent = `源文件副本已存入 BOL 数据区 · ${report.source_file_hash || ''} · 选择 PASS / 待确认行后导入`;
  $('importValidatedWorkbook').disabled = !rows.some(row => ['PASS', 'WAITING_CONFIRMATION'].includes(row.status));
}

async function validateSourceWorkbook() {
  const file = $('sourceWorkbookFile').files?.[0];
  if (!file) return toast('请先选择 XLSX 工作簿。', true);
  const ids = $('sourceWorkbookScope').value.split(',').map(value => value.trim()).filter(Boolean);
  $('sourceWorkbookFeedback').textContent = '正在只读解析所选范围…';
  try {
    const response = await fetch('/api/source-workbook/validate', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-BOL-Filename': encodeURIComponent(file.name), 'X-BOL-Product-IDs': ids.join(',') }, body: await file.arrayBuffer() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error?.message || `请求失败 ${response.status}`), { code: body.error?.code });
    sourceWorkbookPreview = body;
    renderWorkbookPreview();
    const bad = body.blocked_rows?.length || 0;
    toast(`检查完成：${body.eligible_rows?.length || 0} 行可导入/待确认，${bad} 行被 Schema 门禁拦截。`, bad > 0);
  } catch (error) { $('sourceWorkbookFeedback').textContent = `${error.code || '导入检查失败'} · ${error.message}`; toast(`${error.code || ''} ${error.message}`, true); }
}

async function importValidatedWorkbook() {
  if (!sourceWorkbookPreview?.preview_token) return toast('请先执行只读检查。', true);
  const skus = [...$('sourceWorkbookPreview').querySelectorAll('[data-source-import-sku]:checked')].map(input => input.dataset.sourceImportSku);
  if (!skus.length) return toast('请选择通过 Schema QA 的 SKU。', true);
  try {
    const result = await api('/api/source-workbook/import', { method: 'POST', body: JSON.stringify({ preview_token: sourceWorkbookPreview.preview_token, skus }) });
    toast(`Excel 导入完成：${result.accepted} 个接收，${result.rejected} 个失败；逐 SKU 独立处理。`, result.rejected > 0);
    await refresh();
    if (result.accepted) { pool = '全部产品'; switchView('board'); render(); }
  } catch (error) { toast(`${error.code || ''} ${error.message}`, true); }
}

async function exportCsv() {
  try {
    const result = await api('/api/export/tasks', { method: 'POST', body: '{}' });
    toast(`已保存 ${result.rows} 条任务到 BOL 副本：${result.file}`);
  } catch (error) { toast(`导出失败：${error.message}`, true); }
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('[data-open-import]').forEach(button => button.addEventListener('click', () => switchView('import')));
$('detailBack').addEventListener('click', () => switchView(detailReturnView));
$('detailTabs').querySelectorAll('[data-detail-tab]').forEach(button => button.addEventListener('click', () => { void renderProductDetailTab(button.dataset.detailTab); }));
$('refreshBtn').addEventListener('click', refresh);
$('importSubmit').addEventListener('click', importInput);
$('exportBtn').addEventListener('click', exportCsv);
$('closeHistory').addEventListener('click', () => $('historyDialog').close());
$('closeFinal').addEventListener('click', () => $('finalDialog').close());
$('queueResearch').addEventListener('click', queueResearchTask);
$('importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  pendingImportFilename = file.name;
  $('fileName').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  if (file.size > 10 * 1024 * 1024) { toast('导入文件上限 10 MiB。', true); event.target.value = ''; return; }
  $('importText').value = await file.text();
});
$('savePatch').addEventListener('click', async event => {
  event.preventDefault();
  try {
    const data = JSON.parse($('editPatch').value);
    const action = $('editDialog').dataset.action;
    await runAction(editingSku, action, action === 'fix' ? data : { patch: data.patch });
    $('editDialog').close();
  } catch (error) { toast(`修改内容必须是有效 JSON：${error.message}`, true); }
});

refresh();
setInterval(refresh, 5000);
