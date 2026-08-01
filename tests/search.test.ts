import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openManifestFile, hashToId } from '../src/manifest.js';
import { buildItems, compileQuery, resetKeywordCache, sortItems, type SearchItem } from '../src/search/index.js';
import { lexer, parseQuery } from '../src/search/query-parser.js';

const WEAPON = 1, ARMOR = 20, HAND_CANNON = 6, HELMET = 45;
const RESILIENCE = 392767087, MOBILITY = 2996146975;

// Hashes: 100 exotic hand cannon, 101 legendary hunter helmet, 102 a second copy of 100
const ITEMS: Record<number, any> = {
  100: {
    hash: 100,
    displayProperties: { name: 'Sunshot', description: 'Explosive solar rounds.' },
    itemTypeDisplayName: 'Hand Cannon',
    inventory: { tierTypeName: 'Exotic', maxStackSize: 1 },
    itemCategoryHashes: [WEAPON, HAND_CANNON],
    classType: 3,
    defaultDamageType: 3,
    equippingBlock: { ammoType: 1 },
  },
  101: {
    hash: 101,
    displayProperties: { name: 'Wildwood Cover', description: 'A hunter helmet.' },
    itemTypeDisplayName: 'Helmet',
    inventory: { tierTypeName: 'Legendary', maxStackSize: 1 },
    itemCategoryHashes: [ARMOR, HELMET],
    classType: 1,
    equippingBlock: { ammoType: 0 },
  },
  200: { hash: 200, displayProperties: { name: 'Incandescent' } },
};

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2search-')), 'world.content');
  const db = new Database(file);
  for (const t of ['DestinyInventoryItemDefinition', 'DestinyItemCategoryDefinition', 'DestinyStatDefinition', 'DestinyClassDefinition']) {
    db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, json BLOB)`);
  }
  const insert = (table: string, hash: number, json: unknown) =>
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(hashToId(hash), JSON.stringify(json));

  for (const [hash, def] of Object.entries(ITEMS)) insert('DestinyInventoryItemDefinition', Number(hash), def);
  for (const [hash, name] of [[WEAPON, 'Weapon'], [ARMOR, 'Armor'], [HAND_CANNON, 'Hand Cannon'], [HELMET, 'Helmets']] as const) {
    insert('DestinyItemCategoryDefinition', hash, { hash, displayProperties: { name } });
  }
  // Armor 3.0 names, as the live manifest has them — 'resilience'/'mobility' only work via alias
  insert('DestinyStatDefinition', RESILIENCE, { hash: RESILIENCE, displayProperties: { name: 'Health' } });
  insert('DestinyStatDefinition', MOBILITY, { hash: MOBILITY, displayProperties: { name: 'Weapons' } });
  insert('DestinyClassDefinition', 671679327, { hash: 671679327, displayProperties: { name: 'Hunter' } });
  db.close();

  openManifestFile(file);
  resetKeywordCache();
});

const PROFILE = {
  characters: { data: { c1: { characterId: 'c1', classHash: 671679327 } } },
  profileInventory: {
    data: {
      items: [
        { itemHash: 100, itemInstanceId: 'w1', quantity: 1, bucketHash: 138197802, state: 1 },
        { itemHash: 100, itemInstanceId: 'w2', quantity: 1, bucketHash: 138197802, state: 0 },
      ],
    },
  },
  characterInventories: {
    data: { c1: { items: [{ itemHash: 101, itemInstanceId: 'a1', quantity: 1, bucketHash: 3448274439, state: 4 }] } },
  },
  characterEquipment: {
    data: { c1: { items: [{ itemHash: 101, itemInstanceId: 'a2', quantity: 1, bucketHash: 3448274439, state: 0 }] } },
  },
  itemComponents: {
    instances: {
      data: {
        w1: { primaryStat: { value: 1900 }, damageType: 3 },
        w2: { primaryStat: { value: 1750 }, damageType: 3 },
        a1: { primaryStat: { value: 1800 }, energy: { energyUsed: 3, energyCapacity: 10 } },
        a2: { primaryStat: { value: 1810 }, energy: { energyUsed: 0, energyCapacity: 10 } },
      },
    },
    stats: {
      data: {
        a1: { stats: { [RESILIENCE]: { value: 26 }, [MOBILITY]: { value: 10 } } },
        a2: { stats: { [RESILIENCE]: { value: 12 }, [MOBILITY]: { value: 20 } } },
      },
    },
    sockets: { data: { w1: { sockets: [{ plugHash: 200, isEnabled: true }] } } },
  },
};

const items = () => buildItems(PROFILE);
const run = (q: string, list: SearchItem[] = items()) => list.filter(compileQuery(q).predicate).map((i) => i.itemInstanceId);

describe('lexer', () => {
  it('splits filters, negation and implicit and', () => {
    expect([...lexer('is:blue -is:masterwork')].map((t) => t.type)).toEqual(['filter', 'implicit_and', 'not', 'filter']);
  });

  it('keeps quoted phrases together', () => {
    const tokens = [...lexer('name:"the messenger"')];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: 'filter', keyword: 'name', args: 'the messenger' });
  });

  it('normalizes not: into -is:', () => {
    expect(parseQuery('not:exotic')).toMatchObject({ op: 'not', operand: { op: 'filter', type: 'is', args: 'exotic' } });
  });

  it('binds or looser than and, and implicit and loosest', () => {
    // "a or b c" is (a or b) and c, because implicit and has the lowest precedence
    expect(parseQuery('is:weapon or is:armor is:exotic')).toMatchObject({
      op: 'and',
      operands: [{ op: 'or' }, { op: 'filter', args: 'exotic' }],
    });
  });
});

describe('buildItems', () => {
  it('resolves definitions, location, state bits and dupes', () => {
    const all = items();
    expect(all).toHaveLength(4);
    const w1 = all.find((i) => i.itemInstanceId === 'w1')!;
    expect(w1).toMatchObject({
      name: 'Sunshot', type: 'Hand Cannon', tier: 'exotic', power: 1900,
      location: 'Vault', locked: true, masterwork: false, damageType: 3, dupeCount: 2,
    });
    expect(all.find((i) => i.itemInstanceId === 'a2')!.location).toBe('Hunter (equipped)');
    expect(all.find((i) => i.itemInstanceId === 'a1')!.dupeCount).toBe(2);
  });

  it('lowercases plug names for perk matching', () => {
    expect(items().find((i) => i.itemInstanceId === 'w1')!.plugs).toEqual(['incandescent']);
  });
});

describe('filters', () => {
  it('matches item categories generated from the manifest, including the singular alias', () => {
    expect(run('is:handcannon')).toEqual(['w1', 'w2']);
    expect(run('is:helmet')).toEqual(['a1', 'a2']);
    expect(run('is:armor')).toEqual(['a1', 'a2']);
  });

  it('matches rarity, element, ammo and class', () => {
    expect(run('is:exotic')).toEqual(['w1', 'w2']);
    expect(run('is:yellow')).toEqual(['w1', 'w2']);
    expect(run('is:solar')).toEqual(['w1', 'w2']);
    expect(run('is:primary')).toEqual(['w1', 'w2']);
    expect(run('is:hunter')).toEqual(['a1', 'a2']);
  });

  it('matches state, location and dupes', () => {
    expect(run('is:locked')).toEqual(['w1']);
    expect(run('is:masterwork')).toEqual(['a1']);
    expect(run('is:invault')).toEqual(['w1', 'w2']);
    expect(run('is:equipped')).toEqual(['a2']);
    expect(run('is:dupe')).toEqual(['w1', 'w2', 'a1', 'a2']);
    expect(run('is:modded')).toEqual(['a1']);
  });

  it('matches free text, name, description and perks', () => {
    expect(run('sunshot')).toEqual(['w1', 'w2']);
    expect(run('name:wildwood')).toEqual(['a1', 'a2']);
    expect(run('exactname:sunshot')).toEqual(['w1', 'w2']);
    expect(run('exactname:sun')).toEqual([]);
    expect(run('description:"explosive solar"')).toEqual(['w1', 'w2']);
    expect(run('perk:incandescent')).toEqual(['w1']);
  });

  it('compares numbers with and without an operator', () => {
    expect(run('power:>=1800')).toEqual(['w1', 'a1', 'a2']);
    expect(run('power:<1800')).toEqual(['w2']);
    expect(run('power:1900')).toEqual(['w1']);
    expect(run('count:>=2')).toEqual(['w1', 'w2', 'a1', 'a2']);
    expect(run('energycapacity:=10')).toEqual(['a1', 'a2']);
  });

  it('compares stats, including the armor total', () => {
    expect(run('stat:health:>=20')).toEqual(['a1']);
    expect(run('stat:weapons:>=20')).toEqual(['a2']);
    // Armor 2.0 names still resolve to the renamed stats, as they do in DIM
    expect(run('stat:resilience:>=20')).toEqual(['a1']);
    expect(run('stat:mobility:>=20')).toEqual(['a2']);
    expect(run('stat:total:>=32')).toEqual(['a1', 'a2']); // a1 26+10=36, a2 12+20=32
    expect(run('stat:total:>=33')).toEqual(['a1']);
    expect(run('stat:total:>=37')).toEqual([]);
  });

  it('combines with not, or and parentheses', () => {
    expect(run('is:armor -is:equipped')).toEqual(['a1']);
    expect(run('is:armor not is:equipped')).toEqual(['a1']);
    expect(run('(is:handcannon or is:helmet) is:legendary')).toEqual(['a1', 'a2']);
    expect(run('is:handcannon is:legendary')).toEqual([]);
  });

  it('an empty query matches everything', () => {
    expect(run('')).toHaveLength(4);
  });

  it('reports unknown keywords with the keyword list, before any API call', () => {
    expect(() => compileQuery('is:nonsense')).toThrowError(/Unknown filter "is:nonsense"[\s\S]*logic: implicit and/);
    expect(() => compileQuery('bogus:1')).toThrowError(/Unknown filter "bogus:"/);
    expect(() => compileQuery('stat:nonsense:>=1')).toThrowError(/Unknown stat "nonsense"/);
    expect(() => compileQuery('power:high')).toThrowError(/expected a number/);
  });

  it('reports the stats a query used so the tool can echo them', () => {
    expect(compileQuery('stat:resilience:>=20 stat:total:>=30').statsUsed).toEqual(['resilience', 'total']);
    expect(compileQuery('perk:incandescent').usedPerks).toBe(true);
    expect(compileQuery('is:exotic').usedPerks).toBe(false);
  });
});

describe('sortItems', () => {
  it('sorts numerically, highest first', () => {
    expect(sortItems(items(), 'power').map((i) => i.itemInstanceId)).toEqual(['w1', 'a2', 'a1', 'w2']);
    expect(sortItems(items().filter((i) => i.itemInstanceId!.startsWith('a')), 'stat:resilience')
      .map((i) => i.itemInstanceId)).toEqual(['a1', 'a2']);
  });

  it('sorts by name alphabetically', () => {
    expect(sortItems(items(), 'name').map((i) => i.name)[0]).toBe('Sunshot');
  });

  it('sorts before limiting, so "highest" is not truncated away', () => {
    // w2 (1750) comes first in build order but must not survive a sorted limit of 1
    expect(sortItems(items(), 'power').slice(0, 1).map((i) => i.itemInstanceId)).toEqual(['w1']);
  });

  it('rejects unknown sorts', () => {
    expect(() => sortItems([], 'bogus')).toThrowError(/Unknown sort/);
    expect(() => sortItems([], 'stat:bogus')).toThrowError(/Unknown stat/);
  });
});
