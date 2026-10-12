import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'why_it_sells_well', 'hot_selling_points', 'final_hot_selling_points', 'pain_points',
  'own_advantages', 'own_parity', 'own_disadvantages', 'competitive_selling_point_matrix',
  'selling_point_matrix', 'keyword_weighting', 'display_weighting',
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function rawOf(field) {
  return field && typeof field === 'object' && Object.hasOwn(field, 'value') ? field.value : field ?? null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function required(value, code, label) {
  if (value == null || String(value).trim() === '') throw Object.assign(new Error(`${label} is required.`), { code });
  return String(value).trim();
}

function sourceValue(field, source, name) {
  return { status: field?.status || 'UNKNOWN', value: clone(rawOf(field)), evidence_ref: clone(field?.evidence_ref ?? null), source, field: name };
}

function fieldStatus(field) {
  return field?.status || 'UNKNOWN';
}

function sourceInput(version, content) {
  return { version, sha256: sha256(content) };
}

async function collectJsonFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(full);
    }
  }
  return files;
}

function safeDataRootFile(dataRoot, relativePath) {
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error('SOP09 input reference escapes the task data root.'), { code: 'SOP09_INPUT_REFERENCE_OUTSIDE_DATA_ROOT' });
  return target;
}

async function readVersionedJson(root, { version, artifactType, filename = null, matches = () => true }) {
  const files = await collectJsonFiles(root);
  const matchesFound = [];
  for (const file of files) {
    if (filename && path.basename(file).toLowerCase() !== filename.toLowerCase()) continue;
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (value?.version === version && value?.artifact_type === artifactType && matches(value)) matchesFound.push({ file, value });
  }
  if (matchesFound.length !== 1) {
    const code = matchesFound.length ? 'SOP09_INPUT_ARTIFACT_AMBIGUOUS' : 'SOP09_INPUT_ARTIFACT_MISSING';
    throw Object.assign(new Error(`${artifactType} ${version} resolution returned ${matchesFound.length} matches.`), { code, artifact_type: artifactType, version, match_count: matchesFound.length });
  }
  return matchesFound[0];
}

