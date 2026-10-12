import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { registerAiProviderAdapter } from './ai_router.mjs';
import { validateListingSopJsonSchema } from './listing_sop_json_schemas.mjs';
import { providerTransportCounters } from './provider_transport_counters.mjs';
import { resolveAiProviderConfigPath } from './ai_provider_config_path.mjs';

const configPath = resolveAiProviderConfigPath();
const RESPONSE_BODY_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 1;
const ADAPTER_VERSION = 'bol-openai-compatible-adapter-v1';
const DEEPSEEK_RESPONSES_ADAPTER_VERSION = 'bol-deepseek-responses-json-schema-adapter-v1';

export function classifyProviderFailure({ status = null, errorCode = '' } = {}) {
  const numericStatus = Number(status) || 0;
  const code = String(errorCode || '').toUpperCase();
  if (numericStatus === 401) return 'PROVIDER_AUTH_FAILED';
  if (numericStatus === 403) return 'PROVIDER_PERMISSION_DENIED';
  if (numericStatus === 404) return 'PROVIDER_MODEL_OR_ENDPOINT_NOT_FOUND';
  if (numericStatus === 402) return 'PROVIDER_QUOTA_EXCEEDED';
  if (numericStatus === 408 || numericStatus === 504) return 'PROVIDER_TIMEOUT';
  if (numericStatus === 429) return 'PROVIDER_RATE_LIMITED';
  if (numericStatus === 400 || numericStatus === 422) return 'PROVIDER_INVALID_REQUEST';
  if (numericStatus >= 500) return 'PROVIDER_UNAVAILABLE';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code)) return 'PROVIDER_DNS_FAILED';
  if (/^(CERT_|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return 'PROVIDER_TLS_FAILED';
  if (['ETIMEDOUT', 'ECONNABORTED', 'ABORT_ERR'].includes(code)) return 'PROVIDER_TIMEOUT';
  if (code === 'PROVIDER_RESPONSE_TOO_LARGE') return 'PROVIDER_RESPONSE_INVALID';
  if (code === 'PROVIDER_ENDPOINT_INVALID' || code === 'PROVIDER_ENDPOINT_NOT_HTTPS') return 'PROVIDER_CONFIG_INVALID';
  if (code) return 'PROVIDER_TRANSPORT_FAILED';
  return 'PROVIDER_RESPONSE_INVALID';
}

function safeStatusMessage(code) {
  const messages = {
    PROVIDER_NOT_CONFIGURED: 'Provider 配置或凭据缺失。',
    PROVIDER_AUTH_FAILED: 'Provider 身份验证失败。',
    PROVIDER_PERMISSION_DENIED: 'Provider 账户或模型权限不足。',
    PROVIDER_QUOTA_EXCEEDED: 'Provider 账户余额或配额不足。',
    PROVIDER_MODEL_OR_ENDPOINT_NOT_FOUND: 'Provider endpoint 或模型不可用。',
    PROVIDER_TIMEOUT: 'Provider 请求超时。',
    PROVIDER_RATE_LIMITED: 'Provider 请求受到限流或额度限制。',
    PROVIDER_INVALID_REQUEST: 'Provider 拒绝了请求格式或参数。',
    PROVIDER_DNS_FAILED: 'Provider 域名解析失败。',
    PROVIDER_TLS_FAILED: 'Provider TLS 握手或证书校验失败。',
    PROVIDER_TRANSPORT_FAILED: 'Provider 网络连接失败。',
    PROVIDER_UNAVAILABLE: 'Provider 服务暂不可用。',
    PROVIDER_RESPONSE_INVALID: 'Provider 返回格式无效。',
    PROVIDER_CONFIG_INVALID: 'Provider endpoint 配置无效。',
    PROVIDER_STRUCTURED_RESPONSE_INVALID: 'Provider 结构化响应无法解析或不符合探针契约。',
    PROVIDER_READINESS_NOT_PROBED: '尚未执行真实 Provider readiness 探针。',
  };
  return messages[code] || 'Provider 请求失败。';
}

function transientCode(errorCode) {
  const code = String(errorCode || '').toUpperCase();
  return ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ABORT_ERR'].includes(code)
    || /^(CERT_|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED)/.test(code);
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  const aliases = {
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens,
    total_tokens: usage.total_tokens,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens,
  };
  for (const [key, raw] of Object.entries(aliases)) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) result[key] = value;
  }
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens);
  if (Number.isFinite(cached) && cached >= 0) result.cached_tokens = cached;
  return Object.keys(result).length ? result : null;
}

function resolveResponsesEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.pathname.replace(/\/$/, '').endsWith('/chat/completions')) {
    throw Object.assign(new Error('DeepSeek Responses requires a configured /chat/completions endpoint.'), { code: 'PROVIDER_RESPONSES_ENDPOINT_INVALID' });
  }
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/responses');
  return url.toString();
}

function extractResponsesText(body) {
  const parts = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function schemaName(value) {
  const safe = String(value || 'listing_output').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return safe || 'listing_output';
}

function whitespaceTelemetry(content) {
  const value = typeof content === 'string' ? content : '';
  const nonWhitespace = value.replace(/\s/gu, '').length;
  return {
    raw_content_length: value.length,
    trimmed_content_length: value.trim().length,
    non_whitespace_length: nonWhitespace,
    whitespace_only: value.length > 0 && nonWhitespace === 0,
  };
}

function providerRequestId(headers) {
  const raw = headers?.['x-request-id'] || headers?.['x-dashscope-request-id'] || headers?.['request-id'];
  const value = String(Array.isArray(raw) ? raw[0] : raw || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function safeProviderErrorCode(value) {
  const code = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(code) ? code : null;
}

function safeProviderErrorMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password|credential|signature)\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512) || null;
}

function providerErrorDetails(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { provider_error_code: null, provider_error_message: null };
  }
  const candidates = [body.error, body.Error, body].filter(value => value && typeof value === 'object' && !Array.isArray(value));
  let code = null;
  let message = null;
  for (const item of candidates) {
    code ||= item.code ?? item.error_code ?? item.errorCode;
    message ||= item.message ?? item.error_description ?? item.errorDescription;
  }
  return {
    provider_error_code: safeProviderErrorCode(code),
    provider_error_message: safeProviderErrorMessage(message),
  };
}

