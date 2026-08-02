// Every item in the game, not just the ones the account owns.
//
// The manifest already sits on disk for get_definition, so a catalog is just a different
// view of it: each definition flattened into the same SearchItem shape the inventory search
// uses, which means the DIM query language works unchanged against the whole game.
import { defName, eachDef, getDef } from './manifest.js';
import { statKey, type SearchItem } from './search/index.js';

const DUMMY_ITEM_TYPE = 20; // placeholder copies of real items — noise in every search

// Sockets nobody builds around: shaders, ornaments, trackers, mementos.
const COSMETIC = /cosmetic|ornament|shader|tracker|memento|skin/i;

// Mod sockets list every mod in the game; past this the response is bulk, not information.
const MAX_OPTIONS = 40;

let base: SearchItem[] | null = null;
let withPerks: SearchItem[] | null = null;

/** Tests reopen the manifest against a fixture db. */
export function resetCatalog(): void {
  base = null;
  withPerks = null;
}

const defCache = new Map<number, any>();
function itemDef(hash: number): any | undefined {
  if (!defCache.has(hash)) defCache.set(hash, getDef('DestinyInventoryItemDefinition', hash));
  return defCache.get(hash);
}
const plugName = (hash: number) => (itemDef(hash)?.displayProperties?.name ?? '').toLowerCase();

function toSearchItem(d: any): SearchItem {
  const stats: Record<string, number> = {};
  for (const [h, v] of Object.entries<any>(d.stats?.stats ?? {})) {
    const key = statKey(Number(h));
    // Base values from the definition: what the item rolls with before perks and masterwork.
    if (key) stats[key] = v.value;
  }
  return {
    name: d.displayProperties?.name ?? `#${d.hash}`,
    itemHash: d.hash,
    type: d.itemTypeDisplayName,
    tier: (d.inventory?.tierTypeName ?? '').toLowerCase(),
    quantity: 1,
    location: 'Game',
    equipped: false,
    bucketHash: d.inventory?.bucketTypeHash ?? 0,
    categories: d.itemCategoryHashes ?? [],
    classType: d.classType ?? 3,
    damageType: d.defaultDamageType ?? 0,
    ammoType: d.equippingBlock?.ammoType ?? 0,
    maxStackSize: d.inventory?.maxStackSize ?? 1,
    equipment: Boolean(d.equippingBlock),
    transferable: !d.nonTransferrable,
    locked: false,
    tracked: false,
    masterwork: false,
    crafted: false,
    description: (d.displayProperties?.description ?? '').toLowerCase(),
    stats,
    plugs: [],
    dupeCount: 1,
  };
}

/** Plug hashes a socket entry can hold: its fixed list, its plug set, or the perk it always has. */
function socketPlugHashes(entry: any): number[] {
  const set = entry.randomizedPlugSetHash ?? entry.reusablePlugSetHash;
  if (set) {
    const ps = getDef('DestinyPlugSetDefinition', set);
    const items: any[] = ps?.reusablePlugItems ?? [];
    // currentlyCanRoll false = retired from the loot pool; keep it out so "can roll" means today.
    const live = items.filter((p) => p.currentlyCanRoll !== false);
    return (live.length ? live : items).map((p) => p.plugItemHash);
  }
  const fixed = (entry.reusablePlugItems ?? []).map((p: any) => p.plugItemHash);
  if (fixed.length) return fixed;
  return entry.singleInitialItemHash ? [entry.singleInitialItemHash] : [];
}

/** socket index -> the socket category it belongs to ("WEAPON PERKS", "ARMOR MODS", ...). */
function socketCategoryNames(d: any): Map<number, string> {
  const out = new Map<number, string>();
  for (const c of d.sockets?.socketCategories ?? []) {
    const name = defName('DestinySocketCategoryDefinition', c.socketCategoryHash);
    for (const idx of c.socketIndexes ?? []) out.set(idx, name);
  }
  return out;
}

/**
 * The catalog, built once per process.
 *
 * `perks` resolves every socket's plug pool, which is what makes `perk:` and `is:godroll`
 * mean "this weapon CAN roll it" instead of "this copy has it" — it costs a few seconds
 * and only equipment has sockets, so it is a separate, lazier pass.
 */
