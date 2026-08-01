# get_progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `get_progress` MCP tool that answers "what should I do today" and "where do I stand" — ranks, season pass, seasonal artifact, per-character milestones, and bounty/quest progress — in one Bungie profile call.

**Architecture:** Pure projection logic lives in a new `src/progress.ts` with no network and no MCP imports, mirroring how `src/search/index.ts` holds pure logic that `src/tools/read.ts` merely registers. A thin `src/tools/progress.ts` does the single `bungieFetch` and calls those pure functions. Every pure function is unit-testable by mocking only `src/manifest.js`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), zod schemas, vitest, better-sqlite3 manifest reads via `src/manifest.ts`.

**Spec:** `docs/superpowers/specs/2026-08-01-get-progress-design.md`

## Global Constraints

- Import specifiers must end in `.js` even for `.ts` files (ESM + `tsx`). Follow every existing file.
- Manifest access is only ever through `getDef` / `defName` from `src/manifest.js`. Never open the sqlite file directly.
- Never hardcode a season pass hash. Resolve it through `seasonPassList` date windows. `DestinySeasonDefinition.seasonPassProgressionHash` is `0` on current seasons and must not be used.
- Unresolvable hashes render as `#<hash>`, never dropped.
- Empty sections are omitted from the response entirely, never emitted as `[]` or `null`.
- Completed rows are hidden by default but counted under `hidden`.
- Milestone completion is `true | false | "unknown"` and fails open to `"unknown"`.
- Test command is `npx vitest run <file>`. Filter a single test with `-t "<name>"`.
- Commit messages: Conventional Commits. Do **not** add a `Co-Authored-By` trailer.

## File Structure

| File | Responsibility |
|---|---|
| `src/progress.ts` (create) | Pure projection: ranks, season pass, artifact, objective text, milestones, bounties. No network, no MCP. |
| `src/tools/progress.ts` (create) | `registerProgressTools(server)` — zod schema, one `bungieFetch`, character selection, section assembly. |
| `src/index.ts` (modify) | Register the new tool, bump server version, add an `INSTRUCTIONS` line. |
| `tests/progress.test.ts` (create) | Unit tests for the pure module. |
| `tests/progress-tool.test.ts` (create) | Tool-level tests (character selection, error messages). |

`src/tools/read.ts` is already 550 lines. Nothing is added to it.

---

### Task 1: Rank rows

**Files:**
- Create: `src/progress.ts`
- Test: `tests/progress.test.ts`

**Interfaces:**
- Consumes: `getDef` from `src/manifest.js`
- Produces:
  - `DEFAULT_RANKS: number[]`
  - `progressString(p: any): string`
  - `type Rank = { name: string; rank?: string; level: number; progress: string; resets?: number }`
  - `buildRanks(progressions: Record<string, any>, allRanks?: boolean): Rank[]`

- [ ] **Step 1: Write the failing test**

Create `tests/progress.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/progress.test.ts`
Expected: FAIL — cannot resolve module `../src/progress.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/progress.ts`:

