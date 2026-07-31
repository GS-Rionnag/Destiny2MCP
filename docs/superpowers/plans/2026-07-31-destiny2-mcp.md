# Destiny 2 MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local MCP server (Streamable HTTP) exposing the full Bungie/Destiny 2 API — 13 read tools, 8 write tools, 1 raw escape hatch — to ChatGPT web, Claude, and any MCP client.

**Architecture:** One Node/TS process. Express serves `POST /mcp` (stateless Streamable HTTP, fresh McpServer per request) on HTTP port 7777. A second HTTPS listener on port 7778 handles Bungie OAuth (`/auth`, `/callback`) with a self-signed cert (Bungie requires HTTPS redirect URLs). Bungie SQLite manifest downloaded/cached locally for all hash→name resolution.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` + `@modelcontextprotocol/node` (MCP SDK v2), Express, zod v4, better-sqlite3, adm-zip, selfsigned, dotenv, tsx (runtime), vitest (tests).

## Global Constraints

- Node ≥ 20 (built-in `fetch`). No build step — run via `tsx`.
- MCP endpoint: `http://localhost:7777/mcp` (PORT env). OAuth: `https://localhost:7778` (AUTH_PORT env). Bungie app redirect URL: `https://localhost:7778/callback`.
- `.env` keys, exact names: `BUNGIE_API_KEY`, `BUNGIE_CLIENT_ID`, `BUNGIE_CLIENT_SECRET`, `PORT`, `AUTH_PORT`, `DATA_DIR`.
- All runtime state under `DATA_DIR` (default `./data`): `tokens.json`, `certs/`, `manifest/`. `data/` and `.env` are gitignored.
- Tool responses: human-readable names resolved via manifest, never raw hash soup. Errors: readable one-liners (`"DestinyItemNotFound: ..."`), never stack traces, returned as `isError: true` tool results.
- Commits: author is the repo user only. NEVER add a `Co-Authored-By` trailer.
- Bungie Platform base URL: `https://www.bungie.net/Platform`. Every request sends `X-API-Key` header.

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config.ts`

**Interfaces:**
- Produces: `config` object from `src/config.ts`: `{ apiKey: string, clientId: string, clientSecret: string, port: number, authPort: number, dataDir: string }` — read fresh from env at import time.

- [ ] **Step 1: Init package + install deps**

```bash
cd /home/girish/Destiny2MCP
npm init -y
npm pkg set type=module
npm i @modelcontextprotocol/server @modelcontextprotocol/node express zod better-sqlite3 adm-zip selfsigned dotenv
npm i -D typescript tsx vitest @types/express @types/node @types/better-sqlite3 @types/adm-zip
npm pkg set scripts.start="tsx src/index.ts" scripts.setup="tsx scripts/setup.ts" scripts.smoke="tsx scripts/smoke.ts" scripts.test="vitest run"
```

Note: if `@modelcontextprotocol/server` / `@modelcontextprotocol/node` don't exist on npm (SDK v2 not yet published), fall back to `npm i @modelcontextprotocol/sdk` and use its v1 import paths (`@modelcontextprotocol/sdk/server/mcp.js`, `@modelcontextprotocol/sdk/server/streamableHttp.js`, class `StreamableHTTPServerTransport`). All later tasks note the v1 fallback where imports differ.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: Write `.gitignore` and `.env.example`**

`.gitignore`:
```
node_modules/
data/
.env
```

`.env.example`:
```
BUNGIE_API_KEY=your-api-key-from-bungie.net/developer
BUNGIE_CLIENT_ID=your-oauth-client-id
BUNGIE_CLIENT_SECRET=your-oauth-client-secret
PORT=7777
AUTH_PORT=7778
DATA_DIR=./data
```

- [ ] **Step 4: Write `src/config.ts`**

```ts
import 'dotenv/config';

export const config = {
  apiKey: process.env.BUNGIE_API_KEY ?? '',
  clientId: process.env.BUNGIE_CLIENT_ID ?? '',
  clientSecret: process.env.BUNGIE_CLIENT_SECRET ?? '',
  port: Number(process.env.PORT ?? 7777),
  authPort: Number(process.env.AUTH_PORT ?? 7778),
  dataDir: process.env.DATA_DIR ?? './data',
};
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npx tsc`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold TS project with MCP SDK deps"
```

---

### Task 2: Bungie API client

**Files:**
- Create: `src/bungie.ts`
- Test: `tests/bungie.test.ts`

**Interfaces:**
- Consumes: `config` from `src/config.ts`; `getAccessToken()` from `src/auth.ts` (Task 3 — import it now, Task 3 creates it; for this task create a stub `src/auth.ts` exporting `export async function getAccessToken(): Promise<string> { throw new Error('Not authenticated'); }` which Task 3 replaces).
- Produces:
  - `class BungieError extends Error { errorStatus: string; errorCode: number; throttleSeconds: number }`
  - `bungieFetch<T = any>(path: string, opts?: { method?: 'GET'|'POST'; query?: Record<string, string|number|undefined>; body?: unknown; auth?: boolean }): Promise<T>` — resolves with the `Response` field of Bungie's envelope; throws `BungieError` when `ErrorCode !== 1`.
  - `getAccount(): Promise<{ membershipType: number; membershipId: string; characterIds: string[] }>` — cached after first call.

- [ ] **Step 1: Write the failing tests**

`tests/bungie.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bungieFetch, BungieError } from '../src/bungie.js';

const envelope = (over: object) => ({
  ok: true,
  json: async () => ({ ErrorCode: 1, ErrorStatus: 'Success', Message: 'Ok', ThrottleSeconds: 0, Response: { hello: 'world' }, ...over }),
});

beforeEach(() => vi.restoreAllMocks());

describe('bungieFetch', () => {
  it('returns the Response field on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({})));
    expect(await bungieFetch('/Test/')).toEqual({ hello: 'world' });
  });

  it('sends X-API-Key and builds query string', async () => {
    const f = vi.fn(async () => envelope({}));
    vi.stubGlobal('fetch', f);
    await bungieFetch('/Test/', { query: { components: '100,200', skip: undefined } });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://www.bungie.net/Platform/Test/?components=100%2C200');
    expect(init.headers['X-API-Key']).toBeDefined();
  });

  it('throws BungieError with status on ErrorCode != 1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      envelope({ ErrorCode: 1623, ErrorStatus: 'DestinyItemNotFound', Message: 'The item requested was not found.' })));
    await expect(bungieFetch('/Test/')).rejects.toThrowError(/item requested was not found/);
    await expect(bungieFetch('/Test/')).rejects.toBeInstanceOf(BungieError);
  });

  it('maps ErrorCode 5 to maintenance message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ ErrorCode: 5, ErrorStatus: 'SystemDisabled', Message: 'x' })));
    await expect(bungieFetch('/Test/')).rejects.toThrowError(/maintenance/);
  });

  it('retries once after ThrottleSeconds', async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(envelope({ ErrorCode: 51, ErrorStatus: 'PerEndpointRequestThrottleExceeded', Message: 'slow down', ThrottleSeconds: 1 }))
      .mockResolvedValueOnce(envelope({}));
    vi.stubGlobal('fetch', f);
    const p = bungieFetch('/Test/');
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ hello: 'world' });
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bungie.test.ts`
Expected: FAIL — cannot resolve `../src/bungie.js`.

- [ ] **Step 3: Write stub `src/auth.ts` and implementation `src/bungie.ts`**

`src/auth.ts` (stub, replaced in Task 3):
```ts
export async function getAccessToken(): Promise<string> {
  throw new Error('Not authenticated');
}
```

