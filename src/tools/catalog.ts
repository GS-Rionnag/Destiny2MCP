import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { catalogItems, itemDetail, itemHashesByName, type SocketColumn } from '../catalog.js';
import { defName } from '../manifest.js';
import { SEARCH_HELP, compileQuery, sortItems, statValue, type SearchItem } from '../search/index.js';
import { rollsFor, wishlistMeta, wishlistReady } from '../wishlist.js';
import { tool } from './util.js';

const CLASS_NAMES = ['Titan', 'Hunter', 'Warlock'];

function row(i: SearchItem, statsUsed: string[], usedPerks: boolean) {
  const stats = Object.fromEntries(statsUsed.map((s) => [s, statValue(i, s)]).filter(([, v]) => v !== undefined));
  return {
    hash: i.itemHash,
    name: i.name,
    type: i.type,
    tier: i.tier,
    slot: i.bucketHash ? defName('DestinyInventoryBucketDefinition', i.bucketHash) : undefined,
    class: CLASS_NAMES[i.classType],
    ammo: ['', 'Primary', 'Special', 'Heavy'][i.ammoType] || undefined,
    stats: Object.keys(stats).length ? stats : undefined,
    // On a catalog item these are the pool, not a roll: "can roll", not "has".
    canRoll: usedPerks && i.plugOptions ? [...new Set(Object.values(i.plugOptions).flat())].length : undefined,
    godroll: i.godroll ?? undefined,
  };
}

/** Columns that roll: barrels, magazines, traits, origin. A wish-listed roll names perks from these. */
const rollingColumns = (columns: SocketColumn[]) => columns.filter((c) => c.random);

/**
 * The trait columns — `frames` is Bungie's identifier for the two perk columns people argue
 * about. Everything else in a wish-listed roll is a barrel or a magazine, so combining on all
 * four columns would split one god roll into a dozen near-identical rows.
 */
const traitColumns = (columns: SocketColumn[]) => {
  const traits = rollingColumns(columns).filter((c) => c.plugCategory === 'frames');
  return traits.length ? traits : rollingColumns(columns);
};

