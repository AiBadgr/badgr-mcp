import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { TOOLS } from '../src/handlers.js';
import { SERVER_VERSION } from '../src/create-server.js';

// Registry and docs files are easy to forget when a tool or setting changes. These tests fail when they drift.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const read = (...p) => readFileSync(join(...p), 'utf-8');
const toolNames = TOOLS.map(t => t.name);

describe('package metadata', () => {
  const pkg = JSON.parse(read(root, 'package.json'));
  it('version matches what the server reports', () => {
    expect(pkg.version).toBe(SERVER_VERSION);
  });
  it('bin points at an existing file', () => {
    expect(existsSync(join(root, pkg.bin['badgr-mcp']))).toBe(true);
  });
});

describe('smithery.yaml', () => {
  const cfg = yaml.load(read(root, 'smithery.yaml'));
  const start = cfg.startCommand;
  const fn = new Function(`return ${start.commandFunction}`)();

  it('describes a stdio server built from the Dockerfile', () => {
    expect(start.type).toBe('stdio');
    expect(cfg.build.dockerfile).toBe('Dockerfile');
    expect(existsSync(join(root, cfg.build.dockerfile))).toBe(true);
  });

  it('maps every config field to an env var the code reads', () => {
    const out = fn({ badgrApiKey: 'k', maxPricePerHour: 2, maxRuntimeMinutes: 15, maxJobCost: 1, baseUrl: 'https://x/v1' });
    expect(out.command).toBe('node');
    expect(existsSync(join(root, out.args[0]))).toBe(true);
    expect(out.env).toEqual({
      BADGR_API_KEY: 'k', BADGR_MAX_PRICE: '2', BADGR_MAX_JOB_COST: '1', BADGR_MAX_RUNTIME: '15', BADGR_BASE_URL: 'https://x/v1',
    });
    const source = read(root, 'src', 'handlers.js') + read(root, 'src', 'server.js');
    for (const name of Object.keys(out.env)) expect(source, name).toContain(name);
  });

  it('uses safe defaults when optional fields are omitted', () => {
    const out = fn({ badgrApiKey: 'k' });
    expect(out.env).toMatchObject({ BADGR_MAX_PRICE: '5', BADGR_MAX_RUNTIME: '60', BADGR_MAX_JOB_COST: '5', BADGR_BASE_URL: 'https://aibadgr.com/v1' });
  });

  it('requires the API key and exposes only fields the command function uses', () => {
    expect(start.configSchema.required).toEqual(['badgrApiKey']);
    for (const field of Object.keys(start.configSchema.properties)) expect(start.commandFunction, field).toContain(field);
  });
});

describe('Dockerfile', () => {
  const docker = read(root, 'Dockerfile');
  it('installs production dependencies and fails the build if the SDK is unusable', () => {
    expect(docker).toContain('npm ci --omit=dev');
    expect(docker).toContain("import('@modelcontextprotocol/sdk/server/index.js')");
  });
  it('copies the source and starts the stdio server', () => {
    expect(docker).toContain('COPY src ./src');
    expect(docker).toContain('"src/server.js"');
  });
});

describe('Docker MCP registry entry', () => {
  const dir = join(repo, 'integrations', 'docker-mcp-registry', 'servers', 'badgr');
  const server = yaml.load(read(dir, 'server.yaml'));
  const tools = JSON.parse(read(dir, 'tools.json'));

  it('lists exactly the tools the server exposes', () => {
    expect(tools.map(t => t.name).sort()).toEqual([...toolNames].sort());
    for (const t of tools) expect(t.description.length, t.name).toBeGreaterThan(10);
  });

  it('declares the key as a secret and every setting the server reads', () => {
    expect(server.config.secrets[0]).toMatchObject({ env: 'BADGR_API_KEY' });
    const envNames = server.config.env.map(e => e.name).sort();
    expect(envNames).toEqual(['BADGR_MAX_JOB_COST', 'BADGR_MAX_PRICE', 'BADGR_MAX_RUNTIME']);
    // Each env value must reference a parameter that is defined.
    const params = Object.keys(server.config.parameters.properties);
    for (const e of server.config.env) {
      const ref = /\{\{badgr\.(\w+)\}\}/.exec(e.value)[1];
      expect(params, e.name).toContain(ref);
    }
  });

  it('points at the aibadgr org and still marks the commit as a placeholder', () => {
    expect(server.source.project).toBe('https://github.com/aibadgr/badgr-mcp');
    // Fails on purpose once a real commit is filled in, so this reminder is removed with it.
    expect(server.source.commit).toBe('REPLACE_WITH_RELEASE_COMMIT');
  });
});

describe('glama.json', () => {
  it('has a schema and at least one maintainer', () => {
    const g = JSON.parse(read(root, 'glama.json'));
    expect(g.$schema).toContain('glama.ai');
    expect(g.maintainers.length).toBeGreaterThan(0);
  });
});

describe('docs mention every tool', () => {
  it.each([
    ['package README', () => read(root, 'README.md')],
    ['site docs page', () => read(repo, 'frontend', 'app', 'docs', 'badgr-mcp', 'page.tsx')],
  ])('%s', (_label, get) => {
    const text = get();
    const missing = toolNames.filter(n => !text.includes(n));
    expect(missing).toEqual([]);
  });
});
