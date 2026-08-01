import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/manifest.js', () => ({
  getDef: vi.fn(() => undefined),
  defName: vi.fn((_t: string, hash: number) => `Item${hash}`),
}));

const { buildRanks, resolveSeasonPass, objectiveLine, substituteVars, buildArtifact } = await import('../src/progress.js');
const { getDef, defName } = await import('../src/manifest.js');

beforeEach(() => {
  vi.mocked(getDef).mockReset().mockReturnValue(undefined);
});

describe('buildRanks', () => {
  it('resolves the rank label from stepIndex and joins progress into one string', () => {
    vi.mocked(getDef).mockImplementation((_t: string, hash: number) =>
      hash === 2083746873
        ? {
            displayProperties: { name: 'Crucible Rank' },
            steps: [{ stepName: 'Guardian I' }, { stepName: 'Heroic III' }],
          }
        : undefined);

    const rows = buildRanks({
      '2083746873': {
        level: 12, stepIndex: 1, progressToNextLevel: 4230, nextLevelAt: 5000, currentResetCount: 2,
      },
    });

    expect(rows).toEqual([
      { name: 'Crucible', rank: 'Heroic III', level: 12, progress: '4230/5000', resets: 2 },
    ]);
  });

  it('drops progressions outside the default list, and keeps them under allRanks', () => {
    vi.mocked(getDef).mockImplementation((_t: string, hash: number) =>
      hash === 2411069437 ? { displayProperties: { name: 'Xur Rank' }, steps: [] } : undefined);

    const progressions = { '2411069437': { level: 4, progressToNextLevel: 1, nextLevelAt: 2 } };

    expect(buildRanks(progressions)).toEqual([]);
    expect(buildRanks(progressions, true)).toEqual([
      { name: 'Xur', rank: undefined, level: 4, progress: '1/2', resets: undefined },
    ]);
  });

  it('filters junk names out of the allRanks dump', () => {
    vi.mocked(getDef).mockReturnValue({ displayProperties: { name: 'XP' }, steps: [] });
    expect(buildRanks({ '999': { level: 1, progressToNextLevel: 0, nextLevelAt: 1 } }, true)).toEqual([]);
  });
});

describe('resolveSeasonPass', () => {
  const season = {
    displayProperties: { name: 'Monument of Triumph' },
    seasonPassList: [
      { seasonPassHash: 1, seasonPassStartDate: '2025-12-02T17:00:00Z', seasonPassEndDate: '2026-06-09T17:00:00Z' },
      { seasonPassHash: 2, seasonPassStartDate: '2026-06-09T17:00:00Z', seasonPassEndDate: '2099-01-01T17:00:00Z' },
    ],
  };

  it('picks the pass whose date window contains now, not the first one', () => {
    vi.mocked(getDef).mockImplementation((table: string, hash: number) => {
      if (table === 'DestinySeasonDefinition') return season;
      if (table === 'DestinySeasonPassDefinition' && hash === 2) {
        return { rewardProgressionHash: 100, prestigeProgressionHash: 200 };
      }
      return undefined;
    });

    const out = resolveSeasonPass(2758726560, {
      '100': { level: 84, progressToNextLevel: 2100, nextLevelAt: 4000 },
    }, new Date('2026-08-01T00:00:00Z'));

    expect(out).toEqual({
      season: 'Monument of Triumph', tier: 84, progress: '2100/4000', prestigeTier: null,
    });
  });

  it('reports the prestige tier once past the cap', () => {
    vi.mocked(getDef).mockImplementation((table: string, hash: number) => {
      if (table === 'DestinySeasonDefinition') return season;
      if (table === 'DestinySeasonPassDefinition' && hash === 2) {
        return { rewardProgressionHash: 100, prestigeProgressionHash: 200 };
      }
      return undefined;
    });

    const out = resolveSeasonPass(2758726560, {
      '100': { level: 100, progressToNextLevel: 0, nextLevelAt: 0 },
      '200': { level: 7, progressToNextLevel: 500, nextLevelAt: 1000 },
    }, new Date('2026-08-01T00:00:00Z'));

    expect(out?.prestigeTier).toBe(7);
  });

  it('returns undefined when the season is not in the manifest', () => {
    vi.mocked(getDef).mockReturnValue(undefined);
    expect(resolveSeasonPass(1, {}, new Date('2026-08-01T00:00:00Z'))).toBeUndefined();
  });
});

describe('objectiveLine', () => {
  it('renders x/y plus the description with string variables substituted', () => {
    vi.mocked(getDef).mockReturnValue({ progressDescription: 'Defeat {var:42} combatants' });
    expect(objectiveLine({ objectiveHash: 1, progress: 9, completionValue: 10 }, { '42': 30 }))
      .toBe('9/10 Defeat 30 combatants');
  });

  it('leaves an unknown variable token alone rather than printing undefined', () => {
    expect(substituteVars('Defeat {var:42} combatants', {})).toBe('Defeat {var:42} combatants');
  });

  it('drops invisible objectives', () => {
    vi.mocked(getDef).mockReturnValue({ progressDescription: 'Hidden' });
    expect(objectiveLine({ objectiveHash: 1, progress: 0, completionValue: 1, visible: false }, {}))
      .toBeUndefined();
  });
});

describe('buildArtifact', () => {
  it('reports power bonus, points and progress to the next point', () => {
    expect(buildArtifact({
      artifactHash: 7, powerBonus: 12, pointsAcquired: 19,
      pointProgression: { progressToNextLevel: 8400, nextLevelAt: 12000 },
    })).toEqual({ name: 'Item7', powerBonus: 12, pointsAcquired: 19, nextPointAt: '8400/12000' });
  });

  it('returns undefined when no artifact is equipped', () => {
    expect(buildArtifact(undefined)).toBeUndefined();
  });
});
