/**
 * Badgr MCP tool definitions and handlers.
 *
 * `createToolkit(limits)` builds the tool list and handlers for one set of spending limits, so
 * the stdio server, the HTTP server and the Cloudflare Worker share one implementation and cannot
 * drift. The named exports at the bottom are the toolkit for limits read from the environment.
 */

export const MAX_TOKENS_CAP = 4096;
export const LAUNCH_AGENTS = ['claude', 'codex', 'cline', 'opencode', 'commandcode', 'playwright'];

/** A single URL path segment from model-supplied input; rejects anything that could change the route. */
export function pathId(value, label = 'deployment_id') {
  const id = String(value ?? '');
  if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') throw new Error(`${label} is required.`);
  return encodeURIComponent(id);
}

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Limits from BADGR_MAX_PRICE, BADGR_MAX_RUNTIME and BADGR_MAX_JOB_COST (or Worker-style names). */
export function resolveLimits(env = globalThis.process?.env ?? {}) {
  return {
    maxPrice:   positive(env.BADGR_MAX_PRICE ?? env.MAX_PRICE_PER_HOUR, 5.0),
    maxRuntime: Math.trunc(positive(env.BADGR_MAX_RUNTIME ?? env.MAX_RUNTIME_MINUTES, 60)),
    maxJobCost: positive(env.BADGR_MAX_JOB_COST ?? env.MAX_JOB_COST, 5.0),
  };
}

