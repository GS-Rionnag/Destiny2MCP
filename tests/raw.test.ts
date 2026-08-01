import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bungie.js', () => ({
  bungieFetch: vi.fn(async () => ({})),
  BungieError: class BungieError extends Error {},
}));
vi.mock('../src/endpoints.js', () => ({
  listEndpoints: vi.fn(async () => []),
  describeEndpoint: vi.fn(async () => ({})),
}));

const { registerRawTool } = await import('../src/tools/raw.js');
const { bungieFetch } = await import('../src/bungie.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerRawTool({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}

const parse = (res: any) => JSON.parse(res.content[0].text);
const call = (over: Record<string, unknown> = {}) => capture().bungie_api_call({
  method: 'GET', path: '/Destiny2/3/Profile/1/', auth: true, allow_large_response: false, ...over,
});

// Comfortably past the 100KB guard.
const bloat = { junk: 'x'.repeat(200_000) };
const profile = {
  characterActivities: { data: {
    C1: { currentActivityHash: 82913930, other: 1 },
    C2: { currentActivityHash: 0, other: 2 },
  } },
  profile: { data: { userInfo: { displayName: 'Guardian' } } },
};

beforeEach(() => { vi.mocked(bungieFetch).mockReset(); });

describe('bungie_api_call select', () => {
  it('expands * to one entry per key, keyed by the resolved path', async () => {
    vi.mocked(bungieFetch).mockResolvedValue(profile as any);
    expect(parse(await call({ select: ['characterActivities.data.*.currentActivityHash'] }))).toEqual({
      'characterActivities.data.C1.currentActivityHash': 82913930,
      'characterActivities.data.C2.currentActivityHash': 0,
    });
  });

  it('reports an unmatched path instead of hiding it, and still resolves its siblings', async () => {
    vi.mocked(bungieFetch).mockResolvedValue(profile as any);
    const out = parse(await call({ select: ['profile.data.userInfo.displayName', 'nope.not.here'] }));
    expect(out['profile.data.userInfo.displayName']).toBe('Guardian');
    expect(out.unmatchedSelect).toEqual(['nope.not.here']);
  });
});

describe('bungie_api_call size guard', () => {
  it('replaces an oversized unprojected response with a map of where the weight is', async () => {
    vi.mocked(bungieFetch).mockResolvedValue({ ...bloat, small: 'ok' } as any);
    const out = parse(await call());
    expect(out.tooLarge).toBe(true);
    expect(out.bytes).toBeGreaterThan(200_000);
    expect(out.topLevelKeys.junk).toBeGreaterThan(out.topLevelKeys.small);
    expect(out.hint).toContain('select');
  });

  it('still guards when the projection itself is oversized', async () => {
    vi.mocked(bungieFetch).mockResolvedValue({ a: bloat } as any);
    expect(parse(await call({ select: ['a.junk'] })).tooLarge).toBe(true);
  });

  it('returns the whole payload when allow_large_response is set', async () => {
    vi.mocked(bungieFetch).mockResolvedValue(bloat as any);
    expect(parse(await call({ allow_large_response: true })).junk).toHaveLength(200_000);
  });

  it('leaves a normal response untouched', async () => {
    vi.mocked(bungieFetch).mockResolvedValue(profile as any);
    expect(parse(await call())).toEqual(profile);
  });
});