export function catalogItems(perks = false): SearchItem[] {
  if (perks && withPerks) return withPerks;
  if (!perks && base) return base;

  const defs = eachDef('DestinyInventoryItemDefinition');
  const items: SearchItem[] = [];
  for (const d of defs) {
    if (d.redacted || d.itemType === DUMMY_ITEM_TYPE || !d.displayProperties?.name) continue;
    const item = toSearchItem(d);
    if (perks && d.sockets?.socketEntries?.length) {
      const cats = socketCategoryNames(d);
      const options: Record<number, string[]> = {};
      d.sockets.socketEntries.forEach((entry: any, idx: number) => {
        if (COSMETIC.test(cats.get(idx) ?? '')) return;
        const names = socketPlugHashes(entry).map(plugName).filter(Boolean);
        if (names.length) options[idx] = names;
      });
      item.plugOptions = options;
      // The default roll — what the item shows in a vendor or collections.
      item.plugs = d.sockets.socketEntries
        .map((e: any, idx: number) => (COSMETIC.test(cats.get(idx) ?? '') || !e.singleInitialItemHash ? '' : plugName(e.singleInitialItemHash)))
        .filter(Boolean);
    }
    items.push(item);
  }

  if (perks) withPerks = items; else base = items;
  return items;
}

export interface SocketColumn {
  index: number;
  category?: string;
  /**
   * Bungie's plug category for this column: `frames` is the trait column everyone means by
   * "the god roll", vs `barrels`/`magazines`/`origins`/`intrinsics` and the mod sockets.
   */
  plugCategory?: string;
  /** Every perk/mod this column can roll, in manifest order (capped — see optionCount). */
  options: { hash: number; name: string; description?: string }[];
  /** Set when the column was truncated: how many plugs it really accepts. */
  optionCount?: number;
  /** True when the game rolls this column at random — the columns a god roll is expressed in. */
  random?: boolean;
  /** The perk this column starts with (intrinsic, or the collections roll). */
  initial?: string;
}

/** Everything a build needs about one item: base stats and the full perk pool per column. */
export function itemDetail(hash: number) {
  const d = getDef('DestinyInventoryItemDefinition', hash);
  if (!d) return undefined;
  const cats = socketCategoryNames(d);
  const columns: SocketColumn[] = [];
  (d.sockets?.socketEntries ?? []).forEach((entry: any, index: number) => {
    const category = cats.get(index);
    if (COSMETIC.test(category ?? '')) return;
    const hashes = socketPlugHashes(entry);
    // A mod socket accepts 70+ interchangeable mods; a perk column has a handful. Descriptions
    // are what make a perk column worth reading and what make a mod column unreadable.
    const describe = hashes.length <= 30;
    const options = hashes.slice(0, MAX_OPTIONS).map((h) => {
      const p = itemDef(h);
      return {
        hash: h,
        name: p?.displayProperties?.name ?? `#${h}`,
        description: describe ? p?.displayProperties?.description || undefined : undefined,
      };
    }).filter((o) => o.name && o.name !== 'Empty Mod Socket');
    if (!options.length) return;
    columns.push({
      index,
      category,
      plugCategory: itemDef(options[0].hash)?.plug?.plugCategoryIdentifier,
      random: Boolean(entry.randomizedPlugSetHash),
      optionCount: hashes.length > options.length ? hashes.length : undefined,
      options,
      initial: entry.singleInitialItemHash ? itemDef(entry.singleInitialItemHash)?.displayProperties?.name : undefined,
    });
  });

  const stats = Object.values<any>(d.stats?.stats ?? {})
    .map((s) => ({ name: defName('DestinyStatDefinition', s.statHash), value: s.value }))
    .filter((s) => !s.name.startsWith('#'))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    hash: d.hash,
    name: d.displayProperties?.name,
    description: d.displayProperties?.description || undefined,
    flavorText: d.flavorText || undefined,
    type: d.itemTypeDisplayName,
    tier: d.inventory?.tierTypeName,
    slot: d.inventory?.bucketTypeHash ? defName('DestinyInventoryBucketDefinition', d.inventory.bucketTypeHash) : undefined,
    classType: ['Titan', 'Hunter', 'Warlock'][d.classType] ?? undefined,
    damageType: d.defaultDamageType ? defName('DestinyDamageTypeDefinition', d.damageTypeHashes?.[0] ?? 0) : undefined,
    ammoType: ['', 'Primary', 'Special', 'Heavy'][d.equippingBlock?.ammoType ?? 0] || undefined,
    craftable: Boolean(d.inventory?.recipeItemHash),
    stats,
    columns,
  };
}

/** Item hashes for a name, exact matches first — the catalog's answer to "which Palindrome?". */
export function itemHashesByName(name: string, limit = 5): number[] {
  const q = name.trim().toLowerCase();
  const hits = catalogItems().filter((i) => i.name.toLowerCase().includes(q));
  hits.sort((a, b) =>
    Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q)
    || Number(b.tier === 'exotic') - Number(a.tier === 'exotic')
    || a.name.length - b.name.length);
  return hits.slice(0, limit).map((i) => i.itemHash);
}
