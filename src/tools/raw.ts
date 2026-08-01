import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch } from '../bungie.js';
import { describeEndpoint, listEndpoints } from '../endpoints.js';
import { tool } from './util.js';

export function registerRawTool(server: McpServer): void {
  server.registerTool('list_endpoints', {
    description: "Index of every Bungie.net Platform endpoint, from Bungie's own OpenAPI spec — names only, no descriptions. Use this instead of reading the online API docs, then describe_endpoint for the one you picked. Filter with search/tag to keep the list short.",
    inputSchema: z.object({
      search: z.string().optional().describe('Substring match on path, operationId or description, e.g. "postmaster"'),
      tag: z.string().optional().describe('Destiny2 (43), GroupV2 (35), Forum, User, Tokens, Social, Content, Fireteam, Trending, App'),
    }),
  }, tool(async ({ search, tag }) => {
    const hits = await listEndpoints(search, tag);
    return hits.length ? hits : 'No endpoint matched. Try a broader search, or drop the tag filter.';
  }));

  server.registerTool('describe_endpoint', {
    description: 'Full signature for ONE Bungie endpoint: parameters, request body shape, whether it needs OAuth, and its response type. Feed the result to bungie_api_call. Accepts an operationId ("Destiny2.GetProfile") or a path.',
    inputSchema: z.object({
      endpoint: z.string().describe('operationId or path, e.g. "Destiny2.EquipItem" or "/Destiny2/Actions/Items/EquipItem/"'),
    }),
  }, tool(async ({ endpoint }) => describeEndpoint(endpoint)));

  server.registerTool('bungie_api_call', {
    description: 'Escape hatch: call ANY Bungie.net Platform endpoint directly. path is relative to /Platform, e.g. "/Destiny2/Manifest/". Use list_endpoints + describe_endpoint to find the right one rather than reading the online docs. Prefer the specific tools when one fits — responses here are raw JSON with unresolved hashes; for /Destiny2/Manifest/ lookups use get_definition instead (local, batched, far smaller).',
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
