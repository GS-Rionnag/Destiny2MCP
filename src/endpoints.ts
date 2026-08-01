import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SPEC_URL = 'https://raw.githubusercontent.com/Bungie-net/api/master/openapi.json';

let spec: any = null;

/** Bungie's OpenAPI spec — 1.8MB, downloaded once, then read from data/ like the manifest. */
export async function loadSpec(): Promise<any> {
  if (spec) return spec;
  const file = path.join(config.dataDir, 'openapi.json');
  if (!fs.existsSync(file)) {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`OpenAPI spec download failed: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  return spec;
}

export function setSpec(s: any): void { spec = s; }

type Op = { method: string; path: string; op: any };

function operations(s: any): Op[] {
  return Object.entries<any>(s.paths).flatMap(([p, item]) =>
    Object.entries<any>(item)
      .filter(([m]) => m === 'get' || m === 'post')
      .map(([m, op]) => ({ method: m.toUpperCase(), path: p, op })));
}

export async function listEndpoints(search?: string, tag?: string): Promise<string[]> {
  const s = await loadSpec();
  const q = search?.toLowerCase();
  return operations(s)
    .filter(({ path: p, op }) =>
      (!tag || (op.tags ?? []).some((t: string) => t.toLowerCase() === tag.toLowerCase())) &&
      (!q || p.toLowerCase().includes(q) || op.operationId.toLowerCase().includes(q) ||
        (op.description ?? '').toLowerCase().includes(q)))
    .map(({ method, path: p, op }) => `${method} ${p} — ${op.operationId}`);
}

// Response schemas fan out into the whole type graph, so name the type and stop there —
// the model can just make the call and read the actual JSON.
const refName = (ref?: string) => ref?.split('/').pop();

function requestBody(s: any, op: any) {
  const ref = op.requestBody?.content?.['application/json']?.schema?.$ref;
  if (!ref) return undefined;
  const schema = s.components?.schemas?.[refName(ref)!];
  if (!schema?.properties) return refName(ref);
  // A nested object says `type: "object"` next to the $ref that actually names it, and enums
  // say `type: "integer"` next to theirs — the ref is the half worth showing.
  return Object.fromEntries(Object.entries<any>(schema.properties).map(([k, v]) => [
    k,
    [refName(v.allOf?.[0]?.$ref) ?? refName(v['x-enum-reference']?.$ref) ?? v.type, v.description]
      .filter(Boolean).join(' — '),
  ]));
}

export async function describeEndpoint(endpoint: string) {
  const s = await loadSpec();
  const q = endpoint.toLowerCase();
  const all = operations(s);
  const hit =
    all.find((o) => o.op.operationId.toLowerCase() === q || o.path.toLowerCase() === q) ??
    all.find((o) => o.op.operationId.toLowerCase().includes(q) || o.path.toLowerCase().includes(q));
  if (!hit) throw new Error(`No Bungie endpoint matching "${endpoint}". Use list_endpoints to find one.`);

  const { method, path: p, op } = hit;
  const oauth = (op.security ?? []).flatMap((sec: any) => sec.oauth2 ?? []);
  return {
    operationId: op.operationId,
    call: `${method} ${p}`,
    description: op.description,
    auth: oauth.length ? `OAuth required — scope ${oauth.join(', ')}` : 'API key only',
    deprecated: op.deprecated || undefined,
    parameters: (op.parameters ?? []).map((prm: any) => ({
      name: prm.name,
      in: prm.in,
      required: prm.required || undefined,
      type: prm.schema?.type,
      description: prm.description,
    })),
    requestBody: requestBody(s, op),
    responseType: refName(op.responses?.['200']?.$ref),
  };
}
