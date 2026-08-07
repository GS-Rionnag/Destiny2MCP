import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { defName, getDef } from '../manifest.js';
import { browseLoadouts, getLightggItem, getLoadout, newItemCategories, newItems, type PerkPopularity, type TraitCombo } from '../lightgg.js';
import { tool } from './util.js';

// Loadout filter FilterNums (the ?f=code(value) grammar the /loadouts/load/ endpoint uses).
const LD_MODE = 1, LD_CLASS = 2, LD_SUBCLASS = 3, LD_SEASON = 11, LD_ACTIVITY = 12, LD_SCORE = 19;
// Activity-mode keys light.gg exposes on the loadouts filter.
const MODE = { 'any-pvp': 5, 'any-pve': 7, strikes: 3, competitive: 69, trials: 84, 'solo-lost-sectors': 87 } as const;
const LD_CLASSES = { titan: 0, hunter: 1, warlock: 2 } as const;

const perkName = (h: number) => defName('DestinyInventoryItemDefinition', h);
const TIERS: Record<number, string> = { 5: 'Legendary', 6: 'Exotic' };

const perk = (p: PerkPopularity) => ({
  perk: perkName(p.perkHash),
  hash: p.perkHash,
  pct: p.pct,
  count: p.count,
});

const combo = (c: TraitCombo) => ({
  perks: [perkName(c.perks[0]), perkName(c.perks[1])],
  hashes: c.perks,
  count: c.count,
  pct: c.pct, // relative to the most-run combo (100 = the single most popular pairing)
});

