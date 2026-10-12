import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError } from './bol_retailer_client.mjs';
import { ApiCache } from './api_cache.mjs';
import { isBolooWebView2Verified, markBolooProviderReady, productionReadinessSnapshot } from './provider_readiness.mjs';
import { amsterdamBusinessDate, toUtcIso } from './boloo_keyword_policy.mjs';

const DEFAULT_ENDPOINT = 'https://mcp.boloo.co/mcp';
const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const BOLOO_TOOL_CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_MODES = new Set(['CACHE_OK', 'FORCE_REFRESH']);
const NATIVE_FETCH = globalThis.fetch;

function safeFail(code, message, status = null) { throw new AdapterError(code, message, status); }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { return await response.json(); } catch { safeFail('BOLOO_MCP_INVALID_RESPONSE', 'Boloo MCP 响应格式无效。', response.status); }
  }
  if (contentType.includes('text/event-stream')) {
    const reader = response.body?.getReader?.();
    if (!reader) safeFail('BOLOO_MCP_INVALID_RESPONSE', 'Boloo MCP SSE 响应不可读取。', response.status);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) {
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!data || data === '[DONE]') continue;
          try { return JSON.parse(data); } catch { /* Continue until a valid JSON-RPC event arrives. */ }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* The stream may have closed already. */ }
    }
  }
  safeFail('BOLOO_MCP_INVALID_RESPONSE', 'Boloo MCP 未返回可识别的 JSON-RPC 响应。', response.status);
}

export class BolooMcpClient {
  #sessionId = null;
  #requestId = 0;
  #initialized = false;
  #protocolVersion = null;

