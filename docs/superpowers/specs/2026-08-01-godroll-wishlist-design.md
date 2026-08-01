# God rolls from DIM wish lists — design

Date: 2026-08-01

## Problem

The model can already find every weapon in the vault, but it has no idea which of them are
*good*. Asked to build a loadout it falls back on stat totals and its own training data, which
is stale the moment a sandbox patch lands.

The community answer is DIM wish lists. `voltron.txt` from
[48klocs/dim-wish-list-sources](https://github.com/48klocs/dim-wish-list-sources) is the
compiled collection, continuously updated, and every roll block carries a **prose explanation
of why that roll is good** — the exact context the model is missing.

Measured on the 2026-08-01 copy:

| | |
|---|---|
| File | 26.3 MB, 287,171 lines |
| Rolls (`dimwishlist:` lines) | 252,163 |
| Distinct weapons | 1,225 |
| Distinct note blocks | 5,024 |
| Note text | 5.6 MB (~275 tokens average, longest ~1,500 words) |
| Trash-list rolls (`item=-…`) | 0 |

The note text is the feature. It is also the whole cost problem: a 40-item vault sweep that
echoed full notes would spend ~11k tokens on prose.

## Scope

In scope: matching owned weapon instances against the wish list, DIM-syntax search filters,
the "why" surfaced at the right granularity, and keeping the list fresh.

Out of scope: the trash list (voltron ships zero entries — add it if a future source has
them), armor, multiple simultaneous wish-list sources, a user-authored local wish list.

## Storage — `data/wishlist.db`

`better-sqlite3` is already a dependency and already used for the manifest. The parsed list
goes in its own SQLite file, so nothing is held in memory and a rebuild is a file swap.

```sql
notes(id INTEGER PRIMARY KEY, title TEXT, text TEXT, tags TEXT)
rolls(itemHash INTEGER, perks TEXT, noteId INTEGER)
meta(key TEXT PRIMARY KEY, value TEXT)          -- fetchedAt, source, counts
CREATE INDEX rolls_item ON rolls(itemHash);
```

`notes.title` is the `title:` header the roll block sat under — "PvE Podcast 172 - The Best
Pulse Rifles". That is the credit line and the model's cue about which reviewer's opinion it
is reading.

`rolls.perks` holds perk **names**, lowercased, sorted, `|`-separated. See Matching.

### Parsing

Four line shapes appear in the file and all four are handled:

```
title:PvE Podcast 172 - The Best Pulse Rifles      # sets the current source title
description:...                                    # ignored
// free comment                                    # ignored
//notes:<prose>|tags:<a b c>                       # note for every roll line that follows
dimwishlist:item=52683113&perks=839105230,106909392,3891536761,3640170453
dimwishlist:item=435216110&perks=...#notes:<prose>|tags:pve,mkb     # inline note, this roll only
```

Plus **continuation lines**: 218 `//notes:` blocks wrap onto following lines that carry no
prefix at all. A non-blank line matching none of the known prefixes, while a note is pending,
is appended to that note. Anything else unrecognised (`@description:`) is skipped.

A `//notes:` line resets the pending note; the pending note applies to every subsequent
`dimwishlist:` line until the next `//notes:` or `title:`. Inline `#notes:` wins for its own
line only. `item=-<hash>` (trash) is skipped.

Identical note text is stored once — 252k roll lines collapse to ~5.1k note rows. Resolving perks
to names also merges rolls that differed only by perk hash, so the built index holds 198,167 rolls
in a ~24 MB database.

## Matching — by perk name, not perk hash

The wish list names base perks. A crafted or enhanced weapon carries *different hashes* for
the same perks, so hash-set matching silently misses every crafted god roll.

Verified against the manifest: **300 of 301** perk names that have an "Enhanced Trait" variant
share their display name with the base perk exactly, and the enhanced definition carries no
link back to the base. So the fix is to compare names:

- At index build time, each perk hash in the file is resolved through
  `DestinyInventoryItemDefinition` to a lowercased display name. The index therefore needs the
  manifest open before it can be built.
- On the item side, plug hashes resolve the same way — `SearchItem.plugs` already holds
  lowercased plug names.

A roll matches an item when **every** perk name in the roll is present in the item's plug-name
set. Barrel/magazine variants make each god roll expand into dozens of `dimwishlist:` lines;
subset matching over names collapses that back down.

### Equipped vs available

Measured on the live account: **138 of 230 weapons** have more than one selectable option in a
real weapon-perk column — crafted weapons and modern multi-perk drops. A weapon sitting on
Vorpal Weapon with Firing Line one click away *is* a god roll you own.

Two match grades:

| grade | meaning |
|---|---|
| `equipped` | every roll perk is currently plugged |
| `available` | every roll perk is plugged **or** selectable, but a swap is needed |

Selectable options come from profile component **310** (`ItemReusablePlugs`). Measured cost on
the live account:

| components | payload | latency |
|---|---|---|
| `102,201,205,200,300,304,305` (today) | 1.45 MB | 770 ms |
| the same plus `310` | 2.39 MB | 1,754 ms |

So 310 is requested **only when the query uses a god-roll filter**. Ordinary searches keep
today's speed. (The two component strings are separate keys in the existing 60s GET cache.)

## Tool surface

No new search tool — the model already reaches for `search_inventory` and `get_item_details`,
so god rolls have to appear there or they will not be used.

### `search_inventory` — new filters

| filter | meaning |
|---|---|
| `is:godroll`, `is:wishlist` | matches a wish-list roll, equipped or one swap away |
| `is:godrollequipped` | strict — the currently plugged roll matches |
| `godroll:<text>`, `wishlistnotes:<text>` | tag, source title or note text contains `<text>` — `godroll:pve-boss`, `godroll:trials` |

`is:wishlist` and `wishlistnotes:` are DIM's own keyword names, kept as aliases so a query
copied out of DIM still runs. `search_inventory`'s error message already lists every supported
keyword; these join that list.

Matched rows gain a compact `godroll` object — roughly 10 tokens, cheap enough for a 50-row
sweep:

```json
{
  "name": "Succession",
  "itemInstanceId": "6917529997850479349",
  "power": 2010,
  "godroll": {
    "match": "available",
    "tags": "PvE PvE-Boss PvE-God M+KB",
    "source": "PvE Podcast 172 - The Best Pulse Rifles",
    "swap": ["socket 4 → Firing Line"]
  }
}
```

When several rolls match one item, an `equipped` match is reported over an `available` one;
ties break toward the roll with the most perks. `rollsMatched` carries the total count.

### `get_item_details` — the why

Matched items gain a `godroll` object carrying the **full note text**: the several-hundred-word
explanation of what the perks do, how they interact, what content the roll is for, and the
recommended masterwork.

Full text is returned for at most **5** matched items per call. Beyond that each note is cut to
400 characters with `notesTruncated: true`, so a 15-id call cannot blow the context window. No
new parameter — the cap is automatic.

`get_item_details` already fetches per-item component 310 behind `include_plug_options`; it now
requests 310 unconditionally so swap advice always works. The extra plugs are used for matching
only — they are still not rendered unless `include_plug_options` is set, so the tool's own
output does not grow.

### `refresh_wishlist`

Forces a re-download and rebuild. Returns roll/note/weapon counts and the new `fetchedAt`.

## Refresh

On boot, after the manifest opens, the index age is checked. Missing or older than 24 h
triggers a rebuild **in the background** — the old index keeps answering while the new one
builds, and startup never blocks on a 26 MB download. A failed refresh logs and leaves the
previous index in place.

Source URL lives in `config` (`WISHLIST_URL`, defaulting to the voltron raw URL) so a different
list can be pointed at without a code change.

## Error handling

- No index yet (first boot, download still running): god-roll filters return an error naming
  `refresh_wishlist`; every other filter is unaffected.
- Download or parse failure: the previous `wishlist.db` is untouched; the error is logged and
  returned by `refresh_wishlist`.
- A perk hash the manifest no longer knows resolves to `#<hash>`, which simply never matches —
  the correct outcome for a removed perk.

## Testing

`tests/wishlist.test.ts`, against a small fixture file rather than the live 26 MB list:

- block `//notes:` applying to the rolls beneath it
- inline `#notes:` overriding the block note for its own line
- a note wrapped across continuation lines
- note deduplication across rolls
- subset matching: a 4-perk roll matched by an item carrying extra plugs
- an item missing one roll perk does not match
- enhanced-perk equivalence: an item plugged with "Enhanced Trait" *Vorpal Weapon* matches a
  roll listing the base *Vorpal Weapon* hash
- `available` vs `equipped` grading, and the reported swap

## Deliberate simplifications

- Matching runs against **all** the item's plug names, not only sockets in the weapon-perk
  category. A wish-list perk name colliding with a shader or memento name is not a realistic
  risk, and the socket-category filter costs a definition walk per item.
- No trash list, because the source has none.
- One wish-list source at a time.