function attemptFailureStage(error, responseReceived) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  if (['ETIMEDOUT', 'ECONNABORTED', 'ABORT_ERR'].includes(code)) {
    return responseReceived ? 'TIMEOUT_DURING_RESPONSE' : 'TIMEOUT_BEFORE_RESPONSE';
  }
  return responseReceived ? 'HTTP' : 'CONNECT';
}

export function buildAttemptTelemetrySnapshot({ attemptIndex, startedAt, timeoutMs, transportRetry, connected, responseReceived, httpStatus, failureStage, failureCode, outboundTransportStarted,
  requestBodySent = false, secureConnectedAt = null, secureConnectObservation = 'NOT_OBSERVED', secureConnectObservedAt = null,
  requestBodySentAt = null, responseHeadersReceivedAt = null, responseFirstByteAt = null }) {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt || Date.now());
  const finishedAt = new Date();
  const elapsed = value => value instanceof Date ? Math.max(0, value.getTime() - start.getTime()) : null;
  return {
    attempt_index: Number(attemptIndex) || 1,
    started_at: start.toISOString(),
    finished_at: finishedAt.toISOString(),
    elapsed_ms: Math.max(0, finishedAt.getTime() - start.getTime()),
    generation_timeout_ms: Number(timeoutMs) || null,
    transport_retry: transportRetry === true,
    outbound_transport_started: outboundTransportStarted === true,
    secure_connected: connected === true,
    connected: connected === true,
    secure_connect_elapsed_ms: elapsed(secureConnectedAt),
    secure_connect_observation: secureConnectObservation,
    secure_connect_observed_elapsed_ms: elapsed(secureConnectObservedAt),
    request_body_sent: requestBodySent === true,
    request_body_sent_elapsed_ms: elapsed(requestBodySentAt),
    response_headers_received: responseReceived === true,
    response_headers_elapsed_ms: elapsed(responseHeadersReceivedAt),
    response_first_byte_elapsed_ms: elapsed(responseFirstByteAt),
    response_received: responseReceived === true,
    http_status: httpStatus === null || httpStatus === undefined || httpStatus === '' ? null : (Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null),
    returned_model: null,
    finish_reason: null,
    content_state: 'NOT_AVAILABLE',
    content_length: null,
    raw_content_length: null,
    trimmed_content_length: null,
    non_whitespace_length: null,
    whitespace_only: false,
    reasoning_content_exists: false,
    reasoning_content_length: 0,
    json_parse: 'NOT_RUN',
    schema_validation: 'NOT_RUN',
    failure_stage: failureStage || null,
    failure_code: failureCode || null,
  };
}

