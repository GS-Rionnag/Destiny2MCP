import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { BungieError, bungieFetch, getAccount } from '../bungie.js';
import { defName, eachDef, firstHash, getDef, searchDefs } from '../manifest.js';
import { socketPlugPool, tool } from './util.js';

const ACTIONS = '/Destiny2/Actions';

// Loadout names are not free text — the game only allows 22 fixed words, each its own definition
// row (with the name at the top level, not under displayProperties).
export function resolveLoadoutName(name: string): number {
  const rows = eachDef('DestinyLoadoutNameDefinition');
  const hit = rows.find((d) => d.name?.toLowerCase() === name.toLowerCase());
  if (!hit) {
    throw new Error(
      `Loadout names come from a fixed in-game list — "${name}" is not on it. Pick one of: ${rows.map((d) => d.name).join(', ')}`);
  }
  return hit.hash;
}

/** Bungie's update endpoint takes all three identifiers, so read the current ones and merge. */
async function currentLoadout(characterId: string, index: number) {
  const a = await getAccount();
  const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
    auth: true, query: { components: '206' },
  });
  const loadouts = r.characterLoadouts?.data?.[characterId]?.loadouts;
  if (!loadouts) throw new Error(`No loadouts for character ${characterId} — check character_id.`);
  const lo = loadouts[index];
  if (!lo) throw new Error(`Loadout index ${index} does not exist (character has ${loadouts.length} slots).`);
  return lo;
}

export function resolvePlugHash(plug: string, socketPool?: number[]): number {
  if (/^\d+$/.test(plug)) return Number(plug);
  // Many plug names map to several manifest rows (legacy vs current mod variants, 42 different
  // "Empty Mod Socket"s) — only the socket's own option list knows which hash this item accepts.
  const q = plug.toLowerCase();
  for (const h of socketPool ?? []) {
    if (getDef('DestinyInventoryItemDefinition', h)?.displayProperties?.name?.toLowerCase() === q) return h;
  }
  const hit = searchDefs(plug, 'DestinyInventoryItemDefinition', 1)[0];
  if (!hit) throw new Error(`No mod/perk named "${plug}" found. Use search_manifest to find the exact name.`);
  return hit.hash;
}

async function post(path: string, body: Record<string, unknown>) {
  const a = await getAccount();
  return bungieFetch(path, { method: 'POST', auth: true, body: { ...body, membershipType: a.membershipType } });
}

const plugSchema = z.object({ socket_index: z.number().int().min(0), plug: z.string() });

