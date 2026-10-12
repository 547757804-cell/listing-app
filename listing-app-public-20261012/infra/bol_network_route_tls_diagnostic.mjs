import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(projectRoot, 'infra', 'bol-network-proxy.json');
const acceptanceDataRoot = path.join(projectRoot, 'BOL数据', '验收E2E');
const expectedDataRoot = readOption('--data-root');
const targetHosts = ['login.bol.com'];
const now = () => new Date().toISOString();

function readOption(name) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function readClashController() {
  const configFile = path.join(os.homedir(), '.config', 'clash', 'config.yaml');
  let raw;
  try { raw = fs.readFileSync(configFile, 'utf8'); }
  catch { return { available: false, reason: 'CONTROLLER_CONFIG_UNREADABLE' }; }
  const controller = raw.match(/^external-controller:\s*["']?([^\r\n"']+)/mi)?.[1]?.trim();
  const secret = raw.match(/^secret:\s*["']?([^\r\n"']*)/mi)?.[1]?.trim() ?? '';
  if (!controller || !/^127\.0\.0\.1:\d+$/.test(controller)) {
    return { available: false, reason: 'CONTROLLER_NOT_LOOPBACK' };
  }
  return { available: true, baseUrl: `http://${controller}`, secret };
}

function getControllerJson(controller, endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, controller.baseUrl);
    const headers = controller.secret ? { Authorization: `Bearer ${controller.secret}` } : {};
    const req = http.get(url, { headers, agent: new http.Agent({ keepAlive: false }) }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error('CONTROLLER_HTTP_ERROR'), { code: `HTTP_${res.statusCode}` }));
        try { resolve(JSON.parse(body)); }
        catch { reject(Object.assign(new Error('CONTROLLER_INVALID_JSON'), { code: 'CONTROLLER_INVALID_JSON' })); }
      });
    });
    req.setTimeout(2500, () => req.destroy(Object.assign(new Error('CONTROLLER_TIMEOUT'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

function matchRule(host, rules = []) {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  for (const rule of rules) {
    const type = String(rule.type ?? '').toLowerCase();
    const payload = String(rule.payload ?? '').toLowerCase();
    let matched = false;
    if (type === 'domain') matched = normalized === payload;
    else if (type === 'domainsuffix') matched = normalized === payload || normalized.endsWith(`.${payload}`);
    else if (type === 'domainkeyword') matched = normalized.includes(payload);
    else if (type === 'domainregex') {
      try { matched = new RegExp(payload, 'i').test(normalized); } catch { /* malformed regex is ignored */ }
    } else if (type === 'match') matched = true;
    if (matched) return { type: rule.type ?? null, payload: rule.payload ?? null, proxy: rule.proxy ?? null };
  }
  return null;
}

function resolveNode(proxyName, proxies, seen = new Set()) {
  if (!proxyName || seen.has(proxyName)) return { group: proxyName ?? null, node: null };
  seen.add(proxyName);
  const entry = proxies?.[proxyName];
  if (!entry) return { group: proxyName, node: null };
  const isGroup = /selector|urltest|fallback|loadbalance|relay/i.test(String(entry.type ?? ''));
  if (!isGroup) return { group: null, node: proxyName };
  const selected = entry.now ?? null;
  const nested = resolveNode(selected, proxies, seen);
  return { group: proxyName, node: nested.node ?? (selected && !proxies?.[selected] ? selected : null) };
}

function summarizeRoute(host, rules, proxies, connections) {
  const live = (connections ?? []).find(c => String(c.host ?? c.metadata?.host ?? '').toLowerCase() === host);
  const rule = live
    ? { type: live.rule ?? null, payload: live.rule_payload ?? live.rulePayload ?? null, proxy: live.chains?.at(-1) ?? null }
    : matchRule(host, rules);
  const groupHint = rule?.proxy ?? null;
  const resolved = resolveNode(groupHint, proxies);
  const chains = Array.isArray(live?.chains) ? live.chains : [];
  const liveLeaf = chains.length ? chains[0] : null;
  const liveGroup = chains.length > 1 ? chains.at(-1) : resolved.group;
  const activeNode = liveLeaf && liveLeaf !== liveGroup ? liveLeaf : resolved.node;
  return {
    host,
    matched_rule: rule ? `${rule.type}${rule.payload ? ` ${rule.payload}` : ''}` : null,
    proxy_group: liveGroup ?? groupHint,
    active_node: activeNode ?? null,
    route_source: live ? 'CLASH_ACTIVE_CONNECTION' : (rule ? 'CLASH_RULES_AND_SELECTED_PROXY' : 'UNKNOWN'),
    connection_chains: chains,
  };
}

function connectTunnel(host, proxyHost, proxyPort, onTlsReady) {
  return new Promise((resolve) => {
    const result = {
      host,
      proxy_tcp: { status: 'FAIL', duration_ms: null, error_code: null },
      connect: { status: 'NOT_RUN', http_status: null, duration_ms: null, error_code: null },
      tls: { status: 'NOT_RUN', duration_ms: null, version: null, peer_certificate: null, error_code: null, failure_stage: null },
    };
    const started = performance.now();
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let timer = setTimeout(() => socket.destroy(Object.assign(new Error('PROXY_TCP_TIMEOUT'), { code: 'ETIMEDOUT' })), 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      result.proxy_tcp = { status: 'PASS', duration_ms: Math.round(performance.now() - started), error_code: null };
      const connectStart = performance.now();
      result.connect.duration_ms = null;
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
      let header = Buffer.alloc(0);
      const onData = (chunk) => {
        header = Buffer.concat([header, chunk]);
        const boundary = header.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        socket.off('data', onData);
        clearTimeout(timer);
        const text = header.subarray(0, boundary).toString('latin1');
        const status = Number(text.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0) || null;
        result.connect = { status: status === 200 ? 'PASS' : 'FAIL', http_status: status, duration_ms: Math.round(performance.now() - connectStart), error_code: status === 200 ? null : 'PROXY_CONNECT_REJECTED' };
        if (status !== 200) { socket.destroy(); return resolve(result); }
        const remainder = header.subarray(boundary + 4);
        if (remainder.length) socket.unshift(remainder);
        const tlsStart = performance.now();
        const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
        timer = setTimeout(() => secure.destroy(Object.assign(new Error('TLS_TIMEOUT'), { code: 'ETIMEDOUT' })), 10000);
        secure.once('secureConnect', async () => {
          clearTimeout(timer);
          const cert = secure.getPeerCertificate();
          const subject = cert?.subject ?? {};
          const issuer = cert?.issuer ?? {};
          result.tls = {
            status: 'PASS',
            duration_ms: Math.round(performance.now() - tlsStart),
            version: secure.getProtocol(),
            peer_certificate: {
              subject_cn: subject.CN ?? null,
              issuer_cn: issuer.CN ?? null,
              fingerprint256: cert?.fingerprint256 ?? null,
              valid_from: cert?.valid_from ?? null,
              valid_to: cert?.valid_to ?? null,
            },
            error_code: null,
            failure_stage: null,
          };
          try {
            if (onTlsReady) result.live_connection = await onTlsReady();
          } catch { result.live_connections = []; }
          secure.destroy();
          resolve(result);
        });
        secure.once('error', error => {
          clearTimeout(timer);
          result.tls = {
            status: 'FAIL', duration_ms: Math.round(performance.now() - tlsStart), version: null,
            peer_certificate: null, error_code: error.code ?? error.name ?? 'TLS_ERROR',
            failure_stage: error.code === 'CERT_HAS_EXPIRED' || String(error.code).startsWith('ERR_TLS_CERT') ? 'CERTIFICATE_VALIDATION' : 'TLS_HANDSHAKE',
          };
          resolve(result);
        });
      };
      socket.on('data', onData);
      timer = setTimeout(() => socket.destroy(Object.assign(new Error('PROXY_CONNECT_TIMEOUT'), { code: 'ETIMEDOUT' })), 10000);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      result.proxy_tcp = { status: 'FAIL', duration_ms: Math.round(performance.now() - started), error_code: error.code ?? error.name ?? 'PROXY_TCP_ERROR' };
      if (result.connect.status === 'NOT_RUN') result.connect = { status: 'NOT_RUN', http_status: null, duration_ms: null, error_code: result.proxy_tcp.error_code };
      if (result.tls.status === 'NOT_RUN') result.tls = { status: 'NOT_RUN', duration_ms: null, version: null, peer_certificate: null, error_code: result.proxy_tcp.error_code, failure_stage: 'PROXY_TCP' };
      resolve(result);
    });
  });
}

function localJsonRequest(method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 4181, path: requestPath, method, agent: new http.Agent({ keepAlive: false }) }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* return status without exposing body */ }
        resolve({ http_status: response.statusCode, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(Object.assign(new Error('LOCAL_RUNTIME_TIMEOUT'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  if (!expectedDataRoot) fail('DATA_ROOT_ARGUMENT_REQUIRED');
  const dataRoot = path.resolve(expectedDataRoot);
  const relativeDataRoot = path.relative(path.resolve(acceptanceDataRoot), dataRoot);
  if (!relativeDataRoot || relativeDataRoot === '..' || relativeDataRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDataRoot)) {
    fail('DATA_ROOT_OUTSIDE_ACCEPTANCE_ROOT');
  }

  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { fail('BOL_PROXY_CONFIG_INVALID'); }
  if (config.enabled !== true) fail('BOL_PROJECT_PROXY_DISABLED');
  const proxy = new URL(config.httpsProxy);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port) fail('EXPECTED_LOCAL_HTTP_PROXY_REQUIRED');

  const preflight = await localJsonRequest('GET', '/api/health');
  const health = preflight.json;
  if (preflight.http_status !== 200 || !health || health.instance !== 'ACCEPTANCE_4181' || health.acceptance_mode !== true ||
      health.acceptance_hold !== true || health.runtime_policy_status !== 'VALID' ||
      health.business_dispatch_enabled !== false || health.dependency_resume_enabled !== false ||
      health.background_provider_probe_enabled !== false || health.task_auto_mutation_enabled !== false ||
      path.resolve(health.data_root ?? '') !== dataRoot) {
    fail('ACCEPTANCE_HOLD_GUARD_FAILED');
  }

  const controller = readClashController();
  let rules = [];
  let proxies = {};
  let controllerStatus = controller.available ? 'UNKNOWN' : controller.reason;
  if (controller.available) {
    try {
      const [ruleResponse, proxyResponse] = await Promise.all([
        getControllerJson(controller, '/rules'),
        getControllerJson(controller, '/proxies'),
      ]);
      rules = ruleResponse.rules ?? [];
      proxies = proxyResponse.proxies ?? {};
      controllerStatus = 'READ_ONLY_OK';
    } catch (error) {
      controllerStatus = error.code ?? 'CONTROLLER_QUERY_FAILED';
    }
  }

  const probes = [];
  for (const host of targetHosts) {
    const onTlsReady = controller.available && controllerStatus === 'READ_ONLY_OK'
      ? async () => {
          const snapshot = (await getControllerJson(controller, '/connections')).connections ?? [];
          const connection = snapshot.find(item => String(item.metadata?.host ?? '').toLowerCase() === host);
          return connection ? {
            host,
            chains: Array.isArray(connection.chains) ? connection.chains : [],
            rule: connection.rule ?? null,
            rule_payload: connection.rulePayload ?? null,
          } : null;
        }
      : null;
    probes.push(await connectTunnel(host, proxy.hostname, Number(proxy.port), onTlsReady));
  }
  const connections = probes.map(probe => probe.live_connection).filter(Boolean);
  const routes = targetHosts.map(host => summarizeRoute(host, rules, proxies, connections));
  const readiness = { probe_executed: false, reason: 'TRANSPORT_DIAGNOSTIC_ONLY' };
  const result = {
    schema: 'BOL_NETWORK_ROUTE_TLS_DIAGNOSTIC_V1',
    probe_time: now(),
    instance: 'ACCEPTANCE_4181',
    runtime_mode: health.runtime_mode,
    acceptance_hold: health.acceptance_hold,
    data_root: dataRoot,
    project_proxy: { route: 'PROXY', host: proxy.hostname, port: Number(proxy.port) },
    clash_controller: { status: controllerStatus, endpoint: controller.available ? new URL(controller.baseUrl).host : null },
    routes,
    transport: probes,
    readiness,
  };

  const logDir = path.join(expectedDataRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'bol-network-route-tls-diagnostics.jsonl');
  fs.appendFileSync(logPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...result, audit_path: logPath }, null, 2) + '\n');
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ status: 'FAIL', error_code: error.code ?? 'DIAGNOSTIC_ERROR' }) + '\n');
  process.exitCode = 1;
});
