import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { amsterdamBusinessDate, normalizeUtcTimestamp } from './boloo_keyword_policy.mjs';

export const BOL_KEYWORD_VOLUME_IDENTITY = Object.freeze({
  marketplace: 'BOL_NL',
  language: 'nl-NL',
  metric: 'Gemiddeld zoekvolume per maand',
});

function evidenceIsReadable(reference, expectedSha256) {
  if (typeof reference !== 'string' || !path.isAbsolute(reference) || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) return false;
  try { return crypto.createHash('sha256').update(fs.readFileSync(reference)).digest('hex') === expectedSha256; }
  catch { return false; }
}

function normalizeIdentity(identity, exactString, queryDate) {
  if (typeof exactString !== 'string' || !exactString.trim() || /https?:\/\//i.test(exactString)) throw new TypeError('EXACT_KEYWORD_REQUIRED');
  const marketplace = String(identity?.marketplace || '');
  const language = String(identity?.language || '');
  const metric = String(identity?.metric || '');
  if (!marketplace || !language || !metric || !/^\d{4}-\d{2}-\d{2}$/.test(queryDate || '')) throw new TypeError('KEYWORD_VOLUME_IDENTITY_INCOMPLETE');
  return { exactString, marketplace, language, metric, queryDate };
}

export class BolooKeywordVolumeLibrary {
  #db;
  constructor(file) {
    if (!file) throw new TypeError('A shared Keyword Volume Library SQLite path is required.');
    this.file = path.resolve(file);
  }

  initialize() {
    if (this.#db) return this;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.#db = new DatabaseSync(this.file);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS boloo_keyword_volume_v1 (
        record_id TEXT PRIMARY KEY,
        keyword_exact TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        language TEXT NOT NULL,
        metric TEXT NOT NULL,
        query_date TEXT NOT NULL,
        status TEXT NOT NULL,
        monthly_volume REAL,
        queried_at_utc TEXT NOT NULL,
        source_sku TEXT NOT NULL,
        source_record TEXT NOT NULL,
        evidence_ref TEXT NOT NULL DEFAULT '',
        evidence_sha256 TEXT NOT NULL DEFAULT '',
        provider_request_id TEXT NOT NULL DEFAULT '',
        recorded_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS boloo_keyword_volume_v1_identity
        ON boloo_keyword_volume_v1(keyword_exact, marketplace, language, metric, query_date, status);
    `);
    return this;
  }

  close() { this.#db?.close(); this.#db = null; }

  lookup({ exactString, marketplace = BOL_KEYWORD_VOLUME_IDENTITY.marketplace,
    language = BOL_KEYWORD_VOLUME_IDENTITY.language, metric = BOL_KEYWORD_VOLUME_IDENTITY.metric, now = new Date() }) {
    this.initialize();
    const queryDate = amsterdamBusinessDate(normalizeUtcTimestamp(new Date(now).toISOString()));
    const identity = normalizeIdentity({ marketplace, language, metric }, exactString, queryDate);
    const rows = this.#db.prepare(`SELECT * FROM boloo_keyword_volume_v1
      WHERE keyword_exact=? AND marketplace=? AND language=? AND metric=? ORDER BY query_date DESC, recorded_at_utc DESC`)
      .all(identity.exactString, identity.marketplace, identity.language, identity.metric);
    const today = rows.find(row => row.query_date === queryDate && ['PASS', 'ZERO_VALID'].includes(row.status)
      && Number.isFinite(row.monthly_volume) && row.monthly_volume >= 0
      && evidenceIsReadable(row.evidence_ref, row.evidence_sha256));
    if (today) return { status: 'HIT_TODAY', exact_string: exactString, query_date: queryDate,
      monthly_volume: today.monthly_volume, demand_status: today.monthly_volume === 0 ? 'ZERO_VALID' : 'POSITIVE',
      source_record: today.record_id, source_sku: today.source_sku, evidence_ref: today.evidence_ref,
      provider_request_id: today.provider_request_id, queried_at_utc: today.queried_at_utc,
      provider_method: 'BOLOO_OFFICIAL_WEB', identity: { marketplace, language, metric } };
    const history = rows.filter(row => ['PASS', 'ZERO_VALID'].includes(row.status));
    const unusableToday = rows.find(row => row.query_date === queryDate);
    return { status: unusableToday ? 'LEGACY_CACHE_NOT_REUSABLE' : history.length ? 'HISTORY' : 'MISS',
      exact_string: exactString, query_date: queryDate,
      history: history.map(row => ({ query_date: row.query_date, status: row.status, monthly_volume: row.monthly_volume, record_id: row.record_id })),
      identity: { marketplace, language, metric } };
  }

  record({ exactString, identity = BOL_KEYWORD_VOLUME_IDENTITY, queriedAt, status, monthlyVolume,
    sourceSku, sourceRecord, evidenceRef, evidenceSha256, providerRequestId = '' }) {
    this.initialize();
    const queriedAtUtc = normalizeUtcTimestamp(queriedAt);
    const queryDate = amsterdamBusinessDate(queriedAtUtc);
    const key = normalizeIdentity(identity, exactString, queryDate);
    if (!['PASS', 'ZERO_VALID', 'FAILED', 'BLOCKED'].includes(status)) throw new TypeError('KEYWORD_VOLUME_STATUS_INVALID');
    if (status === 'PASS' || status === 'ZERO_VALID') {
      if (!Number.isFinite(monthlyVolume) || monthlyVolume < 0 || (status === 'ZERO_VALID') !== (monthlyVolume === 0)) throw new TypeError('KEYWORD_VOLUME_VALUE_INVALID');
      if (!sourceSku || !sourceRecord || !providerRequestId || !evidenceIsReadable(evidenceRef, evidenceSha256)) throw new TypeError('KEYWORD_VOLUME_EVIDENCE_INVALID');
    } else if (monthlyVolume !== null && monthlyVolume !== undefined) throw new TypeError('FAILED_RESULT_CANNOT_STORE_VOLUME');
    const recordId = `BOL-V1-${crypto.createHash('sha256').update(JSON.stringify([key, status, monthlyVolume, sourceRecord])).digest('hex').slice(0, 24)}`;
    const row = { ...key, record_id: recordId, status, monthly_volume: status === 'FAILED' || status === 'BLOCKED' ? null : monthlyVolume,
      queried_at_utc: queriedAtUtc, source_sku: sourceSku || '', source_record: sourceRecord || '',
      evidence_ref: evidenceRef || '', evidence_sha256: evidenceSha256 || '', provider_request_id: providerRequestId,
      recorded_at_utc: new Date().toISOString() };
    const existing = this.#db.prepare('SELECT * FROM boloo_keyword_volume_v1 WHERE record_id=?').get(recordId);
    if (existing) {
      const comparable = [existing.keyword_exact, existing.marketplace, existing.language, existing.metric, existing.query_date,
        existing.status, existing.monthly_volume, existing.source_record, existing.evidence_sha256];
      const incoming = [row.exactString, row.marketplace, row.language, row.metric, row.queryDate, row.status,
        row.monthly_volume, row.source_record, row.evidence_sha256];
      if (JSON.stringify(comparable) !== JSON.stringify(incoming)) throw Object.assign(new Error('KEYWORD_VOLUME_IDENTITY_CONFLICT'), { code: 'KEYWORD_VOLUME_IDENTITY_CONFLICT' });
      return { ...existing, idempotent: true };
    }
    this.#db.prepare(`INSERT INTO boloo_keyword_volume_v1
      (record_id, keyword_exact, marketplace, language, metric, query_date, status, monthly_volume,
       queried_at_utc, source_sku, source_record, evidence_ref, evidence_sha256, provider_request_id, recorded_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.record_id, row.exactString, row.marketplace, row.language, row.metric, row.queryDate, row.status,
        row.monthly_volume, row.queried_at_utc, row.source_sku, row.source_record, row.evidence_ref, row.evidence_sha256,
        row.provider_request_id, row.recorded_at_utc);
    return row;
  }

  lookupBatch(skuTerms, options = {}) {
    if (!Array.isArray(skuTerms)) throw new TypeError('SKU batch must be an array.');
    const unique = new Map();
    for (const item of skuTerms) {
      if (!item?.sku || !Array.isArray(item.exactStrings)) throw new TypeError('Each batch entry requires sku and exactStrings.');
      for (const exactString of item.exactStrings) {
        if (typeof exactString !== 'string' || !exactString.trim()) throw new TypeError('EXACT_KEYWORD_REQUIRED');
        if (!unique.has(exactString)) unique.set(exactString, this.lookup({ ...options, exactString }));
      }
    }
    return { unique_terms: [...unique.keys()], unique_lookup_count: unique.size,
      miss_terms: [...unique].filter(([, result]) => result.status !== 'HIT_TODAY').map(([term]) => term),
      per_sku: skuTerms.map(item => ({ sku: item.sku, results: item.exactStrings.map(exactString => ({ exact_string: exactString, ...unique.get(exactString) })) })) };
  }
}
