import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName, getDef } from '../manifest.js';
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

const profilePath = async () => {
  const a = await getAccount();
  return `/Destiny2/${a.membershipType}/Profile/${a.membershipId}`;
};

export function registerReadTools(server: McpServer): void {
  server.registerTool('get_profile', {
    description: 'Destiny 2 account overview: characters (class, power, race, playtime), currencies like Glimmer.',
    inputSchema: z.object({}),
  }, tool(async () => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, { auth: true, query: { components: '100,200,103' } });
    return {
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
    description: 'Search ALL items across every character and the vault. Filter by name and/or item type substring (e.g. "Rocket Launcher", "Helmet"). Returns instance ids needed by transfer/equip tools.',
    inputSchema: z.object({
      name: z.string().optional().describe('Case-insensitive name substring'),
      type: z.string().optional().describe('Case-insensitive item type substring, e.g. "Hand Cannon"'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  }, tool(async ({ name, type, limit }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/`, {
      auth: true, query: { components: '102,201,205,200,300' },
    });
    const chars = r.characters.data;
    const instances = r.itemComponents?.instances?.data;
    const locName = (cid: string, equipped: boolean) =>
      `${defName('DestinyClassDefinition', chars[cid].classHash)}${equipped ? ' (equipped)' : ''}`;
    const all: any[] = [
      ...(r.profileInventory?.data?.items ?? []).map((i: any) => ({ ...i, location: 'Vault' })),
      ...Object.entries<any>(r.characterInventories?.data ?? {}).flatMap(([cid, inv]) =>
        inv.items.map((i: any) => ({ ...i, location: locName(cid, false), characterId: cid }))),
      ...Object.entries<any>(r.characterEquipment?.data ?? {}).flatMap(([cid, inv]) =>
        inv.items.map((i: any) => ({ ...i, location: locName(cid, true), characterId: cid }))),
    ];
    const nameQ = name?.toLowerCase(), typeQ = type?.toLowerCase();
    const out = [];
    for (const item of all) {
      const s = { ...itemSummary(item, instances), location: item.location, characterId: item.characterId };
      if (nameQ && !s.name.toLowerCase().includes(nameQ)) continue;
      if (typeQ && !(s.type ?? '').toLowerCase().includes(typeQ)) continue;
      out.push(s);
      if (out.length >= limit) break;
    }
    return { count: out.length, items: out };
  }));

  server.registerTool('get_item_details', {
    description: 'Full detail for one item instance: perks/mods in each socket (with socket indexes for insert_plug), stats, energy.',
    inputSchema: z.object({ item_instance_id: z.string() }),
  }, tool(async ({ item_instance_id }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Item/${item_instance_id}/`, {
      auth: true, query: { components: '300,302,304,305' },
    });
    const inst = r.instance?.data;
    return {
      name: defName('DestinyInventoryItemDefinition', r.item?.data?.itemHash ?? 0),
      power: inst?.primaryStat?.value,
      energy: inst?.energy ? { used: inst.energy.energyUsed, capacity: inst.energy.energyCapacity } : undefined,
      stats: Object.fromEntries(Object.entries<any>(r.stats?.data?.stats ?? {})
        .map(([h, s]) => [defName('DestinyStatDefinition', Number(h)), s.value])),
      sockets: (r.sockets?.data?.sockets ?? []).map((s: any, i: number) => ({
        socketIndex: i,
        plug: s.plugHash ? defName('DestinyInventoryItemDefinition', s.plugHash) : null,
        plugHash: s.plugHash,
        enabled: s.isEnabled,
      })),
    };
  }));

  server.registerTool('get_vendors', {
    description: 'List all currently available vendors (Xur, Banshee-44, Ada-1...) with refresh times. Use get_vendor_items for stock.',
    inputSchema: z.object({ character_id: z.string().describe('Vendors are per-character; from get_profile') }),
  }, tool(async ({ character_id }) => {
    const r = await bungieFetch<any>(`${await profilePath()}/Character/${character_id}/Vendors/`, {
      auth: true, query: { components: '400' },
    });
    return Object.values<any>(r.vendors.data)
      .map((v) => ({
        vendorHash: v.vendorHash,
        name: defName('DestinyVendorDefinition', v.vendorHash),
        nextRefresh: v.nextRefreshDate,
        enabled: v.enabled,
      }))
      .filter((v) => !v.name.startsWith('#'));
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
      loadouts: l.loadouts.map((lo: any, i: number) => ({
        loadoutIndex: i,
        name: defName('DestinyLoadoutNameDefinition', lo.nameHash),
        empty: !lo.items?.length,
        itemInstanceIds: (lo.items ?? []).map((it: any) => it.itemInstanceId),
      })),
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
}
