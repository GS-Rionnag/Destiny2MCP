import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hashToId, openManifestFile } from '../src/manifest.js';
import { resetKeywordCache } from '../src/search/index.js';
import { catalogItems, itemDetail, itemHashesByName, resetCatalog } from '../src/catalog.js';
import { openWishlistFile } from '../src/wishlist.js';
import { registerCatalogTools } from '../src/tools/catalog.js';

const WEAPON = 1, HAND_CANNON = 6;
const RANGE = 1240592695;
const WEAPON_PERKS = 4241085061, INTRINSIC = 3956125808;
// 10 the weapon, 11 a reissue of it, 12 a retired one; 20+ its plugs
const ITEMS: Record<number, any> = {
  10: {
    hash: 10,
    displayProperties: { name: 'The Palindrome', description: 'A hand cannon.' },
    itemTypeDisplayName: 'Hand Cannon',
    inventory: { tierTypeName: 'Legendary', maxStackSize: 1, bucketTypeHash: 2465295065 },
    itemCategoryHashes: [WEAPON, HAND_CANNON],
    classType: 3,
    defaultDamageType: 2,
    damageTypeHashes: [2303181850],
    equippingBlock: { ammoType: 1 },
    stats: { stats: { [RANGE]: { statHash: RANGE, value: 72 } } },
    sockets: {
      socketCategories: [
        { socketCategoryHash: INTRINSIC, socketIndexes: [0] },
        { socketCategoryHash: WEAPON_PERKS, socketIndexes: [1, 2] },
      ],
      socketEntries: [
        { socketTypeHash: 1, singleInitialItemHash: 20, reusablePlugItems: [{ plugItemHash: 20 }] },
        { socketTypeHash: 2, singleInitialItemHash: 21, randomizedPlugSetHash: 900 },
        { socketTypeHash: 3, singleInitialItemHash: 23, randomizedPlugSetHash: 901 },
      ],
    },
  },
  11: { hash: 11, displayProperties: { name: 'The Palindrome' }, itemTypeDisplayName: 'Hand Cannon', inventory: { tierTypeName: 'Legendary' }, itemCategoryHashes: [WEAPON, HAND_CANNON], classType: 3 },
  12: { hash: 12, displayProperties: { name: 'Dummy Copy' }, itemType: 20, itemTypeDisplayName: 'Hand Cannon', inventory: { tierTypeName: 'Legendary' }, itemCategoryHashes: [WEAPON] },
  20: { hash: 20, displayProperties: { name: 'Adaptive Frame' }, plug: { plugCategoryIdentifier: 'intrinsics' } },
  21: { hash: 21, displayProperties: { name: 'Explosive Payload', description: 'Rounds explode.' }, plug: { plugCategoryIdentifier: 'frames' } },
  22: { hash: 22, displayProperties: { name: 'Outlaw' }, plug: { plugCategoryIdentifier: 'frames' } },
  23: { hash: 23, displayProperties: { name: 'Desperate Measures' }, plug: { plugCategoryIdentifier: 'frames' } },
  24: { hash: 24, displayProperties: { name: 'Retired Perk' }, plug: { plugCategoryIdentifier: 'frames' } },
};

const tools: Record<string, Function> = {};
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2cat-'));
  const file = path.join(dir, 'world.content');
  const db = new Database(file);
  for (const t of ['DestinyInventoryItemDefinition', 'DestinyItemCategoryDefinition', 'DestinyStatDefinition',
    'DestinyPlugSetDefinition', 'DestinySocketCategoryDefinition', 'DestinyInventoryBucketDefinition',
    'DestinyDamageTypeDefinition', 'DestinyClassDefinition']) {
    db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, json BLOB)`);
  }
  const insert = (table: string, hash: number, json: unknown) =>
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(hashToId(hash), JSON.stringify(json));

  for (const [hash, def] of Object.entries(ITEMS)) insert('DestinyInventoryItemDefinition', Number(hash), def);
  insert('DestinyItemCategoryDefinition', WEAPON, { hash: WEAPON, displayProperties: { name: 'Weapon' } });
  insert('DestinyItemCategoryDefinition', HAND_CANNON, { hash: HAND_CANNON, displayProperties: { name: 'Hand Cannon' } });
  insert('DestinyStatDefinition', RANGE, { hash: RANGE, displayProperties: { name: 'Range' } });
  insert('DestinySocketCategoryDefinition', WEAPON_PERKS, { hash: WEAPON_PERKS, displayProperties: { name: 'WEAPON PERKS' } });
  insert('DestinySocketCategoryDefinition', INTRINSIC, { hash: INTRINSIC, displayProperties: { name: 'INTRINSIC TRAITS' } });
  insert('DestinyInventoryBucketDefinition', 2465295065, { hash: 2465295065, displayProperties: { name: 'Energy Weapons' } });
  insert('DestinyDamageTypeDefinition', 2303181850, { hash: 2303181850, displayProperties: { name: 'Arc' } });
  // Column 1 rolls Explosive Payload / Outlaw, and one perk that no longer drops.
  insert('DestinyPlugSetDefinition', 900, {
    hash: 900,
    reusablePlugItems: [
      { plugItemHash: 21, currentlyCanRoll: true },
      { plugItemHash: 22, currentlyCanRoll: true },
      { plugItemHash: 24, currentlyCanRoll: false },
    ],
  });
  insert('DestinyPlugSetDefinition', 901, { hash: 901, reusablePlugItems: [{ plugItemHash: 23, currentlyCanRoll: true }] });
  db.close();

  const wish = path.join(dir, 'wishlist.db');
  const w = new Database(wish);
  w.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, text TEXT, tags TEXT);
    CREATE TABLE rolls (itemHash INTEGER, perks TEXT, noteId INTEGER);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX rolls_item ON rolls(itemHash);
  `);
  w.prepare('INSERT INTO notes VALUES (?,?,?,?)').run(1, 'Reviewer', 'Explosive Payload carries this in PvE.', 'pve pve-god');
  w.prepare('INSERT INTO notes VALUES (?,?,?,?)').run(2, 'Reviewer', 'Outlaw is the PvP pick.', 'pvp');
  const roll = w.prepare('INSERT INTO rolls VALUES (?,?,?)');
  roll.run(10, 'Desperate Measures|Explosive Payload', 1);
  roll.run(10, 'Desperate Measures|Explosive Payload|Fluted Barrel', 1); // same traits, different barrel
  roll.run(10, 'Desperate Measures|Outlaw', 2);
  w.prepare('INSERT INTO meta VALUES (?,?)').run('source', 'test-list');
  w.close();

  openManifestFile(file);
  openWishlistFile(wish);
  resetKeywordCache();
  resetCatalog();
  registerCatalogTools({ registerTool: (name: string, _c: any, h: Function) => (tools[name] = h) } as any);
});

