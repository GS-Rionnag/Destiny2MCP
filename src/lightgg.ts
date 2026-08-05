// light.gg community roll-popularity data. No official API — see docs/lightgg-api.md.
// Two things it uniquely has that the Bungie manifest does not: per-perk pick counts
// (how many players actually run each perk) and full trait-combo counts (the god rolls
// AND the rare long-tail combos). Armor gets archetype popularity instead.
//
// Same Cloudflare situation as mobalytics.ts: node's fetch gets a 403 challenge because
// Cloudflare fingerprints the TLS handshake, not cookies. node-tls-client speaks a real
// Chrome fingerprint, which is the only reason this works. The /full endpoint's body is
// additionally AES-128-CBC encrypted; key/IV below.
import { createDecipheriv } from 'node:crypto';
import { ClientIdentifier, initTLS, Session } from 'node-tls-client';

const ORIGIN = 'https://www.light.gg';

const HEADERS: Record<string, string> = {
  'sec-ch-ua-platform': '"Linux"',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  referer: `${ORIGIN}/`,
};

// Not every profile clears the challenge, and a passing one still gets challenged
// occasionally — retry across profiles, same as mobalytics.
const PROFILES = [ClientIdentifier.chrome_131, ClientIdentifier.firefox_133, ClientIdentifier.safari_16_0];

// AES-128-CBC key + IV for the /api/items/.../full response body. Extracted from
// webpack module 7760 of ItemDetail.bundle.js (`t.exports=JSON.parse('{"a":..,"b":..}')`,
// used as key=a, iv=b, algorithm AES-CBC). These CAN rotate on a light.gg redeploy — if
// decrypt starts throwing "bad decrypt", re-extract per the note in docs/lightgg-api.md.
const AES_KEY = Buffer.from('kqdGxkESDjvU9uKg');
const AES_IV = Buffer.from('sDUSyq4VE4csVVDQ');

let session: Promise<InstanceType<typeof Session>> | null = null;
let profile = 0;

async function getSession() {
  if (!session) {
    session = (async () => {
      await initTLS();
      return new Session({ clientIdentifier: PROFILES[profile] });
    })();
  }
  return session;
}

async function nextProfile() {
  profile = (profile + 1) % PROFILES.length;
  const old = session;
  session = null;
  try { (await old)?.close(); } catch { /* closing a dead session is not a failure */ }
}

export class LightggError extends Error {}

// GET returning text, retrying across TLS profiles when Cloudflare challenges.
async function lightggGet(url: string): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < PROFILES.length + 1; attempt++) {
    const s = await getSession();
    const res = await s.get(url, { headers: HEADERS });
    const text = await res.text();
    // Challenge pages are HTML; our endpoints are JSON, so a leading '<' means we were blocked.
    if (res.status === 403 || text.startsWith('<')) {
      last = `Cloudflare challenged the request (HTTP ${res.status})`;
      await nextProfile();
      continue;
    }
    if (res.status !== 200) throw new LightggError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }
  throw new LightggError(`${last} on every TLS profile — light.gg is refusing automated requests right now.`);
}

// Like lightggGet but for endpoints that legitimately return HTML (so a leading '<' is
// content, not a challenge). Only a real Cloudflare interstitial is retried.
async function lightggGetHtml(url: string): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < PROFILES.length + 1; attempt++) {
    const s = await getSession();
    const res = await s.get(url, { headers: { ...HEADERS, accept: 'text/html' } });
    const text = await res.text();
    if (res.status === 403 || text.includes('Just a moment')) { last = `Cloudflare challenged (HTTP ${res.status})`; await nextProfile(); continue; }
    if (res.status !== 200) throw new LightggError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  }
  throw new LightggError(`${last} on every TLS profile.`);
}

// ---------------------------------------------------------------------------
// Full DB filter search. The /db/all/ "More Filters" form POSTs fs.* fields; the
// server compiles them into an ?f=<code>(<value>)... query and 302-redirects to it.
// Appending &raw=1 to that URL returns a plain JSON array of every matching item hash
// (all of them — raw ignores the page). We drive the POST -> follow -> raw chain so we
// never have to hardcode the server's field codes: fs.* names are the stable contract.

const FORM_HEADERS = { ...HEADERS, origin: ORIGIN, referer: `${ORIGIN}/db/all/`, 'content-type': 'application/x-www-form-urlencoded' };
const locOf = (h: any): string | undefined => { const l = h?.location ?? h?.Location; return Array.isArray(l) ? l[0] : l; };