// One failing socket must not abandon the rest of the loadout — report per plug instead.
async function insertPlugs(itemId: string, characterId: string, plugs: z.infer<typeof plugSchema>[]) {
  const out: string[] = [];
  let reusable: Record<string, any[]> = {};
  let socketEntries: any[] = [];
  try {
    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/Item/${itemId}/`, {
      auth: true, query: { components: '307,310' },
    });
    reusable = r.reusablePlugs?.data?.plugs ?? {};
    socketEntries = getDef('DestinyInventoryItemDefinition', r.item?.data?.itemHash ?? 0)?.sockets?.socketEntries ?? [];
  } catch { /* item unreadable — names fall back to the global search below */ }
  for (const p of plugs) {
    let plugItemHash = 0;
    try {
      plugItemHash = resolvePlugHash(p.plug, socketPlugPool(reusable, socketEntries, p.socket_index));
      await post(`${ACTIONS}/Items/InsertSocketPlugFree/`, {
        plug: { socketIndex: p.socket_index, socketArrayType: 0, plugItemHash },
        itemId, characterId,
      });
      out.push(`Socket ${p.socket_index} → ${defName('DestinyInventoryItemDefinition', plugItemHash)} (${plugItemHash}).`);
    } catch (e: any) {
      const sent = plugItemHash ? ` inserting ${defName('DestinyInventoryItemDefinition', plugItemHash)} (${plugItemHash})` : '';
      const detail = e instanceof BungieError ? `${e.errorStatus}: ${e.message}` : `${e?.message ?? e}`;
      out.push(`Socket ${p.socket_index} FAILED${sent}: ${detail}`);
    }
  }
  return out;
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool('transfer_item', {
    description: 'Move an item between a character and the vault. Get item_instance_id + item_hash from search_inventory. To move char→char: transfer to vault first, then vault→other char.',
    inputSchema: z.object({
      item_instance_id: z.string(),
      item_hash: z.number().int(),
      character_id: z.string().describe('Source character when to_vault, destination when from vault'),
      to_vault: z.boolean(),
      stack_size: z.number().int().default(1),
    }),
  }, tool(async ({ item_instance_id, item_hash, character_id, to_vault, stack_size }) => {
    await post(`${ACTIONS}/Items/TransferItem/`, {
      itemReferenceHash: item_hash, stackSize: stack_size, transferToVault: to_vault,
      itemId: item_instance_id, characterId: character_id,
    });
    return `Transferred ${defName('DestinyInventoryItemDefinition', item_hash)} ${to_vault ? 'to vault' : 'to character'}.`;
  }));

  server.registerTool('equip_item', {
    description: 'Equip one item on a character. Only works in orbit/social spaces or offline (Bungie restriction).',
    inputSchema: z.object({ item_instance_id: z.string(), character_id: z.string() }),
  }, tool(async ({ item_instance_id, character_id }) => {
    await post(`${ACTIONS}/Items/EquipItem/`, { itemId: item_instance_id, characterId: character_id });
    return 'Equipped.';
  }));

  server.registerTool('equip_items', {
    description: 'Equip several items at once on a character (full loadout swap). Same location restriction as equip_item.',
    inputSchema: z.object({ item_instance_ids: z.array(z.string()).min(1).max(20), character_id: z.string() }),
  }, tool(async ({ item_instance_ids, character_id }) => {
    const r: any = await post(`${ACTIONS}/Items/EquipItems/`, { itemIds: item_instance_ids, characterId: character_id });
    return (r.equipResults ?? []).map((e: any) => ({
      itemInstanceId: e.itemInstanceId,
      ok: e.equipStatus === 1,
      status: e.equipStatus,
    }));
  }));

  server.registerTool('equip_loadout', {
    description: 'Apply a saved in-game loadout slot. Get loadout_index from get_loadouts.',
    inputSchema: z.object({ loadout_index: z.number().int().min(0), character_id: z.string() }),
  }, tool(async ({ loadout_index, character_id }) => {
    await post(`${ACTIONS}/Loadouts/EquipLoadout/`, { loadoutIndex: loadout_index, characterId: character_id });
    return 'Loadout equipped.';
  }));

  server.registerTool('snapshot_loadout', {
    description: "Save the character's CURRENT equipment into an in-game loadout slot (overwrites that slot).",
    inputSchema: z.object({
      loadout_index: z.number().int().min(0),
      character_id: z.string(),
      name: z.string().optional().describe('One of the fixed in-game names, e.g. "Raid", "PvP", "Prismatic"'),
      name_hash: z.number().int().optional().describe('DestinyLoadoutNameDefinition hash; use name instead'),
      color_hash: z.number().int().optional(),
      icon_hash: z.number().int().optional(),
    }),
  }, tool(async ({ loadout_index, character_id, name, name_hash, color_hash, icon_hash }) => {
    await post(`${ACTIONS}/Loadouts/SnapshotLoadout/`, {
      loadoutIndex: loadout_index, characterId: character_id,
      nameHash: (name ? resolveLoadoutName(name) : name_hash) ?? firstHash('DestinyLoadoutNameDefinition'),
      colorHash: color_hash ?? firstHash('DestinyLoadoutColorDefinition'),
      iconHash: icon_hash ?? firstHash('DestinyLoadoutIconDefinition'),
    });
    return `Saved current gear to loadout slot ${loadout_index}${name ? ` as "${name}"` : ''}.`;
  }));

  server.registerTool('rename_loadout', {
    description: 'Rename / re-color / re-icon an existing loadout slot without touching its items. Names are a fixed in-game list (Raid, Dungeon, PvP, Trials, Nightfall, Strike, Gambit, Crucible, Vanguard, PvE, Support, Prismatic, Solar, Arc, Void, Stasis, Strand, Alpha, Beta, Gamma, Delta, Epsilon) — anything else is rejected with the list. Unspecified fields keep their current value.',
    inputSchema: z.object({
      loadout_index: z.number().int().min(0),
      character_id: z.string(),
      name: z.string().optional(),
      color_hash: z.number().int().optional().describe('DestinyLoadoutColorDefinition hash'),
      icon_hash: z.number().int().optional().describe('DestinyLoadoutIconDefinition hash'),
    }),
  }, tool(async ({ loadout_index, character_id, name, color_hash, icon_hash }) => {
    if (!name && color_hash === undefined && icon_hash === undefined) {
      throw new Error('Nothing to change — pass at least one of name, color_hash, icon_hash.');
    }
    const cur = await currentLoadout(character_id, loadout_index);
    await post(`${ACTIONS}/Loadouts/UpdateLoadoutIdentifiers/`, {
      loadoutIndex: loadout_index, characterId: character_id,
      nameHash: name ? resolveLoadoutName(name) : cur.nameHash,
      colorHash: color_hash ?? cur.colorHash,
      iconHash: icon_hash ?? cur.iconHash,
    });
    return `Loadout slot ${loadout_index} updated${name ? ` — now "${name}"` : ''}.`;
  }));

  server.registerTool('clear_loadout', {
    description: 'Empty a loadout slot: wipes its items AND its name/color/icon, freeing the slot. The gear itself is untouched — only the saved loadout goes away. Not reversible; snapshot_loadout would have to rebuild it.',
    inputSchema: z.object({ loadout_index: z.number().int().min(0), character_id: z.string() }),
  }, tool(async ({ loadout_index, character_id }) => {
    await post(`${ACTIONS}/Loadouts/ClearLoadout/`, { loadoutIndex: loadout_index, characterId: character_id });
    return `Loadout slot ${loadout_index} cleared.`;
  }));

  server.registerTool('pull_from_postmaster', {
    description: 'Pull an item from the postmaster to the character. Find postmaster items via search_inventory (they sit in the Lost Items bucket).',
    inputSchema: z.object({ item_instance_id: z.string(), item_hash: z.number().int(), character_id: z.string(), stack_size: z.number().int().default(1) }),
  }, tool(async ({ item_instance_id, item_hash, character_id, stack_size }) => {
    await post(`${ACTIONS}/Items/PullFromPostmaster/`, {
      itemReferenceHash: item_hash, stackSize: stack_size, itemId: item_instance_id, characterId: character_id,
    });
    return `Pulled ${defName('DestinyInventoryItemDefinition', item_hash)} from postmaster.`;
  }));

  server.registerTool('set_lock_state', {
    description: 'Lock or unlock an item (protects from dismantle in game).',
    inputSchema: z.object({ item_instance_id: z.string(), character_id: z.string(), locked: z.boolean() }),
  }, tool(async ({ item_instance_id, character_id, locked }) => {
    await post(`${ACTIONS}/Items/SetLockState/`, { state: locked, itemId: item_instance_id, characterId: character_id });
    return locked ? 'Locked.' : 'Unlocked.';
  }));

  server.registerTool('insert_plug', {
    description: 'Socket mods/aspects/fragments/free perks into ONE item (armor mods, subclass config, crafted weapon free swaps). Pass every socket you want to change in one call — do not call this once per mod. plug = exact name or hash; socket indexes from get_item_details (use include_plug_options to see what each socket accepts). Only FREE socket operations work (Bungie blocks paid ones for all third-party apps).',
    inputSchema: z.object({
      item_instance_id: z.string(),
      character_id: z.string(),
      plugs: z.array(plugSchema).min(1).max(12).describe('e.g. [{"socket_index":1,"plug":"Grenade Kickstart"}]'),
    }),
  }, tool(async ({ item_instance_id, character_id, plugs }) =>
    (await insertPlugs(item_instance_id, character_id, plugs)).join('\n')));

  server.registerTool('change_subclass', {
    description: 'Equip a subclass by element or name (e.g. "Solar", "Gunslinger", "Prismatic") and optionally configure its super/aspects/fragments in one call. For plugs: first call get_item_details on the subclass instance to see socket indexes.',
    inputSchema: z.object({
      character_id: z.string(),
      subclass_name: z.string(),
      plugs: z.array(plugSchema).default([]),
    }),
  }, tool(async ({ character_id, subclass_name, plugs }) => {
    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
      auth: true, query: { components: '201,205' },
    });
    const q = subclass_name.toLowerCase();
    // DamageType enum → element name (subclass items are named "Gunslinger" etc., users say "Solar")
    const ELEMENT: Record<number, string> = { 1: 'kinetic', 2: 'arc', 3: 'solar', 4: 'void', 6: 'stasis', 7: 'strand' };
    // itemType 16 = Subclass
    const matches = (i: any) => {
      const def = getDef('DestinyInventoryItemDefinition', i.itemHash);
      if (def?.itemType !== 16) return false;
      const element = ELEMENT[def.talentGrid?.hudDamageType] ?? '';
      return def.displayProperties.name.toLowerCase().includes(q) || element.includes(q);
    };
    let subclass = (r.characterEquipment?.data?.[character_id]?.items ?? []).find(matches);
    const alreadyEquipped = !!subclass;
    subclass ??= (r.characterInventories?.data?.[character_id]?.items ?? []).find(matches);
    if (!subclass) throw new Error(`No subclass matching "${subclass_name}" on that character.`);
    const name = defName('DestinyInventoryItemDefinition', subclass.itemHash);
    if (!alreadyEquipped) {
      await post(`${ACTIONS}/Items/EquipItem/`, { itemId: subclass.itemInstanceId, characterId: character_id });
    }
    const results = [alreadyEquipped ? `Already equipped: ${name}.` : `Equipped ${name}.`];
    results.push(...await insertPlugs(subclass.itemInstanceId, character_id, plugs));
    return results.join('\n');
  }));
}
