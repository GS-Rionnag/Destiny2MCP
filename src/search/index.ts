import { defName, eachDef, getDef } from '../manifest.js';
import { matchItem, wishlistReady, type GodrollMatch } from '../wishlist.js';
import { parseQuery, type QueryAST } from './query-parser.js';

/** One inventory item, with everything a filter needs already resolved. */
export interface SearchItem {
  name: string;
  itemHash: number;
  itemInstanceId?: string;
  type?: string;
  tier: string;
  power?: number;
  quantity: number;
  location: string;
  characterId?: string;
  equipped: boolean;
  bucketHash: number;
  categories: number[];
  classType: number;
  damageType: number;
  ammoType: number;
  maxStackSize: number;
  equipment: boolean;
  transferable: boolean;
  locked: boolean;
  tracked: boolean;
  masterwork: boolean;
  crafted: boolean;
  description: string;
  energy?: { used: number; capacity: number };
  /** Lowercased stat name -> value, from component 304. */
  stats: Record<string, number>;
  /** Lowercased socket plug names, from component 305. */
  plugs: string[];
  /** Socket index -> lowercased selectable plug names, from component 310. God-roll queries only. */
  plugOptions?: Record<number, string[]>;
  /** Set by a god-roll filter so the tool can echo the match back. */
  godroll?: GodrollMatch | null;
  /** How many copies of this item hash the account holds. */
  dupeCount: number;
}

const POSTMASTER_BUCKET = 215593132;
// Armor stat hashes. Bungie renames these between expansions (Mobility -> Weapons in Armor 3.0)
// but the hashes are stable, so `stat:total` keeps working across renames.
const ARMOR_STATS = [2996146975, 392767087, 1943323491, 1735777505, 144602215, 4244567218];
// Armor 3.0 renamed the six armor stats. DIM keeps the Armor 2.0 names as aliases so old
// searches (and anyone who learned the game before the rename) still work — so do we.
const OLD_STAT_NAMES: Record<string, number> = {
  mobility: 2996146975, resilience: 392767087, recovery: 1943323491,
  discipline: 1735777505, intellect: 144602215, strength: 4244567218,
};

// Attack, Defense, Power — DIM's `lightStats` (app/search/search-filter-values.ts). Bungie puts a
// primaryStat on plenty of things that have no power: a sparrow's is Speed, a ghost's is Power
// Bonus, and a subclass gets a random armor stat that can read NEGATIVE. Reporting any of those as
// "power" is wrong, so like DIM we only call it power when it is one of these three.
const LIGHT_STATS = new Set([1480404414, 3897883278, 1935470627]);

/** An item's power level, or undefined for items that do not have one. */
export const itemPower = (inst: any): number | undefined =>
  inst?.primaryStat && LIGHT_STATS.has(inst.primaryStat.statHash) ? inst.primaryStat.value : undefined;

const DAMAGE_TYPES: Record<string, number> = { kinetic: 1, arc: 2, solar: 3, void: 4, stasis: 6, strand: 7 };
const AMMO_TYPES: Record<string, number> = { primary: 1, special: 2, heavy: 3 };
const CLASS_TYPES: Record<string, number> = { titan: 0, hunter: 1, warlock: 2 };
const RARITY_ALIASES: Record<string, string> = {
  white: 'common', green: 'uncommon', blue: 'rare', purple: 'legendary', yellow: 'exotic',
};

/** Profile components search needs. Everything is filtered locally, DIM-style. */
export const SEARCH_COMPONENTS = '102,201,205,200,300,304,305';
// 310 (ItemReusablePlugs) is what makes "you own this god roll but have not selected it" answerable.
// It costs ~1MB and ~1s on a full account, so only god-roll queries pay for it.
export const SEARCH_COMPONENTS_GODROLL = SEARCH_COMPONENTS + ',310';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');

// Built once from the manifest, so `is:handcannon` / `is:helmet` stay current across expansions
// instead of living in a hardcoded table that rots.
let categoryKeywords: Map<string, number> | null = null;
let statKeywords: Map<string, number> | null = null;
let statNameByHash: Map<number, string> | null = null;