// POST the filter form, follow the compile+normalize redirect chain, return matching hashes.
async function dbSearchOnce(body: string): Promise<number[]> {
  const s = await getSession();
  const post = await s.post(`${ORIGIN}/db/all/`, { headers: FORM_HEADERS, body });
  const text = await post.text();
  if (post.status === 403 || (post.status !== 302 && text.startsWith('<') && text.includes('challenge'))) {
    throw new LightggError('challenged');
  }
  let loc = locOf(post.headers);
  if (!loc) throw new LightggError(`light.gg /db/all/ did not redirect (HTTP ${post.status}).`);
  // The compiled f=code(value) keeps ()/, literal but leaves spaces in text values raw,
  // which 400s when we re-request it — encode just the spaces. The URL can also 302 once
  // more to drop empty filter slots, so follow a few hops.
  let url = (ORIGIN + loc).replace(/ /g, '%20');
  for (let hop = 0; hop < 5; hop++) {
    const r = await s.get(url.includes('raw=1') ? url : `${url}&raw=1`, { headers: { ...HEADERS } });
    if (r.status === 200) return JSON.parse(await r.text());
    const next = locOf(r.headers);
    if (!next) throw new LightggError(`light.gg DB search failed (HTTP ${r.status}).`);
    url = (ORIGIN + next).replace(/ /g, '%20');
  }
  throw new LightggError('light.gg DB search redirected too many times.');
}

// "New items" — light.gg's per-release collections (/db/new-items/<release>/<sub>/).
// Each such page supports ?raw=1 and returns a plain array of item hashes, exactly like
// /db/all/. The release/subcategory slugs rotate every season, so we scrape the current
// set from the /db/ nav rather than hardcoding them.
export type NewItemCategory = { path: string; release: string; sub?: string; label: string };

export async function newItemCategories(): Promise<NewItemCategory[]> {
  const html = await lightggGetHtml(`${ORIGIN}/db/`);
  const seen = new Map<string, NewItemCategory>();
  const re = /href="\/db\/new-items\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/"[^>]*>\s*(?:<strong>)?([^<]+)/g;
  for (let m; (m = re.exec(html)); ) {
    const [, release, sub, label] = m;
    const path = sub ? `${release}/${sub}` : release;
    if (!seen.has(path)) seen.set(path, { path, release, sub, label: label.trim() });
  }
  return [...seen.values()];
}

export async function newItems(category: string): Promise<number[]> {
  const path = category.replace(/^\/|\/$/g, ''); // tolerate leading/trailing slashes
  const text = await lightggGet(`${ORIGIN}/db/new-items/${path}/?raw=1`);
  return JSON.parse(text);
}

export async function dbSearchLightgg(body: string): Promise<number[]> {
  for (let attempt = 0; attempt < PROFILES.length + 1; attempt++) {
    try {
      return await dbSearchOnce(body);
    } catch (e) {
      if (e instanceof LightggError && e.message === 'challenged') { await nextProfile(); continue; }
      throw e;
    }
  }
  throw new LightggError('light.gg challenged the DB search on every TLS profile.');
}

// Semantic item facets -> the fs.* form values light.gg accepts, then the search. Keeps the
// fs.* vocab in one place so callers pass human values. name matches item name AND description.
const FACET = {
  class: { titan: '0', hunter: '1', warlock: '2' },
  rarity: { exotic: '6', legendary: '5', rare: '4', common: '3', basic: '2' },
  ammo: { primary: '1', special: '2', heavy: '3' },
  breaker: { 'shield-piercing': '1', disruption: '2', stagger: '3' },
  foundry: { suros: '1', omolon: '2', hakke: '3', veist: '4', fotc: '5', 'field-forged': '6', 'tex-mechanica': '7', daito: '8', cassoid: '9' },
  slot: { weapons: 'w', kinetic: '0w', energy: '1w', power: '2w', armor: 'a', helmet: '0a', gauntlets: '1a', chest: '2a', legs: '3a', 'class-item': '4a' },
} as const;

export type ItemFacets = {
  name?: string;
  class?: keyof typeof FACET.class;
  slot?: keyof typeof FACET.slot;
  rarity?: keyof typeof FACET.rarity;
  ammo?: keyof typeof FACET.ammo;
  breaker?: keyof typeof FACET.breaker;
  foundry?: keyof typeof FACET.foundry;
  season?: number;
  craftable?: boolean; enhanceable?: boolean; deepsight?: boolean; hasLore?: boolean;
};