export function createToolkit(limits = resolveLimits()) {
  const MAX_PRICE_CAP = limits.maxPrice;
  const MAX_RUNTIME_M = limits.maxRuntime;
  const MAX_JOB_COST  = limits.maxJobCost;

  const TOOLS = [
    {
      name: 'badgr_run',
      description: [
        'Run a one-off GPU job via Badgr.',
        'Returns deployment_id, status, receipt_id, logs_url.',
        `Hard limits: max_price_per_hour ≤ $${MAX_PRICE_CAP}/hr.`,
        'Always confirm with the user before running jobs that cost > $1/hr.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Container command, e.g. ["python", "train.py", "--epochs", "10"]',
          },
          image: {
            type: 'string',
            description: 'Docker image (default: python:3.11-slim)',
          },
          gpu: {
            type: 'string',
            description: 'GPU type: RTX_4090, A100, L40S, H100 (default: RTX_4090)',
            default: 'RTX_4090',
          },
          gpu_count: {
            type: 'integer',
            description: 'Number of GPUs (default: 1)',
            minimum: 1,
            maximum: 8,
            default: 1,
          },
          region: {
            type: 'string',
            description: 'Optional region preference.',
          },
          max_price_per_hour: {
            type: 'number',
            description: `Max spend cap in USD/hr (hard limit: $${MAX_PRICE_CAP}/hr)`,
            maximum: MAX_PRICE_CAP,
          },
          name: {
            type: 'string',
            description: 'Job name (auto-generated if omitted)',
          },
        },
      },
    },
    {
      name: 'badgr_serve',
      description: [
        'Provision a persistent OpenAI-compatible endpoint for an LLM model.',
        'Returns endpoint_url, deployment_id, receipt_id.',
        'The endpoint stays up (billing runs) until badgr_down is called.',
        `Hard limits: max_price_per_hour ≤ $${MAX_PRICE_CAP}/hr.`,
        'max_runtime_minutes is REQUIRED — agents must not create open-ended billing.',
        'Always confirm with the user before serving.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['model', 'max_runtime_minutes'],
        properties: {
          model: {
            type: 'string',
            description: 'HuggingFace model ID, e.g. meta-llama/Llama-3.1-8B-Instruct',
          },
          max_runtime_minutes: {
            type: 'integer',
            description: 'Auto-terminate after this many minutes. Required — prevents runaway billing.',
            minimum: 1,
            maximum: MAX_RUNTIME_M,
          },
          gpu: {
            type: 'string',
            description: 'GPU type: L40S, A100, H100, RTX_4090 (default: L40S)',
            default: 'L40S',
          },
          gpu_count: {
            type: 'integer',
            description: 'Number of GPUs (default: 1)',
            minimum: 1,
            maximum: 8,
            default: 1,
          },
          region: {
            type: 'string',
            description: 'Optional region preference.',
          },
          max_price_per_hour: {
            type: 'number',
            description: `Max spend cap in USD/hr (hard limit: $${MAX_PRICE_CAP}/hr)`,
            maximum: MAX_PRICE_CAP,
          },
          name: {
            type: 'string',
            description: 'Deployment name (auto-generated if omitted)',
          },
        },
      },
    },
    {
      name: 'badgr_status',
      description: 'List active Badgr GPU deployments for this account.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'badgr_logs',
      description: 'Fetch logs for a Badgr deployment.',
      inputSchema: {
        type: 'object',
        required: ['deployment_id'],
        properties: {
          deployment_id: {
            type: 'string',
            description: 'Deployment ID (returned by badgr_run or badgr_serve)',
          },
        },
      },
    },
    {
      name: 'badgr_down',
      description: 'Terminate a Badgr deployment and stop billing.',
      inputSchema: {
        type: 'object',
        required: ['deployment_id'],
        properties: {
          deployment_id: {
            type: 'string',
            description: 'Deployment ID to terminate',
          },
        },
      },
    },
  ];

  // Smithery-facing tool names. run_workload and deploy_model share the schema,
  // limits and handlers of badgr_run and badgr_serve; check_result is new.
  const byName = (n) => TOOLS.find(t => t.name === n);

  TOOLS.push(
    {
      ...byName('badgr_run'),
      name: 'run_workload',
      description: byName('badgr_run').description,
    },
    {
      ...byName('badgr_serve'),
      name: 'deploy_model',
      description: byName('badgr_serve').description,
    },
    {
      name: 'check_result',
      description: [
        'Check the state of one Badgr deployment and fetch its most recent log lines.',
        'Use after run_workload or deploy_model, with the returned deployment_id.',
        'Call badgr_down when the deployment is finished so billing stops.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['deployment_id'],
        properties: {
          deployment_id: {
            type: 'string',
            description: 'Deployment ID returned by run_workload or deploy_model',
          },
          log_lines: {
            type: 'integer',
            description: 'Number of most recent log lines to return (default: 50)',
            minimum: 0,
            maximum: 500,
            default: 50,
          },
        },
      },
    },
  );

  // AI API (metered inference) and Launch (agent jobs) tools.

  TOOLS.push(
    {
      name: 'ai_chat',
      description: [
        'Call the Badgr AI API (OpenAI-compatible chat completion) and return the reply with token usage.',
        `max_tokens is capped at ${MAX_TOKENS_CAP} per call. Usage is metered.`,
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['model', 'messages'],
        properties: {
          model: { type: 'string', description: 'Model ID to call' },
          messages: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                content: { type: 'string' },
              },
            },
          },
          max_tokens: { type: 'integer', minimum: 1, maximum: MAX_TOKENS_CAP, default: 1024 },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
        },
      },
    },
    {
      name: 'launch_agent_task',
      description: [
        'Launch an autonomous coding agent on a GitHub repository. The job is verified by running `check`.',
        `max_cost is REQUIRED (hard limit $${MAX_JOB_COST}); max_runtime_minutes is REQUIRED (limit ${MAX_RUNTIME_M}).`,
        'Returns a job_id: poll with check_launch_task, and read the receipt when it finishes.',
        'Always confirm with the user before launching.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['repository', 'instruction', 'check', 'max_cost', 'max_runtime_minutes'],
        properties: {
          repository: { type: 'string', description: 'GitHub repository URL (https://github.com/owner/repo)' },
          instruction: { type: 'string', description: 'What the agent should do' },
          check: { type: 'string', description: 'Shell command that must succeed for the task to count as done' },
          agent: { type: 'string', enum: LAUNCH_AGENTS, default: 'claude' },
          max_cost: { type: 'number', exclusiveMinimum: 0, maximum: MAX_JOB_COST, description: `Hard cost cap in USD (max ${MAX_JOB_COST})` },
          max_runtime_minutes: { type: 'integer', minimum: 1, maximum: MAX_RUNTIME_M },
        },
      },
    },
    {
      name: 'check_launch_task',
      description: 'Check an agent task started with launch_agent_task: status, cost so far, verification output, receipt and recent log lines.',
      inputSchema: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'job_id returned by launch_agent_task' },
          log_lines: { type: 'integer', minimum: 0, maximum: 500, default: 50 },
        },
      },
    },
  );

  // ---------------------------------------------------------------------------
  // Handlers — each accepts (args, callApi) so they are unit-testable
  // ---------------------------------------------------------------------------

  async function handleRun(args, callApi) {
    const maxPrice = Math.min(args.max_price_per_hour ?? MAX_PRICE_CAP, MAX_PRICE_CAP);

    const dep = await callApi('/run', {
      method: 'POST',
      body: {
        command:            args.command,
        image:              args.image || 'python:3.11-slim@sha256:0dd364ba7e10242f07755449e3a3d0e35f9efd987952737b90def6709ab0c5ce',
        gpu:                (args.gpu || 'RTX_4090').toUpperCase().replace('-', '_'),
        gpu_count:          args.gpu_count || 1,
        region:             args.region,
        max_price_per_hour: maxPrice,
        name:               args.name,
      },
    });

    return {
      deployment_id: dep.deployment_id,
      status:        dep.status,
      gpu_type:      dep.gpu_type,
      cost_per_hour: dep.cost_per_hour,
      receipt_id:    dep.receipt_id,
      logs_url:      dep.logs_url,
      message:       `Job started. Stream logs: badgr logs ${dep.deployment_id}`,
    };
  }

  async function handleServe(args, callApi) {
    if (!args.max_runtime_minutes) {
      throw new Error(
        'max_runtime_minutes is required for badgr_serve. ' +
        'Agents must not create open-ended billing. ' +
        `Max allowed: ${MAX_RUNTIME_M} minutes.`
      );
    }
    const runtimeMinutes = Math.min(args.max_runtime_minutes, MAX_RUNTIME_M);
    const maxPrice = Math.min(args.max_price_per_hour ?? MAX_PRICE_CAP, MAX_PRICE_CAP);

    const dep = await callApi('/serve', {
      method: 'POST',
      body: {
        model:               args.model,
        gpu:                 (args.gpu || 'L40S').toUpperCase().replace('-', '_'),
        gpu_count:           args.gpu_count || 1,
        region:              args.region || 'US',
        max_price_per_hour:  maxPrice,
        max_runtime_minutes: runtimeMinutes,
        name:                args.name,
      },
    });

    const endpointUrl = dep.openai_base_url || dep.endpoint_url;

    return {
      deployment_id:       dep.deployment_id,
      model:               dep.model || args.model,
      status:              dep.status,
      endpoint_url:        endpointUrl,
      openai_base_url:     endpointUrl,
      cost_per_hour:       dep.cost_per_hour,
      receipt_id:          dep.receipt_id,
      max_runtime_minutes: runtimeMinutes,
      usage_example:       `from openai import OpenAI\nclient = OpenAI(api_key="sk-...", base_url="${endpointUrl}")\nclient.chat.completions.create(model="${dep.model || args.model}", messages=[...])`,
      warning:             `Billing runs until you call badgr_down or ${runtimeMinutes} minutes elapse (auto-terminate). Call badgr_down when done.`,
    };
  }

  async function handleStatus(callApi) {
    const data = await callApi('/deployments');
    const deps = data.deployments || [];
    if (deps.length === 0) return { deployments: [], message: 'No active deployments.' };
    return {
      count: deps.length,
      deployments: deps.map(d => ({
        deployment_id: d.deployment_id,
        name:          d.name,
        type:          d.workload_type,
        model:         d.model,
        gpu:           `${d.gpu_type} × ${d.gpu_count}`,
        status:        d.status,
        cost_per_hour: d.cost_per_hour,
        endpoint_url:  d.endpoint_url,
      })),
    };
  }

  async function handleLogs(args, callApi) {
    const data = await callApi(`/deployments/${pathId(args.deployment_id)}/logs`);
    return {
      deployment_id: args.deployment_id,
      lines:         data.logs || [],
      log_text:      (data.logs || []).join('\n'),
    };
  }

  async function handleDown(args, callApi) {
    const dep = await callApi(`/deployments/${pathId(args.deployment_id)}`, { method: 'DELETE' });
    return {
      deployment_id: dep.deployment_id,
      status:        dep.status,
      message:       'Deployment terminated. Billing stopped.',
      receipt_id:    dep.receipt_id,
    };
  }

  async function handleCheckResult(args, callApi) {
    const id = pathId(args.deployment_id);
    const limit = Math.min(Math.max(args.log_lines ?? 50, 0), 500);

    const dep = await callApi(`/deployments/${id}`);
    const logs = limit > 0 ? await callApi(`/deployments/${id}/logs`) : { logs: [] };
    const lines = (logs.logs || []).slice(-limit);

    return {
      deployment_id: dep.deployment_id || args.deployment_id,
      status:        dep.status,
      model:         dep.model,
      gpu:           dep.gpu_type ? `${dep.gpu_type} × ${dep.gpu_count ?? 1}` : undefined,
      cost_per_hour: dep.cost_per_hour,
      endpoint_url:  dep.endpoint_url,
      receipt_id:    dep.receipt_id,
      lines,
      log_text:      lines.join('\n'),
    };
  }

  async function handleAiChat(args, callApi) {
    if (!args.model) throw new Error('model is required for ai_chat.');
    if (!Array.isArray(args.messages) || args.messages.length === 0) {
      throw new Error('messages must be a non-empty array.');
    }
    const body = {
      model: args.model,
      messages: args.messages,
      max_tokens: Math.min(Math.max(Math.trunc(args.max_tokens ?? 1024), 1), MAX_TOKENS_CAP),
      stream: false,
    };
    if (args.temperature !== undefined) body.temperature = args.temperature;
    const res = await callApi('/chat/completions', { method: 'POST', body });
    const choice = (res.choices || [])[0] || {};
    return {
      model:         res.model || args.model,
      content:       choice.message?.content ?? '',
      finish_reason: choice.finish_reason,
      usage:         res.usage,
    };
  }

  async function handleLaunchAgentTask(args, callApi) {
    const repository = String(args.repository || '');
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(repository)) {
      throw new Error('repository must be a https://github.com/owner/repo URL.');
    }
    if (!String(args.instruction || '').trim()) throw new Error('instruction is required.');
    if (!String(args.check || '').trim()) throw new Error('check is required: a launch must be verifiable.');
    const agent = args.agent || 'claude';
    if (!LAUNCH_AGENTS.includes(agent)) throw new Error(`agent must be one of: ${LAUNCH_AGENTS.join(', ')}.`);
    if (!(Number(args.max_cost) > 0)) throw new Error('max_cost is required and must be greater than 0.');
    if (!(Number(args.max_runtime_minutes) >= 1)) throw new Error('max_runtime_minutes is required.');

    const job = await callApi('/jobs', {
      method: 'POST',
      body: {
        type: 'agent',
        input: { repository, instruction: args.instruction, check: args.check, agent },
        policy: {
          max_cost:            Math.min(Number(args.max_cost), MAX_JOB_COST),
          max_runtime_minutes: Math.min(Math.trunc(args.max_runtime_minutes), MAX_RUNTIME_M),
        },
      },
    });
    return {
      job_id:             job.job_id,
      status:             job.status,
      estimated_cost_usd: job.estimated_cost_usd,
      status_url:         job.status_url,
      message:            'Agent task launched. Poll check_launch_task with this job_id.',
    };
  }

  async function handleCheckLaunchTask(args, callApi) {
    const jobId = String(args.job_id || '');
    const id = pathId(jobId, 'job_id');
    const limit = Math.min(Math.max(args.log_lines ?? 50, 0), 500);
    const job = await callApi(`/jobs/${id}`);
    let lines = [];
    if (limit > 0) {
      const logs = await callApi(`/jobs/${id}/logs`).catch(() => ({ logs: [] }));
      const text = Array.isArray(logs.logs) ? logs.logs.join('\n') : (logs.logs || '');
      lines = text ? text.split('\n').slice(-limit) : [];
    }
    return {
      job_id:           job.job_id || jobId,
      status:           job.status,
      accrued_cost_usd: job.accrued_cost_usd,
      runtime_seconds:  job.runtime_seconds,
      output:           job.output,
      error:            job.error,
      receipt:          job.receipt,
      lines,
    };
  }

  /** Run a tool by name. Resolves to undefined for an unknown tool. */
  async function dispatch(name, args, callApi) {
    switch (name) {
      case 'run_workload':
      case 'badgr_run':          return handleRun(args, callApi);
      case 'deploy_model':
      case 'badgr_serve':        return handleServe(args, callApi);
      case 'badgr_status':       return handleStatus(callApi);
      case 'badgr_logs':         return handleLogs(args, callApi);
      case 'badgr_down':         return handleDown(args, callApi);
      case 'check_result':       return handleCheckResult(args, callApi);
      case 'ai_chat':            return handleAiChat(args, callApi);
      case 'launch_agent_task':  return handleLaunchAgentTask(args, callApi);
      case 'check_launch_task':  return handleCheckLaunchTask(args, callApi);
      default:                   return undefined;
    }
  }

  return {
    limits, TOOLS, dispatch,
    handleRun, handleServe, handleStatus, handleLogs, handleDown,
    handleCheckResult, handleAiChat, handleLaunchAgentTask, handleCheckLaunchTask,
  };
}

const defaults = createToolkit();
export const MAX_PRICE_CAP = defaults.limits.maxPrice;
export const MAX_RUNTIME_M = defaults.limits.maxRuntime;
export const MAX_JOB_COST  = defaults.limits.maxJobCost;
export const {
  TOOLS, dispatch,
  handleRun, handleServe, handleStatus, handleLogs, handleDown,
  handleCheckResult, handleAiChat, handleLaunchAgentTask, handleCheckLaunchTask,
} = defaults;
