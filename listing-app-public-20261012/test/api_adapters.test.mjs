import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ApiCache } from '../app/api_cache.mjs';
import { AdapterError, BolRetailerClient, fetchCompetitorDataForFinalReview, runBolKeywordStage, selectRelatedTerms } from '../app/bol_retailer_client.mjs';
import { BolooMcpClient, bolooIntegrationStatus } from '../app/boloo_mcp_client.mjs';
import { closeDatabase, importProducts } from '../app/bol_core.mjs';
import { withReadinessOverrides } from '../app/provider_readiness.mjs';
import { amsterdamBusinessDate } from '../app/boloo_keyword_policy.mjs';

const fakeEnv = { BOL_CLIENT_ID: 'fixture-client-id', BOL_CLIENT_SECRET: 'fixture-client-secret' };
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');
const fakeToken = 'fixture-access-token-never-returned-by-client';
const termResponse = {
  searchTerms: {
    searchTerm: 'wildcamera 4k', type: 'count', total: 520,
    countries: [{ countryCode: 'NL', value: 400 }, { countryCode: 'BE', value: 120 }],
    periods: [{ period: { week: '20', year: '2026' }, total: 520, countries: [{ countryCode: 'NL', value: 400 }, { countryCode: 'BE', value: 120 }] }],
    relatedSearchTerms: [
      { searchTerm: 'wildcamera 4k', total: 500 },
      { searchTerm: '4k wildcamera', total: 450 },
      { searchTerm: 'wildcamera outdoor 4k', total: 410 },
      { searchTerm: 'wildcamera nachtzicht', total: 350 },
      { searchTerm: 'wildcamera wifi', total: 300 },
      { searchTerm: 'wildcamera batterij', total: 250 },
      { searchTerm: 'wildcamera zonnepaneel', total: 200 },
      { searchTerm: 'kinderwagen', total: 900 },
    ],
  },
};

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function tempDir(t) {
  const offlineTempRoot = path.join(projectRoot, '_offline_tmp');
  await fs.mkdir(offlineTempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(offlineTempRoot, 'api-test-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('persistent API cache stores raw and structured response with expiry and provenance', async t => {
  const dataRoot = await tempDir(t);
  const cache = new ApiCache(dataRoot);
  const now = new Date('2026-09-24T00:00:00.000Z');
  await cache.set('bol_search_terms', 'exact-key', { rawResponse: { raw: true }, structuredResult: { terms: ['a'] }, source: 'fixture', ttlMs: 1000 }, now);
  const hit = await cache.get('bol_search_terms', 'exact-key', new Date(now.getTime() + 500));
  assert.equal(hit.cacheHit, true);
  assert.deepEqual(hit.rawResponse, { raw: true });
  assert.deepEqual(hit.structuredResult, { terms: ['a'] });
  assert.equal(hit.source, 'fixture');
  assert.equal(await cache.get('bol_search_terms', 'exact-key', new Date(now.getTime() + 1001)), null);
  const observation = { exactString: 'Exact keyword 4K', queriedAtUtc: '2026-09-24T00:00:00.000Z', toolName: 'discovered-keyword-tool', providerMethod: 'BOLOO_OFFICIAL_MCP', officialSourceVerified: true, stageQaStatus: 'PASS', rawResponse: { raw: true }, structuredResult: { monthlyVolume: 31 } };
  await cache.recordBolooKeywordObservation(observation, now);
  const mcpReuse = await cache.findReusableBolooKeyword({ exactString: 'Exact keyword 4K', queriedAtUtc: '2026-09-24T21:59:59.000Z' });
  assert.deepEqual(mcpReuse.structuredResult, { monthlyVolume: 31 });
  assert.equal(mcpReuse.source, 'BOLOO_OFFICIAL_VERIFIED');
  assert.equal(mcpReuse.provider_method, 'BOLOO_OFFICIAL_MCP');
  assert.equal(mcpReuse.queried_at_utc, '2026-09-24T00:00:00.000Z');
  assert.equal(await cache.findReusableBolooKeyword({ exactString: 'Exact keyword 4K', queriedAtUtc: '2026-09-24T22:00:00.000Z' }), null);
  assert.equal(await cache.findReusableBolooKeyword({ exactString: 'exact keyword 4K', queriedAtUtc: '2026-09-24T21:59:59.000Z' }), null);
  await assert.rejects(cache.recordBolooKeywordObservation({ ...observation, stageQaStatus: 'FAIL' }), /Only Stage QA PASS/);
  await assert.rejects(cache.recordBolooKeywordObservation({ ...observation, officialSourceVerified: false }), /official-source verification/);
  await assert.rejects(cache.recordBolooKeywordObservation({ ...observation, queryDate: '2026-09-25' }), /match the Europe\/Amsterdam business date/);
  cache.close();
  const reopened = new ApiCache(dataRoot);
  assert.equal((await reopened.findReusableBolooKeyword({ exactString: 'Exact keyword 4K', queriedAtUtc: '2026-09-24T21:00:00.000Z' })).formalReuse, true);
  reopened.close();
});

test('Boloo business date uses Europe/Amsterdam, not the runtime timezone', () => {
  assert.equal(amsterdamBusinessDate('2026-09-24T21:59:59.000Z'), '2026-09-24');
  assert.equal(amsterdamBusinessDate('2026-09-24T22:00:00.000Z'), '2026-09-25');
  assert.equal(amsterdamBusinessDate('2026-01-31T22:59:59.000Z'), '2026-01-31');
  assert.equal(amsterdamBusinessDate('2026-01-31T23:00:00.000Z'), '2026-02-01');
});

test('legacy web keyword rows are not promoted to verified reusable data during migration', async t => {
  const dataRoot = await tempDir(t);
  const file = path.join(dataRoot, 'api-cache.sqlite3');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE boloo_keyword_history (
    observation_id TEXT PRIMARY KEY, exact_string TEXT NOT NULL, query_date TEXT NOT NULL, source TEXT NOT NULL,
    tool_name TEXT NOT NULL, stage_qa_status TEXT NOT NULL, recorded_at TEXT NOT NULL,
    raw_response TEXT NOT NULL, structured_result TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO boloo_keyword_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-row', 'web phrase', '2026-09-24', 'BOLOO_OFFICIAL_WEB', 'fixture-web', 'PASS',
    '2026-09-24T10:00:00.000Z', '{"fixture":true}', '{"volume":10}',
  );
  legacy.close();
  const cache = new ApiCache(dataRoot);
  await cache.initialize();
  assert.equal(await cache.findReusableBolooKeyword({ exactString: 'web phrase', queriedAtUtc: '2026-09-24T10:00:00.000Z' }), null);
  cache.close();
  const migrated = new DatabaseSync(file);
  const row = migrated.prepare('SELECT source, provider_method, queried_at_utc FROM boloo_keyword_history WHERE observation_id=?').get('legacy-row');
  assert.equal(row.source, 'BOLOO_OFFICIAL_WEB');
  assert.equal(row.provider_method, 'BOLOO_OFFICIAL_WEB');
  assert.equal(row.queried_at_utc, '');
  migrated.close();
});

test('BOL Search Terms uses OAuth, caches response, and never returns the token', async t => {
  const dataRoot = await tempDir(t);
  let calls = 0;
  const requestUrls = [];
  const client = new BolRetailerClient({ dataRoot, env: fakeEnv, fetchImpl: async (url, init) => {
    calls++;
    requestUrls.push({ url: String(url), headers: init.headers });
    return String(url) === 'https://login.bol.com/token'
      ? jsonResponse({ access_token: fakeToken, token_type: 'Bearer', expires_in: 299 })
      : jsonResponse(termResponse);
  } });
  const first = await client.getSearchTerms({ searchTerm: 'wildcamera 4k', period: 'WEEK', numberOfPeriods: 52, related: true });
  const second = await client.getSearchTerms({ searchTerm: 'wildcamera 4k', period: 'WEEK', numberOfPeriods: 52, related: true });
  const fresh = await client.getSearchTerms({ searchTerm: 'wildcamera 4k', period: 'WEEK', numberOfPeriods: 52, related: true, cacheMode: 'FORCE_REFRESH' });
  assert.equal(calls, 3);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(fresh.cacheHit, false);
  assert.equal(first.structuredResult.relatedSearchTerms.length, 8);
  assert.equal(JSON.stringify({ first, second, status: client.getAuthStatus() }).includes(fakeToken), false);
  const auth = await client.validateOAuth();
  assert.equal(auth.httpStatus, 200);
  assert.equal(auth.tokenType, 'Bearer');
  assert.ok(auth.expiresInSeconds > 0);
  assert.equal(client.getAuthStatus().status, 'PENDING_PRODUCTION_VALIDATION');
  assert.ok(requestUrls[1].url.includes('related-search-terms=true'));
  assert.ok(!requestUrls[1].url.includes('&related=true'));
  client.cache.close();
});

test('BOL client refreshes once after 401 without exposing token values', async t => {
  const dataRoot = await tempDir(t);
  let tokenCalls = 0;
  let apiCalls = 0;
  const client = new BolRetailerClient({ dataRoot, env: fakeEnv, fetchImpl: async url => {
    if (String(url) === 'https://login.bol.com/token') {
      tokenCalls++;
      return jsonResponse({ access_token: `fixture-token-${tokenCalls}`, token_type: 'Bearer', expires_in: 299 });
    }
    apiCalls++;
    return apiCalls === 1 ? jsonResponse({ sensitive_error: 'fixture echo' }, 401) : jsonResponse(termResponse);
  } });
  const result = await client.getSearchTerms({ searchTerm: 'wildcamera 4k' });
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 2);
  assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  client.cache.close();
});

