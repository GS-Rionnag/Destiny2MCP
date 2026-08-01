import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName, firstHash, getDef, searchDefs } from '../manifest.js';
import { tool } from './util.js';

const ACTIONS = '/Destiny2/Actions';

export function resolvePlugHash(plug: string): number {
  if (/^\d+$/.test(plug)) return Number(plug);
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
  for (const p of plugs) {
    try {
      const plugItemHash = resolvePlugHash(p.plug);
      await post(`${ACTIONS}/Items/InsertSocketPlugFree/`, {
        plug: { socketIndex: p.socket_index, socketArrayType: 0, plugItemHash },
        itemId, characterId,
      });
      out.push(`Socket ${p.socket_index} → ${defName('DestinyInventoryItemDefinition', plugItemHash)}.`);
    } catch (e: any) {
      out.push(`Socket ${p.socket_index} FAILED: ${e?.message ?? e}`);
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
      name_hash: z.number().int().optional().describe('DestinyLoadoutNameDefinition hash; default = first'),
      color_hash: z.number().int().optional(),
      icon_hash: z.number().int().optional(),
    }),
  }, tool(async ({ loadout_index, character_id, name_hash, color_hash, icon_hash }) => {
    await post(`${ACTIONS}/Loadouts/SnapshotLoadout/`, {
      loadoutIndex: loadout_index, characterId: character_id,
      nameHash: name_hash ?? firstHash('DestinyLoadoutNameDefinition'),
      colorHash: color_hash ?? firstHash('DestinyLoadoutColorDefinition'),
      iconHash: icon_hash ?? firstHash('DestinyLoadoutIconDefinition'),
    });
    return `Saved current gear to loadout slot ${loadout_index}.`;
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