function godRollSummary(hash: number, columns: SocketColumn[], text: string | undefined, limit: number) {
  if (!wishlistReady()) {
    return { unavailable: 'The DIM wish list index is not built yet — call refresh_wishlist.' };
  }
  const rolls = rollsFor(hash, text);
  if (!rolls.length) {
    return { rollCount: 0, note: text ? `No wish-listed rolls mention "${text}".` : 'No community wish-list rolls for this item.' };
  }

  const rolling = rollingColumns(columns);
  const traits = new Set(traitColumns(columns).map((c) => c.index));
  const columnOf = new Map<string, number>();
  for (const c of rolling) for (const o of c.options) if (!columnOf.has(o.name.toLowerCase())) columnOf.set(o.name.toLowerCase(), c.index);

  // How often each perk is wished for, per column: the consensus signal for "what to chase".
  const perColumn = new Map<number, Map<string, number>>();
  const combos = new Map<string, { perks: string[]; rolls: number; tags: Set<string> }>();
  const notes = new Map<string, { title: string; tags: string; text: string; rolls: number }>();

  for (const r of rolls) {
    const wanted = r.perks.filter((p) => columnOf.has(p.toLowerCase()));
    for (const p of wanted) {
      const col = columnOf.get(p.toLowerCase())!;
      if (!perColumn.has(col)) perColumn.set(col, new Map());
      const m = perColumn.get(col)!;
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    // Rolls differ mostly in barrel/magazine; the trait pair is what people mean by "the god roll".
    const traitPerks = wanted.filter((p) => traits.has(columnOf.get(p.toLowerCase())!)).sort();
    if (traitPerks.length) {
      const key = traitPerks.join(' + ');
      const c = combos.get(key) ?? { perks: traitPerks, rolls: 0, tags: new Set<string>() };
      c.rolls++;
      for (const t of (r.note?.tags ?? '').split(/\s+/).filter(Boolean)) c.tags.add(t);
      combos.set(key, c);
    }
    const n = r.note;
    if (n?.text || n?.title) {
      const key = `${n.title}\n${n.text}`;
      const e = notes.get(key) ?? { title: n.title, tags: n.tags, text: n.text, rolls: 0 };
      e.rolls++;
      notes.set(key, e);
    }
  }

  const byCount = <T extends { rolls: number }>(a: T, b: T) => b.rolls - a.rolls;
  return {
    rollCount: rolls.length,
    filteredBy: text,
    // Every roll in the list counts once, so a perk in 60 of 108 rolls is a 60-way vote for it.
    mostWantedPerks: rolling.map((c) => ({
      column: c.index,
      slot: c.plugCategory,
      perks: [...(perColumn.get(c.index) ?? new Map())].map(([name, rolls]) => ({ name, rolls }))
        .sort(byCount).slice(0, 8),
    })).filter((c) => c.perks.length),
    topRolls: [...combos.values()].sort(byCount).slice(0, limit)
      .map((c) => ({ perks: c.perks, rolls: c.rolls, tags: [...c.tags].slice(0, 8) })),
    notes: [...notes.values()].sort(byCount).slice(0, 6)
      .map((n) => ({ source: n.title, tags: n.tags || undefined, rolls: n.rolls, text: n.text.slice(0, 600) })),
    source: wishlistMeta().source,
  };
}

export function registerCatalogTools(server: McpServer): void {
  server.registerTool('search_items', {
    description:
      'Search EVERY item in the game (the whole Destiny manifest), not just the account\'s inventory — for designing builds around gear the player may not own. Same DIM query syntax as search_inventory: "is:handcannon is:legendary is:void", "is:exotic is:hunter is:helmet", "stat:range:>=70 is:pulserifle" with sort "stat:range". perk: and is:godroll here mean CAN ROLL it, since a catalog item has no fixed roll: "is:handcannon perk:\'explosive payload\'" finds every hand cannon whose pool contains it, and "is:sniperrifle is:godroll" every sniper with a community wish-listed roll. Stats are the definition\'s BASE values (no perks, no masterwork) — good for comparing frames, not finished rolls. Reissues of one weapon collapse into a single row carrying versions:N. Instance-only filters (power:, is:masterwork, is:locked, is:dupe) match nothing here — use search_inventory for those. Follow up with inspect_item on anything interesting.',
    inputSchema: z.object({
      query: z.string().describe(`DIM search query.\n${SEARCH_HELP}`),
      sort: z.string().optional().describe('stat:<name> (e.g. stat:impact), or name.'),
      limit: z.number().int().min(1).transform((n) => Math.min(n, 100)).default(25),
    }),
  }, tool(async ({ query, sort, limit }) => {
    const q = compileQuery(query);
    // Resolving every socket pool costs seconds, so only perk-aware queries pay for it.
    const items = catalogItems(q.usedPerks || q.usedGodroll);
    const hits = items.filter(q.predicate);
    const ordered = sort ? sortItems(hits, sort) : hits;
    // The manifest carries one definition per version of a weapon — four Aisha's Care rows are
    // four reissues, not four weapons. Collapse them and say how many hashes were behind the row.
    const seen = new Map<string, ReturnType<typeof row>>();
    for (const i of ordered) {
      const key = `${i.name}|${i.type}|${i.tier}`;
      const known = seen.get(key) as any;
      if (known) { known.versions = (known.versions ?? 1) + 1; continue; }
      if (seen.size >= limit) continue;
      seen.set(key, row(i, q.statsUsed, q.usedPerks || q.usedGodroll));
    }
    return {
      total: hits.length,
      showing: seen.size,
      items: [...seen.values()],
    };
  }));

  server.registerTool('inspect_item', {
    description:
      'Everything the game knows about one item, owned or not — the tool for "what is the god roll for X" and for min-maxing a weapon or armor piece. Takes a name ("Fatebringer") or a hash from search_items. Returns base stats; columns = every perk each socket can roll with its description (plugCategory "frames" marks the two trait columns people argue about); and godRolls from the community DIM wish list, aggregated over every roll written for that item: topRolls (trait combinations ranked by how many wish-listed rolls want them, barrel/magazine variants folded together), mostWantedPerks (per-column vote counts, so a perk in 54 of 108 rolls is a 54-way vote), and notes (the reviewers\' own write-ups). godrolls:"pvp" or "pve-boss" keeps only rolls whose notes, tags or source say so. Set include_perk_pool false when only the rolls matter.',
    inputSchema: z.object({
      name: z.string().optional().describe('Item name, e.g. "The Palindrome". Exact match wins; partial names resolve to the closest item.'),
      hash: z.number().int().optional().describe('Item hash, from search_items or search_manifest.'),
      godrolls: z.string().optional().describe('Keep only wish-list rolls whose note, tags or source mention this, e.g. "pvp" or "pve-boss".'),
      roll_limit: z.number().int().min(1).transform((n) => Math.min(n, 30)).default(10).describe('How many perk combinations to return.'),
      include_perk_pool: z.boolean().default(true).describe('Set false for stats and god rolls only — the perk pool is the bulk of the response.'),
    }),
  }, tool(async ({ name, hash, godrolls, roll_limit, include_perk_pool }) => {
    if (!name && hash === undefined) throw new Error('Pass name or hash.');
    const hashes = hash !== undefined ? [hash] : itemHashesByName(name!);
    if (!hashes.length) throw new Error(`No item in the manifest matches "${name}".`);
    // Reissues share a name across several hashes and the wish list usually targets one of them,
    // so prefer the version the community actually wrote rolls for.
    const chosen = (hash === undefined && wishlistReady() ? hashes.find((h) => rollsFor(h).length) : undefined) ?? hashes[0];
    const detail = itemDetail(chosen);
    if (!detail) throw new Error(`No item definition for hash ${chosen}.`);

    return {
      ...detail,
      columns: include_perk_pool ? detail.columns : undefined,
      columnCount: include_perk_pool ? undefined : detail.columns.length,
      godRolls: godRollSummary(detail.hash, detail.columns, godrolls, roll_limit),
      // A partial name can land on the wrong Palindrome; show what else it could have been.
      alsoMatched: hashes.length > 1
        ? hashes.filter((h) => h !== chosen).map((h) => ({ hash: h, name: defName('DestinyInventoryItemDefinition', h) }))
        : undefined,
    };
  }));
}