test('BOL client uses a bounded 429 retry and sanitizes network errors', async t => {
  const dataRoot = await tempDir(t);
  let apiCalls = 0;
  const rateLimited = new BolRetailerClient({ dataRoot, env: fakeEnv, fetchImpl: async url => {
    if (String(url) === 'https://login.bol.com/token') return jsonResponse({ access_token: fakeToken, token_type: 'Bearer', expires_in: 299 });
    apiCalls++;
    return apiCalls === 1 ? jsonResponse({ error: 'fixture error' }, 429, { 'retry-after': '0' }) : jsonResponse(termResponse);
  } });
  assert.equal((await rateLimited.getSearchTerms({ searchTerm: 'wildcamera 4k' })).structuredResult.searchTerm, 'wildcamera 4k');
  assert.equal(apiCalls, 2);
  rateLimited.cache.close();

  const timed = new BolRetailerClient({ dataRoot: path.join(dataRoot, 'timeout'), env: fakeEnv, fetchImpl: async () => { throw new DOMException('fixture contains no network detail', 'TimeoutError'); } });
  await assert.rejects(() => timed.getSearchTerms({ searchTerm: 'wildcamera 4k' }), error => error.code === 'BOL_NETWORK_TIMEOUT' && !error.message.includes('fixture'));
  timed.cache.close();
});

