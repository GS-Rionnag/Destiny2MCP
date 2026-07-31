import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch } from '../bungie.js';
import { tool } from './util.js';

export function registerRawTool(server: McpServer): void {
  server.registerTool('bungie_api_call', {
    description: 'Escape hatch: call ANY Bungie.net Platform endpoint directly (https://bungie-net.github.io/multi lists all ~150). path is relative to /Platform, e.g. "/Destiny2/Manifest/". Prefer the specific tools when one fits; responses here are raw JSON with unresolved hashes.',
    inputSchema: z.object({
      method: z.enum(['GET', 'POST']).default('GET'),
      path: z.string().describe('Must start with /, e.g. /Destiny2/3/Profile/{id}/'),
      query: z.record(z.string(), z.string()).optional(),
      body: z.string().optional().describe('JSON string for POST bodies'),
      auth: z.boolean().default(true),
    }),
  }, tool(async ({ method, path, query, body, auth }) => {
    if (!path.startsWith('/')) throw new Error('path must start with /');
    return bungieFetch(path, { method, query, body: body ? JSON.parse(body) : undefined, auth });
  }));
}
