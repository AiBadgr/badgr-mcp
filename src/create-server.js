/**
 * Builds a Badgr MCP Server instance. Shared by the stdio entrypoint
 * (server.js) and the authenticated HTTP entrypoint (http.js).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, dispatch } from './handlers.js';

export const SERVER_VERSION = '1.1.0';

export function createBadgrApi({ apiKey, baseUrl, fetchImpl = fetch }) {
  return async function badgrApi(path, { method = 'GET', body } = {}) {
    if (!apiKey) throw new Error('BADGR_API_KEY not set');
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return JSON.parse(text);
  };
}

export function createBadgrServer({ apiKey, baseUrl, fetchImpl }) {
  const badgrApi = createBadgrApi({ apiKey, baseUrl, fetchImpl });
  const server = new Server(
    { name: 'badgr-mcp', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await dispatch(name, args, badgrApi);
      if (result === undefined) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}
