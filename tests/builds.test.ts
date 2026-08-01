import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mobalytics.js', () => ({
  mobaGql: vi.fn(),
  searchItems: vi.fn(),
  resolveItemId: vi.fn(async (n: string) => (/^\d+-/.test(n) ? n : `999-${n.toLowerCase().replace(/ /g, '-')}`)),
  MobalyticsError: class MobalyticsError extends Error {},
  BUILD_LIST_QUERY: 'LIST',
  BUILD_DETAIL_QUERY: 'DETAIL',
}));

const { registerBuildTools } = await import('../src/tools/builds.js');
const { mobaGql, searchItems } = await import('../src/mobalytics.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerBuildTools({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}
const parse = (res: any) => JSON.parse(res.content[0].text);
const listResponse = (builds: any[]) => ({
  destiny: { game: { buildsV2: { builds, pageInfo: { cursor: 'CUR', hasMoreItems: true } } } },
});

const BUILD = {
  id: 'b1',
  name: 'Sunbracer Warlock',
  updatedAt: '2026-07-01T00:00:00Z',
  favoriteCounter: 42,
  metaInfo: { slug: 'divide-warlock-solar-sunbracers', isFeatured: true },
  class: { id: 'warlock' },
  subclass: { id: 'solar' },
  buildType: { id: 'pve' },
  tags: [{ id: 'ad-clear' }, { id: 'solo' }],
  superAbility: { name: 'Song of Flame' },
  abilities: [
    { position: 3, item: { name: 'Solar Grenade' } },
    { position: 0, item: { name: 'Phoenix Dive' } },
    { position: 2, item: { name: 'Celestial Fire' } },
    { position: 1, item: { name: 'Burst Glide' } },
  ],
  aspects: [{ position: 1, item: { name: 'Touch of Flame' } }, { position: 0, item: { name: 'Heat Rises' } }],
  weapons: [{
    slotType: 'WEAPON_ENERGY',
    perks: [{ position: 1, perk: { name: 'Incandescent' } }, { position: 0, perk: { name: 'Zen Moment' } }],
    weapon: { id: '2907129557-sunshot', name: 'Sunshot', type: 'Hand Cannon', rarityV2: { id: '2759499571-exotic' } },
  }],
  headArmor: { id: '1-helm', name: 'Helm', rarityV2: { id: '4008398120-legendary' } },
  handArmor: { id: '950745251-sunbracers', name: 'Sunbracers', rarityV2: { id: '2759499571-exotic' } },
  author: { name: 'Divide', user: { username: 'fierce-sun' }, twitch: { login: 'divide', live: true } },
};

beforeEach(() => { vi.mocked(mobaGql).mockReset(); vi.mocked(searchItems).mockReset(); });

describe('search_builds', () => {
  it('previews a build the way the site cards do: subclass, abilities by slot, weapons with perks, exotic armor', async () => {
    vi.mocked(mobaGql).mockResolvedValue(listResponse([BUILD]) as any);
    const out = parse(await capture().search_builds({ class: 'warlock' }));
    const b = out.builds[0];

    expect(b.abilities).toEqual({ class: 'Phoenix Dive', movement: 'Burst Glide', melee: 'Celestial Fire', grenade: 'Solar Grenade' });
    expect(b.aspects).toEqual(['Heat Rises', 'Touch of Flame']);
    expect(b.weapons[0]).toMatchObject({ slot: 'energy', name: 'Sunshot', rarity: 'exotic', hash: 2907129557, perks: ['Zen Moment', 'Incandescent'] });
    expect(b.exoticArmor).toBe('Sunbracers');
    expect(b.tags).toEqual(['ad-clear', 'solo']);
    expect(b.super).toBe('Song of Flame');
    expect(b.url).toBe('https://mobalytics.gg/destiny-2/builds/warlock/solar/divide-warlock-solar-sunbracers');
    expect(out.cursor).toBe('CUR');
  });

  it('maps arguments onto the mobalytics filter, resolving item names to ids', async () => {
    vi.mocked(mobaGql).mockResolvedValue(listResponse([]) as any);
    const out = parse(await capture().search_builds({
      class: 'titan', subclass: 'prismatic', type: 'pvp', tags: ['boss-damage'],
      weapon: 'Ergo Sum', time: 'week', sort: 'new', author: 'Plunder',
    }));
    expect(out.filter).toEqual({
      isPublished: true, class: 'titan', subClass: 'prismatic', buildType: 'pvp',
      tags: ['boss-damage'], publishedDuring: 'WEEK', username: 'Plunder', weaponId: '999-ergo-sum',
    });
    expect(out.sort).toBe('NEW');
  });

  it('searches meta builds when asked, defaulting that source to featured order', async () => {
    vi.mocked(mobaGql).mockResolvedValue(listResponse([]) as any);
    const out = parse(await capture().search_builds({ source: 'meta' }));
    expect(out.filter).toEqual({ metaBuilds: true });
    expect(out.sort).toBe('IS_FEATURED');
  });

  it('routes an exotic to the armor or the weapon filter by what it is', async () => {
    vi.mocked(mobaGql).mockResolvedValue(listResponse([]) as any);
    vi.mocked(searchItems).mockResolvedValue([{ id: '950745251-sunbracers', name: 'Sunbracers', itemTypeDisplayName: 'Gauntlets', equipmentSlotV2: { name: 'Gauntlets' } }] as any);
    expect(parse(await capture().search_builds({ exotic: 'Sunbracers' })).filter.armorId).toBe('950745251-sunbracers');

    vi.mocked(searchItems).mockResolvedValue([{ id: '1681583613-ergo-sum', name: 'Ergo Sum', itemTypeDisplayName: 'Sword', equipmentSlotV2: { name: 'Kinetic Weapons' } }] as any);
    expect(parse(await capture().search_builds({ exotic: 'Ergo Sum' })).filter.weaponId).toBe('1681583613-ergo-sum');
  });

  it('links a community build to its author profile page, since it has no meta slug', async () => {
    vi.mocked(mobaGql).mockResolvedValue(listResponse([{ ...BUILD, metaInfo: null }]) as any);
    const b = parse(await capture().search_builds({})).builds[0];
    expect(b.url).toBe('https://mobalytics.gg/destiny-2/profile/fierce-sun/builds/b1');
    expect(b.slug).toBeUndefined();
  });
});

describe('get_build', () => {
  const detail = (build: any) => ({ destiny: { game: { build: { error: null, build } } } });

  it('returns the loadout, the mods and the whole written guide', async () => {
    vi.mocked(mobaGql).mockResolvedValue(detail({
      ...BUILD,
      fragments: [{ position: 0, item: { name: 'Ember of Torches' } }],
      headMods: [{ position: 0, item: { name: 'Ashes to Assets' } }],
      legsMods: [],
      statsPriority: [{ position: 1, isEnhanced: false, stat: { name: 'Class' } }, { position: 0, isEnhanced: true, stat: { name: 'Grenade' } }],
      artifactPerksV2: [{ position: 0, perk: { name: 'Radiant Orbs', description: 'd' } }],
      gameplayLoop: 'loop text',
      howItWorks: 'how text',
      inDepthExplanation: [{ title: 'Mods', content: 'mod text' }],
      strengthsWeaknesses: { strengths: ['Ad-Clear', ''], weaknesses: ['Squishy'] },
      dimLink: 'https://dim.gg/x',
      videoGuide: 'https://youtu.be/x',
    }) as any);

    const out = parse(await capture().get_build({ id: 'b1' }));
    expect(out.subclassSetup).toEqual({
      super: 'Song of Flame',
      abilities: { class: 'Phoenix Dive', movement: 'Burst Glide', melee: 'Celestial Fire', grenade: 'Solar Grenade' },
      aspects: ['Heat Rises', 'Touch of Flame'],
      fragments: ['Ember of Torches'],
    });
    expect(out.mods).toEqual({ head: ['Ashes to Assets'] }); // empty slots are dropped, not sent as []
    expect(out.statPriority).toEqual([{ stat: 'Grenade', enhanced: true }, { stat: 'Class' }]);
    expect(out.guide.strengths).toEqual(['Ad-Clear']); // mobalytics pads these arrays with ''
    expect(out.guide.gameplayLoop).toBe('loop text');
    expect(out.guide.inDepth).toEqual([{ title: 'Mods', content: 'mod text' }]);
    expect(out.dimLink).toBe('https://dim.gg/x');
    expect(out.videoGuide).toBe('https://youtu.be/x');
    expect(out.author.twitch).toEqual({ login: 'divide', live: true });
    expect(mobaGql).toHaveBeenCalledWith('DETAIL', { filter: { id: 'b1' } }, 'BuildDetail');
  });

  it('reports the API not-found error instead of returning an empty build', async () => {
    vi.mocked(mobaGql).mockResolvedValue({ destiny: { game: { build: { error: { message: 'build not found' }, build: null } } } } as any);
    const res = await capture().get_build({ slug: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('build not found');
  });

  it('refuses a call with neither id nor slug', async () => {
    const res = await capture().get_build({});
    expect(res.isError).toBe(true);
  });
});
