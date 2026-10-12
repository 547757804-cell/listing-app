// Read-only projection of persisted SOP06 evidence. No Provider, task or cache writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { amsterdamBusinessDate, normalizeUtcTimestamp } from './boloo_keyword_policy.mjs';

export const VOLUME_LIBRARY_CONTRACT = 'BOLOO_VOLUME_LIBRARY_V1';
export const OFFICIAL_VOLUME_FIELD = 'Gemiddeld zoekvolume per maand';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const encode = value => JSON.stringify(canonical(value));
const measurement = r => encode([r.execution_kind, r.exact_string, r.monthly_volume, r.provider_method,
  r.provider_request_id, r.result_version, r.queried_at, r.raw_dom_evidence, r.page_url]);
const fail = code => { throw new Error(code); };
const inside = (root, file) => { const r = path.relative(root, file); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function readSource(sourceRoot, reference) {
  if (typeof reference !== 'string' || !reference || /^[a-z]+:\/\//i.test(reference)) fail('LOCAL_SOURCE_REF_REQUIRED');
  const root = fs.realpathSync(sourceRoot);
  const file = fs.realpathSync(path.resolve(root, reference));
  if (!inside(root, file)) fail('SOURCE_OUTSIDE_APPROVED_ROOT');
  if (fs.statSync(file).size > 50 * 1024 * 1024) fail('SOURCE_TOO_LARGE');
  const bytes = fs.readFileSync(file);
  return { file, bytes, value: JSON.parse(bytes), sha256: sha(bytes) };
}

function projectObservation(row, artifact, artifactSource, sourceRoot, executionKind) {
  const p = row.provider_result, e = p?.evidence;
  if (row.status !== 'PASS' || row.qa_status !== 'PASS' || p?.status !== 'PASS') fail('NOT_FORMAL_VOLUME_PASS');
  if (row.provider_method !== 'BOLOO_OFFICIAL_WEB' || p.cache_source !== 'BOLOO_OFFICIAL_WEB') fail('NOT_OFFICIAL_WEB_EVIDENCE');
  if (p.provider_source !== 'keyword_explorer') fail('NOT_KEYWORD_EXPLORER');
  if (e?.field_name !== OFFICIAL_VOLUME_FIELD) fail('NOT_FORMAL_MONTHLY_VOLUME_FIELD');
  const exact = row.exact_string;
  if (typeof exact !== 'string' || !exact.trim() || /https?:\/\//i.test(exact)) fail('EXACT_STRING_REQUIRED');
  if (p.query_text !== exact || e.matched_query !== exact) fail('EXACT_STRING_MISMATCH');
  if (!Number.isFinite(row.volume) || row.volume < 0 || p.result?.search_volume !== row.volume) fail('INVALID_OR_MISMATCHED_VOLUME');
  if (!row.result_version || !row.provider_request_id || p.request_id !== row.provider_request_id) fail('RESULT_IDENTITY_MISSING');
  const queriedAt = normalizeUtcTimestamp(row.queried_at);
  if (normalizeUtcTimestamp(p.observed_at) !== queriedAt) fail('QUERY_TIMESTAMP_MISMATCH');
  const ref = e.dom_evidence_ref?.reference;
  if (!row.evidence_refs_result?.some(x => x.reference === ref && x.persisted === true && x.matches_request === true)) fail('RAW_DOM_LINK_MISSING');
  const raw = readSource(sourceRoot, ref);
  if (raw.value.request_id !== p.request_id || raw.value.query_text !== exact || raw.value.operation !== 'keyword_explorer') fail('RAW_IDENTITY_MISMATCH');
  if (raw.value.raw_response?.matched_query !== exact || raw.value.raw_response?.field_name !== OFFICIAL_VOLUME_FIELD ||
    raw.value.raw_response?.displayed_value !== e.displayed_value) fail('RAW_FIELD_MISMATCH');
  const displayed = String(e.displayed_value ?? '').trim();
  const renderings = [String(row.volume), row.volume.toLocaleString('nl-NL', { maximumFractionDigits: 20 }),
    row.volume.toLocaleString('en-US', { maximumFractionDigits: 20 })];
  if (!renderings.includes(displayed)) fail('RAW_VOLUME_CONSISTENCY_NOT_CONFIRMED');
  const page = new URL(e.page_url);
  if (page.protocol !== 'https:' || page.hostname !== 'app.boloo.co' || page.pathname !== '/research/explorer/') fail('EXPLORER_PAGE_MISMATCH');
  if (page.searchParams.get('keyword') !== exact) fail('PAGE_QUERY_MISMATCH');
  // Query/period are retained; unreported market scope is never inferred to be NL only.
  const safePage = `${page.origin}${page.pathname}?${new URLSearchParams({ keyword: exact, ...(page.searchParams.has('period') ? { period: page.searchParams.get('period') } : {}) })}`;
  const record = {
    contract: VOLUME_LIBRARY_CONTRACT, execution_kind: executionKind,
    exact_string: exact, monthly_volume: row.volume, demand_status: row.volume === 0 ? 'ZERO_VALID' : 'POSITIVE',
    provider_method: row.provider_method, provider_source: 'keyword_explorer', field_name: OFFICIAL_VOLUME_FIELD,
    provider_request_id: p.request_id, result_version: row.result_version,
    queried_at: queriedAt, query_business_date: amsterdamBusinessDate(queriedAt), timezone: 'Europe/Amsterdam',
    page_url: safePage, period_parameter: page.searchParams.get('period') ?? 'NOT_REPORTED', market_scope: 'NOT_REPORTED',
    source_sku: artifact.sku, source_step: 'LISTING_SOP_06', source_version: artifact.version,
    source_facts_version: artifact.confirmed_product_facts_version ?? null, source_sop05_version: artifact.sop05_version ?? null,
    source_artifact: { reference: artifactSource.file, sha256: artifactSource.sha256 },
    raw_dom_evidence: { reference: raw.file, sha256: raw.sha256 },
    qa_status: 'PASS', sku_relevance: 'NOT_TRANSFERABLE', automatic_provider_call: false,
  };
  record.observation_id = `BOLOO-VOLUME-${sha(encode([executionKind, record.provider_method, record.provider_request_id, record.result_version])).slice(0, 24)}`;
  return record;
}

export function buildBolooVolumeSnapshot({ sourceRoot, artifactRef, expectedVersion, expectedSha256, executionKind = 'REAL_PERSISTED_EVIDENCE' }) {
  if (!['REAL_PERSISTED_EVIDENCE', 'OFFLINE_TEST'].includes(executionKind)) fail('UNSUPPORTED_EXECUTION_KIND');
  if (!expectedVersion || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) fail('EXPLICIT_SOURCE_VERSION_AND_HASH_REQUIRED');
  const src = readSource(sourceRoot, artifactRef), a = src.value;
  if (src.sha256 !== expectedSha256 || a.version !== expectedVersion) fail('SOURCE_VERSION_OR_HASH_MISMATCH');
  if (a.sop_step_id !== 'LISTING_SOP_06' || a.qa_status !== 'PASS' || !a.sku || !Array.isArray(a.results)) fail('SOP06_PASS_SOURCE_REQUIRED');
  if (executionKind === 'REAL_PERSISTED_EVIDENCE' && /OFFLINE|MOCK|FIXTURE/.test(a.execution_kind || '')) fail('MOCK_CANNOT_BECOME_REAL');
  const observations = [], excluded_records = [], seen = new Map();
  for (const [i, row] of a.results.entries()) {
    try {
      const r = projectObservation(row, a, src, sourceRoot, executionKind), old = seen.get(r.observation_id);
      if (old && encode(old) !== encode(r)) fail('CONFLICTING_RESULT_IDENTITY');
      if (!old) { observations.push(r); seen.set(r.observation_id, r); }
    } catch (error) {
      if (error.message === 'CONFLICTING_RESULT_IDENTITY') throw error;
      excluded_records.push({ ordinal: i + 1, exact_string: typeof row.exact_string === 'string' ? row.exact_string : null,
        source_status: row.status ?? null, result_version: row.result_version ?? null, reason: error.message });
    }
  }
  const body = { contract: VOLUME_LIBRARY_CONTRACT, execution_kind: executionKind,
    source_root: fs.realpathSync(sourceRoot), source_artifact: { reference: src.file, version: a.version, sha256: src.sha256 },
    observations, excluded_records,
    policy: { exact_string_normalization: 'NONE', reuse_day: 'Europe/Amsterdam', historical_is_current_cache: false,
      provider_calls: 0, task_writes: 0, relevance_inherited: false, runtime_dispatch_connected: false } };
  return { ...body, version: `BOLOO-VOLUME-LIBRARY-${sha(encode(body)).slice(0, 24)}` };
}

function assertSnapshot(snapshot) {
  const { version, ...body } = snapshot;
  if (body.contract !== VOLUME_LIBRARY_CONTRACT || version !== `BOLOO-VOLUME-LIBRARY-${sha(encode(body)).slice(0, 24)}`) fail('SNAPSHOT_INTEGRITY_FAILED');
  return snapshot;
}

export function persistBolooVolumeSnapshot(snapshot, libraryRoot) {
  assertSnapshot(snapshot);
  const target = path.resolve(libraryRoot), source = fs.realpathSync(snapshot.source_root);
  if (inside(source, target)) fail('LIBRARY_MUST_BE_SEPARATE_FROM_SOURCE');
  fs.mkdirSync(target, { recursive: true });
  if (inside(source, fs.realpathSync(target))) fail('LIBRARY_MUST_BE_SEPARATE_FROM_SOURCE');
  // Append-only snapshots. A changed source creates another version, never edits history.
  for (const f of fs.readdirSync(target).filter(f => /^BOLOO-VOLUME-LIBRARY-[a-f0-9]+\.json$/.test(f))) {
    const old = loadBolooVolumeSnapshot(path.join(target, f));
    for (const r of snapshot.observations) {
      const prior = old.observations.find(x => x.observation_id === r.observation_id);
      if (prior && measurement(prior) !== measurement(r)) fail('CONFLICTING_RESULT_IDENTITY');
    }
  }
  const file = path.join(target, `${snapshot.version}.json`), bytes = JSON.stringify(snapshot, null, 2) + '\n';
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST' || encode(loadBolooVolumeSnapshot(file)) !== encode(snapshot)) throw e; }
  return { version: snapshot.version, reference: file, sha256: sha(fs.readFileSync(file)) };
}

export function loadBolooVolumeSnapshot(file) { return assertSnapshot(JSON.parse(fs.readFileSync(file, 'utf8'))); }

export function lookupBolooVolume(snapshot, exactString, { now = new Date().toISOString() } = {}) {
  assertSnapshot(snapshot);
  const instant = normalizeUtcTimestamp(now), day = amsterdamBusinessDate(instant);
  const records = snapshot.observations.filter(r => r.exact_string === exactString).map(r => {
    const valid = [r.source_artifact, r.raw_dom_evidence].every(e => {
      try { return sha(fs.readFileSync(e.reference)) === e.sha256; } catch { return false; }
    });
    const eligibility = !valid ? 'EVIDENCE_UNREADABLE_OR_CHANGED' : r.execution_kind !== 'REAL_PERSISTED_EVIDENCE' ? 'OFFLINE_TEST_ONLY'
      : r.queried_at > instant ? 'FUTURE_OBSERVATION_REJECTED' : r.query_business_date === day ? 'SAME_DAY_CACHE_COMPATIBLE' : 'HISTORICAL_ONLY';
    return { ...r, eligibility, current_business_date: day };
  });
  // Display all observations, not an automatic winner, relevance judgment, or Provider request.
  return { exact_string: exactString, records, automatic_selection: false, provider_calls: 0 };
}
