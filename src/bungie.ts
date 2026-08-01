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

// ponytail: 60s TTL cache on GETs, wiped wholesale by any write. Single-user server, so no
// size cap and no per-key invalidation — add those if this ever serves more than one account.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: unknown }>();

export const clearCache = () => cache.clear();

export async function bungieFetch<T = any>(path: string, opts: FetchOpts = {}, retried = false): Promise<T> {
  const method = opts.method ?? 'GET';
  const key = method === 'GET' ? `${opts.auth ? 'a' : '-'}${path}?${JSON.stringify(opts.query ?? {})}` : '';
  if (key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
  }

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
    method,
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
  if (method !== 'GET') cache.clear(); // a write just changed game state — nothing cached is trustworthy
  if (key) cache.set(key, { at: Date.now(), data: data.Response });
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
