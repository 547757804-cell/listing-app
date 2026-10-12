import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BolRetailerClient, readBolCredentials } from './bol_retailer_client.mjs';
import { markBolApiReady } from './provider_readiness.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const ENDPOINT = '/retailer/insights/search-terms';
const READINESS_TTL_MS = 30 * 60 * 1000;

async function readEnvValue(key, env = process.env, envFile = ENV_FILE) {
  if (typeof env[key] === 'string' && env[key].trim()) return env[key].trim();
  try {
    for (const line of (await fs.readFile(envFile, 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] !== key) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      return value.trim();
    }
  } catch { /* Missing configuration fails closed. */ }
  return '';
}

export async function bolApiEnabled({ env = process.env, envFile = ENV_FILE } = {}) {
  return (await readEnvValue('BOL_API_ENABLED', env, envFile)) === '1';
}

async function credentialFingerprint({ env = process.env, envFile = ENV_FILE } = {}) {
  const { clientId, clientSecret } = await readBolCredentials({ env, envFile });
  return crypto.createHash('sha256').update(`${clientId}\0${clientSecret}`).digest('hex');
}

function readinessFile(dataRoot) {
  return path.join(dataRoot, 'integrations', 'bol-api-readiness.json');
}

function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/("?(?:authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|cookie|set-cookie)"?\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/gi, '$1[REDACTED]$3')
    .replace(/(\b(?:authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|cookie|set-cookie)\b\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi, '$1[REDACTED]')
    .slice(0, 4096);
}

function safeDiagnosticObject(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeDiagnosticObject(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|\btoken\b|\bsecret\b|password|api[_-]?key|cookie/i.test(key)) result[key] = '[REDACTED]';
      else result[key] = safeDiagnosticObject(item, depth + 1);
    }
    return result;
  }
  return typeof value === 'string' ? redactDiagnosticText(value) : value;
}

function safeFailureDiagnostics(error) {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = error?.[key];
      if (value !== undefined && value !== null) return value;
    }
    return null;
  };
  const headers = pick('safe_headers', 'response_headers');
  const body = pick('safe_body', 'response_body');
  const safeBody = typeof body === 'string' ? redactDiagnosticText(body) : body && typeof body === 'object' ? safeDiagnosticObject(body) : null;
  return {
    request_id: pick('request_id', 'adapter_request_id', 'requestId'),
    endpoint: pick('endpoint'),
    method: pick('method'),
    started_at: pick('started_at', 'startedAt'),
    finished_at: pick('finished_at', 'finishedAt'),
    response_received: pick('response_received', 'responseReceived'),
    http_status: pick('http_status', 'httpStatus', 'status'),
    transport_code: pick('transport_code', 'transportCode'),
    transport_class: pick('transport_class', 'transportClass'),
    transport_message: typeof pick('transport_message', 'transportMessage') === 'string'
      ? redactDiagnosticText(pick('transport_message', 'transportMessage')).slice(0, 512)
      : null,
    response_headers: headers && typeof headers === 'object' ? safeDiagnosticObject(headers) : null,
    response_body: safeBody,
  };
}

async function readManifest(dataRoot) {
  try { return JSON.parse(await fs.readFile(readinessFile(dataRoot), 'utf8')); }
  catch { return null; }
}

export async function bolApiReadiness(dataRoot, options = {}) {
  const enabled = await bolApiEnabled(options);
  const manifest = await readManifest(dataRoot);
  if (!enabled) return { enabled: false, status: 'DISABLED', oauth_status: 'NOT_CHECKED', endpoint_status: 'NOT_CHECKED', checked_at: manifest?.checked_at || null };
  if (!manifest || manifest.status !== 'PASS' || manifest.oauth_status !== 'PASS' || manifest.endpoint_status !== 'PASS' || manifest.endpoint !== ENDPOINT) {
    return { enabled: true, status: 'WAITING_FOR_READINESS_CHECK', oauth_status: manifest?.oauth_status || 'NOT_CHECKED', endpoint_status: manifest?.endpoint_status || 'NOT_CHECKED', checked_at: manifest?.checked_at || null };
  }
  const checkedAt = Date.parse(manifest.checked_at || '');
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > READINESS_TTL_MS) {
    return { enabled: true, status: 'STALE_READINESS_CHECK', oauth_status: manifest.oauth_status, endpoint_status: manifest.endpoint_status, checked_at: manifest.checked_at };
  }
  try {
    if (await credentialFingerprint(options) !== manifest.credential_fingerprint) return { enabled: true, status: 'CREDENTIALS_CHANGED', oauth_status: 'NOT_CHECKED', endpoint_status: 'NOT_CHECKED', checked_at: manifest.checked_at };
  } catch { return { enabled: true, status: 'CREDENTIALS_NOT_READY', oauth_status: 'NOT_CHECKED', endpoint_status: 'NOT_CHECKED', checked_at: manifest.checked_at }; }
  return { enabled: true, status: 'PASS', oauth_status: 'PASS', endpoint_status: 'PASS', endpoint: ENDPOINT, checked_at: manifest.checked_at };
}

export async function checkBolApiReadiness(dataRoot, { env = process.env, envFile = ENV_FILE, client } = {}) {
  const enabled = await bolApiEnabled({ env, envFile });
  const now = new Date().toISOString();
  const manifest = {
    status: 'WAITING_FOR_READINESS_CHECK', enabled,
    oauth_status: 'NOT_CHECKED', endpoint_status: 'NOT_CHECKED', endpoint: ENDPOINT,
    checked_at: now, oauth_error_code: null, endpoint_error_code: null,
    credential_fingerprint: null,
  };
  if (!enabled) {
    manifest.status = 'DISABLED';
  } else {
    try {
      manifest.credential_fingerprint = await credentialFingerprint({ env, envFile });
      const api = client || new BolRetailerClient({ dataRoot, env, envFile });
      const oauth = await api.validateOAuth();
      manifest.oauth_status = 'PASS';
      manifest.oauth_expires_at = new Date(oauth.tokenExpiresAt).toISOString();
      try {
        const endpoint = await api.probeSearchTermsEndpoint();
        manifest.endpoint_status = 'PASS';
        manifest.endpoint_http_status = endpoint.httpStatus;
        manifest.status = 'PASS';
        if (api.usesNativeTransport) markBolApiReady(now);
      } catch (error) {
        manifest.endpoint_status = 'FAIL';
        manifest.endpoint_error_code = error?.code || 'BOL_ENDPOINT_PROBE_FAILED';
        manifest.endpoint_diagnostics = safeFailureDiagnostics(error);
        manifest.status = 'FAIL';
      }
    } catch (error) {
      manifest.oauth_status = 'FAIL';
      manifest.oauth_error_code = error?.code || 'BOL_OAUTH_VALIDATION_FAILED';
      manifest.oauth_diagnostics = safeFailureDiagnostics(error);
      manifest.status = 'FAIL';
    }
  }
  const file = readinessFile(dataRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, file);
  const { credential_fingerprint, ...safe } = manifest;
  return safe;
}
