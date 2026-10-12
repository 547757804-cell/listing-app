import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSop09RuntimeInputs, buildListingCompetitorAnalysis, qaListingCompetitorAnalysis, isFormalBolEvidenceBundleForPool, hydrateSop09BolEvidenceBundle } from '../app/listing_competitor_analysis_executor.mjs';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assert(condition, message) { if (!condition) throw new Error(message); }
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function allJson(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(full);
    }
  }
  return out;
}
function rel(root, file) { return path.relative(root, file).replace(/\\/g, '/'); }

const [dataRootArg, skuArg, bolBundleVersionArg] = process.argv.slice(2);
assert(dataRootArg && skuArg && bolBundleVersionArg, 'Usage: node build_sop09_input_bundle_from_persisted_sources.mjs <dataRoot> <sku> <exactBolBundleVersion>');
const dataRoot = path.resolve(dataRootArg);
const sku = skuArg;
const taskPath = path.join(dataRoot, 'products', `${sku}.json`);
const task = await json(taskPath);
assert(task.sku === sku && task.id === sku, 'Persisted task identity does not match the requested SKU.');
assert(task.current_step === 'LISTING_SOP_09' && task.resume_point === 'LISTING_SOP_09'
  && task.last_success_step === 'LISTING_SOP_08' && task.status === 'WAITING_DEPENDENCY'
  && task.waiting_dependency_key === 'SOP09_INPUTS' && task.qa?.LISTING_SOP_09?.status === 'NOT_RUN'
  && Number(task.open_error_count || 0) === 0, 'Task is not at the expected untouched SOP09 input checkpoint.');

const sop08Ref = task.outputs?.listing_competitor_pool?.evidence?.artifact_ref;
const sop08Version = task.outputs?.listing_competitor_pool?.version;
assert(sop08Ref && sop08Version && task.outputs.listing_competitor_pool.status === 'PASS', 'Passed SOP08 artifact reference is missing.');
const sop08Path = path.resolve(dataRoot, sop08Ref);
const sop08 = await json(sop08Path);
assert(sop08.artifact_type === 'EFFECTIVE_COMPETITOR_POOL_VERSION' && sop08.version === sop08Version && sop08.sku === sku && sop08.status === 'PASS', 'SOP08 artifact identity/version/status mismatch.');

const sourceRoot = path.join(dataRoot, 'artifacts', 'listing', sku, 'sop09', 'data-sources');
const files = await allJson(sourceRoot);
const parsed = [];
for (const file of files) {
  try { parsed.push({ file, value: await json(file) }); } catch { /* malformed unrelated evidence is not selected */ }
}
const bolMatches = parsed.filter(item => item.value.artifact_type === 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION'
  && item.value.version === bolBundleVersionArg && isFormalBolEvidenceBundleForPool(item.value, sop08));
assert(bolMatches.length === 1, `Expected one exact SOP08-linked BOL bundle; found ${bolMatches.length}.`);

const amazonBundles = parsed.filter(item => item.value.artifact_type === 'AMAZON_EVIDENCE_BUNDLE_VERSION' && item.value.sku === sku);
const validAmazonBundles = [];
for (const item of amazonBundles) {
  const pageRef = item.value.AMAZON_PAGE_FACTS?.artifact_ref;
  if (!pageRef) continue;
  const pagePath = path.resolve(path.dirname(item.file), pageRef);
  const page = await json(pagePath).catch(() => null);
  const qaPath = path.join(path.dirname(pagePath), 'qa.json');
  const qa = await json(qaPath).catch(() => null);
  if (page?.artifact_type === 'AMAZON_PAGE_FACTS_VERSION' && page.sku === sku
    && page.version === item.value.AMAZON_PAGE_FACTS.version && page.identity?.requested_asin?.value === 'SYNTHETIC2'
    && page.identity?.asin_match?.value === true && qa?.status === 'PASS') {
    validAmazonBundles.push({ ...item, page, pageFile: pagePath, qa, qaFile: qaPath });
  }
}
assert(validAmazonBundles.length === 1, `Expected one QA-PASS Amazon evidence bundle for this SKU and ASIN; found ${validAmazonBundles.length}.`);
const amazon = validAmazonBundles[0];

const refs = {
  sop08Version,
  bolBundleVersion: bolMatches[0].value.version,
  bolPageFactsVersion: bolMatches[0].value.PAGE_FACTS?.version,
  bolApiFactsVersion: bolMatches[0].value.BOL_API_FACTS?.version,
  amazonBundleVersion: amazon.value.version,
  amazonPageFactsVersion: amazon.page.version,
  productFactsVersion: String(task.outputs?.confirmed_product_facts?.version ?? ''),
};
assert(Object.values(refs).every(value => String(value || '').trim()), 'One or more locked input versions are missing.');
const resolved = await resolveSop09RuntimeInputs({ dataRoot, task, expectedVersions: refs });