function categories(): Map<string, number> {
  if (!categoryKeywords) {
    const m = new Map<string, number>();
    for (const d of eachDef('DestinyItemCategoryDefinition')) {
      const n = norm(d.displayProperties?.name ?? '');
      if (!n || d.deprecated) continue;
      if (!m.has(n)) m.set(n, d.hash);
      // "Helmets" -> also is:helmet, matching how DIM words its keywords
      if (n.endsWith('s') && !m.has(n.slice(0, -1))) m.set(n.slice(0, -1), d.hash);
    }
    // DIM's shorthand
    for (const [alias, target] of [['lfr', 'linearfusionrifle'], ['lmg', 'machinegun'], ['smg', 'submachinegun']]) {
      const h = m.get(target);
      if (h && !m.has(alias)) m.set(alias, h);
    }
    categoryKeywords = m;
  }
  return categoryKeywords;
}

function stats(): Map<string, number> {
  if (!statKeywords) {
    const m = new Map<string, number>();
    const byHash = new Map<number, string>();
    for (const d of eachDef('DestinyStatDefinition')) {
      const n = norm(d.displayProperties?.name ?? '');
      if (!n) continue;
      if (!m.has(n)) m.set(n, d.hash);
      if (!byHash.has(d.hash)) byHash.set(d.hash, n);
    }
    for (const [alias, hash] of Object.entries(OLD_STAT_NAMES)) if (!m.has(alias)) m.set(alias, hash);
    statKeywords = m;
    statNameByHash = byHash;
  }
  return statKeywords;
}

/** hash -> current manifest stat name. Items are keyed by these, never by an alias. */
function statNames(): Map<number, string> {
  stats();
  return statNameByHash!;
}

/** Resolve a stat keyword (including Armor 2.0 aliases) to the name items are keyed by. */
function canonicalStat(name: string): string | undefined {
  const hash = stats().get(name);
  return hash === undefined ? undefined : (statNames().get(hash) ?? name);
}

/** Tests reopen the manifest with a fixture db, so the keyword tables must be droppable. */
export function resetKeywordCache(): void {
  categoryKeywords = null;
  statKeywords = null;
  statNameByHash = null;
  armorStatNames = null;
}

/** Flatten a profile response (SEARCH_COMPONENTS) into filterable items. */
export function buildItems(r: any): SearchItem[] {
  const chars = r.characters?.data ?? {};
  const instances = r.itemComponents?.instances?.data ?? {};
  const itemStats = r.itemComponents?.stats?.data ?? {};
  const sockets = r.itemComponents?.sockets?.data ?? {};
  const reusable = r.itemComponents?.reusablePlugs?.data ?? {};
  const statName = statNames();

  const defs = new Map<number, any>(); // hashes repeat heavily; each getDef is a SQLite hit + JSON.parse
  const def = (hash: number) => {
    if (!defs.has(hash)) defs.set(hash, getDef('DestinyInventoryItemDefinition', hash));
    return defs.get(hash);
  };
  const plugNames = new Map<number, string>();
  const plugName = (hash: number) => {
    if (!plugNames.has(hash)) plugNames.set(hash, (defName('DestinyInventoryItemDefinition', hash) ?? '').toLowerCase());
    return plugNames.get(hash)!;
  };

  const locName = (cid: string, equipped: boolean) =>
    `${defName('DestinyClassDefinition', chars[cid]?.classHash ?? 0)}${equipped ? ' (equipped)' : ''}`;

  const raw: { item: any; location: string; characterId?: string; equipped: boolean }[] = [
    ...(r.profileInventory?.data?.items ?? []).map((item: any) => ({ item, location: 'Vault', equipped: false })),
    ...Object.entries<any>(r.characterInventories?.data ?? {}).flatMap(([cid, inv]) =>
      (inv.items ?? []).map((item: any) => ({ item, location: locName(cid, false), characterId: cid, equipped: false }))),
    ...Object.entries<any>(r.characterEquipment?.data ?? {}).flatMap(([cid, inv]) =>
      (inv.items ?? []).map((item: any) => ({ item, location: locName(cid, true), characterId: cid, equipped: true }))),
  ];

  const out = raw.map(({ item, location, characterId, equipped }) => {
    const d = def(item.itemHash);
    const inst = item.itemInstanceId ? instances[item.itemInstanceId] : undefined;
    const state: number = item.state ?? 0;
    const s: Record<string, number> = {};
    for (const [h, v] of Object.entries<any>(itemStats[item.itemInstanceId]?.stats ?? {})) {
      const n = statName.get(Number(h));
      if (n) s[n] = v.value;
    }
    return {
      name: d?.displayProperties?.name ?? `#${item.itemHash}`,
      itemHash: item.itemHash,
      itemInstanceId: item.itemInstanceId,
      type: d?.itemTypeDisplayName,
      tier: (d?.inventory?.tierTypeName ?? '').toLowerCase(),
      power: itemPower(inst),
      quantity: item.quantity ?? 1,
      location,
      characterId,
      equipped,
      bucketHash: item.bucketHash ?? 0,
      categories: d?.itemCategoryHashes ?? [],
      classType: d?.classType ?? 3,
      damageType: inst?.damageType ?? d?.defaultDamageType ?? 0,
      ammoType: d?.equippingBlock?.ammoType ?? 0,
      maxStackSize: d?.inventory?.maxStackSize ?? 1,
      equipment: Boolean(d?.equippingBlock),
      transferable: (item.transferStatus ?? 0) === 0,
      locked: (state & 1) !== 0,
      tracked: (state & 2) !== 0,
      masterwork: (state & 4) !== 0,
      crafted: (state & 8) !== 0,
      description: (d?.displayProperties?.description ?? '').toLowerCase(),
      energy: inst?.energy ? { used: inst.energy.energyUsed, capacity: inst.energy.energyCapacity } : undefined,
      stats: s,
      plugs: (sockets[item.itemInstanceId]?.sockets ?? [])
        .filter((sk: any) => sk.plugHash && sk.isEnabled !== false)
        .map((sk: any) => plugName(sk.plugHash)),
      plugOptions: reusable[item.itemInstanceId]
        ? Object.fromEntries(Object.entries<any[]>(reusable[item.itemInstanceId].plugs ?? {})
          .map(([idx, opts]) => [Number(idx), opts.filter((o) => o.canInsert).map((o) => plugName(o.plugItemHash))]))
        : undefined,
      dupeCount: 0,
    } satisfies SearchItem;
  });

  // Uninstanced items stack rather than duplicate, so only instances count toward dupes.
  const counts = new Map<number, number>();
  for (const i of out) {
    if (i.itemInstanceId) counts.set(i.itemHash, (counts.get(i.itemHash) ?? 0) + 1);
  }
  for (const i of out) i.dupeCount = counts.get(i.itemHash) ?? 1;

  return out;
}

