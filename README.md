# Destiny 2 MCP Server

An MCP (Model Context Protocol) server giving full read/write access to the Bungie API for your Destiny 2 account — usable from ChatGPT web, Claude Code, Claude Desktop, or any MCP client. Ask an AI to find god rolls in your vault, build loadouts, move gear between characters, configure your subclass, check Xur's stock, or pull raid stats. Runs entirely on your machine; your Bungie credentials never leave it.

## Prerequisites

- Node.js ≥ 20
- A Bungie.net account (with cross-save/platform Destiny 2 characters)

## Bungie app registration

1. Go to https://www.bungie.net/en/Application and sign in.
2. Click **Create New App**.
3. Fill in:
   - **Application Name**: anything (e.g. `My D2 MCP`)
   - **Website**: anything (e.g. `https://localhost`)
   - **OAuth Client Type**: `Confidential`
   - **Redirect URL**: `https://localhost:7778/callback`
   - **Scope**: check *Read your Destiny 2 information*, *Move or equip Destiny gear*, and the other read scopes (basic profile, groups/clans, vendors and advisors).
   - **Origin Header**: leave blank.
4. Agree to the terms and save.
5. Copy the **API Key**, **OAuth client_id**, and **OAuth client_secret** — you need all three next.

## Setup

```bash
cp .env.example .env    # paste in your API key, client_id, client_secret
npm install
npm run setup           # generates the self-signed cert for the local OAuth server
npm start
```

On first boot the server downloads the Destiny manifest (~200 MB) — give it a minute.

Then open **https://localhost:7778/auth** in a browser, click through the self-signed-certificate warning (Advanced → Proceed), and sign in with Bungie. That's a one-time step; tokens are saved and refreshed automatically.

The MCP endpoint is now live at **http://localhost:7777/mcp**.

## Verify

```bash
npm run smoke
```

Read-only live test: looks up Gjallarhorn in the manifest, fetches your account, and prints each character's power level. Ends with `SMOKE OK`.

## Connect ChatGPT web

ChatGPT can't reach localhost directly. The supported path is OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels): a daemon on your machine makes an outbound connection to OpenAI, and ChatGPT talks to your server through it. No public URL, no exposed port.

Requires a ChatGPT plan with developer mode (Plus/Pro/Business) and an OpenAI platform account.

