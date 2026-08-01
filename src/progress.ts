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