test('BOL client performs one bounded retry for 5xx and returns a sanitized failure', async t => {
  const dataRoot = await tempDir(t);
  let apiCalls = 0;
  const client = new BolRetailerClient({ dataRoot, env: fakeEnv, fetchImpl: async url => {
    if (String(url) === 'https://login.bol.com/token') return jsonResponse({ access_token: fakeToken, token_type: 'Bearer', expires_in: 299 });
    apiCalls++;
    return jsonResponse({ confidential_detail: 'must not escape' }, 503);
  } });
  await assert.rejects(client.getSearchTerms({ searchTerm: 'wildcamera 4k' }), error => {
    assert.equal(error.code, 'BOL_API_HTTP_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.message.includes('confidential_detail'), false);
    assert.equal(error.message.includes('must not escape'), false);
    return true;
  });
  assert.equal(apiCalls, 2);
  client.cache.close();
});

test('BOL Product List, Offers and Ratings return structured data and retain raw responses', async t => {
  const dataRoot = await tempDir(t);
  let productListRequest;
  let productListCalls = 0;
  let offersCalls = 0;
  let ratingsCalls = 0;
  const client = new BolRetailerClient({ dataRoot, env: fakeEnv, fetchImpl: async (url, init) => {
    const target = String(url);
    if (target === 'https://login.bol.com/token') return jsonResponse({ access_token: fakeToken, token_type: 'Bearer', expires_in: 299 });
    if (target.endsWith('/products/list')) { productListRequest = init; productListCalls++; return jsonResponse({ sort: 'RELEVANCE', products: [{ title: `Fixture product ${productListCalls}`, eans: [{ ean: '123' }, { ean: '' }] }] }); }
    if (target.includes('/offers?')) { offersCalls++; return jsonResponse({ offers: [{ offerId: 'fixture-offer', retailerId: 'fixture-retailer', countryCode: 'BE', bestOffer: true, price: 25 + offersCalls, fulfilmentMethod: 'FBB', condition: 'NEW' }] }); }
    if (target.endsWith('/ratings')) { ratingsCalls++; return jsonResponse({ ratings: [{ rating: 5, count: 12 }, { rating: 4, count: 3 }] }); }
    throw new Error('fixture route missing');
  } });
  const products = await client.getProductList({ countryCode: 'BE', searchTerm: 'fixture term' });
  const productHit = await client.getProductList({ countryCode: 'BE', searchTerm: 'fixture term', cacheMode: 'CACHE_OK' });
  const productRefresh = await client.getProductList({ countryCode: 'BE', searchTerm: 'fixture term', cacheMode: 'FORCE_REFRESH' });
  const offers = await client.getOffers({ ean: '123', countryCode: 'BE' });
  const offerRefresh = await client.getOffers({ ean: '123', countryCode: 'BE', cacheMode: 'FORCE_REFRESH' });
  const ratings = await client.getRatings({ ean: '123' });
  const ratingsHit = await client.getRatings({ ean: '123', cacheMode: 'CACHE_OK' });
  assert.equal(products.structuredResult.products[0].eans.length, 1);
  assert.equal(products.rawResponse.products[0].title, 'Fixture product 1');
  assert.equal(productHit.cacheHit, true);
  assert.equal(productRefresh.cacheHit, false);
  assert.equal(productRefresh.rawResponse.products[0].title, 'Fixture product 2');
  assert.equal(productListCalls, 2);
  assert.equal(productListRequest.headers['Content-Type'], 'application/json');
  assert.equal(productListRequest.headers['Accept-Language'], 'nl-BE');
  assert.deepEqual(JSON.parse(productListRequest.body), { countryCode: 'BE', searchTerm: 'fixture term', sort: 'RELEVANCE', page: 1 });
  assert.equal(offers.structuredResult.offers[0].price, 26);
  assert.equal(offerRefresh.cacheHit, false);
  assert.equal(offerRefresh.structuredResult.offers[0].price, 27);
  assert.equal(offersCalls, 2);
  assert.equal(ratings.structuredResult.ratings[0].count, 12);
  assert.equal(ratingsHit.cacheHit, true);
  assert.equal(ratingsCalls, 1);
  client.cache.close();
});

test('final competitor review helper always forces fresh Product List, Offers and Ratings', async () => {
  const calls = [];
  const resultRow = { rawResponse: {}, structuredResult: {}, cacheHit: false };
  const client = {
    getProductList: async args => { calls.push(['productList', args.cacheMode]); return resultRow; },
    getOffers: async args => { calls.push(['offers', args.cacheMode]); return resultRow; },
    getRatings: async args => { calls.push(['ratings', args.cacheMode]); return resultRow; },
  };
  const snapshot = await fetchCompetitorDataForFinalReview({ client, countryCode: 'BE', searchTerm: 'exact product phrase', categoryId: '123', ean: '456' });
  assert.equal(snapshot.status, 'CURRENT_DATA_REQUIRES_SOP_REVIEW');
  assert.deepEqual(calls, [['productList', 'FORCE_REFRESH'], ['offers', 'FORCE_REFRESH'], ['ratings', 'FORCE_REFRESH']]);
});

test('related-term selection prioritizes relevance, sorts by total, and preserves exact string variants', () => {
  const terms = selectRelatedTerms({
    productMaster: { brand: 'WildCam', name: 'wildcamera 4k outdoor', confirmed_core_terms: ['wildcamera 4k'] },
    seedRecords: [{ searchTerm: 'wildcamera 4k', relatedSearchTerms: termResponse.searchTerms.relatedSearchTerms }],
  });
  assert.equal(terms.length, 7);
  assert.ok(terms.some(item => item.searchTerm === 'wildcamera 4k'));
  assert.ok(terms.some(item => item.searchTerm === '4k wildcamera'));
  assert.ok(!terms.some(item => item.searchTerm === 'kinderwagen'));
  assert.ok(terms.every((item, i) => !i || terms[i - 1].relevance >= item.relevance));
});

test('BOL stage queries at most three seeds and fails if relevant exact terms remain under five', async () => {
  const productMaster = { brand: 'WildCam', name: 'wildcamera outdoor', confirmed_core_terms: ['wildcamera outdoor', 'wildcamera night vision', 'wildcamera wifi'] };
  let calls = 0;
  const client = { getSearchTerms: async ({ searchTerm }) => {
    calls++;
    const relatedSearchTerms = calls === 1
      ? [{ searchTerm: 'wildcamera outdoor', total: 50 }, { searchTerm: 'wildcamera outdoor camera', total: 20 }]
      : [{ searchTerm: 'wildcamera night vision', total: 30 }, { searchTerm: 'wildcamera wifi camera', total: 10 }, { searchTerm: 'wildcamera battery', total: 5 }];
    return { rawResponse: { searchTerms: { searchTerm, relatedSearchTerms } }, structuredResult: { searchTerm, relatedSearchTerms }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+1000).toISOString(), source: 'fixture', cacheHit: false };
  } };
  const output = await runBolKeywordStage({ client, productMaster, sku: 'SKU-1' });
  assert.equal(calls, 2);
  assert.equal(output.relatedTerms.length, 5);
  assert.equal(output.rawResponses.length, 2);

  const insufficientClient = { getSearchTerms: async ({ searchTerm }) => ({ rawResponse: {}, structuredResult: { searchTerm, relatedSearchTerms: [{ searchTerm: 'wildcamera', total: 1 }] }, createdAt: 'now', expiresAt: 'later', source: 'fixture', cacheHit: false }) };
  await assert.rejects(() => runBolKeywordStage({ client: insufficientClient, productMaster, sku: 'SKU-2' }), error => error.code === 'BOL_RELATED_TERMS_INSUFFICIENT');
});

