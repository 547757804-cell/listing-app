import http from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initialize, listTasks, importProducts, importExcelSourceProducts, exportTasks, getTask, getHistory, act, resumeReadyDependencies, listCompetitorResearchTasks, createCompetitorResearchTask, getCompetitorResearchHistory, finalizeSop03BolooProviderSources, readFreshBolooPaneRuntimeReadiness, officialWebBolooReady, evaluateSop06PaneResumePreflight, getActiveListingExecutionLeaseCount, withAcceptanceManualContinueScope } from './bol_core.mjs';
import { inspectSourceWorkbook, normalizeSourceWorkbookRows } from './excel_source_adapter.mjs';
import { bolIntegrationStatus } from './bol_retailer_client.mjs';
import { bolooIntegrationStatus } from './boloo_mcp_client.mjs';
import { bolApiReadiness, checkBolApiReadiness } from './bol_api_readiness.mjs';
import { runSop03BolooExtractors } from './listing_sop03_boloo_bridge.mjs';
import { reconcileSop06SuccessfulChildCheckpoint } from './listing_sop06_boloo_bridge.mjs';
import { persistSop09BolPageFacts, buildSop09BolApiEnrichmentPlan } from './sop09_bol_data_source.mjs';
import {
  READINESS_ONLY, RUNTIME_MODE, ACCEPTANCE_HOLD, BACKGROUND_PROVIDER_PROBE_ENABLED,
  DEPENDENCY_RESUME_ENABLED, TASK_AUTO_MUTATION_ENABLED, runtimeModeFields, setAcceptanceHold, isManualContinueRequired,
  runtimeConfigFields, getEffectiveRuntimePolicy, isRuntimeRequestAllowed, isManualProviderProbeAuthorized, createManualProviderProbeContext,
  createManualProviderProbeClaim, MANUAL_PROVIDER_PROBE_TYPES,
  acceptanceWorkbookImportScopeStatus, isAcceptanceCachedFinalizeScopeAllowed,
} from './runtime_mode.mjs';
import { getAiProviderReadiness, getAiProviderExecutionConfig, runAiGenerationCapabilityProbe, runDeepSeekSop10ResponsesShapeTest, resolveAiTimeoutConfiguration } from './ai_router.mjs';
import { latestGenerationFailureBarrierForProvider, readAiGenerationState } from './ai_generation_recovery.mjs';
import { buildSyntheticSop10ResponsesRequestShape, resolveSop10To17Inputs, buildListingProviderGenerationIdentity, promptFor, sop10To17OutputKey } from './listing_sop10_17_executor.mjs';
import { runQwenSop10RecoveryCapabilityProbe } from './qwen_sop10_recovery_probe.mjs';
import { runQwenListingStepRecoveryCapabilityProbe } from './qwen_listing_step_recovery_probe.mjs';
import { runDeepSeekListingStepRecoveryCapabilityProbe } from './deepseek_listing_step_recovery_probe.mjs';
import { planDeepSeekPromptContractMigration } from './sop10_recovery_evidence.mjs';
import { getListingSopJsonSchema } from './listing_sop_json_schemas.mjs';
import { aiProviderAdapters, aiProviderConfig, probeRegisteredAiProviders } from './ai_provider_adapters.mjs';
import { AI_PROVIDER_READINESS_EVIDENCE_SCHEMA, persistProviderReadinessEvidence } from './ai_provider_readiness_evidence.mjs';
import { resolveListingProviderRecoveryRouteReadiness } from './listing_provider_recovery_route.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(APP_DIR, '..');
const REQUIRED_ROOT = path.resolve(process.env.BOL_AUTO_ROOT || PROJECT_ROOT);
if (PROJECT_ROOT.toLowerCase() !== REQUIRED_ROOT.toLowerCase()) throw new Error('BOL_AUTO_ROOT must resolve to the application project root.');
const UI_DIR = path.join(PROJECT_ROOT, 'ui_shell', 'ui');
const STANDARD_DATA_ROOT = path.join(REQUIRED_ROOT, 'BOL数据');
const REQUESTED_DATA_ROOT = process.env.BOL_ACCEPTANCE_MODE === '1' ? process.env.BOL_ACCEPTANCE_DATA_ROOT : '';
const DATA_ROOT = REQUESTED_DATA_ROOT ? path.resolve(REQUESTED_DATA_ROOT) : STANDARD_DATA_ROOT;
if (DATA_ROOT !== STANDARD_DATA_ROOT) {
  const allowed = path.join(STANDARD_DATA_ROOT, '验收E2E');
  if (process.env.BOL_ACCEPTANCE_MODE !== '1' || !DATA_ROOT.toLowerCase().startsWith(`${allowed.toLowerCase()}${path.sep}`)) {
    throw new Error(`验收数据根必须位于 ${allowed} 内。`);
  }
}
const ACCEPTANCE_LIFECYCLE_LOG = process.env.BOL_RUNTIME_ENVIRONMENT === 'ACCEPTANCE_4181'
  && process.env.BOL_ACCEPTANCE_MODE === '1'
  ? path.join(DATA_ROOT, 'logs', 'acceptance-runtime-lifecycle.jsonl')
  : null;