`src/bungie.ts`:
```ts
import { config } from './config.js';
import { getAccessToken } from './auth.js';

const BASE = 'https://www.bungie.net/Platform';
const MIN_INTERVAL_MS = 100; // ponytail: global serial throttle, fine for one user
let lastRequest = 0;

export class BungieError extends Error {
  constructor(
    public errorStatus: string,
    message: string,
    public errorCode: number,
    public throttleSeconds = 0,
  ) {
    super(message);
    this.name = 'BungieError';
  }
}

export interface FetchOpts {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function bungieFetch<T = any>(path: string, opts: FetchOpts = {}, retried = false): Promise<T> {
  const wait = lastRequest + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { 'X-API-Key': config.apiKey };
  if (opts.auth) headers.Authorization = `Bearer ${await getAccessToken()}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await res.json().catch(() => {
    throw new BungieError('NetworkError', `HTTP ${res.status} from Bungie (non-JSON body)`, -1);
  });

  if (data.ErrorCode !== 1) {
    if (data.ThrottleSeconds > 0 && !retried) {
      await sleep(data.ThrottleSeconds * 1000);
      return bungieFetch(path, opts, true);
    }
    if (data.ErrorCode === 5) {
      throw new BungieError('SystemDisabled', 'Bungie API is down for maintenance. Try again later.', 5);
    }
    throw new BungieError(data.ErrorStatus ?? 'Unknown', data.Message ?? 'Unknown Bungie error', data.ErrorCode ?? -1, data.ThrottleSeconds ?? 0);
  }
  return data.Response as T;
}

let account: { membershipType: number; membershipId: string; characterIds: string[] } | null = null;

export async function getAccount() {
  if (account) return account;
  const r = await bungieFetch<any>('/User/GetMembershipsForCurrentUser/', { auth: true });
  const m =
    r.destinyMemberships.find((d: any) => d.membershipId === r.primaryMembershipId) ??
    r.destinyMemberships[0];
  if (!m) throw new BungieError('NoDestinyAccount', 'This Bungie account has no Destiny 2 memberships.', -1);
  const prof = await bungieFetch<any>(`/Destiny2/${m.membershipType}/Profile/${m.membershipId}/`, {
    auth: true,
    query: { components: '100' },
  });
  account = {
    membershipType: m.membershipType,
    membershipId: m.membershipId,
    characterIds: prof.profile.data.characterIds,
  };
  return account;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bungie.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Bungie API client with throttle, retry, error mapping"
```

---

### Task 3: Token store + refresh

**Files:**
- Modify: `src/auth.ts` (replace Task 2's stub entirely)
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `config` from `src/config.ts`.
- Produces (all from `src/auth.ts`):
  - `interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number }` (ms epochs)
  - `readTokens(): Tokens | null`
  - `storeTokenResponse(raw: any): Tokens` — takes Bungie's snake_case token JSON, persists to `<DATA_DIR>/tokens.json`, returns parsed form.
  - `exchangeCode(code: string): Promise<Tokens>`
  - `getAccessToken(): Promise<string>` — returns cached token if >60s from expiry; refreshes via refresh_token otherwise; throws readable errors when unauthenticated or refresh token expired.

- [ ] **Step 1: Write the failing tests**

`tests/auth.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2mcp-'));
process.env.DATA_DIR = tmp;

const { storeTokenResponse, readTokens, getAccessToken } = await import('../src/auth.js');

const rawToken = (over: object = {}) => ({
  access_token: 'ACCESS',
  refresh_token: 'REFRESH',
  expires_in: 3600,
  refresh_expires_in: 7776000,
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(path.join(tmp, 'tokens.json'), { force: true });
});

describe('token store', () => {
  it('persists and computes expiry epochs', () => {
    const before = Date.now();
    const t = storeTokenResponse(rawToken());
    expect(t.accessToken).toBe('ACCESS');
    expect(t.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(readTokens()).toEqual(t);
  });

  it('getAccessToken throws readable error when unauthenticated', async () => {
    await expect(getAccessToken()).rejects.toThrowError(/\/auth/);
  });

  it('returns stored token while fresh, without network', async () => {
    storeTokenResponse(rawToken());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not fetch'); }));
    expect(await getAccessToken()).toBe('ACCESS');
  });

  it('refreshes when access token expired', async () => {
    storeTokenResponse(rawToken({ expires_in: -10 }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => rawToken({ access_token: 'FRESH' }),
    })));
    expect(await getAccessToken()).toBe('FRESH');
    expect(readTokens()!.accessToken).toBe('FRESH');
  });

  it('throws re-auth error when refresh token expired', async () => {
    storeTokenResponse(rawToken({ expires_in: -10, refresh_expires_in: -10 }));
    await expect(getAccessToken()).rejects.toThrowError(/[Rr]e-authenticate/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — `storeTokenResponse` not exported (stub only has `getAccessToken`).

- [ ] **Step 3: Replace `src/auth.ts` with the real implementation**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const TOKEN_URL = 'https://www.bungie.net/platform/app/oauth/token/';
const tokenFile = () => path.join(config.dataDir, 'tokens.json');

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

export function readTokens(): Tokens | null {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  } catch {
    return null;
  }
}

export function storeTokenResponse(raw: any): Tokens {
  const now = Date.now();
  const t: Tokens = {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: now + raw.expires_in * 1000,
    refreshExpiresAt: now + raw.refresh_expires_in * 1000,
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(t, null, 2));
  return t;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Bungie token endpoint: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export async function exchangeCode(code: string): Promise<Tokens> {
  return storeTokenResponse(await tokenRequest({ grant_type: 'authorization_code', code }));
}

const authUrl = () => `https://localhost:${config.authPort}/auth`;

export async function getAccessToken(): Promise<string> {
  const t = readTokens();
  if (!t) throw new Error(`Not authenticated. Open ${authUrl()} in a browser to link your Bungie account.`);
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (Date.now() > t.refreshExpiresAt) {
    throw new Error(`Bungie refresh token expired. Re-authenticate at ${authUrl()}.`);
  }
  const fresh = storeTokenResponse(await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken }));
  return fresh.accessToken;
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: bungie + auth suites pass (Task 2 tests must still pass against the real auth module).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: OAuth token store with auto-refresh"
```

---

### Task 4: OAuth server + cert setup script

**Files:**
- Create: `src/auth-server.ts`, `scripts/setup.ts`

**Interfaces:**
- Consumes: `config`, `exchangeCode` from `src/auth.ts`.
- Produces: `startAuthServer(): void` from `src/auth-server.ts` — starts HTTPS listener on `config.authPort` with routes `GET /auth` (redirect to Bungie authorize page) and `GET /callback` (exchanges `?code=`, saves tokens). Logs a warning if certs are missing instead of crashing.

- [ ] **Step 1: Write `scripts/setup.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { config } from '../src/config.js';

const dir = path.join(config.dataDir, 'certs');
const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 3650, keySize: 2048 });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
console.log(`Self-signed cert written to ${dir}`);
console.log(`Register your Bungie app redirect URL as: https://localhost:${config.authPort}/callback`);
console.log(`Then: npm start, and open https://localhost:${config.authPort}/auth`);
```

- [ ] **Step 2: Write `src/auth-server.ts`**

```ts
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { exchangeCode } from './auth.js';

export function startAuthServer(): void {
  const certDir = path.join(config.dataDir, 'certs');
  let key: Buffer, cert: Buffer;
  try {
    key = fs.readFileSync(path.join(certDir, 'key.pem'));
    cert = fs.readFileSync(path.join(certDir, 'cert.pem'));
  } catch {
    console.warn('No TLS certs found — run `npm run setup` first. OAuth server not started.');
    return;
  }

  const app = express();

  app.get('/auth', (_req, res) => {
    const u = new URL('https://www.bungie.net/en/oauth/authorize');
    u.searchParams.set('client_id', config.clientId);
    u.searchParams.set('response_type', 'code');
    res.redirect(u.toString());
  });

  app.get('/callback', async (req, res) => {
    try {
      await exchangeCode(String(req.query.code ?? ''));
      res.send('Bungie account linked. You can close this tab.');
      console.log('Bungie auth complete — tokens saved.');
    } catch (e: any) {
      res.status(500).send(`Auth failed: ${e?.message ?? e}`);
    }
  });

  https.createServer({ key, cert }, app).listen(config.authPort, () => {
    console.log(`OAuth: open https://localhost:${config.authPort}/auth to link your Bungie account`);
  });
}
```

- [ ] **Step 3: Verify setup script runs**

Run: `npm run setup && ls data/certs`
Expected: prints instructions; `cert.pem key.pem` exist.

- [ ] **Step 4: Verify typecheck + existing tests still pass**

Run: `npx tsc && npx vitest run`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: HTTPS OAuth server and self-signed cert setup"
```

Note: end-to-end OAuth against real Bungie happens in Task 11's live smoke (needs the human's Bungie app registration — cannot be automated).

