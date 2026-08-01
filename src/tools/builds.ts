import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { BUILD_DETAIL_QUERY, BUILD_LIST_QUERY, MobalyticsError, mobaGql, resolveItemId, searchItems } from '../mobalytics.js';
import { tool } from './util.js';

// Mobalytics ids are "<bungieHash>-<slug>" — the hash is the manifest hash, so it stays
// in the output for anything that wants to cross-reference the local manifest.
const idHash = (id?: string) => (id ? Number(id.split('-')[0]) || undefined : undefined);
const idSlug = (id?: string) => (id ? id.slice(id.indexOf('-') + 1) : undefined);

const CLASSES = ['titan', 'hunter', 'warlock'] as const;
const SUBCLASSES = ['prismatic', 'arc', 'solar', 'void', 'stasis', 'strand', 'kinetic'] as const;
const TAGS = [
  'easy-to-play', 'boss-damage', 'ad-clear', 'high-survivabilty', 'support', 'anti-champion',
  'casual-pvp', 'competitive-pvp', 'raids', 'dungeons', 'master-content', 'grandmaster-nightfall',
  'solo', 'super-focused', 'ability-focused', 'weapon-focused', 'high-damage', 'end-game', 'crowd-control',
] as const;

const SORTS = { trending: 'TRENDING', new: 'NEW', top: 'TOP', featured: 'IS_FEATURED', default: 'DEFAULT' } as const;
const TIMES = { today: 'DAY', week: 'WEEK', month: 'MONTH' } as const;

// Ability slots are positional in every build mobalytics serves: 0 class, 1 movement, 2 melee, 3 grenade.
const ABILITY_SLOTS = ['class', 'movement', 'melee', 'grenade'] as const;
const WEAPON_SLOTS: Record<string, string> = { WEAPON_KINETIC: 'kinetic', WEAPON_ENERGY: 'energy', WEAPON_POWER: 'power' };

type Assigned = { position: number; item?: { id?: string; name?: string } | null } | null;
type Item = { id?: string; name?: string; rarityV2?: { id?: string } | null; rarity?: { id?: string } | null } | null;

const rarity = (i: Item) => idSlug(i?.rarityV2?.id ?? i?.rarity?.id ?? undefined);
const isExotic = (i: Item) => rarity(i) === 'exotic';

const named = (list?: Assigned[] | null) =>
  (list ?? []).filter((a) => a?.item?.name).sort((a, b) => a!.position - b!.position).map((a) => a!.item!.name!);

function abilities(list?: Assigned[] | null) {
  const out: Record<string, string> = {};
  for (const a of list ?? []) {
    if (!a?.item?.name) continue;
    out[ABILITY_SLOTS[a.position] ?? `slot${a.position}`] = a.item.name;
  }
  return out;
}

function weapons(list?: any[] | null) {
  return (list ?? []).filter((w) => w?.weapon?.name).map((w) => ({
    slot: WEAPON_SLOTS[w.slotType] ?? w.slotType,
    name: w.weapon.name,
    type: w.weapon.type ?? w.weapon.itemTypeAndTierDisplayName,
    rarity: rarity(w.weapon),
    hash: idHash(w.weapon.id),
    // Community builds usually leave perks unset; only meta builds pin a roll.
    perks: (w.perks ?? []).filter((p: any) => p?.perk?.name).sort((a: any, b: any) => a.position - b.position).map((p: any) => p.perk.name),
  }));
}

const armorPiece = (i: Item) => (i?.name ? { name: i.name, rarity: rarity(i), hash: idHash(i.id ?? undefined) } : undefined);

function armor(b: any) {
  const slots = { head: b.headArmor, arms: b.handArmor, chest: b.chestArmor, legs: b.legsArmor, classItem: b.classItemArmor } as Record<string, Item>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(slots)) { const p = armorPiece(v); if (p) out[k] = p; }
  return out;
}

const exoticArmor = (b: any) =>
  [b.headArmor, b.handArmor, b.chestArmor, b.legsArmor, b.classItemArmor].find(isExotic)?.name;

function author(a: any) {
  if (!a) return undefined;
  return {
    name: a.name ?? a.user?.username,
    username: a.user?.username,
    twitch: a.twitch?.login ? { login: a.twitch.login, live: !!a.twitch.live } : undefined,
    links: (a.socialLinks ?? []).map((l: any) => l?.link).filter(Boolean),
  };
}

function buildUrl(b: any) {
  const slug = b.metaInfo?.slug;
  if (slug && b.class?.id && b.subclass?.id) return `https://mobalytics.gg/destiny-2/builds/${b.class.id}/${b.subclass.id}/${slug}`;
  const user = b.author?.user?.username;
  return user ? `https://mobalytics.gg/destiny-2/profile/${user}/builds/${b.id}` : undefined;
}

