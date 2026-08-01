import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseWishlist, matchItem, openWishlistFile } from '../src/wishlist.js';

// Perk hashes as a wish list would carry them; the resolver stub stands in for the manifest.
const PERKS: Record<number, string> = { 1: 'Outlaw', 2: 'Rampage', 3: 'Firing Line', 4: 'Kill Clip' };
const parse = (text: string) => parseWishlist(text, (h) => PERKS[h] ?? `#${h}`);
const note = (r: ReturnType<typeof parse>, i = 0) => r.notes.get(r.rolls[i].noteKey)!;

describe('parseWishlist', () => {
  it('applies a //notes: block to every roll beneath it, until a blank line', () => {
    const r = parse([
      '//notes:Great roll.|tags:PvE M+KB',
      'dimwishlist:item=100&perks=2,1,2',
      'dimwishlist:item=101&perks=3',
      '',
      'dimwishlist:item=102&perks=1',
    ].join('\n'));
    // Perk names are deduplicated, sorted and pipe-joined
    expect(r.rolls.map((x) => x.perks)).toEqual(['Outlaw|Rampage', 'Firing Line', 'Outlaw']);
    expect(r.rolls[0].noteKey).toBe(r.rolls[1].noteKey);
    expect(note(r)).toEqual({ title: '', text: 'Great roll.', tags: 'PvE M+KB' });
    expect(note(r, 2)).toEqual({ title: '', text: '', tags: '' }); // the blank line closed the note
  });

  it('lets an inline #notes: override the block note for that line only', () => {
    const r = parse([
      '//notes:Block note.|tags:PvE',
      'dimwishlist:item=200&perks=1',
      'dimwishlist:item=201&perks=1#notes:Inline note.|tags:PvP',
      'dimwishlist:item=202&perks=1',
    ].join('\n'));
    expect(note(r, 1)).toEqual({ title: '', text: 'Inline note.', tags: 'PvP' });
    expect(r.rolls[0].noteKey).toBe(r.rolls[2].noteKey);
    expect(note(r, 0)).toEqual({ title: '', text: 'Block note.', tags: 'PvE' });
  });

  it('recovers |tags: from a note that wraps onto a continuation line', () => {
    // voltron.txt has 218 of these: the prose wraps, and the tag half lands on the bare next line
    const r = parse([
      '//notes:Shreds bosses and',
      'clears adds fast.|tags:PvE PvE-Boss',
      'dimwishlist:item=300&perks=2',
    ].join('\n'));
    expect(note(r)).toEqual({ title: '', text: 'Shreds bosses and clears adds fast.', tags: 'PvE PvE-Boss' });
  });

  it('title: sets the source credit and resets any open note', () => {
    const r = parse([
      '//notes:Stale note.|tags:X',
      'title: CoolGuy PvP',
      'dimwishlist:item=400&perks=4',
    ].join('\n'));
    expect(note(r)).toEqual({ title: 'CoolGuy PvP', text: '', tags: '' });
  });

  it('deduplicates identical title+text+tags into one note entry', () => {
    const r = parse([
      'title:T',
      '//notes:Same note.|tags:PvE',
      'dimwishlist:item=500&perks=1',
      '',
      '//notes:Same note.|tags:PvE',
      'dimwishlist:item=501&perks=2',
    ].join('\n'));
    expect(r.notes.size).toBe(1);
    expect(r.rolls[0].noteKey).toBe(r.rolls[1].noteKey);
  });

  it('ignores comments, description: and @description: lines', () => {
    const r = parse([
      '// a comment',
      'description:file blurb',
      '@description:more blurb',
      '//notes:Kept.|tags:PvE',
      '// a comment inside the block',
      'dimwishlist:item=600&perks=1',
    ].join('\n'));
    expect(r.rolls).toHaveLength(1);
    expect(note(r)).toEqual({ title: '', text: 'Kept.', tags: 'PvE' });
  });

  it('skips trash-list rolls (negative item hash)', () => {
    const r = parse('dimwishlist:item=-69420&perks=1,2');
    expect(r.rolls).toEqual([]);
    expect(r.notes.size).toBe(0);
  });
});

