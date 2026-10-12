import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = path.join(PROJECT_ROOT, `BOL\u6570\u636e`);
const AUDIT_ROOT = path.join(DATA_ROOT, 'logs');
const TARGET = new URL('https://login.bol.com');
const VARIABLE_NAMES = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
];

function envEntry(requestedName) {
  const keys = Object.keys(process.env);
  const exact = keys.find(key => key === requestedName);
  const matched = exact || (process.platform === 'win32'
    ? keys.find(key => key.toLowerCase() === requestedName.toLowerCase())
    : undefined);
  return {
    requested_name: requestedName,
    present: Boolean(matched),
    actual_key_as_exposed_by_node: matched || null,
    value: matched ? process.env[matched] : undefined,
  };
}

function safeProxyUrl(raw) {
  if (!raw || !raw.trim()) return { proxy: null, valid_url: false };
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim())
      ? raw.trim()
      : `http://${raw.trim()}`;
    const url = new URL(candidate);
    const protocol = url.protocol.slice(0, -1).toLowerCase();
    const defaultPort = protocol === 'https' ? '443' : protocol === 'http' ? '80' : null;
    return {
      present: true,
      proxy: {
        protocol,
        host: url.hostname,
        port: url.port || defaultPort,
      },
      valid_url: Boolean(url.hostname),
    };
  } catch {
    return { present: true, proxy: null, valid_url: false };
  }
}

function noProxyMatches(raw, hostname, port) {
  if (!raw) return false;
  const targetHost = hostname.toLowerCase();
  for (const part of raw.split(',')) {
    const item = part.trim().toLowerCase();
    if (!item) continue;
    if (item === '*') return true;
    let hostPattern = item;
    let portPattern = null;
    const colon = item.lastIndexOf(':');
    if (colon > -1 && item.indexOf(':') === colon) {
      hostPattern = item.slice(0, colon);
      portPattern = item.slice(colon + 1);
    }
    if (portPattern && portPattern !== String(port)) continue;
    hostPattern = hostPattern.replace(/^\*\./, '.');
    if (!hostPattern) continue;
    const normalizedPattern = hostPattern.startsWith('.') ? hostPattern.slice(1) : hostPattern;
    if (targetHost === normalizedPattern || targetHost.endsWith(`.${normalizedPattern}`)) return true;
  }
  return false;
}

function computeHttpsRoute(entries) {
  const byName = new Map(entries.map(entry => [entry.requested_name, entry]));
  // Node's https.Agent proxyEnv behavior selects HTTPS_PROXY/https_proxy for HTTPS.
  // ALL_PROXY is recorded for diagnosis, but is not the selected HTTPS setting here.
  const lowerProxy = byName.get('https_proxy');
  const upperProxy = byName.get('HTTPS_PROXY');
  const selected = lowerProxy?.present ? lowerProxy : upperProxy;
  const lowerNoProxy = byName.get('no_proxy');
  const upperNoProxy = byName.get('NO_PROXY');
  const noProxy = lowerNoProxy?.present ? lowerNoProxy : upperNoProxy;
  const targetPort = TARGET.port || '443';
  const bypassed = noProxyMatches(noProxy?.value, TARGET.hostname, targetPort);
  const parsed = selected?.present ? safeProxyUrl(selected.value) : null;

  if (bypassed) {
    return { route: 'DIRECT', reason: 'NO_PROXY_MATCH', selected_proxy_variable: null, proxy: null };
  }
  if (!selected?.present || !selected.value) {
    return { route: 'DIRECT', reason: 'HTTPS_PROXY_NOT_PRESENT', selected_proxy_variable: null, proxy: null };
  }
  if (!parsed?.valid_url || !parsed.proxy) {
    return { route: 'UNRESOLVED', reason: 'HTTPS_PROXY_URL_INVALID', selected_proxy_variable: selected.requested_name, proxy: null };
  }
  return { route: 'PROXY', reason: 'HTTPS_PROXY_SELECTED', selected_proxy_variable: selected.requested_name, proxy: parsed.proxy };
}

function processContext() {
  const raw = process.env.BOL_DESKTOP_PROXY_DIAGNOSTIC_CONTEXT;
  let launcher = null;
  if (raw) {
    try { launcher = JSON.parse(raw); } catch { launcher = { context_parse_error: true }; }
  }
  return {
    windows_username: os.userInfo().username,
    pid: process.pid,
    parent_pid: process.ppid,
    parent_process_context_from_launcher: launcher,
    node_executable: process.execPath,
    node_version: process.version,
    current_working_directory: process.cwd(),
  };
}

const rawEntries = VARIABLE_NAMES.map(envEntry);
const envReport = rawEntries.map(({ requested_name, present, actual_key_as_exposed_by_node, value }) => {
  const isNoProxy = requested_name.toLowerCase() === 'no_proxy';
  const safe = isNoProxy ? { nonempty: Boolean(value?.trim()) } : safeProxyUrl(value);
  return {
    requested_name,
    present,
    actual_key_as_exposed_by_node,
    ...(isNoProxy ? { nonempty: Boolean(value?.trim()) } : safe),
  };
});

const route = computeHttpsRoute(rawEntries);
const httpsProxyAbsent = !rawEntries.some(entry =>
  ['HTTPS_PROXY', 'https_proxy'].includes(entry.requested_name) && entry.present);
const missingProxyRootCause = httpsProxyAbsent && route.route === 'DIRECT'
  ? 'DESKTOP_PROXY_ENV_MISSING'
  : null;
const localProxyConfigured = route.route === 'PROXY'
  && route.proxy?.host?.replace(/^\[|\]$/g, '').toLowerCase() === '127.0.0.1'
  && String(route.proxy?.port) === '7890';
let agentConstructed = false;
try {
  const agent = new https.Agent({ proxyEnv: process.env });
  agentConstructed = true;
  agent.destroy();
} catch {
  // No raw exception text is captured because it may include environment data.
}

const audit = {
  schema: 'bol.desktop-proxy-env-diagnostic.v1',
  checked_at_utc: new Date().toISOString(),
  status: agentConstructed && route.route === 'PROXY' && localProxyConfigured ? 'PASS' : 'FAIL',
  process: processContext(),
  proxy_environment: envReport,
  route_evaluation: {
    target_origin: TARGET.origin,
    agent_configuration: 'https.Agent({ proxyEnv: process.env })',
    agent_constructed: agentConstructed,
    final_route: route.route,
    reason: route.reason,
    selected_proxy_variable: route.selected_proxy_variable,
    proxy: route.proxy,
    configured_proxy_matches_127_0_0_1_7890: localProxyConfigured,
  },
  root_cause_classification: missingProxyRootCause,
  network_requests_made: false,
  database_opened: false,
  health_or_readiness_modified: false,
};

try {
  await fs.mkdir(AUDIT_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const auditPath = path.join(AUDIT_ROOT, `desktop-proxy-env-diagnostic-${stamp}.json`);
  await fs.writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`Desktop proxy environment diagnostic: ${audit.status}`);
  console.log(`Final route to login.bol.com: ${route.route}`);
  if (route.route === 'PROXY') console.log(`Target proxy: ${route.proxy.host}:${route.proxy.port}`);
  console.log(`Expected proxy configured: ${localProxyConfigured ? 'PASS' : 'FAIL'}`);
  console.log(`Sanitized audit: ${auditPath}`);
  process.exitCode = audit.status === 'PASS' && route.route === 'PROXY' && localProxyConfigured ? 0 : 1;
} catch {
  console.error('Desktop proxy environment diagnostic failed to write its sanitized audit.');
  process.exitCode = 2;
}
