import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bungie.js', () => ({
  bungieFetch: vi.fn(async () => ({})),
  getAccount: vi.fn(async () => ({ membershipType: 3, membershipId: 'MID' })),
  BungieError: class BungieError extends Error {},
}));
vi.mock('../src/manifest.js', () => ({
  getDef: vi.fn(() => undefined),
  defName: vi.fn((_t: string, hash: number) => `Item${hash}`),
}));

const { registerProgressTools } = await import('../src/tools/progress.js');
const { bungieFetch } = await import('../src/bungie.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerProgressTools({ registerTool: (n: string, _c: any, h: Function) => (tools[n] = h) } as any);
  return tools;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

const profile = {
  profile: { data: { currentSeasonHash: 0 } },
  characters: {
    data: {
      C1: { characterId: 'C1', classHash: 1, light: 2010, dateLastPlayed: '2026-07-30T00:00:00Z' },
      C2: { characterId: 'C2', classHash: 2, light: 1990, dateLastPlayed: '2026-08-01T00:00:00Z' },
    },
  },
  characterProgressions: { data: { C1: {}, C2: {} } },
  characterInventories: { data: { C1: { items: [] }, C2: { items: [] } } },
};

beforeEach(() => {
  vi.mocked(bungieFetch).mockReset().mockResolvedValue(profile as any);
});

describe('get_progress', () => {
  const args = { all_characters: false, all_ranks: false, include_complete: false, limit: 25 };

  it('defaults to the most-recently-played character', async () => {
    const out = parse(await capture().get_progress({ ...args }));
    expect(out.character.characterId).toBe('C2');
  });

  it('fetches every needed component in one call', async () => {
    await capture().get_progress({ ...args });
    expect(vi.mocked(bungieFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bungieFetch).mock.calls[0][1]?.query?.components)
      .toBe('100,104,200,201,202,301,1200');
  });

  it('rejects an unknown character_id by naming the valid ones', async () => {
    const res = await capture().get_progress({ ...args, character_id: 'NOPE' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('C1, C2');
  });

  it('returns one entry per character under all_characters', async () => {
    const out = parse(await capture().get_progress({ ...args, all_characters: true }));
    expect(out.characters.map((c: any) => c.character.characterId)).toEqual(['C1', 'C2']);
  });

  it('reads the artifact from the profile-scoped component, never the character-scoped one', async () => {
    vi.mocked(bungieFetch).mockResolvedValue({
      ...profile,
      profileProgression: {
        data: {
          seasonalArtifact: {
            artifactHash: 7, powerBonus: 12, pointsAcquired: 19,
            pointProgression: { progressToNextLevel: 8400, nextLevelAt: 12000 },
          },
        },
      },
      characterProgressions: {
        // Character-scoped artifact (component 202) only carries artifactHash/pointsUsed/tiers —
        // preferring it yields confident zeros.
        data: { C1: {}, C2: { seasonalArtifact: { artifactHash: 7, pointsUsed: 12 } } },
      },
    } as any);

    const out = parse(await capture().get_progress({ ...args }));
    expect(out.artifact).toEqual({
      name: 'Item7', powerBonus: 12, pointsAcquired: 19, nextPointAt: '8400/12000',
    });
  });

  it('notes a missing progressions component instead of failing', async () => {
    vi.mocked(bungieFetch).mockResolvedValue({ ...profile, characterProgressions: undefined } as any);
    const out = parse(await capture().get_progress({ ...args }));
    expect(out.notes[0]).toContain('characterProgressions');
    expect(out.ranks).toBeUndefined();
  });
});
