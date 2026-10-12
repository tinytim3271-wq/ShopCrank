/**
 * HTTP bridge for local OEM diagnostics demo (development / CI walkthrough).
 * Wraps the same JSON-RPC logic as the named-pipe host.
 */
const http = require('node:http');
const { handleRequest } = require('./index');

const PORT = Number(process.env.SHOP_CRANK_J2534_HTTP_PORT || 39254);

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3000');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000') {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/rpc') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  // Cap request bodies to guard the local bridge against unbounded memory use.
  const MAX_BODY_BYTES = 256 * 1024;
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const request = JSON.parse(body);
      const response = handleRequest(request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`J2534 HTTP bridge listening on http://127.0.0.1:${PORT}/rpc\n`);
  });
}

module.exports = { server, PORT };
