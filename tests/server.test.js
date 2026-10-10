import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  MAX_PRICE_CAP,
  MAX_RUNTIME_M,
  handleRun,
  handleServe,
  handleStatus,
  handleLogs,
  handleDown,
  handleCheckResult,
  handleAiChat,
  handleLaunchAgentTask,
  handleCheckLaunchTask,
  MAX_JOB_COST,
  MAX_TOKENS_CAP,
} from '../src/handlers.js';

// ---------------------------------------------------------------------------
// TOOLS registry
// ---------------------------------------------------------------------------

describe('TOOLS registry', () => {
  it('exposes exactly 11 tools', () => {
    expect(TOOLS).toHaveLength(11);
  });

  it('includes all required tool names', () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toContain('badgr_run');
    expect(names).toContain('badgr_serve');
    expect(names).toContain('badgr_status');
    expect(names).toContain('badgr_logs');
    expect(names).toContain('badgr_down');
  });

  it('includes the Smithery-facing tool names', () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['run_workload', 'deploy_model', 'check_result']));
  });

  it('run_workload and deploy_model keep the same limits as badgr_run and badgr_serve', () => {
    const get = n => TOOLS.find(t => t.name === n);
    expect(get('run_workload').inputSchema).toEqual(get('badgr_run').inputSchema);
    expect(get('deploy_model').inputSchema).toEqual(get('badgr_serve').inputSchema);
    expect(get('deploy_model').inputSchema.required).toContain('max_runtime_minutes');
  });

  it('badgr_serve requires model and max_runtime_minutes', () => {
    const serve = TOOLS.find(t => t.name === 'badgr_serve');
    expect(serve.inputSchema.required).toContain('model');
    expect(serve.inputSchema.required).toContain('max_runtime_minutes');
  });

  it('badgr_logs requires deployment_id', () => {
    const logs = TOOLS.find(t => t.name === 'badgr_logs');
    expect(logs.inputSchema.required).toContain('deployment_id');
  });

  it('badgr_down requires deployment_id', () => {
    const down = TOOLS.find(t => t.name === 'badgr_down');
    expect(down.inputSchema.required).toContain('deployment_id');
  });

  it('badgr_run max_price_per_hour has a maximum cap', () => {
    const run = TOOLS.find(t => t.name === 'badgr_run');
    const prop = run.inputSchema.properties.max_price_per_hour;
    expect(prop.maximum).toBe(MAX_PRICE_CAP);
  });

  it('badgr_serve max_runtime_minutes has a maximum cap', () => {
    const serve = TOOLS.find(t => t.name === 'badgr_serve');
    const prop = serve.inputSchema.properties.max_runtime_minutes;
    expect(prop.maximum).toBe(MAX_RUNTIME_M);
  });

  it('each tool has a non-empty description', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// handleRun
// ---------------------------------------------------------------------------

describe('handleRun', () => {
  function mockApi(response) {
    return vi.fn().mockResolvedValue(response);
  }

  it('posts to /run and returns deployment fields', async () => {
    const dep = { deployment_id: 'dep-1', status: 'running', gpu_type: 'A100', cost_per_hour: 2.0, receipt_id: 'r1', logs_url: 'https://x' };
    const callApi = mockApi(dep);

    const result = await handleRun({ command: ['python', 'train.py'], gpu: 'A100' }, callApi);

    expect(callApi).toHaveBeenCalledWith('/run', expect.objectContaining({ method: 'POST' }));
    expect(result.deployment_id).toBe('dep-1');
    expect(result.status).toBe('running');
    expect(result.message).toContain('dep-1');
  });

  it('caps max_price_per_hour at MAX_PRICE_CAP', async () => {
    const callApi = mockApi({ deployment_id: 'dep-2', status: 'running' });
    await handleRun({ gpu: 'A100', max_price_per_hour: 999 }, callApi);

    const [, opts] = callApi.mock.calls[0];
    expect(opts.body.max_price_per_hour).toBe(MAX_PRICE_CAP);
  });

  it('uses MAX_PRICE_CAP when no max_price_per_hour provided', async () => {
    const callApi = mockApi({ deployment_id: 'dep-3', status: 'running' });
    await handleRun({ gpu: 'RTX_4090' }, callApi);

    const [, opts] = callApi.mock.calls[0];
    expect(opts.body.max_price_per_hour).toBe(MAX_PRICE_CAP);
  });

  it('normalises GPU name to uppercase with underscores', async () => {
    const callApi = mockApi({ deployment_id: 'dep-4', status: 'running' });
    await handleRun({ gpu: 'rtx-4090' }, callApi);

    const [, opts] = callApi.mock.calls[0];
    expect(opts.body.gpu).toBe('RTX_4090');
  });

  it('defaults to python:3.11-slim image when command is given', async () => {
    const callApi = mockApi({ deployment_id: 'dep-5', status: 'running' });
    await handleRun({ command: ['python', 'run.py'] }, callApi);

    const [, opts] = callApi.mock.calls[0];
    expect(opts.body.image).toMatch(/^python:3\.11-slim@sha256:[0-9a-f]{64}$/); // digest-pinned
  });
});

// ---------------------------------------------------------------------------
// handleServe
// ---------------------------------------------------------------------------

describe('handleServe', () => {
  function mockApi(response) {
    return vi.fn().mockResolvedValue(response);
  }

  it('throws when max_runtime_minutes is missing', async () => {
    const callApi = mockApi({});
    await expect(
      handleServe({ model: 'meta-llama/Llama-3.1-8B-Instruct' }, callApi)
    ).rejects.toThrow('max_runtime_minutes is required');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('throws when max_runtime_minutes is 0 (falsy)', async () => {
    const callApi = mockApi({});
    await expect(
      handleServe({ model: 'my/model', max_runtime_minutes: 0 }, callApi)
    ).rejects.toThrow('max_runtime_minutes is required');
  });

  it('caps max_runtime_minutes at MAX_RUNTIME_M', async () => {
    const dep = { deployment_id: 'dep-s1', model: 'my/model', status: 'running', endpoint_url: 'https://ep' };
    const callApi = mockApi(dep);

    const result = await handleServe({ model: 'my/model', max_runtime_minutes: 9999 }, callApi);

    const [, opts] = callApi.mock.calls[0];
    expect(opts.body.max_runtime_minutes).toBe(MAX_RUNTIME_M);
    expect(result.max_runtime_minutes).toBe(MAX_RUNTIME_M);
  });

  it('caps max_price_per_hour at MAX_PRICE_CAP', async () => {
    const dep = { deployment_id: 'dep-s2', model: 'my/model', status: 'running', endpoint_url: 'https://ep' };
    const callApi = mockApi(dep);

    await handleServe({ model: 'my/model', max_runtime_minutes: 30, max_price_per_hour: 100 }, callApi);

    const [, opts] = callApi.mock.calls[0];
    expect(opts.body.max_price_per_hour).toBe(MAX_PRICE_CAP);
  });

  it('returns endpoint_url and usage_example', async () => {
    const dep = { deployment_id: 'dep-s3', model: 'my/model', status: 'running', endpoint_url: 'https://ep.badgr.ai/v1' };
    const callApi = mockApi(dep);

    const result = await handleServe({ model: 'my/model', max_runtime_minutes: 30 }, callApi);
    expect(result.endpoint_url).toBe('https://ep.badgr.ai/v1');
    expect(result.usage_example).toContain('OpenAI');
    expect(result.warning).toContain('badgr_down');
  });

  it('uses openai_base_url over endpoint_url when both present', async () => {
    const dep = { deployment_id: 'dep-s4', status: 'running', endpoint_url: 'https://old', openai_base_url: 'https://new' };
    const callApi = mockApi(dep);

    const result = await handleServe({ model: 'my/model', max_runtime_minutes: 10 }, callApi);
    expect(result.endpoint_url).toBe('https://new');
  });
});

// ---------------------------------------------------------------------------
// handleStatus
// ---------------------------------------------------------------------------

describe('handleStatus', () => {
  it('returns empty message when no deployments', async () => {
    const callApi = vi.fn().mockResolvedValue({ deployments: [] });
    const result = await handleStatus(callApi);
    expect(result.deployments).toEqual([]);
    expect(result.message).toContain('No active deployments');
  });

  it('maps deployment fields correctly', async () => {
    const callApi = vi.fn().mockResolvedValue({
      deployments: [
        { deployment_id: 'dep-a', name: 'test', workload_type: 'run', model: null, gpu_type: 'A100', gpu_count: 2, status: 'running', cost_per_hour: 3.5, endpoint_url: null },
      ],
    });
    const result = await handleStatus(callApi);
    expect(result.count).toBe(1);
    expect(result.deployments[0].gpu).toBe('A100 × 2');
    expect(result.deployments[0].cost_per_hour).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------
// handleLogs
// ---------------------------------------------------------------------------

describe('handleLogs', () => {
  it('returns log lines and joined log_text', async () => {
    const callApi = vi.fn().mockResolvedValue({ logs: ['line 1', 'line 2', 'line 3'] });
    const result = await handleLogs({ deployment_id: 'dep-x' }, callApi);
    expect(result.lines).toHaveLength(3);
    expect(result.log_text).toBe('line 1\nline 2\nline 3');
    expect(result.deployment_id).toBe('dep-x');
  });

  it('handles missing logs field gracefully', async () => {
    const callApi = vi.fn().mockResolvedValue({});
    const result = await handleLogs({ deployment_id: 'dep-y' }, callApi);
    expect(result.lines).toEqual([]);
    expect(result.log_text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// handleDown
// ---------------------------------------------------------------------------

describe('handleDown', () => {
  it('calls DELETE and returns terminated status', async () => {
    const callApi = vi.fn().mockResolvedValue({ deployment_id: 'dep-z', status: 'terminated', receipt_id: 'r99' });
    const result = await handleDown({ deployment_id: 'dep-z' }, callApi);

    expect(callApi).toHaveBeenCalledWith('/deployments/dep-z', expect.objectContaining({ method: 'DELETE' }));
    expect(result.status).toBe('terminated');
    expect(result.message).toContain('Billing stopped');
  });
});

// ---------------------------------------------------------------------------
// Safety constants
// ---------------------------------------------------------------------------

describe('safety constants', () => {
  it('MAX_PRICE_CAP is a positive number', () => {
    expect(typeof MAX_PRICE_CAP).toBe('number');
    expect(MAX_PRICE_CAP).toBeGreaterThan(0);
  });

  it('MAX_RUNTIME_M is a positive integer', () => {
    expect(Number.isInteger(MAX_RUNTIME_M)).toBe(true);
    expect(MAX_RUNTIME_M).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// handleCheckResult
// ---------------------------------------------------------------------------

describe('handleCheckResult', () => {
  const dep = { deployment_id: 'dep-9', status: 'running', gpu_type: 'A100', gpu_count: 2, cost_per_hour: 3.0 };

  it('fetches deployment state and returns the last N log lines', async () => {
    const callApi = vi.fn()
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce({ logs: ['a', 'b', 'c', 'd'] });

    const result = await handleCheckResult({ deployment_id: 'dep-9', log_lines: 2 }, callApi);

    expect(callApi).toHaveBeenNthCalledWith(1, '/deployments/dep-9');
    expect(callApi).toHaveBeenNthCalledWith(2, '/deployments/dep-9/logs');
    expect(result.status).toBe('running');
    expect(result.gpu).toBe('A100 × 2');
    expect(result.lines).toEqual(['c', 'd']);
    expect(result.log_text).toBe('c\nd');
  });

  it('skips the logs call when log_lines is 0', async () => {
    const callApi = vi.fn().mockResolvedValue(dep);
    const result = await handleCheckResult({ deployment_id: 'dep-9', log_lines: 0 }, callApi);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result.lines).toEqual([]);
  });

  it('throws when deployment_id is missing', async () => {
    const callApi = vi.fn();
    await expect(handleCheckResult({}, callApi)).rejects.toThrow('deployment_id is required');
    expect(callApi).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AI API and Launch tools
// ---------------------------------------------------------------------------

describe('handleAiChat', () => {
  it('posts a non-streaming chat completion and returns content plus usage', async () => {
    const callApi = vi.fn().mockResolvedValue({
      model: 'm', choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { total_tokens: 7 },
    });
    const out = await handleAiChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, callApi);
    const [path, opts] = callApi.mock.calls[0];
    expect(path).toBe('/chat/completions');
    expect(opts.body).toMatchObject({ model: 'm', stream: false, max_tokens: 1024 });
    expect(out).toEqual({ model: 'm', content: 'hello', finish_reason: 'stop', usage: { total_tokens: 7 } });
  });

  it('caps max_tokens and rejects bad input without calling the API', async () => {
    const callApi = vi.fn().mockResolvedValue({ choices: [] });
    await handleAiChat({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10_000_000 }, callApi);
    expect(callApi.mock.calls[0][1].body.max_tokens).toBe(MAX_TOKENS_CAP);
    callApi.mockClear();
    await expect(handleAiChat({ model: 'm', messages: [] }, callApi)).rejects.toThrow('messages');
    await expect(handleAiChat({ messages: [{ role: 'user', content: 'x' }] }, callApi)).rejects.toThrow('model');
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('handleLaunchAgentTask', () => {
  const base = {
    repository: 'https://github.com/acme/app', instruction: 'fix tests', check: 'npm test',
    max_cost: 2, max_runtime_minutes: 30,
  };

  it('creates a capped agent job and returns its id', async () => {
    const callApi = vi.fn().mockResolvedValue({ job_id: 'job-1', status: 'queued', estimated_cost_usd: 2, status_url: 'u' });
    const out = await handleLaunchAgentTask(base, callApi);
    const [path, opts] = callApi.mock.calls[0];
    expect(path).toBe('/jobs');
    expect(opts.body).toEqual({
      type: 'agent',
      input: { repository: base.repository, instruction: 'fix tests', check: 'npm test', agent: 'claude' },
      policy: { max_cost: 2, max_runtime_minutes: 30 },
    });
    expect(out.job_id).toBe('job-1');
  });

  it('clamps cost and runtime to the server limits', async () => {
    const callApi = vi.fn().mockResolvedValue({ job_id: 'j' });
    await handleLaunchAgentTask({ ...base, max_cost: 9999, max_runtime_minutes: 9999 }, callApi);
    expect(callApi.mock.calls[0][1].body.policy).toEqual({ max_cost: MAX_JOB_COST, max_runtime_minutes: MAX_RUNTIME_M });
  });

  it.each([
    [{ repository: 'https://example.com/x' }, 'repository'],
    [{ instruction: ' ' }, 'instruction'],
    [{ check: '' }, 'check'],
    [{ agent: 'nope' }, 'agent'],
    [{ max_cost: 0 }, 'max_cost'],
    [{ max_runtime_minutes: undefined }, 'max_runtime_minutes'],
  ])('rejects %j without calling the API', async (patch, msg) => {
    const callApi = vi.fn();
    await expect(handleLaunchAgentTask({ ...base, ...patch }, callApi)).rejects.toThrow(msg);
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('handleCheckLaunchTask', () => {
  it('returns status, receipt and the last log lines', async () => {
    const callApi = vi.fn()
      .mockResolvedValueOnce({ job_id: 'job-2', status: 'succeeded', accrued_cost_usd: 0.4, receipt: { total_usd: 0.4 }, output: { ok: true } })
      .mockResolvedValueOnce({ logs: 'a\nb\nc' });
    const out = await handleCheckLaunchTask({ job_id: 'job-2', log_lines: 2 }, callApi);
    expect(callApi).toHaveBeenNthCalledWith(1, '/jobs/job-2');
    expect(callApi).toHaveBeenNthCalledWith(2, '/jobs/job-2/logs');
    expect(out).toMatchObject({ status: 'succeeded', receipt: { total_usd: 0.4 }, lines: ['b', 'c'] });
  });

  it('rejects a path-escaping job id', async () => {
    const callApi = vi.fn();
    await expect(handleCheckLaunchTask({ job_id: '../x' }, callApi)).rejects.toThrow('job_id');
    expect(callApi).not.toHaveBeenCalled();
  });
});