```ts
import { getDef } from './manifest.js';

/**
 * The ranks worth printing by default. Chosen by hand: the manifest holds 172 progression
 * definitions, only 86 are named, and ~15 of those named ones are all literally "XP" — so
 * "keep the named ones" is not a usable filter on its own. allRanks is the escape hatch when
 * a season adds a rank before this list is updated.
 */
export const DEFAULT_RANKS = [
  457612306,   // Vanguard Rank
  2083746873,  // Crucible Rank
  3008065600,  // Gambit Rank
  2755675426,  // Trials Rank
  1471185389,  // Gunsmith Rank
  3011295063,  // Ghost Rank
];

const JUNK_RANK_NAMES = new Set(['XP', 'Classified', 'Prestige', 'Gifted Subs']);

export type Rank = { name: string; rank?: string; level: number; progress: string; resets?: number };

/** Two fields the model always reads together, so send them as one. */
export const progressString = (p: any): string => `${p?.progressToNextLevel ?? 0}/${p?.nextLevelAt ?? 0}`;

export function buildRanks(progressions: Record<string, any>, allRanks = false): Rank[] {
  const rows: { hash: number; row: Rank }[] = [];
  for (const [key, p] of Object.entries(progressions ?? {})) {
    const hash = Number(key);
    const def = getDef('DestinyProgressionDefinition', hash);
    const name: string | undefined = def?.displayProperties?.name;
    if (allRanks ? !name || JUNK_RANK_NAMES.has(name) : !DEFAULT_RANKS.includes(hash)) continue;
    rows.push({
      hash,
      row: {
        // "Crucible Rank" reads as "Crucible" once it sits under a `ranks` key.
        name: (name ?? `#${hash}`).replace(/ Rank$/, ''),
        rank: def?.steps?.[p.stepIndex]?.stepName || undefined,
        level: p.level ?? 0,
        progress: progressString(p),
        resets: p.currentResetCount || undefined,
      },
    });
  }
  rows.sort((a, b) => allRanks
    ? a.row.name.localeCompare(b.row.name)
    : DEFAULT_RANKS.indexOf(a.hash) - DEFAULT_RANKS.indexOf(b.hash));
  return rows.map((r) => r.row);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/progress.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts tests/progress.test.ts
git commit -m "feat: rank rows for get_progress"
```

---

### Task 2: Season pass resolution

**Files:**
- Modify: `src/progress.ts`
- Test: `tests/progress.test.ts`

**Interfaces:**
- Consumes: `getDef`, `progressString` from Task 1
- Produces:
  - `type SeasonPass = { season: string; tier: number; progress: string; prestigeTier: number | null }`
  - `resolveSeasonPass(currentSeasonHash: number, progressions: Record<string, any>, now: Date): SeasonPass | undefined`

- [ ] **Step 1: Write the failing test**

Append to `tests/progress.test.ts` (and add `resolveSeasonPass` to the existing import from `../src/progress.js`):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/progress.test.ts -t "resolveSeasonPass"`
Expected: FAIL — `resolveSeasonPass is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/progress.ts`:

```ts
export type SeasonPass = { season: string; tier: number; progress: string; prestigeTier: number | null };

/**
 * Season passes change several times a year, so the hash is resolved, never hardcoded:
 * currentSeasonHash -> seasonPassList -> the entry whose date window contains now -> the pass
 * definition's reward/prestige progression hashes. Season 28 ships two passes, which is why
 * the first entry is not good enough. DestinySeasonDefinition.seasonPassProgressionHash is 0
 * on current seasons and is deliberately not used as a fallback.
 */
export function resolveSeasonPass(
  currentSeasonHash: number,
  progressions: Record<string, any>,
  now: Date,
): SeasonPass | undefined {
  const season = currentSeasonHash ? getDef('DestinySeasonDefinition', currentSeasonHash) : undefined;
  if (!season) return undefined;

  const t = now.getTime();
  const list: any[] = season.seasonPassList ?? [];
  const entry = list.find((e) =>
    Date.parse(e.seasonPassStartDate) <= t && t < Date.parse(e.seasonPassEndDate)) ?? list.at(-1);

  const pass = entry?.seasonPassHash
    ? getDef('DestinySeasonPassDefinition', entry.seasonPassHash)
    : undefined;
  const reward = pass ? progressions?.[pass.rewardProgressionHash] : undefined;
  if (!reward) return undefined;

  const prestige = progressions?.[pass.prestigeProgressionHash];
  return {
    season: season.displayProperties?.name ?? `#${currentSeasonHash}`,
    tier: reward.level ?? 0,
    progress: progressString(reward),
    prestigeTier: prestige?.level ? prestige.level : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/progress.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts tests/progress.test.ts