const claimAcceptanceBolReadinessProbe = createManualProviderProbeClaim({
  endpoint: '/api/integrations/bol/readiness-check',
  probeType: MANUAL_PROVIDER_PROBE_TYPES.BOL_READINESS,
});
const PROCESS_STARTED_AT = new Date().toISOString();
let shutdownSource = null;
let lifecycleExitLogged = false;
let server = null;
let acceptanceQwenListingStepRecoveryProbeClaimed = false;
let acceptanceDeepSeekListingStepRecoveryProbeClaimed = false;
function safeLifecycleLog(event, extra = {}) {
  if (!ACCEPTANCE_LIFECYCLE_LOG) return;
  try {
    fsSync.mkdirSync(path.dirname(ACCEPTANCE_LIFECYCLE_LOG), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(), event, pid: process.pid,
      instance: 'ACCEPTANCE_4181', runtime_mode: RUNTIME_MODE,
      uptime_seconds: Math.floor(process.uptime()), shutdown_source: shutdownSource,
      ...extra,
    };
    fsSync.appendFileSync(ACCEPTANCE_LIFECYCLE_LOG, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
  } catch {
    // Lifecycle diagnostics must never hide or replace the original exit path.
  }
}
function safeErrorMetadata(error) {
  const value = error && typeof error === 'object' ? error : {};
  const clean = candidate => /^[A-Za-z0-9_.:-]{1,96}$/.test(String(candidate || '')) ? String(candidate) : null;
  return { error_name: clean(value.name), error_code: clean(value.code) };
}
if (ACCEPTANCE_LIFECYCLE_LOG) {
  safeLifecycleLog('PROCESS_START', { process_started_at: PROCESS_STARTED_AT });
  process.on('uncaughtException', error => {
    shutdownSource = 'UNCAUGHT_EXCEPTION';
    safeLifecycleLog('UNCAUGHT_EXCEPTION', safeErrorMetadata(error));
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    shutdownSource = 'UNHANDLED_REJECTION';
    safeLifecycleLog('UNHANDLED_REJECTION', safeErrorMetadata(reason));
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    shutdownSource = 'SIGTERM';
    safeLifecycleLog('SIGNAL_RECEIVED', { signal: 'SIGTERM' });
    if (server?.listening) server.close(() => process.exit(0)); else process.exit(0);
    setTimeout(() => process.exit(0), 5000).unref();
  });
  process.on('SIGINT', () => {
    shutdownSource = 'SIGINT';
    safeLifecycleLog('SIGNAL_RECEIVED', { signal: 'SIGINT' });
    if (server?.listening) server.close(() => process.exit(0)); else process.exit(0);
    setTimeout(() => process.exit(0), 5000).unref();
  });
  process.on('exit', code => {
    if (lifecycleExitLogged) return;
    lifecycleExitLogged = true;
    safeLifecycleLog('PROCESS_EXIT', { exit_code: Number(code), process_started_at: PROCESS_STARTED_AT });
  });
}

async function persistAiReadinessResults(providerNames, result) {
  const persisted = [];
  for (const provider of providerNames) {
    const adapterResult = result?.providers?.[provider];
    const providerConfig = (aiProviderConfig.providers || []).find(item => String(item?.name || '').toLowerCase() === provider.toLowerCase());
    const adapter = aiProviderAdapters.get(provider);
    if (!adapterResult || !providerConfig || !adapter) continue;
    persisted.push(await persistProviderReadinessEvidence({
      dataRoot: DATA_ROOT, provider, providerConfig,
      adapterMetadata: getAiProviderExecutionConfig(provider),
      result: adapterResult,
      runtimeEnvironment: process.env.BOL_RUNTIME_ENVIRONMENT,
      source: 'RUNTIME_CONTROL_PLANE_PROBE',
    }));
  }
  return persisted;
}
let acceptanceQwenControlProbeClaimed = false;
let acceptanceQwenSop10RecoveryProbeClaimed = false;
const acceptanceGenerationProbeClaims = new Set();
const HOST = '127.0.0.1';
const PORT = Number(process.env.BOL_ACCEPTANCE_MODE === '1' ? process.env.BOL_ACCEPTANCE_PORT || 4181 : 4180);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('BOL 服务端口配置无效。');
if (READINESS_ONLY && (process.env.BOL_ACCEPTANCE_MODE !== '1' || PORT !== 4181)) {
  throw Object.assign(new Error('READINESS_ONLY 仅允许在隔离的 4181 acceptance runtime 启动。'), { code: 'READINESS_ONLY_ACCEPTANCE_REQUIRED' });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw Object.assign(new Error('请求超过 10 MiB。'), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求必须是有效 JSON。'), { status: 400, code: 'JSON_INVALID' }); }
}

async function readRawBody(req, maxBytes = 80 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('工作簿超过80 MiB限制。'), { status: 413, code: 'WORKBOOK_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeImportFilename(rawName) {
  let decoded = String(rawName || 'source-workbook.xlsx');
  try { decoded = decodeURIComponent(decoded); } catch { /* Keep the provided name and sanitize it below. */ }
  return path.basename(decoded).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 140) || 'source-workbook.xlsx';
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const manualProbePaths = new Set([
    '/api/integrations/bol/readiness-check',
    '/api/integrations/ai/readiness-check',
    '/api/integrations/ai/qwen-control-plane-probe',
    '/api/integrations/ai/generation-capability-probe',
    '/api/integrations/ai/sop10-responses-shape-test',
    '/api/integrations/ai/qwen-sop10-recovery-probe',
    '/api/integrations/ai/qwen-listing-step-recovery-probe',
    '/api/integrations/ai/deepseek-listing-step-recovery-probe',
  ]);
  let cachedBody;
  let bodyWasRead = false;
  const readRequestBody = async () => {
    if (!bodyWasRead) { cachedBody = await readBody(req); bodyWasRead = true; }
    return cachedBody;
  };
  const isManualProbeEndpoint = req.method === 'POST' && manualProbePaths.has(url.pathname);
  if (ACCEPTANCE_HOLD && isManualProbeEndpoint) {
    cachedBody = await readRequestBody();
  }
  const manualProviderProbeContext = ACCEPTANCE_HOLD && isManualProbeEndpoint
    ? createManualProviderProbeContext({
      method: req.method, pathname: url.pathname, headers: req.headers,
      probeType: cachedBody?.probe_type, provider: cachedBody?.provider,
    })
    : null;
  req.manualProviderProbeContext = manualProviderProbeContext;
  const effectivePolicy = getEffectiveRuntimePolicy();
  if (!isRuntimeRequestAllowed(req.method, url.pathname, {
    runtimePolicy: effectivePolicy,
    manualProviderProbeContext,
    manualProviderProbeAuthorized: isManualProviderProbeAuthorized(req.headers),
  })) {
    const probeGateFailure = ACCEPTANCE_HOLD && isManualProbeEndpoint ? manualProviderProbeContext?.reason_code : null;
    const manualProbeAuthFailure = probeGateFailure === 'MANUAL_PROVIDER_PROBE_AUTH_REQUIRED';
    return send(res, 423, {
      error: {
        code: effectivePolicy.runtime_policy_status === 'INVALID_CONFIG' ? 'INVALID_CONFIG' : (probeGateFailure || (ACCEPTANCE_HOLD ? 'ACCEPTANCE_HOLD_ACTIVE' : 'BUSINESS_DISPATCH_DISABLED_READINESS_ONLY')),
        message: manualProbeAuthFailure
          ? 'Acceptance hold 下的 Provider probe 必须由人工显式授权。'
          : (ACCEPTANCE_HOLD ? 'Acceptance hold 已关闭业务写入与后台动作。' : '当前为只读就绪模式，业务任务入口已关闭。'),
      },
      ...runtimeModeFields(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    shutdownSource = 'API_SHUTDOWN';
    safeLifecycleLog('SHUTDOWN_REQUESTED', { shutdown_source: shutdownSource });
    send(res, 200, { stopped: true });
    setTimeout(() => server.close(() => process.exit(0)), 80).unref();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/runtime/acceptance-hold') {
    const body = await readBody(req);
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || !ACCEPTANCE_HOLD || body.hold !== false) {
      return send(res, 409, { error: { code: 'ACCEPTANCE_HOLD_RELEASE_REJECTED', message: '只允许在 NORMAL ACCEPTANCE_4181 中将当前活动 HOLD 单向解除。' }, ...runtimeModeFields() });
    }
    const policy = setAcceptanceHold(false, { manualContinueRequired: true, manualContinueSku: body.sku || null });
    // A runtime started under HOLD intentionally skipped task initialization.
    // Initialize synchronously at HOLD release, before any explicit Continue,
    // so a later dashboard poll cannot mistake a live task for restart recovery.
    await initialize(DATA_ROOT);
    return send(res, 200, { hold_released: true, automatic_resume: false, manual_continue_required: true, ...policy });
  }
  const sop06PaneResume = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sop06-pane-resume$/);
  if (req.method === 'POST' && sop06PaneResume) {
    const sku = decodeURIComponent(sop06PaneResume[1]);
    const body = await readBody(req);
    const policy = getEffectiveRuntimePolicy();
    if (READINESS_ONLY || RUNTIME_MODE !== 'NORMAL' || process.env.BOL_ACCEPTANCE_MODE !== '1'
      || ACCEPTANCE_HOLD || !isManualContinueRequired() || policy.manual_continue_sku !== sku) {
      return send(res, 409, { error: { code: 'SOP06_SCOPED_RESUME_NOT_AUTHORIZED' }, ...runtimeModeFields() });
    }
    const outcome = await withAcceptanceManualContinueScope(DATA_ROOT, sku, 'sop06-pane-resume', async () => {
      const task = await getTask(DATA_ROOT, sku);
      const activeLeaseCount = getActiveListingExecutionLeaseCount(DATA_ROOT, sku, 'LISTING_SOP_06');
      const paneReadiness = await readFreshBolooPaneRuntimeReadiness();
      const officialWebReady = officialWebBolooReady();
      const preflight = evaluateSop06PaneResumePreflight({ task, sku, expectedRevision: body.expected_revision,
        activeLeaseCount, runtimeMode: RUNTIME_MODE, acceptanceModeEnabled: process.env.BOL_ACCEPTANCE_MODE === '1',
        acceptanceHold: ACCEPTANCE_HOLD, manualContinueRequired: isManualContinueRequired(),
        manualContinueSku: policy.manual_continue_sku, paneReadiness, officialWebReady });
      if (!preflight.allowed) return { status: 409,
        body: { error: { code: 'SOP06_SCOPED_RESUME_PREFLIGHT_FAILED', failed: preflight.failed }, preflight,
          pane_readiness: paneReadiness, official_web_ready: officialWebReady } };
      const result = await resumeReadyDependencies(DATA_ROOT, { onlySku: sku, expectedRevision: Number(body.expected_revision) });
      return { status: 200, body: { ...result, preflight, hold_released: false,
        explicit_continue: true, external_readiness_probe: false } };
    });
    return send(res, outcome.status, { ...outcome.body, ...runtimeModeFields() });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const bolApi = await bolApiReadiness(DATA_ROOT);
    const config = runtimeConfigFields({ dataRoot: DATA_ROOT, port: PORT });
    const valid = config.runtime_policy_status === 'VALID';
    return send(res, valid ? 200 : 503, {
      status: valid ? 'OK' : 'INVALID_CONFIG', port: PORT, bol_api: bolApi,
      ...config,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/runtime/preflight') {
    return send(res, 200, {
      ...runtimeConfigFields({ dataRoot: DATA_ROOT, port: PORT }),
      data_root_validation: 'PASS',
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const tasks = await listTasks(DATA_ROOT);
    const bolApi = await bolApiReadiness(DATA_ROOT);
    const boloo = bolooIntegrationStatus();
    const moduleGates = {
      'CORE/ISOLATION': { status: 'PASS', blocks: [] },
      BOL_API_PRODUCTION: { status: bolApi.status === 'PASS' ? 'PASS' : 'WAITING_DEPENDENCY', blocks: ['bol_keywords'] },
      BOLOO_MCP: { status: boloo.BOLOO_MCP_READY ? 'PASS' : 'WAITING_DEPENDENCY', blocks: [] },
      BOLOO_OFFICIAL_WEB: { status: boloo.BOLOO_OFFICIAL_WEB_READY ? 'PASS' : 'WAITING_DEPENDENCY', blocks: boloo.BOLOO_OFFICIAL_WEB_READY ? [] : ['boloo_keywords'] },
      MABANG_SCHEMA: { status: 'WAITING_DECISION', blocks: ['mabang_export'] },
    };
    return send(res, 200, { product_count: tasks.length, tasks, data_root: DATA_ROOT, last_updated: new Date().toISOString(), module_gates: moduleGates, integrations: { bol: bolIntegrationStatus(bolApi), bol_api: bolApi, boloo }, ...runtimeConfigFields({ dataRoot: DATA_ROOT, port: PORT }) });
  }
  if (req.method === 'GET' && url.pathname === '/api/competitor-research/tasks') {
    return send(res, 200, { tasks: await listCompetitorResearchTasks(DATA_ROOT) });
  }
  if (req.method === 'POST' && url.pathname === '/api/competitor-research/tasks') {
    const body = await readBody(req);
    const task = await createCompetitorResearchTask(DATA_ROOT, body.sku, body.seed_competitor_url);
    return send(res, 201, { task });
  }
  const researchHistory = url.pathname.match(/^\/api\/competitor-research\/tasks\/([^/]+)\/history$/);
  if (req.method === 'GET' && researchHistory) {
    return send(res, 200, { task_id: researchHistory[1], history: await getCompetitorResearchHistory(DATA_ROOT, researchHistory[1]) });
  }
  const sop03BolooRun = url.pathname.match(/^\/api\/tasks\/([^/]+)\/listing\/sop03\/boloo-extractors$/);
  if (req.method === 'POST' && sop03BolooRun) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1') return send(res, 409, { error: { code: 'SOP03_PROVIDER_ACCEPTANCE_ONLY', message: '当前 WebView2 Provider bridge 仅允许在隔离 acceptance runtime 执行。' } });
    const body = await readBody(req);
    const result = await runSop03BolooExtractors(DATA_ROOT, decodeURIComponent(sop03BolooRun[1]), {
      bridgeDir: typeof body.bridge_dir === 'string' ? body.bridge_dir : undefined,
      requestTimeoutMs: Number.isFinite(Number(body.request_timeout_ms)) ? Math.min(120000, Math.max(5000, Number(body.request_timeout_ms))) : undefined,
      localSourceAudit: body.local_source_audit && typeof body.local_source_audit === 'object' ? body.local_source_audit : {},
    });
    return send(res, 200, result);
  }
  const sop03LocalAudit = url.pathname.match(/^\/api\/tasks\/([^/]+)\/listing\/sop03\/local-source-audit$/);
  if (req.method === 'POST' && sop03LocalAudit) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1') return send(res, 409, { error: { code: 'SOP03_SOURCE_AUDIT_ACCEPTANCE_ONLY', message: '当前来源审计接口仅允许在隔离 acceptance runtime 执行。' } });
    const body = await readBody(req);
    return send(res, 200, await finalizeSop03BolooProviderSources(DATA_ROOT, decodeURIComponent(sop03LocalAudit[1]), body.local_source_audit || {}));
  }
  const sop09PageFacts = url.pathname.match(/^\/api\/tasks\/([^/]+)\/listing\/sop09\/page-facts$/);
  if (req.method === 'POST' && sop09PageFacts) {
    const body = await readBody(req);
    const taskId = decodeURIComponent(sop09PageFacts[1]);
    const task = await getTask(DATA_ROOT, taskId);
    if (!task) return send(res, 404, { error: { code: 'TASK_NOT_FOUND', message: 'Listing task was not found.' } });
    const sop08Version = task.outputs?.listing_competitor_pool?.version;
    if (!sop08Version || sop08Version !== body.sop08_artifact_version) {
      return send(res, 409, { error: { code: 'SOP09_SOP08_VERSION_MISMATCH', message: '当前 task 的 SOP08 artifact 与请求版本不一致。' } });
    }
    const artifactPath = path.join(DATA_ROOT, 'artifacts', 'listing', task.sku, 'sop08', `${sop08Version}.json`);
    let sop08Artifact;
    try { sop08Artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8')); }
    catch { return send(res, 409, { error: { code: 'SOP09_SOP08_ARTIFACT_UNREADABLE', message: 'SOP08 artifact 不可读取。' } }); }
    const competitor = sop08Artifact.candidates?.find(item => item.competitor_id === body.competitor_id);
    if (!competitor) return send(res, 404, { error: { code: 'SOP09_COMPETITOR_NOT_FOUND', message: 'Competitor is not present in the referenced SOP08 artifact.' } });
    const result = await persistSop09BolPageFacts({
      dataRoot: DATA_ROOT, sku: task.sku, competitor, sop08Artifact, sop08ArtifactPath: artifactPath,
      pageProbeResult: body.page_probe_result, expectedSop08Version: body.sop08_artifact_version,
    });
    return send(res, result.qa.status === 'PASS' ? 201 : 422, {
      status: result.qa.status, page_facts: result.pageFacts, competitor_evidence_bundle: result.bundle,
      integration_qa: result.qa, artifact_dir: path.relative(DATA_ROOT, result.artifact_dir),
      bol_api_enrichment_plan: buildSop09BolApiEnrichmentPlan(result.bundle),
      task_state_mutated: false, sop09_started: false,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/integrations/bol/readiness') return send(res, 200, { ...(await bolApiReadiness(DATA_ROOT)), ...runtimeModeFields() });
  if (req.method === 'POST' && url.pathname === '/api/integrations/bol/readiness-check') {
    if (ACCEPTANCE_HOLD && !claimAcceptanceBolReadinessProbe(req.manualProviderProbeContext)) {
      return send(res, 409, { error: { code: 'BOL_MANUAL_READINESS_PROBE_ALREADY_CLAIMED' }, external_requests: 0, ...runtimeModeFields() });
    }
    return send(res, 200, { ...(await checkBolApiReadiness(DATA_ROOT)), ...runtimeModeFields() });
  }
  if (req.method === 'GET' && url.pathname === '/api/integrations/ai/readiness') return send(res, 200, { ...(await getAiProviderReadiness(DATA_ROOT)), ...runtimeModeFields() });
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/qwen-control-plane-probe') {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY) return send(res, 409, { error: { code: 'AI_CONTROL_PROBE_ACCEPTANCE_ONLY', message: 'Qwen control-plane probe is restricted to the active NORMAL acceptance runtime.' }, ...runtimeModeFields() });
    if (acceptanceQwenControlProbeClaimed) return send(res, 409, { error: { code: 'QWEN_CONTROL_PROBE_ALREADY_CLAIMED', message: 'This runtime has already claimed its one allowed Qwen control-plane probe.' }, ...runtimeModeFields() });
    acceptanceQwenControlProbeClaimed = true;
    const result = await probeRegisteredAiProviders(['Qwen'], { timeoutMs: resolveAiTimeoutConfiguration().provider_readiness_timeout_ms });
    const persisted = await persistAiReadinessResults(['Qwen'], result);
    const item = result.providers?.Qwen || {};
    const evidence = persisted.find(row => row.provider === 'Qwen') || null;
    const safeResult = {
      provider: 'Qwen', status: item.status || 'UNAVAILABLE', ready: item.ready === true,
      requested_model: item.requested_model || item.model || null,
      effective_model: item.effective_request_model || item.effective_model || null,
      returned_model: item.returned_model || null, http_status: item.http_status ?? item.diagnostics?.http_status ?? null,
      checked_at: item.checked_at || null, finish_reason: item.finish_reason || item.diagnostics?.finish_reason || null,
      content_state: item.diagnostics?.content_state || item.content_state || null,
      content_length: item.diagnostics?.content_length ?? item.content_length ?? null,
      json_parse: item.diagnostics?.json_parse_success === true ? 'PASS' : item.diagnostics?.json_parse_success === false ? 'FAIL' : 'NOT_REPORTED',
      schema_validation: item.diagnostics?.schema_validation_success === true ? 'PASS' : item.diagnostics?.schema_validation_success === false ? 'FAIL' : 'NOT_REPORTED',
      reason_code: item.reason_code || null,
    };
    return send(res, safeResult.ready && evidence?.status === 'READY' ? 200 : 503, {
      result: safeResult,
      evidence: evidence ? {
        schema: AI_PROVIDER_READINESS_EVIDENCE_SCHEMA, status: evidence.status, checked_at: evidence.checked_at, expires_at: evidence.expires_at,
        requested_model: evidence.requested_model, effective_model: evidence.effective_model, returned_model: evidence.returned_model,
        endpoint_identity_hash: evidence.endpoint_identity_hash, provider_config_hash: evidence.provider_config_hash,
        adapter_version: evidence.adapter_version, adapter_contract_version: evidence.adapter_contract_version,
        adapter_contract_hash: evidence.adapter_contract_hash, network_config_hash: evidence.network_config_hash,
        runtime_environment: evidence.runtime_environment, probe_type: evidence.probe_type, source: evidence.source,
        result_metadata: evidence.result_metadata,
      } : null,
      provider_dispatch_attempted: item.provider_dispatch_attempted === true,
      outbound_transport_started: item.outbound_transport_started === true,
      provider_http_response_received: item.provider_http_response_received === true,
      external_requests: Number(item.external_requests ?? item.external_request_count ?? 0),
      probe_execution_context: manualProviderProbeContext?.context || null,
      ...runtimeModeFields(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/readiness-check') {
    const names = ['Qwen', 'DeepSeek'];
    const result = await probeRegisteredAiProviders(names, { timeoutMs: resolveAiTimeoutConfiguration().provider_readiness_timeout_ms });
    await persistAiReadinessResults(names, result);
    return send(res, 200, { ...result, ...runtimeModeFields() });
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/generation-capability-probe') {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY) return send(res, 409, { error: { code: 'AI_GENERATION_PROBE_ACCEPTANCE_ONLY', message: 'Generation capability probes are explicit acceptance actions and are disabled in READINESS_ONLY and production modes.' }, ...runtimeModeFields() });
    const body = await readRequestBody();
    const provider = String(body.provider || '').toUpperCase();
    if (!['QWEN', 'DEEPSEEK'].includes(provider)) return send(res, 400, { error: { code: 'AI_GENERATION_PROBE_PROVIDER_INVALID', message: 'Probe provider must be QWEN or DEEPSEEK.' } });
    if (provider === 'DEEPSEEK' && acceptanceGenerationProbeClaims.has(provider)) return send(res, 409, { error: { code: 'DEEPSEEK_GENERATION_PROBE_ALREADY_CLAIMED', message: 'This runtime has already claimed its one allowed DeepSeek generation capability probe.' }, ...runtimeModeFields() });
    if (provider === 'DEEPSEEK') acceptanceGenerationProbeClaims.add(provider);
    const metadata = getAiProviderExecutionConfig(provider === 'DEEPSEEK' ? 'DeepSeek' : 'Qwen');
    const normalizedProvider = provider === 'DEEPSEEK' ? 'DeepSeek' : 'Qwen';
    const failureBarrierAt = await latestGenerationFailureBarrierForProvider(DATA_ROOT, normalizedProvider, metadata.effective_request_model);
    if (provider === 'DEEPSEEK' && !failureBarrierAt) return send(res, 400, { error: { code: 'AI_GENERATION_PROBE_BARRIER_REQUIRED', message: 'DeepSeek capability probe requires the current generation failure barrier timestamp.' } });
    const timeoutMs = provider === 'QWEN' && Number.isInteger(Number(body.timeout_ms))
      ? Math.max(1000, Math.min(120000, Number(body.timeout_ms))) : null;
    // Explicit manual Qwen generation probes are single-attempt diagnostics;
    // the synthetic request timeout is independently bounded from readiness.
    const result = await runAiGenerationCapabilityProbe(DATA_ROOT, provider, {
      failureBarrierAt, timeoutMs, retryLimit: provider === 'QWEN' ? 0 : null,
    });
    return send(res, result.status === 'PASS' ? 200 : 503, { ...result, probe_execution_context: manualProviderProbeContext?.context || null, prompt_logged: false, business_artifact_created: false, ...runtimeModeFields() });
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/sop10-responses-shape-test') {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || !ACCEPTANCE_HOLD) return send(res, 409, { error: { code: 'SOP10_RESPONSES_SHAPE_TEST_ACCEPTANCE_HOLD_REQUIRED' }, ...runtimeModeFields() });
    if (!manualProviderProbeContext?.authorized || manualProviderProbeContext.probe_type !== 'DEEPSEEK_SOP10_RESPONSES_SHAPE_CAPABILITY') {
      return send(res, 423, { error: { code: manualProviderProbeContext?.reason_code || 'MANUAL_PROVIDER_PROBE_TYPE_NOT_ALLOWED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (acceptanceGenerationProbeClaims.has('DEEPSEEK')) return send(res, 409, { error: { code: 'DEEPSEEK_GENERATION_PROBE_ALREADY_CLAIMED' }, ...runtimeModeFields() });
    acceptanceGenerationProbeClaims.add('DEEPSEEK');
    const metadata = getAiProviderExecutionConfig('DeepSeek');
    const failureBarrierAt = await latestGenerationFailureBarrierForProvider(DATA_ROOT, 'DeepSeek', metadata.effective_request_model);
    if (!failureBarrierAt) return send(res, 409, { error: { code: 'CURRENT_DEEPSEEK_FAILURE_BARRIER_MISSING' }, external_requests: 0, ...runtimeModeFields() });
    const fixture = buildSyntheticSop10ResponsesRequestShape();
    const result = await runDeepSeekSop10ResponsesShapeTest(DATA_ROOT, fixture, { failureBarrierAt });
    return send(res, result.status === 'PASS' ? 200 : result.status === 'FAIL' ? 503 : 409,
      { ...result, probe_execution_context: manualProviderProbeContext.context, prompt_logged: false, response_body_logged: false, reasoning_logged: false, business_artifact_created: false, ...runtimeModeFields() });
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/qwen-sop10-recovery-probe') {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || !ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL') {
      return send(res, 409, { error: { code: 'QWEN_SOP10_RECOVERY_HOLD_REQUIRED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (!manualProviderProbeContext?.authorized
      || manualProviderProbeContext.probe_type !== MANUAL_PROVIDER_PROBE_TYPES.QWEN_SOP10_RECOVERY) {
      return send(res, 423, { error: { code: manualProviderProbeContext?.reason_code || 'MANUAL_PROVIDER_PROBE_TYPE_NOT_ALLOWED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (acceptanceQwenSop10RecoveryProbeClaimed) {
      return send(res, 409, { error: { code: 'QWEN_SOP10_RECOVERY_PROBE_ALREADY_CLAIMED' }, external_requests: 0, ...runtimeModeFields() });
    }
    const body = await readRequestBody();
    if (!Number.isSafeInteger(Number(body.expected_revision))) {
      return send(res, 400, { error: { code: 'TASK_REVISION_CAS_REQUIRED' }, external_requests: 0, ...runtimeModeFields() });
    }
    const sku = 'SYNTHETIC-SKU-LEGACY-05';
    const task = await getTask(DATA_ROOT, sku);
    if (!task || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_05' || Number(task.revision) !== Number(body.expected_revision)) {
      return send(res, 409, { error: { code: task ? 'TASK_REVISION_CAS_CONFLICT' : 'TASK_NOT_FOUND', observed_revision: task?.revision ?? null }, external_requests: 0, ...runtimeModeFields() });
    }
    const localPreflight = await act(DATA_ROOT, sku, 'qwen_sop10_recovery_preflight', {});
    const requiredChecks = ['acceptance_scope', 'current_sop10_checkpoint', 'eligible_task_state', 'no_open_errors',
      'no_sop10_pass', 'no_active_lease', 'qwen_recovery_wait'];
    const failedChecks = requiredChecks.filter(key => localPreflight.recovery_preflight?.checks?.[key]?.status !== 'PASS');
    if (failedChecks.length || Number(localPreflight.task_revision) !== Number(body.expected_revision)) {
      return send(res, 409, { error: { code: 'QWEN_SOP10_PROBE_PRECONDITION_FAILED', failed_checks: failedChecks,
        expected_revision: Number(body.expected_revision), observed_revision: localPreflight.task_revision ?? null },
        external_requests: 0, ...runtimeModeFields() });
    }
    const inputs = await resolveSop10To17Inputs(DATA_ROOT, task, 'LISTING_SOP_10');
    const identity = buildListingProviderGenerationIdentity({ task, step: 'LISTING_SOP_10', inputs, provider: 'Qwen' });
    if (identity.generation_key !== localPreflight.recovery_preflight.generation_key) {
      return send(res, 409, { error: { code: 'QWEN_SOP10_IDENTITY_CHANGED_BEFORE_PROBE' }, external_requests: 0, ...runtimeModeFields() });
    }
    const metadata = getAiProviderExecutionConfig('Qwen');
    const failureBarrierAt = await latestGenerationFailureBarrierForProvider(DATA_ROOT, 'Qwen', metadata.effective_request_model);
    if (!failureBarrierAt || Date.parse(failureBarrierAt) !== Date.parse(String(task.ai_generation_waiting?.generation_failed_at || ''))
      || Date.parse(failureBarrierAt) !== Date.parse(String(task.dependency_failed_at || ''))
      || Date.parse(failureBarrierAt) !== Date.parse(String(task.required_readiness_after || ''))) {
      return send(res, 409, { error: { code: 'QWEN_SOP10_CURRENT_FAILURE_BARRIER_MISMATCH' }, external_requests: 0, ...runtimeModeFields() });
    }

    // The runtime claim and the durable identity/barrier claim both happen
    // before the single outbound request. A restart cannot repeat it.
    acceptanceQwenSop10RecoveryProbeClaimed = true;
    const result = await runQwenSop10RecoveryCapabilityProbe(DATA_ROOT, { task, identity, failureBarrierAt });
    if (result.status !== 'PASS' || Number(result.external_requests) !== 1) {
      return send(res, 503, { ...result, binding: 'NOT_BOUND', task_revision: task.revision,
        automatic_retry: false, business_task_mutated: false, ...runtimeModeFields() });
    }

    let currentTask = await getTask(DATA_ROOT, sku);
    if (!currentTask || currentTask.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_05') {
      return send(res, 409, { ...result, binding: 'NOT_BOUND', error: { code: 'TASK_IDENTITY_CHANGED_AFTER_PROBE' },
        external_requests: 1, automatic_retry: false, business_task_mutated: false, ...runtimeModeFields() });
    }
    if (Number(currentTask.revision) !== Number(task.revision)) {
      const currentInputs = await resolveSop10To17Inputs(DATA_ROOT, currentTask, 'LISTING_SOP_10');
      const currentIdentity = buildListingProviderGenerationIdentity({ task: currentTask, step: 'LISTING_SOP_10', inputs: currentInputs, provider: 'Qwen' });
      if (currentIdentity.generation_key !== result.target_generation_key
        || currentTask.current_step !== 'LISTING_SOP_10' || currentTask.resume_point !== 'LISTING_SOP_10'
        || currentTask.last_success_step !== 'LISTING_SOP_09' || currentTask.status !== 'WAITING_DEPENDENCY'
        || currentTask.waiting_dependency_key !== 'QWEN') {
        return send(res, 409, { ...result, binding: 'NOT_BOUND', error: { code: 'TASK_CHANGED_AFTER_PROBE' },
          external_requests: 1, automatic_retry: false, business_task_mutated: false, ...runtimeModeFields() });
      }
    }
    const binding = await act(DATA_ROOT, sku, 'qwen_sop10_generation_recovery_probe_bind', {
      expected_revision: Number(currentTask.revision), capability_evidence_ref: result.capability_evidence_ref,
    });
    const preflight = await act(DATA_ROOT, sku, 'qwen_sop10_recovery_preflight', {});
    return send(res, binding.binding === 'PASS' && preflight.recovery_preflight?.SOP10_RECOVERY_ROUTE_READY === true ? 200 : 409, {
      probe: result, binding, recovery_preflight: preflight.recovery_preflight,
      automatic_continue: false, task_revision: preflight.task_revision,
      external_requests: 1, ...runtimeModeFields(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/qwen-listing-step-recovery-probe') {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || !ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL') {
      return send(res, 409, { error: { code: 'QWEN_LISTING_STEP_RECOVERY_HOLD_REQUIRED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (!manualProviderProbeContext?.authorized
      || manualProviderProbeContext.probe_type !== MANUAL_PROVIDER_PROBE_TYPES.QWEN_LISTING_STEP_RECOVERY) {
      return send(res, 423, { error: { code: manualProviderProbeContext?.reason_code || 'MANUAL_PROVIDER_PROBE_TYPE_NOT_ALLOWED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (acceptanceQwenListingStepRecoveryProbeClaimed) {
      return send(res, 409, { error: { code: 'QWEN_LISTING_STEP_RECOVERY_PROBE_ALREADY_CLAIMED' }, external_requests: 0, ...runtimeModeFields() });
    }
    const body = await readRequestBody();
    const sku = String(body.sku || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sku) || !Number.isSafeInteger(Number(body.expected_revision))) {
      return send(res, 400, { error: { code: 'TASK_IDENTITY_AND_REVISION_CAS_REQUIRED' }, external_requests: 0, ...runtimeModeFields() });
    }
    const task = await getTask(DATA_ROOT, sku);
    if (!task || Number(task.revision) !== Number(body.expected_revision)) {
      return send(res, 409, { error: { code: task ? 'TASK_REVISION_CAS_CONFLICT' : 'TASK_NOT_FOUND', observed_revision: task?.revision ?? null }, external_requests: 0, ...runtimeModeFields() });
    }
    const step = task.current_step;
    const activeLeaseCount = await getActiveListingExecutionLeaseCount(DATA_ROOT, sku, step);
    if (!/^LISTING_SOP_1[1-7]$/.test(String(step || '')) || task.resume_point !== step
      || task.status !== 'WAITING_DEPENDENCY' || task.waiting_dependency_key !== 'QWEN'
      || task.last_success_step !== `LISTING_SOP_${String(Number(step.slice(-2)) - 1).padStart(2, '0')}`
      || task.ai_generation_waiting?.provider !== 'Qwen' || task.ai_generation_waiting?.step !== step
      || Number(task.open_error_count || 0) !== 0 || task.qa?.[step]?.status === 'PASS'
      || task.outputs?.[sop10To17OutputKey(step)]?.version || activeLeaseCount !== 0) {
      return send(res, 409, { error: { code: 'CURRENT_QWEN_LISTING_STEP_NOT_ELIGIBLE' }, active_lease_count: activeLeaseCount, external_requests: 0, ...runtimeModeFields() });
    }
    const inputs = await resolveSop10To17Inputs(DATA_ROOT, task, step);
    const identity = buildListingProviderGenerationIdentity({ task, step, inputs, provider: 'Qwen' });
    const wait = task.ai_generation_waiting;
    if (identity.generation_key !== wait.generation_key || identity.input_version_hash !== wait.input_version_hash
      || identity.prompt_hash !== wait.prompt_hash || identity.prompt_contract_version !== wait.prompt_contract_version
      || identity.effective_model !== wait.effective_model || identity.adapter_version !== wait.adapter_version
      || identity.adapter_contract_version !== wait.adapter_contract_version) {
      return send(res, 409, { error: { code: 'CURRENT_QWEN_LISTING_IDENTITY_MISMATCH' }, external_requests: 0, ...runtimeModeFields() });
    }
    const metadata = getAiProviderExecutionConfig('Qwen');
    const failureBarrierAt = await latestGenerationFailureBarrierForProvider(DATA_ROOT, 'Qwen', metadata.effective_request_model);
    if (!failureBarrierAt || Date.parse(failureBarrierAt) !== Date.parse(String(wait.generation_failed_at || ''))
      || Date.parse(failureBarrierAt) !== Date.parse(String(wait.required_generation_readiness_after || ''))
      || Date.parse(failureBarrierAt) !== Date.parse(String(task.dependency_failed_at || ''))
      || Date.parse(failureBarrierAt) !== Date.parse(String(task.required_readiness_after || ''))) {
      return send(res, 409, { error: { code: 'CURRENT_QWEN_FAILURE_BARRIER_MISMATCH' }, external_requests: 0, ...runtimeModeFields() });
    }
    const promptCharacters = promptFor(step, inputs).length;
    const schema = getListingSopJsonSchema(step);
    acceptanceQwenListingStepRecoveryProbeClaimed = true;
    const result = await runQwenListingStepRecoveryCapabilityProbe(DATA_ROOT, {
      task, identity, schema, targetCharacters: promptCharacters, failureBarrierAt, activeLeaseCount,
      adapterMetadata: metadata,
    });
    const currentTask = await getTask(DATA_ROOT, sku);
    const sameTaskState = currentTask && Number(currentTask.revision) === Number(task.revision)
      && currentTask.current_step === step && currentTask.resume_point === step
      && currentTask.status === 'WAITING_DEPENDENCY' && currentTask.waiting_dependency_key === 'QWEN'
      && currentTask.ai_generation_waiting?.generation_key === identity.generation_key;
    return send(res, result.status === 'PASS' && sameTaskState && Number(result.external_requests) === 1 ? 200 : 503, {
      ...result, task_revision: task.revision, task_unchanged: Boolean(sameTaskState), task_mutated: false,
      automatic_retry: false, business_artifact_created: false, qwen_business_call_count: 0,
      probe_execution_context: manualProviderProbeContext.context, prompt_logged: false,
      response_logged: false, reasoning_logged: false, ...runtimeModeFields(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/integrations/ai/deepseek-listing-step-recovery-probe') {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || !ACCEPTANCE_HOLD || RUNTIME_MODE !== 'NORMAL') {
      return send(res, 409, { error: { code: 'DEEPSEEK_LISTING_STEP_RECOVERY_HOLD_REQUIRED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (!manualProviderProbeContext?.authorized
      || manualProviderProbeContext.probe_type !== MANUAL_PROVIDER_PROBE_TYPES.DEEPSEEK_LISTING_STEP_RECOVERY) {
      return send(res, 423, { error: { code: manualProviderProbeContext?.reason_code || 'MANUAL_PROVIDER_PROBE_TYPE_NOT_ALLOWED' }, external_requests: 0, ...runtimeModeFields() });
    }
    if (acceptanceDeepSeekListingStepRecoveryProbeClaimed) {
      return send(res, 409, { error: { code: 'DEEPSEEK_LISTING_STEP_RECOVERY_PROBE_ALREADY_CLAIMED' }, external_requests: 0, ...runtimeModeFields() });
    }
    const body = await readRequestBody();
    const sku = String(body.sku || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sku) || !Number.isSafeInteger(Number(body.expected_revision))) {
      return send(res, 400, { error: { code: 'TASK_IDENTITY_AND_REVISION_CAS_REQUIRED' }, external_requests: 0, ...runtimeModeFields() });
    }
    const task = await getTask(DATA_ROOT, sku);
    if (!task || Number(task.revision) !== Number(body.expected_revision)) {
      return send(res, 409, { error: { code: task ? 'TASK_REVISION_CAS_CONFLICT' : 'TASK_NOT_FOUND', observed_revision: task?.revision ?? null }, external_requests: 0, ...runtimeModeFields() });
    }
    const step = task.current_step;
    const activeLeaseCount = await getActiveListingExecutionLeaseCount(DATA_ROOT, sku, step);
    if (sku !== 'SYNTHETIC-SKU-LEGACY-05' || task.master?.source_product_id !== 'SYNTHETIC_ACCEPTANCE_05' || step !== 'LISTING_SOP_14'
      || task.resume_point !== step || task.status !== 'WAITING_DEPENDENCY' || task.waiting_dependency_key !== 'DEEPSEEK'
      || task.last_success_step !== 'LISTING_SOP_13' || task.ai_generation_waiting?.provider !== 'DeepSeek'
      || task.ai_generation_waiting?.step !== step || Number(task.open_error_count || 0) !== 0
      || task.qa?.[step]?.status === 'PASS' || task.outputs?.[sop10To17OutputKey(step)]?.version || activeLeaseCount !== 0) {
      return send(res, 409, { error: { code: 'CURRENT_DEEPSEEK_SOP14_WAIT_NOT_ELIGIBLE' }, active_lease_count: activeLeaseCount, external_requests: 0, ...runtimeModeFields() });
    }
    const inputs = await resolveSop10To17Inputs(DATA_ROOT, task, step);
    const identity = buildListingProviderGenerationIdentity({ task, step, inputs, provider: 'DeepSeek' });
    const state = await readAiGenerationState(DATA_ROOT);
    const migrationPlan = planDeepSeekPromptContractMigration({ task, identity, state });
    if (!migrationPlan.migration || migrationPlan.wait?.generation_key !== identity.generation_key
      || Date.parse(String(migrationPlan.wait.generation_failed_at || '')) !== Date.parse(String(task.dependency_failed_at || ''))
      || Date.parse(String(task.required_readiness_after || '')) !== Date.parse(String(task.dependency_failed_at || ''))) {
      return send(res, 409, { error: { code: 'DEEPSEEK_SOP14_PROMPT_MIGRATION_NOT_VALID' }, external_requests: 0, ...runtimeModeFields() });
    }
    const qwenIdentity = buildListingProviderGenerationIdentity({ task, step, inputs, provider: 'Qwen' });
    const qwenProviderConfig = aiProviderConfig.providers?.find(item => String(item.name).toLowerCase() === 'qwen');
    const qwenRoute = await resolveListingProviderRecoveryRouteReadiness({ dataRoot: DATA_ROOT, provider: 'Qwen',
      identity: qwenIdentity, partialRecord: state.partial_results?.[qwenIdentity.generation_key] || null,
      providerConfig: qwenProviderConfig, adapterMetadata: getAiProviderExecutionConfig('Qwen'),
      runtimeEnvironment: process.env.BOL_RUNTIME_ENVIRONMENT });
    if (!qwenRoute.ready) return send(res, 409, {
      error: { code: 'QWEN_SOP14_ROUTE_NOT_READY', reason: qwenRoute.reason || null },
      qwen_route_source: qwenRoute.route_readiness_source, qwen_control_plane_evidence: qwenRoute.evidence,
      external_requests: 0, ...runtimeModeFields(),
    });
    const schema = getListingSopJsonSchema(step);
    const targetCharacters = promptFor(step, inputs).length;
    acceptanceDeepSeekListingStepRecoveryProbeClaimed = true;
    const result = await runDeepSeekListingStepRecoveryCapabilityProbe(DATA_ROOT, {
      task, identity, schema, targetCharacters, failureBarrierAt: task.dependency_failed_at,
      activeLeaseCount, migrationPlan,
    });
    const currentTask = await getTask(DATA_ROOT, sku);
    const sameTaskState = currentTask && Number(currentTask.revision) === Number(task.revision)
      && currentTask.current_step === step && currentTask.resume_point === step
      && currentTask.status === 'WAITING_DEPENDENCY' && currentTask.waiting_dependency_key === 'DEEPSEEK'
      && currentTask.ai_generation_waiting?.generation_key === task.ai_generation_waiting?.generation_key
      && currentTask.dependency_failed_at === task.dependency_failed_at;
    return send(res, result.status === 'PASS' && sameTaskState && Number(result.external_requests) === 1 ? 200 : 503, {
      ...result, task_revision: task.revision, task_unchanged: Boolean(sameTaskState), task_mutated: false,
      automatic_retry: false, business_artifact_created: false, qwen_business_call_count: 0,
      probe_execution_context: manualProviderProbeContext.context, prompt_logged: false,
      response_logged: false, reasoning_logged: false, ...runtimeModeFields(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/products/import') {
    const body = await readBody(req);
    let sourceFile = null;
    if (typeof body.raw_content === 'string') {
      const originalName = path.basename(String(body.filename || 'manual_import.json')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 140) || 'manual_import.json';
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}_${originalName}`;
      const file = path.join(DATA_ROOT, 'imports', name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body.raw_content, 'utf8');
      sourceFile = { file, sha256: crypto.createHash('sha256').update(body.raw_content).digest('hex') };
    }
    const result = await importProducts(DATA_ROOT, body.products);
    return send(res, 200, { ...result, source_file: sourceFile });
  }
  if (req.method === 'POST' && url.pathname === '/api/source-workbook/validate') {
    const policy = getEffectiveRuntimePolicy();
    const scopeHeader = String(req.headers['x-bol-product-ids'] || '').trim();
    const scopeIds = scopeHeader.split(',').map(value => value.trim()).filter(Boolean);
    if ((policy.acceptance_hold || policy.manual_continue_required) && scopeIds.length === 0) {
      return send(res, 400, { error: { code: 'SOURCE_PRODUCT_SCOPE_REQUIRED', message: 'Acceptance 状态下必须明确限定 Product ID 后才能验证工作簿。' } });
    }
    const bytes = await readRawBody(req);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return send(res, 400, { error: { code: 'XLSX_FILE_INVALID', message: '所选文件不是有效的 XLSX 工作簿。' } });
    const originalName = safeImportFilename(req.headers['x-bol-filename']);
    const importsDir = path.join(DATA_ROOT, 'imports', 'source-workbooks');
    await fs.mkdir(importsDir, { recursive: true });
    const token = crypto.randomUUID();
    const relativePath = path.join('imports', 'source-workbooks', `${token}_${originalName}`).replace(/\\/g, '/');
    const sourcePath = path.join(DATA_ROOT, relativePath);
    await fs.writeFile(sourcePath, bytes, { flag: 'wx' });
    const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const report = inspectSourceWorkbook(bytes, { sourceFile: relativePath, importVersion: 1, previousSchema: null, productIds: scopeIds.length ? scopeIds : null });
    report.source_file_hash = sourceHash;
    report.product_id_scope = scopeIds.length ? scopeIds : null;
    report.preview_token = token;
    const reportPath = path.join(importsDir, `${token}.validation.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    return send(res, 200, { preview_token: token, validation: report, eligible_rows: report.rows.filter(row => ['PASS', 'WAITING_CONFIRMATION'].includes(row.status)).map(row => ({ product_id: row.product_id, sku: row.sku, status: row.status })), blocked_rows: report.rows.filter(row => !['PASS', 'WAITING_CONFIRMATION'].includes(row.status)).map(row => ({ product_id: row.product_id, sku: row.sku, row_number: row.row_number, status: row.status, issues: row.issues })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/source-workbook/import') {
    const body = await readBody(req);
    const token = String(body.preview_token || '').replace(/[^a-f0-9-]/gi, '');
    if (!token) return send(res, 400, { error: { code: 'SOURCE_IMPORT_TOKEN_INVALID', message: '缺少有效的工作簿预检编号。' } });
    const importsDir = path.join(DATA_ROOT, 'imports', 'source-workbooks');
    const reportPath = path.join(importsDir, `${token}.validation.json`);
    let report;
    try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return send(res, 404, { error: { code: 'SOURCE_IMPORT_PREVIEW_NOT_FOUND', message: '预检结果不存在或已过期。' } }); throw error; }
    const selected = Array.isArray(body.skus) ? new Set(body.skus.map(value => String(value).trim())) : new Set();
    const policy = getEffectiveRuntimePolicy();
    if (policy.manual_continue_required) {
      const scopeCheck = acceptanceWorkbookImportScopeStatus(report, [...selected]);
      if (!scopeCheck.allowed) {
        return send(res, 403, { error: { code: 'ACCEPTANCE_IMPORT_SCOPE_MISMATCH', message: '手工继续状态下，只允许导入该预检记录中明确 Product ID scope 内的全部合格 SKU。' } });
      }
    }
    const allowedRows = report.rows.filter(row => selected.has(String(row.sku)) && ['PASS', 'WAITING_CONFIRMATION'].includes(row.status));
    if (!allowedRows.length) return send(res, 422, { error: { code: 'SOURCE_SCHEMA_VALIDATION_FAILED', message: '没有所选且通过 SOURCE_SCHEMA_VALIDATION 的SKU可以导入。' }, blocked_rows: report.rows.filter(row => selected.has(String(row.sku))).map(row => ({ sku: row.sku, status: row.status, issues: row.issues })) });
    const normalized = normalizeSourceWorkbookRows({ ...report, rows: allowedRows }, { sourceFilePath: report.source_file, sourceFileHash: report.source_file_hash });
    const result = await importExcelSourceProducts(DATA_ROOT, normalized);
    return send(res, 200, { ...result, imported_skus: normalized.map(row => row.sku), blocked_rows: report.rows.filter(row => selected.has(String(row.sku)) && !['PASS', 'WAITING_CONFIRMATION'].includes(row.status)).map(row => ({ sku: row.sku, status: row.status, issues: row.issues })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/export/tasks') {
    return send(res, 200, await exportTasks(DATA_ROOT));
  }
  const localReconciliation = url.pathname.match(/^\/api\/tasks\/([^/]+)\/local-state-reconciliation$/);
  if (req.method === 'POST' && localReconciliation) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || RUNTIME_MODE !== 'NORMAL'
      || !ACCEPTANCE_HOLD || getEffectiveRuntimePolicy().runtime_policy_status !== 'VALID') {
      return send(res, 409, { error: { code: 'LOCAL_STATE_RECONCILIATION_SCOPE_REJECTED', message: '本地校正仅允许在 NORMAL ACCEPTANCE_4181 且 HOLD=true 时执行。' }, ...runtimeModeFields() });
    }
    const sku = decodeURIComponent(localReconciliation[1]);
    const body = await readBody(req);
    const result = await act(DATA_ROOT, sku, 'RECONCILE_LOCAL_TASK_STATE', body);
    return send(res, 200, result);
  }
  const sop09InputBundleRegistration = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sop09-input-bundle-registration$/);
  if (req.method === 'POST' && sop09InputBundleRegistration) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || RUNTIME_MODE !== 'NORMAL'
      || !ACCEPTANCE_HOLD || getEffectiveRuntimePolicy().runtime_policy_status !== 'VALID') {
      return send(res, 409, { error: { code: 'SOP09_INPUT_BUNDLE_REGISTRATION_SCOPE_REJECTED', message: 'SOP09 输入登记仅允许在 NORMAL ACCEPTANCE_4181 且 HOLD=true 时执行。' }, ...runtimeModeFields() });
    }
    const sku = decodeURIComponent(sop09InputBundleRegistration[1]);
    const body = await readBody(req);
    const result = await act(DATA_ROOT, sku, 'register_sop09_input_bundle', body);
    return send(res, 200, result);
  }
  const sop09CachedQaRevalidation = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sop09-cached-qa-revalidation$/);
  if (req.method === 'POST' && sop09CachedQaRevalidation) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || RUNTIME_MODE !== 'NORMAL'
      || !ACCEPTANCE_HOLD || getEffectiveRuntimePolicy().runtime_policy_status !== 'VALID') {
      return send(res, 409, { error: { code: 'SOP09_CACHED_QA_REVALIDATION_SCOPE_REJECTED', message: 'SOP09缓存产物QA复核仅允许在NORMAL ACCEPTANCE_4181且HOLD=true时执行。' }, ...runtimeModeFields() });
    }
    const sku = decodeURIComponent(sop09CachedQaRevalidation[1]);
    const body = await readBody(req);
    const result = await act(DATA_ROOT, sku, 'revalidate_cached_sop09_qa', body);
    return send(res, 200, result);
  }
  const sop06PaneReconciliation = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sop06-pane-timeout-reconciliation$/);
  if (req.method === 'POST' && sop06PaneReconciliation) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || RUNTIME_MODE !== 'NORMAL'
      || !ACCEPTANCE_HOLD || getEffectiveRuntimePolicy().runtime_policy_status !== 'VALID') {
      return send(res, 409, { error: { code: 'SOP06_LOCAL_RECONCILIATION_SCOPE_REJECTED', message: 'SOP06 本地超时校正仅允许在 NORMAL ACCEPTANCE_4181 且 HOLD=true 时执行。' }, ...runtimeModeFields() });
    }
    const sku = decodeURIComponent(sop06PaneReconciliation[1]);
    const body = await readBody(req);
    const result = await act(DATA_ROOT, sku, 'RECONCILE_SOP06_PANE_TIMEOUT', body);
    return send(res, 200, result);
  }
  const sop06SuccessCheckpointReconciliation = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sop06-success-checkpoint-reconciliation$/);
  if (req.method === 'POST' && sop06SuccessCheckpointReconciliation) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || RUNTIME_MODE !== 'NORMAL'
      || !ACCEPTANCE_HOLD || getEffectiveRuntimePolicy().runtime_policy_status !== 'VALID') {
      return send(res, 409, { error: { code: 'SOP06_LOCAL_RECONCILIATION_SCOPE_REJECTED', message: '成功 checkpoint 本地校正仅允许在 NORMAL ACCEPTANCE_4181 且 HOLD=true 时执行。' }, ...runtimeModeFields() });
    }
    const sku = decodeURIComponent(sop06SuccessCheckpointReconciliation[1]);
    const body = await readBody(req);
    const result = await reconcileSop06SuccessfulChildCheckpoint(DATA_ROOT, sku, body);
    return send(res, 200, result);
  }
  const sop07CachedQaRevalidation = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sop07-cached-qa-revalidation$/);
  if (req.method === 'POST' && sop07CachedQaRevalidation) {
    if (process.env.BOL_ACCEPTANCE_MODE !== '1' || READINESS_ONLY || RUNTIME_MODE !== 'NORMAL'
      || !ACCEPTANCE_HOLD || getEffectiveRuntimePolicy().runtime_policy_status !== 'VALID') {
      return send(res, 409, { error: { code: 'SOP07_CACHED_QA_REVALIDATION_SCOPE_REJECTED', message: 'SOP07缓存QA恢复仅允许在 NORMAL ACCEPTANCE_4181 且 HOLD=true 时执行。' }, ...runtimeModeFields() });
    }
    const sku = decodeURIComponent(sop07CachedQaRevalidation[1]);
    const body = await readBody(req);
    const result = await act(DATA_ROOT, sku, 'finalize_cached_sop07_top20', body);
    return send(res, 200, result);
  }
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(history|action))?$/);
  if (match) {
    const sku = decodeURIComponent(match[1]);
    if (req.method === 'GET' && !match[2]) {
      const task = await getTask(DATA_ROOT, sku);
      return task ? send(res, 200, task) : send(res, 404, { error: { code: 'SKU_NOT_FOUND', message: 'SKU 不存在。' } });
    }
    if (req.method === 'GET' && match[2] === 'history') return send(res, 200, { sku, history: await getHistory(DATA_ROOT, sku) });
    if (req.method === 'POST' && match[2] === 'action') {
      const body = await readBody(req);
      if (ACCEPTANCE_HOLD) {
        const heldAction = String(body.action || '');
        const allowedHeldActions = new Set(['case_a_sop10_recovery_preflight', 'case_a_sop10_generation_recovery_probe_bind', 'recover_listing_transition', 'finalize_cached_listing_evidence_repair', 'finalize_cached_listing_step']);
        const scopedCachedFinalize = heldAction === 'finalize_cached_listing_step'
          && isAcceptanceCachedFinalizeScopeAllowed({ sku, dataRoot: DATA_ROOT, action: heldAction });
        const allowedSYNTHETIC_ACCEPTANCE_10RecoveryAction = sku === 'SYNTHETIC-SKU-LEGACY-10' && allowedHeldActions.has(heldAction);
        const allowedSYNTHETIC_ACCEPTANCE_05DeepSeekRecoveryAction = sku === 'SYNTHETIC-SKU-LEGACY-05'
          && ['deepseek_listing_step_recovery_preflight', 'deepseek_listing_step_generation_recovery_probe_bind'].includes(heldAction)
          && process.env.BOL_ACCEPTANCE_MODE === '1' && RUNTIME_MODE === 'NORMAL' && !READINESS_ONLY;
        if (!scopedCachedFinalize && !allowedSYNTHETIC_ACCEPTANCE_10RecoveryAction && !allowedSYNTHETIC_ACCEPTANCE_05DeepSeekRecoveryAction) {
          return send(res, 423, { error: { code: 'ACCEPTANCE_HOLD_ACTIVE', message: 'HOLD期间仅允许当前验收SKU的精确范围本地恢复控制操作。' }, ...runtimeModeFields() });
        }
      } else if (isManualContinueRequired() && !['continue', 'pause'].includes(String(body.action || ''))) {
        return send(res, 423, { error: { code: 'MANUAL_CONTINUE_REQUIRED', message: 'HOLD解除后仅允许当前锁定 SKU 的明确 Continue 或安全 Pause 操作。' }, ...runtimeModeFields() });
      }
      const runTaskAction = async () => {
        const actionName = String(body.action || '');
        const currentPolicy = getEffectiveRuntimePolicy();
        const scopedManualTransition = ['continue', 'pause'].includes(actionName)
          && isManualContinueRequired() && currentPolicy.manual_continue_sku === sku;
        const scopedPayload = { ...(body.payload || {}) };
        if (scopedManualTransition) {
          // The operator authorized this one SKU transition. Read the live
          // revision server-side immediately before act(); act() still checks
          // it under the SKU serializer, so a concurrent write fails closed.
          const currentTask = await getTask(DATA_ROOT, sku);
          if (!currentTask || !Number.isSafeInteger(Number(currentTask.revision))) {
            throw Object.assign(new Error('无法读取当前任务 revision，已取消状态操作。'), { code: 'TASK_REVISION_UNAVAILABLE' });
          }
          scopedPayload.expected_revision = Number(currentTask.revision);
        }
        if (String(body.action || '') === 'continue') {
          const current = await getTask(DATA_ROOT, sku);
          if (current?.current_step === 'LISTING_SOP_03') {
            return runSop03BolooExtractors(DATA_ROOT, sku, {
              localSourceAudit: body.payload?.local_source_audit && typeof body.payload.local_source_audit === 'object' ? body.payload.local_source_audit : {},
            });
          }
        }
        return act(DATA_ROOT, sku, actionName, scopedPayload);
      };
      const policy = getEffectiveRuntimePolicy();
      const manualScopedAction = String(body.action || '');
      if (['continue', 'pause'].includes(manualScopedAction) && isManualContinueRequired()
        && policy.manual_continue_sku === sku) {
        return send(res, 200, await withAcceptanceManualContinueScope(DATA_ROOT, sku, manualScopedAction, runTaskAction));
      }
      return send(res, 200, await runTaskAction());
    }
  }
  if (req.method === 'GET') {
    const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'bol.js', 'bol.css', 'styles.css', 'integration.css', 'boloo-test.html'].includes(asset)) return send(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在。' } });
    const target = path.join(UI_DIR, asset);
    const body = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(asset)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(body);
  }
  return send(res, 404, { error: { code: 'NOT_FOUND', message: '路径不存在。' } });
}

if (getEffectiveRuntimePolicy().task_auto_mutation_enabled) await initialize(DATA_ROOT);
let bolReadinessRefresh = null;
let bolReadinessRetryAt = 0;
async function refreshExpiredBolReadiness() {
  if (!getEffectiveRuntimePolicy().background_provider_probe_enabled) return null;
  if (process.env.BOL_ACCEPTANCE_MODE === '1') return null;
  const readiness = await bolApiReadiness(DATA_ROOT);
  if (!readiness.enabled || readiness.status !== 'STALE_READINESS_CHECK' || Date.now() < bolReadinessRetryAt) return readiness;
  if (!bolReadinessRefresh) {
    bolReadinessRefresh = checkBolApiReadiness(DATA_ROOT)
      .then(result => {
        bolReadinessRetryAt = result.status === 'PASS' ? 0 : Date.now() + 5 * 60 * 1000;
        return result;
      })
      .catch(error => {
        bolReadinessRetryAt = Date.now() + 5 * 60 * 1000;
        console.error(`BOL readiness refresh failed: ${error?.code || 'READINESS_REFRESH_FAILED'}`);
        return null;
      })
      .finally(() => { bolReadinessRefresh = null; });
  }
  return bolReadinessRefresh;
}
const aiDependencyProbeNextAt = new Map();
const AI_DEPENDENCY_PROBE_BACKOFF_MS = 30_000;
let dependencyPollRunning = false;
async function probeWaitingAiDependencies() {
  if (!getEffectiveRuntimePolicy().background_provider_probe_enabled) return;
  const waiting = (await listTasks(DATA_ROOT)).filter(task => task.status === 'WAITING_DEPENDENCY'
    && /^LISTING_SOP_(1[0-7])$/.test(String(task.current_step || ''))
    && !task.ai_generation_waiting?.generation_key
    && ['QWEN', 'DEEPSEEK'].includes(task.waiting_dependency_key));
  if (!waiting.length) return;
  const current = await getAiProviderReadiness(DATA_ROOT);
  for (const dependency of new Set(waiting.map(task => task.waiting_dependency_key))) {
    const related = waiting.filter(task => task.waiting_dependency_key === dependency);
    const requiredAfterValues = related.map(task => Date.parse(String(task.required_readiness_after || task.stages?.[task.current_step]?.updated_at || task.updated_at || ''))).filter(Number.isFinite);
    const requiredAfter = requiredAfterValues.length ? Math.max(...requiredAfterValues) : Number.NaN;
    const snapshot = dependency === 'QWEN' ? current.providers?.QWEN : current.providers?.DEEPSEEK;
    const checkedAt = Date.parse(String(snapshot?.checked_at || ''));
    if (snapshot?.ready === true && Number.isFinite(checkedAt) && Number.isFinite(requiredAfter) && checkedAt > requiredAfter) continue;
    if (snapshot?.status === 'NOT_CONFIGURED' || snapshot?.status === 'OPTIONAL_NOT_CONFIGURED') continue;
    const now = Date.now();
    if (now < Number(aiDependencyProbeNextAt.get(dependency) || 0)) continue;
    aiDependencyProbeNextAt.set(dependency, now + AI_DEPENDENCY_PROBE_BACKOFF_MS);
    const providerName = dependency === 'QWEN' ? 'Qwen' : 'DeepSeek';
    const result = await probeRegisteredAiProviders([providerName], { timeoutMs: resolveAiTimeoutConfiguration().provider_readiness_timeout_ms });
    await persistAiReadinessResults([providerName], result);
  }
}
const dependencyPoll = setInterval(async () => {
  // A pass may run longer than the polling interval while SOP06 serially
  // processes exact-string misses across SKUs. Do not overlap scheduler passes:
  // the first pass persists each objective volume before the next SKU lookup.
  if (dependencyPollRunning) return;
  dependencyPollRunning = true;
  try {
    const policy = getEffectiveRuntimePolicy();
    if (policy.runtime_policy_status !== 'VALID') return;
    if (READINESS_ONLY) {
      // Observe only: this loop must never resume a task or dispatch business work.
      await bolApiReadiness(DATA_ROOT);
      return;
    }
    if (policy.acceptance_hold) return;
    await probeWaitingAiDependencies();
    await refreshExpiredBolReadiness();
    if (getEffectiveRuntimePolicy().dependency_resume_enabled) await resumeReadyDependencies(DATA_ROOT);
  } catch (error) {
    console.error(`BOL dependency worker failed: ${error?.code || 'DEPENDENCY_WORKER_FAILED'}`);
  } finally {
    dependencyPollRunning = false;
  }
}, 5000);
dependencyPoll.unref?.();
server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    const status = Number(error.status) || (error.code === 'SKU_NOT_FOUND' ? 404
      : error.code === 'TASK_REVISION_CAS_CONFLICT' ? 409 : 400);
    send(res, status, { error: { code: error.code || 'REQUEST_FAILED', message: error.message || String(error) } });
  });
});
server.listen(PORT, HOST, () => {
  safeLifecycleLog('LISTENING', { host: HOST, port: PORT, data_root: DATA_ROOT });
  console.log(`BOL 精品半自动化后台: http://${HOST}:${PORT} · mode=${RUNTIME_MODE} · data=${DATA_ROOT}`);
});
server.on('error', error => {
  safeLifecycleLog('SERVER_ERROR', safeErrorMetadata(error));
  console.error(`BOL server failed: ${error.code || 'SERVER_ERROR'}`);
  process.exitCode = 1;
});