// The card the site shows in a list: enough to pick a build without opening it.
function preview(b: any) {
  return {
    id: b.id,
    slug: b.metaInfo?.slug ?? undefined,
    name: b.name,
    class: b.class?.id,
    subclass: b.subclass?.id,
    type: b.buildType?.id,
    tags: (b.tags ?? []).map((t: any) => t.id),
    featured: b.metaInfo?.isFeatured || undefined,
    favorites: b.favoriteCounter,
    updatedAt: b.updatedAt,
    author: author(b.author),
    super: b.superAbility?.name,
    abilities: abilities(b.abilities),
    aspects: named(b.aspects),
    exoticArmor: exoticArmor(b),
    weapons: weapons(b.weapons),
    armor: armor(b),
    url: buildUrl(b),
  };
}

function mods(b: any) {
  const out: Record<string, string[]> = {};
  for (const [k, v] of [['head', b.headMods], ['arms', b.handMods], ['chest', b.chestMods], ['legs', b.legsMods], ['classItem', b.classItemMods]] as const) {
    const list = named(v as Assigned[]);
    if (list.length) out[k] = list;
  }
  return out;
}

function detailArmor(b: any) {
  const slots = { head: b.headArmor, arms: b.handArmor, chest: b.chestArmor, legs: b.legsArmor, classItem: b.classItemArmor } as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const [k, i] of Object.entries(slots)) {
    if (!i?.name) continue;
    out[k] = {
      name: i.name,
      type: i.itemTypeAndTierDisplayName,
      rarity: rarity(i),
      hash: idHash(i.id),
      // Exotic armour perks and armour-set bonuses are the reason a piece is in the build.
      perks: (i.sockets ?? []).map((s: any) => s?.predefinedItem).filter((p: any) => p?.name)
        .map((p: any) => ({ name: p.name, description: p.description || undefined })),
      itemSet: i.itemSet ? {
        name: i.itemSet.name,
        perks: (i.itemSet.setPerks ?? []).map((p: any) => ({ name: p.name, requiredSetCount: p.requiredSetCount, description: p.description || undefined })),
      } : undefined,
    };
  }
  return out;
}