describe('matchItem', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2wish-'));
    const file = path.join(tmp, 'wishlist.db');
    const db = new Database(file);
    // Same schema rebuildWishlist writes
    db.exec(`
      CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, text TEXT, tags TEXT);
      CREATE TABLE rolls (itemHash INTEGER, perks TEXT, noteId INTEGER);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX rolls_item ON rolls(itemHash);
    `);
    const insNote = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?)');
    insNote.run(1, 'Voltron', 'Great all-around roll.', 'PvE M+KB');
    insNote.run(2, 'CoolGuy', 'Crucible melter.', 'PvP');
    const insRoll = db.prepare('INSERT INTO rolls VALUES (?, ?, ?)');
    for (const [item, perks, noteId] of [
      [500, 'Firing Line|Outlaw|Rampage|Snapshot Sights', 1],
      [501, 'Kill Clip|Outlaw', 1],
      [502, 'Firing Line', 1],
      [503, 'Firing Line|Outlaw', 1],
      [504, 'Outlaw|Rampage', 1],
      [504, 'Firing Line|Outlaw', 2],
      [505, 'Outlaw|Rampage', 1],
      [505, 'Kill Clip|Rangefinder', 2],
    ] as const) insRoll.run(item, perks, noteId);
    db.close();
    openWishlistFile(file);
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('matches a roll whose perks are a subset of the plugged perks', () => {
    const m = matchItem(500, ['smallbore', 'firing line', 'outlaw', 'rampage', 'snapshot sights', 'extended mag'])!;
    expect(m).toMatchObject({ match: 'equipped', rollsMatched: 1, tags: 'PvE M+KB', source: 'Voltron' });
    expect(m.perks).toEqual(['Firing Line', 'Outlaw', 'Rampage', 'Snapshot Sights']);
    expect(m.swap).toBeUndefined();
  });

  it('returns null when a roll perk is neither plugged nor selectable', () => {
    expect(matchItem(501, ['outlaw', 'smallbore'])).toBeNull();
    expect(matchItem(999, ['outlaw'])).toBeNull(); // item not on the list at all
  });

  it('matches enhanced perks by lowercased display name, not hash', () => {
    // An enhanced perk has a different hash but the same display name; the caller lowercases
    // the plug name, so it must equal the stored display-case roll perk case-insensitively.
    const m = matchItem(502, ['firing line'])!;
    expect(m.match).toBe('equipped');
    expect(m.perks).toEqual(['Firing Line']); // display case preserved from the wish list
    expect(m.perks[0].toLowerCase()).toBe('firing line');
  });

  it('grades a selectable-but-unplugged perk as available, with the swap named', () => {
    const m = matchItem(503, ['outlaw', 'smallbore'], { 3: ['firing line', 'snapshot sights'] })!;
    expect(m.match).toBe('available');
    expect(m.swap).toEqual(['socket 3 -> Firing Line']);
  });

  it('prefers an equipped roll over an available one and counts every match', () => {
    const m = matchItem(504, ['outlaw', 'rampage'], { 2: ['firing line'] })!;
    expect(m.match).toBe('equipped');
    expect(m.perks).toEqual(['Outlaw', 'Rampage']);
    expect(m.rollsMatched).toBe(2);
  });

  it('filters rolls by note title, tags and text, case-insensitively', () => {
    const plugs = ['outlaw', 'rampage', 'kill clip', 'rangefinder'];
    expect(matchItem(505, plugs)!.rollsMatched).toBe(2);
    const m = matchItem(505, plugs, undefined, 'PVP')!; // tag match
    expect(m.perks).toEqual(['Kill Clip', 'Rangefinder']);
    expect(m.rollsMatched).toBe(1);
    expect(matchItem(505, plugs, undefined, 'coolguy')!.source).toBe('CoolGuy'); // title match
    expect(matchItem(505, plugs, undefined, 'crucible')!.tags).toBe('PvP'); // text match
    expect(matchItem(505, plugs, undefined, 'zzz')).toBeNull();
  });
});
