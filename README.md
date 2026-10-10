# badgr-mcp

MCP server that lets coding agents provision GPU jobs and model endpoints — directly from Claude, Cursor, Copilot, or any MCP-compatible tool.

```bash
npx badgr-mcp
```

---

## The problem it solves

Running a GPU workload normally means switching to a terminal, writing a CLI command, waiting, and copying an endpoint URL back into your editor. `badgr-mcp` removes all of that — your coding agent calls `badgr_serve` or `badgr_run` directly, gets the endpoint URL back, and keeps working without you leaving the editor.

---

## Quick start

**1. Get a Badgr API key** at [aibadgr.com](https://aibadgr.com)

**2. Add to your MCP config:**

```json
{
  "mcpServers": {
    "badgr": {
      "command": "npx",
      "args": ["badgr-mcp"],
      "env": {
        "BADGR_API_KEY": "your-api-key"
      }
    }
  }
}
```

**3. Ask your agent to run a GPU job:**

> "Serve `meta-llama/Llama-3.1-8B-Instruct` on a GPU and give me the endpoint URL"

The agent calls `badgr_serve`, gets back the endpoint URL, and you can start using it immediately.

---

## Available tools

### `badgr_serve` — persistent OpenAI-compatible endpoint

Start a model endpoint that stays up until you stop it or the max runtime is reached.

```
badgr_serve(
  model: string,                    // HuggingFace model ID
  max_runtime_minutes: number,      // Auto-stop after N minutes (max: BADGR_MAX_RUNTIME, default 60)
  gpu?: string,                     // L40S | A100 | H100 | RTX_4090 (default: L40S)
  gpu_count?: number,               // 1–8 GPUs (default: 1)
  region?: string,                  // US | EU | AU (default: US)
  max_price_per_hour?: number,      // Hard $/hr cap
  name?: string                     // Optional label for the deployment
)
```

**Returns:** `{ deployment_id, endpoint_url, openai_base_url, cost_per_hour, max_runtime_minutes }`

The `openai_base_url` is a fully OpenAI-compatible endpoint — drop it into any OpenAI SDK client.

---

### `badgr_run` — one-off GPU job

Run a container command on a GPU. The job runs, completes, and is torn down automatically.

```
badgr_run(
  command: string[],               // Docker command, e.g. ["python", "train.py"]
  image?: string,                  // Docker image (default: python:3.11-slim)
  gpu?: string,                    // RTX_4090 | A100 | L40S | H100 (default: RTX_4090)
  gpu_count?: number,              // 1–8 GPUs (default: 1)
  region?: string,
  max_price_per_hour?: number,
  name?: string
)
```

**Returns:** `{ deployment_id, status, gpu_type, cost_per_hour, logs_url }`

---

### `badgr_status` — list active deployments

```
badgr_status()
```

**Returns:** list of active deployments with IDs, models, GPUs, status, and cost.

---

### `badgr_logs` — fetch deployment logs

```
badgr_logs(deployment_id: string)
```

**Returns:** `{ lines: string[], log_text: string }`

---

### `badgr_down` — stop a deployment

```
badgr_down(deployment_id: string)
```

Terminates the deployment and stops billing immediately.

**Returns:** `{ status, message }` — always call this when done.

---

## Smithery tool names

The server also exposes tools used for registry listings (the first three are aliases or helpers for Run and Serve, the next three cover the AI API and Launch products):

| Tool | Behavior |
|---|---|
| `run_workload` | Same as `badgr_run` (same inputs and price cap) |
| `deploy_model` | Same as `badgr_serve` (same inputs, price cap and required `max_runtime_minutes`) |
| `ai_chat` | `ai_chat(model, messages, max_tokens?, temperature?)` calls the Badgr AI API (OpenAI-compatible chat) and returns the reply with token usage. `max_tokens` is capped at 4096 |
| `launch_agent_task` | Launches an autonomous agent job on a GitHub repository, verified by your `check` command. `max_cost` and `max_runtime_minutes` are required and clamped to server limits |
| `check_launch_task` | `check_launch_task(job_id, log_lines?)` returns status, cost, output, receipt and recent logs for a launched task |
| `check_result` | `check_result(deployment_id, log_lines?)` returns the deployment's status, GPU, cost, endpoint and its last `log_lines` log lines (default 50, max 500) |

Call `badgr_down` when a deployment is finished so billing stops.

### Hosted HTTP mode

`node src/server.js --http` (or set `PORT`) serves the same tools at `POST /mcp` over streamable HTTP, with `GET /health`. Every request must carry `Authorization: Bearer <Badgr API key>`; the server uses that caller's key for Badgr calls, so a shared host never spends someone else's credits. The server never falls back to a `BADGR_API_KEY` env var in this mode, so an unauthenticated caller cannot spend the host's credits. Each request is stateless. Put TLS in front of it.

### Publishing to Smithery

`smithery.yaml` and `Dockerfile` in this folder describe a stdio deployment. In Smithery, connect the GitHub repo and set the base directory to `packages/badgr-mcp`. Users supply `badgrApiKey` (plus optional price cap, runtime cap and base URL) as Smithery config, which maps to the environment variables below. Publishing on Smithery is a manual step done from a Smithery account. The `smithery.yaml` here describes the stdio deployment; whether Smithery's current flow wants that or the hosted HTTP mode above was not verified.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BADGR_API_KEY` | Yes | — | Your Badgr API key from [aibadgr.com](https://aibadgr.com) |
| `BADGR_BASE_URL` | No | `https://aibadgr.com/v1` | API endpoint override |
| `BADGR_MAX_PRICE` | No | `5.0` | Hard $/hr cap applied to all jobs |
| `BADGR_MAX_RUNTIME` | No | `60` | Max minutes for `badgr_serve`, `deploy_model` and `launch_agent_task` |
| `BADGR_MAX_JOB_COST` | No | `5.0` | Hard USD cap on one `launch_agent_task` |

`BADGR_MAX_PRICE` and `BADGR_MAX_RUNTIME` are safety limits — the server enforces these regardless of what the agent requests.

---

## Example agent workflow

**Serve a model and use it:**

```
Agent: badgr_serve("meta-llama/Llama-3.1-8B-Instruct", max_runtime_minutes=30)
← { deployment_id: "dep-abc123", openai_base_url: "https://dep-abc123.aibadgr.com/v1", cost_per_hour: 1.20 }

Agent: [uses openai_base_url to run inference]

Agent: badgr_down("dep-abc123")
← { status: "terminated", message: "Billing stopped" }
```

**Run a fine-tuning job:**

```
Agent: badgr_run(["python", "train.py"], gpu="A100", image="pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime")
← { deployment_id: "dep-xyz789", status: "running", logs_url: "..." }

Agent: badgr_logs("dep-xyz789")
← { log_text: "Epoch 1/10: loss=2.34..." }
```

---

## Requirements

- Node.js 18+
- A Badgr API key — sign up at [aibadgr.com](https://aibadgr.com)
- An MCP-compatible coding agent (Claude, Cursor, Copilot, or any client that supports MCP)
