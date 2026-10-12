import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiCache } from './api_cache.mjs';
import { productionReadinessSnapshot } from './provider_readiness.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_URL = 'https://login.bol.com/token';
const API_ROOT = 'https://api.bol.com/retailer';
const TOKEN_MARGIN_MS = 30_000;
const RETRY_MAX_WAIT_MS = 30_000;
const SEARCH_CACHE_MS = 20 * 60 * 60 * 1000;
const PRODUCT_CACHE_MS = 6 * 60 * 60 * 1000;
const ERROR_BODY_MAX_BYTES = 16 * 1024;
const ERROR_BODY_MAX_CHARS = 4096;
const ERROR_RESPONSE_HEADERS = new Set(['content-type', 'date', 'retry-after', 'x-request-id', 'request-id', 'traceparent', 'x-correlation-id', 'correlation-id', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']);
const CACHE_MODES = new Set(['CACHE_OK', 'FORCE_REFRESH']);
const ORIGINAL_GLOBAL_FETCH = globalThis.fetch;
// Keep proxy handling local to BOL API traffic. Node's global fetch does not
// automatically use HTTP(S)_PROXY unless a process-wide option is enabled.
// This project's bundled Node runtime supports proxyEnv on https.Agent.
const BOL_HTTPS_AGENT = new https.Agent({ proxyEnv: process.env, keepAlive: true, maxSockets: 8 });

function bolHttpsFetch(input, init = {}) {
  const url = new URL(input);
  if (url.protocol !== 'https:') return Promise.reject(new TypeError('BOL API requests must use HTTPS.'));
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: init.method || 'GET',
      headers: init.headers,
      agent: BOL_HTTPS_AGENT,
      signal: init.signal,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode || 0;
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        try {
          resolve(new Response(body, { status, statusText: response.statusMessage, headers: response.headers }));
        } catch {
          reject(new Error('BOL response could not be constructed.'));
        }
      });
    });
    request.on('error', reject);
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}

const PRODUCTION_FETCH = bolHttpsFetch;

export class AdapterError extends Error {
  constructor(code, message, status = null, diagnostic = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
    this.adapter_request_id = diagnostic.adapter_request_id ?? diagnostic.requestId ?? null;
    this.request_id = this.adapter_request_id;
    this.requestId = this.adapter_request_id;
    this.endpoint = diagnostic.endpoint ?? null;
    this.method = diagnostic.method ?? null;
    this.request_params = diagnostic.request_params ?? null;
    this.started_at = diagnostic.startedAt ?? null;
    this.finished_at = diagnostic.finishedAt ?? null;
    this.response_received = diagnostic.responseReceived ?? null;
    this.transport_code = diagnostic.transportCode ?? null;
    this.transport_message = diagnostic.transportMessage ?? null;
    this.transport_class = diagnostic.transportClass ?? null;
    this.http_status = diagnostic.httpStatus ?? status;
    this.http_status_text = diagnostic.httpStatusText ?? null;
    this.safe_headers = diagnostic.safeHeaders ?? null;
    this.response_headers = this.safe_headers;
    this.safe_body = diagnostic.safeBody ?? null;
    this.response_body = this.safe_body;
    this.adapter_original_message = diagnostic.adapterOriginalMessage ?? message;
  }
}

const fail = (code, message, status = null) => { throw new AdapterError(code, message, status); };

export async function readBolCredentials({ env = process.env, envFile = path.join(APP_ROOT, '.env') } = {}) {
  const readKey = async key => {
    if (typeof env[key] === 'string' && env[key].trim()) return env[key].trim();
    try {
      const content = await fs.readFile(envFile, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1] !== key) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        return value.trim() || null;
      }
    } catch { /* Report only a safe missing-credentials error below. */ }
    return null;
  };
  const [clientId, clientSecret] = await Promise.all([readKey('BOL_CLIENT_ID'), readKey('BOL_CLIENT_SECRET')]);
  if (!clientId || !clientSecret) fail('BOL_CREDENTIALS_MISSING', 'BOL OAuth 凭据未配置。');
  return { clientId, clientSecret };
}

function makeTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function diagnosticContext(url, method) {
  return { adapter_request_id: randomUUID(), endpoint: new URL(url).pathname, method, startedAt: new Date().toISOString() };
}

function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(/("?(?:authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|cookie|set-cookie)"?\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/gi, '$1[REDACTED]$3')
    .replace(/(\b(?:authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|cookie|set-cookie)\b\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .slice(0, ERROR_BODY_MAX_CHARS);
}

function safeDiagnosticValue(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeDiagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const safe = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|\btoken\b|\bsecret\b|password|api[_-]?key|cookie/i.test(key)) safe[key] = '[REDACTED]';
      else safe[key] = safeDiagnosticValue(item, depth + 1);
    }
    return safe;
  }
  return typeof value === 'string' ? redactDiagnosticText(value) : value;
}

function safeRequestParams(url, body) {
  const query = Object.fromEntries([...new URL(url).searchParams.entries()].map(([key, value]) => [key, value]));
  const params = { ...(Object.keys(query).length ? { query: safeDiagnosticValue(query) } : {}), ...(body && typeof body === 'object' ? { body: safeDiagnosticValue(body) } : {}) };
  const serialized = JSON.stringify(params);
  return serialized.length <= 2000 ? params : { truncated: true, preview: serialized.slice(0, 2000) };
}

function safeDiagnosticHeaders(headers) {
  if (!headers || typeof headers.entries !== 'function') return null;
  const safe = {};
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (ERROR_RESPONSE_HEADERS.has(normalized)) safe[normalized] = redactDiagnosticText(value).slice(0, 512);
  }
  return Object.keys(safe).length ? safe : null;
}

async function readBoundedDiagnosticBody(response) {
  if (!response?.body?.getReader) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (total < ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = ERROR_BODY_MAX_BYTES - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
  } catch { return text ? redactDiagnosticText(text) : null; }
  finally { try { await reader.cancel(); } catch { /* Body diagnostics are best effort. */ } }
  if (!text) return null;
  const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (parsed !== null) {
    const safe = safeDiagnosticValue(parsed);
    const serialized = JSON.stringify(safe);
    if (serialized.length <= ERROR_BODY_MAX_CHARS) return safe;
    return `${serialized.slice(0, ERROR_BODY_MAX_CHARS)} [TRUNCATED]`;
  }
  const safeText = redactDiagnosticText(text);
  return text.length > safeText.length || total >= ERROR_BODY_MAX_BYTES ? `${safeText} [TRUNCATED]` : safeText;
}

function throwDiagnosticError(code, message, status, diagnostic = {}) {
  throw new AdapterError(code, message, status, { ...diagnostic, finishedAt: diagnostic.finishedAt || new Date().toISOString() });
}

async function fetchTimed(fetchImpl, url, init, timeoutMs, diagnostic = diagnosticContext(url, init.method || 'GET')) {
  const timeout = makeTimeoutSignal(timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: timeout.signal }); }
  catch (error) {
    const transportCode = error?.cause?.code || error?.code || null;
    const metadata = { ...diagnostic, responseReceived: false, httpStatus: null, transportCode, transportMessage: redactDiagnosticText(error?.message || ''), transportClass: classifyTransportError(error) };
    if (timeout.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throwDiagnosticError('BOL_NETWORK_TIMEOUT', 'BOL 请求超时或网络不可达。', null, metadata);
    }
    throwDiagnosticError('BOL_NETWORK_ERROR', 'BOL 网络连接失败。', null, metadata);
  } finally { timeout.clear(); }
}

