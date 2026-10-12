import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bolApiReadiness } from '../app/bol_api_readiness.mjs';
import { BolRetailerClient } from '../app/bol_retailer_client.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAL_DATA_ROOT = path.join(PROJECT_ROOT, 'BOL数据');
const ACCEPTANCE_ROOT = path.join(FORMAL_DATA_ROOT, '验收E2E', 'competitor-source-20260926');
const EVIDENCE_FILE = path.join(ACCEPTANCE_ROOT, 'product-placement-adapter-acceptance.json');
const RUNTIME_FILE = path.join(FORMAL_DATA_ROOT, 'integrations', 'bol-api-runtime-health.json');
const CANDIDATE_EAN = '8720929106707';
const NOT_FOUND_TEST_EAN = '9999999999994';
const READINESS_TTL_MS = 30 * 60 * 1000;
const LAUNCHER_USER = process.env.BOL_PLACEMENT_LAUNCHER_USER || 'UNAVAILABLE';
const LAUNCHER_PID = Number(process.env.BOL_PLACEMENT_LAUNCHER_PID) || null;

function captureError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNEXPECTED_ERROR',
    http_status: Number.isInteger(error?.status) ? error.status : null,
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

async function durableWrite(file, content) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.unlink(temp); } catch {}
    throw error;
  }
}

async function writeEvidence(record) {
  await durableWrite(EVIDENCE_FILE, `${JSON.stringify(record, null, 2)}\n`);
}

async function runEvidencePreflight() {
  const tag = `${process.pid}-${crypto.randomUUID()}`;
  const probe = path.join(ACCEPTANCE_ROOT, `.placement-preflight-${tag}.tmp`);
  const renamed = path.join(ACCEPTANCE_ROOT, `.placement-preflight-${tag}.renamed`);
  const replaceTarget = path.join(ACCEPTANCE_ROOT, `.placement-preflight-${tag}.replace-target`);
  const replaceSource = path.join(ACCEPTANCE_ROOT, `.placement-preflight-${tag}.replace-source`);
  const probeText = `placement-preflight:${tag}\n`;
  const replacementText = `placement-preflight-replacement:${tag}\n`;
  const steps = { create: 'NOT_RUN', write: 'NOT_RUN', fsync_close: 'NOT_RUN', readback: 'NOT_RUN', rename: 'NOT_RUN', atomic_replace: 'NOT_RUN', delete: 'NOT_RUN' };
  const errors = {};
  let handle = null;
  let probeExists = false;
  let renamedExists = false;
  let replaceTargetExists = false;
  let replaceSourceExists = false;
  const fail = (name, error) => { steps[name] = 'FAIL'; errors[name] = error?.stack || error?.message || String(error); };

  try {
    try { handle = await fs.open(probe, 'wx'); probeExists = true; steps.create = 'PASS'; }
    catch (error) { fail('create', error); }
    if (handle) {
      try { await handle.writeFile(probeText, 'utf8'); steps.write = 'PASS'; }
      catch (error) { fail('write', error); }
      try { await handle.sync(); await handle.close(); handle = null; steps.fsync_close = 'PASS'; }
      catch (error) { fail('fsync_close', error); try { await handle?.close(); } catch {} handle = null; }
      try { if (await fs.readFile(probe, 'utf8') !== probeText) throw new Error('Evidence preflight readback mismatch.'); steps.readback = 'PASS'; }
      catch (error) { fail('readback', error); }
      try { await fs.rename(probe, renamed); probeExists = false; renamedExists = true; steps.rename = 'PASS'; }
      catch (error) { fail('rename', error); }

      try {
        const target = await fs.open(replaceTarget, 'wx');
        replaceTargetExists = true;
        await target.writeFile(`prior:${tag}\n`, 'utf8');
        await target.sync();
        await target.close();
        const source = await fs.open(replaceSource, 'wx');
        replaceSourceExists = true;
        await source.writeFile(replacementText, 'utf8');
        await source.sync();
        await source.close();
        await fs.rename(replaceSource, replaceTarget);
        replaceSourceExists = false;
        if (await fs.readFile(replaceTarget, 'utf8') !== replacementText) throw new Error('Atomic replace readback mismatch.');
        steps.atomic_replace = 'PASS';
      } catch (error) { fail('atomic_replace', error); }

      try {
        const deleteTargets = [];
        if (renamedExists) deleteTargets.push(renamed);
        if (replaceTargetExists) deleteTargets.push(replaceTarget);
        if (replaceSourceExists) deleteTargets.push(replaceSource);
        if (probeExists) deleteTargets.push(probe);
        if (!deleteTargets.length) throw new Error('No created evidence preflight file remained to delete.');
        for (const file of deleteTargets) await fs.unlink(file);
        renamedExists = false; replaceTargetExists = false; replaceSourceExists = false; probeExists = false;
        steps.delete = 'PASS';
      } catch (error) { fail('delete', error); }
    }
  } finally {
    try { await handle?.close(); } catch {}
    for (const [file, exists] of [[probe, probeExists], [renamed, renamedExists], [replaceTarget, replaceTargetExists], [replaceSource, replaceSourceExists]]) {
      if (exists) { try { await fs.unlink(file); } catch (error) { errors.cleanup ||= error?.stack || error?.message || String(error); } }
    }
  }

  return {
    process_user: LAUNCHER_USER,
    process_pid: process.pid,
    launcher_pid: LAUNCHER_PID,
    evidence_file_path: EVIDENCE_FILE,
    probe_path: probe,
    steps,
    errors,
    status: Object.values(steps).every(value => value === 'PASS') ? 'PASS' : 'FAIL',
  };
}

