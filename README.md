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

Alternative without an OpenAI platform account: expose the server publicly with `cloudflared tunnel --url http://localhost:7777` and add the URL as a connector — but then anyone with the URL controls your Destiny inventory; protect it or rotate it regularly.

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
| `get_item_details` | Full detail for one item instance: perks/mods in each socket (with socket indexes for insert_plug), stats, energy. `include_plug_options` also lists what each socket accepts; `socket_index` narrows that to one socket. |
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

### Raw (1)

| Tool | Description |
|------|-------------|
| `bungie_api_call` | Escape hatch: call ANY Bungie.net Platform endpoint directly (https://bungie-net.github.io/multi lists all ~150). path is relative to /Platform, e.g. "/Destiny2/Manifest/". Prefer the specific tools when one fits; responses here are raw JSON with unresolved hashes. |

## Known Bungie limits

- **Equipping** only works while the character is in orbit, in a social space, or offline — the game rejects equip requests mid-activity.
- **Paid perk/mod swaps are blocked** for all third-party apps: Bungie's `AdvancedWriteActions` only permits free socket operations (armor mods, subclass config, crafted-weapon free swaps). Anything that costs materials must be done in game.
- **Refresh token expires after 90 days.** If API calls start failing with auth errors, re-run the one-time OAuth: `npm start`, then open `https://localhost:7778/auth` again.