function classifyTransportError(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (code.includes('TIMEOUT') || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'TIMEOUT';
  if (code.startsWith('ENOTFOUND') || code.startsWith('EAI_')) return 'DNS';
  if (code.includes('TLS') || code.includes('CERT') || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || message.includes('certificate')) return 'TLS';
  if (code === 'ECONNRESET' || code === 'EPIPE' || message.includes('socket hang up')) return 'CONNECTION_RESET';
  return 'NETWORK';
}

async function responseDiagnostic(response, context) {
  const safeHeaders = safeDiagnosticHeaders(response.headers);
  const safeBody = await readBoundedDiagnosticBody(response);
  return {
    ...context,
    finishedAt: new Date().toISOString(),
    responseReceived: true,
    httpStatus: response.status,
    httpStatusText: response.statusText || null,
    safeHeaders,
    safeBody,
    transportCode: null,
    transportMessage: null,
    transportClass: null,
  };
}

async function throwResponseError(code, message, response, context) {
  throwDiagnosticError(code, message, response.status, await responseDiagnostic(response, context));
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(RETRY_MAX_WAIT_MS, ms);
  }
  const reset = response?.headers?.get?.('x-ratelimit-reset');
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value)) return Math.min(RETRY_MAX_WAIT_MS, Math.max(0, value * (value < 1e12 ? 1000 : 1) - Date.now()));
  }
  return Math.min(2000, 250 * 2 ** attempt);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function asSearchRecord(raw) {
  const searchTerms = raw?.searchTerms;
  if (!searchTerms || typeof searchTerms !== 'object') fail('BOL_RESPONSE_INVALID', 'BOL Search Terms 响应结构无效。');
  const related = Array.isArray(searchTerms.relatedSearchTerms) ? searchTerms.relatedSearchTerms : [];
  return {
    searchTerm: String(searchTerms.searchTerm ?? ''),
    type: String(searchTerms.type ?? ''),
    total: searchTerms.total ?? null,
    countries: Array.isArray(searchTerms.countries) ? searchTerms.countries : [],
    periods: Array.isArray(searchTerms.periods) ? searchTerms.periods : [],
    relatedSearchTerms: related.filter(item => typeof item?.searchTerm === 'string').map(item => ({
      searchTerm: item.searchTerm,
      total: Number.isFinite(Number(item.total)) ? Number(item.total) : null,
    })),
  };
}

function asProductListRecord(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.products)) fail('BOL_RESPONSE_INVALID', 'BOL Product List 响应结构无效。');
  return { sort: raw.sort ?? null, products: raw.products.map(product => ({ title: String(product?.title || ''), eans: Array.isArray(product?.eans) ? product.eans.map(row => ({ ean: String(row?.ean || '') })).filter(row => row.ean) : [] })) };
}

function asProductPlacementRecord(raw, status, { ean, endpoint, countryCode, language }) {
  if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !raw.url.trim() || !Array.isArray(raw.categories)) {
    fail('BOL_RESPONSE_INVALID', 'BOL Product Placement 响应结构无效。', status);
  }
  return {
    ean,
    url: raw.url,
    categories: raw.categories,
    http_status: status,
    queried_at: new Date().toISOString(),
    provider_evidence: {
      method: 'BOL_RETAILER_V10_PRODUCT_PLACEMENT',
      endpoint,
      country_code: countryCode,
      accept_language: language,
      response_status: status,
    },
  };
}

function asOffersRecord(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.offers)) fail('BOL_RESPONSE_INVALID', 'BOL Offers 响应结构无效。');
  return { offers: raw.offers.map(offer => ({ offerId: offer.offerId ?? null, retailerId: offer.retailerId ?? null, countryCode: offer.countryCode ?? null, bestOffer: offer.bestOffer ?? null, price: offer.price ?? null, fulfilmentMethod: offer.fulfilmentMethod ?? null, condition: offer.condition ?? null, ultimateOrderTime: offer.ultimateOrderTime ?? null, minDeliveryDate: offer.minDeliveryDate ?? null, maxDeliveryDate: offer.maxDeliveryDate ?? null })) };
}

function asRatingsRecord(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ratings)) fail('BOL_RESPONSE_INVALID', 'BOL Ratings 响应结构无效。');
  return { ratings: raw.ratings.map(row => ({ rating: Number(row?.rating), count: Number(row?.count) })).filter(row => Number.isFinite(row.rating) && Number.isFinite(row.count)) };
}

