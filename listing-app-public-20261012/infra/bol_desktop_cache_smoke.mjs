import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ApiCache } from '../app/api_cache.mjs';
import { BolRetailerClient } from '../app/bol_retailer_client.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAL_DATA_ROOT = path.join(PROJECT_ROOT, 'BOL数据');
const INTEGRATIONS_ROOT = path.join(FORMAL_DATA_ROOT, 'integrations');
const DB_FILE = path.join(FORMAL_DATA_ROOT, 'api-cache.sqlite3');
const AUDIT_ROOT = path.join(FORMAL_DATA_ROOT, 'logs');
const STARTED_AT = new Date().toISOString();
const runId = crypto.randomUUID();
const diagnosticProvider = 'desktop_smoke';
const diagnosticKey = `DESKTOP_SMOKE:${runId}`;
const productSearchTerm = `DESKTOP_SMOKE ${runId.replaceAll('-', '').slice(0, 20)}`;
const productCacheKey = JSON.stringify({ countryCode: 'NL', searchTerm: productSearchTerm, categoryId: null, sort: 'RELEVANCE', page: 1 });
const productProvider = 'bol_product_list';
const auditFile = path.join(AUDIT_ROOT, `bol-desktop-cache-smoke-${STARTED_AT.replaceAll(':', '').replaceAll('-', '').replaceAll('.', '')}.jsonl`);

let cache = null;
let client = null;
let sqliteError = null;
let runtimeUpdated = false;
let cleanupCompleted = false;
let productListHttpStatus = null;
const checks = {
  process_context: 'NOT_RUN',
  diagnostic_cache_write: 'NOT_RUN',
  diagnostic_cache_readback: 'NOT_RUN',
  diagnostic_cleanup: 'NOT_RUN',
  oauth: 'NOT_RUN',
  product_list_remote: 'NOT_RUN',
  product_list_cache_write: 'NOT_RUN',
  product_list_cache_readback: 'NOT_RUN',
  no_test_pollution: 'NOT_RUN',
  runtime_health_update: 'NOT_RUN',
};

await fs.mkdir(AUDIT_ROOT, { recursive: true });

async function log(event, fields = {}) {
  const row = { at_utc: new Date().toISOString(), run_id: runId, event, ...fields };
  await fs.appendFile(auditFile, `${JSON.stringify(row)}\n`, 'utf8');
  console.log(`${event}: ${fields.status || fields.result || 'recorded'}`);
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,80}$/i.test(error.code) ? error.code : 'UNEXPECTED_ERROR';
  const status = Number.isInteger(error?.status) ? error.status : null;
  const extended = Number.isInteger(error?.errcode) ? error.errcode : (Number.isInteger(error?.extendedCode) ? error.extendedCode : null);
  const mayLogMessage = error?.code === 'ERR_SQLITE_ERROR' || error?.code === 'SQLITE_READONLY' || error?.name === 'AdapterError';
  const message = mayLogMessage && typeof error?.message === 'string' && error.message.length < 240
    ? error.message.replace(/(?:access_token|client_secret|authorization)\s*[:=]\s*\S+/ig, '[REDACTED]').replace(/Bearer\s+\S+/ig, 'Bearer [REDACTED]')
    : 'Sanitized failure';
  return { error_code: code, http_status: status, sqlite_extended_code: extended, message };
}

function openDb() {
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

function normalizeWindowsPath(value) {
  const resolved = path.win32.normalize(path.win32.resolve(String(value).normalize('NFC')));
  const root = path.win32.parse(resolved).root;
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
}

function sameWindowsPath(left, right) {
  return normalizeWindowsPath(left).toLocaleLowerCase('en-US') === normalizeWindowsPath(right).toLocaleLowerCase('en-US');
}

async function resolveExistingPath(value) {
  try { return path.win32.normalize(await fs.realpath(value)); }
  catch { return normalizeWindowsPath(value); }
}

function deleteExactRows(rows) {
  const db = openDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const row of rows) {
      db.prepare('DELETE FROM api_cache WHERE provider=? AND cache_key=?').run(row.provider, row.key);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no-op */ }
    throw error;
  } finally { db.close(); }
}