---

### Task 5: Manifest store

**Files:**
- Create: `src/manifest.ts`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: `bungieFetch` from `src/bungie.ts`, `config`.
- Produces (all from `src/manifest.ts`):
  - `openManifest(): Promise<void>` — fetches `/Destiny2/Manifest/`, downloads+unzips `mobileWorldContentPaths.en` into `<DATA_DIR>/manifest/<basename>` unless cached, opens it.
  - `openManifestFile(file: string): void` — opens a specific SQLite file (used by tests and by `openManifest`).
  - `hashToId(hash: number): number` — unsigned 32-bit hash → signed SQLite id.
  - `getDef(table: string, hash: number): any | undefined`
  - `defName(table: string, hash: number): string` — falls back to `` `#${hash}` ``.
  - `searchDefs(query: string, table?: string, limit?: number): { hash: number; name: string; type?: string; tier?: string }[]` — case-insensitive name substring match, default table `DestinyInventoryItemDefinition`, default limit 25.
  - `firstHash(table: string): number` — hash of first row (used for loadout snapshot defaults).

- [ ] **Step 1: Write the failing tests**

`tests/manifest.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openManifestFile, hashToId, getDef, defName, searchDefs, firstHash } from '../src/manifest.js';

// Gjallarhorn's real hash — above 2^31, so its sqlite id is negative.
const GJALLY = 1363886209;

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2mani-')), 'world.content');
  const db = new Database(file);
  db.exec('CREATE TABLE DestinyInventoryItemDefinition (id INTEGER PRIMARY KEY, json BLOB)');
  const ins = db.prepare('INSERT INTO DestinyInventoryItemDefinition VALUES (?, ?)');
  ins.run(hashToId(GJALLY), JSON.stringify({
    hash: GJALLY,
    displayProperties: { name: 'Gjallarhorn' },
    itemTypeDisplayName: 'Rocket Launcher',
    inventory: { tierTypeName: 'Exotic' },
  }));
  ins.run(100, JSON.stringify({ hash: 100, displayProperties: { name: 'Sunshot' }, itemTypeDisplayName: 'Hand Cannon' }));
  db.close();
  openManifestFile(file);
});

describe('manifest', () => {
  it('converts high hashes to negative ids', () => {
    expect(hashToId(GJALLY)).toBeLessThan(0);
    expect(hashToId(100)).toBe(100);
  });

  it('getDef finds rows via unsigned hash', () => {
    expect(getDef('DestinyInventoryItemDefinition', GJALLY)?.displayProperties.name).toBe('Gjallarhorn');
  });

  it('defName falls back to #hash for unknown', () => {
    expect(defName('DestinyInventoryItemDefinition', 42)).toBe('#42');
  });

  it('searchDefs matches name case-insensitively', () => {
    const r = searchDefs('gjallar');
    expect(r).toEqual([{ hash: GJALLY, name: 'Gjallarhorn', type: 'Rocket Launcher', tier: 'Exotic' }]);
  });

  it('firstHash returns some row hash', () => {
    expect([GJALLY, 100]).toContain(firstHash('DestinyInventoryItemDefinition'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — cannot resolve `../src/manifest.js`.

- [ ] **Step 3: Write `src/manifest.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { config } from './config.js';
import { bungieFetch } from './bungie.js';

let db: Database.Database | null = null;

export function openManifestFile(file: string): void {
  db = new Database(file, { readonly: true });
}

export async function openManifest(): Promise<void> {
  const info = await bungieFetch<any>('/Destiny2/Manifest/');
  const remotePath: string = info.mobileWorldContentPaths.en;
  const file = path.join(config.dataDir, 'manifest', path.basename(remotePath));
  if (!fs.existsSync(file)) {
    console.log('Downloading Destiny 2 manifest (one-time, ~200MB)...');
    const res = await fetch('https://www.bungie.net' + remotePath);
    if (!res.ok) throw new Error(`Manifest download failed: HTTP ${res.status}`);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zip.getEntries()[0].getData());
    console.log('Manifest ready.');
  }
  openManifestFile(file);
}

export const hashToId = (hash: number): number => (hash > 0x7fffffff ? hash - 0x1_0000_0000 : hash);

function need(): Database.Database {
  if (!db) throw new Error('Manifest not loaded — server still starting up.');
  return db;
}

export function getDef(table: string, hash: number): any | undefined {
  if (!/^Destiny\w+Definition$/.test(table)) throw new Error(`Invalid manifest table: ${table}`);
  const row = need().prepare(`SELECT json FROM ${table} WHERE id = ?`).get(hashToId(hash)) as any;
  return row ? JSON.parse(row.json) : undefined;
}

export const defName = (table: string, hash: number): string =>
  getDef(table, hash)?.displayProperties?.name || `#${hash}`;