export const FACET_VALUES = {
  class: Object.keys(FACET.class), slot: Object.keys(FACET.slot), rarity: Object.keys(FACET.rarity),
  ammo: Object.keys(FACET.ammo), breaker: Object.keys(FACET.breaker), foundry: Object.keys(FACET.foundry),
} as const;

export async function browseItems(f: ItemFacets): Promise<number[]> {
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  if (f.name) add('fs.Name', f.name);
  if (f.class) add('fs.Classes', FACET.class[f.class]);
  if (f.slot) add('fs.Slots', FACET.slot[f.slot]);
  if (f.rarity) add('fs.Tiers', FACET.rarity[f.rarity]);
  if (f.ammo) add('fs.AmmoTypes', FACET.ammo[f.ammo]);
  if (f.breaker) add('fs.BreakerTypes', FACET.breaker[f.breaker]);
  if (f.foundry) add('fs.Foundries', FACET.foundry[f.foundry]);
  if (f.season) add('fs.Seasons', String(f.season));
  if (f.craftable) add('fs.IsCraftable', 'true');
  if (f.enhanceable) add('fs.IsEnhanceable', 'true');
  if (f.deepsight) add('fs.CanBeDeepsight', 'true');
  if (f.hasLore) add('fs.HasLore', 'true');
  if (!parts.length) throw new LightggError('Pass at least one facet.');
  return dbSearchLightgg(parts.join('&'));
}

// ---------------------------------------------------------------------------
// Search: name substring -> item summary (hash, type, base stats). Not a filter
// engine — multi-word / grammar queries return []. Use it to resolve a name to a hash.

export type LightggSearchItem = {
  Name: string;
  ItemHash: number;
  Tier: number;
  ItemTypeDisplayName: string;
  Slot: number;
  DamageType: number;
  AmmoType: number;
  IsWeapon: boolean;
  IsArmor: boolean;
  Stats: { StatHash: number; Value: number }[];
};

const searchCache = new Map<string, LightggSearchItem[]>();

export async function searchLightgg(name: string): Promise<LightggSearchItem[]> {
  const key = name.trim().toLowerCase();
  const hit = searchCache.get(key);
  if (hit) return hit;
  const text = await lightggGet(`${ORIGIN}/db/search/autocomplete/?q=${encodeURIComponent(name)}&raw=1`);
  const items: LightggSearchItem[] = JSON.parse(text);
  searchCache.set(key, items);
  return items;
}

// Resolve a name or numeric hash to a hash. Exact name wins over a longer item that
// merely contains it ("Sunshot" over "Sunshot Catalyst").
export async function resolveLightggHash(nameOrHash: string | number): Promise<number> {
  if (typeof nameOrHash === 'number') return nameOrHash;
  if (/^\d+$/.test(nameOrHash)) return Number(nameOrHash);
  const items = await searchLightgg(nameOrHash);
  if (!items.length) throw new LightggError(`No Destiny item matches "${nameOrHash}" on light.gg.`);
  const q = nameOrHash.trim().toLowerCase();
  const exact = items.find((i) => i.Name.toLowerCase() === q);
  return (exact ?? items[0]).ItemHash;
}

// ---------------------------------------------------------------------------
// Loadouts DB. The /loadouts/db/ page inlines all results and weighs ~36 MB (that's the
// lag). The site's own AJAX list endpoint returns a light ~500 KB HTML fragment instead:
//   GET /loadouts/load/?f=<code>(<val>;<val>),...&page=N   (X-Requested-With: XMLHttpRequest)
// Filter grammar is the same ?f=code(value) shape as /db/all/. Codes are the loadout
// filter FilterNums: 1 Mode, 2 Class, 3 Subclass, 5 Weapons, 7 Exotic Armor, 10 Weapon
// Type, 11 Season, 12 Activity, 19 Score-range (min;max). Results are ordered newest-first
// — the order is NOT controllable, so "good/skilled" is a matter of filtering (a hard
// activity + a high min score), not sorting.

export type LoadoutCard = {
  id: number; votes: number; title?: string; subclass?: string; activity?: string;
  date?: string; duration?: string; score?: string; author?: string; pgcr?: string;
};

const cardField = (re: RegExp, s: string) => { const m = s.match(re); return m ? m[1].trim() : undefined; };

