import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openManifestFile, hashToId } from '../src/manifest.js';
import { itemSummary, formatSales, parseBungieName } from '../src/tools/read.js';
import { tool } from '../src/tools/util.js';

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2read-')), 'world.content');
  const db = new Database(file);
  db.exec('CREATE TABLE DestinyInventoryItemDefinition (id INTEGER PRIMARY KEY, json BLOB)');
  db.prepare('INSERT INTO DestinyInventoryItemDefinition VALUES (?, ?)').run(
    hashToId(999), JSON.stringify({
      hash: 999,
      displayProperties: { name: 'Test Rifle' },
      itemTypeDisplayName: 'Auto Rifle',
      inventory: { tierTypeName: 'Legendary' },
    }));
  db.close();
  openManifestFile(file);
});

describe('itemSummary', () => {
  it('resolves names, power, and drops noise', () => {
    const s = itemSummary(
      { itemHash: 999, itemInstanceId: '123', quantity: 1 },
      { '123': { primaryStat: { statHash: 1480404414, value: 2010 } } }, // Attack — a real power stat
    );
    expect(s).toEqual({
      name: 'Test Rifle', itemHash: 999, itemInstanceId: '123',
      type: 'Auto Rifle', tier: 'Legendary', power: 2010, quantity: undefined,
    });
  });

  it('falls back to #hash when def missing', () => {
    expect(itemSummary({ itemHash: 1, quantity: 3 }).name).toBe('#1');
  });
});

describe('formatSales', () => {
  it('resolves item and cost names', () => {
    const sales = {
      '5': { itemHash: 999, vendorItemIndex: 5, costs: [{ itemHash: 999, quantity: 25 }] },
    };
    expect(formatSales(sales)).toEqual([
      { name: 'Test Rifle', itemHash: 999, vendorItemIndex: 5, costs: ['25 Test Rifle'] },
    ]);
  });
});

describe('parseBungieName', () => {
  it('splits on the last #', () => {
    expect(parseBungieName('Cool#Guy#1234')).toEqual({ displayName: 'Cool#Guy', displayNameCode: 1234 });
  });
  it('throws readable error without code', () => {
    expect(() => parseBungieName('NoCode')).toThrowError(/Name#1234/);
  });
});

describe('tool wrapper', () => {
  it('wraps success as text content', async () => {
    const h = tool(async () => ({ a: 1 }));
    expect(await h({})).toEqual({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
  });

  it('wraps errors as isError result, no stack', async () => {
    const h = tool(async () => { throw new Error('boom'); });
    const r = await h({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('boom');
    expect(r.content[0].text).not.toContain('    at ');
  });
});
