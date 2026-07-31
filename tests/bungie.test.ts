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
    const [url, init] = f.mock.calls[0] as any[]; // cast: verbatim brief code fails tsc tuple check
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
