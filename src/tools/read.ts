import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName, getDef, searchDefs } from '../manifest.js';
import { SEARCH_COMPONENTS, buildItems, compileQuery, sortItems, statValue, type SearchItem } from '../search/index.js';
import { tool } from './util.js';

export function itemSummary(item: any, instances?: Record<string, any>) {
  const def = getDef('DestinyInventoryItemDefinition', item.itemHash);
  const inst = item.itemInstanceId ? instances?.[item.itemInstanceId] : undefined;
  return {
    name: def?.displayProperties?.name ?? `#${item.itemHash}`,
    itemHash: item.itemHash,
    itemInstanceId: item.itemInstanceId,
    type: def?.itemTypeDisplayName,
    tier: def?.inventory?.tierTypeName,
    power: inst?.primaryStat?.value,
    quantity: item.quantity > 1 ? item.quantity : undefined,
  };
}

export function formatSales(sales: Record<string, any>) {
  return Object.values<any>(sales).map((s) => ({
    name: defName('DestinyInventoryItemDefinition', s.itemHash),
    itemHash: s.itemHash,
    vendorItemIndex: s.vendorItemIndex,
    costs: (s.costs ?? []).map((c: any) => `${c.quantity} ${defName('DestinyInventoryItemDefinition', c.itemHash)}`),
  }));
}

// The fields a model actually reasons over. Raw defs are ~4KB each, mostly icons/UI plumbing.
export function trimDef(d: any) {
  return {
    hash: d.hash,
    name: d.displayProperties?.name,
    description: d.displayProperties?.description || undefined,
    type: d.itemTypeDisplayName || undefined,
    tier: d.inventory?.tierTypeName || undefined,
    energyCost: d.plug?.energyCost?.energyCost,
    plugCategory: d.plug?.plugCategoryIdentifier,
    perks: (d.perks ?? [])
      .map((p: any) => getDef('DestinySandboxPerkDefinition', p.perkHash)?.displayProperties?.description)
      .filter(Boolean),
  };
}

export function parseBungieName(full: string): { displayName: string; displayNameCode: number } {
  const i = full.lastIndexOf('#');
  const code = Number(full.slice(i + 1));
  if (i < 1 || !Number.isInteger(code)) throw new Error(`Bungie names look like "Name#1234", got "${full}"`);
  return { displayName: full.slice(0, i), displayNameCode: code };
}

const profilePath = async () => {
  const a = await getAccount();
  return `/Destiny2/${a.membershipType}/Profile/${a.membershipId}`;
};

// Orbit's activity def exists but has an empty name, so the hash is the only usable signal.
const ORBIT_ACTIVITY_HASH = 82913930;
// modeType 40 is "Social" in DestinyActivityModeDefinition — Tower, Farm, every hub.
const SOCIAL_MODE_TYPE = 40;