export function selectRelatedTerms({ seedRecords, productMaster, maxTerms = 7 }) {
  const contextTerms = [
    productMaster?.brand,
    productMaster?.name,
    ...(Array.isArray(productMaster?.confirmed_core_terms) ? productMaster.confirmed_core_terms : []),
  ].filter(value => typeof value === 'string' && value.trim());
  const factText = flattenText(productMaster?.product_facts);
  contextTerms.push(...factText);
  const anchors = new Set(contextTerms.flatMap(tokenize).filter(token => token.length >= 3 || /\d/.test(token)));
  if (!anchors.size) fail('BOL_PRODUCT_CONTEXT_MISSING', 'Product Master 缺少可用于关联词相关性核验的信息。');

  const unique = new Map();
  for (const record of seedRecords) {
    for (const term of record.relatedSearchTerms || []) {
      const exact = term.searchTerm;
      const words = new Set(tokenize(exact));
      const overlap = [...words].filter(word => anchors.has(word));
      if (!overlap.length) continue;
      const relevance = overlap.length / Math.max(1, words.size);
      const prior = unique.get(exact);
      const candidate = { ...term, seed: record.searchTerm, relevance };
      if (!prior || (candidate.total ?? -1) > (prior.total ?? -1)) unique.set(exact, candidate);
    }
  }
  return [...unique.values()]
    .sort((a, b) => b.relevance - a.relevance || (b.total ?? -1) - (a.total ?? -1))
    .slice(0, maxTerms)
    .map(({ searchTerm, total, seed, relevance }) => ({ searchTerm, total, seed, relevance }));
}

function tokenize(value) {
  return String(value ?? '').normalize('NFC').toLocaleLowerCase('nl-NL').match(/[\p{L}\p{N}]+/gu) || [];
}