const hydratedBolBundle = hydrateSop09BolEvidenceBundle(resolved.bolEvidenceBundle,
  resolved.bolPageFacts.map((page, index) => ({ page, api: resolved.bolApiFacts[index] })));
const analysisPreview = buildListingCompetitorAnalysis({
  sop08Artifact: resolved.sop08Artifact,
  bolEvidenceBundle: hydratedBolBundle,
  sourceBolEvidenceBundle: resolved.bolEvidenceBundle,
  amazonEvidenceBundle: resolved.amazonEvidenceBundle,
  productFacts: resolved.productFacts,
  expected: refs,
  createdAt: new Date().toISOString(),
});
analysisPreview.source_file_refs = resolved.sourceFileRefs;
const analysisQa = qaListingCompetitorAnalysis({ artifact: analysisPreview, inputs: { ...resolved, bolEvidenceBundle: hydratedBolBundle } });

const qaChecks = [
  ['SOP08_LOCKED_AND_PASS', sop08.status === 'PASS' && sop08.version === refs.sop08Version],
  ['FIVE_BOL_PAGE_FACTS_RESOLVED', resolved.bolPageFacts.length === 5 && resolved.bolPageFacts.every(item => item.product_id_match === true)],
  ['BOL_API_PARTIAL_SEMANTICS_PRESERVED', resolved.bolApiFacts.length === 5 && resolved.bolApiFacts.every(item => item.status === 'PARTIAL')],
  ['BOL_API_UNAVAILABLE_METHODS_NOT_INVENTED', resolved.bolApiFacts.every(item => ['NOT_RUN', 'AVAILABLE_REAL', 'AVAILABLE_PARTIAL'].includes(item.offers?.status) && ['NOT_RUN', 'AVAILABLE_REAL', 'AVAILABLE_PARTIAL'].includes(item.ratings?.status))],
  ['AMAZON_IDENTITY_AND_PAGE_QA_PASS', amazon.page.identity?.asin_match?.value === true && amazon.qa.status === 'PASS'],
  ['PRODUCT_FACTS_VERSIONED_FOR_SKU', resolved.productFacts.artifact_type === 'CONFIRMED_PRODUCT_FACTS_VERSION' && resolved.productFacts.sku === sku && String(resolved.productFacts.version) === refs.productFactsVersion],
  ['SOURCE_REFS_HASHED_AND_RESOLVABLE', async () => resolved.sourceFileRefs.length >= 10
    && (await Promise.all(resolved.sourceFileRefs.map(async item => {
      try { await fs.access(path.join(dataRoot, item.reference)); return Boolean(item.sha256); } catch { return false; }
    }))).every(Boolean)],
  ['NO_SYNTHETIC_ACCEPTANCE_10_SOURCE_NAMESPACE', resolved.sourceFileRefs.every(item => !item.reference.includes('SYNTHETIC-SKU-LEGACY-10') && !item.reference.includes('SYNTHETIC_ACCEPTANCE_10'))],
  ['SOP09_ANALYSIS_PREVIEW_QA_PASS', analysisQa.status === 'PASS'],
];
const checks = await Promise.all(qaChecks.map(async ([id, check]) => ({ id, pass: typeof check === 'function' ? await check() : Boolean(check) })));
const failed = checks.filter(item => !item.pass);
assert(failed.length === 0, `SOP09 input/source QA failed: ${failed.map(item => item.id).join(', ')}; preview=${JSON.stringify(analysisQa.checks.filter(item => !item.pass))}; api=${JSON.stringify(analysisPreview.bol_competitor_analysis.map(item => ({ id: item.competitor_id, offers: item.api_offer, ratings: item.api_ratings })))}`);