/** Resolve only exact, identity-linked, persisted SOP09 inputs from one task data root. */
export async function resolveSop09RuntimeInputs({ dataRoot, task, expectedVersions = {} }) {
  const diskTaskFile = path.join(path.resolve(dataRoot), 'products', `${task?.sku}.json`);
  let diskTask;
  try { diskTask = JSON.parse(await fs.readFile(diskTaskFile, 'utf8')); }
  catch { throw Object.assign(new Error('Current task record is not readable in the selected data root.'), { code: 'SOP09_TASK_RECORD_MISSING' }); }
  if (diskTask.sku !== task.sku || diskTask.revision !== task.revision) throw Object.assign(new Error('Runtime task snapshot does not match the persisted record.'), { code: 'SOP09_TASK_SNAPSHOT_MISMATCH' });

  const taskPool = diskTask.outputs?.listing_competitor_pool;
  const sop08Version = taskPool?.version;
  const requiredVersionLocks = [expectedVersions.sop08Version, expectedVersions.bolBundleVersion,
    expectedVersions.bolPageFactsVersion, expectedVersions.bolApiFactsVersion,
    expectedVersions.amazonBundleVersion, expectedVersions.amazonPageFactsVersion,
    expectedVersions.productFactsVersion];
  if (requiredVersionLocks.some(value => value == null || String(value).trim() === '')) {
    throw Object.assign(new Error('SOP09 runtime requires explicit locked input versions; it will not select the latest matching files.'), { code: 'SOP09_INPUT_VERSION_LOCK_MISSING' });
  }
  if (!sop08Version || taskPool?.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION' || taskPool?.status !== 'PASS') throw Object.assign(new Error('Task record does not point to a passed SOP08 pool.'), { code: 'SOP09_SOP08_TASK_REF_MISSING' });
  if (expectedVersions.sop08Version && expectedVersions.sop08Version !== sop08Version) throw Object.assign(new Error('SOP08 task reference differs from the required version.'), { code: 'SOP09_SOP08_VERSION_MISMATCH' });
  const sop08Ref = taskPool.evidence?.artifact_ref;
  let sop08File;
  let sop08Artifact;
  if (typeof sop08Ref === 'string' && sop08Ref) {
    sop08File = safeDataRootFile(dataRoot, sop08Ref);
    try { sop08Artifact = JSON.parse(await fs.readFile(sop08File, 'utf8')); }
    catch { throw Object.assign(new Error('SOP08 artifact reference from task is not readable.'), { code: 'SOP09_SOP08_ARTIFACT_UNREADABLE', ref: sop08Ref }); }
    if (sop08Artifact.version !== sop08Version || sop08Artifact.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION' || sop08Artifact.status !== 'PASS') throw Object.assign(new Error('Persisted SOP08 artifact does not match the task version/status.'), { code: 'SOP09_SOP08_ARTIFACT_MISMATCH' });
  } else {
    const found = await readVersionedJson(path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop08'), { version: sop08Version, artifactType: 'EFFECTIVE_COMPETITOR_POOL_VERSION' });
    sop08File = found.file; sop08Artifact = found.value;
  }

  const sourceRoot = path.join(dataRoot, 'artifacts', 'listing', task.sku, 'sop09', 'data-sources');
  const bolVersion = expectedVersions.bolBundleVersion || null;
  const amazonVersion = expectedVersions.amazonBundleVersion || null;
  const bolMatches = [];
  const amazonMatches = [];
  for (const file of await collectJsonFiles(sourceRoot)) {
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (value?.artifact_type === 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION'
      && (!bolVersion || value.version === bolVersion)
      && value.SOP08_CONTEXT?.artifact_version === sop08Version
      && value.sku === task.sku
      && isFormalBolEvidenceBundleForPool(value, sop08Artifact)) bolMatches.push({ file, value });
    if (value?.artifact_type === 'AMAZON_EVIDENCE_BUNDLE_VERSION'
      && (!amazonVersion || value.version === amazonVersion)
      && value.sku === task.sku) amazonMatches.push({ file, value });
  }
  if (bolMatches.length !== 1) throw Object.assign(new Error(`Expected one SOP08-linked BOL bundle; found ${bolMatches.length}.`), { code: bolMatches.length ? 'SOP09_BOL_BUNDLE_AMBIGUOUS' : 'SOP09_BOL_BUNDLE_MISSING', match_count: bolMatches.length });
  if (amazonMatches.length !== 1) throw Object.assign(new Error(`Expected one identity-matched Amazon bundle; found ${amazonMatches.length}.`), { code: amazonMatches.length ? 'SOP09_AMAZON_BUNDLE_AMBIGUOUS' : 'SOP09_AMAZON_BUNDLE_MISSING', match_count: amazonMatches.length });
  const bolEvidenceBundle = bolMatches[0].value;
  const amazonEvidenceBundle = amazonMatches[0].value;
  if (expectedVersions.bolBundleVersion && bolEvidenceBundle.version !== expectedVersions.bolBundleVersion) throw Object.assign(new Error('BOL bundle version mismatch.'), { code: 'SOP09_BOL_BUNDLE_VERSION_MISMATCH' });
  if (expectedVersions.amazonBundleVersion && amazonEvidenceBundle.version !== expectedVersions.amazonBundleVersion) throw Object.assign(new Error('Amazon bundle version mismatch.'), { code: 'SOP09_AMAZON_BUNDLE_VERSION_MISMATCH' });

  const productFacts = diskTask.outputs?.confirmed_product_facts;
  if (productFacts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || productFacts.sku !== task.sku
    || productFacts.version == null || (expectedVersions.productFactsVersion != null && String(productFacts.version) !== String(expectedVersions.productFactsVersion))) {
    throw Object.assign(new Error('Current SKU Product Facts are missing or do not match the requested version.'), { code: 'SOP09_FACTS_VERSION_MISMATCH' });
  }
  const bolPageVersion = bolEvidenceBundle.PAGE_FACTS?.version;
  const bolApiVersion = bolEvidenceBundle.BOL_API_FACTS?.version;
  const amazonPageVersion = amazonEvidenceBundle.AMAZON_PAGE_FACTS?.version;
  const linkedArtifact = async (baseFile, reference, version, artifactType, matches = () => true) => {
    const file = safeDataRootFile(dataRoot, path.relative(path.resolve(dataRoot), path.resolve(path.dirname(baseFile), reference)));
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw Object.assign(new Error(`${artifactType} linked reference is not readable.`), { code: 'SOP09_INPUT_ARTIFACT_UNREADABLE', artifact_type: artifactType }); }
    if (value?.version !== version || value?.artifact_type !== artifactType || !matches(value)) {
      throw Object.assign(new Error(`${artifactType} linked reference does not match its locked version/identity.`), { code: 'SOP09_NESTED_SOURCE_VERSION_MISMATCH', artifact_type: artifactType, version });
    }
    return { file, value };
  };
  const bolBundleFile = bolMatches[0].file;
  const amazonBundleFile = amazonMatches[0].file;
  const bolSourceEntries = normalizeBolEvidenceEntries(bolEvidenceBundle);
  const resolvedBolEntries = [];
  for (const entry of bolSourceEntries) {
    const competitorId = String(entry.competitorId || '');
    const pageRef = entry.pageRef;
    const apiRef = entry.apiRef;
    const pageVersion = pageRef?.version || pageFactsOf(pageRef)?.version;
    const apiVersion = apiRef?.version || apiFactsOf(apiRef)?.version;
    if (pageRef?.status !== 'READY' || !pageVersion || !apiVersion) {
      throw Object.assign(new Error(`SOP09 BOL facts lack locked page/API versions for ${competitorId || 'unknown competitor'}.`), { code: 'SOP09_NESTED_SOURCE_VERSION_MISSING', competitor_id: competitorId });
    }
    const pageReference = pageRef.artifact_ref || (bolSourceEntries.length === 1 ? 'page-facts.json' : null);
    const apiReference = apiRef.artifact_ref || (bolSourceEntries.length === 1 ? 'bol-api-facts.json' : null);
    if (!pageReference || !apiReference) throw Object.assign(new Error(`SOP09 BOL facts lack persisted evidence refs for ${competitorId || 'unknown competitor'}.`), { code: 'SOP09_NESTED_SOURCE_REFERENCE_MISSING', competitor_id: competitorId });
    const pageFile = await linkedArtifact(bolBundleFile, pageReference, pageVersion, 'BOL_PAGE_FACTS_VERSION', value => value.sku === task.sku && value.competitor_id === competitorId);
    const apiFile = await linkedArtifact(bolBundleFile, apiReference, apiVersion, 'BOL_API_FACTS_VERSION', value => !value.competitor_id || value.competitor_id === competitorId);
    const page = pageFile.value;
    const api = apiFile.value;
    if (page.competitor_id !== competitorId || page.product_id_match !== true) throw Object.assign(new Error('Persisted BOL page facts do not match their bundle competitor identity.'), { code: 'SOP09_BOL_IDENTITY_MISMATCH', competitor_id: competitorId });
    resolvedBolEntries.push({ competitor_id: competitorId, page, api, pageFile, apiFile });
  }
  const amazonPageFile = await linkedArtifact(amazonBundleFile, amazonEvidenceBundle.AMAZON_PAGE_FACTS.artifact_ref, amazonPageVersion, 'AMAZON_PAGE_FACTS_VERSION', value => value.sku === task.sku);
  if (resolvedBolEntries.length !== bolSourceEntries.length || !resolvedBolEntries.length
    || amazonPageFile.value.version !== amazonEvidenceBundle.AMAZON_PAGE_FACTS.version) throw Object.assign(new Error('Nested source data version mismatch.'), { code: 'SOP09_NESTED_SOURCE_VERSION_MISMATCH' });

  const relative = file => path.relative(path.resolve(dataRoot), file).replace(/\\/g, '/');
  const sourceFileRefs = [
    { source: 'SOP08', reference: relative(sop08File), version: sop08Version },
    { source: 'BOL_COMPETITOR_EVIDENCE_BUNDLE', reference: relative(bolMatches[0].file), version: bolEvidenceBundle.version },
    ...resolvedBolEntries.flatMap(entry => [
      { source: 'BOL_PAGE_FACTS', competitor_id: entry.competitor_id, reference: relative(entry.pageFile.file), version: entry.page.version },
      { source: 'BOL_API_FACTS', competitor_id: entry.competitor_id, reference: relative(entry.apiFile.file), version: entry.api.version },
    ]),
    { source: 'AMAZON_EVIDENCE_BUNDLE', reference: relative(amazonMatches[0].file), version: amazonEvidenceBundle.version },
    { source: 'AMAZON_PAGE_FACTS', reference: relative(amazonPageFile.file), version: amazonPageVersion },
    { source: 'PRODUCT_FACTS_V2_TASK_RECORD', reference: relative(diskTaskFile), version: String(productFacts.version) },
  ];
  for (const item of sourceFileRefs) item.sha256 = sha256(await fs.readFile(safeDataRootFile(dataRoot, item.reference)));
  return { task: diskTask, sop08Artifact, bolEvidenceBundle,
    bolEvidenceBundleForAnalysis: hydrateSop09BolEvidenceBundle(bolEvidenceBundle, resolvedBolEntries),
    bolPageFacts: resolvedBolEntries.map(entry => entry.page), bolApiFacts: resolvedBolEntries.map(entry => entry.api),
    amazonEvidenceBundle, amazonPageFacts: amazonPageFile.value, productFacts, sourceFileRefs };
}

export function getListingSopExecutor(step) {
  return step === 'LISTING_SOP_09' ? LISTING_COMPETITOR_ANALYSIS_EXECUTOR : null;
}

export function expectedSop09RuntimeVersions(task, dataRoot) {
  const refs = task?.listing_executor?.registry?.LISTING_SOP_09?.input_version_refs;
  const byName = Object.fromEntries((Array.isArray(refs) ? refs : []).map(ref => [ref.artifact_type || ref.name, ref.version]));
  // Legacy formal SOP09 artifacts may predate registry input_version_refs.
  // In that case use the current task's own immutable SOP09 input_versions;
  // never use SKU-, dataRoot-, or historical-version constants.
  const recorded = task?.outputs?.competitor_analysis?.input_versions || {};
  const result = {
    sop08Version: byName.EFFECTIVE_COMPETITOR_POOL_VERSION || recorded.sop08_artifact?.version,
    bolBundleVersion: byName.BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION || recorded.bol_evidence_bundle?.version,
    bolPageFactsVersion: byName.BOL_PAGE_FACTS_VERSION || recorded.bol_page_facts?.version,
    bolApiFactsVersion: byName.BOL_API_FACTS_VERSION || recorded.bol_api_facts?.version,
    amazonBundleVersion: byName.AMAZON_EVIDENCE_BUNDLE_VERSION || recorded.amazon_evidence_bundle?.version,
    amazonPageFactsVersion: byName.AMAZON_PAGE_FACTS_VERSION || recorded.amazon_page_facts?.version,
    productFactsVersion: String(byName.CONFIRMED_PRODUCT_FACTS_VERSION || recorded.product_facts?.version || ''),
  };
  if (Object.values(result).some(value => !value)) throw Object.assign(new Error('SOP09 requires explicit input version refs for this task.'), { code: 'SOP09_INPUT_VERSION_LOCK_MISSING' });
  return result;
}

export async function runListingCompetitorAnalysisRuntime({ dataRoot, task, expectedVersions, createdAt }) {
  const versions = expectedVersions || expectedSop09RuntimeVersions(task, dataRoot);
  const inputs = await resolveSop09RuntimeInputs({ dataRoot, task, expectedVersions: versions });
  const artifact = buildListingCompetitorAnalysis({
    sop08Artifact: inputs.sop08Artifact,
    bolEvidenceBundle: inputs.bolEvidenceBundleForAnalysis || inputs.bolEvidenceBundle,
    sourceBolEvidenceBundle: inputs.bolEvidenceBundle,
    amazonEvidenceBundle: inputs.amazonEvidenceBundle,
    productFacts: inputs.productFacts,
    expected: versions,
    createdAt,
  });
  artifact.source_file_refs = inputs.sourceFileRefs;
  const qaInputs = { ...inputs, bolEvidenceBundle: inputs.bolEvidenceBundleForAnalysis || inputs.bolEvidenceBundle };
  const qa = qaListingCompetitorAnalysis({ artifact, inputs: qaInputs });
  artifact.qa_status = qa.status === 'PASS' ? 'PASS' : 'FAIL';
  const outDir = path.join(path.resolve(dataRoot), 'artifacts', 'listing', task.sku, 'sop09', artifact.version);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'analysis.json'), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(outDir, 'qa.json'), `${JSON.stringify(qa, null, 2)}\n`, { flag: 'wx' });
  return {
    artifact, qa, inputs,
    artifact_ref: path.relative(path.resolve(dataRoot), path.join(outDir, 'analysis.json')).replace(/\\/g, '/'),
    qa_ref: path.relative(path.resolve(dataRoot), path.join(outDir, 'qa.json')).replace(/\\/g, '/'),
    external_requests: 0,
  };
}

