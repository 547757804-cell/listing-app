import fs from 'node:fs/promises';
import path from 'node:path';
import {
  persistSop09BolApiFacts,
  persistSop09BolEvidenceBundle,
} from '../app/sop09_bol_data_source.mjs';

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function adaptPersistedApiEvidence(item) {
  return {
    createdAt: item.queried_at || null,
    source: item.response_source || null,
    cacheHit: item.cache_hit === true,
    rawResponse: item.raw_response,
    structuredResult: item.structured_result,
    requestId: item.request_id || null,
  };
}

const [dataRootArg, skuArg, sop08VersionArg] = process.argv.slice(2);
const dataRoot = path.resolve(required(dataRootArg, 'dataRoot'));
const sku = required(skuArg, 'sku');
const expectedSop08Version = required(sop08VersionArg, 'sop08Version');
const listingRoot = path.join(dataRoot, 'artifacts', 'listing', sku);
const sop08Path = path.join(listingRoot, 'sop08', `${expectedSop08Version}.json`);
const sop08Artifact = await readJson(sop08Path);
if (sop08Artifact.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION'
  || sop08Artifact.status !== 'PASS' || sop08Artifact.sku !== sku) {
  throw new Error('The exact SOP08 artifact is not a persisted PASS for this SKU.');
}

const sourceRoot = path.join(listingRoot, 'sop09', 'data-sources');
const sourceDirectories = (await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  .map(entry => path.join(sourceRoot, entry.name));
const sop08Pool = Array.isArray(sop08Artifact.main_comparison_pool)
  ? sop08Artifact.main_comparison_pool.map(item => typeof item === 'string' ? item : item?.competitor_id)
  : [];
if (!sop08Pool.length || sop08Pool.some(id => !id)) throw new Error('SOP08 main comparison pool is empty or malformed.');

const evidenceDir = path.join(listingRoot, 'sop08', 'evidence');
const evidenceFiles = (await fs.readdir(evidenceDir, { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
  .map(entry => path.join(evidenceDir, entry.name));
const competitors = [];
const checkedAt = new Date().toISOString();

for (const competitorId of sop08Pool) {
  const candidate = sop08Artifact.candidates?.find(item => item.competitor_id === competitorId);
  if (!candidate || !candidate.bol_product_id || !['A_STRONG_EFFECTIVE', 'B_REFERENCE'].includes(candidate.classification)) {
    throw new Error(`SOP08 candidate identity/classification is not confirmed for ${competitorId}.`);
  }
  const pageMatches = [];
  for (const directory of sourceDirectories) {
    const file = path.join(directory, 'page-facts.json');
    try {
      const facts = await readJson(file);
      if (facts.artifact_type === 'BOL_PAGE_FACTS_VERSION' && facts.sku === sku && facts.competitor_id === competitorId) {
        pageMatches.push({ facts, file, qaFile: path.join(directory, 'qa.json') });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (pageMatches.length !== 1) throw new Error(`Expected exactly one persisted PAGE_FACTS artifact for ${competitorId}; found ${pageMatches.length}.`);
  const { facts: pageFacts, qaFile } = pageMatches[0];
  const pageQa = await readJson(qaFile);
  if (pageQa.status !== 'PASS' || pageFacts.product_id_match !== true
    || pageFacts.requested_product_id !== candidate.bol_product_id
    || pageFacts.canonical_product_id !== candidate.bol_product_id
    || !Array.isArray(pageFacts.dom_evidence_refs) || pageFacts.dom_evidence_refs.length === 0) {
    throw new Error(`PAGE_FACTS identity/evidence QA failed for ${competitorId}.`);
  }

  const apiResult = {};
  for (const [method, key] of [['OFFERS', 'offersResult'], ['RATINGS', 'ratingsResult']]) {
    const matchingFiles = evidenceFiles.filter(file => path.basename(file).startsWith(`${competitorId}-${method}-`));
    const successful = [];
    for (const file of matchingFiles) {
      const record = await readJson(file);
      if (record.sku !== sku || record.competitor_id !== competitorId || record.method !== method
        || String(record.request?.ean || '') !== String(pageFacts.ean_gtin || '')) {
        throw new Error(`Persisted ${method} evidence identity mismatch for ${competitorId}.`);
      }
      if (record.http_status === 200 && record.response_received !== false) successful.push(record);
    }
    if (successful.length > 1) throw new Error(`Multiple successful ${method} records need explicit lineage selection for ${competitorId}.`);
    if (successful.length === 1) apiResult[key] = adaptPersistedApiEvidence(successful[0]);
  }

  const apiPersisted = await persistSop09BolApiFacts({ dataRoot, sku,
    competitor: { competitor_id: competitorId }, pageFacts,
    offersResult: apiResult.offersResult || null,
    ratingsResult: apiResult.ratingsResult || null,
    checkedAt,
  });
  competitors.push({ competitor_id: competitorId, pageFacts, apiFacts: apiPersisted.apiFacts,
    api_artifact_ref: apiPersisted.artifact_ref, page_facts_ref: path.relative(dataRoot, pageMatches[0].file).replace(/\\/g, '/'),
    page_qa: pageQa.status,
    api_methods: { offers: apiPersisted.apiFacts.offers.status, ratings: apiPersisted.apiFacts.ratings.status },
  });
}

const bundleResult = await persistSop09BolEvidenceBundle({ dataRoot, sku, sop08Artifact, competitors });
process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  sku,
  sop08_version: sop08Artifact.version,
  bol_bundle_version: bundleResult.bundle.version,
  artifact_ref: bundleResult.artifact_ref,
  idempotent_reuse: bundleResult.idempotent_reuse,
  page_facts_count: competitors.length,
  api_method_statuses: competitors.map(item => ({ competitor_id: item.competitor_id, ...item.api_methods })),
  external_requests: 0,
}, null, 2)}\n`);
