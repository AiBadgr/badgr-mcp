#!/usr/bin/env node
/**
 * Badgr MCP Server (stdio entrypoint)
 *
 * Exposes GPU compute tools to coding agents (Claude, Cursor, etc).
 * Enforces budget and runtime limits on every expensive action.
 *
 * Tools:
 *   badgr_run    — one-off GPU job
 *   badgr_serve  — persistent OpenAI-compatible endpoint
 *   badgr_status — list active deployments
 *   badgr_logs   — fetch logs for a deployment
 *   badgr_down   — terminate a deployment (stop billing)
 *   run_workload / deploy_model / check_result — registry-facing names;
 *     the first two share badgr_run / badgr_serve handlers
 *
 * `node src/server.js --http` (or PORT set) serves the same tools over
 * authenticated streamable HTTP instead; see http.js.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBadgrServer } from './create-server.js';
import { startHttpServer } from './http.js';

const BADGR_API_KEY  = process.env.BADGR_API_KEY  || '';
const BADGR_BASE_URL = process.env.BADGR_BASE_URL  || 'https://aibadgr.com/v1';

if (process.argv.includes('--http') || process.env.PORT) {
  await startHttpServer({
    port: parseInt(process.env.PORT || '8080', 10),
    baseUrl: BADGR_BASE_URL,
  });
} else {
  const server = createBadgrServer({ apiKey: BADGR_API_KEY, baseUrl: BADGR_BASE_URL });
  await server.connect(new StdioServerTransport());
}
