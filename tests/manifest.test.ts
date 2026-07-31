import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openManifestFile, hashToId, getDef, defName, searchDefs, firstHash } from '../src/manifest.js';

// Hash above 2^31 (real Gjallarhorn hash 1363886209 is below it), so its sqlite id is negative.
const GJALLY = 4289226715;

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2mani-')), 'world.content');
  const db = new Database(file);
  db.exec('CREATE TABLE DestinyInventoryItemDefinition (id INTEGER PRIMARY KEY, json BLOB)');
  const ins = db.prepare('INSERT INTO DestinyInventoryItemDefinition VALUES (?, ?)');
  ins.run(hashToId(GJALLY), JSON.stringify({
    hash: GJALLY,
    displayProperties: { name: 'Gjallarhorn' },
    itemTypeDisplayName: 'Rocket Launcher',
    inventory: { tierTypeName: 'Exotic' },
  }));
  ins.run(100, JSON.stringify({ hash: 100, displayProperties: { name: 'Sunshot' }, itemTypeDisplayName: 'Hand Cannon' }));
  db.close();
  openManifestFile(file);
});

describe('manifest', () => {
  it('converts high hashes to negative ids', () => {
    expect(hashToId(GJALLY)).toBeLessThan(0);
    expect(hashToId(100)).toBe(100);
  });

  it('getDef finds rows via unsigned hash', () => {
    expect(getDef('DestinyInventoryItemDefinition', GJALLY)?.displayProperties.name).toBe('Gjallarhorn');
  });

  it('defName falls back to #hash for unknown', () => {
    expect(defName('DestinyInventoryItemDefinition', 42)).toBe('#42');
  });

  it('searchDefs matches name case-insensitively', () => {
    const r = searchDefs('gjallar');
    expect(r).toEqual([{ hash: GJALLY, name: 'Gjallarhorn', type: 'Rocket Launcher', tier: 'Exotic' }]);
  });

  it('firstHash returns some row hash', () => {
    expect([GJALLY, 100]).toContain(firstHash('DestinyInventoryItemDefinition'));
  });
});
