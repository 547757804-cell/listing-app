import http from 'node:http';

const dataRoot = process.env.BOL_RUNTIME_STUB_DATA_ROOT;
if (!dataRoot) process.exit(2);
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/dashboard') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data_root: dataRoot, runtime_environment: 'ACCEPTANCE_4181' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/integrations/bol/readiness') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'PASS', checked_at: '2026-09-26T12:00:00.000Z' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/__shutdown') {
    res.writeHead(204);
    res.end();
    server.close();
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`READY|${address.port}\n`);
});
