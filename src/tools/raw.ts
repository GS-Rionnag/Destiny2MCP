import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch } from '../bungie.js';
import { describeEndpoint, listEndpoints } from '../endpoints.js';
import { tool } from './util.js';

// A raw profile call with every component returns megabytes. Nothing the model asks for in
// one turn is worth 25k tokens, so an unprojected response over this comes back as a map of
// where the weight is instead of the weight itself.
const MAX_RESPONSE_BYTES = 100 * 1024;
// Ceiling on how far one "*" can fan out, so the walker cannot blow up before we can measure it.
const MAX_MATCHES = 500;

/** Resolve one dot path ("a.*.b") to a flat map of fully-resolved path -> value. */
function resolvePath(root: unknown, path: string): Record<string, unknown> {
  let frontier: [string, unknown][] = [['', root]];
  for (const seg of path.split('.')) {
    const next: [string, unknown][] = [];
    for (const [prefix, node] of frontier) {
      if (node === null || typeof node !== 'object') continue;
      const entries = seg === '*'
        ? Object.entries(node as Record<string, unknown>)
        : seg in (node as Record<string, unknown>) ? [[seg, (node as Record<string, unknown>)[seg]] as const] : [];
      for (const [key, child] of entries) {
        next.push([prefix ? `${prefix}.${key}` : key, child]);
        if (next.length >= MAX_MATCHES) break;
      }
      if (next.length >= MAX_MATCHES) break;
    }
    frontier = next;
  }
  return Object.fromEntries(frontier);
}

function guardSize(data: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8');
  if (bytes <= MAX_RESPONSE_BYTES) return data;
  const topLevelKeys = data && typeof data === 'object'
    ? Object.fromEntries(Object.entries(data as Record<string, unknown>)
        .map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')]))
    : undefined;
  return {
    tooLarge: true,
    bytes,
    topLevelKeys,
    hint: 'Response too large. Re-call with select to pull only what you need, e.g. select:["characterActivities.data.*.currentActivityHash"], or allow_large_response:true to force the whole thing.',
  };
}

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
    description: 'Escape hatch: call ANY Bungie.net Platform endpoint directly. path is relative to /Platform, e.g. "/Destiny2/Manifest/". Use list_endpoints + describe_endpoint to find the right one rather than reading the online docs. Prefer the specific tools when one fits — responses here are raw JSON with unresolved hashes; for /Destiny2/Manifest/ lookups use get_definition instead (local, batched, far smaller). ALWAYS pass select on profile-shaped endpoints: an unprojected response over 100KB comes back as a map of its top-level keys and their sizes instead of the data, so you can retry with the right path.',
    inputSchema: z.object({
      method: z.enum(['GET', 'POST']).default('GET'),
      path: z.string().describe('Must start with /, e.g. /Destiny2/3/Profile/{id}/'),
      query: z.record(z.string(), z.string()).optional(),
      body: z.string().optional().describe('JSON string for POST bodies'),
      auth: z.boolean().default(true),
      select: z.array(z.string()).optional()
        .describe('Dot paths to pull out, "*" matching every key or array element, e.g. ["characterActivities.data.*.currentActivityHash"]. Returns a flat map of resolved path -> value.'),
      allow_large_response: z.boolean().default(false)
        .describe('Bypass the 100KB size guard. Only when you genuinely need the whole payload.'),
    }),
  }, tool(async ({ method, path, query, body, auth, select, allow_large_response }) => {
    if (!path.startsWith('/')) throw new Error('path must start with /');
    const data = await bungieFetch(path, { method, query, body: body ? JSON.parse(body) : undefined, auth });
    if (!select?.length) return allow_large_response ? data : guardSize(data);

    // One bad path must not lose the others — report it instead of throwing or hiding it.
    const picked: Record<string, unknown> = {};
    const unmatchedSelect: string[] = [];
    for (const p of select) {
      const found = resolvePath(data, p);
      if (Object.keys(found).length) Object.assign(picked, found);
      else unmatchedSelect.push(p);
    }
    const result = unmatchedSelect.length ? { ...picked, unmatchedSelect } : picked;
    // A projection can still be huge — measure the thing we are actually returning.
    return allow_large_response ? result : guardSize(result);
  }));
}