/* **** Filters **** */

type Pred = (i: SearchItem) => boolean;

const hasCategory = (i: SearchItem, hash: number) => i.categories.includes(hash);

/** `is:` keywords that don't come from the manifest category table. */
const IS_FILTERS: Record<string, Pred> = {
  equipped: (i) => i.equipped,
  equipment: (i) => i.equipment,
  equippable: (i) => i.equipment,
  postmaster: (i) => i.bucketHash === POSTMASTER_BUCKET,
  inpostmaster: (i) => i.bucketHash === POSTMASTER_BUCKET,
  invault: (i) => i.location === 'Vault',
  oncharacter: (i) => i.location !== 'Vault',
  incurrentchar: (i) => i.location !== 'Vault',
  locked: (i) => i.locked,
  unlocked: (i) => !i.locked,
  tracked: (i) => i.tracked,
  masterwork: (i) => i.masterwork,
  crafted: (i) => i.crafted,
  shaped: (i) => i.crafted,
  dupe: (i) => i.dupeCount > 1,
  transferable: (i) => i.transferable,
  movable: (i) => i.transferable,
  stackable: (i) => i.maxStackSize > 1,
  stackfull: (i) => i.maxStackSize > 1 && i.quantity >= i.maxStackSize,
  haslight: (i) => i.power !== undefined,
  haspower: (i) => i.power !== undefined,
  modded: (i) => i.energy !== undefined && i.energy.used > 0,
};

for (const [k, v] of Object.entries(DAMAGE_TYPES)) IS_FILTERS[k] = (i) => i.damageType === v;
for (const [k, v] of Object.entries(AMMO_TYPES)) IS_FILTERS[k] = (i) => i.ammoType === v;
for (const [k, v] of Object.entries(CLASS_TYPES)) IS_FILTERS[k] = (i) => i.classType === v;
for (const t of ['common', 'uncommon', 'rare', 'legendary', 'exotic']) IS_FILTERS[t] = (i) => i.tier === t;
for (const [alias, t] of Object.entries(RARITY_ALIASES)) IS_FILTERS[alias] = (i) => i.tier === t;