function flattenText(value, out = []) {
  if (typeof value === 'string' && value.trim()) out.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenText(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenText(item, out);
  return out;
}

export class BolRetailerClient {
  #credentialsPromise = null;
  #token = null;
  #tokenExpiresAt = 0;
  #tokenType = null;
  #validatedAt = null;
  #authPromise = null;
  #inflight = new Map();

  constructor({ dataRoot, env = process.env, envFile, fetchImpl = globalThis.fetch === ORIGINAL_GLOBAL_FETCH ? PRODUCTION_FETCH : globalThis.fetch, timeoutMs = 12_000, cache } = {}) {
    this.dataRoot = path.resolve(dataRoot || path.join(APP_ROOT, 'BOL数据'));
    this.env = env;
    this.envFile = envFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = cache || new ApiCache(this.dataRoot);
  }

  async #credentials() {
    this.#credentialsPromise ||= readBolCredentials({ env: this.env, envFile: this.envFile });
    return this.#credentialsPromise;
  }

  async #accessToken(forceRefresh = false) {
    if (!forceRefresh && this.#token && Date.now() + TOKEN_MARGIN_MS < this.#tokenExpiresAt) return this.#token;
    if (this.#authPromise) return this.#authPromise;
    this.#authPromise = (async () => {
      const { clientId, clientSecret } = await this.#credentials();
      const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
      const tokenRequest = diagnosticContext(TOKEN_URL, 'POST');
      tokenRequest.request_params = { grant_type: 'client_credentials' };
      let response;
      try {
        response = await fetchTimed(this.fetchImpl, TOKEN_URL, {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        }, this.timeoutMs, tokenRequest);
      } finally { /* No request headers or body are logged or retained. */ }
      if (response.status !== 200) {
        this.#token = null;
        if (response.status === 401) await throwResponseError('BOL_AUTH_UNAUTHORIZED', 'BOL OAuth 拒绝认证。', response, tokenRequest);
        await throwResponseError('BOL_AUTH_HTTP_ERROR', 'BOL OAuth 服务返回错误状态。', response, tokenRequest);
      }
      let body;
      try { body = await response.json(); } catch {
        throwDiagnosticError('BOL_AUTH_RESPONSE_INVALID', 'BOL OAuth 响应格式无效。', response.status, {
          ...tokenRequest, finishedAt: new Date().toISOString(), responseReceived: true, httpStatus: response.status,
          httpStatusText: response.statusText || null, safeHeaders: safeDiagnosticHeaders(response.headers), safeBody: null,
        });
      }
      if (typeof body?.access_token !== 'string' || !body.access_token || body.token_type !== 'Bearer' || !Number.isFinite(Number(body.expires_in))) {
        throwDiagnosticError('BOL_AUTH_RESPONSE_INVALID', 'BOL OAuth 响应缺少有效 Token 元数据。', response.status, {
          ...tokenRequest, finishedAt: new Date().toISOString(), responseReceived: true, httpStatus: response.status,
          httpStatusText: response.statusText || null, safeHeaders: safeDiagnosticHeaders(response.headers), safeBody: '[REDACTED_OAUTH_RESPONSE]',
        });
      }
      this.#token = body.access_token;
      this.#tokenType = body.token_type;
      this.#tokenExpiresAt = Date.now() + Number(body.expires_in) * 1000;
      this.#validatedAt = new Date().toISOString();
      return this.#token;
    })().finally(() => { this.#authPromise = null; });
    return this.#authPromise;
  }

  async validateOAuth() {
    await this.#accessToken();
    return {
      status: 'PASS', httpStatus: 200, tokenType: this.#tokenType,
      expiresInSeconds: Math.max(0, Math.floor((this.#tokenExpiresAt - Date.now()) / 1000)),
      validatedAt: this.#validatedAt, tokenExpiresAt: this.#tokenExpiresAt,
    };
  }

  async probeSearchTermsEndpoint() {
    const query = new URLSearchParams({ 'search-term': 'bol readiness check', period: 'WEEK', 'number-of-periods': '1', 'related-search-terms': 'false' });
    const result = await this.#authorizedRequest(`${API_ROOT}/insights/search-terms?${query}`);
    asSearchRecord(result.data);
    return { status: 'PASS', httpStatus: result.status, endpoint: '/retailer/insights/search-terms' };
  }

  async #authorizedRequest(url, { method = 'GET', headers = {}, body, allow401Refresh = true } = {}) {
    const diagnostic = diagnosticContext(url, method);
    diagnostic.request_params = safeRequestParams(url, body);
    let token = await this.#accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchTimed(this.fetchImpl, url, {
        method,
        headers: { Authorization: `${this.#tokenType} ${token}`, Accept: 'application/vnd.retailer.v10+json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, this.timeoutMs, diagnostic);
      if (response.status === 401 && allow401Refresh && attempt === 0) {
        this.#token = null;
        token = await this.#accessToken(true);
        continue;
      }
      if (response.status === 429 && attempt === 0) {
        await pause(retryDelay(response, attempt));
        continue;
      }
      if (response.status >= 500 && response.status <= 599 && attempt === 0) {
        await pause(retryDelay(response, attempt));
        continue;
      }
      if (!response.ok) {
        if (response.status === 401) await throwResponseError('BOL_AUTH_UNAUTHORIZED', 'BOL API 拒绝认证。', response, diagnostic);
        if (response.status === 429) await throwResponseError('BOL_RATE_LIMITED', 'BOL API 限流；有限重试后仍未恢复。', response, diagnostic);
        await throwResponseError('BOL_API_HTTP_ERROR', 'BOL API 返回错误状态。', response, diagnostic);
      }
      const diagnosticResponse = response.clone();
      try { return { status: response.status, headers: response.headers, data: await response.json() }; }
      catch {
        throwDiagnosticError('BOL_RESPONSE_INVALID', 'BOL API 响应格式无效。', response.status, await responseDiagnostic(diagnosticResponse, diagnostic));
      }
    }
    fail('BOL_API_RETRY_EXHAUSTED', 'BOL API 有限重试后仍未成功。');
  }

  async #cached(provider, key, ttlMs, fetchFn, normalize = value => value, cacheMode = 'CACHE_OK') {
    if (!CACHE_MODES.has(cacheMode)) fail('API_CACHE_MODE_INVALID', '缓存模式必须为 CACHE_OK 或 FORCE_REFRESH。');
    if (cacheMode === 'CACHE_OK') {
      const hit = await this.cache.get(provider, key);
      if (hit) return hit;
    }
    const sharedKey = `${provider}:${key}`;
    if (this.#inflight.has(sharedKey)) return this.#inflight.get(sharedKey);
    const pending = (async () => {
      const { status, data } = await fetchFn();
      return this.cache.set(provider, key, { rawResponse: data, structuredResult: normalize(data, status), source: `${provider}:HTTP ${status}`, ttlMs });
    })();
    this.#inflight.set(sharedKey, pending);
    try { return await pending; }
    finally { if (this.#inflight.get(sharedKey) === pending) this.#inflight.delete(sharedKey); }
  }

  async getSearchTerms({ searchTerm, period = 'WEEK', numberOfPeriods = 52, related = true, cacheMode = 'CACHE_OK' } = {}) {
    if (typeof searchTerm !== 'string' || !searchTerm.trim()) fail('BOL_SEARCH_TERM_MISSING', 'BOL Search Terms 缺少查询词。');
    const exactTerm = searchTerm.trim();
    const key = JSON.stringify({ searchTerm: exactTerm, period, numberOfPeriods, related });
    return this.#cached('bol_search_terms', key, SEARCH_CACHE_MS, async () => {
      const query = new URLSearchParams({ 'search-term': exactTerm, period, 'number-of-periods': String(numberOfPeriods), 'related-search-terms': String(Boolean(related)) });
      return this.#authorizedRequest(`${API_ROOT}/insights/search-terms?${query}`);
    }, asSearchRecord, cacheMode);
  }

  async getProductList({ countryCode = 'NL', searchTerm, categoryId, sort = 'RELEVANCE', page = 1, cacheMode = 'CACHE_OK' } = {}) {
    if (!['NL', 'BE'].includes(countryCode)) fail('BOL_COUNTRY_INVALID', 'BOL 市场必须是 NL 或 BE。');
    const key = JSON.stringify({ countryCode, searchTerm: searchTerm ?? null, categoryId: categoryId ?? null, sort, page });
    return this.#cached('bol_product_list', key, PRODUCT_CACHE_MS, () => this.#authorizedRequest(`${API_ROOT}/products/list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': countryCode === 'BE' ? 'nl-BE' : 'nl' }, body: { countryCode, searchTerm, categoryId, sort, page },
    }), asProductListRecord, cacheMode);
  }

  async getProductPlacement(input = {}, options = {}) {
    const args = input && typeof input === 'object' ? input : { ...options, ean: input };
    const { countryCode = 'NL', language = 'nl', cacheMode = 'CACHE_OK' } = args;
    if (typeof args.ean !== 'string' && typeof args.ean !== 'number') fail('BOL_EAN_MISSING', '获取 BOL Product Placement 缺少 EAN。');
    const ean = String(args.ean).trim();
    if (!ean) fail('BOL_EAN_MISSING', '获取 BOL Product Placement 缺少 EAN。');
    if (!['NL', 'BE'].includes(countryCode)) fail('BOL_COUNTRY_INVALID', 'BOL 市场必须是 NL 或 BE。');
    if (typeof language !== 'string' || !language.trim()) fail('BOL_LANGUAGE_INVALID', 'BOL Product Placement 缺少有效 Accept-Language。');
    const endpoint = `/retailer/products/${encodeURIComponent(ean)}/placement`;
    const key = JSON.stringify({ ean, countryCode, language });
    try {
      return await this.#cached('bol_product_placement', key, PRODUCT_CACHE_MS, () => {
        const query = new URLSearchParams({ 'country-code': countryCode });
        return this.#authorizedRequest(`${API_ROOT}/products/${encodeURIComponent(ean)}/placement?${query}`, {
          headers: { 'Accept-Language': language.trim() },
        });
      }, (raw, status) => asProductPlacementRecord(raw, status, { ean, endpoint, countryCode, language: language.trim() }), cacheMode);
    } catch (error) {
      const codes = {
        400: 'PRODUCT_PLACEMENT_BAD_REQUEST',
        404: 'PRODUCT_PLACEMENT_NOT_FOUND',
        406: 'PRODUCT_PLACEMENT_NOT_ACCEPTABLE',
      };
      if (error instanceof AdapterError && codes[error.status]) {
        throwDiagnosticError(codes[error.status], `BOL Product Placement 返回 HTTP ${error.status}。`, error.status, {
          adapter_request_id: error.adapter_request_id,
          endpoint: error.endpoint || endpoint,
          method: error.method || 'GET',
          request_params: error.request_params,
          startedAt: error.started_at,
          finishedAt: error.finished_at,
          responseReceived: error.response_received,
          httpStatus: error.http_status,
          httpStatusText: error.http_status_text,
          transportCode: error.transport_code,
          transportMessage: error.transport_message,
          transportClass: error.transport_class,
          safeHeaders: error.safe_headers,
          safeBody: error.safe_body,
          adapterOriginalMessage: error.message,
        });
      }
      throw error;
    }
  }

  async getOffers({ ean, countryCode = 'NL', page = 1, cacheMode = 'CACHE_OK' } = {}) {
    if (!ean) fail('BOL_EAN_MISSING', '获取 BOL Offers 缺少 EAN。');
    if (!['NL', 'BE'].includes(countryCode)) fail('BOL_COUNTRY_INVALID', 'BOL 市场必须是 NL 或 BE。');
    const key = JSON.stringify({ ean: String(ean), countryCode, page });
    return this.#cached('bol_offers', key, PRODUCT_CACHE_MS, () => {
      const query = new URLSearchParams({ 'country-code': countryCode, page: String(page) });
      return this.#authorizedRequest(`${API_ROOT}/products/${encodeURIComponent(ean)}/offers?${query}`);
    }, asOffersRecord, cacheMode);
  }

  async getRatings({ ean, cacheMode = 'CACHE_OK' } = {}) {
    if (!ean) fail('BOL_EAN_MISSING', '获取 BOL Ratings 缺少 EAN。');
    const key = JSON.stringify({ ean: String(ean) });
    return this.#cached('bol_ratings', key, PRODUCT_CACHE_MS, () => this.#authorizedRequest(`${API_ROOT}/products/${encodeURIComponent(ean)}/ratings`), asRatingsRecord, cacheMode);
  }

  getAuthStatus() {
    const readiness = productionReadinessSnapshot();
    return { status: readiness.BOL_API_READY ? 'CONNECTED' : 'PENDING_PRODUCTION_VALIDATION', validatedAt: readiness.BOL_VALIDATED_AT, tokenType: readiness.BOL_API_READY ? this.#tokenType : null, expiresInSeconds: readiness.BOL_API_READY ? Math.max(0, Math.floor((this.#tokenExpiresAt - Date.now()) / 1000)) : null };
  }

  get usesNativeTransport() { return this.fetchImpl === PRODUCTION_FETCH; }
}