function isValidGtin13(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function isOfficialBolProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'bol.com' || url.hostname.endsWith('.bol.com'))
      && /\/p\//.test(url.pathname);
  } catch { return false; }
}

function safeProviderEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    method: value.method || null,
    endpoint: value.endpoint || null,
    country_code: value.country_code || null,
    accept_language: value.accept_language || null,
    response_status: value.response_status ?? null,
  };
}

const evidence = {
  acceptance: 'BOL_RETAILER_V10_PRODUCT_PLACEMENT_ADAPTER',
  status: 'PREFLIGHT_PENDING',
  recorded_at: new Date().toISOString(),
  adapter_status: 'FROZEN',
  process_context: {
    process_user: LAUNCHER_USER,
    process_pid: process.pid,
    launcher_pid: LAUNCHER_PID,
    explorer_launch_marker: process.env.BOL_PLACEMENT_EXPLORER_LAUNCH === '1',
  },
  candidate_ean: CANDIDATE_EAN,
  PRODUCT_PLACEMENT_200_REAL_E2E: 'NOT_RUN',
  PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E: 'NOT_OBSERVED',
  candidate_result: null,
  not_found_test: { ean: NOT_FOUND_TEST_EAN, gtin13_check_digit_valid: isValidGtin13(NOT_FOUND_TEST_EAN), result: null },
  secrets_or_authorization_headers_recorded: false,
};

if (process.env.BOL_PLACEMENT_EXPLORER_LAUNCH !== '1' || /CodexSandbox/i.test(LAUNCHER_USER)) {
  console.error(JSON.stringify({ status: 'STOPPED', reason_code: 'DESKTOP_EXPLORER_LAUNCH_REQUIRED', process_user: LAUNCHER_USER, process_pid: process.pid, evidence_file_path: EVIDENCE_FILE }, null, 2));
  process.exit(2);
}

const preflight = await runEvidencePreflight();
evidence.recorded_at = new Date().toISOString();
evidence.evidence_preflight = preflight;
if (preflight.status !== 'PASS') {
  evidence.status = 'BLOCKED_EVIDENCE_PREFLIGHT';
  console.error(JSON.stringify(evidence, null, 2));
  process.exit(3);
}

try { await writeEvidence(evidence); }
catch (error) {
  console.error(JSON.stringify({ status: 'BLOCKED_EVIDENCE_PREFLIGHT', reason_code: 'EVIDENCE_DESTINATION_WRITE_FAILED', evidence_file_path: EVIDENCE_FILE, error: captureError(error) }, null, 2));
  process.exit(4);
}

let readiness;
try {
  const [gate, runtimeText] = await Promise.all([
    bolApiReadiness(FORMAL_DATA_ROOT, { envFile: path.join(PROJECT_ROOT, '.env') }),
    fs.readFile(RUNTIME_FILE, 'utf8'),
  ]);
  const runtime = JSON.parse(runtimeText.replace(/^\uFEFF/, ''));
  const runtimeAt = Date.parse(runtime?.last_success_at || '');
  const runtimeFresh = Number.isFinite(runtimeAt) && runtimeAt <= Date.now() && Date.now() - runtimeAt <= READINESS_TTL_MS;
  const runtimeReady = runtime?.BOL_API_RUNTIME_HEALTH === 'HEALTHY'
    && runtime?.dependency_readiness === 'READY'
    && runtime?.last_error_code == null
    && runtime?.oauth_runtime_health === 'HEALTHY'
    && runtimeFresh;
  readiness = {
    ready: gate.status === 'PASS' && runtimeReady,
    status: gate.status,
    checked_at: gate.checked_at || null,
    runtime_last_success_at: runtime?.last_success_at || null,
    runtime_health: runtime?.BOL_API_RUNTIME_HEALTH || null,
    dependency_readiness: runtime?.dependency_readiness || null,
    reason_code: gate.status === 'PASS' && runtimeReady ? null : 'WAITING_DEPENDENCY:BOL_API',
  };
} catch (error) {
  readiness = { ready: false, reason_code: 'WAITING_DEPENDENCY:BOL_API', safe_error: captureError(error).code };
}
evidence.readiness_consumed = readiness;
if (!readiness.ready) {
  evidence.status = 'BLOCKED / WAITING_DEPENDENCY:BOL_API';
  evidence.PRODUCT_PLACEMENT_200_REAL_E2E = 'BLOCKED / NOT_RUN';
  await writeEvidence(evidence);
  console.log(JSON.stringify({ status: evidence.status, evidence_file_path: EVIDENCE_FILE, readiness }, null, 2));
  process.exit(5);
}

