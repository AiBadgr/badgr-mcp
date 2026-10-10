import { describe, it, expect, vi } from 'vitest';
import {
  createToolkit, resolveLimits, pathId, dispatch, TOOLS,
  handleLogs, handleDown, handleCheckResult, handleCheckLaunchTask,
} from '../src/handlers.js';

describe('resolveLimits', () => {
  it('reads the BADGR_* names', () => {
    expect(resolveLimits({ BADGR_MAX_PRICE: '2.5', BADGR_MAX_RUNTIME: '20', BADGR_MAX_JOB_COST: '1.5' }))
      .toEqual({ maxPrice: 2.5, maxRuntime: 20, maxJobCost: 1.5 });
  });
  it('also reads the Worker-style names', () => {
    expect(resolveLimits({ MAX_PRICE_PER_HOUR: '3', MAX_RUNTIME_MINUTES: '45', MAX_JOB_COST: '2' }))
      .toEqual({ maxPrice: 3, maxRuntime: 45, maxJobCost: 2 });
  });
  it('falls back to safe defaults for missing, zero, negative or non-numeric values', () => {
    const defaults = { maxPrice: 5, maxRuntime: 60, maxJobCost: 5 };
    expect(resolveLimits({})).toEqual(defaults);
    expect(resolveLimits({ BADGR_MAX_PRICE: '0', BADGR_MAX_RUNTIME: '-1', BADGR_MAX_JOB_COST: 'abc' })).toEqual(defaults);
  });
});

describe('createToolkit with custom limits', () => {
  const kit = createToolkit({ maxPrice: 1, maxRuntime: 10, maxJobCost: 0.5 });

  it('puts the limits in the tool schemas', () => {
    const get = n => kit.TOOLS.find(t => t.name === n).inputSchema.properties;
    expect(get('badgr_run').max_price_per_hour.maximum).toBe(1);
    expect(get('badgr_serve').max_runtime_minutes.maximum).toBe(10);
    expect(get('launch_agent_task').max_cost.maximum).toBe(0.5);
  });

  it('clamps what handlers send, whatever the agent asks for', async () => {
    const callApi = vi.fn().mockResolvedValue({});
    await kit.handleRun({ command: ['x'], max_price_per_hour: 99 }, callApi);
    await kit.handleServe({ model: 'm', max_runtime_minutes: 999, max_price_per_hour: 99 }, callApi);
    await kit.handleLaunchAgentTask({ repository: 'https://github.com/a/b', instruction: 'i', check: 'c', max_cost: 99, max_runtime_minutes: 999 }, callApi);
    expect(callApi.mock.calls[0][1].body.max_price_per_hour).toBe(1);
    expect(callApi.mock.calls[1][1].body).toMatchObject({ max_price_per_hour: 1, max_runtime_minutes: 10 });
    expect(callApi.mock.calls[2][1].body.policy).toEqual({ max_cost: 0.5, max_runtime_minutes: 10 });
  });

  it('does not share state between toolkits', () => {
    const other = createToolkit({ maxPrice: 9, maxRuntime: 90, maxJobCost: 9 });
    expect(other.TOOLS.find(t => t.name === 'badgr_run').inputSchema.properties.max_price_per_hour.maximum).toBe(9);
    expect(kit.TOOLS.find(t => t.name === 'badgr_run').inputSchema.properties.max_price_per_hour.maximum).toBe(1);
  });
});

describe('dispatch', () => {
  const callApi = vi.fn().mockResolvedValue({ deployments: [], logs: [], choices: [], job_id: 'j' });

  it('routes every advertised tool name to a handler', async () => {
    const args = {
      badgr_run: { command: ['x'] }, run_workload: { command: ['x'] },
      badgr_serve: { model: 'm', max_runtime_minutes: 5 }, deploy_model: { model: 'm', max_runtime_minutes: 5 },
      badgr_status: {}, badgr_logs: { deployment_id: 'd' }, badgr_down: { deployment_id: 'd' },
      check_result: { deployment_id: 'd' }, ai_chat: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      launch_agent_task: { repository: 'https://github.com/a/b', instruction: 'i', check: 'c', max_cost: 1, max_runtime_minutes: 5 },
      check_launch_task: { job_id: 'j' },
    };
    expect(Object.keys(args).sort()).toEqual(TOOLS.map(t => t.name).sort());
    for (const [name, a] of Object.entries(args)) {
      expect(await dispatch(name, a, callApi), name).not.toBeUndefined();
    }
  });

  it('returns undefined for an unknown tool', async () => {
    expect(await dispatch('nope', {}, callApi)).toBeUndefined();
  });
});

describe('pathId: model-supplied ids cannot change the request route', () => {
  it('accepts normal ids and percent-encodes odd characters', () => {
    expect(pathId('dep-abc_123')).toBe('dep-abc_123');
    expect(pathId('a b')).toBe('a%20b');
  });
  it.each(['', undefined, null, '.', '..', '../x', 'a/b', 'a\\b'])('rejects %j', (bad) => {
    expect(() => pathId(bad)).toThrow('is required');
  });

  it.each([
    ['handleLogs', a => handleLogs(a, vi.fn())],
    ['handleDown', a => handleDown(a, vi.fn())],
    ['handleCheckResult', a => handleCheckResult(a, vi.fn())],
  ])('%s refuses a traversal id without calling the API', async (_n, run) => {
    for (const bad of ['..', '../x', 'a/b']) {
      await expect(run({ deployment_id: bad })).rejects.toThrow('deployment_id');
    }
  });

  it('handleCheckLaunchTask refuses a traversal job id', async () => {
    const callApi = vi.fn();
    await expect(handleCheckLaunchTask({ job_id: '../x' }, callApi)).rejects.toThrow('job_id');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('handleLogs and handleDown call the encoded path for a good id', async () => {
    const callApi = vi.fn().mockResolvedValue({ logs: ['a'], deployment_id: 'd1', status: 'stopped' });
    await handleLogs({ deployment_id: 'd1' }, callApi);
    await handleDown({ deployment_id: 'd1' }, callApi);
    expect(callApi).toHaveBeenNthCalledWith(1, '/deployments/d1/logs');
    expect(callApi).toHaveBeenNthCalledWith(2, '/deployments/d1', { method: 'DELETE' });
  });
});
