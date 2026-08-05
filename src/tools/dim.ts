import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { describeLoadout, fetchDimLoadout } from '../dim.js';
import { tool } from './util.js';

export function registerDimTools(server: McpServer): void {
  server.registerTool('dim_build', {
    description:
      'Read a shared DIM loadout link and return everything in it, resolved to names. Takes dim.gg/<id>/<name>, any DIM url with ?loadout=..., a bare share id, or the dimLink that get_build returns.\n'
      + 'Returns: the author\'s notes verbatim, the subclass with its super, class/movement/melee/grenade abilities, aspects and fragments (each with its in-game description and socket index), weapons, armor with exotic perks and armor-SET bonuses (which are active at this piece count), every armor mod grouped by the slot its plug category restricts it to with energy cost and description, fashion (shaders/ornaments), the seasonal artifact perks, and item hashes throughout.\n'
      + 'Read-only: no account, no auth, nothing equipped. To wear the build, take the hashes from here into search_inventory (the share\'s own instance ids belong to whoever shared it and are useless on another account), then transfer_item / equip_items / insert_plug. Mods are listed per slot, not per socket — get_item_details with include_plug_options gives the socket indexes for the piece actually being worn.\n'
      + 'The notes are free text and often name gear or artifact columns the loadout itself does not carry — report them, do not treat them as equipment.',
    inputSchema: z.object({
      url: z.string().describe('https://dim.gg/<id>/<name>, a DIM url with ?loadout=..., or the bare share id.'),
    }),
  }, tool(async ({ url }) => {
    const { loadout, shareId } = await fetchDimLoadout(url);
    return describeLoadout(loadout, shareId);
  }));
}