const lineageRefs = [];
for (const [outputKey, artifactType] of [
  ['keyword_source_discovery', 'SOP03_SOURCE_DISCOVERY_VERSION'],
  ['LISTING_SOP_06', 'LISTING_SOP_06_BOLOO_KEYWORD_VOLUMES'],
  ['top20', 'LISTING_SOP_07_TOP20'],
]) {
  const output = task.outputs?.[outputKey];
  const version = output?.version;
  assert(version, `Missing exact upstream lineage version ${artifactType}.`);
  let match;
  if (artifactType === 'SOP03_SOURCE_DISCOVERY_VERSION') {
    const suffix = String(version).startsWith('SOP03-SOURCES-') ? String(version).slice('SOP03-SOURCES-'.length) : '';
    assert(suffix && /^[a-f0-9]{20,64}$/i.test(suffix), 'SOP03 task lineage does not use the exact file-key version form.');
    const file = path.join(dataRoot, 'artifacts', 'listing', sku, 'sop03', `${suffix}.json`);
    const value = await json(file);
    assert(value.artifact_type === artifactType && value.sku === sku && !value.version,
      'SOP03 source artifact must match its task version-derived filename and SKU without inventing an embedded version.');
    match = { file, value, versionBinding: 'TASK_VERSION_SUFFIX_EQUALS_EXACT_FILENAME' };
  } else {
    const candidates = await allJson(path.join(dataRoot, 'artifacts', 'listing', sku)).then(async list => {
      const found = [];
      for (const file of list) { try { const value = await json(file); if (value.artifact_type === artifactType && value.version === version && value.sku === sku) found.push({ file, value }); } catch {} }
      return found;
    });
    assert(candidates.length === 1, `Expected exact persisted lineage ${artifactType}/${version}; found ${candidates.length}.`);
    match = candidates[0];
  }
  const bytes = await fs.readFile(match.file);
  lineageRefs.push({ artifact_type: artifactType, version, ...(match.versionBinding ? { version_binding: match.versionBinding } : {}), reference: rel(dataRoot, match.file), sha256: sha256(bytes) });
}

const sourceFileRefs = resolved.sourceFileRefs.filter(item => item.source !== 'PRODUCT_FACTS_V2_TASK_RECORD');
const core = {
  schema_version: 1,
  artifact_type: 'SOP09_INPUT_BUNDLE_VERSION',
  sku,
  status: 'READY',
  expected_versions: refs,
  input_version_refs: [
    { artifact_type: 'EFFECTIVE_COMPETITOR_POOL_VERSION', version: refs.sop08Version },
    { artifact_type: 'BOL_COMPETITOR_EVIDENCE_BUNDLE_VERSION', version: refs.bolBundleVersion },
    { artifact_type: 'BOL_PAGE_FACTS_VERSION', version: refs.bolPageFactsVersion },
    { artifact_type: 'BOL_API_FACTS_VERSION', version: refs.bolApiFactsVersion },
    { artifact_type: 'AMAZON_EVIDENCE_BUNDLE_VERSION', version: refs.amazonBundleVersion },
    { artifact_type: 'AMAZON_PAGE_FACTS_VERSION', version: refs.amazonPageFactsVersion },
    { artifact_type: 'CONFIRMED_PRODUCT_FACTS_VERSION', version: refs.productFactsVersion },
  ],
  source_file_refs: sourceFileRefs,
  lineage_refs: lineageRefs,
  product_facts_version: refs.productFactsVersion,
  product_facts_content_sha256: sha256(Buffer.from(stable(resolved.productFacts), 'utf8')),
  qa: { status: 'PASS', checked_at: new Date().toISOString(), checks },
  source_completeness: {
    bol_page_facts: 'AVAILABLE_REAL',
    bol_api_facts: 'PARTIAL',
    bol_api_historical_records_are_not_current: true,
    amazon_page_facts: 'AVAILABLE_REAL',
  },
  created_at: new Date().toISOString(),
};
const version = `SOP09_INPUT_BUNDLE-${sha256(Buffer.from(stable(Object.fromEntries(Object.entries(core).filter(([key]) => key !== 'created_at'))), 'utf8')).slice(0, 20)}`;
const artifact = { ...core, version };
const relative = `artifacts/listing/${sku}/sop09/input-bundles/${version}/input-bundle.json`;
const outputPath = path.join(dataRoot, relative);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
try {
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  const existing = await json(outputPath);
  assert(stable({ ...existing, created_at: undefined }) === stable({ ...artifact, created_at: undefined }), 'Existing SOP09 input bundle version has different contents.');
}
process.stdout.write(`${JSON.stringify({ status: 'PASS', sku, version, artifact_ref: relative, qa: artifact.qa.status,
  qa_checks: checks, sop09_preview_qa: analysisQa.status, bol_bundle: refs.bolBundleVersion,
  bol_page_set: refs.bolPageFactsVersion, bol_api_set: refs.bolApiFactsVersion,
  amazon_bundle: refs.amazonBundleVersion, amazon_page_facts: refs.amazonPageFactsVersion,
  product_facts_version: refs.productFactsVersion, source_ref_count: sourceFileRefs.length,
  lineage_ref_count: lineageRefs.length, external_requests: 0 }, null, 2)}\n`);
