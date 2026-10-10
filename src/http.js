/**
 * Authenticated streamable-HTTP entrypoint for badgr-mcp (hosted use, e.g.
 * Smithery). Stateless: each POST /mcp builds its own server, authenticated
 * with the caller's own Badgr key from `Authorization: Bearer <key>`, so one
 * hosted instance never spends another user's credits.
 */

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBadgrServer } from './create-server.js';

const MAX_BODY_BYTES = 1_000_000;

export function bearerToken(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  return m ? m[1] : '';
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createHttpHandler({ baseUrl, fetchImpl }) {
  return async function handler(req, res) {
    const path = (req.url || '').split('?')[0];
    if (path === '/health') return sendJson(res, 200, { status: 'ok' });
    if (path !== '/mcp') return sendJson(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
    }

    // Never fall back to a server-side key: an unauthenticated caller must not be able to spend the host's credits.
    const apiKey = bearerToken(req.headers.authorization);
    if (!apiKey) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="badgr-mcp"');
      return sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Missing Badgr API key. Send Authorization: Bearer <key>.' }, id: null });
    }

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Invalid request body: ${err.message}` }, id: null });
    }

    const server = createBadgrServer({ apiKey, baseUrl, fetchImpl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: `Internal error: ${err.message}` }, id: null });
    }
  };
}

export function startHttpServer({ port, baseUrl, fetchImpl, host = '0.0.0.0' }) {
  const server = http.createServer(createHttpHandler({ baseUrl, fetchImpl }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      process.stderr.write(`badgr-mcp listening on http://${host}:${server.address().port}/mcp\n`);
      resolve(server);
    });
  });
}
