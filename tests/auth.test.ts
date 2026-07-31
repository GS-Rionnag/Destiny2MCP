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