test('Boloo client does not send a request without plan access/key', async () => {
  let called = false;
  const client = new BolooMcpClient({ authorizationValue: '', fetchImpl: async () => { called = true; } });
  await assert.rejects(() => client.discoverTools(), error => error.code === 'BOLOO_MCP_PLAN_ACCESS_NOT_INCLUDED');
  assert.equal(called, false);
  assert.equal(bolooIntegrationStatus().status, 'PLAN_ACCESS_NOT_INCLUDED');
});

test('Boloo Streamable HTTP discovery records only tools returned by the server', async t => {
  const directory = await tempDir(t);
  const discoveryFile = path.join(directory, 'tool-schemas.json');
  const requests = [];
  let clockValue = '2026-09-24T10:00:00.000Z';
  const client = new BolooMcpClient({ authorizationValue: 'fixture-auth-header', discoveryFile, dataRoot: directory, clock: () => new Date(clockValue), fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.at(-1).method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: requests.at(-1).id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture-server', version: '1' } } }, 200, { 'mcp-session-id': 'fixture-session' });
    if (requests.at(-1).method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (requests.at(-1).method === 'tools/call') return jsonResponse({ jsonrpc: '2.0', id: requests.at(-1).id, result: { content: [{ type: 'text', text: 'fixture result' }] } });
    return jsonResponse({ jsonrpc: '2.0', id: requests.at(-1).id, result: { tools: [{ name: 'fixture_tool_name', description: 'fixture tool description', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } });
  } });
  const snapshot = await client.discoverTools();
  assert.equal(snapshot.tools[0].name, 'fixture_tool_name');
  assert.equal(snapshot.tools[0].inputSchema.properties.query.type, 'string');
  assert.equal(JSON.stringify(snapshot).includes('fixture-auth-header'), false);
  assert.equal((await fs.readFile(discoveryFile, 'utf8')).includes('fixture-auth-header'), false);
  assert.deepEqual(await client.callTool('fixture_tool_name', { query: 'exact phrase' }), { content: [{ type: 'text', text: 'fixture result' }] });
  await client.callTool('fixture_tool_name', { query: 'exact phrase' });
  await client.callTool('fixture_tool_name', { query: 'exact phrase' }, { cacheMode: 'CACHE_OK' });
  assert.equal(requests.filter(item => item.method === 'tools/call').length, 2);
  const exact = { toolName: 'fixture_tool_name', args: { query: 'exact phrase' }, exactString: 'exact phrase' };
  const fresh = await client.callExactKeywordTool(exact);
  assert.equal(fresh.status, 'FRESH_RESPONSE_REQUIRES_STAGE_QA');
  assert.equal(fresh.queryDate, '2026-09-24');
  assert.equal(fresh.queried_at_utc, clockValue);
  await client.cache.recordBolooKeywordObservation({ exactString: exact.exactString, queriedAtUtc: fresh.queried_at_utc, toolName: 'fixture_tool_name', providerMethod: 'BOLOO_OFFICIAL_MCP', officialSourceVerified: true, rawResponse: fresh.result, structuredResult: { exactString: exact.exactString, monthlyVolume: 42 }, stageQaStatus: 'PASS' });
  const callCountBeforeReuse = requests.filter(item => item.method === 'tools/call').length;
  const reused = await client.callExactKeywordTool(exact);
  assert.equal(reused.status, 'FORMAL_REUSE');
  assert.equal(reused.structuredResult.monthlyVolume, 42);
  assert.equal(reused.source, 'BOLOO_OFFICIAL_VERIFIED');
  assert.equal(reused.provider_method, 'BOLOO_OFFICIAL_MCP');
  assert.equal(reused.queried_at_utc, fresh.queried_at_utc);
  assert.equal(requests.filter(item => item.method === 'tools/call').length, callCountBeforeReuse);
  await assert.rejects(() => client.recordVerifiedKeywordResult({ ...exact, queried_at_utc: fresh.queried_at_utc, rawResponse: fresh.result, structuredResult: {}, stageQaStatus: 'PASS' }), error => error.code === 'BOLOO_OFFICIAL_SOURCE_NOT_VERIFIED');
  clockValue = '2026-09-24T22:00:00.000Z';
  const nextDay = await client.callExactKeywordTool(exact);
  assert.equal(nextDay.status, 'FRESH_RESPONSE_REQUIRES_STAGE_QA');
  assert.equal(nextDay.queryDate, '2026-09-25');
  const variant = await client.callExactKeywordTool({ ...exact, exactString: 'Exact phrase' });
  assert.equal(variant.status, 'FRESH_RESPONSE_REQUIRES_STAGE_QA');
  assert.equal(requests.filter(item => item.method === 'tools/call').length, 5);
  assert.equal(bolooIntegrationStatus().BOLOO_PROVIDER_READY, false);
  client.cache.close();
});

test('Boloo WebView2 is fail-closed; mocked web verification cannot persist formal data', async t => {
  const dataRoot = await tempDir(t);
  const client = new BolooMcpClient({ dataRoot, clock: () => new Date('2026-09-24T10:00:00.000Z'), officialWebVerifier: async () => true, fetchImpl: async () => { throw new Error('not used'); } });
  await assert.rejects(() => client.recordVerifiedOfficialWebKeywordResult({ exactString: 'exact web keyword', sourceUrl: 'https://boloo.co/keyword-explorer', pageFieldName: 'Gemiddeld zoekvolume per maand', rawValue: 17, fetchedAtUtc: '2026-09-24T10:00:00.000Z', rawDomEvidenceRef: { kind: 'DOM', reference: 'fixture://dom-snapshot' }, rawResponse: { page: 'fixture' }, structuredResult: { monthlyVolume: 17 }, stageQaStatus: 'PASS' }), error => error.code === 'BOLOO_WEBVIEW2_NOT_VERIFIED');
  assert.equal(await client.cache.findReusableBolooKeyword({ exactString: 'exact web keyword', queriedAtUtc: '2026-09-24T10:00:00.000Z' }), null);
  assert.equal(bolooIntegrationStatus().BOLOO_WEBVIEW2_VERIFIED, false);
  client.cache.close();
});

test('new product import stops at the current SOP03 dependency checkpoint', async t => {
  const dataRoot = await tempDir(t);
  t.after(() => {
    closeDatabase();
  });
  const result = await withReadinessOverrides({ BOL_API_READY: true }, () => importProducts(dataRoot, [
    { sku: 'BOL-MOCK-CHECKPOINT', name: 'wildcamera 4k outdoor', brand: 'WildCam', confirmed_core_terms: ['wildcamera 4k'], source_refs: ['fixture-source'] },
  ]));
  closeDatabase();
  const task = result.results[0].task;
  assert.equal(result.accepted, 1);
  assert.equal(task.last_success_step, 'LISTING_SOP_02');
  assert.equal(task.current_step, 'LISTING_SOP_03');
  assert.equal(task.resume_point, 'LISTING_SOP_03');
  assert.equal(task.status, 'WAITING_DEPENDENCY');
  assert.equal(task.qa.LISTING_SOP_03.status, 'NOT_RUN');
  assert.equal(task.open_error_count, 0);
});

test('providers not ready wait without production calls or SKU issues', async t => {
  const dataRoot = await tempDir(t);
  let calls = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected request'); };
  t.after(() => { globalThis.fetch = savedFetch; closeDatabase(); });
  const result = await importProducts(dataRoot, [{ sku: 'BOL-WAIT-ONLY', name: 'wildcamera 4k', brand: 'WildCam', source_refs: ['fixture-source'] }]);
  const task = result.results[0].task;
  assert.equal(task.current_step, 'LISTING_SOP_03');
  assert.equal(task.status, 'WAITING_DEPENDENCY');
  assert.equal(task.last_success_step, 'LISTING_SOP_02');
  assert.equal(task.stages.LISTING_SOP_03.status, 'WAITING_DEPENDENCY');
  assert.equal(task.error_code, null);
  assert.equal(task.open_error_count, 0);
  assert.equal(task.issues.length, 0);
  assert.equal(calls, 0);
  closeDatabase();
});
