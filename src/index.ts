import express from 'express';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { config } from './config.js';
import { openManifest } from './manifest.js';
import { refreshWishlistIfStale } from './wishlist.js';
import { startAuthServer } from './auth-server.js';
import { readTokens } from './auth.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerRawTool } from './tools/raw.js';
import { registerProgressTools } from './tools/progress.js';
import { registerBuildTools } from './tools/builds.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerDimTools } from './tools/dim.js';
import { registerLightggTools } from './tools/lightgg.js';

// ponytail: byte-count + JSONL append, no rotation. Add rotation if log outgrows the disk.
function logCalls(body: unknown, bytes: number, ms: number) {
  if (!config.logCalls) return; // MCP_LOG=1 to re-enable
  const calls = Array.isArray(body) ? body : [body];
  for (const c of calls as any[]) {
    const tool = c?.params?.name ? ` ${c.params.name}` : '';
    const args = c?.params?.arguments ? ` ${JSON.stringify(c.params.arguments).slice(0, 160)}` : '';
    const line = `${new Date().toISOString()} ${c?.method ?? '?'}${tool}${args} -> ${bytes}B ~${Math.round(bytes / 4)}tok ${ms}ms`;
    console.error(line);
    try { appendFileSync(join(config.dataDir, 'mcp.log'), line + '\n'); } catch { /* logging never breaks a request */ }
  }
}

// Shown to the model once per session. Everything here is something it otherwise
// has to learn by trial and error, in every new conversation, forever.
const INSTRUCTIONS = `Destiny 2 account control via the Bungie API.

Batch your calls — every extra round trip is a full turn:
- get_item_details takes item_instance_ids (up to 15), not one id
- insert_plug takes a plugs array — send a whole item's mods at once
- get_definition takes up to 50 hashes

search_inventory speaks DIM search syntax (is:, name:, perk:, power:>=, stat:x:>=n,
or/-/parens). Put every condition in one query — "is:armor is:hunter -is:exotic
stat:resilience:>=20" answers in one call what seven name/type searches cannot. Add
sort to get the highest few instead of a list to scan.

Three different questions about gear, three different tools — mixing them up is the most
common mistake:
- "what do I have" -> search_inventory (the account; instance ids; power, masterwork, dupes)
- "what exists in the game" -> search_items (every item, owned or not; light.gg facets OR DIM query)
- "everything about this one item" -> inspect_item (base stats, every perk each column can
  roll, and the community god rolls for it — works for gear the account has never seen)

Two different god-roll signals, do not conflate them:
- inspect_item = the curated DIM wish list (what reviewers say the roll SHOULD be, with notes).
- lightgg_rolls = REAL usage from light.gg (how many players actually equip each perk). Use it for
  min-maxing and for finding off-meta combos: perkColumns give each column's perks by usage %, and
  traitCombos rank the two trait columns by pick count — top is the community god roll, the long tail
  is the rare combo only dedicated players run (raise combos to mine it). lightgg_rolls takes a name
  directly, so no separate name-to-hash step is needed.

search_items is ONE tool with two ways in. Prefer light.gg FACETS (class, slot, rarity, ammo, breaker,
foundry, season, craftable/enhanceable/deepsight/hasLore, and name = name-or-description text) — that
is light.gg's own item DB and stays current: {rarity:"exotic", ammo:"heavy"}, {foundry:"hakke",
season:29}, {class:"warlock", slot:"helmet", rarity:"exotic"}, {name:"fatebringer"}, all AND-ed. Use
the query param (DIM syntax, manifest-backed) ONLY for what facets cannot express — perk pools and
stat thresholds: "is:handcannon perk:'explosive payload'", "stat:range:>=70 is:pulserifle" with
sort:"stat:range", "is:sniperrifle is:godroll". perk:/is:godroll mean CAN ROLL. If both a query and
facets are passed, query wins. Instance filters (power:, is:masterwork, is:dupe) belong to
search_inventory. Feed a hit into inspect_item for the full item or lightgg_rolls for community usage.

"What's new", "new weapons this season", "new exotics in <expansion>" — new_items lists light.gg's
New Items collections. Call it with no category first to see the current releases' collection slugs
(they rotate each season), then again with a path like "renegades/new-weapons" for those items.

"What loadouts do good players run in X", "popular Trials loadouts", "loadouts using Sunbracers in
GMs" — browse_loadouts reads light.gg's Loadouts DB, real loadouts captured from actual runs (each a
PGCR snapshot). Filter by class, subclass hash, mode (trials/competitive/strikes/any-pvp/any-pve/
solo-lost-sectors), a specific activity/weapon/exotic-armor hash, season, and minScore/maxScore. It
CANNOT sort by popularity — results are newest-first and most have 0 votes — so to surface skilled
play, filter for it: a hard mode/activity PLUS a high minScore (the LLM sets the score bounds). Each
card carries a loadout id; get_loadout returns that loadout's full gear (equipped weapons/armor with
overrides, mods, stat targets, author notes, dim.gg export). Follow up with lightgg_rolls for a
weapon's community god roll.

Judging whether a weapon is good is not yours to guess: the community DIM wish list is indexed
locally and both paths read it.
- Owned copy: search_inventory "is:godroll" (matches plugged, or one perk swap away), then
  get_item_details for the reviewer's write-up on WHY that roll works.
- Any weapon at all, owned or not: inspect_item name:"Fatebringer" -> topRolls (trait
  combinations ranked by how many wish-listed rolls want them), mostWantedPerks (per-column
  vote counts) and notes (the reviewers' own words). Add godrolls:"pvp" to keep only rolls
  whose notes/tags say PvP. Answer "what is the god roll for X" from this, never from memory
  of an older sandbox.

On search_items, perk: and is:godroll mean CAN ROLL — "is:sniperrifle perk:'firing line'" is
every sniper whose loot pool contains it, not one the player owns. Its stats are the
definition's BASE values, before perks and masterwork, so use them to compare frames, then
inspect_item for the perk pool that decides the roll.

Building a loadout end to end: search_builds for what the community runs -> inspect_item on
each exotic and weapon in it for the perks that matter -> search_inventory to see what the
account already has (is:godroll included) -> name the gap that has to drop.

Someone pastes a DIM link (dim.gg/... or the dimLink get_build returns): dim_build reads it. One
call, no account, returns the author's notes, the subclass with its aspects and fragments, weapons,
armor with exotic perks and set bonuses, every mod grouped by slot with its energy cost, and the
artifact perks — that answers "what is special about this build".
To then wear it, drive the writes yourself: the share's instance ids belong to whoever shared it,
so take the HASHES into search_inventory to find the account's own copies, then transfer_item ->
equip_items -> insert_plug (get_item_details with include_plug_options for the socket indexes of
the piece actually being worn). Substitute armor where a piece is missing; never substitute an
exotic or a weapon silently — say what is missing.

For a recurring or scheduled check ("tell me what dropped"), use get_new_items, never
search_inventory with sort:recent. get_new_items keeps a watermark on the server, so it
reports each drop exactly once even though the run that calls it remembers nothing.

"What build should I run", "best Prismatic Titan build", "builds that use Sunbracers" — that is
search_builds, which reads the Mobalytics community/meta build database, NOT the player's account.
It returns preview cards (subclass, super, abilities, aspects, weapons + perks, exotic armor, tags);
get_build then returns that build's full loadout, mods, stat priority, written guide, DIM link and
video guide. Do not describe a build from memory when these two calls have the current one.

For "what should I do today", "what are my ranks" or "did I do my weekly", use get_progress.
get_milestones only knows the PUBLIC weekly reset list — it cannot tell you what THIS account
has already cleared.

Pick the right tool:
- Names/descriptions for a hash: get_definition. It reads a local copy of the
  manifest — instant and far smaller than fetching /Destiny2/Manifest/ over the API.
- Which Bungie endpoint exists: list_endpoints then describe_endpoint. Do not go
  read the online API docs.
- bungie_api_call is a last resort for endpoints no other tool covers.

Before socketing mods, call get_item_details with include_plug_options and a
socket_index — it tells you exactly what that socket accepts. Do not guess indexes.

Equipping and socketing only work when the character is in orbit, in a social
space, or offline. "You must either be logged off or in orbit" means the player
is in an activity, not that the call was wrong. get_session_state answers this in
one call — do not go work it out from the profile.

GET responses are cached for 60s, so re-reading something you just read is cheap,
and any write clears the cache.`;