function exactRowsExist(rows) {
  const db = openDb();
  try {
    const stmt = db.prepare('SELECT 1 AS found FROM api_cache WHERE provider=? AND cache_key=? LIMIT 1');
    return rows.some(row => Boolean(stmt.get(row.provider, row.key)));
  } finally { db.close(); }
}

function countSmokeKeys() {
  const db = openDb();
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM api_cache WHERE cache_key LIKE 'DESKTOP_SMOKE:%' OR cache_key LIKE '%DESKTOP_SMOKE %'").get().n);
  } finally { db.close(); }
}

async function updateRuntimeHealth() {
  if (checks.oauth !== 'PASS' || checks.product_list_remote !== 'PASS'
      || checks.diagnostic_cache_write !== 'PASS' || checks.diagnostic_cache_readback !== 'PASS'
      || checks.diagnostic_cleanup !== 'PASS' || checks.product_list_cache_write !== 'PASS'
      || checks.product_list_cache_readback !== 'PASS' || checks.no_test_pollution !== 'PASS') {
    checks.runtime_health_update = 'SKIPPED_GATES_NOT_ALL_PASS';
    return;
  }
  const healthPath = path.join(INTEGRATIONS_ROOT, 'bol-api-runtime-health.json');
  const healthText = (await fs.readFile(healthPath, 'utf8')).replace(/^\uFEFF/, '');
  const record = JSON.parse(healthText);
  if (record.BOL_API_PRODUCTION_VALIDATED !== 'PASS') {
    checks.runtime_health_update = 'SKIPPED_HISTORICAL_VALIDATION_NOT_PASS';
    return;
  }
  const checkedAt = new Date().toISOString();
  record.BOL_API_RUNTIME_HEALTH = 'HEALTHY';
  record.dependency_readiness = 'READY';
  record.last_success_at = checkedAt;
  record.last_check_at = checkedAt;
  record.last_error_code = null;
  record.oauth_runtime_health = 'HEALTHY';
  record.product_list_runtime_health = 'HEALTHY';
  record.product_list_http_status = productListHttpStatus;
  record.runtime_health_evidence = {
    checked_at_utc: checkedAt,
    method: 'DESKTOP_API_CACHE_SMOKE',
    product_list_request_count: 1,
    cache_write_readback: 'PASS',
    test_data_cleanup: 'PASS',
  };
  const tempPath = `${healthPath}.${runId}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, healthPath);
  runtimeUpdated = true;
  checks.runtime_health_update = 'PASS';
}

try {
  const dataRootFromLauncher = process.env.BOL_DESKTOP_SMOKE_DATA_ROOT || '';
  const contextPath = process.env.BOL_DESKTOP_SMOKE_CONTEXT_FILE;
  const contextText = contextPath ? (await fs.readFile(contextPath, 'utf8')).replace(/^\uFEFF/, '') : '{}';
  const launcherContext = JSON.parse(contextText);
  const expectedNormalized = normalizeWindowsPath(FORMAL_DATA_ROOT);
  const actualNormalized = dataRootFromLauncher ? normalizeWindowsPath(dataRootFromLauncher) : '';
  const expectedCanonical = await resolveExistingPath(FORMAL_DATA_ROOT);
  const actualCanonical = dataRootFromLauncher ? await resolveExistingPath(dataRootFromLauncher) : '';
  let isReparsePoint = false;
  try { isReparsePoint = (await fs.lstat(dataRootFromLauncher)).isSymbolicLink(); } catch { /* Missing or invalid root is recorded below. */ }
  const actualLower = actualNormalized.toLocaleLowerCase('en-US');
  const acceptanceMarker = `\\${String.fromCodePoint(0x9a8c,0x6536)}e2e\\`.toLocaleLowerCase('en-US');
  const acceptanceName = String.fromCodePoint(0x9a8c,0x6536).toLocaleLowerCase('en-US') + 'e2e';
  const isAcceptanceRoot = actualLower.includes(acceptanceMarker) || actualLower.endsWith(`\\${acceptanceName}`);
  const isLegacyExternalProjectRoot = /(^|\\)legacy_external_project(\\|$)/.test(actualLower) || actualLower === 'd:\\LEGACY_EXTERNAL_PROJECT_ROOT' || actualLower.startsWith('d:\\LEGACY_EXTERNAL_PROJECT_ROOT\\');
  const rootsMatch = Boolean(dataRootFromLauncher) && sameWindowsPath(expectedNormalized, actualNormalized)
    && sameWindowsPath(expectedCanonical, actualCanonical);
  const dataRootDiagnostic = {
    expected_formal_data_root: FORMAL_DATA_ROOT,
    actual_resolved_data_root: actualNormalized || null,
    data_root_source: process.env.BOL_DESKTOP_SMOKE_DATA_ROOT ? 'environment' : 'default',
    original_raw_path: dataRootFromLauncher || null,
    windows_canonical_normalized_path: actualCanonical || null,
    expected_windows_canonical_normalized_path: expectedCanonical,
    current_working_directory: process.cwd(),
    has_trailing_separator: /[\\/]$/.test(dataRootFromLauncher),
    has_case_only_difference: rootsMatch && expectedNormalized !== actualNormalized,
    is_relative_path: dataRootFromLauncher ? !path.win32.isAbsolute(dataRootFromLauncher) : null,
    is_reparse_point: isReparsePoint,
    unicode_normalization_changes_path: Boolean(dataRootFromLauncher && dataRootFromLauncher.normalize('NFC') !== dataRootFromLauncher),
    unicode_nfc_equivalent_to_expected: Boolean(dataRootFromLauncher && dataRootFromLauncher.normalize('NFC').toLocaleLowerCase('en-US') === expectedNormalized.normalize('NFC').toLocaleLowerCase('en-US')),
    is_acceptance_root: isAcceptanceRoot,
    is_legacy_external_project_root: isLegacyExternalProjectRoot,
    matches_formal_root: rootsMatch,
    launcher_path_diagnostic: launcherContext.data_root_diagnostic || null,
  };
  await log('data_root_diagnostic', { status: rootsMatch && !isReparsePoint && !isAcceptanceRoot && !isLegacyExternalProjectRoot ? 'PASS' : 'FAIL', ...dataRootDiagnostic });
  const user = os.userInfo().username;
  const restricted = launcherContext.launcher_in_job_object === true || launcherContext.codex_sandbox_marker === true || /CodexSandbox/i.test(user);
  checks.process_context = restricted ? 'FAIL' : 'PASS';
  await log('process_context', {
    status: checks.process_context,
    process_user: user,
    process_pid: process.pid,
    parent_pid: process.ppid,
    node_version: process.version,
    node_executable: process.execPath,
    launcher_pid: Number.isInteger(launcherContext.launcher_pid) ? launcherContext.launcher_pid : null,
    launcher_user: launcherContext.launcher_user || null,
    launcher_in_job_object: launcherContext.launcher_in_job_object === true,
    node_child_job_membership: launcherContext.node_child_job_membership || 'UNKNOWN',
    codex_sandbox_marker: launcherContext.codex_sandbox_marker === true || /CodexSandbox/i.test(user),
    explorer_in_launch_ancestry: launcherContext.explorer_in_launch_ancestry === true,
    launch_ancestor_process_names: Array.isArray(launcherContext.launch_ancestor_process_names) ? launcherContext.launch_ancestor_process_names : [],
    formal_data_root: FORMAL_DATA_ROOT,
    database_path: DB_FILE,
  });
  if (restricted || launcherContext.explorer_in_launch_ancestry !== true) throw Object.assign(new Error('RESTRICTED_OR_NON_DESKTOP_CONTEXT'), { code: 'RESTRICTED_OR_NON_DESKTOP_CONTEXT' });
  if (!rootsMatch || isReparsePoint || isAcceptanceRoot || isLegacyExternalProjectRoot) throw Object.assign(new Error('FORMAL_DATA_ROOT_MISMATCH'), { code: 'FORMAL_DATA_ROOT_MISMATCH' });
  if (path.resolve(process.cwd()) !== path.resolve(PROJECT_ROOT)) throw Object.assign(new Error('PROJECT_ROOT_MISMATCH'), { code: 'PROJECT_ROOT_MISMATCH' });
  if (countSmokeKeys() !== 0) throw Object.assign(new Error('PREEXISTING_DESKTOP_SMOKE_CACHE_KEYS'), { code: 'PREEXISTING_DESKTOP_SMOKE_CACHE_KEYS' });

  cache = new ApiCache(FORMAL_DATA_ROOT);
  await cache.initialize();
  const probeValue = { runId, marker: diagnosticKey, createdAt: STARTED_AT };
  await cache.set(diagnosticProvider, diagnosticKey, {
    rawResponse: probeValue,
    structuredResult: probeValue,
    source: 'DESKTOP_SMOKE',
    ttlMs: 60_000,
  });
  checks.diagnostic_cache_write = 'PASS';
  await log('diagnostic_cache_write', { status: 'PASS', provider: diagnosticProvider, unique_key: diagnosticKey, sqlite_file: DB_FILE });

  const probeRead = await cache.get(diagnosticProvider, diagnosticKey);
  checks.diagnostic_cache_readback = probeRead && JSON.stringify(probeRead.rawResponse) === JSON.stringify(probeValue)
    && JSON.stringify(probeRead.structuredResult) === JSON.stringify(probeValue) ? 'PASS' : 'FAIL';
  await log('diagnostic_cache_readback', { status: checks.diagnostic_cache_readback, value_matches: checks.diagnostic_cache_readback === 'PASS' });
  if (checks.diagnostic_cache_readback !== 'PASS') throw Object.assign(new Error('CACHE_READBACK_MISMATCH'), { code: 'CACHE_READBACK_MISMATCH' });

  cache.close();
  cache = null;
  deleteExactRows([{ provider: diagnosticProvider, key: diagnosticKey }]);
  checks.diagnostic_cleanup = exactRowsExist([{ provider: diagnosticProvider, key: diagnosticKey }]) ? 'FAIL' : 'PASS';
  await log('diagnostic_cleanup', { status: checks.diagnostic_cleanup, test_record_present: checks.diagnostic_cleanup !== 'PASS' });
  if (checks.diagnostic_cleanup !== 'PASS') throw Object.assign(new Error('CACHE_CLEANUP_FAILED'), { code: 'CACHE_CLEANUP_FAILED' });

  client = new BolRetailerClient({ dataRoot: FORMAL_DATA_ROOT, envFile: path.join(PROJECT_ROOT, '.env') });
  const oauth = await client.validateOAuth();
  checks.oauth = oauth.status === 'PASS' && oauth.httpStatus === 200 ? 'PASS' : 'FAIL';
  await log('oauth_readiness_refresh', { status: checks.oauth, http_status: oauth.httpStatus, token_obtained: oauth.status === 'PASS', token_type: oauth.tokenType, expires_in_seconds: oauth.expiresInSeconds, validated_at_utc: oauth.validatedAt });
  if (checks.oauth !== 'PASS') throw Object.assign(new Error('OAUTH_NOT_PASS'), { code: 'OAUTH_NOT_PASS', status: oauth.httpStatus });

  const productResult = await client.getProductList({ countryCode: 'NL', searchTerm: productSearchTerm, sort: 'RELEVANCE', page: 1, cacheMode: 'FORCE_REFRESH' });
  productListHttpStatus = Number(productResult?.source?.match(/HTTP (\d+)/)?.[1] || 0);
  checks.product_list_remote = productListHttpStatus >= 200 && productListHttpStatus < 300 ? 'PASS' : 'FAIL';
  await log('product_list_remote', { status: checks.product_list_remote, http_status: productListHttpStatus, endpoint: '/retailer/products/list', adapter_call_count: 1, response_product_count: productResult?.structuredResult?.products?.length ?? null });
  if (checks.product_list_remote !== 'PASS') throw Object.assign(new Error('PRODUCT_LIST_REMOTE_NOT_PASS'), { code: 'PRODUCT_LIST_REMOTE_NOT_PASS' });

  checks.product_list_cache_write = productResult?.cacheHit === false ? 'PASS' : 'FAIL';
  await log('product_list_cache_write', { status: checks.product_list_cache_write, cache_provider: productProvider, unique_search_marker: true });
  if (checks.product_list_cache_write !== 'PASS') throw Object.assign(new Error('PRODUCT_LIST_CACHE_WRITE_NOT_PASS'), { code: 'PRODUCT_LIST_CACHE_WRITE_NOT_PASS' });

  const cachedResult = await client.cache.get(productProvider, productCacheKey);
  checks.product_list_cache_readback = cachedResult && JSON.stringify(cachedResult.rawResponse) === JSON.stringify(productResult.rawResponse)
    && JSON.stringify(cachedResult.structuredResult) === JSON.stringify(productResult.structuredResult) ? 'PASS' : 'FAIL';
  await log('product_list_cache_readback', { status: checks.product_list_cache_readback, raw_response_matches: checks.product_list_cache_readback === 'PASS', structured_result_matches: checks.product_list_cache_readback === 'PASS' });
  if (checks.product_list_cache_readback !== 'PASS') throw Object.assign(new Error('PRODUCT_LIST_CACHE_READBACK_MISMATCH'), { code: 'PRODUCT_LIST_CACHE_READBACK_MISMATCH' });

  client.cache.close();
  client = null;
  deleteExactRows([
    { provider: diagnosticProvider, key: diagnosticKey },
    { provider: productProvider, key: productCacheKey },
  ]);
  const residualExact = exactRowsExist([
    { provider: diagnosticProvider, key: diagnosticKey },
    { provider: productProvider, key: productCacheKey },
  ]);
  const residualSmokeCount = countSmokeKeys();
  checks.no_test_pollution = !residualExact && residualSmokeCount === 0 ? 'PASS' : 'FAIL';
  cleanupCompleted = checks.no_test_pollution === 'PASS';
  await log('test_cleanup_and_pollution_check', { status: checks.no_test_pollution, residual_exact_test_rows: residualExact, residual_desktop_smoke_keys: residualSmokeCount });
  if (checks.no_test_pollution !== 'PASS') throw Object.assign(new Error('TEST_CACHE_POLLUTION_DETECTED'), { code: 'TEST_CACHE_POLLUTION_DETECTED' });

  await updateRuntimeHealth();
  await log('runtime_health_update', { status: checks.runtime_health_update, production_validation_preserved: true, runtime_health: runtimeUpdated ? 'HEALTHY' : 'UNCHANGED', readiness: runtimeUpdated ? 'READY' : 'UNCHANGED' });
} catch (error) {
  sqliteError = error?.code === 'ERR_SQLITE_ERROR' || error?.code === 'SQLITE_READONLY' ? safeError(error) : null;
  const failure = safeError(error);
  await log('smoke_failure', { status: 'FAIL', ...failure, sqlite_diagnostic: sqliteError });
} finally {
  try { cache?.close(); } catch { /* cleanup below uses its own connection */ }
  try { client?.cache?.close(); } catch { /* cleanup below uses its own connection */ }
  try {
    if (!cleanupCompleted) {
      const rows = [
        { provider: diagnosticProvider, key: diagnosticKey },
        { provider: productProvider, key: productCacheKey },
      ];
      deleteExactRows(rows);
      const residual = exactRowsExist(rows);
      if (residual) checks.no_test_pollution = 'FAIL';
      else cleanupCompleted = true;
    }
  } catch (error) {
    if (checks.no_test_pollution !== 'PASS') checks.no_test_pollution = 'FAIL';
    await log('cleanup_failure', safeError(error));
  }
  await log('final_summary', {
    status: checks.oauth === 'PASS' && checks.product_list_remote === 'PASS'
      && checks.diagnostic_cache_write === 'PASS' && checks.diagnostic_cache_readback === 'PASS'
      && checks.diagnostic_cleanup === 'PASS' && checks.product_list_cache_write === 'PASS'
      && checks.product_list_cache_readback === 'PASS' && checks.no_test_pollution === 'PASS'
      && checks.runtime_health_update === 'PASS' ? 'PASS' : 'FAIL',
    checks,
    runtime_health_updated: runtimeUpdated,
    sqlite_error: sqliteError,
    audit_file: auditFile,
  });
}

const allRequiredPass = checks.oauth === 'PASS' && checks.product_list_remote === 'PASS'
  && checks.diagnostic_cache_write === 'PASS' && checks.diagnostic_cache_readback === 'PASS'
  && checks.diagnostic_cleanup === 'PASS' && checks.product_list_cache_write === 'PASS'
  && checks.product_list_cache_readback === 'PASS' && checks.no_test_pollution === 'PASS'
  && checks.runtime_health_update === 'PASS';
console.log(`Audit file: ${auditFile}`);
console.log(`Result: ${allRequiredPass ? 'PASS' : 'FAIL'}`);
process.exitCode = allRequiredPass ? 0 : 1;