git commit -m "feat: resolve season pass through seasonPassList date windows"
```

---

### Task 3: Objective text and artifact

**Files:**
- Modify: `src/progress.ts`
- Test: `tests/progress.test.ts`

**Interfaces:**
- Consumes: `getDef`, `defName` from `src/manifest.js`; `progressString` from Task 1
- Produces:
  - `substituteVars(text: string, vars: Record<string, number>): string`
  - `objectiveLine(o: any, vars: Record<string, number>): string | undefined`
  - `type Artifact = { name: string; powerBonus: number; pointsAcquired: number; nextPointAt?: string }`
  - `buildArtifact(art: any): Artifact | undefined`

- [ ] **Step 1: Write the failing test**

Append to `tests/progress.test.ts` (add `objectiveLine`, `substituteVars`, `buildArtifact` to the import, and `defName` to the `../src/manifest.js` import):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/progress.test.ts -t "objectiveLine"`
Expected: FAIL — `objectiveLine is not a function`.

- [ ] **Step 3: Write minimal implementation**

Change the manifest import at the top of `src/progress.ts` to:

```ts
import { defName, getDef } from './manifest.js';
```

Append:

```ts
/** Bungie objective text embeds live numbers as {var:<hash>}; StringVariables holds the values. */
export const substituteVars = (text: string, vars: Record<string, number>): string =>
  text.replace(/\{var:(\d+)\}/g, (token, hash) => {
    const v = vars?.[hash];
    return v === undefined ? token : String(v);
  });

export function objectiveLine(o: any, vars: Record<string, number>): string | undefined {
  if (o?.visible === false) return undefined;
  const def = getDef('DestinyObjectiveDefinition', o.objectiveHash);
  const text = def?.progressDescription || def?.displayProperties?.name || `#${o.objectiveHash}`;
  return `${o.progress ?? 0}/${o.completionValue ?? 0} ${substituteVars(text, vars)}`.trim();
}

export type Artifact = { name: string; powerBonus: number; pointsAcquired: number; nextPointAt?: string };

