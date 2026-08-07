# light.gg community data API (reverse-engineered 2026-08-05)

light.gg has no official API. This doc is the map: how to reach it past Cloudflare,
which endpoints exist, and — the whole point — how to decrypt and read the
**community roll-popularity data** that light.gg is the only place to get.

That community layer is what the Bungie manifest cannot give you: for every weapon,
how many players actually rolled each perk, and which full perk *combinations* they
run — including the rare long-tail combos ("only 23 people run this") that reward
hours of digging. For armor, which archetypes the community actually builds into.

## What light.gg uniquely has (and the manifest does not)

| Data | Source | Why it matters |
|---|---|---|
| Per-perk pick counts, per column | `/api/items/en/{hash}/full` → `PerkStats` | real usage %, not editorial opinion |
| Full trait-combo counts (col3 × col4) | same → `TraitCombos` | the actual god rolls **and** the weird rare ones |
| Curated vs random roll pool | same → `Item.CuratedRolls` / `RandomRolls` | every perk an item *can* roll |
| Armor archetype popularity | same → `ArmorArchetypeStats` | which armor archetypes/sets people build |
| Masterwork / mod options | same → `MWPlugs` / `Mods` | full customization surface |

Base stats, names, damage/ammo type, tier also come back, so a single call is
self-contained — you don't strictly need the manifest to read it, though perk
*hashes* still resolve to names via the manifest (or `Item.Localized`).

## Access: getting past Cloudflare

Every light.gg host sits behind Cloudflare's managed-challenge. Plain `fetch`/curl
gets `403 "Just a moment..."`. Cloudflare fingerprints the **TLS/HTTP2 handshake**
(JA3), not cookies — a `cf_clearance` cookie copied from a browser still 403s.

| Thing | Required? |
|---|---|
| Browser-like TLS fingerprint | **Yes** — the only hard requirement |
| Login / auth token | No, for everything in this doc |
| Cookies | No |
| Browser headers (UA, sec-ch-ua, referer) | Recommended; helps but TLS is what counts |

Working clients: **`node-tls-client`** (what this repo uses — see `src/lightgg.ts`
and the identical trick in `src/mobalytics.ts`), `curl_cffi` (`impersonate="chrome"`),
curl-impersonate, or a real Chrome via Playwright (`channel: "chrome"`).
Headless Playwright without the real Chrome channel gets stuck on the Turnstile
checkbox — don't bother. All three `node-tls-client` profiles (chrome_131,
firefox_133, safari_16_0) pass; rotate on the occasional 403, same as mobalytics.