function parseLoadoutCards(html: string): { total: number; cards: LoadoutCard[] } {
  const total = Number(cardField(/build-list-result-count"\s*value="([^"]*)"/, html) ?? '0');
  const cards = html.split('<div class="build">').slice(1).map((c): LoadoutCard => {
    const title = cardField(/target="_blank">([^<]+)</, c);
    // Title reads "<Subclass> Loadout for <activity> by <author>" — the subclass leads it.
    const subclass = title ? cardField(/^(.*?)\s+Loadout for /, title) : undefined;
    return {
      id: Number(cardField(/vote-controls"\s+data-id="(\d+)"/, c) ?? '0'),
      votes: Number(cardField(/data-id="\d+">[\s\S]*?<span>(-?\d+)<\/span>/, c) ?? '0'),
      title, subclass,
      activity: cardField(/fa-rocket"><\/i>\s*([^<]+)</, c),
      date: cardField(/fa-calendar"><\/i>\s*([^<]+)</, c),
      duration: cardField(/fa-clock-o"><\/i>\s*([^<]+)</, c),
      score: cardField(/hundred-points"><\/i>\s*([^<]+)</, c),
      author: cardField(/fa-user"><\/i>\s*([^<]+)</, c),
      pgcr: cardField(/PGCR\/(\d+)/, c),
    };
  });
  return { total, cards };
}

export async function browseLoadouts(fstr: string, page = 1): Promise<{ total: number; page: number; cards: LoadoutCard[] }> {
  const qs = `${fstr ? `f=${fstr}&` : ''}page=${page}`;
  // The list endpoint is XHR-gated; without the header it returns the 36 MB shell.
  let last = '';
  for (let attempt = 0; attempt < PROFILES.length + 1; attempt++) {
    const s = await getSession();
    const res = await s.get(`${ORIGIN}/loadouts/load/?${qs}`, { headers: { ...HEADERS, accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' } });
    const html = await res.text();
    if (res.status === 403 || (!html.includes('build-list-result-count') && html.includes('challenge'))) {
      last = `Cloudflare challenged the request (HTTP ${res.status})`; await nextProfile(); continue;
    }
    if (res.status !== 200) throw new LightggError(`HTTP ${res.status}: ${html.slice(0, 200)}`);
    return { ...parseLoadoutCards(html), page };
  }
  throw new LightggError(`${last} on every TLS profile.`);
}

// One loadout's full gear. /loadouts/<id>/export embeds the DIM loadout object inside a
// dim.gg import link (?loadout=<form-encoded JSON>); decode it out.
export type DimLoadout = {
  id: string; name: string; classType: number; notes?: string;
  equipped: { hash: number; socketOverrides?: Record<string, number> }[];
  unequipped?: { hash: number }[];
  parameters?: { mods?: number[]; statConstraints?: { statHash: number; minTier?: number; maxTier?: number }[]; [k: string]: unknown };
};

export async function getLoadout(id: number): Promise<DimLoadout> {
  // The export is a full HTML page (not JSON), so fetch it directly rather than via
  // lightggGet, which treats a leading '<' as a Cloudflare challenge.
  let html = '';
  for (let attempt = 0; attempt < PROFILES.length + 1; attempt++) {
    const s = await getSession();
    const res = await s.get(`${ORIGIN}/loadouts/${id}/export`, { headers: { ...HEADERS, accept: 'text/html' } });
    html = await res.text();
    if (res.status === 403 || html.includes('Just a moment')) { await nextProfile(); continue; }
    if (res.status !== 200) throw new LightggError(`HTTP ${res.status} for loadout ${id}.`);
    break;
  }
  const start = html.indexOf('%7b%22id%22%3a%22'); // encoded {"id":"
  if (start < 0) throw new LightggError(`No exportable loadout found for ${id}.`);
  const end = html.indexOf('"', start); // the real quote closing the ?loadout= attribute
  const decoded = decodeURIComponent(html.slice(start, end).replace(/\+/g, ' '));
  let depth = 0, out = '';
  for (const ch of decoded) { out += ch; if (ch === '{') depth++; else if (ch === '}' && --depth === 0) break; }
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// Item community data: fetch /full, AES-decrypt, shape the popularity numbers.
// All perk/archetype hashes are unsigned manifest hashes — resolve names with
// defName('DestinyInventoryItemDefinition', hash) at the tool layer.

type RawPerkStat = { PerkHash: number; PerkEnhancedHash: number | null; Count: number; Rank: number; PerkIDX: number; Show: boolean };
type RawCombo = { Perk4Hash: number; Perk4EnhancedHash: number | null; Perk5Hash: number; Perk5EnhancedHash: number | null; Count: number; Show: boolean };

export type PerkPopularity = { perkHash: number; enhancedHash?: number; count: number; pct: number; rank: number };
export type TraitCombo = { perks: [number, number]; enhancedHashes: [number | null, number | null]; count: number; pct: number };

export type LightggItem = {
  hash: number;
  name: string;
  type: string;
  tier: number;
  isWeapon: boolean;
  isArmor: boolean;
  craftable: boolean;
  hasRandomRolls: boolean;
  // Per random-perk column, the perks players actually run, most-popular first, with %.
  perkColumns: PerkPopularity[][];
  // The two trait columns paired: god rolls at the top, the rare long-tail at the bottom.
  traitCombos: TraitCombo[];
  // Every perk the item CAN roll, per column (from the item's random-roll pool).
  rollPool: number[][];
  // Armor only: archetype popularity ranks (higher = more used). Empty for weapons.
  armorArchetypes: { archetypeHash: number; rank: number }[];
};

function decryptFull(bodyText: string): any {
  let enc: Buffer;
  try {
    enc = Buffer.from(JSON.parse(bodyText), 'base64');
  } catch {
    throw new LightggError('light.gg /full returned an unexpected (non-encrypted) body.');
  }
  try {
    const d = createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch {
    throw new LightggError('light.gg decryption failed — the AES key likely rotated; see docs/lightgg-api.md to re-extract.');
  }
}

// Show:true rows are the real perks; Show:false/PerkIDX:-1 are enhanced dupes folded
// into the same Count. Percent is share of the column's total picks.
function perkColumn(col: RawPerkStat[]): PerkPopularity[] {
  const real = col.filter((p) => p.Show);
  const total = real.reduce((a, p) => a + p.Count, 0) || 1;
  return real
    .sort((a, b) => b.Count - a.Count)
    .map((p) => ({
      perkHash: p.PerkHash,
      enhancedHash: p.PerkEnhancedHash ?? undefined,
      count: p.Count,
      pct: Math.round((1000 * p.Count) / total) / 10,
      rank: p.Rank,
    }));
}

// Pull the per-column perk-hash pool out of Item.RandomRolls (shape varies a little by
// item; be defensive and just collect whatever perk hashes each column lists).
function rollPool(randomRolls: any): number[][] {
  if (!Array.isArray(randomRolls)) return [];
  return randomRolls.map((col: any) => {
    const perks = Array.isArray(col) ? col : (col?.Perks ?? col?.perks ?? col?.Items ?? []);
    return (Array.isArray(perks) ? perks : [])
      .map((p: any) => (typeof p === 'number' ? p : p?.PerkHash ?? p?.ItemHash ?? p?.Hash))
      .filter((h: any): h is number => typeof h === 'number');
  });
}

export async function getLightggItem(nameOrHash: string | number): Promise<LightggItem> {
  const hash = await resolveLightggHash(nameOrHash);
  const body = await lightggGet(`${ORIGIN}/api/items/en/${hash}/full`);
  const full = decryptFull(body);
  const item = full.Item ?? {};

  const perkColumns = (full.PerkStats ?? []).map(perkColumn).filter((c: PerkPopularity[]) => c.length);

  const combos: RawCombo[] = [...(full.TraitCombos ?? [])].sort((a, b) => b.Count - a.Count);
  const topCount = combos[0]?.Count || 1;
  const traitCombos: TraitCombo[] = combos.map((c) => ({
    perks: [c.Perk4Hash, c.Perk5Hash],
    enhancedHashes: [c.Perk4EnhancedHash, c.Perk5EnhancedHash],
    count: c.Count,
    pct: Math.round((1000 * c.Count) / topCount) / 10,
  }));

  const arch = full.ArmorArchetypeStats?.ByArchetype ?? {};
  const armorArchetypes = Object.values(arch)
    .map((a: any) => ({ archetypeHash: a.ArchetypeHash, rank: a.Rank }))
    .sort((a, b) => b.rank - a.rank);

  return {
    hash,
    name: item.Name ?? String(hash),
    type: item.ItemTypeDisplayName ?? '',
    tier: item.Tier ?? 0,
    isWeapon: perkColumns.length > 0 || !!item.HasRandomRolls,
    isArmor: armorArchetypes.length > 0,
    craftable: !!item.IsCraftable,
    hasRandomRolls: !!item.HasRandomRolls,
    perkColumns,
    traitCombos,
    rollPool: rollPool(item.RandomRolls),
    armorArchetypes,
  };
}
