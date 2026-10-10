import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBadgrApi, createBadgrServer, SERVER_VERSION } from '../src/create-server.js';

// Real MCP server and client joined by the SDK's in-memory transport; only Badgr's HTTP API is faked.
async function connect(fetchImpl, apiKey = 'k') {
  const server = createBadgrServer({ apiKey, baseUrl: 'http://api.test/v1', fetchImpl });
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const ok = (body) => vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(body) }));
const text = (res) => res.content[0].text;

describe('createBadgrApi', () => {
  it('sends the bearer key and JSON body to baseUrl + path', async () => {
    const fetchImpl = ok({ a: 1 });
    const api = createBadgrApi({ apiKey: 'sekret', baseUrl: 'http://api.test/v1', fetchImpl });
    expect(await api('/run', { method: 'POST', body: { x: 1 } })).toEqual({ a: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://api.test/v1/run');
    expect(init).toMatchObject({ method: 'POST', body: '{"x":1}' });
    expect(init.headers.Authorization).toBe('Bearer sekret');
  });

  it('defaults to GET with no body', async () => {
    const fetchImpl = ok({});
    await createBadgrApi({ apiKey: 'k', baseUrl: 'http://api.test/v1', fetchImpl })('/deployments');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('refuses to call without a key', async () => {
    const fetchImpl = ok({});
    await expect(createBadgrApi({ apiKey: '', baseUrl: 'x', fetchImpl })('/p')).rejects.toThrow('BADGR_API_KEY not set');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a non-2xx response into an error with status and body', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 402, text: async () => 'no credits' }));
    await expect(createBadgrApi({ apiKey: 'k', baseUrl: 'http://x', fetchImpl })('/run', { method: 'POST', body: {} }))
      .rejects.toThrow('POST /run → 402: no credits');
  });
});

describe('createBadgrServer over a real MCP transport', () => {
  it('advertises its version and the full tool list', async () => {
    const client = await connect(ok({}));
    expect(client.getServerVersion()).toMatchObject({ name: 'badgr-mcp', version: SERVER_VERSION });
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['run_workload', 'ai_chat', 'launch_agent_task', 'badgr_down']));
  });

  it('runs a tool end to end and returns JSON text', async () => {
    const fetchImpl = ok({ deployment_id: 'dep-s1', status: 'running' });
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: 'run_workload', arguments: { command: ['echo', 'hi'] } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).deployment_id).toBe('dep-s1');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://api.test/v1/run');
  });

  it('reports an unknown tool as an error result', async () => {
    const res = await (await connect(ok({}))).callTool({ name: 'nope', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Unknown tool: nope');
  });

  it('reports handler and API failures as error results, not protocol errors', async () => {
    const bad = await (await connect(ok({}))).callTool({ name: 'badgr_down', arguments: { deployment_id: '../x' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('deployment_id is required');
    const down = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    const res = await (await connect(down)).callTool({ name: 'badgr_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('500');
  });

  it('errors clearly when the server has no key', async () => {
    const res = await (await connect(ok({}), '')).callTool({ name: 'badgr_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('BADGR_API_KEY not set');
  });
});
