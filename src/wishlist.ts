// DIM wish lists ("god rolls"), indexed into SQLite.
//
// The source (voltron.txt) is ~26MB / 250k rolls, so it is parsed once into data/wishlist.db
// and queried per item hash — nothing is held in memory. See
// docs/superpowers/specs/2026-08-01-godroll-wishlist-design.md.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { defName } from './manifest.js';

export interface GodrollMatch {
  /** "equipped": the plugged roll matches. "available": every perk is selectable, but a swap is needed. */
  match: 'equipped' | 'available';
  /** Wish-list tags, e.g. "PvE PvE-Boss PvE-God M+KB". */
  tags?: string;
  /** The `title:` block the roll came from — the reviewer/source credit. */
  source?: string;
  /** The roll's perks, as named by the wish list. */
  perks: string[];
  /** For an "available" match: what to change, e.g. "socket 4 -> Firing Line". */
  swap?: string[];
  /** How many wish-list rolls this item satisfies. */
  rollsMatched: number;
  noteId: number;
}

export interface WishlistNote {
  title: string;
  text: string;
  tags: string;
}

let db: Database.Database | null = null;
let tried = false;
let stmts: {
  rolls: Database.Statement;
  note: Database.Statement;
  meta: Database.Statement;
} | null = null;

const dbFile = () => path.join(config.dataDir, 'wishlist.db');

function prepare(d: Database.Database) {
  stmts = {
    rolls: d.prepare('SELECT perks, noteId FROM rolls WHERE itemHash = ?'),
    note: d.prepare('SELECT title, text, tags FROM notes WHERE id = ?'),
    meta: d.prepare('SELECT key, value FROM meta'),
  };
}

/** Open the index if it has been built. Returns null when there is nothing to read yet. */
function open(): Database.Database | null {
  if (!tried) {
    tried = true;
    try {
      if (fs.existsSync(dbFile())) {
        db = new Database(dbFile(), { readonly: true });
        prepare(db);
      }
    } catch {
      db = null; // a half-written or corrupt index must not take the server down
    }
  }
  return db;
}

/** Tests point this at a fixture index. */
export function openWishlistFile(file: string): void {
  db?.close();
  tried = true;
  db = new Database(file, { readonly: true });
  prepare(db);
}

export const wishlistReady = (): boolean => open() !== null;

export function wishlistMeta(): Record<string, string> {
  if (!open()) return {};
  return Object.fromEntries((stmts!.meta.all() as any[]).map((r) => [r.key, r.value]));
}

export function getNote(id: number): WishlistNote | undefined {
  if (!open()) return undefined;
  return stmts!.note.get(id) as WishlistNote | undefined;
}

/**
 * Best wish-list roll this item satisfies, or null.
 *
 * `plugs` are the item's currently plugged plug names, lowercased.
 * `options` maps socket index to selectable plug names (lowercased), from component 310.
 * `text`, when given, keeps only rolls whose note, tags or source contain it.
 */
export function matchItem(
  itemHash: number,
  plugs: string[],
  options?: Record<number, string[]>,
  text?: string,
): GodrollMatch | null {
  if (!open()) return null;
  const rows = stmts!.rolls.all(itemHash) as { perks: string; noteId: number }[];
  if (!rows.length) return null;

  const equipped = new Set(plugs);
  // First socket offering a perk is enough — a perk never legitimately appears in two columns.
  const selectable = new Map<string, number>();
  for (const [idx, names] of Object.entries(options ?? {})) {
    for (const n of names) if (!selectable.has(n)) selectable.set(n, Number(idx));
  }

  const needle = text?.toLowerCase();
  const noteCache = new Map<number, WishlistNote | undefined>();
  const noteMatches = (id: number) => {
    if (!needle) return true;
    if (!noteCache.has(id)) noteCache.set(id, getNote(id));
    const n = noteCache.get(id);
    return n ? [n.title, n.tags, n.text].join(' ').toLowerCase().includes(needle) : false;
  };

  let best: GodrollMatch | null = null;
  let count = 0;
  for (const row of rows) {
    const perks = row.perks.split('|');
    const lower = perks.map((p) => p.toLowerCase());
    if (!lower.every((p) => equipped.has(p) || selectable.has(p))) continue;
    if (!noteMatches(row.noteId)) continue;
    count++;
    const swap = perks
      .filter((_, i) => !equipped.has(lower[i]))
      .map((p) => `socket ${selectable.get(p.toLowerCase())} -> ${p}`);
    const match: 'equipped' | 'available' = swap.length ? 'available' : 'equipped';
    // Prefer a roll already plugged, then the most specific roll.
    const better = !best
      || (match === 'equipped' && best.match === 'available')
      || (match === best.match && perks.length > best.perks.length);
    if (better) {
      best = { match, perks, swap: swap.length ? swap : undefined, rollsMatched: 0, noteId: row.noteId };
    }
  }
  if (!best) return null;
  best.rollsMatched = count;
  const note = getNote(best.noteId);
  best.tags = note?.tags || undefined;
  best.source = note?.title || undefined;
  return best;
}

/* **** Building the index **** */

interface ParsedRoll {
  itemHash: number;
  /** Perk display names, deduplicated, sorted, pipe-separated. */
  perks: string;
  noteKey: string;
}

interface ParsedNote {
  title: string;
  text: string;
  tags: string;
}

/**
 * Parse a DIM wish list into deduplicated notes plus rolls keyed by perk NAME.
 *
 * Names, not hashes, because a crafted or enhanced weapon carries different hashes for the
 * same perks — but 300 of the 301 enhanced perks share their base perk's display name, and
 * the definitions carry no link back. Matching on names is what makes crafted rolls work.
 */