export function registerBuildTools(server: McpServer): void {
  server.registerTool('search_builds', {
    description:
      'Search the Mobalytics Destiny 2 build database (community builds + editorial "meta" builds) and return a preview card for each hit: subclass, super, abilities (class/movement/melee/grenade), aspects, weapons with their perks, armor with the exotic called out, tags and author. Filter by class, subclass, pve/pvp, tags, a weapon or armor piece by NAME (e.g. weapon:"Ergo Sum", armor:"Sunbracers"), author, and sort by trending/new/top. time narrows to builds first published today, this week or this month. Pass the returned id (or slug) to get_build for the full write-up. This is community build data, not the player\'s inventory.',
    inputSchema: z.object({
      class: z.enum(CLASSES).optional(),
      subclass: z.enum(SUBCLASSES).optional().describe('Subclass / damage type.'),
      type: z.enum(['pve', 'pvp']).optional(),
      tags: z.array(z.enum(TAGS)).optional().describe('All tags must match (AND).'),
      weapon: z.string().optional().describe('Weapon name or mobalytics id — only builds using it.'),
      armor: z.string().optional().describe('Armor piece name or mobalytics id, e.g. an exotic like "Cuirass of the Falling Star".'),
      exotic: z.string().optional().describe('Exotic name when you do not want to think about whether it is a weapon or an armor piece — routed to the right filter.'),
      author: z.string().optional().describe('Mobalytics username or author UUID.'),
      sort: z.enum(['trending', 'new', 'top', 'featured', 'default']).optional().describe('Default trending for community builds, featured for meta builds.'),
      time: z.enum(['today', 'week', 'month']).optional().describe('Only builds FIRST PUBLISHED in that window — an older build updated yesterday does not match, so combining time with tags often returns nothing.'),
      source: z.enum(['community', 'meta']).optional().describe('community (default) = player-published builds; meta = Mobalytics editorial builds.'),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional().describe('pageInfo.cursor from a previous call, for the next page.'),
    }),
  }, tool(async (a: any) => {
    const meta = a.source === 'meta';
    const filter: Record<string, unknown> = meta ? { metaBuilds: true } : { isPublished: true };
    if (a.class) filter.class = a.class;
    if (a.subclass) filter.subClass = a.subclass;
    if (a.type) filter.buildType = a.type;
    if (a.tags?.length) filter.tags = a.tags;
    if (a.time) filter.publishedDuring = TIMES[a.time as keyof typeof TIMES];
    // author takes a UUID or the literal "me"; anything else is a username.
    if (a.author) filter[/^[0-9a-f-]{36}$/i.test(a.author) ? 'author' : 'username'] = a.author;
    if (a.weapon) filter.weaponId = await resolveItemId(a.weapon);
    if (a.armor) filter.armorId = await resolveItemId(a.armor);
    if (a.exotic) {
      const hits = await searchItems(a.exotic);
      const item = hits.find((i) => i.name.toLowerCase() === a.exotic.trim().toLowerCase()) ?? hits[0];
      if (!item) throw new MobalyticsError(`No Destiny item matches "${a.exotic}" on mobalytics.`);
      const isArmor = /armor|helmet|gauntlet|chest|leg|mark|bond|cloak/i.test(`${item.itemTypeDisplayName} ${item.equipmentSlotV2?.name}`);
      filter[isArmor ? 'armorId' : 'weaponId'] = item.id;
    }

    const sort = SORTS[(a.sort ?? (meta ? 'featured' : 'trending')) as keyof typeof SORTS];
    const page = { count: a.limit ?? 10, cursor: a.cursor ?? null };
    const d = await mobaGql<any>(BUILD_LIST_QUERY, { filter, page, sort }, 'BuildsList');
    const res = d?.destiny?.game?.buildsV2;
    const builds = (res?.builds ?? []).map(preview);
    return {
      builds,
      count: builds.length,
      cursor: res?.pageInfo?.hasMoreItems ? res.pageInfo.cursor : undefined,
      hasMore: !!res?.pageInfo?.hasMoreItems,
      filter,
      sort,
    };
  }));

  server.registerTool('get_build', {
    description:
      'Everything Mobalytics holds on one build: full loadout (weapons with perks, armor with exotic perks and armor-set bonuses, mods per slot), subclass setup (super, abilities, aspects, fragments), stat priority, artifact perks, and the written guide — gameplay loop, how it works, in-depth sections, strengths and weaknesses, the DIM import link and the video guide when the author added one. Takes the id or slug from search_builds.',
    inputSchema: z.object({
      id: z.string().optional().describe('Build UUID from search_builds.'),
      slug: z.string().optional().describe('Meta-build slug, e.g. "divide-titan-prismatic-thunderclap".'),
    }),
  }, tool(async (a: any) => {
    if (!a.id && !a.slug) throw new MobalyticsError('Pass id or slug.');
    const d = await mobaGql<any>(BUILD_DETAIL_QUERY, { filter: a.id ? { id: a.id } : { slug: a.slug } }, 'BuildDetail');
    const payload = d?.destiny?.game?.build;
    const b = payload?.build;
    if (!b) throw new MobalyticsError(payload?.error?.message ?? `No build found for ${a.id ?? a.slug}.`);

    return {
      id: b.id,
      slug: b.metaInfo?.slug ?? undefined,
      name: b.name,
      url: buildUrl(b),
      class: b.class?.id,
      subclass: b.subclass?.id,
      type: b.buildType?.id,
      tags: (b.tags ?? []).map((t: any) => t.id),
      featured: b.metaInfo?.isFeatured || undefined,
      favorites: b.favoriteCounter,
      updatedAt: b.updatedAt,
      author: author(b.author),

      subclassSetup: {
        super: b.superAbility?.name,
        abilities: abilities(b.abilities),
        aspects: named(b.aspects),
        fragments: named(b.fragments),
      },
      weapons: weapons(b.weapons).map((w, i) => ({
        ...w,
        damageType: b.weapons?.[i]?.weapon?.damageTypes?.[0]?.name,
      })),
      armor: detailArmor(b),
      mods: mods(b),
      statPriority: (b.statsPriority ?? []).sort((x: any, y: any) => x.position - y.position)
        .map((s: any) => ({ stat: s.stat?.name, enhanced: s.isEnhanced || undefined })),
      artifact: b.artifact ? { name: b.artifact.name, perks: (b.artifact.perks ?? []).map((p: any) => p.name) } : undefined,
      artifactPerks: (b.artifactPerksV2 ?? []).sort((x: any, y: any) => x.position - y.position)
        .map((p: any) => ({ name: p.perk?.name, description: p.perk?.description || undefined })),

      guide: {
        gameplayLoop: b.gameplayLoop || undefined,
        howItWorks: b.howItWorks || undefined,
        inDepth: (b.inDepthExplanation ?? []).filter((s: any) => s?.title || s?.content)
          .map((s: any) => ({ title: s.title, content: s.content })),
        strengths: b.strengthsWeaknesses?.strengths?.filter(Boolean),
        weaknesses: b.strengthsWeaknesses?.weaknesses?.filter(Boolean),
      },
      dimLink: b.dimLink || undefined,
      videoGuide: b.videoGuide || undefined,
    };
  }));

  server.registerTool('find_build_item', {
    description: 'Look up the Mobalytics item id for a weapon or armor piece by name, for the weapon/armor filters of search_builds. Only needed when a name is ambiguous — search_builds resolves names itself.',
    inputSchema: z.object({ name: z.string() }),
  }, tool(async (a: any) => (await searchItems(a.name)).map((i) => ({
    id: i.id,
    name: i.name,
    type: i.itemTypeDisplayName,
    rarity: i.rarity?.name,
    slot: i.equipmentSlotV2?.name,
    hash: idHash(i.id),
  }))));
}
