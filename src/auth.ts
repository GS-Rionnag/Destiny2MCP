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
