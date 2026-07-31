# Destiny 2 MCP Server — Design

Date: 2026-07-31
Status: Approved

## Goal

Local MCP server exposing the full Bungie/Destiny 2 API — reads AND writes
(move items, equip gear, change subclasses, mods, perks) — to any MCP client.
Primary target: ChatGPT web (via connector). Also Claude and any other MCP
client.

## Distribution model

Single-user-per-deployment. Anyone clones the repo, registers their own
Bungie app (API key + OAuth client id/secret), runs it locally. Server
listens on `localhost:PORT` (default 7777). Exposing it to ChatGPT web
(Cloudflare tunnel etc.) is the user's job, outside this project's scope.

## Architecture

```
ChatGPT web ──(user's tunnel, later)──┐
Claude / other LLMs ──────────────────┤
                                      ▼
                        localhost:7777  (Express + MCP Streamable HTTP)
                                      │
                 ┌────────────────────┼──────────────────┐
                 ▼                    ▼                  ▼
           MCP tools (~22)      OAuth routes        Manifest store
           + bungie_api_call    /auth /callback     (SQLite, auto-DL)
                 │                    │
                 └────────► Bungie API client ◄──────────┘
                            (throttle, retry, token refresh)
```

- **Stack:** Node + TypeScript, official `@modelcontextprotocol/sdk`,
  Streamable HTTP transport, Express host. One process.
- **Run:** `npm install && npm run setup && npm start`.
- **Config:** `.env` — `BUNGIE_API_KEY`, `BUNGIE_CLIENT_ID`,
  `BUNGIE_CLIENT_SECRET`, `PORT`.
- **Tokens:** `tokens.json`, gitignored. Access token auto-refreshed (1h
  expiry); refresh token lasts 90 days, server warns as it nears expiry.
- **Manifest:** Bungie SQLite manifest (~200MB) downloaded on first run,
  cached on disk, version-checked at startup. All hash→name resolution is
  local — responses to the LLM contain human-readable names, never raw
  hashes.
- **MCP endpoint:** `POST /mcp` (Streamable HTTP). No auth on the endpoint
  itself (localhost). Tunnel hardening (Cloudflare Access, token header) is
  documented in README as the user's responsibility.

## Tools

### Read (13)

| Tool | Does |
|---|---|
| `get_profile` | Characters overview, currencies, season |
| `get_character` | One char: equipped gear, stats, artifact |
| `search_inventory` | All items across chars + vault; filter by name/type/slot |
| `get_item_details` | Instance: perks, sockets, stats, masterwork |
| `get_vendors` | Vendor list + refresh times |
| `get_vendor_items` | One vendor's stock (Xur, Banshee, …) |
| `get_loadouts` | In-game loadout slots |
| `get_milestones` | Weekly activities, rotators |
| `get_activity_history` | Recent PvE/PvP games |
| `get_stats` | Lifetime/mode stats (K/D etc.) |
| `get_clan` | Clan roster, progress |
| `search_player` | Bungie name → membership id |
| `search_manifest` | Name → hash/definition (items, perks, mods) |

### Write (8)

| Tool | Does |
|---|---|
| `transfer_item` | Char ↔ vault; auto-unequips equipped items first |
| `equip_item` / `equip_items` | Equip gear (single / batch) |
| `equip_loadout` | Apply in-game loadout |
| `snapshot_loadout` | Save current gear to a loadout slot |
| `pull_from_postmaster` | Rescue postmaster items |
| `set_lock_state` | Lock/unlock item |
| `change_subclass` | Equip subclass + set super/aspects/fragments via free socket plugs |
| `insert_plug` | Change mods/free perks on any socketed item |

### Escape hatch (1)

`bungie_api_call(method, path, query?, body?)` — any of the ~150 Bungie
endpoints, authenticated, raw JSON response. Guarantees 100% API coverage
beyond the curated tools.

### Known platform limit (Bungie's, not ours)

Bungie gates paid/permanent perk changes behind `AdvancedWriteActions`
(manual app whitelist, effectively DIM-only). Free socket operations via
`insertSocketPlugFree` — mods, subclass supers/aspects/fragments, free
crafted-weapon reslotting — work with normal OAuth. So: subclass editing ✅,
mods ✅, paid weapon perk rerolls ❌ (blocked for all third parties).

## Auth flow (one-time per user)

1. User registers app at bungie.net/developer → API key, client id/secret.
   OAuth redirect URL: `https://localhost:7778/callback` (separate HTTPS
   port — MCP stays plain HTTP on 7777; one port can't serve both).
2. `npm run setup` → generates self-signed TLS cert (Bungie requires HTTPS
   redirect), prints `https://localhost:7778/auth`.
3. User opens it, accepts the one-time browser cert warning, logs into
   Bungie, callback stores `tokens.json`.
4. Thereafter fully automatic: access token refresh on expiry; clear warning
   when the 90-day refresh token nears death.

## Error handling

- Bungie `ErrorCode != 1` → readable tool error
  (`"DestinyItemNotFound: item no longer exists"`), never a stack trace.
- Rate limiting: client-side throttle (~25 req/s) + retry honoring Bungie's
  `ThrottleSeconds`.
- `SystemDisabled` → "Bungie API down for maintenance".
- Dead/expired tokens → tool response instructs the LLM to tell the user to
  re-visit `/auth`.

## Project layout

```
src/
  index.ts          server + MCP transport wiring
  auth.ts           oauth routes, token store, refresh
  bungie.ts         API client (throttle, retry, error mapping)
  manifest.ts       download, cache, hash→name, name→hash search
  tools/
    read.ts         13 read tools
    write.ts        8 write tools
    raw.ts          bungie_api_call
.env.example
README.md           setup, ChatGPT connector + Claude config, tunnel notes
```

## Testing

- **Unit:** manifest lookup, Bungie error mapping, token refresh logic
  (mocked fetch).
- **Live smoke:** `npm run smoke` — read-only hit of `get_profile` +
  `search_inventory` against the real account.
- **Write tools:** manual verification against real inventory; excluded from
  CI.
