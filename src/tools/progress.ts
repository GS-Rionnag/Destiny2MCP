import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { bungieFetch, getAccount } from '../bungie.js';
import { defName } from '../manifest.js';
import { buildArtifact, buildBounties, buildMilestones, buildRanks, resolveSeasonPass } from '../progress.js';
import { tool } from './util.js';

// The fetch is fat and the response is thin: Bungie returns every character regardless, and we
// project down to one. Server-side bytes are free, model context is not.
const COMPONENTS = '100,104,200,201,202,301,1200';

const SECTIONS = ['ranks', 'seasonpass', 'artifact', 'milestones', 'bounties'] as const;

export function registerProgressTools(server: McpServer): void {
  server.registerTool('get_progress', {
    description: `What to do today and where you stand: ranks and reset counts, season pass tier, seasonal artifact, this character's weekly milestones, and every bounty/quest step sorted nearest-to-complete.

Use this, not get_milestones — that one reads the PUBLIC weekly reset list and cannot say whether YOU have cleared anything.

Compact by default: only the six ranks worth reading, completed rows hidden but counted under "hidden". Widen with all_ranks, include_complete, all_characters, or narrow with sections.`,
    inputSchema: z.object({
      sections: z.array(z.enum(SECTIONS)).optional()
        .describe('Subset to return. Omit for all of them.'),
      character_id: z.string().optional()
        .describe('From get_profile. Defaults to the most-recently-played character.'),
      all_characters: z.boolean().default(false),
      all_ranks: z.boolean().default(false)
        .describe('Every named progression instead of the six real ranks'),
      include_complete: z.boolean().default(false)
        .describe('Inline finished bounties and milestones instead of only counting them'),
      limit: z.number().int().min(1).transform((n) => Math.min(n, 100)).default(25)
        .describe('Bounty rows, max 100'),
    }),
  }, tool(async ({ sections, character_id, all_characters, all_ranks, include_complete, limit }) => {
    const want = (s: (typeof SECTIONS)[number]) => !sections?.length || sections.includes(s);

    const a = await getAccount();
    const r = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
      auth: true, query: { components: COMPONENTS },
    });

    const chars: Record<string, any> = r.characters?.data ?? {};
    const ids = Object.keys(chars);
    if (!ids.length) throw new Error('No characters on this account.');
    if (character_id && !chars[character_id]) {
      throw new Error(`Unknown character_id "${character_id}". Valid ids: ${ids.join(', ')}`);
    }

    // Bungie leaves stale activity hashes behind after logoff, so dateLastPlayed is the only
    // reliable "which character is this player actually on" signal. Same pick as get_session_state.
    const active = character_id
      ?? ids.reduce((best, id) => chars[id].dateLastPlayed > chars[best].dateLastPlayed ? id : best, ids[0]);

    const notes: string[] = [];
    if (!r.characterProgressions?.data) {
      notes.push('characterProgressions missing — account privacy settings may restrict it; ranks, season pass and milestones are unavailable.');
    }

    const one = (cid: string) => {
      const prog = r.characterProgressions?.data?.[cid];
      const vars: Record<string, number> = {
        ...(r.profileStringVariables?.data?.integerValuesByHash ?? {}),
        ...(r.characterStringVariables?.data?.[cid]?.integerValuesByHash ?? {}),
      };

      const out: Record<string, unknown> = {
        character: {
          characterId: cid,
          class: defName('DestinyClassDefinition', chars[cid].classHash),
          power: chars[cid].light,
        },
      };
      const hidden: Record<string, number> = {};
      // Empty sections are omitted entirely — an empty array still costs the model a read.
      const set = (k: string, v: unknown) => {
        if (v === undefined || (Array.isArray(v) && !v.length)) return;
        out[k] = v;
      };

      if (want('ranks') && prog?.progressions) set('ranks', buildRanks(prog.progressions, all_ranks));
      if (want('seasonpass') && prog?.progressions) {
        set('seasonPass', resolveSeasonPass(r.profile?.data?.currentSeasonHash, prog.progressions, new Date()));
      }
      if (want('artifact')) {
        // Profile-scoped (component 104) only: the character-scoped artifact (202) carries just
        // artifactHash/pointsUsed/tiers, so feeding it to buildArtifact yields confident zeros.
        set('artifact', buildArtifact(r.profileProgression?.data?.seasonalArtifact));
      }
      if (want('milestones') && prog?.milestones) {
        const m = buildMilestones(prog.milestones, include_complete);
        set('milestones', m.rows);
        if (m.hiddenComplete) hidden.milestonesComplete = m.hiddenComplete;
      }
      if (want('bounties')) {
        const b = buildBounties(
          r.characterInventories?.data?.[cid]?.items ?? [],
          r.itemComponents?.objectives?.data ?? {},
          prog?.uninstancedItemObjectives ?? {},
          vars,
          { includeComplete: include_complete, limit },
        );
        set('bounties', b.rows);
        if (b.hiddenComplete) hidden.bountiesComplete = b.hiddenComplete;
      }
      if (Object.keys(hidden).length) out.hidden = hidden;
      return out;
    };

    const body = all_characters ? { characters: ids.map(one) } : one(active);
    return notes.length ? { ...body, notes } : body;
  }));
}