export function buildArtifact(art: any): Artifact | undefined {
  if (!art?.artifactHash) return undefined;
  return {
    name: defName('DestinyInventoryItemDefinition', art.artifactHash),
    powerBonus: art.powerBonus ?? 0,
    pointsAcquired: art.pointsAcquired ?? 0,
    nextPointAt: art.pointProgression ? progressString(art.pointProgression) : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/progress.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts tests/progress.test.ts
git commit -m "feat: objective text with string variables, artifact summary"
```

---

### Task 4: Milestones

**Files:**
- Modify: `src/progress.ts`
- Test: `tests/progress.test.ts`

**Interfaces:**
- Consumes: `getDef`
- Produces:
  - `type Milestone = { name: string; complete: boolean | 'unknown'; progress?: string; ends?: string }`
  - `buildMilestones(milestones: Record<string, any>, includeComplete?: boolean): { rows: Milestone[]; hiddenComplete: number }`

- [ ] **Step 1: Write the failing test**

Append to `tests/progress.test.ts` (add `buildMilestones` to the import):

```ts
describe('buildMilestones', () => {
  const named = (name: string) => ({ displayProperties: { name } });

  it('reports "unknown" rather than false when there is nothing to derive completion from', () => {
    vi.mocked(getDef).mockReturnValue(named('Nightfall'));
    const { rows } = buildMilestones({ '1': { milestoneHash: 1, endDate: '2026-08-04T17:00:00Z' } });
    expect(rows).toEqual([{ name: 'Nightfall', complete: 'unknown', progress: undefined, ends: '2026-08-04T17:00:00Z' }]);
  });

  it('derives completion and progress from activity challenges', () => {
    vi.mocked(getDef).mockReturnValue(named('Weekly Raid'));
    const { rows } = buildMilestones({
      '1': {
        milestoneHash: 1,
        activities: [{ challenges: [{ objective: { complete: true } }, { objective: { complete: false } }] }],
      },
    });
    expect(rows[0]).toMatchObject({ complete: false, progress: '1/2' });
  });

  it('hides completed milestones by default but counts them', () => {
    vi.mocked(getDef).mockReturnValue(named('Weekly Raid'));
    const input = { '1': { milestoneHash: 1, availableQuests: [{ status: { completed: true } }] } };

    expect(buildMilestones(input)).toEqual({ rows: [], hiddenComplete: 1 });
    expect(buildMilestones(input, true).rows[0]).toMatchObject({ complete: true, progress: '1/1' });
  });

  it('skips nameless milestones', () => {
    vi.mocked(getDef).mockReturnValue({ displayProperties: {} });
    expect(buildMilestones({ '1': { milestoneHash: 1 } }).rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/progress.test.ts -t "buildMilestones"`
Expected: FAIL — `buildMilestones is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/progress.ts`:

```ts
export type Milestone = { name: string; complete: boolean | 'unknown'; progress?: string; ends?: string };

/**
 * Bungie is inconsistent about which milestones carry quests versus challenges, and about
 * whether completed ones are pruned from the response at all. So this fails open to "unknown"
 * instead of guessing — same call as get_session_state, where a confident wrong answer costs a
 * wasted turn and an honest one costs a sentence.
 */
function milestoneStatus(m: any): { complete: boolean | 'unknown'; progress?: string } {
  const quests: any[] = m.availableQuests ?? [];
  if (quests.length) {
    const done = quests.filter((q) => q.status?.completed === true).length;
    return { complete: done === quests.length, progress: `${done}/${quests.length}` };
  }
  const challenges: any[] = (m.activities ?? []).flatMap((a: any) => a.challenges ?? []);
  if (challenges.length) {
    const done = challenges.filter((c) => c.objective?.complete === true).length;
    return { complete: done === challenges.length, progress: `${done}/${challenges.length}` };
  }
  return { complete: 'unknown' };
}

export function buildMilestones(
  milestones: Record<string, any>,
  includeComplete = false,
): { rows: Milestone[]; hiddenComplete: number } {
  const rows: Milestone[] = [];
  let hiddenComplete = 0;
  for (const m of Object.values<any>(milestones ?? {})) {
    // Nameless milestones are internal plumbing — the same filter get_milestones already uses.
    const name: string | undefined = getDef('DestinyMilestoneDefinition', m.milestoneHash)?.displayProperties?.name;
    if (!name) continue;
    const { complete, progress } = milestoneStatus(m);
    if (complete === true && !includeComplete) { hiddenComplete++; continue; }
    rows.push({ name, complete, progress, ends: m.endDate });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, hiddenComplete };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/progress.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts tests/progress.test.ts
git commit -m "feat: milestone completion with honest unknown fallback"
```

---

### Task 5: Bounties

**Files:**
- Modify: `src/progress.ts`
- Test: `tests/progress.test.ts`

**Interfaces:**
- Consumes: `getDef`, `objectiveLine` from Task 3
- Produces:
  - `type Bounty = { name: string; kind: string; pct: number; objectives: string[]; expires?: string }`
  - `buildBounties(items: any[], instanced: Record<string, { objectives?: any[] }>, uninstanced: Record<string, { objectives?: any[] }>, vars: Record<string, number>, opts?: { includeComplete?: boolean; limit?: number }): { rows: Bounty[]; hiddenComplete: number }`

- [ ] **Step 1: Write the failing test**

Append to `tests/progress.test.ts` (add `buildBounties` to the import):

```ts
describe('buildBounties', () => {
  const bountyDef = (name: string) => ({ displayProperties: { name }, itemType: 26 });

  beforeEach(() => {
    vi.mocked(getDef).mockImplementation((table: string) =>
      table === 'DestinyObjectiveDefinition' ? { progressDescription: 'Do the thing' } : undefined);
  });

  it('sorts nearest-to-complete first', () => {
    vi.mocked(getDef).mockImplementation((table: string, hash: number) => {
      if (table === 'DestinyObjectiveDefinition') return { progressDescription: 'Do the thing' };
      return bountyDef(hash === 1 ? 'Slow' : 'Fast');
    });

    const { rows } = buildBounties(
      [{ itemHash: 1, itemInstanceId: 'A' }, { itemHash: 2, itemInstanceId: 'B' }],
      {
        A: { objectives: [{ objectiveHash: 9, progress: 1, completionValue: 10 }] },
        B: { objectives: [{ objectiveHash: 9, progress: 9, completionValue: 10 }] },
      },
      {}, {},
    );

    expect(rows.map((r) => [r.name, r.pct])).toEqual([['Fast', 90], ['Slow', 10]]);
    expect(rows[0].objectives).toEqual(['9/10 Do the thing']);
  });

  it('reads uninstanced bounty progress by itemHash', () => {
    vi.mocked(getDef).mockImplementation((table: string) =>
      table === 'DestinyObjectiveDefinition' ? { progressDescription: 'Do the thing' } : bountyDef('Uninstanced'));

    const { rows } = buildBounties(
      [{ itemHash: 55 }],
      {},
      { '55': { objectives: [{ objectiveHash: 9, progress: 5, completionValue: 10 }] } },
      {},
    );

    expect(rows[0]).toMatchObject({ name: 'Uninstanced', pct: 50 });
  });

  it('hides completed bounties by default but counts them', () => {
    vi.mocked(getDef).mockImplementation((table: string) =>
      table === 'DestinyObjectiveDefinition' ? { progressDescription: 'Do the thing' } : bountyDef('Done'));

    const run = (opts?: { includeComplete?: boolean }) => buildBounties(
      [{ itemHash: 1, itemInstanceId: 'A' }],
      { A: { objectives: [{ objectiveHash: 9, progress: 10, completionValue: 10, complete: true }] } },
      {}, {}, opts,
    );

    expect(run()).toMatchObject({ rows: [], hiddenComplete: 1 });
    expect(run({ includeComplete: true }).rows).toHaveLength(1);
  });

  it('gives an objectiveless item pct 0 instead of dividing by zero, and ignores non-bounties', () => {
    vi.mocked(getDef).mockImplementation((_t: string, hash: number) =>
      hash === 1 ? bountyDef('Empty') : { displayProperties: { name: 'Gun' }, itemType: 3 });

    const { rows } = buildBounties([{ itemHash: 1 }, { itemHash: 2 }], {}, {}, {});
    expect(rows).toEqual([{ name: 'Empty', kind: 'Bounty', pct: 0, objectives: [], expires: undefined }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/progress.test.ts -t "buildBounties"`
Expected: FAIL — `buildBounties is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/progress.ts`:

```ts
export type Bounty = { name: string; kind: string; pct: number; objectives: string[]; expires?: string };

// DestinyItemType: 26 Bounty, 12 QuestStep. Everything else in the inventory is not a to-do.
const BOUNTY_KINDS: Record<number, string> = { 26: 'Bounty', 12: 'QuestStep' };

export function buildBounties(
  items: any[],
  instanced: Record<string, { objectives?: any[] }>,
  uninstanced: Record<string, { objectives?: any[] }>,
  vars: Record<string, number>,
  { includeComplete = false, limit = 25 }: { includeComplete?: boolean; limit?: number } = {},
): { rows: Bounty[]; hiddenComplete: number } {
  const rows: Bounty[] = [];
  let hiddenComplete = 0;

  for (const it of items ?? []) {
    const def = getDef('DestinyInventoryItemDefinition', it.itemHash);
    const kind = BOUNTY_KINDS[def?.itemType];
    if (!kind) continue;

    // Instanced bounties carry objectives under their instance id; uninstanced ones are keyed
    // by item hash on the character progression component. Both are real, so read both.
    const objs: any[] = (it.itemInstanceId
      ? instanced?.[it.itemInstanceId]?.objectives
      : uninstanced?.[it.itemHash]?.objectives) ?? [];
    const visible = objs.filter((o) => o.visible !== false);

    const complete = visible.length > 0 && visible.every((o) => o.complete === true);
    if (complete && !includeComplete) { hiddenComplete++; continue; }

    // Mean fraction across objectives. `|| 1` guards a zero completionValue; an item with no
    // visible objectives gets 0 and sorts last rather than producing NaN.
    const pct = visible.length
      ? Math.round(100 * visible.reduce(
          (s, o) => s + Math.min(1, (o.progress ?? 0) / (o.completionValue || 1)), 0) / visible.length)
      : 0;

    rows.push({
      name: def?.displayProperties?.name ?? `#${it.itemHash}`,
      kind,
      pct,
      objectives: visible.map((o) => objectiveLine(o, vars)).filter((s): s is string => !!s),
      expires: it.expirationDate,
    });
  }

  // Nearest-to-complete first — an unsorted list is just the inventory again.
  rows.sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  return { rows: rows.slice(0, limit), hiddenComplete };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/progress.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts tests/progress.test.ts
git commit -m "feat: bounty rows sorted nearest-to-complete"
```

---

### Task 6: Tool registration and wiring

**Files:**
- Create: `src/tools/progress.ts`
- Create: `tests/progress-tool.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `buildArtifact`, `buildBounties`, `buildMilestones`, `buildRanks`, `resolveSeasonPass` from Tasks 1-5; `bungieFetch`, `getAccount` from `src/bungie.js`; `defName` from `src/manifest.js`; `tool` from `src/tools/util.js`
- Produces: `registerProgressTools(server: McpServer): void`

- [ ] **Step 1: Write the failing test**

Create `tests/progress-tool.test.ts`:

```ts
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

  it('notes a missing progressions component instead of failing', async () => {
    vi.mocked(bungieFetch).mockResolvedValue({ ...profile, characterProgressions: undefined } as any);
    const out = parse(await capture().get_progress({ ...args }));
    expect(out.notes[0]).toContain('characterProgressions');
    expect(out.ranks).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/progress-tool.test.ts`
Expected: FAIL — cannot resolve module `../src/tools/progress.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/progress.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName } from '../manifest.js';
import { buildArtifact, buildBounties, buildMilestones, buildRanks, resolveSeasonPass } from '../progress.js';
import { tool } from './util.js';

// The fetch is fat and the response is thin: Bungie returns every character regardless, and we
// project down to one. Server-side bytes are free, model context is not.
const COMPONENTS = '100,104,200,201,202,301,1200';

const SECTIONS = ['ranks', 'seasonpass', 'artifact', 'milestones', 'bounties'] as const;

export function registerProgressTools(server: McpServer): void {
  server.registerTool('get_progress', {
    description: `What to do today and where you stand: ranks and reset counts, season pass tier, seasonal artifact, this character's weekly milestones, and every bounty/quest step sorted nearest-to-complete.

Use this, not get_milestones — that one reads the PUBLIC weekly reset list and cannot say whether YOU have cleared anything.

Compact by default: only the six ranks worth reading, completed rows hidden but counted under "hidden". Widen with all_ranks, include_complete, all_characters, or narrow with sections.`,
    inputSchema: z.object({
      sections: z.array(z.enum(SECTIONS)).optional()
        .describe('Subset to return. Omit for all of them.'),
      character_id: z.string().optional()
        .describe('From get_profile. Defaults to the most-recently-played character.'),
      all_characters: z.boolean().default(false),
      all_ranks: z.boolean().default(false)
        .describe('Every named progression instead of the six real ranks'),
      include_complete: z.boolean().default(false)
        .describe('Inline finished bounties and milestones instead of only counting them'),
      limit: z.number().int().min(1).transform((n) => Math.min(n, 100)).default(25)
        .describe('Bounty rows, max 100'),
    }),
  }, tool(async ({ sections, character_id, all_characters, all_ranks, include_complete, limit }) => {
    const want = (s: (typeof SECTIONS)[number]) => !sections?.length || sections.includes(s);

    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
      auth: true, query: { components: COMPONENTS },
    });

    const chars: Record<string, any> = r.characters?.data ?? {};
    const ids = Object.keys(chars);
    if (!ids.length) throw new Error('No characters on this account.');
    if (character_id && !chars[character_id]) {
      throw new Error(`Unknown character_id "${character_id}". Valid ids: ${ids.join(', ')}`);
    }

    // Bungie leaves stale activity hashes behind after logoff, so dateLastPlayed is the only
    // reliable "which character is this player actually on" signal. Same pick as get_session_state.
    const active = character_id
      ?? ids.reduce((best, id) => chars[id].dateLastPlayed > chars[best].dateLastPlayed ? id : best, ids[0]);

    const notes: string[] = [];
    if (!r.characterProgressions?.data) {
      notes.push('characterProgressions missing — account privacy settings may restrict it; ranks, season pass and milestones are unavailable.');
    }

    const one = (cid: string) => {
      const prog = r.characterProgressions?.data?.[cid];
      const vars: Record<string, number> = {
        ...(r.profileStringVariables?.data?.integerValuesByHash ?? {}),
        ...(r.characterStringVariables?.data?.[cid]?.integerValuesByHash ?? {}),
      };

      const out: Record<string, unknown> = {
        character: {
          characterId: cid,
          class: defName('DestinyClassDefinition', chars[cid].classHash),
          power: chars[cid].light,
        },
      };
      const hidden: Record<string, number> = {};
      // Empty sections are omitted entirely — an empty array still costs the model a read.
      const set = (k: string, v: unknown) => {
        if (v === undefined || (Array.isArray(v) && !v.length)) return;
        out[k] = v;
      };

      if (want('ranks') && prog?.progressions) set('ranks', buildRanks(prog.progressions, all_ranks));
      if (want('seasonpass') && prog?.progressions) {
        set('seasonPass', resolveSeasonPass(r.profile?.data?.currentSeasonHash, prog.progressions, new Date()));
      }
      if (want('artifact')) {
        set('artifact', buildArtifact(prog?.seasonalArtifact ?? r.profileProgression?.data?.seasonalArtifact));
      }
      if (want('milestones') && prog?.milestones) {
        const m = buildMilestones(prog.milestones, include_complete);
        set('milestones', m.rows);
        if (m.hiddenComplete) hidden.milestonesComplete = m.hiddenComplete;
      }
      if (want('bounties')) {
        const b = buildBounties(
          r.characterInventories?.data?.[cid]?.items ?? [],
          r.itemComponents?.objectives?.data ?? {},
          prog?.uninstancedItemObjectives ?? {},
          vars,
          { includeComplete: include_complete, limit },
        );
        set('bounties', b.rows);
        if (b.hiddenComplete) hidden.bountiesComplete = b.hiddenComplete;
      }
      if (Object.keys(hidden).length) out.hidden = hidden;
      return out;
    };

    const body = all_characters ? { characters: ids.map(one) } : one(active);
    return notes.length ? { ...body, notes } : body;
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/progress-tool.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the server**

In `src/index.ts`, add the import next to the other tool imports:

```ts
import { registerProgressTools } from './tools/progress.js';
```

Register it in `buildServer()` and bump the version — some clients cache the tool list keyed on it:

```ts
  const server = new McpServer({ name: 'destiny2', version: '1.8.0' }, { instructions: INSTRUCTIONS });
  registerReadTools(server);
  registerWriteTools(server);
  registerRawTool(server);
  registerProgressTools(server);
```

In the `INSTRUCTIONS` template literal, insert this paragraph immediately before the line
`Pick the right tool:`:

```
For "what should I do today", "what are my ranks" or "did I do my weekly", use get_progress.
get_milestones only knows the PUBLIC weekly reset list — it cannot tell you what THIS account
has already cleared.

```

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — every pre-existing test plus the 24 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/tools/progress.ts src/index.ts tests/progress-tool.test.ts
git commit -m "feat: get_progress — ranks, season pass, artifact, milestones, bounties"
```

- [ ] **Step 8: Verify against the live account**

The service runs as a systemd user unit, so restart rather than `npm start`:

```bash
systemctl --user restart destiny2-mcp
systemctl --user status destiny2-mcp --no-pager
```

Then call `get_progress` from a client and confirm against the game: the rank labels match the
in-game ranks, the season pass tier matches, and at least one bounty shows real x/y progress.
Manifest-derived data cannot be validated by unit tests alone — the mocks assert shape, the
game asserts truth.

---

## Notes for the implementer

- `src/progress.ts` never imports from `src/tools/` or `src/bungie.js`. If a task tempts you to, the projection is being done in the wrong layer.
- Tests mock `../src/manifest.js` wholesale. If a task needs another manifest export, add it to the mock factory in that test file — `vi.mock` factories cannot reference outer variables.
- `vi.mocked(getDef).mockImplementation` receives `(table, hash)`. Several tests key off `table`; keep returning `undefined` for tables a test does not care about, so a missing definition is exercised too.