/** DIM's `<`, `<=`, `=`, `>`, `>=`, and a bare number meaning `=`. */
function compare(args: string, label: string): (v: number | undefined) => boolean {
  const m = /^(>=|<=|=|>|<)?(-?\d+(?:\.\d+)?)$/.exec(args.trim());
  if (!m) throw new Error(`${label}: expected a number with an optional comparison, e.g. ${label}>=1800 — got "${args}"`);
  const n = Number(m[2]);
  switch (m[1]) {
    case '>': return (v) => v !== undefined && v > n;
    case '>=': return (v) => v !== undefined && v >= n;
    case '<': return (v) => v !== undefined && v < n;
    case '<=': return (v) => v !== undefined && v <= n;
    default: return (v) => v === n;
  }
}

/** Which stat a `stat:` filter or a `sort` refers to, plus its comparison half. */
function splitStat(args: string): { stat: string; rest: string } {
  const idx = args.lastIndexOf(':');
  if (idx < 0) throw new Error(`stat: expected stat:<name>:<comparison>, e.g. stat:resilience:>=20 — got "${args}"`);
  return { stat: norm(args.slice(0, idx)), rest: args.slice(idx + 1) };
}

let armorStatNames: string[] | null = null;
function armorStats(): string[] {
  if (!armorStatNames) {
    armorStatNames = ARMOR_STATS.map((h) => statNames().get(h)).filter(Boolean) as string[];
  }
  return armorStatNames;
}