  constructor({ endpoint = process.env.BOLOO_MCP_URL || DEFAULT_ENDPOINT, authorizationValue = process.env.BOLOO_MCP_AUTHORIZATION, fetchImpl = globalThis.fetch, timeoutMs = 15_000, discoveryFile, dataRoot, officialWebVerifier = null, clock = () => new Date() } = {}) {
    this.endpoint = endpoint;
    this.authorizationValue = authorizationValue;
    this.fetchImpl = fetchImpl;
    this.usesNativeTransport = this.fetchImpl === NATIVE_FETCH;
    this.timeoutMs = timeoutMs;
    this.dataRoot = path.resolve(dataRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'BOL数据'));
    this.discoveryFile = discoveryFile || path.join(this.dataRoot, 'boloo-tools-discovery.json');
    this.officialWebVerifier = officialWebVerifier;
    this.clock = clock;
    this.cache = new ApiCache(this.dataRoot);
  }

  async #send(method, params = {}, { notification = false } = {}) {
    if (!this.authorizationValue) safeFail('BOLOO_MCP_PLAN_ACCESS_NOT_INCLUDED', 'Boloo MCP 当前套餐未开放；未发送任何请求。');
    const id = ++this.#requestId;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: this.authorizationValue,
    };
    if (this.#protocolVersion) headers['MCP-Protocol-Version'] = this.#protocolVersion;
    if (this.#sessionId) headers['Mcp-Session-Id'] = this.#sessionId;
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers, signal: timeout,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      });
    } catch (error) {
      safeFail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'BOLOO_MCP_TIMEOUT' : 'BOLOO_MCP_NETWORK_ERROR', 'Boloo MCP 网络请求失败。');
    }
    if (response.status === 401 || response.status === 403) safeFail('BOLOO_MCP_ACCESS_DENIED', 'Boloo MCP 拒绝访问；检查套餐、只读权限和连接状态。', response.status);
    if (!response.ok && response.status !== 202) safeFail('BOLOO_MCP_HTTP_ERROR', 'Boloo MCP 返回错误状态。', response.status);
    const session = response.headers.get('mcp-session-id');
    if (session) this.#sessionId = session;
    if (notification || response.status === 202) return null;
    const result = await parseResponse(response);
    if (result?.error) safeFail('BOLOO_MCP_RPC_ERROR', 'Boloo MCP JSON-RPC 请求失败。', response.status);
    return result?.result;
  }

  async initialize() {
    if (this.#initialized) return { status: 'INITIALIZED' };
    const result = await this.#send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bol-auto-adapter', version: '1.0.0' },
    });
    if (!result || typeof result.protocolVersion !== 'string') safeFail('BOLOO_MCP_INITIALIZE_INVALID', 'Boloo MCP 初始化响应缺少协议元数据。');
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(result.protocolVersion)) safeFail('BOLOO_MCP_PROTOCOL_UNSUPPORTED', 'Boloo MCP 返回了当前适配器不支持的协议版本。');
    this.#protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo || null;
    await this.#send('notifications/initialized', {}, { notification: true });
    this.#initialized = true;
    return { status: 'INITIALIZED', serverInfo: this.serverInfo };
  }

  async discoverTools() {
    await this.initialize();
    const response = await this.#send('tools/list');
    const tools = Array.isArray(response?.tools) ? response.tools : null;
    if (!tools) safeFail('BOLOO_MCP_TOOLS_LIST_INVALID', 'Boloo MCP tools/list 响应结构无效。');
    const snapshot = {
      source: 'Boloo official MCP', endpoint: this.endpoint, discoveredAt: new Date().toISOString(),
      serverInfo: this.serverInfo,
      permissionEvidence: 'Current tools/list reflects tools exposed to this connection; per-area account grants are not included in the tools/list response.',
      tools: tools.map(tool => ({ name: String(tool.name || ''), description: String(tool.description || ''), inputSchema: tool.inputSchema || {} })),
    };
    this.discoveredTools = new Set(snapshot.tools.map(tool => tool.name));
    if (this.discoveryFile) {
      await fs.mkdir(path.dirname(path.resolve(this.discoveryFile)), { recursive: true });
      await fs.writeFile(path.resolve(this.discoveryFile), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    }
    if (this.usesNativeTransport) markBolooProviderReady();
    return snapshot;
  }

  async callTool(toolName, args = {}, { cacheMode = 'FORCE_REFRESH' } = {}) {
    if (!CACHE_MODES.has(cacheMode)) safeFail('API_CACHE_MODE_INVALID', '缓存模式必须为 CACHE_OK 或 FORCE_REFRESH。');
    if (!this.#initialized) await this.initialize();
    if (typeof toolName !== 'string' || !toolName.trim()) safeFail('BOLOO_MCP_TOOL_NAME_REQUIRED', '必须使用 tools/list 返回的工具名。');
    if (!this.discoveredTools) await this.discoverTools();
    if (!this.discoveredTools.has(toolName)) safeFail('BOLOO_MCP_TOOL_NOT_DISCOVERED', '只能调用当前 tools/list 已返回的工具名。');
    const cacheKey = stableJson({ toolName, args });
    if (cacheMode === 'CACHE_OK') {
      const hit = await this.cache.get('boloo_mcp_tool', cacheKey);
      if (hit) return hit.structuredResult;
    }
    const result = await this.#send('tools/call', { name: toolName, arguments: args });
    await this.cache.set('boloo_mcp_tool', cacheKey, { rawResponse: result, structuredResult: result, source: `Boloo MCP tool:${toolName}`, ttlMs: BOLOO_TOOL_CACHE_MS });
    return result;
  }

  async callExactKeywordTool({ toolName, args = {}, exactString }) {
    if (typeof exactString !== 'string' || !exactString.trim()) safeFail('BOLOO_EXACT_STRING_REQUIRED', 'Boloo 精确关键词必须提供原始精确字符串。');
    let lookupAtUtc;
    try { lookupAtUtc = toUtcIso(this.clock()); }
    catch { safeFail('BOLOO_QUERY_TIME_INVALID', '无法取得有效 UTC 查询时间。'); }
    const reusable = await this.cache.findReusableBolooKeyword({ exactString, queriedAtUtc: lookupAtUtc });
    if (reusable) return { status: 'FORMAL_REUSE', ...reusable };

    // Resolve the discovered capability before capturing the timestamp for the actual provider call.
    if (!this.#initialized) await this.initialize();
    if (!this.discoveredTools) await this.discoverTools();
    if (typeof toolName !== 'string' || !this.discoveredTools.has(toolName)) safeFail('BOLOO_MCP_TOOL_NOT_DISCOVERED', '只能调用当前 tools/list 已返回的工具名。');
    let queriedAtUtc;
    try { queriedAtUtc = toUtcIso(this.clock()); }
    catch { safeFail('BOLOO_QUERY_TIME_INVALID', '无法取得有效 UTC 查询时间。'); }
    const queryDate = amsterdamBusinessDate(queriedAtUtc);
    const result = await this.callTool(toolName, args, { cacheMode: 'FORCE_REFRESH' });
    return { status: 'FRESH_RESPONSE_REQUIRES_STAGE_QA', exactString, queryDate, queried_at_utc: queriedAtUtc, provider_method: 'BOLOO_OFFICIAL_MCP', result };
  }

  async recordVerifiedKeywordResult({ toolName, exactString, queryDate, queried_at_utc, rawResponse, structuredResult, stageQaStatus }) {
    if (!this.discoveredTools?.has(toolName)) safeFail('BOLOO_MCP_TOOL_NOT_DISCOVERED', '关键词结果必须来自当前已发现的官方工具。');
    if (!this.usesNativeTransport || !productionReadinessSnapshot().BOLOO_PROVIDER_READY) safeFail('BOLOO_OFFICIAL_SOURCE_NOT_VERIFIED', '离线或未验证的 MCP 响应不能登记为 Boloo 官方正式数据。');
    return this.cache.recordBolooKeywordObservation({ exactString, queryDate, queriedAtUtc: queried_at_utc, toolName, providerMethod: 'BOLOO_OFFICIAL_MCP', officialSourceVerified: true, rawResponse, structuredResult, stageQaStatus });
  }

  async recordVerifiedOfficialWebKeywordResult({ exactString, sourceUrl, pageFieldName, rawValue, fetchedAtUtc, rawDomEvidenceRef, rawResponse, structuredResult, stageQaStatus }) {
    if (!isBolooWebView2Verified()) safeFail('BOLOO_WEBVIEW2_NOT_VERIFIED', 'Boloo WebView2 尚未完成真实页面与 DOM 验证；未登记正式数据。');
    let url;
    try { url = new URL(sourceUrl); } catch { safeFail('BOLOO_WEB_SOURCE_NOT_VERIFIED', 'Boloo 官方网页来源未通过验证。'); }
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'boloo.co' || url.hostname.endsWith('.boloo.co')) || typeof this.officialWebVerifier !== 'function') {
      safeFail('BOLOO_WEB_SOURCE_NOT_VERIFIED', 'Boloo 官方网页来源未通过验证。');
    }
    let verified = false;
    try { verified = await this.officialWebVerifier({ sourceUrl, exactString, pageFieldName, rawValue, fetchedAtUtc, rawDomEvidenceRef, rawResponse }) === true; }
    catch { verified = false; }
    if (!verified) safeFail('BOLOO_WEB_SOURCE_NOT_VERIFIED', 'Boloo 官方网页来源未通过验证。');
    let queriedAtUtc;
    try { queriedAtUtc = toUtcIso(fetchedAtUtc); }
    catch { safeFail('BOLOO_WEB_EVIDENCE_INCOMPLETE', 'WebView2 抓取时间必须是有效 UTC 时间。'); }
    return this.cache.recordBolooKeywordObservation({
      exactString, queriedAtUtc, toolName: 'webview2-official-page', providerMethod: 'BOLOO_OFFICIAL_WEB',
      officialSourceVerified: true, stageQaStatus, rawResponse, structuredResult,
      pageUrl: sourceUrl, pageFieldName, rawValue, fetchedAtUtc: queriedAtUtc, rawDomEvidenceRef,
    });
  }
}