export function registerReadTools(server: McpServer): void {
  server.registerTool('get_profile', {
    description: 'Destiny 2 account overview: who the player is (Bungie name, membership), characters (class, power, race, playtime), currencies like Glimmer.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const a = await getAccount();
    const r = await bungieFetch<any>(`${await profilePath()}/`, { auth: true, query: { components: '100,200,103' } });
    return {
      bungieName: a.bungieName,
      membershipId: a.membershipId,
      membershipType: a.membershipType,
      characters: Object.values<any>(r.characters.data).map((c) => ({
        characterId: c.characterId,
        class: defName('DestinyClassDefinition', c.classHash),
        power: c.light,
        race: defName('DestinyRaceDefinition', c.raceHash),
        lastPlayed: c.dateLastPlayed,
        hoursPlayed: Math.round(Number(c.minutesPlayedTotal) / 60),
      })),
      currencies: (r.profileCurrencies?.data?.items ?? []).map((i: any) => ({
        name: defName('DestinyInventoryItemDefinition', i.itemHash),
        quantity: i.quantity,
      })),
    };
  }));

  server.registerTool('get_session_state', {
    description: 'Whether the player is online and which writes are allowed RIGHT NOW. Equipping and socketing only work in orbit, a social space, or offline; transfers, locks and postmaster pulls always work. Call this once before a write instead of probing the profile to work it out.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, { auth: true, query: { components: '200,204,1000' } });
    const chars = Object.values<any>(r.characters?.data ?? {});
    // profileTransitoryData only exists while the account is actually in a game session.
    const online = !!r.profileTransitoryData?.data;
    // Only ONE character can be in an activity, and the others report currentActivityHash 0 —
    // so "any character is in orbit" would say writes are fine while the played character raids.
    // Bungie also leaves stale nonzero hashes behind after logoff, which rules out counting
    // nonzero hashes; dateLastPlayed is the one signal that survives both cases.
    const active = chars.reduce<any>((a, c) => (!a || c.dateLastPlayed > a.dateLastPlayed ? c : a), null);
    const hash: number = (active && r.characterActivities?.data?.[active.characterId]?.currentActivityHash) || 0;
    const def = hash ? getDef('DestinyActivityDefinition', hash) : undefined;

    // Anything we cannot positively classify fails closed: a wrong "go ahead" costs a failed write.
    const [state, reason] =
      !online ? ['offline', 'Not in a game session — writes are unrestricted.'] as const
      : !active ? ['unknown', 'In a game session but no character could be identified.'] as const
      : hash === ORBIT_ACTIVITY_HASH ? ['orbit', 'Active character is in orbit.'] as const
      : def?.directActivityModeType === SOCIAL_MODE_TYPE
        ? ['social', `Active character is in a social space (${def.displayProperties?.name || 'unnamed'}).`] as const
      : def ? ['activity', `Active character is in ${def.displayProperties?.name || 'an activity'} — equip and socket writes will be refused.`] as const
      : ['unknown', 'In a game session but the current activity could not be resolved.'] as const;

    const restricted = state === 'offline' || state === 'orbit' || state === 'social';
    return {
      online,
      activeCharacterId: active?.characterId,
      state,
      activity: hash ? { hash, name: def?.displayProperties?.name || (state === 'orbit' ? 'Orbit' : undefined) } : undefined,
      writeCapabilities: {
        equip: restricted, socket: restricted,
        transfer: true, lock: true, postmaster: true,
      },
      reason,
      characters: chars.map((c) => ({ characterId: c.characterId, active: c.characterId === active?.characterId })),
    };
  }));

  server.registerTool('get_character', {
    description: 'One character in detail: stats (Mobility etc.) and all currently equipped items with power.',
    inputSchema: z.object({ character_id: z.string().describe('From get_profile') }),
  }, tool(async ({ character_id }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/`, {
      auth: true, query: { components: '200,205,300' },
    });
    const c = r.character.data;
    return {
      class: defName('DestinyClassDefinition', c.classHash),
      power: c.light,
      stats: Object.fromEntries(Object.entries(c.stats).map(([h, v]) => [defName('DestinyStatDefinition', Number(h)), v])),
      equipped: r.equipment.data.items.map((i: any) => itemSummary(i, r.itemComponents?.instances?.data)),
    };
  }));

  server.registerTool('search_inventory', {
    description: `Search ALL items across every character and the vault with DIM search syntax. Returns the instance ids that transfer/equip/insert_plug need.

One query replaces several searches — combine every condition instead of calling this per slot.
Filters: is:<keyword> (rarity, element, ammo, class, weapon/armor type, locked/masterwork/crafted/dupe/invault/equipped/postmaster), name:, description:, perk:, type:, power:<comparison>, stat:<name>:<comparison>, count:. Combine with spaces (and), "or", "-" or "not" to negate, and parentheses.
Examples:
  is:armor is:hunter -is:exotic stat:resilience:>=20
  is:weapon is:solar perk:incandescent is:masterwork
  (is:handcannon or is:smg) is:legendary power:>=1800
  is:dupe is:legendary -is:locked

Answer in ONE call instead of paging:
  count_only — just the number, no items
  group_by — counts per itemHash/name/type/tier/location over EVERY match, not just the page. Use itemHash for dupe audits; several distinct items share a name.
  queries — several searches against one inventory snapshot, e.g. [{"id":"vault","query":"is:invault","count_only":true},{"id":"chars","query":"-is:invault","count_only":true}]`,
    inputSchema: z.object({
      query: z.string().optional().describe('DIM search query. Omit to list everything.'),
      sort: z.string().optional().describe('"power", "name", "recent", "quantity" or "stat:<name>" — numeric sorts are highest first, applied before limit. "recent" is newest-acquired first (DIM item-feed order), the answer to "what did I just get".'),
      // Clamped, not rejected: a model guessing limit:500 should get 200 items, not a wasted turn
      limit: z.number().int().min(1).transform((n) => Math.min(n, 200)).default(50),
      count_only: z.boolean().default(false).describe('Return only the match count'),
      group_by: z.enum(['itemHash', 'name', 'type', 'tier', 'location']).optional()
        .describe('Return counts per group instead of items, computed over all matches'),
      group_limit: z.number().int().min(1).transform((n) => Math.min(n, 500)).default(50),
      queries: z.array(z.object({
        id: z.string(),
        query: z.string(),
        count_only: z.boolean().default(false),
      })).min(1).max(10).optional().describe('Run several searches against one snapshot. Replaces query/sort.'),
    }),
  }, tool(async ({ query, sort, limit, count_only, group_by, group_limit, queries }) => {
    // Compile first: a bad query should cost no API call, and should come back as the keyword list.
    const plan = (q?: string) => {
      const { predicate, statsUsed, usedPerks } = compileQuery(q ?? '');
      return {
        predicate,
        showStats: statsUsed,
        perkTerms: usedPerks && q ? [...q.matchAll(/perk(?:name)?:("[^"]*"|'[^']*'|\S+)/gi)]
          .map((m) => m[1].replace(/^['"]|['"]$/g, '').toLowerCase()) : [],
      };
    };
    const compiled = queries?.map((q) => ({ ...q, ...plan(q.query) })) ?? [];
    const single = queries ? undefined : plan(query);
    const sortStat = !queries && sort?.toLowerCase().startsWith('stat:')
      ? sort.slice(5).toLowerCase().replace(/[^a-z0-9.]/g, '') : undefined;
    if (!queries && sort) sortItems([], sort); // validate before spending an API call on a query we can't answer

    const r = await bungieFetch<any>(`${await profilePath()}/`, {
      auth: true, query: { components: SEARCH_COMPONENTS },
    });
    const all = buildItems(r);

    const groupsOf = (matches: SearchItem[]) => {
      const counts = new Map<string, { key: string; itemHash?: number; name?: string; count: number }>();
      for (const i of matches) {
        const key = group_by === 'itemHash' ? String(i.itemHash) : String(i[group_by!] ?? 'Unknown');
        const g = counts.get(key) ?? { key, count: 0, ...(group_by === 'itemHash' ? { itemHash: i.itemHash, name: i.name } : {}) };
        g.count++;
        counts.set(key, g);
      }
      const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
      return { groupTotal: sorted.length, truncated: sorted.length > group_limit, groups: sorted.slice(0, group_limit) };
    };

    const project = (matches: SearchItem[], p: { showStats: string[]; perkTerms: string[] }) => {
      // Echo back only the stats and perks the query asked about — everything else is wasted context.
      const showStats = [...new Set([...p.showStats, ...(sortStat ? [sortStat] : [])])];
      return matches.slice(0, limit).map((i) => ({
        name: i.name,
        itemHash: i.itemHash,
        itemInstanceId: i.itemInstanceId,
        type: i.type,
        tier: i.tier,
        power: i.power,
        quantity: i.quantity > 1 ? i.quantity : undefined,
        location: i.location,
        characterId: i.characterId,
        stats: showStats.length ? Object.fromEntries(showStats.map((s) => [s, statValue(i, s)])) : undefined,
        perks: p.perkTerms.length ? i.plugs.filter((pl) => p.perkTerms.some((t) => pl.includes(t))) : undefined,
      }));
    };

    if (queries) {
      return {
        results: compiled.map((c) => {
          const matches = all.filter(c.predicate);
          if (c.count_only) return { id: c.id, total: matches.length };
          const items = project(matches, c);
          return { id: c.id, count: items.length, total: matches.length, items };
        }),
      };
    }

    let matches = all.filter(single!.predicate);
    const total = matches.length;
    if (count_only) return { total };
    if (group_by) return { total, ...groupsOf(matches) };
    if (sort) matches = sortItems(matches, sort);
    const items = project(matches, single!);
    return { count: items.length, total, items };
  }));

  server.registerTool('get_item_details', {
    description: 'Full detail for item instances: perks/mods in each socket (with socket indexes for insert_plug), stats, energy. Pass every instance id you care about in one call — do not call this once per item. Set include_plug_options to also list what each socket ACCEPTS (bigger response — pair it with socket_index, and with few ids), so you never have to guess a socket index. Options are paged: raise option_limit and walk nextOffset to see every one (shader/ornament sockets have 700+).',
    inputSchema: z.object({
      item_instance_ids: z.array(z.string()).min(1).max(15),
      include_plug_options: z.boolean().default(false).describe('List insertable plugs per socket (much bigger response)'),
      socket_index: z.number().int().min(0).optional().describe('Limit plug options to this one socket — much smaller than listing every socket'),
      option_limit: z.number().int().min(1).transform((n) => Math.min(n, 200)).default(12)
        .describe('Plug options per socket, max 200. Pair a high value with socket_index.'),
      option_offset: z.number().int().min(0).default(0).describe('Skip this many options — feed it the nextOffset from the last call'),
    }),
  }, tool(async ({ item_instance_ids, include_plug_options, socket_index, option_limit, option_offset }) => {
    // One bad id must not lose the other 14 — report it in place and keep going.
    const one = async (item_instance_id: string) => {
      const r = await bungieFetch<any>(`${await profilePath()}/Item/${item_instance_id}/`, {
        auth: true, query: { components: include_plug_options ? '300,302,304,305,307,310' : '300,302,304,305,307' },
      });
      const inst = r.instance?.data;
      const reusable: Record<string, any[]> = r.reusablePlugs?.data?.plugs ?? {};
      const socketEntries: any[] = getDef('DestinyInventoryItemDefinition', r.item?.data?.itemHash ?? 0)?.sockets?.socketEntries ?? [];
      // Default of 12 options/socket keeps shader/ornament sockets (700+ entries) from blowing up a
      // whole-item response; option_offset/nextOffset make the rest reachable when you actually want them.
      const options = (i: number) => {
        if (!include_plug_options || (socket_index !== undefined && i !== socket_index)) return undefined;
        // The API only fills reusablePlugs for weapon-style sockets; armor mods and subclass
        // fragments have to come from the manifest plug set the socket points at.
        let hashes: number[] = (reusable[String(i)] ?? []).filter((p: any) => p.canInsert).map((p: any) => p.plugItemHash);
        if (!hashes.length) {
          const e = socketEntries[i] ?? {};
          const setHash = e.reusablePlugSetHash ?? e.randomizedPlugSetHash;
          const fromSet = setHash
            ? (getDef('DestinyPlugSetDefinition', setHash)?.reusablePlugItems ?? [])
            : (e.reusablePlugItems ?? []);
          hashes = fromSet.filter((p: any) => p.currentlyCanRoll !== false).map((p: any) => p.plugItemHash);
        }
        // Plug sets carry several hashes per name (energy tiers, legacy copies) — one per name is enough to pick from.
        // Nameless plugs are hidden intrinsics the game never offers; listing them as "#969663972" is pure noise.
        const byName = new Map<string, number>();
        for (const h of hashes) {
          const n = getDef('DestinyInventoryItemDefinition', h)?.displayProperties?.name;
          if (n && !byName.has(n)) byName.set(n, h);
        }
        const uniq = [...byName].map(([name, hash]) => ({ hash, name }));
        const page = uniq.slice(option_offset, option_offset + option_limit);
        const seen = option_offset + page.length;
        return {
          options: page,
          optionTotal: uniq.length,
          optionOffset: option_offset,
          moreOptions: uniq.length - seen || undefined,
          nextOffset: seen < uniq.length ? seen : null,
        };
      };
      return {
        itemInstanceId: item_instance_id,
        name: defName('DestinyInventoryItemDefinition', r.item?.data?.itemHash ?? 0),
        power: inst?.primaryStat?.value,
        energy: inst?.energy ? { used: inst.energy.energyUsed, capacity: inst.energy.energyCapacity } : undefined,
        stats: Object.fromEntries(Object.entries<any>(r.stats?.data?.stats ?? {})
          .map(([h, s]) => [defName('DestinyStatDefinition', Number(h)), s.value])),
        sockets: (r.sockets?.data?.sockets ?? []).map((s: any, i: number) => ({
          socketIndex: i,
          plug: (s.plugHash && getDef('DestinyInventoryItemDefinition', s.plugHash)?.displayProperties?.name) || null,
          plugHash: s.plugHash,
          enabled: s.isEnabled,
          ...options(i),
        })),
      };
    };

    const out = [];
    for (const id of item_instance_ids) {
      try { out.push(await one(id)); }
      catch (e: any) { out.push({ itemInstanceId: id, error: e?.message ?? String(e) }); }
    }
    return out;
  }));

  server.registerTool('get_vendors', {
    description: 'List all currently available vendors (Xur, Banshee-44, Ada-1...) with refresh times. Use get_vendor_items for stock.',
    inputSchema: z.object({
      character_id: z.string().describe('Vendors are per-character; from get_profile'),
      include_submenus: z.boolean().default(false)
        .describe('Also return the subclass/kiosk sub-vendors ("Aspects", "Melees", "Armor"...) — ~5x more entries, rarely what you want'),
    }),
  }, tool(async ({ character_id, include_submenus }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/Vendors/`, {
      auth: true, query: { components: '400' },
    });
    return Object.values<any>(r.vendors.data)
      .map((v) => {
        const def = getDef('DestinyVendorDefinition', v.vendorHash);
        return {
          vendorHash: v.vendorHash,
          name: def?.displayProperties?.name || `#${v.vendorHash}`,
          // Real NPCs carry a title ("Agent of the Nine"); the subclass/kiosk submenus that
          // make up most of the ~200 records have none. That is the only reliable split.
          subtitle: def?.displayProperties?.subtitle || undefined,
          nextRefresh: v.nextRefreshDate,
          enabled: v.enabled,
        };
      })
      .filter((v) => !v.name.startsWith('#') && (include_submenus || v.subtitle));
  }));

  server.registerTool('get_vendor_items', {
    description: "One vendor's current stock with costs. vendor_hash from get_vendors (Xur: 2190858386).",
    inputSchema: z.object({ character_id: z.string(), vendor_hash: z.number().int() }),
  }, tool(async ({ character_id, vendor_hash }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/Vendors/${vendor_hash}/`, {
      auth: true, query: { components: '402' },
    });
    return {
      vendor: defName('DestinyVendorDefinition', vendor_hash),
      items: formatSales(r.sales?.data ?? {}),
    };
  }));

  server.registerTool('get_loadouts', {
    description: 'In-game loadout slots per character. loadout_index feeds equip_loadout / snapshot_loadout.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, { auth: true, query: { components: '206,200' } });
    const chars = r.characters.data;
    return Object.entries<any>(r.characterLoadouts?.data ?? {}).map(([cid, l]) => ({
      characterId: cid,
      class: defName('DestinyClassDefinition', chars[cid].classHash),
      loadouts: l.loadouts.map((lo: any, i: number) => {
        // Bungie always sends 16 slots; unused ones are full of "0" ids and an unset nameHash
        // (2166136261 — the FNV-1a basis, which has no LoadoutNameDefinition row).
        const ids = (lo.items ?? []).map((it: any) => it.itemInstanceId).filter((id: string) => id && id !== '0');
        return {
          loadoutIndex: i,
          name: getDef('DestinyLoadoutNameDefinition', lo.nameHash)?.displayProperties?.name ?? null,
          empty: !ids.length,
          itemInstanceIds: ids,
        };
      }),
    }));
  }));

  server.registerTool('get_milestones', {
    description: 'Current weekly milestones/activities across the game (public info, no character needed).',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>('/Destiny2/Milestones/');
    return Object.values<any>(r)
      .map((m) => {
        const def = getDef('DestinyMilestoneDefinition', m.milestoneHash);
        return def?.displayProperties?.name
          ? { name: def.displayProperties.name, description: def.displayProperties.description, ends: m.endDate }
          : null;
      })
      .filter(Boolean);
  }));

  server.registerTool('get_activity_history', {
    description: 'Recent completed activities for a character. mode: 0=all, 5=PvP, 7=PvE, 4=raid, 82=dungeon, 84=Trials, 46=GM nightfall.',
    inputSchema: z.object({
      character_id: z.string(),
      mode: z.number().int().default(0),
      count: z.number().int().min(1).max(50).default(10),
    }),
  }, tool(async ({ character_id, mode, count }) => {
    const a = await getAccount();
    const r = await bungieFetch<any>(
      `/Destiny2/${a.membershipType}/Account/${a.membershipId}/Character/${character_id}/Stats/Activities/`,
      { auth: true, query: { mode, count, page: 0 } },
    );
    return (r.activities ?? []).map((act: any) => ({
      date: act.period,
      activity: defName('DestinyActivityDefinition', act.activityDetails.directorActivityHash),
      completed: act.values.completed?.basic?.displayValue,
      kills: act.values.kills?.basic?.value,
      deaths: act.values.deaths?.basic?.value,
      kd: act.values.killsDeathsRatio?.basic?.displayValue,
      standing: act.values.standing?.basic?.displayValue,
    }));
  }));

  server.registerTool('get_stats', {
    description: 'Lifetime account stats, split PvE / PvP: kills, K/D, activities cleared, time played, and more.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Account/${a.membershipId}/Stats/`, {
      auth: true, query: { groups: 'General' },
    });
    const prune = (side: any) =>
      Object.fromEntries(Object.entries<any>(side?.allTime ?? {}).map(([k, v]) => [k, v.basic.displayValue]));
    return {
      pve: prune(r.mergedAllCharacters?.results?.allPvE),
      pvp: prune(r.mergedAllCharacters?.results?.allPvP),
    };
  }));

  server.registerTool('get_clan', {
    description: "The account's clan: name, motto, member count, online members.",
    inputSchema: z.object({}),
  }, tool(async () => {
    const a = await getAccount();
    const g = await bungieFetch<any>(`/GroupV2/User/${a.membershipType}/${a.membershipId}/0/1/`, { auth: true });
    const group = g.results?.[0]?.group;
    if (!group) return 'Not in a clan.';
    const members = await bungieFetch<any>(`/GroupV2/${group.groupId}/Members/`);
    return {
      name: group.name,
      motto: group.motto,
      about: group.about,
      memberCount: group.memberCount,
      members: (members.results ?? []).map((m: any) => ({
        name: `${m.destinyUserInfo.bungieGlobalDisplayName}#${m.destinyUserInfo.bungieGlobalDisplayNameCode}`,
        online: m.isOnline,
      })),
    };
  }));

  server.registerTool('search_player', {
    description: 'Find any player by full Bungie name ("Guardian#1234") → their membership ids.',
    inputSchema: z.object({ bungie_name: z.string() }),
  }, tool(async ({ bungie_name }) => {
    const r = await bungieFetch<any>('/Destiny2/SearchDestinyPlayerByBungieName/-1/', {
      method: 'POST', body: parseBungieName(bungie_name),
    });
    return (r ?? []).map((p: any) => ({
      membershipType: p.membershipType,
      membershipId: p.membershipId,
      name: `${p.bungieGlobalDisplayName}#${p.bungieGlobalDisplayNameCode}`,
    }));
  }));

  server.registerTool('search_manifest', {
    description: 'Look up any Destiny definition by name → hash. Items by default; set table for perks (DestinySandboxPerkDefinition), activities (DestinyActivityDefinition), etc.',
    inputSchema: z.object({
      query: z.string(),
      table: z.string().default('DestinyInventoryItemDefinition'),
      limit: z.number().int().min(1).transform((n) => Math.min(n, 100)).default(25),
    }),
  }, tool(async ({ query, table, limit }) => searchDefs(query, table, limit)));

  server.registerTool('get_definition', {
    description: 'Look up definitions by hash from the LOCAL manifest — instant, no network. Use this instead of bungie_api_call on /Destiny2/Manifest/... paths, and batch every hash you need into one call.',
    inputSchema: z.object({
      hashes: z.array(z.number().int()).min(1).max(50),
      table: z.string().default('DestinyInventoryItemDefinition'),
      full: z.boolean().default(false).describe('Raw definition instead of the trimmed one — ~4KB each, use for at most 1-2 hashes'),
    }),
  }, tool(async ({ hashes, table, full }) => hashes.map((h) => {
    const d = getDef(table, h);
    if (!d) return { hash: h, error: `not found in ${table}` };
    return full ? d : trimDef(d);
  })));
}