export function statValue(i: SearchItem, stat: string): number | undefined {
  if (stat === 'total') {
    const vals = armorStats().map((n) => i.stats[n]).filter((v) => v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
  }
  const key = canonicalStat(stat);
  return key === undefined ? undefined : i.stats[key];
}

export interface CompiledQuery {
  predicate: Pred;
  /** Stat names the query mentioned — the tool echoes only these back, to keep responses small. */
  statsUsed: string[];
  /** True if the query filtered on perks, so the tool includes matching plug names. */
  usedPerks: boolean;
  /** True if the query used a god-roll filter — the tool must then fetch component 310. */
  usedGodroll: boolean;
}

function keywordList(): string {
  const isKeywords = [...Object.keys(IS_FILTERS)].sort().join(', ');
  return [
    `is: ${isKeywords}`,
    'is: also accepts any item type from the manifest — is:handcannon, is:sniperrifle, is:helmet, is:gauntlets, is:weapon, is:armor, is:lfr, is:lmg, is:smg',
    'god rolls (DIM wish list): is:godroll / is:wishlist (matches a wish-list roll, equipped or one perk swap away), is:godrollequipped (the plugged roll matches), godroll:<text> / wishlistnotes:<text> (tag, source or note text, e.g. godroll:pve-boss)',
    'text: name:, exactname:, description:, type:, perk:, perkname:, or a bare word',
    'numbers (<, <=, =, >, >= or a bare number): power:, light:, stack:, count:, energycapacity:',
    'stats: stat:<name>:<comparison>, e.g. stat:resilience:>=20 or stat:total:>=65',
    'logic: implicit and, or, and, not, - prefix, ( ) grouping, "quoted phrases"',
  ].join('\n');
}

/** Compile a DIM-syntax query into a predicate over SearchItems. */
export function compileQuery(query: string): CompiledQuery {
  const ast = parseQuery(query);
  const statsUsed: string[] = [];
  let usedPerks = false;
  let usedGodroll = false;

  // ponytail: one indexed SQLite lookup per item, no memo across duplicate item hashes.
  // Measured cheap on a full vault; memoize on itemHash + plug signature if that ever changes.
  const godroll = (i: SearchItem, text?: string) => {
    i.godroll = matchItem(i.itemHash, i.plugs, i.plugOptions, text);
    return i.godroll;
  };
  const needIndex = () => {
    if (!wishlistReady()) {
      throw new Error('God-roll filters need the DIM wish list index, which is not built yet. It downloads in the background on startup — call refresh_wishlist to build it now.');
    }
    usedGodroll = true;
  };

  const filter = (type: string, args: string): Pred => {
    switch (type) {
      case 'is': {
        const k = norm(args);
        if (k === 'godroll' || k === 'wishlist' || k === 'godrollequipped' || k === 'wishlistequipped') {
          needIndex();
          const strict = k.endsWith('equipped');
          // matchItem already prefers an equipped roll, so an "available" best means no equipped match exists.
          return (i) => {
            const m = godroll(i);
            return m !== null && (!strict || m.match === 'equipped');
          };
        }
        const explicit = IS_FILTERS[k];
        if (explicit) return explicit;
        const cat = categories().get(k);
        if (cat !== undefined) return (i) => hasCategory(i, cat);
        throw new Error(`Unknown filter "is:${args}".\n${keywordList()}`);
      }
      case 'keyword': {
        const q = args.toLowerCase();
        return (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.type ?? '').toLowerCase().includes(q) ||
          i.plugs.some((p) => p.includes(q));
      }
      case 'name': {
        const q = args.toLowerCase();
        return (i) => i.name.toLowerCase().includes(q);
      }
      case 'exactname': {
        const q = args.toLowerCase();
        return (i) => i.name.toLowerCase() === q;
      }
      case 'description': {
        const q = args.toLowerCase();
        return (i) => i.description.includes(q);
      }
      case 'type': {
        const q = args.toLowerCase();
        return (i) => (i.type ?? '').toLowerCase().includes(q);
      }
      case 'godroll':
      case 'wishlistnotes': {
        needIndex();
        const q = args.toLowerCase();
        return (i) => godroll(i, q) !== null;
      }
      case 'perk':
      case 'perkname': {
        usedPerks = true;
        const q = args.toLowerCase();
        return (i) => i.plugs.some((p) => p.includes(q));
      }
      case 'power':
      case 'light': {
        const c = compare(args, 'power');
        return (i) => c(i.power);
      }
      case 'stack': {
        const c = compare(args, 'stack');
        return (i) => c(i.quantity);
      }
      case 'count': {
        const c = compare(args, 'count');
        return (i) => c(i.dupeCount);
      }
      case 'energycapacity': {
        const c = compare(args, 'energycapacity');
        return (i) => c(i.energy?.capacity);
      }
      case 'stat': {
        const { stat, rest } = splitStat(args);
        if (stat !== 'total' && !stats().has(stat)) {
          throw new Error(`Unknown stat "${stat}". Use a stat name as it appears in game, or "total".`);
        }
        statsUsed.push(stat);
        const c = compare(rest, `stat:${stat}:`);
        return (i) => c(statValue(i, stat));
      }
      default:
        throw new Error(`Unknown filter "${type}:".\n${keywordList()}`);
    }
  };

  const walk = (node: QueryAST): Pred => {
    if (node.error) throw node.error;
    switch (node.op) {
      case 'filter': return filter(node.type, node.args);
      case 'not': {
        const p = walk(node.operand);
        return (i) => !p(i);
      }
      case 'and': {
        const ps = node.operands.map(walk);
        return (i) => ps.every((p) => p(i));
      }
      case 'or': {
        const ps = node.operands.map(walk);
        return (i) => ps.some((p) => p(i));
      }
      case 'noop': return () => true;
    }
  };

  const predicate = walk(ast);
  return { predicate, statsUsed, usedPerks, usedGodroll };
}

/** Sort key for the tool's `sort` param: "power", "name", "recent", "quantity" or "stat:<name>". */
export function sortItems(items: SearchItem[], sort: string): SearchItem[] {
  const key = sort.trim().toLowerCase();
  if (key === 'name') return [...items].sort((a, b) => a.name.localeCompare(b.name));
  // DIM's item-feed order: Bungie allocates instance ids monotonically, so newest id = newest drop.
  // Padded string compare, not BigInt — ids are uint64 and a malformed one must not throw mid-sort.
  // Uninstanced stacks (materials, shaders) have no id and fall to the end.
  if (key === 'recent') {
    const k = (i: SearchItem) => (i.itemInstanceId ?? '').padStart(20, '0');
    return [...items].sort((a, b) => k(b).localeCompare(k(a)));
  }
  const stat = key.startsWith('stat:') ? norm(key.slice(5)) : undefined;
  if (stat !== undefined && stat !== 'total' && !stats().has(stat)) {
    throw new Error(`Unknown stat "${stat}" in sort. Use "power", "name", "recent", "quantity", or "stat:<name>".`);
  }
  const value = (i: SearchItem): number =>
    (stat !== undefined ? statValue(i, stat) : key === 'quantity' ? i.quantity : key === 'power' ? i.power : undefined) ?? -Infinity;
  if (stat === undefined && key !== 'power' && key !== 'quantity') {
    throw new Error(`Unknown sort "${sort}". Use "power", "name", "recent", "quantity", or "stat:<name>".`);
  }
  return [...items].sort((a, b) => value(b) - value(a)); // numeric sorts are descending — "highest X" is the ask
}

export const SEARCH_HELP = keywordList();
