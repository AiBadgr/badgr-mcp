import { describe, it, expect, vi, afterEach } from 'vitest';
import { startHttpServer, bearerToken } from '../src/http.js';

// Real HTTP server + real MCP transport; only the Badgr API (fetchImpl) is mocked.
let server;
afterEach(() => new Promise(r => (server ? server.close(r) : r())));

async function boot(opts = {}) {
  const fetchImpl = vi.fn(async (url) => ({
    ok: true,
    text: async () => JSON.stringify(url.endsWith('/logs') ? { logs: ['x', 'y'] } : { deployment_id: 'dep-h1', status: 'running' }),
  }));
  server = await startHttpServer({ port: 0, host: '127.0.0.1', baseUrl: 'http://api.test/v1', fetchImpl, ...opts });
  return { url: `http://127.0.0.1:${server.address().port}`, fetchImpl };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const headers = (extra = {}) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...extra,
});

describe('badgr-mcp HTTP transport', () => {
  it('parses bearer tokens', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBe('');
    expect(bearerToken(undefined)).toBe('');
  });

  it('answers /health without auth', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects /mcp without a Badgr key', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: headers(), body: rpc(1, 'tools/list') });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('never falls back to a server-side key, even if one is passed in', async () => {
    const { url, fetchImpl } = await boot({ defaultApiKey: 'host-owners-secret' });
    const res = await fetch(`${url}/mcp`, {
      method: 'POST', headers: headers(),
      body: rpc(1, 'tools/call', { name: 'badgr_status', arguments: {} }),
    });
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-POST and malformed bodies', async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/mcp`, { headers: headers({ Authorization: 'Bearer k' }) })).status).toBe(405);
    const bad = await fetch(`${url}/mcp`, { method: 'POST', headers: headers({ Authorization: 'Bearer k' }), body: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('lists all tools for an authenticated caller', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/mcp`, { method: 'POST', headers: headers({ Authorization: 'Bearer k' }), body: rpc(1, 'tools/list') });
    const json = await res.json();
    expect(json.result.tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['run_workload', 'deploy_model', 'check_result', 'badgr_down']),
    );
  });

  it("calls the Badgr API with the caller's own key, not a shared one", async () => {
    const { url, fetchImpl } = await boot();
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: headers({ Authorization: 'Bearer caller-key' }),
      body: rpc(2, 'tools/call', { name: 'run_workload', arguments: { command: ['echo', 'hi'] } }),
    });
    const json = await res.json();
    expect(JSON.parse(json.result.content[0].text).deployment_id).toBe('dep-h1');
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('http://api.test/v1/run');
    expect(init.headers.Authorization).toBe('Bearer caller-key');
  });
});
