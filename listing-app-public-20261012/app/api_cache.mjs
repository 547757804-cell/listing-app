import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { amsterdamBusinessDate, normalizeUtcTimestamp } from './boloo_keyword_policy.mjs';

/** Persistent response cache. Secrets and authorization material must never be passed here. */
export class ApiCache {
  #db;

  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.file = path.join(this.dataRoot, 'api-cache.sqlite3');
  }

  async initialize() {
    await fs.mkdir(this.dataRoot, { recursive: true });
    if (!this.#db) {
      this.#db = new DatabaseSync(this.file);
      this.#db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS api_cache (
          provider TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          source TEXT NOT NULL,
          raw_response TEXT NOT NULL,
          structured_result TEXT NOT NULL,
          PRIMARY KEY (provider, cache_key)
        );
        CREATE INDEX IF NOT EXISTS api_cache_expiry ON api_cache(expires_at);
        CREATE TABLE IF NOT EXISTS boloo_keyword_history (
          observation_id TEXT PRIMARY KEY,
          exact_string TEXT NOT NULL,
          query_date TEXT NOT NULL,
          source TEXT NOT NULL,
          provider_method TEXT NOT NULL DEFAULT '',
          queried_at_utc TEXT NOT NULL DEFAULT '',
          tool_name TEXT NOT NULL,
          stage_qa_status TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          page_url TEXT NOT NULL DEFAULT '',
          page_field_name TEXT NOT NULL DEFAULT '',
          raw_value TEXT NOT NULL DEFAULT 'null',
          fetched_at_utc TEXT NOT NULL DEFAULT '',
          raw_dom_evidence_ref TEXT NOT NULL DEFAULT '',
          marketplace TEXT NOT NULL DEFAULT '',
          language TEXT NOT NULL DEFAULT '',
          metric TEXT NOT NULL DEFAULT '',
          raw_response TEXT NOT NULL,
          structured_result TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS boloo_keyword_history_reuse
          ON boloo_keyword_history(exact_string, query_date, source, stage_qa_status, recorded_at);
      `);
      const keywordColumns = new Set(this.#db.prepare('PRAGMA table_info(boloo_keyword_history)').all().map(row => row.name));
      for (const [name, declaration] of [
        ['provider_method', "TEXT NOT NULL DEFAULT ''"], ['queried_at_utc', "TEXT NOT NULL DEFAULT ''"],
        ['page_url', "TEXT NOT NULL DEFAULT ''"], ['page_field_name', "TEXT NOT NULL DEFAULT ''"],
        ['raw_value', "TEXT NOT NULL DEFAULT 'null'"], ['fetched_at_utc', "TEXT NOT NULL DEFAULT ''"],
        ['raw_dom_evidence_ref', "TEXT NOT NULL DEFAULT ''"], ['marketplace', "TEXT NOT NULL DEFAULT ''"],
        ['language', "TEXT NOT NULL DEFAULT ''"], ['metric', "TEXT NOT NULL DEFAULT ''"],
      ]) if (!keywordColumns.has(name)) this.#db.exec(`ALTER TABLE boloo_keyword_history ADD COLUMN ${name} ${declaration}`);
      this.#db.exec(`UPDATE boloo_keyword_history SET provider_method=source
        WHERE provider_method='' AND source IN ('BOLOO_OFFICIAL_MCP', 'BOLOO_OFFICIAL_WEB')`);
    }
    return this;
  }

  async get(provider, cacheKey, now = new Date()) {
    await this.initialize();
    const row = this.#db.prepare('SELECT * FROM api_cache WHERE provider=? AND cache_key=?').get(provider, cacheKey);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime()) {
      this.#db.prepare('DELETE FROM api_cache WHERE provider=? AND cache_key=?').run(provider, cacheKey);
      return null;
    }
    try {
      return {
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        source: row.source,
        rawResponse: JSON.parse(row.raw_response),
        structuredResult: JSON.parse(row.structured_result),
        cacheHit: true,
      };
    } catch {
      this.#db.prepare('DELETE FROM api_cache WHERE provider=? AND cache_key=?').run(provider, cacheKey);
      return null;
    }
  }

  async set(provider, cacheKey, { rawResponse, structuredResult, source = provider, ttlMs }, now = new Date()) {
    await this.initialize();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number');
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.#db.prepare(`INSERT INTO api_cache (provider, cache_key, created_at, expires_at, source, raw_response, structured_result)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, cache_key) DO UPDATE SET created_at=excluded.created_at, expires_at=excluded.expires_at,
      source=excluded.source, raw_response=excluded.raw_response, structured_result=excluded.structured_result`)
      .run(provider, cacheKey, createdAt, expiresAt, source, JSON.stringify(rawResponse), JSON.stringify(structuredResult));
    return { createdAt, expiresAt, source, rawResponse, structuredResult, cacheHit: false };
  }

  /** Permanent audit history; formal reuse is intentionally restricted to same-day, exact, Boloo PASS rows. */
  async recordBolooKeywordObservation({ exactString, queryDate, queriedAtUtc, toolName, providerMethod, officialSourceVerified, stageQaStatus, rawResponse, structuredResult, pageUrl = '', pageFieldName = '', rawValue = null, fetchedAtUtc = '', rawDomEvidenceRef = null, marketplace = 'BOL_NL', language = 'nl-NL', metric = 'Gemiddeld zoekvolume per maand' }, now = new Date()) {
    await this.initialize();
    if (typeof exactString !== 'string' || !exactString.trim()) throw new TypeError('exactString must be non-empty');
    let normalizedQueriedAtUtc;
    try { normalizedQueriedAtUtc = normalizeUtcTimestamp(queriedAtUtc); }
    catch { throw new TypeError('queriedAtUtc must be a valid UTC ISO timestamp'); }
    const businessDate = amsterdamBusinessDate(normalizedQueriedAtUtc);
    if (queryDate != null && queryDate !== businessDate) throw new TypeError('queryDate must match the Europe/Amsterdam business date of queriedAtUtc');
    if (typeof toolName !== 'string' || !toolName.trim()) throw new TypeError('toolName must be non-empty');
    if (!['BOLOO_OFFICIAL_MCP', 'BOLOO_OFFICIAL_WEB'].includes(providerMethod)) throw new TypeError('providerMethod must identify a supported official Boloo source');
    if (officialSourceVerified !== true) throw new TypeError('Boloo source must pass official-source verification');
    if (stageQaStatus !== 'PASS') throw new TypeError('Only Stage QA PASS keyword observations can be recorded for formal reuse');
    if (rawResponse === undefined || structuredResult === undefined) throw new TypeError('rawResponse and structuredResult are required');
    let normalizedFetchedAtUtc = '';
    let evidenceJson = '';
    if (providerMethod === 'BOLOO_OFFICIAL_WEB') {
      let page;
      try { page = new URL(pageUrl); } catch { throw new TypeError('Web page URL is required'); }
      if (page.protocol !== 'https:' || page.username || page.password || !(page.hostname === 'boloo.co' || page.hostname.endsWith('.boloo.co'))) throw new TypeError('Web page URL must use the official Boloo HTTPS domain');
      if (typeof pageFieldName !== 'string' || !pageFieldName.trim()) throw new TypeError('Web page field name is required');
      if (rawValue === undefined || rawValue === null) throw new TypeError('The original Web page field value is required');
      if (!isValidUtcTimestamp(fetchedAtUtc) || amsterdamBusinessDate(fetchedAtUtc) !== businessDate) throw new TypeError('fetchedAtUtc must be UTC and match the query business date');
      if (!rawDomEvidenceRef || typeof rawDomEvidenceRef !== 'object' || !['RAW', 'DOM'].includes(rawDomEvidenceRef.kind) || typeof rawDomEvidenceRef.reference !== 'string' || !rawDomEvidenceRef.reference.trim()) {
        throw new TypeError('A traceable RAW or DOM evidence reference is required');
      }
      normalizedFetchedAtUtc = normalizeUtcTimestamp(fetchedAtUtc);
      evidenceJson = JSON.stringify(rawDomEvidenceRef);
    }
    if (typeof marketplace !== 'string' || !marketplace || typeof language !== 'string' || !language || typeof metric !== 'string' || !metric) throw new TypeError('marketplace, language, and metric identity are required');
    const observation = {
      observationId: crypto.randomUUID(), exactString, queryDate: businessDate, queried_at_utc: normalizedQueriedAtUtc,
      source: 'BOLOO_OFFICIAL_VERIFIED', provider_method: providerMethod,
      marketplace, language, metric,
      toolName, stageQaStatus: 'PASS', recordedAt: now.toISOString(), rawResponse, structuredResult,
      page_url: providerMethod === 'BOLOO_OFFICIAL_WEB' ? pageUrl : '',
      page_field_name: providerMethod === 'BOLOO_OFFICIAL_WEB' ? pageFieldName : '',
      raw_value: rawValue, fetched_at_utc: normalizedFetchedAtUtc, raw_dom_evidence_ref: evidenceJson,
    };
    this.#db.prepare(`INSERT INTO boloo_keyword_history (observation_id, exact_string, query_date, source, provider_method, queried_at_utc, tool_name, stage_qa_status, recorded_at, page_url, page_field_name, raw_value, fetched_at_utc, raw_dom_evidence_ref, marketplace, language, metric, raw_response, structured_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(observation.observationId, observation.exactString, observation.queryDate, observation.source, observation.provider_method,
        observation.queried_at_utc, observation.toolName, observation.stageQaStatus, observation.recordedAt,
        observation.page_url, observation.page_field_name, JSON.stringify(observation.raw_value), observation.fetched_at_utc,
        observation.raw_dom_evidence_ref, observation.marketplace, observation.language, observation.metric, JSON.stringify(rawResponse), JSON.stringify(structuredResult));
    return observation;
  }

  async findReusableBolooKeyword({ exactString, queriedAtUtc, marketplace = 'BOL_NL', language = 'nl-NL', metric = 'Gemiddeld zoekvolume per maand' }) {
    await this.initialize();
    if (typeof exactString !== 'string' || !exactString.trim()) return null;
    let queryDate;
    try { queryDate = amsterdamBusinessDate(normalizeUtcTimestamp(queriedAtUtc)); }
    catch { return null; }
    const row = this.#db.prepare(`SELECT * FROM boloo_keyword_history
      WHERE exact_string=? AND query_date=? AND marketplace=? AND language=? AND metric=? AND source='BOLOO_OFFICIAL_VERIFIED'
        AND queried_at_utc<>'' AND provider_method IN ('BOLOO_OFFICIAL_MCP', 'BOLOO_OFFICIAL_WEB') AND stage_qa_status='PASS'
      ORDER BY recorded_at DESC LIMIT 1`).get(exactString, queryDate, marketplace, language, metric);
    if (!row) return null;
    try {
      return {
        observationId: row.observation_id, exactString: row.exact_string, queryDate: row.query_date, queried_at_utc: row.queried_at_utc,
        source: row.source, provider_method: row.provider_method, toolName: row.tool_name, stageQaStatus: row.stage_qa_status, recordedAt: row.recorded_at,
        marketplace: row.marketplace, language: row.language, metric: row.metric,
        page_url: row.page_url, page_field_name: row.page_field_name, raw_value: JSON.parse(row.raw_value),
        fetched_at_utc: row.fetched_at_utc, raw_dom_evidence_ref: row.raw_dom_evidence_ref ? JSON.parse(row.raw_dom_evidence_ref) : null,
        rawResponse: JSON.parse(row.raw_response), structuredResult: JSON.parse(row.structured_result), formalReuse: true,
      };
    } catch { return null; }
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }
}

function isValidUtcTimestamp(value) {
  try { normalizeUtcTimestamp(value); return true; }
  catch { return false; }
}