// light.gg lists a separate row for every normal/enhanced permutation of the same two
// perks, all carrying the same count — so one logical combo shows up to 4x. Fold them
// to their display names (enhanced and base share a name) so each pairing appears once.
function dedupeCombos(combos: TraitCombo[], limit: number) {
  const seen = new Set<string>();
  const out: ReturnType<typeof combo>[] = [];
  for (const c of combos) {
    const named = combo(c);
    const key = named.perks.join(' + ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(named);
    if (out.length >= limit) break;
  }
  return out;
}

export function registerLightggTools(server: McpServer): void {
  server.registerTool('lightgg_rolls', {
    description:
      'REAL community usage from light.gg for one item — how many players actually roll each perk, not editorial or wish-list opinion. This is the tool for min-maxing and for finding weird off-meta combos: takes a weapon name ("Fatebringer") or a hash from lightgg_search. Returns, for a weapon: perkColumns (every random-perk socket, perks ordered by how often players run them, each with its share % of that column) and traitCombos (the two trait columns paired and ranked by pick count — the top is the community god roll, the long tail at the bottom is the rare combo only dedicated players run, pct is relative to the most popular pairing). For armor: armorArchetypes ranked by community popularity. rollPool lists every perk each column CAN roll. Distinct from inspect_item, which reads the curated DIM wish list — use this one for what people ACTUALLY equip. combos caps the trait-combo list (default 40; raise to mine the long tail).',
    inputSchema: z.object({
      item: z.string().describe('Weapon/armor name or light.gg hash.'),
      combos: z.number().int().min(1).max(256).optional().describe('How many trait combinations to return, most-run first (default 40).'),
    }),
  }, tool(async (a: { item: string; combos?: number }) => {
    const it = await getLightggItem(a.item);
    const limit = a.combos ?? 40;
    return {
      name: it.name,
      hash: it.hash,
      type: it.type,
      tier: TIERS[it.tier] ?? it.tier,
      craftable: it.craftable || undefined,
      url: `https://www.light.gg/db/items/${it.hash}/`,
      perkColumns: it.perkColumns.map((c) => c.map(perk)),
      traitCombos: dedupeCombos(it.traitCombos, limit),
      uniqueTraitCombos: dedupeCombos(it.traitCombos, Infinity).length, // raise `combos` up to here to mine the tail
      rollPool: it.rollPool.length ? it.rollPool.map((c) => c.map(perkName)) : undefined,
      armorArchetypes: it.armorArchetypes.length
        ? it.armorArchetypes.map((x) => ({ archetype: perkName(x.archetypeHash), hash: x.archetypeHash, rank: x.rank }))
        : undefined,
    };
  }));

  server.registerTool('new_items', {
    description:
      "List the newest items added to Destiny 2, from light.gg's \"New Items\" collections — the per-release/season pages (e.g. the current expansion's new weapons, new exotics, raid gear, craftable weapons, trials gear). Call with NO category to get the list of available collections for the current releases (their slugs rotate every season, so always check here rather than guessing). Then call again with a category path (e.g. \"renegades/new-weapons\" or just \"renegades\" for all of that release) to get those items resolved to name + hash + type. Feed any weapon into lightgg_rolls for its community god roll, or inspect_item for its perk pool.",
    inputSchema: z.object({
      category: z.string().optional().describe('A collection path from the no-arg listing, e.g. "renegades/new-exotics". Omit to list available collections.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max items to resolve to names (default 100).'),
    }),
  }, tool(async (a: { category?: string; limit?: number }) => {
    const categories = await newItemCategories();
    if (!a.category) {
      return { categories, hint: 'Call new_items again with one of these paths as `category`.' };
    }
    const hashes = await newItems(a.category);
    const limit = a.limit ?? 100;
    // Reissues share a name across several hashes — collapse them like search_items does.
    const seen = new Map<string, { name: string; hash: number; type?: string; tier?: string; versions?: number }>();
    for (const h of hashes) {
      const d = getDef('DestinyInventoryItemDefinition', h);
      const name = d?.displayProperties?.name ?? `#${h}`;
      const type = d?.itemTypeDisplayName || undefined;
      const key = `${name}|${type}`;
      const known = seen.get(key);
      if (known) { known.versions = (known.versions ?? 1) + 1; continue; }
      if (seen.size >= limit) continue;
      seen.set(key, { name, hash: h, type, tier: d?.inventory?.tierTypeName || undefined });
    }
    const items = [...seen.values()];
    return { category: a.category, totalHashes: hashes.length, uniqueShown: items.length, truncated: hashes.length > items.length || undefined, items, categories };
  }));

  server.registerTool('search_lightgg_builds', {
    description:
      "BUILDS from light.gg — the second of the two build sources here, and the one to use for \"what are people actually running\", \"best builds on light.gg\", or any build question that names light.gg. Where search_builds returns builds someone wrote up and recommended (Mobalytics), these are real loadouts auto-captured from players' actual runs — each one a snapshot of a real Post Game Carnage Report, so it is evidence of what got used and how it performed, not advice. Consider both sources for \"what should I run\"; prefer this one when the ask is about real usage, a specific activity, or light.gg by name. Filter by class, subclass, activity mode, a specific weapon or exotic armor piece, season, and a MINIMUM performance score. Returns cards: title, activity, subclass, the run's score, upvotes, author and the build id — pass that id to get_lightgg_build for the full gear. IMPORTANT on \"popular / best / skilled\": light.gg does NOT let you sort these — results are always newest-first and most have 0 votes, so there is no \"top\" to ask for. To surface skilled play, FILTER for it: pick a hard activity (mode:\"trials\"/\"competitive\", or an endgame activity by hash via activity) AND set a high minScore. That is the only lever. Mirrors light.gg's own loadout filters exactly.",
    inputSchema: z.object({
      class: z.enum(['titan', 'hunter', 'warlock']).optional(),
      subclass: z.number().int().optional().describe('Subclass definition hash (e.g. 4282591831 = Prismatic Hunter). Resolve with get_definition/search_items.'),
      mode: z.enum(Object.keys(MODE) as [keyof typeof MODE]).optional().describe('Activity mode: any-pvp | any-pve | strikes | competitive | trials | solo-lost-sectors.'),
      activity: z.number().int().optional().describe('Specific activity definition hash, for one activity rather than a whole mode.'),
      weapon: z.number().int().optional().describe('Only loadouts using this weapon (item hash). Filter code 5.'),
      exoticArmor: z.number().int().optional().describe('Only loadouts using this exotic armor piece (item hash). Filter code 7.'),
      season: z.number().int().min(1).max(29).optional(),
      minScore: z.number().int().optional().describe('Minimum run score — the main lever for "skilled" play. Combine with a hard activity.'),
      maxScore: z.number().int().optional(),
      page: z.number().int().min(1).optional().describe('Page of 20, newest-first (default 1).'),
    }),
  }, tool(async (a: any) => {
    const parts: string[] = [];
    const f = (code: number, val: string | number) => parts.push(`${code}(${val})`);
    if (a.class) f(LD_CLASS, LD_CLASSES[a.class as keyof typeof LD_CLASSES]);
    if (a.subclass) f(LD_SUBCLASS, a.subclass);
    if (a.mode) f(LD_MODE, MODE[a.mode as keyof typeof MODE]);
    if (a.activity) f(LD_ACTIVITY, a.activity);
    if (a.weapon) f(5, a.weapon);
    if (a.exoticArmor) f(7, a.exoticArmor);
    if (a.season) f(LD_SEASON, a.season);
    // Score is a range filter: min;max. light.gg needs both bounds, so default the open end.
    if (a.minScore !== undefined || a.maxScore !== undefined) f(LD_SCORE, `${a.minScore ?? 0};${a.maxScore ?? 100000000}`);

    const res = await browseLoadouts(parts.join(','), a.page ?? 1);
    return {
      total: res.total,
      page: res.page,
      pageSize: res.cards.length,
      note: 'Ordered newest-first (light.gg has no popularity sort). Filter by activity + minScore for skilled play.',
      loadouts: res.cards,
    };
  }));

  server.registerTool('get_lightgg_build', {
    description:
      "Full gear for one light.gg build, by the id from search_lightgg_builds. Returns class, subclass, equipped weapons and armor (resolved to names) with any perk/aspect/fragment overrides, the mods, stat targets, the author's notes, and a dim.gg-importable export URL. Because these are captured from a real run, equipped gear is exact item hashes; some perk detail may be sparse. For the community god roll of any weapon in it, follow up with lightgg_rolls. Not to be confused with get_loadouts, which reads the player's own in-game loadout slots.",
    inputSchema: z.object({ id: z.number().int().describe('Build id from search_lightgg_builds.') }),
  }, tool(async (a: { id: number }) => {
    const d = await getLoadout(a.id);
    const gear = (list?: { hash: number; socketOverrides?: Record<string, number> }[]) =>
      (list ?? []).map((it) => ({
        name: perkName(it.hash),
        hash: it.hash,
        overrides: it.socketOverrides && Object.keys(it.socketOverrides).length
          ? Object.values(it.socketOverrides).map((h) => perkName(h)) : undefined,
      }));
    return {
      id: a.id,
      name: d.name,
      class: ['Titan', 'Hunter', 'Warlock'][d.classType] ?? d.classType,
      notes: d.notes || undefined,
      equipped: gear(d.equipped),
      unequipped: d.unequipped?.length ? gear(d.unequipped as any) : undefined,
      mods: d.parameters?.mods?.map((h) => perkName(h)),
      statTargets: d.parameters?.statConstraints?.map((s) => ({ stat: defName('DestinyStatDefinition', s.statHash), minTier: s.minTier, maxTier: s.maxTier })),
      exportUrl: `https://www.light.gg/loadouts/${a.id}/export`,
    };
  }));
}