export function searchDefs(query: string, table = 'DestinyInventoryItemDefinition', limit = 25) {
  if (!/^Destiny\w+Definition$/.test(table)) throw new Error(`Invalid manifest table: ${table}`);
  // ponytail: LIKE prefilter + JS scan over ~30k rows, ~100ms; index it if ever too slow
  const rows = need().prepare(`SELECT json FROM ${table} WHERE json LIKE ?`).all(`%${query}%`) as any[];
  const q = query.toLowerCase();
  const out: { hash: number; name: string; type?: string; tier?: string }[] = [];
  for (const r of rows) {
    const d = JSON.parse(r.json);
    const name: string | undefined = d.displayProperties?.name;
    if (name && name.toLowerCase().includes(q)) {
      out.push({ hash: d.hash, name, type: d.itemTypeDisplayName, tier: d.inventory?.tierTypeName });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function firstHash(table: string): number {
  if (!/^Destiny\w+Definition$/.test(table)) throw new Error(`Invalid manifest table: ${table}`);
  const row = need().prepare(`SELECT json FROM ${table} LIMIT 1`).get() as any;
  return JSON.parse(row.json).hash;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: manifest download, cache, and definition lookup"
```

---

### Task 6: Tool plumbing + read tools A (profile, character, inventory, item details)

**Files:**
- Create: `src/tools/util.ts`, `src/tools/read.ts`
- Test: `tests/read.test.ts`

**Interfaces:**
- Consumes: `bungieFetch`, `getAccount`, `BungieError` from `src/bungie.ts`; `getDef`, `defName` from `src/manifest.ts`; `McpServer` type from `@modelcontextprotocol/server` (v1 fallback: `@modelcontextprotocol/sdk/server/mcp.js`).
- Produces:
  - `src/tools/util.ts`: `ok(data: unknown)` → `{ content: [{ type: 'text', text: string }] }`; `tool<A>(fn: (args: A) => Promise<unknown>)` → MCP handler that catches errors into `isError: true` text results.
  - `src/tools/read.ts`: `itemSummary(item: any, instances?: Record<string, any>): { name, itemHash, itemInstanceId?, type?, tier?, power?, quantity? }` (exported for tests and reuse); `registerReadTools(server: McpServer): void` — this task registers `get_profile`, `get_character`, `search_inventory`, `get_item_details`; Tasks 7–8 append more registrations inside the same function.

- [ ] **Step 1: Write the failing test**

`tests/read.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openManifestFile, hashToId } from '../src/manifest.js';
import { itemSummary } from '../src/tools/read.js';
import { tool } from '../src/tools/util.js';

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2read-')), 'world.content');
  const db = new Database(file);
  db.exec('CREATE TABLE DestinyInventoryItemDefinition (id INTEGER PRIMARY KEY, json BLOB)');
  db.prepare('INSERT INTO DestinyInventoryItemDefinition VALUES (?, ?)').run(
    hashToId(999), JSON.stringify({
      hash: 999,
      displayProperties: { name: 'Test Rifle' },
      itemTypeDisplayName: 'Auto Rifle',
      inventory: { tierTypeName: 'Legendary' },
    }));
  db.close();
  openManifestFile(file);
});

describe('itemSummary', () => {
  it('resolves names, power, and drops noise', () => {
    const s = itemSummary(
      { itemHash: 999, itemInstanceId: '123', quantity: 1 },
      { '123': { primaryStat: { value: 2010 } } },
    );
    expect(s).toEqual({
      name: 'Test Rifle', itemHash: 999, itemInstanceId: '123',
      type: 'Auto Rifle', tier: 'Legendary', power: 2010, quantity: undefined,
    });
  });

  it('falls back to #hash when def missing', () => {
    expect(itemSummary({ itemHash: 1, quantity: 3 }).name).toBe('#1');
  });
});

describe('tool wrapper', () => {
  it('wraps success as text content', async () => {
    const h = tool(async () => ({ a: 1 }));
    expect(await h({})).toEqual({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
  });

  it('wraps errors as isError result, no stack', async () => {
    const h = tool(async () => { throw new Error('boom'); });
    const r = await h({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('boom');
    expect(r.content[0].text).not.toContain('    at ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/read.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write `src/tools/util.ts`**

```ts
import { BungieError } from '../bungie.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

export const tool =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e: any) {
      const msg = e instanceof BungieError ? `${e.errorStatus}: ${e.message}` : String(e?.message ?? e);
      return { content: [{ type: 'text', text: `Error — ${msg}` }], isError: true };
    }
  };
```

- [ ] **Step 4: Write `src/tools/read.ts` (first four tools)**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName, getDef, searchDefs } from '../manifest.js';
import { tool } from './util.js';

export function itemSummary(item: any, instances?: Record<string, any>) {
  const def = getDef('DestinyInventoryItemDefinition', item.itemHash);
  const inst = item.itemInstanceId ? instances?.[item.itemInstanceId] : undefined;
  return {
    name: def?.displayProperties?.name ?? `#${item.itemHash}`,
    itemHash: item.itemHash,
    itemInstanceId: item.itemInstanceId,
    type: def?.itemTypeDisplayName,
    tier: def?.inventory?.tierTypeName,
    power: inst?.primaryStat?.value,
    quantity: item.quantity > 1 ? item.quantity : undefined,
  };
}

const profilePath = async () => {
  const a = await getAccount();
  return `/Destiny2/${a.membershipType}/Profile/${a.membershipId}`;
};

export function registerReadTools(server: McpServer): void {
  server.registerTool('get_profile', {
    description: 'Destiny 2 account overview: characters (class, power, race, playtime), currencies like Glimmer.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, { auth: true, query: { components: '100,200,103' } });
    return {
      characters: Object.values<any>(r.characters.data).map((c) => ({
        characterId: c.characterId,
        class: defName('DestinyClassDefinition', c.classHash),
        power: c.light,
        race: defName('DestinyRaceDefinition', c.raceHash),
        lastPlayed: c.dateLastPlayed,
        hoursPlayed: Math.round(Number(c.minutesPlayedTotal) / 60),
      })),
      currencies: (r.profileCurrencies?.data?.items ?? []).map((i: any) => ({
        name: defName('DestinyInventoryItemDefinition', i.itemHash),
        quantity: i.quantity,
      })),
    };
  }));

  server.registerTool('get_character', {
    description: 'One character in detail: stats (Mobility etc.) and all currently equipped items with power.',
    inputSchema: z.object({ character_id: z.string().describe('From get_profile') }),
  }, tool(async ({ character_id }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/`, {
      auth: true, query: { components: '200,205,300' },
    });
    const c = r.character.data;
    return {
      class: defName('DestinyClassDefinition', c.classHash),
      power: c.light,
      stats: Object.fromEntries(Object.entries(c.stats).map(([h, v]) => [defName('DestinyStatDefinition', Number(h)), v])),
      equipped: r.equipment.data.items.map((i: any) => itemSummary(i, r.itemComponents?.instances?.data)),
    };
  }));

  server.registerTool('search_inventory', {
    description: 'Search ALL items across every character and the vault. Filter by name and/or item type substring (e.g. "Rocket Launcher", "Helmet"). Returns instance ids needed by transfer/equip tools.',
    inputSchema: z.object({
      name: z.string().optional().describe('Case-insensitive name substring'),
      type: z.string().optional().describe('Case-insensitive item type substring, e.g. "Hand Cannon"'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  }, tool(async ({ name, type, limit }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, {
      auth: true, query: { components: '102,201,205,200,300' },
    });
    const chars = r.characters.data;
    const instances = r.itemComponents?.instances?.data;
    const locName = (cid: string, equipped: boolean) =>
      `${defName('DestinyClassDefinition', chars[cid].classHash)}${equipped ? ' (equipped)' : ''}`;
    const all: any[] = [
      ...(r.profileInventory?.data?.items ?? []).map((i: any) => ({ ...i, location: 'Vault' })),
      ...Object.entries<any>(r.characterInventories?.data ?? {}).flatMap(([cid, inv]) =>
        inv.items.map((i: any) => ({ ...i, location: locName(cid, false), characterId: cid }))),
      ...Object.entries<any>(r.characterEquipment?.data ?? {}).flatMap(([cid, inv]) =>
        inv.items.map((i: any) => ({ ...i, location: locName(cid, true), characterId: cid }))),
    ];
    const nameQ = name?.toLowerCase(), typeQ = type?.toLowerCase();
    const out = [];
    for (const item of all) {
      const s = { ...itemSummary(item, instances), location: item.location, characterId: item.characterId };
      if (nameQ && !s.name.toLowerCase().includes(nameQ)) continue;
      if (typeQ && !(s.type ?? '').toLowerCase().includes(typeQ)) continue;
      out.push(s);
      if (out.length >= limit) break;
    }
    return { count: out.length, items: out };
  }));

  server.registerTool('get_item_details', {
    description: 'Full detail for one item instance: perks/mods in each socket (with socket indexes for insert_plug), stats, energy.',
    inputSchema: z.object({ item_instance_id: z.string() }),
  }, tool(async ({ item_instance_id }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Item/${item_instance_id}/`, {
      auth: true, query: { components: '300,302,304,305' },
    });
    const inst = r.instance?.data;
    return {
      name: defName('DestinyInventoryItemDefinition', r.item?.data?.itemHash ?? 0),
      power: inst?.primaryStat?.value,
      energy: inst?.energy ? { used: inst.energy.energyUsed, capacity: inst.energy.energyCapacity } : undefined,
      stats: Object.fromEntries(Object.entries<any>(r.stats?.data?.stats ?? {})
        .map(([h, s]) => [defName('DestinyStatDefinition', Number(h)), s.value])),
      sockets: (r.sockets?.data?.sockets ?? []).map((s: any, i: number) => ({
        socketIndex: i,
        plug: s.plugHash ? defName('DestinyInventoryItemDefinition', s.plugHash) : null,
        plugHash: s.plugHash,
        enabled: s.isEnabled,
      })),
    };
  }));
}
```

Note: `get_item_details` needs component `307` semantics? No — `Item/{id}/` accepts the components listed; `r.item.data.itemHash` comes back with component `300`... If `r.item` is absent at runtime, add component `302`'s sibling `ItemCommonData = 307`? Correct fix if name comes back empty during live smoke: request components `300,302,304,305,307` and read `r.item.data.itemHash` (component 307 populates `item`). Live smoke in Task 11 verifies; adjust then if needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: tool plumbing and profile/character/inventory/item read tools"
```

---

### Task 7: Read tools B (vendors, loadouts, milestones)

**Files:**
- Modify: `src/tools/read.ts` (append registrations inside `registerReadTools`)
- Test: append to `tests/read.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produced; `firstHash` not needed here.
- Produces: `formatSales(sales: Record<string, any>): { name, itemHash, vendorItemIndex, costs: string[] }[]` exported from `src/tools/read.ts`; tools `get_vendors`, `get_vendor_items`, `get_loadouts`, `get_milestones`.

- [ ] **Step 1: Write the failing test (append to `tests/read.test.ts`)**

```ts
import { formatSales } from '../src/tools/read.js';
// beforeAll fixture from Task 6 already registers item 999 'Test Rifle'.

describe('formatSales', () => {
  it('resolves item and cost names', () => {
    const sales = {
      '5': { itemHash: 999, vendorItemIndex: 5, costs: [{ itemHash: 999, quantity: 25 }] },
    };
    expect(formatSales(sales)).toEqual([
      { name: 'Test Rifle', itemHash: 999, vendorItemIndex: 5, costs: ['25 Test Rifle'] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/read.test.ts`
Expected: FAIL — `formatSales` not exported.

- [ ] **Step 3: Append to `src/tools/read.ts`**

Exported helper (module level):
```ts
export function formatSales(sales: Record<string, any>) {
  return Object.values<any>(sales).map((s) => ({
    name: defName('DestinyInventoryItemDefinition', s.itemHash),
    itemHash: s.itemHash,
    vendorItemIndex: s.vendorItemIndex,
    costs: (s.costs ?? []).map((c: any) => `${c.quantity} ${defName('DestinyInventoryItemDefinition', c.itemHash)}`),
  }));
}
```

Inside `registerReadTools`, append:
```ts
  server.registerTool('get_vendors', {
    description: 'List all currently available vendors (Xur, Banshee-44, Ada-1...) with refresh times. Use get_vendor_items for stock.',
    inputSchema: z.object({ character_id: z.string().describe('Vendors are per-character; from get_profile') }),
  }, tool(async ({ character_id }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/Vendors/`, {
      auth: true, query: { components: '400' },
    });
    return Object.values<any>(r.vendors.data)
      .map((v) => ({
        vendorHash: v.vendorHash,
        name: defName('DestinyVendorDefinition', v.vendorHash),
        nextRefresh: v.nextRefreshDate,
        enabled: v.enabled,
      }))
      .filter((v) => !v.name.startsWith('#'));
  }));

  server.registerTool('get_vendor_items', {
    description: "One vendor's current stock with costs. vendor_hash from get_vendors (Xur: 2190858386).",
    inputSchema: z.object({ character_id: z.string(), vendor_hash: z.number().int() }),
  }, tool(async ({ character_id, vendor_hash }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/Vendors/${vendor_hash}/`, {
      auth: true, query: { components: '402' },
    });
    return {
      vendor: defName('DestinyVendorDefinition', vendor_hash),
      items: formatSales(r.sales?.data ?? {}),
    };
  }));

  server.registerTool('get_loadouts', {
    description: 'In-game loadout slots per character. loadout_index feeds equip_loadout / snapshot_loadout.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, { auth: true, query: { components: '206,200' } });
    const chars = r.characters.data;
    return Object.entries<any>(r.characterLoadouts?.data ?? {}).map(([cid, l]) => ({
      characterId: cid,
      class: defName('DestinyClassDefinition', chars[cid].classHash),
      loadouts: l.loadouts.map((lo: any, i: number) => ({
        loadoutIndex: i,
        name: defName('DestinyLoadoutNameDefinition', lo.nameHash),
        empty: !lo.items?.length,
        itemInstanceIds: (lo.items ?? []).map((it: any) => it.itemInstanceId),
      })),
    }));
  }));

  server.registerTool('get_milestones', {
    description: 'Current weekly milestones/activities across the game (public info, no character needed).',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>('/Destiny2/Milestones/');
    return Object.values<any>(r)
      .map((m) => {
        const def = getDef('DestinyMilestoneDefinition', m.milestoneHash);
        return def?.displayProperties?.name
          ? { name: def.displayProperties.name, description: def.displayProperties.description, ends: m.endDate }
          : null;
      })
      .filter(Boolean);
  }));
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsc && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: vendor, loadout, and milestone read tools"
```

---

### Task 8: Read tools C (history, stats, clan, player search, manifest search)

**Files:**
- Modify: `src/tools/read.ts` (append inside `registerReadTools`)
- Test: append to `tests/read.test.ts`

**Interfaces:**
- Consumes: Task 6 exports.
- Produces: `parseBungieName(full: string): { displayName: string; displayNameCode: number }` exported from `src/tools/read.ts` (throws readable error if no `#code`); tools `get_activity_history`, `get_stats`, `get_clan`, `search_player`, `search_manifest`.

- [ ] **Step 1: Write the failing test (append to `tests/read.test.ts`)**

```ts
import { parseBungieName } from '../src/tools/read.js';

describe('parseBungieName', () => {
  it('splits on the last #', () => {
    expect(parseBungieName('Cool#Guy#1234')).toEqual({ displayName: 'Cool#Guy', displayNameCode: 1234 });
  });
  it('throws readable error without code', () => {
    expect(() => parseBungieName('NoCode')).toThrowError(/Name#1234/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/read.test.ts`
Expected: FAIL — `parseBungieName` not exported.

- [ ] **Step 3: Append to `src/tools/read.ts`**

Module-level helper:
```ts
export function parseBungieName(full: string): { displayName: string; displayNameCode: number } {
  const i = full.lastIndexOf('#');
  const code = Number(full.slice(i + 1));
  if (i < 1 || !Number.isInteger(code)) throw new Error(`Bungie names look like "Name#1234", got "${full}"`);
  return { displayName: full.slice(0, i), displayNameCode: code };
}
```

Inside `registerReadTools`, append:
```ts
  server.registerTool('get_activity_history', {
    description: 'Recent completed activities for a character. mode: 0=all, 5=PvP, 7=PvE, 4=raid, 82=dungeon, 84=Trials, 46=GM nightfall.',
    inputSchema: z.object({
      character_id: z.string(),
      mode: z.number().int().default(0),
      count: z.number().int().min(1).max(50).default(10),
    }),
  }, tool(async ({ character_id, mode, count }) => {
    const a = await getAccount();
    const r = await bungieFetch<any>(
      `/Destiny2/${a.membershipType}/Account/${a.membershipId}/Character/${character_id}/Stats/Activities/`,
      { auth: true, query: { mode, count, page: 0 } },
    );
    return (r.activities ?? []).map((act: any) => ({
      date: act.period,
      activity: defName('DestinyActivityDefinition', act.activityDetails.directorActivityHash),
      completed: act.values.completed?.basic?.displayValue,
      kills: act.values.kills?.basic?.value,
      deaths: act.values.deaths?.basic?.value,
      kd: act.values.killsDeathsRatio?.basic?.displayValue,
      standing: act.values.standing?.basic?.displayValue,
    }));
  }));

  server.registerTool('get_stats', {
    description: 'Lifetime account stats, split PvE / PvP: kills, K/D, activities cleared, time played, and more.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Account/${a.membershipId}/Stats/`, {
      auth: true, query: { groups: 'General' },
    });
    const prune = (side: any) =>
      Object.fromEntries(Object.entries<any>(side?.allTime ?? {}).map(([k, v]) => [k, v.basic.displayValue]));
    return {
      pve: prune(r.mergedAllCharacters?.results?.allPvE),
      pvp: prune(r.mergedAllCharacters?.results?.allPvP),
    };
  }));

  server.registerTool('get_clan', {
    description: "The account's clan: name, motto, member count, online members.",
    inputSchema: z.object({}),
  }, tool(async () => {
    const a = await getAccount();
    const g = await bungieFetch<any>(`/GroupV2/User/${a.membershipType}/${a.membershipId}/0/1/`, { auth: true });
    const group = g.results?.[0]?.group;
    if (!group) return 'Not in a clan.';
    const members = await bungieFetch<any>(`/GroupV2/${group.groupId}/Members/`);
    return {
      name: group.name,
      motto: group.motto,
      about: group.about,
      memberCount: group.memberCount,
      members: (members.results ?? []).map((m: any) => ({
        name: `${m.destinyUserInfo.bungieGlobalDisplayName}#${m.destinyUserInfo.bungieGlobalDisplayNameCode}`,
        online: m.isOnline,
      })),
    };
  }));

  server.registerTool('search_player', {
    description: 'Find any player by full Bungie name ("Guardian#1234") → their membership ids.',
    inputSchema: z.object({ bungie_name: z.string() }),
  }, tool(async ({ bungie_name }) => {
    const r = await bungieFetch<any>('/Destiny2/SearchDestinyPlayerByBungieName/-1/', {
      method: 'POST', body: parseBungieName(bungie_name),
    });
    return (r ?? []).map((p: any) => ({
      membershipType: p.membershipType,
      membershipId: p.membershipId,
      name: `${p.bungieGlobalDisplayName}#${p.bungieGlobalDisplayNameCode}`,
    }));
  }));

  server.registerTool('search_manifest', {
    description: 'Look up any Destiny definition by name → hash. Items by default; set table for perks (DestinySandboxPerkDefinition), activities (DestinyActivityDefinition), etc.',
    inputSchema: z.object({
      query: z.string(),
      table: z.string().default('DestinyInventoryItemDefinition'),
      limit: z.number().int().min(1).max(100).default(25),
    }),
  }, tool(async ({ query, table, limit }) => searchDefs(query, table, limit)));
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsc && npx vitest run`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: stats, clan, player and manifest search read tools"
```

---

### Task 9: Write tools

**Files:**
- Create: `src/tools/write.ts`
- Test: `tests/write.test.ts`

**Interfaces:**
- Consumes: `bungieFetch`, `getAccount` from `src/bungie.ts` (mocked in tests via `vi.mock`); `searchDefs`, `firstHash`, `defName` from `src/manifest.ts`; `tool` from `./util.js`.
- Produces: `registerWriteTools(server: McpServer): void`; helper `resolvePlugHash(plug: string): number` exported (numeric string → hash; otherwise manifest name search, throws readable error when not found).
- All Bungie action endpoints are `POST` with `auth: true`; every body includes `membershipType` from `getAccount()`.

- [ ] **Step 1: Write the failing tests**

`tests/write.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bungie.js', () => ({
  bungieFetch: vi.fn(async () => ({})),
  getAccount: vi.fn(async () => ({ membershipType: 3, membershipId: 'MID', characterIds: ['C1'] })),
  BungieError: class BungieError extends Error {},
}));
vi.mock('../src/manifest.js', () => ({
  searchDefs: vi.fn((q: string) => (q === 'Sunshot' ? [{ hash: 555, name: 'Sunshot' }] : [])),
  firstHash: vi.fn(() => 111),
  defName: vi.fn(() => 'X'),
  getDef: vi.fn(() => undefined),
}));

const { registerWriteTools, resolvePlugHash } = await import('../src/tools/write.js');
const { bungieFetch } = await import('../src/bungie.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerWriteTools({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}

beforeEach(() => vi.mocked(bungieFetch).mockClear());

describe('write tools', () => {
  it('transfer_item posts correct body', async () => {
    await capture().transfer_item({
      item_instance_id: 'IID', item_hash: 999, character_id: 'C1', to_vault: true, stack_size: 1,
    });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/TransferItem/', {
      method: 'POST', auth: true,
      body: { itemReferenceHash: 999, stackSize: 1, transferToVault: true, itemId: 'IID', characterId: 'C1', membershipType: 3 },
    });
  });

  it('insert_plug resolves plug name to hash', async () => {
    await capture().insert_plug({ item_instance_id: 'IID', character_id: 'C1', socket_index: 4, plug: 'Sunshot' });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/InsertSocketPlugFree/', {
      method: 'POST', auth: true,
      body: {
        plug: { socketIndex: 4, socketArrayType: 0, plugItemHash: 555 },
        itemId: 'IID', characterId: 'C1', membershipType: 3,
      },
    });
  });

  it('resolvePlugHash: numeric passthrough, unknown name throws readable', () => {
    expect(resolvePlugHash('12345')).toBe(12345);
    expect(() => resolvePlugHash('Nope Nothing')).toThrowError(/search_manifest/);
  });

  it('set_lock_state posts state', async () => {
    await capture().set_lock_state({ item_instance_id: 'IID', character_id: 'C1', locked: true });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/SetLockState/', {
      method: 'POST', auth: true,
      body: { state: true, itemId: 'IID', characterId: 'C1', membershipType: 3 },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/write.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/tools/write.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName, firstHash, getDef, searchDefs } from '../manifest.js';
import { tool } from './util.js';

const ACTIONS = '/Destiny2/Actions';

export function resolvePlugHash(plug: string): number {
  if (/^\d+$/.test(plug)) return Number(plug);
  const hit = searchDefs(plug, 'DestinyInventoryItemDefinition', 1)[0];
  if (!hit) throw new Error(`No mod/perk named "${plug}" found. Use search_manifest to find the exact name.`);
  return hit.hash;
}

async function post(path: string, body: Record<string, unknown>) {
  const a = await getAccount();
  return bungieFetch(path, { method: 'POST', auth: true, body: { ...body, membershipType: a.membershipType } });
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool('transfer_item', {
    description: 'Move an item between a character and the vault. Get item_instance_id + item_hash from search_inventory. To move char→char: transfer to vault first, then vault→other char.',
    inputSchema: z.object({
      item_instance_id: z.string(),
      item_hash: z.number().int(),
      character_id: z.string().describe('Source character when to_vault, destination when from vault'),
      to_vault: z.boolean(),
      stack_size: z.number().int().default(1),
    }),
  }, tool(async ({ item_instance_id, item_hash, character_id, to_vault, stack_size }) => {
    await post(`${ACTIONS}/Items/TransferItem/`, {
      itemReferenceHash: item_hash, stackSize: stack_size, transferToVault: to_vault,
      itemId: item_instance_id, characterId: character_id,
    });
    return `Transferred ${defName('DestinyInventoryItemDefinition', item_hash)} ${to_vault ? 'to vault' : 'to character'}.`;
  }));

  server.registerTool('equip_item', {
    description: 'Equip one item on a character. Only works in orbit/social spaces or offline (Bungie restriction).',
    inputSchema: z.object({ item_instance_id: z.string(), character_id: z.string() }),
  }, tool(async ({ item_instance_id, character_id }) => {
    await post(`${ACTIONS}/Items/EquipItem/`, { itemId: item_instance_id, characterId: character_id });
    return 'Equipped.';
  }));

  server.registerTool('equip_items', {
    description: 'Equip several items at once on a character (full loadout swap). Same location restriction as equip_item.',
    inputSchema: z.object({ item_instance_ids: z.array(z.string()).min(1).max(20), character_id: z.string() }),
  }, tool(async ({ item_instance_ids, character_id }) => {
    const r: any = await post(`${ACTIONS}/Items/EquipItems/`, { itemIds: item_instance_ids, characterId: character_id });
    return (r.equipResults ?? []).map((e: any) => ({
      itemInstanceId: e.itemInstanceId,
      ok: e.equipStatus === 1,
      status: e.equipStatus,
    }));
  }));

  server.registerTool('equip_loadout', {
    description: 'Apply a saved in-game loadout slot. Get loadout_index from get_loadouts.',
    inputSchema: z.object({ loadout_index: z.number().int().min(0), character_id: z.string() }),
  }, tool(async ({ loadout_index, character_id }) => {
    await post(`${ACTIONS}/Loadouts/EquipLoadout/`, { loadoutIndex: loadout_index, characterId: character_id });
    return 'Loadout equipped.';
  }));

  server.registerTool('snapshot_loadout', {
    description: "Save the character's CURRENT equipment into an in-game loadout slot (overwrites that slot).",
    inputSchema: z.object({
      loadout_index: z.number().int().min(0),
      character_id: z.string(),
      name_hash: z.number().int().optional().describe('DestinyLoadoutNameDefinition hash; default = first'),
      color_hash: z.number().int().optional(),
      icon_hash: z.number().int().optional(),
    }),
  }, tool(async ({ loadout_index, character_id, name_hash, color_hash, icon_hash }) => {
    await post(`${ACTIONS}/Loadouts/SnapshotLoadout/`, {
      loadoutIndex: loadout_index, characterId: character_id,
      nameHash: name_hash ?? firstHash('DestinyLoadoutNameDefinition'),
      colorHash: color_hash ?? firstHash('DestinyLoadoutColorDefinition'),
      iconHash: icon_hash ?? firstHash('DestinyLoadoutIconDefinition'),
    });
    return `Saved current gear to loadout slot ${loadout_index}.`;
  }));

  server.registerTool('pull_from_postmaster', {
    description: 'Pull an item from the postmaster to the character. Find postmaster items via search_inventory (they sit in the Lost Items bucket).',
    inputSchema: z.object({ item_instance_id: z.string(), item_hash: z.number().int(), character_id: z.string(), stack_size: z.number().int().default(1) }),
  }, tool(async ({ item_instance_id, item_hash, character_id, stack_size }) => {
    await post(`${ACTIONS}/Items/PullFromPostmaster/`, {
      itemReferenceHash: item_hash, stackSize: stack_size, itemId: item_instance_id, characterId: character_id,
    });
    return `Pulled ${defName('DestinyInventoryItemDefinition', item_hash)} from postmaster.`;
  }));

  server.registerTool('set_lock_state', {
    description: 'Lock or unlock an item (protects from dismantle in game).',
    inputSchema: z.object({ item_instance_id: z.string(), character_id: z.string(), locked: z.boolean() }),
  }, tool(async ({ item_instance_id, character_id, locked }) => {
    await post(`${ACTIONS}/Items/SetLockState/`, { state: locked, itemId: item_instance_id, characterId: character_id });
    return locked ? 'Locked.' : 'Unlocked.';
  }));

  server.registerTool('insert_plug', {
    description: 'Socket a mod/aspect/fragment/free perk into an item (armor mods, subclass configuration, crafted weapon free swaps). plug = exact name or hash. socket_index from get_item_details. Only FREE socket operations work (Bungie blocks paid ones for all third-party apps).',
    inputSchema: z.object({
      item_instance_id: z.string(),
      character_id: z.string(),
      socket_index: z.number().int().min(0),
      plug: z.string().describe('Exact plug name (e.g. "Grenade Kickstart") or numeric hash'),
    }),
  }, tool(async ({ item_instance_id, character_id, socket_index, plug }) => {
    const plugItemHash = resolvePlugHash(plug);
    await post(`${ACTIONS}/Items/InsertSocketPlugFree/`, {
      plug: { socketIndex: socket_index, socketArrayType: 0, plugItemHash },
      itemId: item_instance_id, characterId: character_id,
    });
    return `Socketed ${defName('DestinyInventoryItemDefinition', plugItemHash)} into socket ${socket_index}.`;
  }));

  server.registerTool('change_subclass', {
    description: 'Equip a subclass by name (e.g. "Solar", "Prismatic") and optionally configure its super/aspects/fragments in one call. For plugs: first call get_item_details on the subclass instance to see socket indexes.',
    inputSchema: z.object({
      character_id: z.string(),
      subclass_name: z.string(),
      plugs: z.array(z.object({ socket_index: z.number().int().min(0), plug: z.string() })).default([]),
    }),
  }, tool(async ({ character_id, subclass_name, plugs }) => {
    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
      auth: true, query: { components: '201,205' },
    });
    const items = [
      ...(r.characterInventories?.data?.[character_id]?.items ?? []),
      ...(r.characterEquipment?.data?.[character_id]?.items ?? []),
    ];
    const q = subclass_name.toLowerCase();
    // itemType 16 = Subclass
    const subclass = items.find((i: any) => {
      const def = getDef('DestinyInventoryItemDefinition', i.itemHash);
      return def?.itemType === 16 && def.displayProperties.name.toLowerCase().includes(q);
    });
    if (!subclass) throw new Error(`No subclass matching "${subclass_name}" on that character.`);
    await post(`${ACTIONS}/Items/EquipItem/`, { itemId: subclass.itemInstanceId, characterId: character_id });
    const results = [`Equipped ${defName('DestinyInventoryItemDefinition', subclass.itemHash)}.`];
    for (const p of plugs) {
      const plugItemHash = resolvePlugHash(p.plug);
      await post(`${ACTIONS}/Items/InsertSocketPlugFree/`, {
        plug: { socketIndex: p.socket_index, socketArrayType: 0, plugItemHash },
        itemId: subclass.itemInstanceId, characterId: character_id,
      });
      results.push(`Socket ${p.socket_index} → ${defName('DestinyInventoryItemDefinition', plugItemHash)}.`);
    }
    return results.join('\n');
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: write tools - transfer, equip, loadouts, postmaster, sockets, subclass"
```

---

### Task 10: Raw escape hatch + server wiring

**Files:**
- Create: `src/tools/raw.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `registerReadTools`, `registerWriteTools`, `openManifest`, `startAuthServer`, `bungieFetch`, `config`.
- Produces: `registerRawTool(server: McpServer): void`; running server: `npm start` → MCP at `http://localhost:7777/mcp`, OAuth at `https://localhost:7778`.

- [ ] **Step 1: Write `src/tools/raw.ts`**

```ts
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
```

- [ ] **Step 2: Write `src/index.ts`**

```ts
import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { config } from './config.js';
import { openManifest } from './manifest.js';
import { startAuthServer } from './auth-server.js';
import { readTokens } from './auth.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerRawTool } from './tools/raw.js';

// v1 SDK fallback:
//   import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
//   import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'destiny2', version: '1.0.0' });
  registerReadTools(server);
  registerWriteTools(server);
  registerRawTool(server);
  return server;
}

async function main() {
  for (const k of ['apiKey', 'clientId', 'clientSecret'] as const) {
    if (!config[k]) {
      console.error(`Missing Bungie credential in .env (see .env.example). Missing: ${k}`);
      process.exit(1);
    }
  }

  await openManifest();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/mcp', async (req, res) => {
    // ponytail: stateless — fresh server+transport per request, no session bookkeeping
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'POST only (stateless mode)' }); });

  app.listen(config.port, () => {
    console.log(`MCP endpoint: http://localhost:${config.port}/mcp`);
    const t = readTokens();
    if (!t) console.log(`Not authenticated yet — open https://localhost:${config.authPort}/auth`);
    else if (Date.now() > t.refreshExpiresAt - 7 * 24 * 3600 * 1000) {
      console.warn(`WARNING: Bungie refresh token expires soon — re-auth at https://localhost:${config.authPort}/auth`);
    }
  });

  startAuthServer();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Boot check (no Bungie account needed)**

With a real `BUNGIE_API_KEY` in `.env` the manifest downloads. If the executing agent has no key yet: create `.env` from `.env.example` with placeholder values and expect the manifest fetch to fail with a clear Bungie error — that still proves wiring runs. With a key, verify:

Run (background): `npm start`
Then: `curl -s -X POST http://localhost:7777/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`
Expected: JSON-RPC result listing 22 tools (13 read + 8 write + bungie_api_call). Note: in stateless Streamable HTTP, `tools/list` without prior `initialize` may require the client flow — if the curl errors with "server not initialized", send an `initialize` request first with the same curl pattern (`method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "curl", version: "0"}}`) — but a fresh transport per request means each request stands alone; the SDK accepts initialize-less requests in stateless mode.

- [ ] **Step 4: Run full test suite + typecheck**

Run: `npx tsc && npx vitest run`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: raw Bungie escape hatch and MCP server wiring"
```

---

### Task 11: Smoke script + README

**Files:**
- Create: `scripts/smoke.ts`, `README.md`

**Interfaces:**
- Consumes: `openManifest`, `searchDefs` from `src/manifest.ts`; `getAccount`, `bungieFetch` from `src/bungie.ts`; `readTokens` from `src/auth.ts`.
- Produces: `npm run smoke` — read-only live verification; `README.md` — complete setup walkthrough.

- [ ] **Step 1: Write `scripts/smoke.ts`**

```ts
// Read-only live smoke test. Requires .env + completed OAuth (tokens.json).
import { openManifest, searchDefs } from '../src/manifest.js';
import { getAccount, bungieFetch } from '../src/bungie.js';
import { readTokens } from '../src/auth.js';

if (!readTokens()) {
  console.error('No tokens.json — run `npm start` and complete https://localhost:7778/auth first.');
  process.exit(1);
}

await openManifest();

const gjally = searchDefs('Gjallarhorn')[0];
console.log('manifest lookup:', gjally);
if (gjally?.name !== 'Gjallarhorn') throw new Error('Manifest search failed');

const a = await getAccount();
console.log('account:', a.membershipType, a.membershipId, `${a.characterIds.length} characters`);

const prof = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
  auth: true, query: { components: '200' },
});
for (const c of Object.values<any>(prof.characters.data)) {
  console.log(`character ${c.characterId}: power ${c.light}`);
}
console.log('SMOKE OK');
```

- [ ] **Step 2: Write `README.md`**

Must contain, in this order (write real prose, not placeholders):
1. **What it is** — Destiny 2 MCP server: full read/write Bungie API access for ChatGPT web, Claude, any MCP client. Runs locally.
2. **Prereqs** — Node ≥ 20; a Bungie.net account.
3. **Bungie app registration** — step-by-step at https://www.bungie.net/en/Application: create app, OAuth Client Type = `Confidential`, Redirect URL = `https://localhost:7778/callback`, scopes: check *Read your Destiny 2 information*, *Move or equip Destiny gear*, and the other read scopes; copy API Key, OAuth client_id, client_secret.
4. **Setup** — `cp .env.example .env` (fill in the three Bungie values), `npm install`, `npm run setup`, `npm start`, open `https://localhost:7778/auth`, click through the self-signed-cert warning, sign in. First boot downloads the ~200MB manifest.
5. **Verify** — `npm run smoke`.
6. **Connect ChatGPT web** — Settings → Connectors → Advanced → Developer mode; needs a public URL: run a tunnel (`cloudflared tunnel --url http://localhost:7777`), then add connector with URL `https://<tunnel-host>/mcp`, no auth. Security note: anyone with the tunnel URL controls your Destiny inventory — protect it (Cloudflare Access) or keep the URL secret and rotating.
7. **Connect Claude Code** — `claude mcp add --transport http destiny2 http://localhost:7777/mcp`. Claude Desktop: Settings → Connectors → Add custom connector.
8. **Tool list** — table of the 22 tools with one-line descriptions (copy from the tool registrations).
9. **Known Bungie limits** — equipping only in orbit/offline; paid perk swaps blocked for all third-party apps (`AdvancedWriteActions`); refresh token expires after 90 days → re-auth.

- [ ] **Step 3: Live verification (needs the human once)**

If `.env` has real credentials and OAuth was completed: run `npm run smoke` — expect `SMOKE OK`.
If not (executing agent without credentials): run `npx tsx --check scripts/smoke.ts` for syntax, and flag to the human: "Smoke test needs your Bungie app credentials + one-time OAuth — run `npm run setup && npm start`, complete `https://localhost:7778/auth`, then `npm run smoke`."

- [ ] **Step 4: Full suite one last time**

Run: `npx tsc && npx vitest run`
Expected: clean.

- [ ] **Step 5: Commit + push**

```bash
git add -A && git commit -m "feat: live smoke script and README"
git push
```

---

## Verification checklist (after all tasks)

- [ ] `npx tsc` clean, `npx vitest run` all green.
- [ ] `npm start` boots: manifest loads, MCP on 7777, OAuth on 7778.
- [ ] `curl` `tools/list` returns 22 tools.
- [ ] Human completes OAuth once; `npm run smoke` prints `SMOKE OK`.
- [ ] Write-tool live test (human-supervised, real account): `search_inventory` for a junk item → `transfer_item` to vault → verify in game/DIM → transfer back.
