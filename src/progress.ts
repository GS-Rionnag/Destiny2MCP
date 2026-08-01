import { defName, getDef } from './manifest.js';

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