export async function runBolKeywordStage({ client, productMaster, sku }) {
  const explicit = Array.isArray(productMaster?.confirmed_core_terms) ? productMaster.confirmed_core_terms : [];
  const seeds = [...new Set(explicit.map(item => String(item ?? '').trim()).filter(Boolean))].slice(0, 3);
  if (!seeds.length && productMaster?.name?.trim()) seeds.push(productMaster.name.trim());
  if (!seeds.length) fail('BOL_CORE_TERMS_MISSING', 'Product Master 缺少第一个核心查询词。');

  const seedRecords = [];
  for (const seed of seeds) {
    const result = await client.getSearchTerms({ searchTerm: seed, period: 'WEEK', numberOfPeriods: 52, related: true });
    seedRecords.push({ searchTerm: seed, rawResponse: result.rawResponse, cache: { createdAt: result.createdAt, expiresAt: result.expiresAt, source: result.source, cacheHit: result.cacheHit }, ...result.structuredResult });
    const selected = selectRelatedTerms({ seedRecords, productMaster });
    if (selected.length >= 5) break;
  }
  const terms = selectRelatedTerms({ seedRecords, productMaster });
  if (terms.length < 5) fail('BOL_RELATED_TERMS_INSUFFICIENT', '最多查询 3 个已确认核心词后，相关且唯一的联想词仍少于 5 个。');
  return {
    sku,
    source: 'BOL Retailer API v10 · Search Terms',
    queriedAt: new Date().toISOString(),
    selectionRule: 'exact-string-dedupe; Product-Master lexical relevance first; total second; maximum three confirmed seeds; maximum seven outputs',
    seeds: seedRecords.map(({ searchTerm, cache }) => ({ searchTerm, cache })),
    relatedTerms: terms.slice(0, 7),
    rawResponses: seedRecords.map(({ searchTerm, rawResponse }) => ({ searchTerm, response: rawResponse })),
    cacheProvenance: seedRecords.map(({ searchTerm, cache }) => ({ searchTerm, ...cache })),
    open_error_count: 0,
  };
}

