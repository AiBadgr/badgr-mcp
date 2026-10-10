import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the real src/server.js as a child process, in both modes. No Badgr network access is needed.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function start(env) {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: '', BADGR_API_KEY: '', ...env } });
  let out = ''; let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const waitFor = (get, re, ms = 8000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const m = re.exec(get());
      if (m) return resolve(m);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${re}; stderr=${err}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  return { child, waitOut: re => waitFor(() => out, re), waitErr: re => waitFor(() => err, re) };
}

describe('server.js entry point', () => {
  it('serves authenticated HTTP when PORT is set', async () => {
    const p = start({ PORT: '0' });
    try {
      const [, port] = await p.waitErr(/listening on http:\/\/[\d.]+:(\d+)\/mcp/);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toEqual({ status: 'ok' });
      const noKey = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(noKey.status).toBe(401);
    } finally { p.child.kill(); }
  });

  it('serves stdio otherwise, even with a server-side key set', async () => {
    const p = start({ BADGR_API_KEY: 'x' });
    try {
      const send = m => p.child.stdin.write(JSON.stringify(m) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      await p.waitOut(/"id":1/);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const [line] = await p.waitOut(/\{[^\n]*"id":2[^\n]*\}/);
      const names = JSON.parse(line).result.tools.map(t => t.name);
      expect(names).toEqual(expect.arrayContaining(['badgr_run', 'run_workload', 'ai_chat', 'launch_agent_task']));
      expect(names).toHaveLength(11);
    } finally { p.child.kill(); }
  });

  it('also serves HTTP when started with --http', async () => {
    const child = spawn(process.execPath, ['src/server.js', '--http'], { cwd: root, env: { ...process.env, PORT: '0' } });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    await new Promise(r => setTimeout(r, 1500));
    child.kill();
    expect(err).toContain('listening on');
  });
});