describe('catalog', () => {
  it('covers every real item and leaves dummy definitions out', () => {
    const names = catalogItems().map((i) => i.name);
    expect(names).toContain('The Palindrome');
    expect(names).not.toContain('Dummy Copy');
  });

  it('exposes the whole perk pool as plugOptions, dropping perks that no longer drop', () => {
    resetCatalog();
    const item = catalogItems(true).find((i) => i.itemHash === 10)!;
    expect(Object.values(item.plugOptions!).flat()).toEqual(
      expect.arrayContaining(['explosive payload', 'outlaw', 'desperate measures']));
    expect(Object.values(item.plugOptions!).flat()).not.toContain('retired perk');
  });

  it('reads base stats off the definition, so unowned items still compare', () => {
    expect(catalogItems().find((i) => i.itemHash === 10)!.stats.range).toBe(72);
  });

  it('groups a socket into a column with its plug category and description', () => {
    const d = itemDetail(10)!;
    expect(d.slot).toBe('Energy Weapons');
    expect(d.damageType).toBe('Arc');
    expect(d.columns.map((c) => c.plugCategory)).toEqual(['intrinsics', 'frames', 'frames']);
    expect(d.columns[1].options.map((o) => o.name)).toEqual(['Explosive Payload', 'Outlaw']);
    expect(d.columns[1].options[0].description).toBe('Rounds explode.');
  });

  it('resolves a name to every version of that item', () => {
    expect(itemHashesByName('The Palindrome')).toEqual([10, 11]);
  });
});

describe('search_items', () => {
  it('runs DIM queries against the whole game and collapses reissues into one row', async () => {
    const out = parse(await tools.search_items({ query: 'is:handcannon', limit: 25 }));
    const pal = out.items.find((i: any) => i.name === 'The Palindrome');
    expect(pal.versions).toBe(2); // hashes 10 and 11 are the same weapon
    expect(pal.slot).toBe('Energy Weapons');
  });

  it('treats perk: as "can roll it", which is the only sense a catalog item has', async () => {
    const hit = parse(await tools.search_items({ query: "perk:'explosive payload'", limit: 5 }));
    expect(hit.items.map((i: any) => i.name)).toContain('The Palindrome');
    const miss = parse(await tools.search_items({ query: "perk:'retired perk'", limit: 5 }));
    expect(miss.items).toEqual([]);
  });

  it('finds every item with a community god roll', async () => {
    const out = parse(await tools.search_items({ query: 'is:godroll', limit: 5 }));
    expect(out.items.map((i: any) => i.name)).toEqual(['The Palindrome']);
  });
});

describe('inspect_item', () => {
  it('aggregates wish-list rolls into per-column votes and trait combinations', async () => {
    const out = parse(await tools.inspect_item({ name: 'The Palindrome', roll_limit: 10, include_perk_pool: true }));
    const g = out.godRolls;
    expect(g.rollCount).toBe(3);
    // Two rolls want Explosive Payload; they differ only by barrel, so they are ONE combination.
    expect(g.topRolls[0]).toMatchObject({ perks: ['Desperate Measures', 'Explosive Payload'], rolls: 2 });
    expect(g.mostWantedPerks.find((c: any) => c.column === 1).perks[0]).toEqual({ name: 'Explosive Payload', rolls: 2 });
    expect(g.notes.map((n: any) => n.text)).toContain('Explosive Payload carries this in PvE.');
  });

  it('filters rolls by note text, for "what is the PvP roll"', async () => {
    const out = parse(await tools.inspect_item({ name: 'The Palindrome', godrolls: 'pvp', roll_limit: 10, include_perk_pool: false }));
    expect(out.godRolls.rollCount).toBe(1);
    expect(out.godRolls.topRolls[0].perks).toEqual(['Desperate Measures', 'Outlaw']);
    expect(out.columns).toBeUndefined();
  });

  it('prefers the version of a reissued weapon the wish list actually covers', async () => {
    const out = parse(await tools.inspect_item({ name: 'The Palindrome', roll_limit: 5, include_perk_pool: false }));
    expect(out.hash).toBe(10);
    expect(out.alsoMatched).toEqual([{ hash: 11, name: 'The Palindrome' }]);
  });

  it('refuses a call with neither name nor hash', async () => {
    const res = await tools.inspect_item({ roll_limit: 5, include_perk_pool: false });
    expect(res.isError).toBe(true);
  });
});