function assertNoForbiddenOutputs(value, at = 'artifact') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoForbiddenOutputs(item, `${at}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) throw Object.assign(new Error(`SOP09 output contains out-of-scope key: ${at}.${key}`), { code: 'SOP09_SCOPE_BOUNDARY_VIOLATION' });
    assertNoForbiddenOutputs(child, `${at}.${key}`);
  }
}

function sampleText(review) {
  const body = rawOf(review?.body);
  return [rawOf(review?.title), typeof body === 'string' ? body : body?.text].filter(value => typeof value === 'string').join(' ');
}

const SENTIMENT_TERMS = Object.freeze({
  positive: ['schön', 'wunderschön', 'zauberhaft', 'praktisch', 'stabil', 'empfehl', 'great', 'excellent', 'good', 'quality', 'hübsch', 'fest'],
  negative: ['schlecht', 'kaputt', 'enttäusch', 'unbrauchbar', 'mangelhaft', 'broken', 'bad', 'poor', 'disappoint', 'leider'],
});

const OBSERVED_TOPIC_TERMS = Object.freeze({
  appearance_or_design: ['motiv', 'design', 'weihnacht', 'christmas', 'festlich'],
  paper_or_sturdiness: ['papier', 'kraftpapier', 'stabil', 'strength', 'fest'],
  set_or_contents: ['set', 'tüten', 'geschenktüten', 'sticker', 'bags'],
  price_or_value: ['preis', 'value', 'price'],
  size: ['größe', 'size', 'klein', 'small'],
});

function includesTerm(text, term) {
  return new RegExp(`(?:^|[^\\p{L}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\p{L}]*`, 'iu').test(text);
}

function parseObservedReview(review, index, checkedAt, reviewScope = 'UNKNOWN') {
  const text = sampleText(review);
  const positiveMatches = SENTIMENT_TERMS.positive.filter(term => includesTerm(text, term));
  const negativeMatches = SENTIMENT_TERMS.negative.filter(term => includesTerm(text, term));
  const sentiment = positiveMatches.length && negativeMatches.length ? 'MIXED_TERMS_IN_OBSERVED_TEXT'
    : positiveMatches.length ? 'POSITIVE_TERMS_IN_OBSERVED_TEXT'
      : negativeMatches.length ? 'NEGATIVE_TERMS_IN_OBSERVED_TEXT' : 'UNDETERMINED_FROM_CAPTURED_TEXT';
  const themes = Object.entries(OBSERVED_TOPIC_TERMS)
    .filter(([, terms]) => terms.some(term => includesTerm(text, term)))
    .map(([theme, terms]) => ({ theme, matched_terms: terms.filter(term => includesTerm(text, term)) }));
  const dateRaw = rawOf(review?.date);
  const parsedDate = typeof dateRaw === 'string' && Number.isFinite(Date.parse(dateRaw)) ? new Date(dateRaw).toISOString() : null;
  const body = rawOf(review?.body);
  return {
    sample_index: index + 1,
    review_scope: reviewScope,
    title: sourceValue(review?.title, 'AMAZON_PAGE_FACTS', 'inline_reviews.title'),
    body: sourceValue(review?.body, 'AMAZON_PAGE_FACTS', 'inline_reviews.body'),
    date: { ...sourceValue(review?.date, 'AMAZON_PAGE_FACTS', 'inline_reviews.date'), parsed_iso: parsedDate },
    rating: sourceValue(review?.rating, 'AMAZON_PAGE_FACTS', 'inline_reviews.rating'),
    text_tendency: {
      result: sentiment,
      observed_positive_terms: positiveMatches,
      observed_negative_terms: negativeMatches,
      method: 'TRANSPARENT_LEXICON_MATCH_ON_CAPTURED_TITLE_AND_BODY_SNIPPET',
      limitation: body && typeof body === 'object' && body.truncated_by_bridge === true ? 'BODY_SNIPPET_TRUNCATED' : 'SAMPLE_ONLY_NOT_POPULATION_INFERENCE',
    },
    observed_topics: themes,
    recency: {
      checked_at: checkedAt,
      days_before_check: parsedDate ? Math.max(0, Math.floor((Date.parse(checkedAt) - Date.parse(parsedDate)) / 86400000)) : null,
      interpretation: 'DATE_DISTANCE_ONLY_NO_RECENCY_THRESHOLD_APPLIED',
    },
  };
}

function normalizeBolEvidenceEntries(bundle) {
  if (Array.isArray(bundle?.competitors)) {
    return bundle.competitors.map(entry => ({
      competitorId: entry?.competitor_id,
      pageRef: entry?.PAGE_FACTS || entry?.page_facts,
      apiRef: entry?.BOL_API_FACTS || entry?.api_facts,
      sop08Context: entry?.SOP08_CONTEXT || entry?.sop08_context,
    }));
  }
  return [{
    competitorId: bundle?.competitor_id,
    pageRef: bundle?.PAGE_FACTS,
    apiRef: bundle?.BOL_API_FACTS,
    sop08Context: bundle?.SOP08_CONTEXT,
  }];
}

/** Distinguish a pool-level bundle from per-competitor siblings in the same source tree. */
export function isFormalBolEvidenceBundleForPool(bundle, sop08Artifact) {
  const ids = (Array.isArray(sop08Artifact?.main_comparison_pool) ? sop08Artifact.main_comparison_pool : [])
    .map(item => typeof item === 'string' ? item : item?.competitor_id).filter(Boolean);
  if (!ids.length || bundle?.artifact_type !== 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION'
    || bundle?.sku !== sop08Artifact?.sku || bundle?.SOP08_CONTEXT?.artifact_version !== sop08Artifact?.version) return false;
  const entries = Array.isArray(bundle.competitors) ? bundle.competitors : null;
  if (!entries) return ids.length === 1 && bundle.competitor_id === ids[0];
  const bundledIds = entries.map(item => item?.competitor_id).filter(Boolean);
  return bundledIds.length === ids.length && new Set(bundledIds).size === bundledIds.length
    && ids.every(id => bundledIds.includes(id));
}

/** Add resolved immutable facts to an in-memory view; persisted source bundles stay reference-only. */
export function hydrateSop09BolEvidenceBundle(bundle, resolvedEntries) {
  const sourceEntries = Array.isArray(bundle?.competitors) ? bundle.competitors : null;
  if (sourceEntries) {
    if (!Array.isArray(resolvedEntries) || sourceEntries.length !== resolvedEntries.length) {
      throw Object.assign(new Error('Resolved BOL evidence cardinality does not match the persisted bundle.'), { code: 'SOP09_BOL_HYDRATION_CARDINALITY_MISMATCH' });
    }
    return {
      ...bundle,
      competitors: sourceEntries.map((entry, index) => ({
        ...entry,
        PAGE_FACTS: { ...(entry.PAGE_FACTS || entry.page_facts || {}), page_facts: resolvedEntries[index].page },
        BOL_API_FACTS: { ...(entry.BOL_API_FACTS || entry.api_facts || {}), api_facts: resolvedEntries[index].api },
      })),
    };
  }
  if (resolvedEntries?.length !== 1) throw Object.assign(new Error('Single-competitor BOL bundle requires exactly one resolved evidence row.'), { code: 'SOP09_BOL_HYDRATION_CARDINALITY_MISMATCH' });
  return {
    ...bundle,
    PAGE_FACTS: { ...(bundle.PAGE_FACTS || {}), page_facts: resolvedEntries[0].page },
    BOL_API_FACTS: { ...(bundle.BOL_API_FACTS || {}), api_facts: resolvedEntries[0].api },
  };
}

function pageFactsOf(ref) { return ref?.page_facts || ref?.facts || ref || null; }
function apiFactsOf(ref) { return ref?.api_facts || ref?.facts || ref || null; }

function layerVersion(bundle, layer, entries) {
  const explicit = bundle?.[layer]?.version;
  if (explicit != null && String(explicit).trim()) return String(explicit);
  const versions = entries.map(entry => layer === 'PAGE_FACTS' ? entry.page.version : entry.api.version);
  if (versions.length === 1) return String(versions[0]);
  return `${layer === 'PAGE_FACTS' ? 'BOL_PAGE_FACTS_SET' : 'BOL_API_FACTS_SET'}-${sha256(versions.map((version, index) => ({ competitor_id: entries[index].candidate.competitor_id, version }))).slice(0, 20)}`;
}

function validateInputs({ sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle, productFacts, expected }) {
  if (sop08Artifact?.artifact_type !== 'EFFECTIVE_COMPETITOR_POOL_VERSION' || sop08Artifact.status !== 'PASS') {
    throw Object.assign(new Error('SOP08 passed artifact is required.'), { code: 'SOP09_SOP08_INPUT_INVALID' });
  }
  if (expected?.sop08Version && sop08Artifact.version !== expected.sop08Version) throw Object.assign(new Error('SOP08 version mismatch.'), { code: 'SOP09_SOP08_VERSION_MISMATCH' });
  const sku = required(sop08Artifact.sku, 'SOP09_SKU_MISSING', 'SOP08 SKU');
  if (productFacts?.artifact_type !== 'CONFIRMED_PRODUCT_FACTS_VERSION' || productFacts.version == null || productFacts.sku !== sku) {
    throw Object.assign(new Error('Versioned Product Facts for the same SKU are required.'), { code: 'SOP09_FACTS_INVALID' });
  }
  if (bolEvidenceBundle?.artifact_type !== 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION' || bolEvidenceBundle.sku !== sku) {
    throw Object.assign(new Error('Versioned BOL competitor evidence bundle is required.'), { code: 'SOP09_BOL_BUNDLE_INVALID' });
  }
  if (expected?.bolBundleVersion && bolEvidenceBundle.version !== expected.bolBundleVersion) throw Object.assign(new Error('BOL evidence bundle version mismatch.'), { code: 'SOP09_BOL_BUNDLE_VERSION_MISMATCH' });
  if (amazonEvidenceBundle?.artifact_type !== 'AMAZON_EVIDENCE_BUNDLE_VERSION' || amazonEvidenceBundle.sku !== sku) {
    throw Object.assign(new Error('Versioned Amazon evidence bundle is required.'), { code: 'SOP09_AMAZON_BUNDLE_INVALID' });
  }
  if (expected?.amazonBundleVersion && amazonEvidenceBundle.version !== expected.amazonBundleVersion) throw Object.assign(new Error('Amazon evidence bundle version mismatch.'), { code: 'SOP09_AMAZON_BUNDLE_VERSION_MISMATCH' });
  const formalPool = Array.isArray(sop08Artifact.main_comparison_pool) ? sop08Artifact.main_comparison_pool : [];
  const expectedLowConfidence = sop08Artifact.low_competitor_pool_confidence === true || sop08Artifact.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE';
  if (!formalPool.length) throw Object.assign(new Error('SOP08 formal comparison pool is empty.'), { code: 'SOP09_COMPETITOR_BUNDLE_CARDINALITY_INVALID', count: 0 });
  const formalIds = formalPool.map(item => typeof item === 'string' ? item : item?.competitor_id);
  const evidenceEntries = normalizeBolEvidenceEntries(bolEvidenceBundle);
  const seen = new Set();
  const bolCompetitors = evidenceEntries.map(entry => {
    const candidateId = String(entry.competitorId || '');
    if (!candidateId || seen.has(candidateId)) throw Object.assign(new Error('BOL evidence bundle contains a missing or duplicate competitor identity.'), { code: 'SOP09_BOL_COMPETITOR_IDENTITY_DUPLICATE' });
    seen.add(candidateId);
    if (!formalIds.includes(candidateId)) throw Object.assign(new Error('BOL evidence bundle contains a competitor outside the SOP08 formal pool.'), { code: 'SOP09_BOL_COMPETITOR_NOT_IN_POOL', competitor_id: candidateId });
    const candidate = sop08Artifact.candidates?.find(row => row.competitor_id === candidateId);
    const pageRef = entry.pageRef;
    const apiRef = entry.apiRef;
    const page = pageFactsOf(pageRef);
    const api = apiFactsOf(apiRef);
    const sop08Context = entry.sop08Context;
    if (!candidate || !['A_STRONG_EFFECTIVE', 'B_REFERENCE'].includes(candidate.classification)) throw Object.assign(new Error('Formal competitor does not meet an eligible comparison classification.'), { code: 'SOP09_BOL_COMPETITOR_CONTEXT_INVALID', competitor_id: candidateId });
    if (pageRef?.status !== 'READY' || page?.artifact_type !== 'BOL_PAGE_FACTS_VERSION') throw Object.assign(new Error('BOL PAGE_FACTS is not ready.'), { code: 'SOP09_BOL_PAGE_FACTS_MISSING', competitor_id: candidateId });
    const canonicalUrl = rawOf(page.canonical_url ?? page.fields?.canonical_url);
    const canonicalProductPath = canonicalUrl && String(canonicalUrl).match(new RegExp(`/${String(candidate.bol_product_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`));
    if (page.sku !== sku) throw Object.assign(new Error('BOL PAGE_FACTS belong to a different SKU.'), { code: 'SOP09_BOL_SKU_MISMATCH', competitor_id: candidateId });
    if (page.competitor_id !== candidateId || page.canonical_product_id !== candidate.bol_product_id || page.product_id_match !== true || !canonicalProductPath) {
      throw Object.assign(new Error('BOL evidence identity does not match the SOP08 competitor.'), { code: 'SOP09_BOL_IDENTITY_MISMATCH', competitor_id: candidateId });
    }
    if (api?.artifact_type !== 'BOL_API_FACTS_VERSION') throw Object.assign(new Error('BOL API facts version is missing.'), { code: 'SOP09_BOL_API_FACTS_MISSING', competitor_id: candidateId });
    const pageEan = rawOf(page.ean_gtin);
    if (api.ean_gtin != null && pageEan != null && String(api.ean_gtin) !== String(pageEan)) {
      throw Object.assign(new Error('BOL API identity EAN differs from page identity EAN.'), { code: 'SOP09_BOL_EAN_MISMATCH', competitor_id: candidateId });
    }
    if (sop08Context?.artifact_version !== sop08Artifact.version || sop08Context?.classification !== candidate.classification
      || Boolean(sop08Context?.low_competitor_pool_confidence) !== expectedLowConfidence) {
      throw Object.assign(new Error('BOL bundle SOP08 context does not match the formal pool.'), { code: 'SOP09_BOL_SOP08_CONTEXT_MISMATCH', competitor_id: candidateId });
    }
    return { candidate, page, api, sop08Context, pageRef, apiRef };
  });
  if (seen.size !== formalIds.length || formalIds.some(id => !seen.has(id))) {
    throw Object.assign(new Error('BOL evidence bundle must cover every SOP08 formal pool member exactly once.'), { code: 'SOP09_BOL_COMPETITOR_COVERAGE_INCOMPLETE', expected: formalIds.length, actual: seen.size });
  }
  if (expected?.bolPageFactsVersion && String(layerVersion(bolEvidenceBundle, 'PAGE_FACTS', bolCompetitors)) !== String(expected.bolPageFactsVersion)) throw Object.assign(new Error('BOL PAGE_FACTS version mismatch.'), { code: 'SOP09_BOL_PAGE_FACTS_VERSION_MISMATCH' });
  if (expected?.bolApiFactsVersion && String(layerVersion(bolEvidenceBundle, 'BOL_API_FACTS', bolCompetitors)) !== String(expected.bolApiFactsVersion)) throw Object.assign(new Error('BOL API facts version mismatch.'), { code: 'SOP09_BOL_API_FACTS_VERSION_MISMATCH' });
  const amazonFacts = amazonEvidenceBundle.AMAZON_PAGE_FACTS?.page_facts;
  if (amazonEvidenceBundle.AMAZON_PAGE_FACTS?.status !== 'READY' || amazonFacts?.artifact_type !== 'AMAZON_PAGE_FACTS_VERSION') throw Object.assign(new Error('Amazon page facts are not ready.'), { code: 'SOP09_AMAZON_PAGE_FACTS_MISSING' });
  if (expected?.amazonPageFactsVersion && amazonFacts.version !== expected.amazonPageFactsVersion) throw Object.assign(new Error('Amazon PAGE_FACTS version mismatch.'), { code: 'SOP09_AMAZON_PAGE_FACTS_VERSION_MISMATCH' });
  const identity = amazonFacts.identity;
  const requestedAsin = rawOf(identity?.requested_asin), canonicalAsin = rawOf(identity?.canonical_asin);
  const canonicalUrl = rawOf(identity?.canonical_url);
  if (!rawOf(identity?.marketplace) || !requestedAsin || canonicalAsin !== requestedAsin || rawOf(identity?.asin_match) !== true
    || (canonicalUrl && !String(canonicalUrl).toUpperCase().includes(String(canonicalAsin).toUpperCase()))) {
    throw Object.assign(new Error('Amazon identity context failed.'), { code: 'SOP09_AMAZON_IDENTITY_MISMATCH' });
  }
  if (!['LOCAL_SOURCE_AVAILABLE', 'PASS'].includes(amazonEvidenceBundle.SOP03_AMAZON_CONTEXT?.status)) throw Object.assign(new Error('SOP03 Amazon context must remain separately available.'), { code: 'SOP09_SOP03_AMAZON_CONTEXT_MISSING' });
  const sop09Context = amazonEvidenceBundle.SOP09_CONTEXT || {};
  if (expected?.productFactsVersion && String(productFacts.version) !== String(expected.productFactsVersion)) throw Object.assign(new Error('Product Facts version mismatch.'), { code: 'SOP09_FACTS_VERSION_MISMATCH' });
  return { sku, bolCompetitors, amazonFacts, sop03AmazonContext: amazonEvidenceBundle.SOP03_AMAZON_CONTEXT, sop09AmazonContext: sop09Context };
}

function buildBolAnalysis({ candidate, page, api, sop08Context }) {
  const fields = page.fields || {};
  const mapPage = (...keys) => Object.fromEntries(keys.map(key => [key, sourceValue(fields[key], 'PAGE_FACTS', key)]));
  const noReviews = page.reviews_status === 'NO_REVIEWS';
  const offer = api.offers || {};
  const ratings = api.ratings || {};
  const unavailableFields = [];
  for (const [name, status] of Object.entries({
    latest_review_date: noReviews ? 'NOT_APPLICABLE' : (fields.reviews?.pagination_status || 'UNKNOWN'),
    review_text_items: noReviews ? 'NOT_APPLICABLE' : (fields.reviews?.reviews_status || 'UNKNOWN'),
    verified_sales_volume: 'NOT_AVAILABLE',
    verified_recent_sales_trend: 'NOT_AVAILABLE',
  })) if (status === 'NOT_AVAILABLE' || status === 'UNKNOWN' || status === 'NOT_APPLICABLE') unavailableFields.push({ field: name, status, evidence_ref: 'PAGE_FACTS/BOL_API_FACTS semantics' });

  return {
    competitor_id: candidate.competitor_id,
    product_id: page.canonical_product_id,
    ean_gtin: sourceValue(fields.ean_gtin, 'PAGE_FACTS', 'ean_gtin'),
    canonical_url: sourceValue(fields.canonical_url, 'PAGE_FACTS', 'canonical_url'),
    classification: candidate.classification,
    title: sourceValue(fields.title, 'PAGE_FACTS', 'title'),
    images: mapPage('main_image', 'image_list'),
    description: sourceValue(fields.description, 'PAGE_FACTS', 'description'),
    specifications: sourceValue(fields.specifications, 'PAGE_FACTS', 'specifications'),
    package_or_set_content: sourceValue(fields.package_or_set_content, 'PAGE_FACTS', 'package_or_set_content'),
    page_offer: {
      current_price: sourceValue(fields.current_price, 'PAGE_FACTS', 'current_price'),
      current_offer: sourceValue(fields.current_offer, 'PAGE_FACTS', 'current_offer'),
      seller: sourceValue(fields.seller, 'PAGE_FACTS', 'seller'),
      seller_rating: sourceValue(fields.seller_rating, 'PAGE_FACTS', 'seller_rating'),
      fulfilment: sourceValue(fields.fulfilment, 'PAGE_FACTS', 'fulfilment'),
      delivery_text: sourceValue(fields.delivery_text, 'PAGE_FACTS', 'delivery_text'),
    },
    api_offer: {
      status: offer.status || 'UNKNOWN',
      country_code: offer.country_code || null,
      checked_at: offer.checked_at || null,
      temporal_relation_to_page_facts: offer.temporal_relation_to_page_facts || 'TIME_UNKNOWN',
      usable_as_current: offer.usable_as_current === true,
      http_status: offer.http_status ?? null,
      offer_count: offer.offer_count ?? null,
      current_offers: clone(offer.current_offers || []),
      availability_status: offer.availability_status || 'UNKNOWN',
      evidence_refs: clone(offer.evidence_refs || []),
      request_ref: offer.request_ref || null,
    },
    api_ratings: {
      status: ratings.status || 'UNKNOWN',
      checked_at: ratings.checked_at || null,
      temporal_relation_to_page_facts: ratings.temporal_relation_to_page_facts || 'TIME_UNKNOWN',
      usable_as_current: ratings.usable_as_current === true,
      rating_distribution: clone(ratings.rating_distribution || []),
      rating_count: ratings.rating_count ?? null,
      overall_rating: ratings.overall_rating || 'UNKNOWN',
      review_content: ratings.review_content || 'NOT_PROVIDED_BY_RATINGS_ENDPOINT',
      evidence_refs: clone(ratings.evidence_refs || []),
      request_ref: ratings.request_ref || null,
    },
    reviews: {
      reviews_status: page.reviews_status,
      rating: noReviews ? { status: 'NOT_PRESENT', value: null, evidence_ref: fields.rating?.evidence_ref || null } : sourceValue(fields.rating, 'PAGE_FACTS', 'rating'),
      review_count: noReviews ? { status: 'NOT_PRESENT', value: null, evidence_ref: fields.review_count?.evidence_ref || null } : sourceValue(fields.review_count, 'PAGE_FACTS', 'review_count'),
      items: noReviews ? [] : clone(page.reviews?.items || []),
      pagination_status: page.reviews?.pagination_status || (noReviews ? 'NOT_APPLICABLE' : 'UNKNOWN'),
    },
    evidence_refs: {
      page_facts_version: page.version,
      page_dom: clone(page.dom_evidence_refs || []),
      api_bundle_version: api.version,
      offers: clone(offer.evidence_refs || []),
      ratings: clone(ratings.evidence_refs || []),
      sop08_artifact: sop08Context.artifact_version,
    },
    unavailable_fields: unavailableFields,
  };
}

function bolSourceDifferences(page, api) {
  const differences = [];
  const pagePrice = Number(rawOf(page.fields?.current_price));
  const apiPrices = (api.offers?.current_offers || []).map(offer => Number(offer.price)).filter(Number.isFinite);
  if (Number.isFinite(pagePrice) && apiPrices.length && !apiPrices.some(price => price === pagePrice)) {
    differences.push({ field: 'current_price', status: 'SOURCE_DIFFERENCE', PAGE_FACTS: pagePrice, BOL_API_FACTS: apiPrices, auto_resolved: false });
  }
  const pageReviewCount = rawOf(page.fields?.review_count);
  const apiRatingCount = api.ratings?.rating_count;
  if (page.reviews_status === 'NO_REVIEWS' && Number.isFinite(apiRatingCount) && apiRatingCount > 0) {
    differences.push({ field: 'review_presence', status: 'SOURCE_DIFFERENCE', PAGE_FACTS: 'NO_REVIEWS', BOL_API_FACTS: { rating_count: apiRatingCount }, auto_resolved: false, note: 'Rating count is not review text count.' });
  } else if (pageReviewCount != null && Number.isFinite(apiRatingCount) && Number(pageReviewCount) !== apiRatingCount) {
    differences.push({ field: 'review_count_vs_rating_count', status: 'SOURCE_DIFFERENCE', PAGE_FACTS: pageReviewCount, BOL_API_FACTS: apiRatingCount, auto_resolved: false, note: 'The fields retain their native source semantics.' });
  }
  return differences;
}

function buildAmazonAnalysis(facts, sop03Context, sop09Context) {
  const checkedAt = facts.checked_at;
  const reviews = facts.inline_reviews?.items || [];
  const reviewScope = facts.inline_reviews?.review_scope || facts.inline_reviews?.status || 'UNKNOWN';
  const partialReviewSource = facts.inline_reviews?.status === 'AVAILABLE_PARTIAL' || ['INLINE_SAMPLE', 'INLINE_SAMPLE_ONLY'].includes(reviewScope);
  const analyses = reviews.map((review, index) => parseObservedReview(review, index, checkedAt, reviewScope));
  const themeCounts = new Map();
  for (const review of analyses) for (const theme of review.observed_topics) themeCounts.set(theme.theme, (themeCounts.get(theme.theme) || 0) + 1);
  const packageContents = facts.package_contents;
  const pagination = rawOf(facts.review_pagination);
  const ratingCount = rawOf(facts.ratings_summary?.rating_count);
  const sellerOffer = facts.seller_offer || {};
  const delivery = facts.delivery_context || {};
  return {
    identity: clone(facts.identity),
    title: clone(facts.product_content?.title),
    bullet_points: clone(facts.product_content?.bullet_points),
    description: clone(facts.product_content?.description),
    images: clone(facts.images),
    specifications: clone(facts.specifications),
    package_contents: {
      source: clone(packageContents),
      conflict_status: packageContents.conflict_status || 'UNKNOWN',
      auto_resolved: packageContents.auto_resolved === true,
    },
    ratings_summary: {
      rating: clone(facts.ratings_summary?.rating),
      rating_count: clone(facts.ratings_summary?.rating_count),
      review_count: { status: 'NOT_CONFIRMED', value: null, note: 'rating_count is not text review_count.' },
    },
    inline_reviews: {
      status: facts.inline_reviews?.status || 'UNKNOWN',
      review_scope: facts.inline_reviews?.review_scope || 'UNKNOWN',
      sample_count: reviews.length,
      items: analyses,
      pagination_status: pagination?.status || 'UNKNOWN',
      theme_frequency_scope: partialReviewSource ? 'WITHIN_OBSERVED_SAMPLE' : 'WITHIN_CAPTURED_REVIEWS',
      observed_theme_sample_counts: Object.fromEntries(themeCounts),
      complete_review_set_claimed: facts.inline_reviews?.complete_review_set_claimed === true,
      note: partialReviewSource ? 'Records are a partial sample; snippets flagged truncated remain partial. Counts do not estimate all reviews.'
        : 'Theme counts describe only the records actually present in this source; no unseen records are inferred.',
    },
    seller_offer: clone(sellerOffer),
    delivery_context: {
      destination: clone(delivery.destination_country),
      currency: clone(delivery.displayed_currency),
      displayed_price: clone(delivery.displayed_price),
      delivery: clone(delivery.delivery),
      usable_for_amazon_de_local_price_comparison: delivery.usable_for_amazon_de_local_price_comparison === true,
    },
    sop03_amazon_context: clone(sop03Context),
    sop09_context: clone(sop09Context),
    evidence_refs: {
      amazon_page_facts_version: facts.version,
      source_probe_ref: clone(facts.source_probe_ref || null),
      sop03_context_ref: clone(facts.sop03_context_ref || null),
      network_evidence: clone(facts.network_evidence || []),
    },
    unavailable_fields: [
      { field: 'full_review_population', status: pagination?.status === 'BLOCKED_LOGIN_REQUIRED' ? 'BLOCKED_LOGIN_REQUIRED' : 'NOT_CONFIRMED' },
      { field: 'amazon_de_local_price_comparison', status: delivery.usable_for_amazon_de_local_price_comparison === false ? 'NOT_USABLE_SOURCE_PRICE_CONTEXT' : 'UNKNOWN' },
      { field: 'text_review_count', status: 'NOT_CONFIRMED', rating_count: ratingCount },
    ],
  };
}

export function buildListingCompetitorAnalysis(input) {
  const context = validateInputs(input);
  const { sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle, productFacts } = input;
  const sourceBolEvidenceBundle = input.sourceBolEvidenceBundle || bolEvidenceBundle;
  const amazonFacts = context.amazonFacts;
  const bolPageFactsVersion = layerVersion(bolEvidenceBundle, 'PAGE_FACTS', context.bolCompetitors);
  const bolApiFactsVersion = layerVersion(bolEvidenceBundle, 'BOL_API_FACTS', context.bolCompetitors);
  const pageFactsSet = context.bolCompetitors.map(({ candidate, page }) => ({ competitor_id: candidate.competitor_id, version: page.version, sha256: sha256(page) }));
  const apiFactsSet = context.bolCompetitors.map(({ candidate, api }) => ({ competitor_id: candidate.competitor_id, version: api.version, sha256: sha256(api) }));
  const bolAnalyses = context.bolCompetitors.map(entry => buildBolAnalysis(entry));
  const sourceCapture = {
    sop08: sourceInput(sop08Artifact.version, sop08Artifact),
    bolBundle: sourceInput(sourceBolEvidenceBundle.version, sourceBolEvidenceBundle),
    bolPageFacts: sourceInput(bolPageFactsVersion, pageFactsSet),
    bolApiFacts: sourceInput(bolApiFactsVersion, apiFactsSet),
    amazonBundle: sourceInput(amazonEvidenceBundle.version, amazonEvidenceBundle),
    amazonPageFacts: sourceInput(amazonFacts.version, amazonFacts),
    productFacts: sourceInput(`CONFIRMED_PRODUCT_FACTS_VERSION=${productFacts.version}`, productFacts),
  };
  const amazonAnalysis = buildAmazonAnalysis(amazonFacts, context.sop03AmazonContext, context.sop09AmazonContext);
  const lowConfidence = context.bolCompetitors[0]?.sop08Context?.low_competitor_pool_confidence === true;
  const classifications = context.bolCompetitors.map(({ candidate }) => ({ competitor_id: candidate.competitor_id, classification: candidate.classification }));
  const body = {
    schema_version: 1,
    artifact_type: 'LISTING_COMPETITOR_ANALYSIS_VERSION',
    sku: context.sku,
    created_at: input.createdAt || new Date().toISOString(),
    input_versions: {
      sop08_artifact: { version: sop08Artifact.version, sha256: sourceCapture.sop08.sha256 },
      bol_evidence_bundle: { version: sourceBolEvidenceBundle.version, sha256: sourceCapture.bolBundle.sha256 },
      bol_page_facts: { version: bolPageFactsVersion, sha256: sourceCapture.bolPageFacts.sha256, competitor_versions: pageFactsSet },
      bol_api_facts: { version: bolApiFactsVersion, sha256: sourceCapture.bolApiFacts.sha256, competitor_versions: apiFactsSet },
      amazon_evidence_bundle: { version: amazonEvidenceBundle.version, sha256: sourceCapture.amazonBundle.sha256 },
      amazon_page_facts: { version: amazonFacts.version, sha256: sourceCapture.amazonPageFacts.sha256 },
      product_facts: { version: String(productFacts.version), sha256: sourceCapture.productFacts.sha256, usage: 'SAFETY_REFERENCE_ONLY_NO_COMPETITOR_FACT_INHERITANCE' },
    },
    sop08_context: {
      artifact: sop08Artifact.version,
      formal_pool_ids: clone(sop08Artifact.main_comparison_pool),
      competitor_classifications: classifications,
      analyzed_competitor_classification: classifications.length === 1 ? classifications[0].classification : null,
      low_competitor_pool_confidence: lowConfidence,
      confidence_reason: sop08Artifact.confidence_reason || null,
      influence_boundary: lowConfidence ? 'LIMITED_BY_CURRENT_LOW_POOL_CONFIDENCE'
        : classifications.some(item => item.classification === 'B_REFERENCE') ? 'B_REFERENCE_LIMITED_REFERENCE_ONLY'
          : 'NORMAL_CURRENT_POOL_CONTEXT',
    },
    bol_competitor_analysis: bolAnalyses,
    amazon_reference_analysis: amazonAnalysis,
    review_analysis: {
      amazon_scope: amazonAnalysis.inline_reviews.review_scope === 'INLINE_SAMPLE' ? 'INLINE_SAMPLE_ONLY' : amazonAnalysis.inline_reviews.review_scope,
      sample_count: amazonAnalysis.inline_reviews.sample_count,
      pagination_status: amazonAnalysis.inline_reviews.pagination_status,
      frequency_scope: ['INLINE_SAMPLE', 'INLINE_SAMPLE_ONLY'].includes(amazonAnalysis.inline_reviews.review_scope) ? 'WITHIN_OBSERVED_SAMPLE' : amazonAnalysis.inline_reviews.theme_frequency_scope,
      sample_items: amazonAnalysis.inline_reviews.items,
      observed_theme_sample_counts: amazonAnalysis.inline_reviews.observed_theme_sample_counts,
      no_population_frequency_claim: true,
      bol_competitors: bolAnalyses.map(item => ({ competitor_id: item.competitor_id, reviews_status: item.reviews.reviews_status, items: item.reviews.items, pagination_status: item.reviews.pagination_status })),
      ...(bolAnalyses.length === 1 ? { bol_reviews_status: bolAnalyses[0].reviews.reviews_status, bol_reviews_items: bolAnalyses[0].reviews.items } : {}),
    },
    evidence_refs: {
      sop08_artifact: sop08Artifact.version,
      bol_bundle: bolEvidenceBundle.version,
      bol_page_facts: bolPageFactsVersion,
      bol_api_facts: bolApiFactsVersion,
      amazon_bundle: amazonEvidenceBundle.version,
      amazon_page_facts: amazonFacts.version,
      sop03_amazon_context: clone(context.sop03AmazonContext),
    },
    source_completeness: {
      bol_page_facts: 'CONSUMED_VERSION_LOCKED',
      bol_api_facts: 'CONSUMED_VERSION_LOCKED',
      amazon_page_facts: 'CONSUMED_VERSION_LOCKED',
      sop03_amazon_context: 'PRESERVED_SEPARATELY',
      product_facts: 'VERSION_LOCKED_SAFETY_REFERENCE_ONLY',
      amazon_inline_reviews: amazonAnalysis.inline_reviews.status,
      amazon_review_population: amazonAnalysis.inline_reviews.pagination_status,
    },
    source_conflicts: [
      ...context.bolCompetitors.flatMap(({ candidate, page, api }) => [
        ...(api.source_differences || []).map(item => ({ source: 'BOL_PAGE_FACTS_VS_BOL_API_FACTS', competitor_id: candidate.competitor_id, ...clone(item) })),
        ...bolSourceDifferences(page, api).map(item => ({ source: 'BOL_PAGE_FACTS_VS_BOL_API_FACTS', competitor_id: candidate.competitor_id, ...item })),
      ]),
      ...(amazonAnalysis.package_contents.conflict_status === 'SOURCE_CONFLICT_WITHIN_PAGE' ? [{ source: 'AMAZON_PAGE_FACTS', status: 'SOURCE_CONFLICT_WITHIN_PAGE', evidence_ref: amazonFacts.package_contents.evidence_ref, auto_resolved: false }] : []),
      ...(rawOf(amazonAnalysis.delivery_context.displayed_price)?.usable_for_amazon_de_local_price_comparison === false ? [{ source: 'AMAZON_PAGE_FACTS', status: 'SOURCE_CONTEXT_DIFFERENCE', reason: 'The captured source price context is not usable for the target local-market comparison.' }] : []),
    ],
    unavailable_fields: [
      ...bolAnalyses.flatMap(row => row.unavailable_fields.map(item => ({ source: 'BOL', competitor_id: row.competitor_id, ...item }))),
      ...amazonAnalysis.unavailable_fields.map(row => ({ source: 'AMAZON', ...row })),
    ],
    analysis_confidence: {
      status: lowConfidence ? 'LOW_COMPETITOR_POOL_CONFIDENCE_INHERITED' : 'CURRENT_POOL_CONFIDENCE_INHERITED',
      reasons: lowConfidence ? ['继承当前SOP08有效竞品池的低置信边界。'] : [],
      restriction: 'No definitive sales-success, hot-point, own-versus-competitor, matrix, or weighting conclusion is produced at SOP09.',
    },
    scope_guard: { sop10_through_sop13_executed: false, prohibited_business_conclusions_emitted: false },
    qa_status: 'NOT_RUN',
  };
  body.version = `LISTING_COMPETITOR_ANALYSIS-${sha256(body).slice(0, 20)}`;
  assertNoForbiddenOutputs(body);
  return body;
}

export function qaListingCompetitorAnalysis({ artifact, inputs }) {
  const checks = [];
  const check = (code, pass, message, applicable = true) => checks.push({ code, pass: !applicable || Boolean(pass), status: applicable ? (pass ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE', message });
  const { sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle, productFacts } = inputs;
  const bols = Array.isArray(artifact?.bol_competitor_analysis) ? artifact.bol_competitor_analysis : [];
  const amazon = artifact?.amazon_reference_analysis;
  const formalIds = (sop08Artifact?.main_comparison_pool || []).map(item => typeof item === 'string' ? item : item?.competitor_id).filter(Boolean);
  const bolEvidenceEntries = normalizeBolEvidenceEntries(bolEvidenceBundle).map(entry => {
    const pageRef = entry.pageRef;
    const apiRef = entry.apiRef;
    return {
      competitor_id: entry.competitorId,
      page: pageFactsOf(pageRef),
      api: apiFactsOf(apiRef),
      page_status: pageRef?.status,
    };
  });
  const pageVersionById = new Map(bolEvidenceEntries.map(item => [item.competitor_id, item.page?.version]));
  const apiVersionById = new Map(bolEvidenceEntries.map(item => [item.competitor_id, item.api?.version]));
  const versionEntries = bolEvidenceEntries.map(item => ({
    candidate: sop08Artifact?.candidates?.find(candidate => candidate.competitor_id === item.competitor_id),
    page: item.page,
    api: item.api,
  }));
  const bolPageVersion = layerVersion(bolEvidenceBundle, 'PAGE_FACTS', versionEntries);
  const bolApiVersion = layerVersion(bolEvidenceBundle, 'BOL_API_FACTS', versionEntries);
  const sop08Low = sop08Artifact?.low_competitor_pool_confidence === true || sop08Artifact?.confidence_status === 'LOW_COMPETITOR_POOL_CONFIDENCE';
  const analyzedIds = bols.map(row => row.competitor_id);
  const idsCovered = formalIds.length > 0 && formalIds.length === bols.length
    && new Set(analyzedIds).size === analyzedIds.length
    && formalIds.every(id => analyzedIds.includes(id));
  const expectedInputCount = Object.keys(artifact?.input_versions || {}).length;
  check('SOP09_ARTIFACT_AND_VERSION_LOCK', artifact?.artifact_type === 'LISTING_COMPETITOR_ANALYSIS_VERSION'
    && expectedInputCount >= 5 && Object.values(artifact.input_versions || {}).every(value => value?.version != null && value?.sha256), 'Analysis artifact records its actual version-locked inputs.');
  check('SOP08_FORMAL_POOL_ANALYZED', formalIds.length > 0 && idsCovered
    && bols.every(row => formalIds.includes(row.competitor_id) && row.classification === (sop08Artifact.candidates?.find(c => c.competitor_id === row.competitor_id)?.classification)),
  'Each analyzed formal competitor preserves the corresponding current SOP08 identity and classification.');
  check('BOL_PAGE_API_LAYERS_SEPARATE', bols.length === formalIds.length && bolEvidenceEntries.length === formalIds.length
    && bols.every(bol => pageVersionById.get(bol.competitor_id) === bol.evidence_refs?.page_facts_version
    && apiVersionById.get(bol.competitor_id) === bol.evidence_refs?.api_bundle_version
    && bol.page_offer?.current_price?.source === 'PAGE_FACTS'), 'Each formal competitor retains its own PAGE_FACTS and BOL_API_FACTS versions.');
  check('BOL_API_TEMPORAL_CONTEXT_PRESERVED', bols.every(bol => {
    const source = bolEvidenceEntries.find(item => item.competitor_id === bol.competitor_id)?.api;
    const offers = source?.offers || {};
    const ratings = source?.ratings || {};
    return bol.api_offer?.temporal_relation_to_page_facts === (offers.temporal_relation_to_page_facts || 'TIME_UNKNOWN')
      && bol.api_offer?.usable_as_current === (offers.usable_as_current === true)
      && bol.api_ratings?.temporal_relation_to_page_facts === (ratings.temporal_relation_to_page_facts || 'TIME_UNKNOWN')
      && bol.api_ratings?.usable_as_current === (ratings.usable_as_current === true)
      && (offers.temporal_relation_to_page_facts !== 'BEFORE_PAGE_CAPTURE' || offers.usable_as_current === false)
      && (ratings.temporal_relation_to_page_facts !== 'BEFORE_PAGE_CAPTURE' || ratings.usable_as_current === false);
  }), 'API evidence older than Page Facts is retained as historical and is never described as current.');
  check('BOL_LAYER_VERSION_LOCKS_MATCH', artifact?.input_versions?.bol_page_facts?.version === bolPageVersion
    && artifact?.input_versions?.bol_api_facts?.version === bolApiVersion
    && artifact?.evidence_refs?.bol_page_facts === bolPageVersion
    && artifact?.evidence_refs?.bol_api_facts === bolApiVersion,
  'Aggregate PAGE_FACTS and BOL_API_FACTS locks match the exact competitor evidence set.');
  const amazonFacts = amazonEvidenceBundle?.AMAZON_PAGE_FACTS?.page_facts || amazonEvidenceBundle?.page_facts || null;
  const amazonApplicable = Boolean(amazonEvidenceBundle || amazonFacts);
  check('AMAZON_PAGE_AND_SOP03_CONTEXT_SEPARATE', !amazonApplicable || (
    (!amazonFacts?.version || amazon?.evidence_refs?.amazon_page_facts_version === amazonFacts.version)
    && (!amazonEvidenceBundle?.SOP03_AMAZON_CONTEXT || amazon?.sop03_amazon_context?.source_url === amazonEvidenceBundle.SOP03_AMAZON_CONTEXT.source_url)
    && (!amazonEvidenceBundle?.SOP03_AMAZON_CONTEXT || amazon?.sop03_amazon_context?.candidate_only === amazonEvidenceBundle.SOP03_AMAZON_CONTEXT.candidate_only)),
  'Amazon page facts and SOP03 local-source context are not merged.', amazonApplicable);
  const bolNoReviews = bols.filter(row => row.reviews?.reviews_status === 'NO_REVIEWS');
  check('NO_REVIEWS_VALID', bolNoReviews.every(row => row.reviews.rating?.status === 'NOT_PRESENT'
    && row.reviews.review_count?.status === 'NOT_PRESENT' && Array.isArray(row.reviews.items) && row.reviews.items.length === 0),
  'A source-level NO_REVIEWS status is preserved as a valid result.');
  const ratingCount = rawOf(amazon?.ratings_summary?.rating_count);
  const textReviewCount = rawOf(amazon?.ratings_summary?.review_count);
  check('RATING_COUNT_NOT_REVIEW_COUNT', ratingCount == null || textReviewCount == null || Number(ratingCount) !== Number(textReviewCount),
    'Rating totals are not silently represented as text-review totals.', ratingCount != null);
  const reviewSource = amazonFacts?.inline_reviews || {};
  const reviewScope = reviewSource.review_scope;
  const sample = amazon?.inline_reviews;
  const partialSample = reviewScope === 'INLINE_SAMPLE' || reviewScope === 'INLINE_SAMPLE_ONLY' || reviewSource.status === 'AVAILABLE_PARTIAL';
  const noAmazonReviews = reviewSource.status === 'NO_REVIEWS' || reviewSource.review_scope === 'NO_REVIEWS';
  const reviewScopeValid = !amazonApplicable || (noAmazonReviews
    ? (sample?.review_scope === 'NO_REVIEWS' || sample?.sample_count === 0)
    : !reviewScope || (sample?.review_scope === (partialSample && reviewScope === 'INLINE_SAMPLE' ? 'INLINE_SAMPLE' : reviewScope)
      && sample?.sample_count === (reviewSource.items?.length ?? sample?.sample_count)
      && (!partialSample || (sample?.complete_review_set_claimed === false && artifact.review_analysis?.frequency_scope === 'WITHIN_OBSERVED_SAMPLE'))));
  check('REVIEW_SCOPE_AND_COMPLETENESS', reviewScopeValid,
  'Review scope and completeness claims do not exceed the current source.', amazonApplicable);
  const pagePriceUnusable = amazonFacts?.delivery_context?.usable_for_amazon_de_local_price_comparison === false;
  const pagePriceContext = amazonFacts?.delivery_context;
  const priceContextMatches = pagePriceContext ? ['destination', 'currency', 'usable_for_amazon_de_local_price_comparison']
    .every(key => pagePriceContext[key] === undefined || JSON.stringify(amazon?.delivery_context?.[key]) === JSON.stringify(pagePriceContext[key])) : true;
  check('AMAZON_PRICE_CONTEXT_PRESERVED', priceContextMatches && (!pagePriceUnusable || amazon?.delivery_context?.usable_for_amazon_de_local_price_comparison === false),
    'The current source price context is preserved; unusable local-price data remains unusable.', Boolean(pagePriceContext));
  const hasPackageConflict = ['SOURCE_CONFLICT_WITHIN_PAGE', 'SOURCE_CONFLICT'].includes(amazonFacts?.package_contents?.conflict_status || amazonFacts?.package_contents?.consistency);
  check('PACKAGE_CONFLICT_NOT_AUTO_RESOLVED', !hasPackageConflict || (amazon?.package_contents?.conflict_status === (amazonFacts.package_contents.conflict_status || amazonFacts.package_contents.consistency)
    && amazon.package_contents.auto_resolved === false), 'A source-declared package conflict remains unresolved.', hasPackageConflict);
  check('COMPETITOR_CONFIDENCE_INHERITED', artifact?.sop08_context?.low_competitor_pool_confidence === sop08Low,
    'The current SOP08 confidence state is inherited without imposing another SKU’s state.');
  check('PRODUCT_FACTS_VERSION_REFERENCE_ONLY', productFacts?.artifact_type === 'CONFIRMED_PRODUCT_FACTS_VERSION'
    && productFacts?.sku === sop08Artifact?.sku && String(artifact?.input_versions?.product_facts?.version) === String(productFacts.version)
    && artifact?.input_versions?.product_facts?.usage === 'SAFETY_REFERENCE_ONLY_NO_COMPETITOR_FACT_INHERITANCE',
  'Current SKU product facts are version-locked as a safety reference only.');
  check('SOP10_13_NOT_EXECUTED', artifact?.scope_guard?.sop10_through_sop13_executed === false && artifact?.scope_guard?.prohibited_business_conclusions_emitted === false, 'No SOP10–13 conclusion or matrix is produced.');
  let forbidden = false;
  try { assertNoForbiddenOutputs(artifact); } catch { forbidden = true; }
  check('NO_OUT_OF_SCOPE_OUTPUT_KEYS', !forbidden, 'No hot-point, pain-point, own advantage, matrix, or weighting output is present.');
  check('SOURCE_EVIDENCE_VERSION_TRACEABLE', artifact?.evidence_refs?.sop08_artifact === sop08Artifact.version
    && (!bolEvidenceBundle || artifact?.evidence_refs?.bol_bundle === bolEvidenceBundle.version)
    && (!amazonEvidenceBundle || artifact?.evidence_refs?.amazon_bundle === amazonEvidenceBundle.version),
  'Evidence refs point to the exact consumed source versions.');
  const passed = checks.every(row => row.pass);
  return { schema_version: 1, artifact_type: 'LISTING_COMPETITOR_ANALYSIS_QA', status: passed ? 'PASS' : 'FAIL', checked_at: new Date().toISOString(), external_requests: 0, checks };
}

export async function runListingCompetitorAnalysisOffline({ inputPaths, outputRoot, createdAt, expected }) {
  const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const [task, sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle] = await Promise.all([
    readJson(inputPaths.task), readJson(inputPaths.sop08), readJson(inputPaths.bolBundle), readJson(inputPaths.amazonBundle),
  ]);
  const productFacts = task.outputs?.confirmed_product_facts;
  const artifact = buildListingCompetitorAnalysis({ sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle, productFacts, createdAt, expected });
  const qa = qaListingCompetitorAnalysis({ artifact, inputs: { sop08Artifact, bolEvidenceBundle, amazonEvidenceBundle, productFacts } });
  artifact.qa_status = qa.status;
  const root = path.resolve(outputRoot);
  const outDir = path.join(root, artifact.version);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'analysis.json'), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(outDir, 'qa.json'), `${JSON.stringify(qa, null, 2)}\n`, { flag: 'wx' });
  return { artifact, qa, output_dir: outDir, input_task_status: task.status, input_task_revision: task.revision, external_requests: 0 };
}

export const LISTING_COMPETITOR_ANALYSIS_EXECUTOR = Object.freeze({
  executor_id: 'LISTING_COMPETITOR_ANALYSIS_EXECUTOR',
  sop_step_id: 'LISTING_SOP_09',
  input_artifacts: Object.freeze(['EFFECTIVE_COMPETITOR_POOL_VERSION', 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION', 'AMAZON_EVIDENCE_BUNDLE_VERSION', 'CONFIRMED_PRODUCT_FACTS_VERSION']),
  output_artifact: 'LISTING_COMPETITOR_ANALYSIS_VERSION',
  run: buildListingCompetitorAnalysis,
  qa: qaListingCompetitorAnalysis,
});
