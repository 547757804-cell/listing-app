import assert from 'node:assert/strict';
import { BolRetailerClient } from './bol_retailer_client.mjs';

const TEST_SECRET = 'offline-secret-marker';
const cache = {
  async get() { return null; },
  async set(provider, key, value) { return value; },
};

function response(status, body, headers = {}, statusText = 'Offline Fixture') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, statusText, headers: { 'content-type': 'application/json', ...headers } });
}

function makeClient(apiFetch) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://login.bol.com/token')) {
      return response(200, { access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 });
    }
    return apiFetch(String(url), init, calls);
  };
  return {
    calls,
    client: new BolRetailerClient({
      env: { BOL_CLIENT_ID: 'offline-client-id', BOL_CLIENT_SECRET: TEST_SECRET },
      fetchImpl,
      cache,
      timeoutMs: 25,
    }),
  };
}

{
  const { client, calls } = makeClient(async () => response(415, {
    error: 'Unsupported Media Type', accepted_content_type: 'application/json',
  }, { 'x-request-id': 'bol-415' }, 'Unsupported Media Type'));
  await assert.rejects(client.getProductList({ searchTerm: 'fixture query', cacheMode: 'FORCE_REFRESH' }), error => {
    assert.equal(error.code, 'BOL_API_HTTP_ERROR');
    assert.equal(error.http_status, 415);
    assert.equal(error.http_status_text, 'Unsupported Media Type');
    assert.equal(error.response_received, true);
    assert.equal(error.safe_body.accepted_content_type, 'application/json');
    assert.equal(error.safe_headers['x-request-id'], 'bol-415');
    assert.ok(error.adapter_request_id);
    return true;
  });
  const productListRequest = calls.find(call => call.url.includes('/retailer/products/list'));
  assert.equal(productListRequest.init.method, 'POST');
  assert.equal(productListRequest.init.headers['Content-Type'], 'application/json');
  assert.equal(productListRequest.init.headers.Accept, 'application/vnd.retailer.v10+json');
  assert.equal(productListRequest.init.headers['Accept-Language'], 'nl');
  assert.deepEqual(JSON.parse(productListRequest.init.body), {
    countryCode: 'NL', searchTerm: 'fixture query', sort: 'RELEVANCE', page: 1,
  });
}