function buildServer(): McpServer {
  // Bump on any tool-schema change — some clients cache the tool list and key it on version.
  const server = new McpServer({ name: 'destiny2', version: '1.18.0' }, { instructions: INSTRUCTIONS });
  registerReadTools(server);
  registerWriteTools(server);
  registerRawTool(server);
  registerProgressTools(server);
  registerBuildTools(server);
  registerCatalogTools(server);
  registerDimTools(server);
  registerLightggTools(server);
  return server;
}

async function main() {
  for (const k of ['apiKey', 'clientId', 'clientSecret'] as const) {
    if (!config[k]) {
      console.error(`Missing Bungie credential in .env (see .env.example). Missing: ${k}`);
      process.exit(1);
    }
  }

  await openManifest();
  refreshWishlistIfStale(); // background: resolving wish-list perk hashes needs the manifest open

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/mcp', async (req, res) => {
    const t0 = Date.now();
    let bytes = 0;
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = ((chunk: any, ...a: any[]) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...a); }) as any;
    res.end = ((chunk: any, ...a: any[]) => { if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk); return end(chunk, ...a); }) as any;
    res.on('close', () => logCalls(req.body, bytes, Date.now() - t0));

    // ponytail: stateless — fresh server+transport per request, no session bookkeeping
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'POST only (stateless mode)' }); });

  app.listen(config.port, '127.0.0.1', () => {
    console.log(`MCP endpoint: http://localhost:${config.port}/mcp`);
    const t = readTokens();
    if (!t) console.log(`Not authenticated yet — open https://localhost:${config.authPort}/auth`);
    else if (Date.now() > t.refreshExpiresAt - 7 * 24 * 3600 * 1000) {
      console.warn(`WARNING: Bungie refresh token expires soon — re-auth at https://localhost:${config.authPort}/auth`);
    }
  });

  startAuthServer();
}

main().catch((e) => { console.error(e); process.exit(1); });
