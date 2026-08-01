import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/manifest.js', () => ({
  getDef: vi.fn(() => undefined),
  defName: vi.fn((_t: string, hash: number) => `Item${hash}`),
}));

const { buildRanks } = await import('../src/progress.js');
const { getDef } = await import('../src/manifest.js');

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