{
  const { client, calls } = makeClient(async url => {
    if (url.includes('/insights/search-terms')) return response(200, { searchTerms: { searchTerm: 'fixture', relatedSearchTerms: [] } });
    if (url.endsWith('/offers?country-code=NL&page=1')) return response(200, { offers: [] });
    if (url.endsWith('/ratings')) return response(200, { ratings: [] });
    if (url.includes('/placement?country-code=NL')) return response(200, { url: 'https://www.bol.com/nl/nl/p/fixture/123/', categories: [] });
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  await client.getSearchTerms({ searchTerm: 'fixture', cacheMode: 'FORCE_REFRESH' });
  await client.getOffers({ ean: '1234567890123', cacheMode: 'FORCE_REFRESH' });
  await client.getRatings({ ean: '1234567890123', cacheMode: 'FORCE_REFRESH' });
  await client.getProductPlacement({ ean: '1234567890123', cacheMode: 'FORCE_REFRESH' });
  const apiRequests = calls.filter(call => call.url.startsWith('https://api.bol.com/'));
  assert.equal(apiRequests.length, 4);
  for (const call of apiRequests) {
    assert.equal(call.init.headers.Accept, 'application/vnd.retailer.v10+json');
    assert.equal(Object.hasOwn(call.init.headers, 'Content-Type'), false);
  }
  const placement = apiRequests.find(call => call.url.includes('/placement'));
  assert.equal(placement.init.headers['Accept-Language'], 'nl');
  assert.equal(placement.init.method || 'GET', 'GET');
}

{
  const { client } = makeClient(async () => response(400, { error: 'bad request', request_id: 'bol-400' }, { 'x-request-id': 'bol-400' }, 'Bad Request'));
  await assert.rejects(client.getProductList({ searchTerm: 'fixture query', cacheMode: 'FORCE_REFRESH' }), error => {
    assert.equal(error.http_status, 400);
    assert.equal(error.http_status_text, 'Bad Request');
    assert.equal(error.response_received, true);
    assert.equal(error.safe_body.error, 'bad request');
    assert.equal(error.safe_headers['x-request-id'], 'bol-400');
    assert.equal(error.adapter_request_id.length > 0, true);
    assert.equal(error.endpoint, '/retailer/products/list');
    assert.equal(error.method, 'POST');
    assert.ok(error.request_params.body.searchTerm);
    assert.ok(error.started_at && error.finished_at);
    assert.equal(error.adapter_original_message, error.message);
    return true;
  });
}

for (const status of [401, 403]) {
  const { client } = makeClient(async () => response(status, {
    error: `rejected ${status}`, access_token: 'body-token-secret', client_secret: TEST_SECRET,
  }, { authorization: `Bearer ${TEST_SECRET}`, 'set-cookie': `sid=${TEST_SECRET}`, 'x-request-id': `bol-${status}` }));
  await assert.rejects(client.getProductList({ searchTerm: 'fixture query', cacheMode: 'FORCE_REFRESH' }), error => {
    assert.equal(error.http_status, status);
    assert.equal(error.response_received, true);
    assert.equal(error.safe_body.access_token, '[REDACTED]');
    assert.equal(error.safe_body.client_secret, '[REDACTED]');
    assert.equal(Object.hasOwn(error.safe_headers, 'authorization'), false);
    assert.equal(Object.hasOwn(error.safe_headers, 'set-cookie'), false);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(TEST_SECRET));
    assert.doesNotMatch(JSON.stringify(error), /body-token-secret/);
    return true;
  });
}

{
  const { client } = makeClient(async () => response(429, { error: 'slow down' }, { 'retry-after': '0', 'ratelimit-remaining': '0' }, 'Too Many Requests'));
  await assert.rejects(client.getProductList({ searchTerm: 'fixture query', cacheMode: 'FORCE_REFRESH' }), error => {
    assert.equal(error.http_status, 429);
    assert.equal(error.safe_headers['retry-after'], '0');
    assert.equal(error.safe_headers['ratelimit-remaining'], '0');
    return true;
  });
}

{
  const { client } = makeClient(async () => response(500, { error: 'temporary failure', access_token: 'must-redact' }, {}, 'Server Error'));
  await assert.rejects(client.getProductList({ searchTerm: 'fixture query', cacheMode: 'FORCE_REFRESH' }), error => {
    assert.equal(error.http_status, 500);
    assert.equal(error.safe_body.error, 'temporary failure');
    assert.equal(error.safe_body.access_token, '[REDACTED]');
    assert.equal(error.response_received, true);
    return true;
  });
}

for (const [label, transport, expectedCode, expectedClass] of [
  ['timeout', Object.assign(new Error(`timeout Bearer ${TEST_SECRET}`), { name: 'TimeoutError', code: 'ETIMEDOUT' }), 'ETIMEDOUT', 'TIMEOUT'],
  ['reset', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), 'ECONNRESET', 'CONNECTION_RESET'],
  ['tls', Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }), 'CERT_HAS_EXPIRED', 'TLS'],
]) {
  const { client } = makeClient(async () => { throw transport; });
  await assert.rejects(client.getProductList({ searchTerm: `fixture ${label}`, cacheMode: 'FORCE_REFRESH' }), error => {
    assert.ok(['BOL_NETWORK_ERROR', 'BOL_NETWORK_TIMEOUT'].includes(error.code));
    assert.equal(error.response_received, false);
    assert.equal(error.http_status, null);
    assert.equal(error.transport_code, expectedCode);
    assert.equal(error.transport_class, expectedClass);
    assert.ok(error.transport_message);
    assert.equal(error.safe_body, null);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(TEST_SECRET));
    return true;
  });
}

{
  const { client } = makeClient(async () => response(500, `non-json body ${'x'.repeat(20_000)}`, {}, 'Server Error'));
  await assert.rejects(client.getProductList({ searchTerm: 'fixture long body', cacheMode: 'FORCE_REFRESH' }), error => {
    assert.equal(error.http_status, 500);
    assert.equal(typeof error.safe_body, 'string');
    assert.ok(error.safe_body.length <= 4_200);
    assert.match(error.safe_body, /TRUNCATED/);
    return true;
  });
}

{
  const { client } = makeClient(async () => response(200, { sort: 'RELEVANCE', products: [] }));
  const result = await client.getProductList({ searchTerm: 'fixture success', cacheMode: 'FORCE_REFRESH' });
  assert.deepEqual(result.structuredResult, { sort: 'RELEVANCE', products: [] }, 'successful result contract remains unchanged');
}

console.log('API adapter diagnostic offline fixtures passed: HTTP 400/401/403/429/500, timeout, reset, TLS, redaction, truncation, and success contract.');