const memoryCache = {
  async get() { return null; },
  async set(provider, key, { rawResponse, structuredResult, source, ttlMs }) {
    const createdAt = new Date().toISOString();
    return { provider, key, rawResponse, structuredResult, source, createdAt, expiresAt: new Date(Date.now() + ttlMs).toISOString(), cacheHit: false };
  },
  close() {},
};
const client = new BolRetailerClient({ dataRoot: ACCEPTANCE_ROOT, envFile: path.join(PROJECT_ROOT, '.env'), cache: memoryCache });

async function invokePlacement(ean) {
  const requestedAt = new Date().toISOString();
  try {
    const result = await client.getProductPlacement(ean, { countryCode: 'NL', language: 'nl', cacheMode: 'FORCE_REFRESH' });
    const value = result.structuredResult;
    return {
      outcome: 'HTTP_RESPONSE',
      ean: value.ean,
      url: value.url,
      categories: value.categories,
      http_status: value.http_status,
      queried_at: value.queried_at,
      provider_evidence: safeProviderEvidence(value.provider_evidence),
      requested_at: requestedAt,
    };
  } catch (error) {
    const safe = captureError(error);
    return { outcome: 'ERROR', ean, requested_at: requestedAt, http_status: safe.http_status, error_code: safe.code };
  }
}

evidence.status = 'RUNNING_PLACEMENT_ACCEPTANCE';
evidence.PRODUCT_PLACEMENT_200_REAL_E2E = 'NOT_RUN';
await writeEvidence(evidence);

const candidate = await invokePlacement(CANDIDATE_EAN);
evidence.candidate_result = candidate;
evidence.recorded_at = new Date().toISOString();
evidence.status = 'CANDIDATE_RESPONSE_PERSISTED';
await writeEvidence(evidence);

const candidatePass = candidate.outcome === 'HTTP_RESPONSE'
  && candidate.http_status === 200
  && candidate.ean === CANDIDATE_EAN
  && isOfficialBolProductUrl(candidate.url);
evidence.candidate_result.official_bol_product_url = candidate.outcome === 'HTTP_RESPONSE' && isOfficialBolProductUrl(candidate.url);
evidence.PRODUCT_PLACEMENT_200_REAL_E2E = candidatePass ? 'PASS' : 'FAIL';
evidence.status = 'CANDIDATE_ASSERTION_RECORDED';
evidence.recorded_at = new Date().toISOString();
await writeEvidence(evidence);

if (candidate.outcome === 'ERROR' && candidate.http_status === null) {
  evidence.not_found_test.result = { outcome: 'NOT_RUN', reason_code: candidate.error_code };
  evidence.PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E = 'NOT_OBSERVED';
  evidence.status = 'INCOMPLETE / PLACEMENT_DEPENDENCY_ERROR';
  evidence.recorded_at = new Date().toISOString();
  await writeEvidence(evidence);
  console.log(JSON.stringify({ status: evidence.status, PRODUCT_PLACEMENT_200_REAL_E2E: evidence.PRODUCT_PLACEMENT_200_REAL_E2E, PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E: evidence.PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E, candidate_result: candidate, evidence_file_path: EVIDENCE_FILE }, null, 2));
  process.exit(6);
}

const negative = await invokePlacement(NOT_FOUND_TEST_EAN);
evidence.not_found_test.result = negative;
evidence.recorded_at = new Date().toISOString();
evidence.status = 'NOT_FOUND_RESPONSE_PERSISTED';
await writeEvidence(evidence);

if (negative.http_status === 404) {
  evidence.PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E = negative.outcome === 'ERROR' && negative.error_code === 'PRODUCT_PLACEMENT_NOT_FOUND' ? 'PASS' : 'FAIL';
} else {
  evidence.PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E = 'NOT_OBSERVED';
}
evidence.status = 'COMPLETE';
evidence.recorded_at = new Date().toISOString();
await writeEvidence(evidence);
console.log(JSON.stringify({ status: evidence.status, PRODUCT_PLACEMENT_200_REAL_E2E: evidence.PRODUCT_PLACEMENT_200_REAL_E2E, candidate_result: candidate, PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E: evidence.PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E, not_found_result: negative, evidence_file_path: EVIDENCE_FILE }, null, 2));
process.exitCode = candidatePass && evidence.PRODUCT_PLACEMENT_404_MAPPING_REAL_E2E === 'PASS' ? 0 : 1;
