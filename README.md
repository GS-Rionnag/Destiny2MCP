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

ChatGPT connectors need a public URL, so run a tunnel:

```bash
cloudflared tunnel --url http://localhost:7777
```

Then in ChatGPT: **Settings → Connectors → Advanced → Developer mode**, add a connector with URL `https://<tunnel-host>/mcp`, no authentication.

**Security note:** anyone who has the tunnel URL controls your Destiny inventory. Protect it (e.g. Cloudflare Access) or keep the URL secret and rotate it regularly.

## Connect Claude

Claude Code:

```bash
claude mcp add --transport http destiny2 http://localhost:7777/mcp
```

Claude Desktop: **Settings → Connectors → Add custom connector**, URL `http://localhost:7777/mcp`.

## Tools (23)

### Read (13)

| Tool | Description |
|------|-------------|
| `get_profile` | Destiny 2 account overview: characters (class, power, race, playtime), currencies like Glimmer. |
| `get_character` | One character in detail: stats (Mobility etc.) and all currently equipped items with power. |
| `search_inventory` | Search ALL items across every character and the vault. Filter by name and/or item type substring (e.g. "Rocket Launcher", "Helmet"). Returns instance ids needed by transfer/equip tools. |
| `get_item_details` | Full detail for one item instance: perks/mods in each socket (with socket indexes for insert_plug), stats, energy. |
| `get_vendors` | List all currently available vendors (Xur, Banshee-44, Ada-1...) with refresh times. Use get_vendor_items for stock. |
| `get_vendor_items` | One vendor's current stock with costs. vendor_hash from get_vendors (Xur: 2190858386). |
| `get_loadouts` | In-game loadout slots per character. loadout_index feeds equip_loadout / snapshot_loadout. |
| `get_milestones` | Current weekly milestones/activities across the game (public info, no character needed). |
| `get_activity_history` | Recent completed activities for a character. mode: 0=all, 5=PvP, 7=PvE, 4=raid, 82=dungeon, 84=Trials, 46=GM nightfall. |
| `get_stats` | Lifetime account stats, split PvE / PvP: kills, K/D, activities cleared, time played, and more. |
| `get_clan` | The account's clan: name, motto, member count, online members. |
| `search_player` | Find any player by full Bungie name ("Guardian#1234") → their membership ids. |
| `search_manifest` | Look up any Destiny definition by name → hash. Items by default; set table for perks (DestinySandboxPerkDefinition), activities (DestinyActivityDefinition), etc. |

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
| `insert_plug` | Socket a mod/aspect/fragment/free perk into an item (armor mods, subclass configuration, crafted weapon free swaps). plug = exact name or hash. socket_index from get_item_details. Only FREE socket operations work (Bungie blocks paid ones for all third-party apps). |
| `change_subclass` | Equip a subclass by name (e.g. "Solar", "Prismatic") and optionally configure its super/aspects/fragments in one call. For plugs: first call get_item_details on the subclass instance to see socket indexes. |

### Raw (1)

| Tool | Description |
|------|-------------|
| `bungie_api_call` | Escape hatch: call ANY Bungie.net Platform endpoint directly (https://bungie-net.github.io/multi lists all ~150). path is relative to /Platform, e.g. "/Destiny2/Manifest/". Prefer the specific tools when one fits; responses here are raw JSON with unresolved hashes. |

## Known Bungie limits

- **Equipping** only works while the character is in orbit, in a social space, or offline — the game rejects equip requests mid-activity.
- **Paid perk/mod swaps are blocked** for all third-party apps: Bungie's `AdvancedWriteActions` only permits free socket operations (armor mods, subclass config, crafted-weapon free swaps). Anything that costs materials must be done in game.
- **Refresh token expires after 90 days.** If API calls start failing with auth errors, re-run the one-time OAuth: `npm start`, then open `https://localhost:7778/auth` again.