function requestCompletion(endpoint, apiKey, payload, { timeoutMs, requestId, attemptIndex = 1, onTransportStarted = null }) {
  const startedAt = new Date();
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); }
    catch { reject(Object.assign(new Error('Provider endpoint is invalid.'), { code: 'PROVIDER_ENDPOINT_INVALID' })); return; }
    if (url.protocol !== 'https:') {
      reject(Object.assign(new Error('Provider endpoint must use HTTPS.'), { code: 'PROVIDER_ENDPOINT_NOT_HTTPS' }));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const agent = new https.Agent({ proxyEnv: process.env, keepAlive: false, maxSockets: 1 });
    let connected = false;
    let responseReceived = false;
    let outboundTransportStarted = false;
    let requestBodySent = false;
    let secureConnectedAt = null;
    let secureConnectObservation = 'NOT_OBSERVED';
    let secureConnectObservedAt = null;
    let requestBodySentAt = null;
    let responseHeadersReceivedAt = null;
    let responseFirstByteAt = null;
    let httpStatus = null;
    let timer;
    let settled = false;
    const makeTelemetry = (failureStage, failureCode = null) => buildAttemptTelemetrySnapshot({
      attemptIndex, startedAt, timeoutMs, transportRetry: attemptIndex > 1,
      connected, responseReceived, httpStatus, failureStage, failureCode, outboundTransportStarted,
      requestBodySent, secureConnectedAt, secureConnectObservation, secureConnectObservedAt,
      requestBodySentAt, responseHeadersReceivedAt, responseFirstByteAt,
    });
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.attempt_telemetry = error.attempt_telemetry || makeTelemetry(
        attemptFailureStage(error, responseReceived), String(error?.code || error?.cause?.code || 'TRANSPORT_ERROR'),
      );
      reject(error);
    };
    const req = https.request(url, {
      method: 'POST',
      agent,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': body.length,
        'X-Request-ID': requestId,
      },
    }, response => {
      // A valid HTTPS response proves that the target TLS session completed,
      // even when a proxy Agent handed the request an already-secured socket.
      if (!connected) {
        connected = true;
        secureConnectObservation = 'IMPLIED_BY_HTTPS_RESPONSE';
        secureConnectObservedAt = new Date();
      }
      responseReceived = true;
      responseHeadersReceivedAt = new Date();
      httpStatus = Number(response.statusCode) || null;
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        responseFirstByteAt ||= new Date();
        bytes += chunk.length;
        if (bytes > RESPONSE_BODY_LIMIT) {
          req.destroy(Object.assign(new Error('Provider response body exceeded limit.'), { code: 'PROVIDER_RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* classified below */ }
        const parsedBody = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        const choice = parsedBody?.choices?.[0];
        const message = choice?.message;
        const rawContent = message?.content;
        const content = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.map(item => item?.text || '').join('') : '';
        const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
        const requestIdFromProvider = providerRequestId(response.headers);
        const providerError = response.statusCode >= 200 && response.statusCode < 300
          ? { provider_error_code: null, provider_error_message: null }
          : providerErrorDetails(parsedBody);
        const attemptTelemetry = {
          ...makeTelemetry(response.statusCode >= 200 && response.statusCode < 300 ? 'SUCCESS' : 'HTTP', response.statusCode >= 200 && response.statusCode < 300 ? null : `HTTP_${response.statusCode}`),
          provider_request_id: requestIdFromProvider,
          ...providerError,
          returned_model: typeof parsedBody?.model === 'string' ? parsedBody.model : null,
          finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
          content_state: rawContent == null ? 'EMPTY' : content.trim() ? 'NON_EMPTY' : 'EMPTY',
          content_length: content.length,
          ...whitespaceTelemetry(content),
          reasoning_content_exists: Boolean(message && Object.hasOwn(message, 'reasoning_content')),
          reasoning_content_length: reasoning.length,
          json_parse: parsedBody ? 'PASS' : 'FAIL',
          schema_validation: 'NOT_RUN',
          failure_stage: response.statusCode >= 200 && response.statusCode < 300 ? 'SUCCESS' : 'HTTP',
          failure_code: response.statusCode >= 200 && response.statusCode < 300 ? null : `HTTP_${response.statusCode}`,
        };
        resolve({ status: response.statusCode || 0, headers: response.headers, body: parsedBody, provider_request_id: requestIdFromProvider, ...providerError, attempt_telemetry: attemptTelemetry });
      });
      response.on('error', fail);
    });
    req.on('socket', socket => {
      socket.on('secureConnect', () => {
        connected = true;
        secureConnectedAt = new Date();
        secureConnectObservation = 'SECURE_CONNECT_EVENT';
        secureConnectObservedAt = secureConnectedAt;
      });
      // Node's proxyEnv Agent may emit `secureConnect` before assigning its
      // already-tunneled TLSSocket to ClientRequest. Record the completed
      // handshake as observed, but do not invent its elapsed time.
      if (socket.encrypted === true && socket.secureConnecting === false) {
        connected = true;
        if (secureConnectObservation === 'NOT_OBSERVED') {
          secureConnectObservation = socket.authorized === true
            ? 'SOCKET_ALREADY_TLS_AUTHORIZED' : 'SOCKET_ALREADY_TLS_ESTABLISHED';
          secureConnectObservedAt = new Date();
        }
      }
    });
    req.on('finish', () => { requestBodySent = true; requestBodySentAt = new Date(); });
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Provider request timed out.'), { code: 'ETIMEDOUT' });
      error.attempt_telemetry = makeTelemetry(responseReceived ? 'TIMEOUT_DURING_RESPONSE' : 'TIMEOUT_BEFORE_RESPONSE', 'ETIMEDOUT');
      fail(error);
      req.destroy(error);
    }, timeoutMs);
    timer.unref?.();
    req.on('error', fail);
    req.on('close', () => { clearTimeout(timer); agent.destroy(); });
    // This is the first point where the request is handed to Node's HTTPS
    // transport. Local validation/routing failures above do not count.
    outboundTransportStarted = true;
    try { onTransportStarted?.(); } catch { /* Telemetry callbacks must not alter transport behavior. */ }
    req.end(body);
  });
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function createOpenAiCompatibleAdapter(config, { env = process.env, transport = requestCompletion } = {}) {
  const provider = String(config?.name || '').trim();
  const endpoint = String(config?.endpoint || '').trim();
  const requestedModel = String(config?.requestedModel || config?.requested_model || config?.model || '').trim();
  const model = String(config?.model || config?.effective_request_model || requestedModel).trim();
  const credentialEnv = String(config?.credentialEnv || config?.credential_env || '').trim();
  let lastProbeState = null;

  function localConfiguration() {
    const apiKey = credentialEnv ? String(env[credentialEnv] || '').trim() : '';
    if (!provider || !endpoint || !model || !credentialEnv || !apiKey) {
      return { configured: false, ready: false, status: 'NOT_CONFIGURED', reason_code: 'PROVIDER_NOT_CONFIGURED', model: model || null, requested_model: requestedModel || null, effective_request_model: model || null, returned_model: null, endpoint_host: safeEndpointHost(endpoint) };
    }
    return { configured: true, ready: false, status: 'UNAVAILABLE', reason_code: 'PROVIDER_READINESS_NOT_PROBED', model, requested_model: requestedModel, effective_request_model: model, returned_model: null, endpoint_host: safeEndpointHost(endpoint) };
  }

  async function complete(input, options = {}) {
    const local = localConfiguration();
    if (local.status === 'NOT_CONFIGURED') throw Object.assign(new Error(safeStatusMessage('PROVIDER_NOT_CONFIGURED')), { code: 'PROVIDER_NOT_CONFIGURED' });
    let providerDispatchAttempted = false;
    let outboundTransportStartedCount = 0;
    const apiKey = String(env[credentialEnv] || '').trim();
    const requestId = String(input?.request_id || crypto.randomUUID());
    const timeoutMs = boundedInteger(options.timeoutMs ?? input?.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 120000);
    const maxRetries = boundedInteger(options.maxRetries ?? input?.max_retries, MAX_RETRIES, 0, MAX_RETRIES);
    const apiProtocol = String(input?.api_protocol || options.apiProtocol || 'CHAT_COMPLETIONS').toUpperCase();
    const responsesApi = apiProtocol === 'RESPONSES';
    if (responsesApi && provider.toLowerCase() !== 'deepseek') throw Object.assign(new Error('Responses protocol is enabled only for DeepSeek Listing calls.'), { code: 'PROVIDER_RESPONSES_PROVIDER_UNSUPPORTED' });
    const jsonSchema = input?.json_schema && typeof input.json_schema === 'object' ? input.json_schema : null;
    const structured = responsesApi || options.structured === true || input?.structured_output === true || input?.response_format === 'json_object' || Boolean(jsonSchema);
    const isQwen = provider.toLowerCase() === 'qwen';
    const reasoningEffort = typeof input?.reasoning_effort === 'string' ? input.reasoning_effort : null;
    const preserveThinking = isQwen && typeof input?.preserve_thinking === 'boolean' ? input.preserve_thinking : null;
    const thinkingMode = (provider.toLowerCase() === 'deepseek' && input?.extra_body?.thinking?.type === 'disabled')
      || (isQwen && reasoningEffort === 'none') ? 'disabled' : null;
    const requestModeTelemetry = {
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(preserveThinking !== null ? { preserve_thinking: preserveThinking } : {}),
      ...(thinkingMode ? { thinking_mode: thinkingMode } : {}),
      ...(Number.isFinite(Number(input?.max_tokens)) ? { max_tokens_requested: Number(input.max_tokens) } : {}),
      ...(Number.isFinite(Number(input?.max_completion_tokens)) ? { max_completion_tokens_requested: Number(input.max_completion_tokens) } : {}),
    };
    const messages = Array.isArray(input?.messages)
      ? input.messages.map(message => ({ role: message.role, content: message.content }))
      : [
        { role: 'system', content: String(input?.system || 'You are a helpful assistant.') },
        { role: 'user', content: String(input?.prompt || '') },
      ];
    if (!messages.some(message => String(message.content || '').trim())) {
      throw Object.assign(new Error('AI provider request requires non-empty messages.'), { code: 'AI_PROMPT_REQUIRED' });
    }
    if (structured) {
      const system = messages.find(message => message.role === 'system');
      if (system) system.content = `${system.content}\nReturn a JSON object only.`;
      else messages.unshift({ role: 'system', content: 'Return a JSON object only.' });
      if (!messages.some(message => /json/i.test(String(message.content || '')))) messages.push({ role: 'user', content: 'Return a valid JSON object.' });
    }
    if (responsesApi && !jsonSchema) throw Object.assign(new Error('Responses structured output requires a formal JSON Schema.'), { code: 'PROVIDER_RESPONSES_SCHEMA_REQUIRED' });
    const chatJsonSchema = !responsesApi && provider.toLowerCase() === 'qwen' && jsonSchema
      ? { type: 'json_schema', json_schema: { name: schemaName(input?.json_schema_name || input?.module), strict: true, schema: jsonSchema } }
      : null;
    const requestEndpoint = responsesApi ? resolveResponsesEndpoint(endpoint) : endpoint;
    const payload = responsesApi ? {
      model,
      instructions: messages.find(message => message.role === 'system')?.content || 'Return JSON only.',
      input: [{ role: 'user', content: messages.find(message => message.role === 'user')?.content || '' }],
      reasoning: { effort: String(input?.reasoning_effort || 'none') },
      text: { format: { type: 'json_schema', name: schemaName(input?.json_schema_name || input?.module), schema: jsonSchema } },
      max_output_tokens: boundedInteger(input?.max_output_tokens, 16384, 1, 65536),
      stream: false,
    } : {
      model, messages, stream: false,
      ...(chatJsonSchema ? { response_format: chatJsonSchema } : (structured ? { response_format: { type: 'json_object' } } : {})),
      // Qwen 3.8 documents `reasoning_effort: "none"` as the supported way
      // to disable thinking. Do not also send the unrelated `thinking` object
      // (used by other provider families) on the Qwen Chat Completions path.
      ...(thinkingMode && !isQwen ? { extra_body: { thinking: { type: 'disabled' } } } : {}),
      ...(isQwen && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(isQwen && preserveThinking !== null ? { preserve_thinking: preserveThinking } : {}),
      ...(isQwen && Number.isFinite(Number(input?.max_completion_tokens)) ? { max_completion_tokens: boundedInteger(input.max_completion_tokens, 1024, 1, 131072) } : {}),
      ...(Number.isFinite(Number(input?.max_tokens)) ? { max_tokens: boundedInteger(input.max_tokens, 1024, 1, isQwen ? 131072 : 8192) } : {}),
      ...(Number.isFinite(Number(input?.temperature)) ? { temperature: Math.max(0, Math.min(2, Number(input.temperature))) } : {}),
    };
    let response;
    let attempts = 0;
    const attemptTelemetry = [];
    const persistAttemptLifecycle = async (callback, telemetry) => {
      if (typeof callback !== 'function') return;
      try { await callback(telemetry); }
      catch { throw Object.assign(new Error('Probe telemetry could not be persisted; provider execution stopped.'), { code: 'AI_PROBE_TELEMETRY_PERSIST_FAILED', attempt_telemetry: telemetry ? [telemetry] : [] }); }
    };
    providerDispatchAttempted = true;
    while (true) {
      attempts += 1;
      let thisAttemptOutboundStarted = false;
      const attemptStartedAt = new Date();
      await persistAttemptLifecycle(input?.on_attempt_started, {
        attempt_index: attempts, attempt_status: 'RUNNING', started_at: attemptStartedAt.toISOString(),
        generation_timeout_ms: timeoutMs, transport_retry: attempts > 1,
        ...requestModeTelemetry,
      });
      try {
        response = await transport(requestEndpoint, apiKey, payload, {
          timeoutMs, requestId, attemptIndex: attempts,
          onTransportStarted: () => {
            thisAttemptOutboundStarted = true;
            outboundTransportStartedCount += 1;
            try { input?.on_outbound_transport_started?.({ attempt_index: attempts, started_at: new Date().toISOString() }); } catch { /* Audit callback cannot affect Provider transport. */ }
          },
        });
      } catch (error) {
        const rawCode = String(error?.code || error?.cause?.code || 'TRANSPORT_ERROR');
        const code = classifyProviderFailure({ errorCode: rawCode });
        const retryable = transientCode(rawCode);
        attemptTelemetry.push({
          ...(error?.attempt_telemetry || {
            attempt_index: attempts, started_at: attemptStartedAt.toISOString(), finished_at: new Date().toISOString(),
            elapsed_ms: Math.max(0, Date.now() - attemptStartedAt.getTime()), generation_timeout_ms: timeoutMs,
            transport_retry: attempts > 1, outbound_transport_started: thisAttemptOutboundStarted, connected: false, response_received: false, http_status: null,
            returned_model: null, finish_reason: null, content_state: 'NOT_AVAILABLE', content_length: null,
            reasoning_content_exists: false, reasoning_content_length: 0, json_parse: 'NOT_RUN', schema_validation: 'NOT_RUN',
            failure_stage: attemptFailureStage(error, false), failure_code: rawCode,
          }),
          attempt_index: attempts, generation_timeout_ms: timeoutMs, transport_retry: attempts > 1,
          ...requestModeTelemetry,
          json_parse: 'NOT_RUN', schema_validation: 'NOT_RUN', failure_code: rawCode,
        });
        await persistAttemptLifecycle(input?.on_attempt_finished, attemptTelemetry.at(-1));
        if (retryable && attempts <= maxRetries) {
          await new Promise(resolve => setTimeout(resolve, Math.min(500 * attempts, 1000)));
          continue;
        }
        throw Object.assign(new Error(safeStatusMessage(code)), {
          code, provider, request_id: requestId, attempt_count: attempts, retryable, attempt_telemetry: attemptTelemetry,
        });
      }
      if (!(response.status >= 200 && response.status < 300)) {
        const details = providerErrorDetails(response.body);
        const lastAttempt = attemptTelemetry.at(-1);
        response.provider_error_code ||= details.provider_error_code;
        response.provider_error_message ||= details.provider_error_message;
        response.provider_request_id ||= providerRequestId(response.headers);
        if (lastAttempt) {
          lastAttempt.provider_error_code ||= response.provider_error_code;
          lastAttempt.provider_error_message ||= response.provider_error_message;
          lastAttempt.provider_request_id ||= response.provider_request_id;
        }
      }
      const currentAttempt = response?.attempt_telemetry || {
        attempt_index: attempts, started_at: attemptStartedAt.toISOString(), finished_at: new Date().toISOString(),
        elapsed_ms: Math.max(0, Date.now() - attemptStartedAt.getTime()), generation_timeout_ms: timeoutMs,
        transport_retry: attempts > 1, connected: response?.status != null, response_received: response?.status != null,
        http_status: Number(response?.status) || null, returned_model: response?.body?.model || null,
        finish_reason: response?.body?.choices?.[0]?.finish_reason || null, content_state: 'NOT_AVAILABLE', content_length: null,
        reasoning_content_exists: false, reasoning_content_length: 0, json_parse: response?.body ? 'PASS' : 'FAIL',
        schema_validation: 'NOT_RUN', failure_stage: response?.status >= 200 && response?.status < 300 ? 'SUCCESS' : 'HTTP',
        failure_code: response?.status >= 200 && response?.status < 300 ? null : `HTTP_${response?.status || 0}`,
      };
      const responseProvesTransportStarted = Number(response?.status) > 0;
      if (responseProvesTransportStarted && !thisAttemptOutboundStarted) outboundTransportStartedCount += 1;
      attemptTelemetry.push({ ...currentAttempt,
        ...requestModeTelemetry,
        api_protocol: responsesApi ? 'RESPONSES' : 'CHAT_COMPLETIONS',
        structured_output: jsonSchema ? 'json_schema' : (structured ? 'json_object' : null),
        max_output_tokens_requested: responsesApi ? payload.max_output_tokens : null,
        outbound_transport_started: thisAttemptOutboundStarted || currentAttempt.outbound_transport_started === true || responseProvesTransportStarted,
        attempt_index: attempts, generation_timeout_ms: timeoutMs, transport_retry: attempts > 1, ...(thinkingMode ? { thinking_mode: thinkingMode } : {}) });
      if (response.status >= 200 && response.status < 300) break;
      await persistAttemptLifecycle(input?.on_attempt_finished, attemptTelemetry.at(-1));
      const code = classifyProviderFailure({ status: response.status });
      const retryable = response.status === 429 || response.status >= 500 || response.status === 408 || response.status === 504;
      const retryAfter = Number(response.headers?.['retry-after']);
      if (retryable && attempts <= maxRetries && (!Number.isFinite(retryAfter) || retryAfter <= 1)) {
        await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : Math.min(500 * attempts, 1000)));
        continue;
      }
      throw Object.assign(new Error(safeStatusMessage(code)), {
        code, provider, request_id: requestId, http_status: response.status,
        provider_request_id: response.provider_request_id || attemptTelemetry.at(-1)?.provider_request_id || null,
        provider_error_code: response.provider_error_code || attemptTelemetry.at(-1)?.provider_error_code || null,
        provider_error_message: response.provider_error_message || attemptTelemetry.at(-1)?.provider_error_message || null,
        attempt_count: attempts, retryable, attempt_telemetry: attemptTelemetry,
      });
    }
    const envelope = response.body;
    const responseStatus = responsesApi ? String(envelope?.status || 'failed') : null;
    const incompleteReason = responsesApi ? String(envelope?.incomplete_details?.reason || '') || null : null;
    const rawContent = responsesApi ? extractResponsesText(envelope) : envelope?.choices?.[0]?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.map(item => item?.text || '').join('') : '';
    const message = responsesApi ? null : envelope?.choices?.[0]?.message;
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    const finishReason = responsesApi ? responseStatus : (typeof envelope?.choices?.[0]?.finish_reason === 'string' ? envelope.choices[0].finish_reason : null);
    const currentAttemptTelemetry = attemptTelemetry[attemptTelemetry.length - 1];
    if (currentAttemptTelemetry) {
      currentAttemptTelemetry.returned_model = typeof envelope?.model === 'string' ? envelope.model : null;
      currentAttemptTelemetry.finish_reason = finishReason;
      if (responsesApi) {
        currentAttemptTelemetry.response_status = responseStatus;
        currentAttemptTelemetry.incomplete_reason = incompleteReason;
        currentAttemptTelemetry.max_output_tokens_requested = payload.max_output_tokens;
        currentAttemptTelemetry.input_tokens = Number.isFinite(Number(envelope?.usage?.input_tokens)) ? Number(envelope.usage.input_tokens) : null;
        currentAttemptTelemetry.output_tokens = Number.isFinite(Number(envelope?.usage?.output_tokens)) ? Number(envelope.usage.output_tokens) : null;
        currentAttemptTelemetry.reasoning_tokens = Number.isFinite(Number(envelope?.usage?.output_tokens_details?.reasoning_tokens)) ? Number(envelope.usage.output_tokens_details.reasoning_tokens) : null;
      }
      currentAttemptTelemetry.content_state = rawContent == null || !content.trim() ? 'EMPTY' : 'NON_EMPTY';
      currentAttemptTelemetry.content_length = content.length;
      Object.assign(currentAttemptTelemetry, whitespaceTelemetry(content));
      currentAttemptTelemetry.reasoning_content_exists = responsesApi
        ? (Number(envelope?.usage?.output_tokens_details?.reasoning_tokens) > 0)
        : Boolean(message && Object.hasOwn(message, 'reasoning_content'));
      currentAttemptTelemetry.reasoning_content_length = reasoning.length;
    }
    if (responsesApi && responseStatus !== 'completed') {
      const code = responseStatus === 'incomplete'
        ? (incompleteReason === 'max_output_tokens' ? 'PROVIDER_INCOMPLETE_MAX_OUTPUT_TOKENS' : incompleteReason === 'content_filter' ? 'PROVIDER_INCOMPLETE_CONTENT_FILTER' : 'PROVIDER_INCOMPLETE')
        : 'PROVIDER_RESPONSE_FAILED';
      if (currentAttemptTelemetry) {
        currentAttemptTelemetry.failure_stage = responseStatus === 'incomplete' ? 'INCOMPLETE' : 'PROVIDER_FAILED';
        currentAttemptTelemetry.failure_code = code;
      }
      await persistAttemptLifecycle(input?.on_attempt_finished, currentAttemptTelemetry);
      throw Object.assign(new Error('DeepSeek Responses returned a non-completed response.'), {
        code, provider, request_id: requestId, http_status: response.status, response_status: responseStatus,
        incomplete_reason: incompleteReason, attempt_count: attempts, attempt_telemetry: attemptTelemetry,
        usage: safeUsage(envelope?.usage),
      });
    }
    if (!envelope || !content.trim()) {
      const emptyResponse = !envelope;
      const code = emptyResponse ? 'PROVIDER_RESPONSE_INVALID' : (structured ? 'PROVIDER_STRUCTURED_RESPONSE_INVALID' : 'PROVIDER_RESPONSE_INVALID');
      const failureCode = currentAttemptTelemetry?.json_parse === 'FAIL' ? 'PROVIDER_RESPONSE_JSON_INVALID' : 'PROVIDER_EMPTY_CONTENT';
      if (currentAttemptTelemetry) { currentAttemptTelemetry.failure_stage = failureCode === 'PROVIDER_RESPONSE_JSON_INVALID' ? 'JSON_PARSE' : 'EMPTY_CONTENT'; currentAttemptTelemetry.failure_code = failureCode; }
      await persistAttemptLifecycle(input?.on_attempt_finished, currentAttemptTelemetry);
      throw Object.assign(new Error(safeStatusMessage(code)), { code: failureCode, provider, request_id: requestId, http_status: response.status, attempt_count: attempts, attempt_telemetry: attemptTelemetry });
    }
    let structuredResponse = null;
    if (structured) {
      try {
        structuredResponse = JSON.parse(content);
        if (currentAttemptTelemetry) currentAttemptTelemetry.json_parse = 'PASS';
      } catch {
        if (currentAttemptTelemetry) { currentAttemptTelemetry.json_parse = 'FAIL'; currentAttemptTelemetry.failure_stage = 'JSON_PARSE'; currentAttemptTelemetry.failure_code = 'PROVIDER_JSON_PARSE_FAILED'; }
        await persistAttemptLifecycle(input?.on_attempt_finished, currentAttemptTelemetry);
        throw Object.assign(new Error(safeStatusMessage('PROVIDER_STRUCTURED_RESPONSE_INVALID')), { code: 'PROVIDER_JSON_PARSE_FAILED', provider, request_id: requestId, http_status: response.status, attempt_count: attempts, attempt_telemetry: attemptTelemetry });
      }
      if (jsonSchema) {
        const schemaResult = validateListingSopJsonSchema(structuredResponse, jsonSchema);
        if (currentAttemptTelemetry) currentAttemptTelemetry.schema_validation = schemaResult.valid ? 'PASS' : 'FAIL';
        if (!schemaResult.valid) {
          if (currentAttemptTelemetry) {
            currentAttemptTelemetry.failure_stage = 'SCHEMA_VALIDATION';
            currentAttemptTelemetry.failure_code = 'PROVIDER_JSON_SCHEMA_INVALID';
            // Persist schema paths/codes only, never the response or field values.
            currentAttemptTelemetry.schema_validation_errors = schemaResult.errors.slice(0, 32);
            currentAttemptTelemetry.schema_validation_details = schemaResult.details.slice(0, 32);
          }
          await persistAttemptLifecycle(input?.on_attempt_finished, currentAttemptTelemetry);
          throw Object.assign(new Error(`${provider} structured output failed local JSON Schema validation.`), { code: 'PROVIDER_JSON_SCHEMA_INVALID', provider, request_id: requestId, http_status: response.status, attempt_count: attempts, attempt_telemetry: attemptTelemetry });
        }
      }
    }
    await persistAttemptLifecycle(input?.on_attempt_finished, currentAttemptTelemetry);
    return {
      provider,
      model: String(envelope.model || model),
      version: String(envelope.model || model),
      adapter_version: responsesApi ? DEEPSEEK_RESPONSES_ADAPTER_VERSION : ADAPTER_VERSION,
      requested_model: requestedModel,
      effective_request_model: model,
      returned_model: String(envelope.model || ''),
      ...(thinkingMode ? { thinking_mode: thinkingMode } : {}),
      ...(responsesApi ? { api_protocol: 'RESPONSES', structured_output: 'json_schema', reasoning_effort: String(input?.reasoning_effort || 'none'), max_output_tokens: payload.max_output_tokens, response_status: responseStatus, incomplete_reason: incompleteReason } : {}),
      ...(!responsesApi && jsonSchema ? { api_protocol: 'CHAT_COMPLETIONS', structured_output: 'json_schema', json_schema_name: schemaName(input?.json_schema_name || input?.module) } : {}),
      ...(isQwen && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(isQwen && preserveThinking !== null ? { preserve_thinking: preserveThinking } : {}),
      ...(isQwen && Number.isFinite(Number(payload.max_completion_tokens)) ? { max_completion_tokens: Number(payload.max_completion_tokens) } : {}),
      ...(isQwen && Number.isFinite(Number(payload.max_tokens)) ? { max_tokens: Number(payload.max_tokens) } : {}),
      request_id: requestId,
      provider_request_id: providerRequestId(response.headers),
      content,
      structured_response: structuredResponse,
      usage: safeUsage(envelope.usage),
      http_status: response.status,
      attempt_count: attempts,
      ...providerTransportCounters({ attempts: attemptTelemetry, providerDispatchAttempted }),
      finish_reason: finishReason,
      attempt_telemetry: attemptTelemetry,
    };
  }

  return {
    provider,
    model,
    endpoint_host: safeEndpointHost(endpoint),
    executionMetadata() { const responses = provider.toLowerCase() === 'deepseek'; return { provider, requested_model: requestedModel || model, effective_request_model: model, adapter_version: responses ? DEEPSEEK_RESPONSES_ADAPTER_VERSION : ADAPTER_VERSION, adapter_contract_version: responses ? 'AI_PROVIDER_RESULT_CONTRACT_V2' : 'AI_PROVIDER_RESULT_CONTRACT_V1' }; },
    async readiness() {
      const local = localConfiguration();
      if (local.status === 'NOT_CONFIGURED') return local;
      return lastProbeState ? { ...lastProbeState } : local;
    },
    async probeReadiness({ timeoutMs = 15000, baseline = false } = {}) {
      const local = localConfiguration();
      if (local.status === 'NOT_CONFIGURED') {
        const result = { ...local, checked_at: new Date().toISOString(), external_request_count: 0 };
        lastProbeState = result;
        return result;
      }
      const checkedAt = new Date().toISOString();
      const requestId = crypto.randomUUID();
      const deepSeekProbe = provider.toLowerCase() === 'deepseek';
      const expected = deepSeekProbe && !baseline ? { status: 'ok' } : { ready: true };
      const promptJson = JSON.stringify(expected);
      const systemPrompt = baseline && deepSeekProbe
        ? 'Return only a JSON object with one boolean field ready set to true. JSON output is required.'
        : `Return JSON only. Match this schema exactly: ${promptJson}`;
      const userPrompt = baseline && deepSeekProbe
        ? 'Return exactly this readiness JSON: {"ready":true}'
        : promptJson;
      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        response_format: { type: 'json_object' },
        max_tokens: deepSeekProbe && !baseline ? 256 : 32,
        temperature: 0,
      };
      let response = null;
      let providerDispatchAttempted = false;
      let outboundTransportStartedCount = 0;
      try {
        providerDispatchAttempted = true;
        response = await transport(endpoint, String(env[credentialEnv] || '').trim(), payload, {
          timeoutMs, requestId,
          onTransportStarted: () => { outboundTransportStartedCount += 1; },
        });
        const envelope = response?.body;
        const choices = Array.isArray(envelope?.choices) ? envelope.choices : null;
        const choice = choices?.[0] || null;
        const message = choice?.message && typeof choice.message === 'object' ? choice.message : null;
        const rawContent = message?.content;
        const content = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent) ? rawContent.map(item => typeof item?.text === 'string' ? item.text : '').join('') : '';
        const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
        const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
        const shapeValid = Boolean(envelope && typeof envelope === 'object' && !Array.isArray(envelope)
          && typeof envelope.model === 'string' && Array.isArray(envelope.choices));
        let parsed = null;
        let jsonParseSuccess = false;
        let schemaValidationSuccess = false;
        if (content.trim()) {
          try { parsed = JSON.parse(content); jsonParseSuccess = true; } catch { /* content is never included in diagnostics */ }
        }
        if (jsonParseSuccess && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const keys = Object.keys(parsed);
          schemaValidationSuccess = deepSeekProbe
            ? keys.length === 1 && parsed.status === 'ok'
            : keys.length === 1 && parsed.ready === true;
        }
        const diagnostic = {
          http_status: Number(response?.status) || null,
          provider_error_code: response?.provider_error_code || providerErrorDetails(response?.body).provider_error_code,
          provider_error_message: response?.provider_error_message || providerErrorDetails(response?.body).provider_error_message,
          provider_request_id: response?.provider_request_id || providerRequestId(response?.headers),
          returned_model: typeof envelope?.model === 'string' ? envelope.model : null,
          top_level_schema_valid: shapeValid,
          choices_present: Array.isArray(envelope?.choices),
          choices_count: choices?.length ?? 0,
          finish_reason: finishReason,
          message_present: Boolean(message),
          content_state: rawContent == null ? 'null' : content.length ? 'non-empty' : 'empty',
          content_length: content.length,
          ...whitespaceTelemetry(content),
          reasoning_content_present: Boolean(message && Object.prototype.hasOwnProperty.call(message, 'reasoning_content')),
          reasoning_content_length: reasoning.length,
          usage: safeUsage(envelope?.usage),
          json_parse_success: jsonParseSuccess,
          schema_validation_success: schemaValidationSuccess,
          failure_stage: null,
          secondary_reason_code: null,
          request_contract: { response_format_type: 'json_object', stream: false, max_tokens: payload.max_tokens, expected_json: promptJson },
        };
        let failureCode = null;
        if (!(response.status >= 200 && response.status < 300)) {
          diagnostic.failure_stage = 'HTTP';
          failureCode = classifyProviderFailure({ status: response.status });
        } else if (!shapeValid || !message) {
          diagnostic.failure_stage = 'OPENAI_RESPONSE_SHAPE';
          failureCode = 'PROVIDER_RESPONSE_SHAPE_INVALID';
        } else if (finishReason === 'length') {
          diagnostic.failure_stage = content.trim() ? (jsonParseSuccess ? 'STRUCTURED_SCHEMA_VALIDATION' : 'JSON_PARSE') : 'EMPTY_CONTENT';
          failureCode = 'PROVIDER_OUTPUT_TRUNCATED';
          diagnostic.secondary_reason_code = content.trim() ? (jsonParseSuccess ? null : 'PROVIDER_JSON_PARSE_FAILED') : 'PROVIDER_EMPTY_CONTENT';
        } else if (!content.trim()) {
          diagnostic.failure_stage = 'EMPTY_CONTENT';
          failureCode = 'PROVIDER_EMPTY_CONTENT';
        } else if (!jsonParseSuccess) {
          diagnostic.failure_stage = 'JSON_PARSE';
          failureCode = 'PROVIDER_JSON_PARSE_FAILED';
        } else if (!schemaValidationSuccess) {
          diagnostic.failure_stage = 'STRUCTURED_SCHEMA_VALIDATION';
          failureCode = 'PROVIDER_SCHEMA_INVALID';
        }
        const ready = failureCode === null && Boolean(diagnostic.returned_model);
        const snapshot = {
          ready,
          status: ready ? 'READY' : failureCode === 'PROVIDER_AUTH_FAILED' ? 'AUTH_FAILED' : 'UNAVAILABLE',
          reason_code: failureCode,
          model: diagnostic.returned_model || model,
          adapter_version: ADAPTER_VERSION,
          requested_model: requestedModel,
          effective_request_model: model,
          returned_model: diagnostic.returned_model,
          endpoint_host: safeEndpointHost(endpoint),
          checked_at: checkedAt,
          http_status: diagnostic.http_status,
          request_id: requestId,
          provider_request_id: diagnostic.provider_request_id,
          provider_error_code: diagnostic.provider_error_code,
          provider_error_message: diagnostic.provider_error_message,
          usage: diagnostic.usage,
          diagnostics: diagnostic,
          ...providerTransportCounters({ attempts: response?.attempt_telemetry, providerDispatchAttempted, fallbackHttpStatus: response?.status }),
          external_request_count: outboundTransportStartedCount || (response?.status ? 1 : 0),
        };
        lastProbeState = snapshot;
        return snapshot;
      } catch (error) {
        const code = String(error?.code || 'PROVIDER_UNAVAILABLE');
        const diagnostic = {
          http_status: Number(error?.http_status) || null,
          provider_error_code: error?.provider_error_code || error?.attempt_telemetry?.at(-1)?.provider_error_code || null,
          provider_error_message: error?.provider_error_message || error?.attempt_telemetry?.at(-1)?.provider_error_message || null,
          provider_request_id: error?.provider_request_id || error?.attempt_telemetry?.at(-1)?.provider_request_id || null,
          returned_model: null,
          top_level_schema_valid: false,
          choices_present: false,
          choices_count: 0,
          finish_reason: null,
          message_present: false,
          content_state: 'null',
          content_length: 0,
          reasoning_content_present: false,
          reasoning_content_length: 0,
          usage: null,
          json_parse_success: false,
          schema_validation_success: false,
          failure_stage: 'HTTP',
          request_contract: { response_format_type: 'json_object', stream: false, max_tokens: payload.max_tokens, expected_json: promptJson },
        };
        const snapshot = {
          ready: false,
          status: code === 'PROVIDER_AUTH_FAILED' ? 'AUTH_FAILED' : 'UNAVAILABLE',
          reason_code: code,
          reason: safeStatusMessage(code),
          model,
          adapter_version: ADAPTER_VERSION,
          requested_model: requestedModel,
          effective_request_model: model,
          returned_model: null,
          endpoint_host: safeEndpointHost(endpoint),
          checked_at: checkedAt,
          http_status: Number(error?.http_status) || null,
          request_id: requestId,
          provider_request_id: diagnostic.provider_request_id,
          provider_error_code: diagnostic.provider_error_code,
          provider_error_message: diagnostic.provider_error_message,
          diagnostics: diagnostic,
          ...providerTransportCounters({ attempts: error?.attempt_telemetry, providerDispatchAttempted, fallbackHttpStatus: error?.http_status }),
          external_request_count: outboundTransportStartedCount || (error?.http_status ? 1 : 0),
        };
        lastProbeState = snapshot;
        return snapshot;
      }
    },
    async invoke(input) {
      return complete(input);
    },
  };
}

function safeEndpointHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return null; }
}

export const aiProviderConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
export const aiProviderAdapters = new Map();
for (const config of aiProviderConfig.providers || []) {
  const name = String(config?.name || '').trim();
  if (!['Qwen', 'DeepSeek'].includes(name)) continue;
  const adapter = createOpenAiCompatibleAdapter(config);
  aiProviderAdapters.set(name, adapter);
  registerAiProviderAdapter(name, adapter);
}

export async function probeRegisteredAiProviders(names = ['Qwen', 'DeepSeek'], options = {}) {
  const providers = {};
  for (const name of names) {
    const adapter = aiProviderAdapters.get(name);
    if (!adapter) {
      providers[name] = { ready: false, status: 'NOT_CONFIGURED', reason_code: 'PROVIDER_ADAPTER_NOT_REGISTERED', external_request_count: 0 };
      continue;
    }
    providers[name] = await adapter.probeReadiness(options);
  }
  return {
    status: providers.Qwen?.ready === true && providers.DeepSeek?.ready === true ? 'PASS' : 'WAITING_DEPENDENCY',
    QWEN: providers.Qwen?.status || 'NOT_CONFIGURED',
    DEEPSEEK: providers.DeepSeek?.status || 'NOT_CONFIGURED',
    GPT: 'OPTIONAL_NOT_CONFIGURED',
    mock: 'DISABLED',
    providers,
    primary_ready: names.includes('Qwen') && names.includes('DeepSeek') && providers.Qwen?.ready === true && providers.DeepSeek?.ready === true,
    external_request_count: Object.values(providers).reduce((sum, item) => sum + Number(item.external_request_count || 0), 0),
  };
}

export function getRegisteredAiProviderAdapters() { return [...aiProviderAdapters.keys()]; }