export function parseWishlist(
  text: string,
  perkName: (hash: number) => string,
): { rolls: ParsedRoll[]; notes: Map<string, ParsedNote> } {
  const notes = new Map<string, ParsedNote>();
  const rolls: ParsedRoll[] = [];
  const seen = new Set<string>();
  let title = '';
  // Raw note body, split into text/tags only once a roll consumes it: a wrapped note carries
  // its "|tags:" half on a continuation line, so splitting early would bury the tags in the prose.
  let pending: string | null = null;

  const remember = (n: ParsedNote) => {
    const k = [n.title, n.tags, n.text].join('\n');
    if (!notes.has(k)) notes.set(k, n);
    return k;
  };
  // "<prose>|tags:a b c" — the tag half is optional and always last.
  const splitNote = (body: string): ParsedNote => {
    const at = body.lastIndexOf('|tags:');
    return at < 0
      ? { title, text: body.trim(), tags: '' }
      : { title, text: body.slice(0, at).trim(), tags: body.slice(at + 6).trim() };
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { pending = null; continue; }

    if (line.startsWith('dimwishlist:')) {
      const m = /item=(-?\d+)&perks=([\d,]+)/.exec(line);
      if (!m) continue;
      const itemHash = Number(m[1]);
      if (itemHash < 0) continue; // trash list — the source ships none, so nothing consumes it
      const inline = line.indexOf('#notes:');
      const noteKey = remember(splitNote(inline >= 0 ? line.slice(inline + 7) : pending ?? ''));
      const perks = [...new Set(m[2].split(',').map((h) => perkName(Number(h))))].sort().join('|');
      const dedupe = [itemHash, perks, noteKey].join('\n');
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      rolls.push({ itemHash, perks, noteKey });
      continue;
    }

    if (line.startsWith('//notes:')) { pending = line.slice(8); continue; }
    if (line.startsWith('title:')) { title = line.slice(6).trim(); pending = null; continue; }
    if (line.startsWith('//') || line.startsWith('description:')) continue;

    // A bare line while a note is open is that note wrapping — 218 of them in voltron.txt.
    if (pending !== null) pending = `${pending} ${line}`;
  }
  return { rolls, notes };
}

export interface RebuildResult {
  rolls: number;
  notes: number;
  weapons: number;
  fetchedAt: string;
  source: string;
}

/** Download the wish list and rebuild data/wishlist.db. The old index stays live until it succeeds. */
export async function rebuildWishlist(): Promise<RebuildResult> {
  const res = await fetch(config.wishlistUrl);
  if (!res.ok) throw new Error(`Wish list download failed: HTTP ${res.status} from ${config.wishlistUrl}`);
  const text = await res.text();

  const names = new Map<number, string>();
  const perkName = (hash: number) => {
    if (!names.has(hash)) names.set(hash, defName('DestinyInventoryItemDefinition', hash));
    return names.get(hash)!;
  };
  const { rolls, notes } = parseWishlist(text, perkName);
  if (!rolls.length) throw new Error('Wish list parsed to zero rolls — refusing to replace the index');

  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = dbFile() + '.tmp';
  fs.rmSync(tmp, { force: true });
  const out = new Database(tmp);
  out.pragma('journal_mode = OFF');
  out.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, text TEXT, tags TEXT);
    CREATE TABLE rolls (itemHash INTEGER, perks TEXT, noteId INTEGER);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const ids = new Map<string, number>();
  const insertNote = out.prepare('INSERT INTO notes (id, title, text, tags) VALUES (?, ?, ?, ?)');
  const insertRoll = out.prepare('INSERT INTO rolls (itemHash, perks, noteId) VALUES (?, ?, ?)');
  const insertMeta = out.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const fetchedAt = new Date().toISOString();
  out.transaction(() => {
    let id = 0;
    for (const [k, n] of notes) {
      ids.set(k, ++id);
      insertNote.run(id, n.title, n.text, n.tags);
    }
    for (const r of rolls) insertRoll.run(r.itemHash, r.perks, ids.get(r.noteKey) ?? null);
  })();
  out.exec('CREATE INDEX rolls_item ON rolls(itemHash)');
  const weapons = (out.prepare('SELECT COUNT(DISTINCT itemHash) n FROM rolls').get() as any).n;
  for (const [k, v] of Object.entries({
    fetchedAt, source: config.wishlistUrl,
    rolls: String(rolls.length), notes: String(notes.size), weapons: String(weapons),
  })) insertMeta.run(k, v);
  out.close();

  db?.close();
  db = null;
  stmts = null;
  tried = false;
  fs.renameSync(tmp, dbFile());
  open();
  return { rolls: rolls.length, notes: notes.size, weapons, fetchedAt, source: config.wishlistUrl };
}

/** Rebuild in the background if the index is missing or stale. Never blocks startup. */
export function refreshWishlistIfStale(): void {
  const at = wishlistMeta().fetchedAt;
  const age = at ? Date.now() - Date.parse(at) : Infinity;
  if (age < config.wishlistMaxAgeMs) return;
  console.log(at ? 'Wish list is stale — refreshing in the background.' : 'Downloading DIM wish list (one-time)...');
  rebuildWishlist()
    .then((r) => console.log(`Wish list ready: ${r.rolls} rolls, ${r.weapons} weapons, ${r.notes} notes.`))
    .catch((e) => console.error('Wish list refresh failed (keeping the previous index):', e?.message ?? e));
}