Site config (from any page's inline `<script>`): `apiRoot = 'www.light.gg/api'`,
`apiKey = 'd4ea1e95b5394ffdb46908af0275f324'`. The apiKey is **not** needed for the
read endpoints below.

## Endpoints

### 1. Item search / name → hash  (clean JSON, no decryption)

```
GET https://www.light.gg/db/search/autocomplete/?q=<name>&raw=1
Accept: application/json
```

Name **substring** match only (multi-word queries and filter grammar like
`is:weapon` return `[]` — this is a resolver, not a filter engine). Returns an
array; each element:

```jsonc
{
  "Name": "Likely Suspect",
  "ItemHash": 1994645182,
  "Tier": 5,                      // 5 = Legendary, 6 = Exotic
  "ItemTypeDisplayName": "Fusion Rifle",
  "Slot": 1,                      // bucket
  "DamageType": 3, "AmmoType": 1,
  "IsWeapon": true, "IsArmor": false,
  "Stats": [ { "StatHash": 155624089, "Value": 31, "Minimum": 0, "Maximum": 0 }, ... ],
  "DefaultSockets": [ ... ],
  "IconPath": "/common/destiny2_content/icons/....jpg"
}
```

To discover items by *criteria* (type, element, perk), filter the **local Bungie
manifest** this repo already loads (`src/manifest.ts`), then pull light.gg per hash
for the community layer. light.gg's own advanced filter (`is:weapon perk:x`) runs
client-side over a downloaded index — there is no server JSON for it.

### 2. Full DB filter search  (the "More Filters" panel → matching item hashes)

The `/db/all/` "More Filters" form is a server-side filter engine over the entire item
database. It is a **POST** of `fs.*` fields; the server compiles them into a
`?f=<code>(<value>)…` query and **302-redirects** to it. Add **`&raw=1`** to that URL
and you get a plain JSON array of **every** matching item hash (raw ignores paging).

```
POST https://www.light.gg/db/all/
Content-Type: application/x-www-form-urlencoded
Body: fs.Classes=1&fs.Slots=0w&fs.Tiers=5        # AND across fields

→ 302 Location: /db/all/?page=1&f=6(1),8(0),4(5)
GET https://www.light.gg/db/all/?page=1&f=6(1),8(0),4(5)&raw=1
→ [2815819177, 2400936607, ...]                  # all matching item hashes
```

**Drive the POST → follow redirect → GET `raw=1` chain** rather than hardcoding the
server's `f=` codes — the `fs.*` field names are the stable contract, the codes are
not. Two gotchas the client handles: the compiled URL may 302 once more to drop empty
filter slots (follow a couple hops), and a **space** in a text value is left raw in the
`Location` (encode spaces to `%20` or you get HTTP 400).

`fs.*` fields and their accepted values (all multi-select unless noted; repeat the field
for multiple values, which AND within light.gg's compiler):

| Field | Values |
|---|---|
| `fs.Name` (text) | item **name or description** substring |
| `fs.Classes` | `0` Titan, `1` Hunter, `2` Warlock |
| `fs.Slots` | buckets `w` Weapons / `a` Armor / `c` Cosmetic; weapon slots `0w` Kinetic, `1w` Energy, `2w` Power; armor `0a` Helmet, `1a` Gauntlets, `2a` Chest, `3a` Legs, `4a` Class Item |
| `fs.Tiers` (rarity) | `6` Exotic, `5` Legendary, `4` Rare, `3` Common, `2` Basic, `1` Currency |
| `fs.AmmoTypes` | `1` Primary, `2` Special, `3` Heavy |
| `fs.BreakerTypes` | `1` Shield-Piercing, `2` Disruption, `3` Stagger |
| `fs.Foundries` | `1` SUROS, `2` Omolon, `3` Hakke, `4` VEIST, `5` FOTC, `6` Field Forged, `7` Tex Mechanica, `8` Daito, `9` Cassoid |
| `fs.Seasons` | season number `1`–`29` (current) |
| `fs.IsCraftable` / `fs.IsEnhanceable` / `fs.CanBeDeepsight` / `fs.HasLore` / `fs.IsEquippable` / `fs.IsRecipe` | `true` |
| `power-cap-min` / `power-cap-max` | numbers |
| `fs.RawFilters` | free-form light.gg query text |

Resolve the returned hashes to names/types via the Bungie manifest
(`DestinyInventoryItemDefinition`). This backs the facet mode of the `search_items` tool
(`browseItems()` in `src/lightgg.ts`); the tool's `query` mode routes to the manifest for
perk:/stat: filters light.gg can't express.

### 2b. New Items collections  (what's new this season)

light.gg's `/db/new-items/` pages group each release's newly-added items. Same trick as
`/db/all/`: append `?raw=1` to get a JSON array of item hashes.

```
GET https://www.light.gg/db/new-items/<release>/<subcategory>/?raw=1   → [hash, …]
```

`<release>` and `<subcategory>` slugs **rotate every season** (e.g. `renegades`,
`monument-of-triumph`; subcats `new-weapons`, `new-exotics`, `raid-gear`,
`craftable-weapons`, `trials-gear`, `new-armor`, …). Don't hardcode them — scrape the
current set from the `/db/` page nav:

```
GET /db/  →  href="/db/new-items/<release>/<subcategory>/">Label
```

`<release>` alone (no subcategory) returns that whole release's new items. Resolve hashes
via the manifest; reissues repeat under several hashes, so dedupe by name+type. This is
the `new_items` tool.

### 3. Item community data  (encrypted JSON — the crown jewel)

```
GET https://www.light.gg/api/items/en/<itemHash>/full
Accept: application/json
# optional: ?version=<versionHash> for a specific reissue
```

Body is a JSON **string**: base64 of an **AES-128-CBC** ciphertext.

**Key/IV** (extracted from webpack module 7760, referenced by `ItemDetail.bundle.js`
as `const u=r.a, c=r.b`; algorithm is `AES-CBC`, key `importKey('raw', TextEncoder(u))`):

```
key = "kqdGxkESDjvU9uKg"   (16 ASCII bytes → AES-128)
iv  = "sDUSyq4VE4csVVDQ"   (16 ASCII bytes)
```

Decrypt → UTF-8 → `JSON.parse`. Node:

```js
import { createDecipheriv } from 'node:crypto';
const key = Buffer.from('kqdGxkESDjvU9uKg'), iv = Buffer.from('sDUSyq4VE4csVVDQ');
function decryptFull(bodyText) {          // bodyText = the response text (a JSON string)
  const enc = Buffer.from(JSON.parse(bodyText), 'base64');
  const d = createDecipheriv('aes-128-cbc', key, iv);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
}
```

> **Key rotation.** The key/IV live in a JS chunk and *can* change on a light.gg
> redeploy. If decryption ever throws `bad decrypt`, re-extract: fetch any item page,
> find the `ItemDetail.bundle.js?v=...` it references, and in it locate the tiny
> webpack module whose source is `t.exports=JSON.parse('{"a":"...","b":"..."}')` —
> `a` is the key, `b` the IV. `src/lightgg.ts` keeps them in one constant for exactly
> this reason.

#### Decrypted shape (top-level keys)

```
Item  MWPlugs  MWStats  MWUseStats  ModStats  PerkStats  TraitCombos
Mods  Stats  AllStats  CraftingObjectives  DeepsightObjectives
Localization  ArmorSetStats  ArmorArchetypeStats
```

**`PerkStats`** — array of columns (one per random-perk socket; a fusion has 5:
barrel, battery, trait-1, trait-2, origin). Each column is a list of perk rows:

```jsonc
{
  "ItemHash": 1994645182,
  "PerkHash": 839105230,          // the perk (resolve name via manifest)
  "PerkEnhancedHash": 3048246338, // enhanced variant, or null
  "Count": 3633,                  // how many scanned rolls have this perk in this column
  "Rank": 1,                      // popularity rank within the column
  "PerkIDX": 2,                   // socket column index this perk belongs to
  "Show": true                    // true = a real selectable perk row; ...
}
```

Rows with `Show:false` / `PerkIDX:-1` are enhanced-variant duplicates folded into the
same `Count` — **filter to `Show:true`** to get the real perks. Popularity % for a
perk = `Count / Σ Count of the Show:true rows in its column`.

**`TraitCombos`** — the full pairwise popularity of the two trait columns (col3 ×
col4). ~256 rows even for one weapon: this is where god rolls **and** the rare combos
live.

```jsonc
{
  "Perk4Hash": 3920370755,          // trait column 3 perk
  "Perk4EnhancedHash": null,
  "Perk5Hash": 2652708987,          // trait column 4 perk
  "Perk5EnhancedHash": 617966211,
  "Count": 2583,                    // rolls running this exact pair
  "Show": false
}
```

Sort by `Count` desc for god rolls; the tail (e.g. `Count:23`) is the "only someone
with hours finds this" territory. Divide by the top combo's count for a relative
popularity.

**`Item`** — self-contained item summary, no manifest needed for the basics:

```
ItemHash  Name  Description  ItemTypeDisplayName  Tier  IconPath  IconPaths
IsCraftable  HasEnhancedPerks  IsAdept  IsHolofoil  HasRandomRolls
Localized              // localized display strings
SocketCategories       // socket layout
Intrinsics             // intrinsic/frame perk(s)
CuratedRolls           // the curated (vendor) roll perk pool, per column
RandomRolls            // the full random-roll perk pool, per column
```

`CuratedRolls`/`RandomRolls` give **every perk the item can roll** — pair with
`PerkStats` counts to see pool vs. what people actually use.

**`Stats`** / **`AllStats`** — stat definitions (`Hash`, `Name`, `SortOrder`,
`ShowNumeric`, `IsHidden`). Numeric base values come from the search endpoint's
`Stats[]` or the manifest.

**`Mods`** (array) and **`MWPlugs`** (array) — every insertable mod and every
masterwork option for the item (`ItemHash`, `Name`, `ImageURL`, stat deltas).

**`ArmorArchetypeStats`** — armor only (weapons return empties here). Popularity of
armor archetypes; weapons' `PerkStats`/`TraitCombos` are the equivalent for guns.

```jsonc
"ArmorArchetypeStats": {
  "ByArchetype":            { "351770835": { "ArchetypeHash": 351770835, "Rank": 5.358 }, ... },
  "ByArchetypeClass":       { ... },   // split by class
  "BySetArchetype":         { ... },   // armor 3.0 set + archetype
  "BySetClassArchetype":    { ... },
  "BySetArchetypeTertiary": { ... },
  "BySetClassArchetypeTertiary": { ... }
}
```

`Rank` is a popularity score (higher = more used). Resolve `ArchetypeHash` via the
manifest. Armor pieces have no random perks, so their `PerkStats` columns are empty —
the archetype ranks are the community signal.

### 4. Loadouts DB  (real loadouts captured from players' runs)

`/loadouts/db/` inlines every result and weighs **~36 MB** — that is the page lag. The
site's own AJAX list endpoint returns a light **~500 KB** HTML fragment instead:

```
GET https://www.light.gg/loadouts/load/?f=<code>(<val>;<val>),…&page=N
X-Requested-With: XMLHttpRequest        # without it you get the 36 MB shell
```

Same `?f=code(value)` grammar as `/db/all/`; codes here are the loadout filter FilterNums:

| Code | Filter | Values |
|---|---|---|
| 1 | Mode | 5 Any PVP, 7 Any PVE, 3 Strikes, 69 Competitive, 84 Trials, 87 Solo Lost Sectors |
| 2 | Class | 0 Titan, 1 Hunter, 2 Warlock |
| 3 | Subclass | subclass definition hash |
| 5 | Weapons | weapon item hash |
| 7 | Exotic Armor | armor item hash |
| 10 | Weapon Type | — |
| 11 | Season | season number |
| 12 | Activity | activity definition hash |
| 19 | Score | **range** `min;max` (both bounds required) |

Filters AND together (`f=2(1),1(84)` = Hunter **and** Trials). The response fragment
holds 20 cards; `<input id="build-list-result-count" value="N">` is the total, `&page=N`
pages. Each `<div class="build">` card carries: `data-id` (loadout id) + upvotes, the
title (`"<Subclass> Loadout for <activity> by <author>"`), activity, date/season,
duration, score (`10.15K / 42.12K` = personal / team), author, and the PGCR id.

**No sort.** Order is always newest-first and most loadouts have 0 votes — there is no
"popular" query. Surface skilled play by *filtering*: a hard mode/activity **plus** a
high `19(minScore;…)`. Note score scale differs by mode (PVE ≈ tens of thousands; Trials
is rounds won, ≈0–7), so a PVE minScore returns nothing on Trials.

**One loadout's gear:**

```
GET https://www.light.gg/loadouts/<id>/export
```

A full HTML page that embeds the **DIM loadout JSON** inside a `dim.gg?loadout=<…>`
import link (form-encoded: `%`-escaped with `+` for space). Find the encoded `{"id":"…`,
slice to the next real `"`, `decodeURIComponent(x.replace(/\+/g,' '))`, brace-balance,
`JSON.parse`. Shape:

```jsonc
{
  "id": "...", "name": "[LGG] …", "classType": 1, "notes": "",
  "equipped": [ { "hash": 4293613902, "socketOverrides": { "<socketIndex>": <plugHash> } } ],
  "unequipped": [ … ],
  "parameters": { "mods": [<hash>…], "modsByBucket": {…}, "statConstraints": [ { "statHash": …, "minTier": … } ] }
}
```

`equipped` hashes resolve to weapon/armor names via the manifest; the subclass item's
`socketOverrides` are its super/abilities/aspects/fragments. Gear is exact (it is a real
run), but random-roll perk detail can be sparse. This is `search_lightgg_builds` + `get_lightgg_build`.

### 5. HTML fallback (no decryption, if the key ever breaks)

`GET /db/items/<hash>/<slug>/` (301 from `/db/items/<hash>/`) renders the same data
into HTML, ~300 KB/item:

- `#community-average` → `<li>` per perk: `.percent` text, `.item[data-id=<perkHash>]`,
  `img[alt=<perkName>]`, grouped into columns (`ul.sockets`).
- `.combo-percent` blocks ("15.94% of Rolls") with `.perk-names` → top trait combos.
- inline `var rollData.RecommendedPerks = [[{Item1:<perkHash>, Item2:"pve"|"pvp"|""}, ...], ...]`
  → light.gg's *recommended* god-roll perks per column, tagged PvE/PvP.

Prefer the encrypted endpoint (raw counts, full 256-combo tail, armor archetypes);
keep this as the documented backup.

## Other endpoints seen in the bundle (not needed for research)

Account/inventory (need Bungie OAuth): `/account/whoami/`, `/dim/tags/`,
Bungie proxy under the manifest section. Social: `/comments/`, `/review/`, `/vote/`,
`/report/`. Manifest: `/manifest/table/`, `/manifest/seasonmap`, `/season/list`.
Leaderboards: `/leaderboard/update` (POST, auth). None add research value beyond the
item endpoints above.

## Worked example (Node, using this repo's TLS client)

```js
import { ClientIdentifier, initTLS, Session } from 'node-tls-client';
import { createDecipheriv } from 'node:crypto';

const KEY = Buffer.from('kqdGxkESDjvU9uKg'), IV = Buffer.from('sDUSyq4VE4csVVDQ');
const H = { 'user-agent': 'Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36',
            accept: 'application/json', referer: 'https://www.light.gg/' };

await initTLS();
const s = new Session({ clientIdentifier: ClientIdentifier.chrome_131 });

// 1. resolve a name
const found = await (await s.get(
  'https://www.light.gg/db/search/autocomplete/?q=likely%20suspect&raw=1', { headers: H })).json();
const hash = found[0].ItemHash;                                   // 1994645182

// 2. pull + decrypt the community data
const body = await (await s.get(
  `https://www.light.gg/api/items/en/${hash}/full`, { headers: H })).text();
const d = createDecipheriv('aes-128-cbc', KEY, IV);
const full = JSON.parse(Buffer.concat(
  [d.update(Buffer.from(JSON.parse(body), 'base64')), d.final()]).toString('utf8'));

// 3. read the community signal
const col = full.PerkStats[2].filter(p => p.Show);               // trait column 1
const tot = col.reduce((a, p) => a + p.Count, 0);
col.sort((a, b) => b.Count - a.Count)
   .forEach(p => console.log(p.PerkHash, (100 * p.Count / tot).toFixed(1) + '%'));

const combos = [...full.TraitCombos].sort((a, b) => b.Count - a.Count);
console.log('god roll:', combos[0], '| rarest tracked:', combos.at(-1));

await s.close();
```