export async function discoverBolCompetitorCandidates({ client, searchTerms, categoryId, countries = ['NL', 'BE'], maxPages = 1, cacheMode = 'CACHE_OK' } = {}) {
  const candidates = new Map();
  const requests = [];
  for (const countryCode of countries) {
    for (const term of searchTerms || []) {
      const searchTerm = typeof term === 'string' ? term : term?.searchTerm;
      if (!searchTerm) continue;
      for (let page = 1; page <= Math.min(3, Math.max(1, maxPages)); page++) {
        const result = await client.getProductList({ countryCode, searchTerm, categoryId, page, cacheMode });
        requests.push({ countryCode, searchTerm, page, cacheHit: result.cacheHit, retrievedAt: result.createdAt });
        for (const product of result.rawResponse?.products || []) {
          for (const eanRow of product.eans || []) {
            const ean = String(eanRow?.ean || '');
            if (!ean) continue;
            const candidate = candidates.get(ean) || { ean, title: product.title || '', markets: [] };
            if (!candidate.markets.includes(countryCode)) candidate.markets.push(countryCode);
            candidates.set(ean, candidate);
          }
        }
      }
    }
  }
  return { status: 'CANDIDATES_NEED_SOP_REVIEW', source: 'BOL Retailer API v10 · Product List', requests, candidates: [...candidates.values()] };
}