1. **Enable developer mode**: ChatGPT → **Settings → Apps & Connectors → Advanced settings → Developer mode**.
2. **Create a tunnel**: [platform.openai.com → Settings → Tunnels](https://platform.openai.com/settings/organization/tunnels) → Create tunnel. Copy the `tunnel_id`.
3. **Create a runtime API key**: [Runtime API keys](https://platform.openai.com/settings/organization/api-keys), with Tunnels **Read + Use** permissions. This key only authenticates the tunnel — it doesn't spend model credits.
4. **Install `tunnel-client`** on the machine running this server: download the binary for your platform from [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest) and put it on your PATH.
5. **Configure and run** (with `npm start` already running):

   ```bash
   export CONTROL_PLANE_API_KEY="sk-..."   # the runtime key

   tunnel-client init \
     --sample sample_mcp_remote_no_auth \
     --profile destiny2 \
     --tunnel-id tunnel_YOUR_ID \
     --mcp-server-url http://localhost:7777/mcp

   tunnel-client run --profile destiny2
   ```

   `tunnel-client doctor --profile destiny2` flags a failed `oauth_metadata` check — expected, this server has no OAuth layer; plain MCP servers still reach ready. Confirm with `curl http://127.0.0.1:8080/readyz` → `ready`.
6. **Add the plugin**: ChatGPT → **Plugins → + → Connection: Tunnel** → select your tunnel. Authentication: **None**. Give it a name and a capability-rich description (the model uses the description to decide when to call your tools).

Keep `tunnel-client run` alive alongside `npm start` (e.g. systemd services) — ChatGPT needs both for every call.

**After changing a tool's schema, delete the connector and add it again.** ChatGPT snapshots the tool list when the connector is created and does not call `tools/list` on later sessions — reconnecting or restarting the server reuses the stale snapshot, and calls fail with `Input validation error`. Confirm the refetch landed by looking for a `tools/list` line in `data/mcp.log` — per-call logging is off by default, so set `MCP_LOG=1` in `.env` and restart first.

Alternative without an OpenAI platform account: expose the server publicly with `cloudflared tunnel --url http://localhost:7777` and add the URL as a connector — but then anyone with the URL controls your Destiny inventory; protect it or rotate it regularly.

## Scheduled monitoring

ChatGPT's Scheduled Tasks run a prompt on a timer (max hourly) and start **every run with a fresh context** — a task cannot remember what it reported last time. `search_inventory sort:recent` therefore re-reports the same drops forever.

`get_new_items` moves that memory server-side. It stores the highest item instance id it has seen per `cursor` in `data/watermarks.json` (instance ids are allocated monotonically, so "id above the mark" means "acquired since"), and returns `{"new": 0}` when nothing arrived — the tool description tells the model to stay silent in that case, so no push notification fires on a quiet hour.

Task prompt that works:

> Every hour, call `get_new_items` with cursor `"chatgpt-hourly"`. If `new` is 0, reply with nothing. Otherwise list the items with tier and power.

Notes:

- The **first** call on a cursor only records a baseline (`initialized: true`). Drops are reported from the second call on.
- Give each task its own `cursor`. Two tasks sharing one cursor eat each other's deltas. Use `peek: true` to look without consuming.
- A `query` filters what is reported but not how far the watermark moves — so `query: "is:exotic"` will never re-scan the legendaries it skipped.
- Detects arrivals only, not dismantles or transfers.
- The hourly cap does not lose anything: the watermark is id-based, not time-based, so a longer gap just means a bigger batch.
- Plus/Pro developer-mode connectors are **read-only** — `get_new_items` works there; the write tools need Business/Enterprise.
- If the Bungie refresh token dies, calls fail with a message starting `REAUTH REQUIRED`, which surfaces in the task's notification instead of failing silently.

## Connect Claude

Claude Code:

```bash
claude mcp add --transport http destiny2 http://localhost:7777/mcp
```

Claude Desktop: **Settings → Connectors → Add custom connector**, URL `http://localhost:7777/mcp`.

## Tools (32)

### Read (17)

| Tool | Description |
|------|-------------|
| `get_profile` | Destiny 2 account overview: characters (class, power, race, playtime), currencies like Glimmer. |
| `get_session_state` | Whether the player is online and which writes are allowed right now — equip/socket need orbit, a social space, or offline. One call instead of deducing it from the profile. |
| `get_character` | One character in detail: stats (Mobility etc.) and all currently equipped items with power. |
| `search_inventory` | Search ALL items across every character and the vault using [DIM search syntax](#dim-search-syntax) — `is:armor is:hunter -is:exotic stat:resilience:>=20`. Optional `sort` (`power`, `name`, `recent`, `quantity`, `stat:<name>`) is applied before `limit`. Returns instance ids needed by transfer/equip tools. `is:godroll` filters against the [DIM wish list](#god-rolls); matching rows carry a compact `godroll` field. |
| `get_new_items` | Items acquired since the last check — for scheduled/recurring monitoring. Keeps a watermark per `cursor` in `data/watermarks.json`, so each drop is reported exactly once even to a client with no memory between runs. Optional DIM `query` filters what gets reported; `peek` reports without advancing. See [Scheduled monitoring](#scheduled-monitoring). |
| `get_item_details` | Full detail for up to 15 item instances in one call: perks/mods in each socket (with socket indexes for insert_plug), stats, energy. `include_plug_options` also lists what each socket accepts; `socket_index` narrows that to one socket. A bad id is reported in place, not fatal. Items matching a [god roll](#god-rolls) include the full wish-list note explaining why the roll is good. |
| `get_vendors` | List all currently available vendors (Xur, Banshee-44, Ada-1...) with refresh times. Use get_vendor_items for stock. |
| `get_vendor_items` | One vendor's current stock with costs. vendor_hash from get_vendors (Xur: 2190858386). |
| `get_loadouts` | In-game loadout slots per character. loadout_index feeds equip_loadout / snapshot_loadout. |
| `get_milestones` | Current weekly milestones/activities across the game (public info, no character needed). |
| `get_activity_history` | Recent completed activities for a character. mode: 0=all, 5=PvP, 7=PvE, 4=raid, 82=dungeon, 84=Trials, 46=GM nightfall. |
| `get_stats` | Lifetime account stats, split PvE / PvP: kills, K/D, activities cleared, time played, and more. |
| `get_clan` | The account's clan: name, motto, member count, online members. |
| `search_player` | Find any player by full Bungie name ("Guardian#1234") → their membership ids. |
| `search_manifest` | Look up any Destiny definition by name → hash. Items by default; set table for perks (DestinySandboxPerkDefinition), activities (DestinyActivityDefinition), etc. |
| `get_definition` | Definitions by hash from the local manifest — instant, no network, up to 50 hashes per call. Trimmed to name/description/type/energy cost/perks; `full` returns the raw definition. |
| `refresh_wishlist` | Re-download and rebuild the DIM wish list index used by the god-roll filters. Returns roll/note/weapon counts. |

### Write (9)

| Tool | Description |
|------|-------------|
| `transfer_item` | Move an item between a character and the vault. Get item_instance_id + item_hash from search_inventory. To move char→char: transfer to vault first, then vault→other char. |
| `equip_item` | Equip one item on a character. Only works in orbit/social spaces or offline (Bungie restriction). |
| `equip_items` | Equip several items at once on a character (full loadout swap). Same location restriction as equip_item. |
| `equip_loadout` | Apply a saved in-game loadout slot. Get loadout_index from get_loadouts. |
| `snapshot_loadout` | Save the character's CURRENT equipment into an in-game loadout slot (overwrites that slot). |
| `pull_from_postmaster` | Pull an item from the postmaster to the character. Find postmaster items via search_inventory (they sit in the Lost Items bucket). |
| `set_lock_state` | Lock or unlock an item (protects from dismantle in game). |
| `insert_plug` | Socket mods/aspects/fragments/free perks into one item — pass every socket in a single `plugs` array. plug = exact name or hash; socket indexes from get_item_details. A failed socket is reported without aborting the rest. Only FREE socket operations work (Bungie blocks paid ones for all third-party apps). |
| `change_subclass` | Equip a subclass by name (e.g. "Solar", "Prismatic") and optionally configure its super/aspects/fragments in one call. For plugs: first call get_item_details on the subclass instance to see socket indexes. |

### Raw (3)

| Tool | Description |
|------|-------------|
| `list_endpoints` | Index of all 135 Bungie Platform endpoints from Bungie's own OpenAPI spec — names only. Filter by `search` or `tag`. Saves the model from reading the online API docs. |
| `describe_endpoint` | One endpoint's full signature: parameters, request body shape, OAuth scope, response type. |
| `bungie_api_call` | Escape hatch: call ANY Bungie.net Platform endpoint directly. path is relative to /Platform, e.g. "/Destiny2/Manifest/". Prefer the specific tools when one fits; responses here are raw JSON with unresolved hashes. |

The spec behind the first two is downloaded once (1.8MB) to `data/openapi.json` on first use. Delete that file to pick up Bungie's latest.

### Builds (3)

Community and editorial builds from [Mobalytics](https://mobalytics.gg/destiny-2/builds) — build *ideas*, not the player's inventory. No account, no API key: it is the site's own public GraphQL API. See [docs/mobalytics-api.md](docs/mobalytics-api.md) for the reverse-engineered schema.

| Tool | Description |
|------|-------------|
| `search_builds` | Search builds by `class`, `subclass`, `type` (pve/pvp), `tags` (AND), `weapon`/`armor`/`exotic` by name, `author`, `sort` (`trending`/`new`/`top`/`featured`) and `time` (`today`/`week`/`month`). `source: meta` searches Mobalytics' editorial builds instead of player-published ones. Returns a preview card per build — super, abilities by slot, aspects, weapons with perks, armor with the exotic called out, tags, author, favorites — plus a `cursor` for the next page. |
| `get_build` | Everything on one build id/slug: full loadout, armor exotic perks and set bonuses, mods per slot, fragments, stat priority, artifact perks, and the author's write-up — gameplay loop, how it works, in-depth sections, strengths/weaknesses, DIM import link, video guide. |
| `find_build_item` | Name → Mobalytics item id, for when a weapon/armor name is ambiguous. `search_builds` resolves names on its own. |

Mobalytics sits behind Cloudflare, which fingerprints TLS and HTTP/2 — plain `fetch` gets a challenge page, so these tools go through `node-tls-client` (a real Chrome fingerprint). It downloads a ~16MB shared library on first run. If Cloudflare ever refuses every profile, the tools say so rather than returning empty results.

## DIM search syntax

`search_inventory` uses [DIM's item search language](https://github.com/DestinyItemManager/DIM/wiki/Item-Search).
The lexer and parser are ported from DIM (`src/search/query-parser.ts`, MIT), so a query that parses
in DIM parses here — same operators, same precedence, same quoting.

Like DIM, one profile fetch pulls everything and every filter runs locally, so a complex query costs
exactly one API call. Repeat searches inside 60s hit the response cache and cost none.

| | |
|---|---|
| **Logic** | space = and, `or`, `and`, `not`, `-` to negate, `( )` to group, `"quoted phrases"` |
| **Text** | `name:`, `exactname:`, `description:`, `type:`, `perk:` / `perkname:`, or a bare word (matches name, type or perk) |
| **Rarity** | `is:common` `is:uncommon` `is:rare` `is:legendary` `is:exotic` (+ `white` `green` `blue` `purple` `yellow`) |
| **Element** | `is:kinetic` `is:arc` `is:solar` `is:void` `is:stasis` `is:strand` |
| **Ammo / class** | `is:primary` `is:special` `is:heavy`; `is:titan` `is:hunter` `is:warlock` |
| **Item type** | any category from the manifest: `is:handcannon` `is:sniperrifle` `is:helmet` `is:gauntlets` `is:weapon` `is:armor`, plus `is:lfr` `is:lmg` `is:smg` |
| **State** | `is:locked` `is:unlocked` `is:masterwork` `is:crafted` / `is:shaped` `is:tracked` `is:modded` `is:dupe` |
| **Location** | `is:invault` `is:oncharacter` `is:equipped` `is:postmaster` `is:transferable` |
| **Numbers** | `power:` `light:` `stack:` `count:` `energycapacity:`, each taking `>`, `>=`, `<`, `<=`, `=` or a bare number |
| **Stats** | `stat:<name>:<comparison>`, e.g. `stat:resilience:>=20`, plus `stat:total:` for the armor total |
| **God rolls** | `is:godroll` / `is:wishlist` (matches a wish-list roll, equipped or one perk swap away), `is:godrollequipped` (strict — the currently plugged roll matches), `godroll:<text>` / `wishlistnotes:<text>` (tag, source title or note text contains the text, e.g. `godroll:pve-boss`) |

Armor 3.0 renamed the six armor stats (Resilience → Health, Mobility → Weapons, and so on). Both
names work — the old ones are aliases, as they are in DIM.

Not supported, because they need DIM Sync or data Bungie's API doesn't serve: `tag:`, `notes:`,
`season:`, `source:`, `foundry:`, `basestat:`. An unknown keyword comes back as an error
listing everything that is supported.

## God rolls

The god-roll filters match your weapons against a DIM wish list. The default source is
[voltron.txt](https://raw.githubusercontent.com/48klocs/dim-wish-list-sources/refs/heads/master/voltron.txt)
— a continuously updated compilation of community god rolls (26 MB, 252,163 `dimwishlist:` lines
covering 1,225 weapons). Set `WISHLIST_URL` in `.env` to use a different list. The file is parsed
once into `data/wishlist.db` (SQLite, ~24 MB — 198k rolls and 5.1k note blocks after
deduplication) and never held in memory.

The point is the notes: every roll block carries a prose explanation of **why** the roll is good
— what the model needs to build a loadout, not just which perks to look for. `search_inventory`
returns tags + source per matching item (~10 tokens a row); `get_item_details` returns the full
note, capped at 5 full notes per call with the rest truncated to 400 chars, so a 15-id call
cannot blow the context.

- **Matching is by perk name, not hash**, so crafted and enhanced weapons match (300 of 301
  enhanced perks share their base perk's display name).
- Two match grades: `equipped` (the plugged roll matches) and `available` (every perk is
  selectable but a swap is needed — the match reports which socket to change). This matters: on
  a real account 138 of 230 weapons had multi-option perk columns.
- The extra Bungie component this needs (310, ItemReusablePlugs) is requested only when a query
  uses a god-roll filter — measured 1.45 MB / 770 ms without it vs 2.39 MB / 1754 ms with it, so
  ordinary searches keep their speed.
- On boot the index rebuilds in the background if missing or older than 24 h; the old index
  keeps serving and startup never blocks. `refresh_wishlist` forces a rebuild.
- Not supported: the trash list (the source ships zero entries), armor, multiple simultaneous
  sources.

## Known Bungie limits

- **Equipping** only works while the character is in orbit, in a social space, or offline — the game rejects equip requests mid-activity.
- **Paid perk/mod swaps are blocked** for all third-party apps: Bungie's `AdvancedWriteActions` only permits free socket operations (armor mods, subclass config, crafted-weapon free swaps). Anything that costs materials must be done in game.
- **Refresh token expires after 90 days.** If API calls start failing with auth errors, re-run the one-time OAuth: `npm start`, then open `https://localhost:7778/auth` again.
- **Only weapons and armor have power.** Bungie hangs a `primaryStat` on plenty of things that have none — a sparrow's is Speed, and a subclass gets one of its own stat modifiers picked at random, which can read *negative*. Following [DIM](https://github.com/DestinyItemManager/DIM/blob/master/src/app/inventory/store/d2-item-factory.ts), `power` is reported only when that stat is Attack, Defense or Power, so nothing else leaks into `is:haspower` or `sort:power`. The stat is not thrown away: an item with no power gets `primaryStat: {name, value}` instead, so a sparrow reports `{"name": "Speed", "value": 190}`. Subclasses and the artifact are the exception — their primary stat is dropped outright, because component 304 already reports all six of a subclass's real stats.
- **Gear on a character you have not played in a long time reads power 10.** That is Bungie's data (`itemLevel: 1`), not a parsing bug — log the character in once and it re-derives.