export function bolooIntegrationStatus() {
  const readiness = productionReadinessSnapshot();
  const mcpReady = readiness.BOLOO_MCP_READY;
  const webReady = readiness.BOLOO_OFFICIAL_WEB_READY && readiness.BOLOO_WEBVIEW2_VERIFIED;
  return {
    BOLOO_PROVIDER_READY: readiness.BOLOO_PROVIDER_READY,
    BOLOO_MCP_READY: mcpReady,
    BOLOO_OFFICIAL_WEB_READY: webReady,
    BOLOO_WEBVIEW2_VERIFIED: readiness.BOLOO_WEBVIEW2_VERIFIED,
    status: webReady ? 'READY' : mcpReady ? 'CONNECTED' : 'PLAN_ACCESS_NOT_INCLUDED',
    provider_source: webReady ? 'BOLOO_OFFICIAL_WEB' : mcpReady ? 'BOLOO_OFFICIAL_MCP' : null,
    endpoint: webReady ? 'https://app.boloo.co' : DEFAULT_ENDPOINT,
    mcp_endpoint: DEFAULT_ENDPOINT,
    connected: readiness.BOLOO_PROVIDER_READY,
    mcp_connected: mcpReady,
    toolDiscovery: mcpReady ? 'COMPLETE' : webReady ? 'NOT_REQUIRED_FOR_OFFICIAL_WEB' : 'WAITING_FOR_PLAN_ACCESS',
  };
}