/** Explicit fresh snapshot for final review; callers must still apply the read-only competitor SOP. */
export async function fetchCompetitorDataForFinalReview({ client, countryCode = 'NL', searchTerm, categoryId, ean } = {}) {
  if (!client || !ean) fail('BOL_FINAL_REVIEW_INPUT_MISSING', '最终竞品复核需要 API 客户端和 EAN。');
  const [productList, offers, ratings] = await Promise.all([
    client.getProductList({ countryCode, searchTerm, categoryId, cacheMode: 'FORCE_REFRESH' }),
    client.getOffers({ ean, countryCode, cacheMode: 'FORCE_REFRESH' }),
    client.getRatings({ ean, cacheMode: 'FORCE_REFRESH' }),
  ]);
  return {
    status: 'CURRENT_DATA_REQUIRES_SOP_REVIEW',
    fetchedAt: new Date().toISOString(),
    source: 'BOL Retailer API v10',
    refreshMode: 'FORCE_REFRESH',
    mustReviewAgainstCompetitorSop: true,
    productList,
    offers,
    ratings,
  };
}

export function bolIntegrationStatus(readiness = null) {
  const connected = readiness ? readiness.status === 'PASS' : productionReadinessSnapshot().BOL_API_READY;
  return { BOL_API_READY: connected, status: connected ? 'CONNECTED' : 'PENDING_PRODUCTION_VALIDATION', validatedAt: readiness?.checked_at || productionReadinessSnapshot().BOL_VALIDATED_AT, tokenStoredOnDisk: false };
}
