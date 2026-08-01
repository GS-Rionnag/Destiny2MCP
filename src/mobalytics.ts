// Mobalytics Destiny 2 build database (community + editorial "meta" builds).
// Public GraphQL, no auth — but it sits behind Cloudflare, which fingerprints TLS and
// HTTP/2, not cookies: node's fetch (and a copied cf_clearance cookie) get a 403
// "Just a moment..." challenge page. node-tls-client speaks a real Chrome fingerprint,
// which is the only reason any of this works. See docs/mobalytics-api.md.
import { ClientIdentifier, initTLS, Session } from 'node-tls-client';

const ENDPOINT = 'https://mobalytics.gg/api/dst/v3/graphql/query';

// Sent verbatim by the site. Cloudflare 403s a request with no browser headers even
// when the TLS handshake is perfect, so this list is load-bearing, not decoration.
const HEADERS: Record<string, string> = {
  'sec-ch-ua-platform': '"Linux"',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'content-type': 'application/json',
  'sec-ch-ua-mobile': '?0',
  accept: '*/*',
  origin: 'https://mobalytics.gg',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  referer: 'https://mobalytics.gg/destiny-2/builds',
  'accept-language': 'en-US,en;q=0.9',
  'x-moba-client': 'mobalytics-web',
};

// Not every profile clears the challenge (chrome_133 is refused where chrome_131 passes),
// and a passing one still gets challenged occasionally — so retry across profiles.
const PROFILES = [ClientIdentifier.chrome_131, ClientIdentifier.firefox_133, ClientIdentifier.safari_16_0];

let session: Promise<InstanceType<typeof Session>> | null = null;
let profile = 0;

async function getSession() {
  if (!session) {
    session = (async () => {
      await initTLS();
      return new Session({ clientIdentifier: PROFILES[profile] });
    })();
  }
  return session;
}

async function nextProfile() {
  profile = (profile + 1) % PROFILES.length;
  const old = session;
  session = null;
  try { (await old)?.close(); } catch { /* closing a dead session is not a failure */ }
}

export class MobalyticsError extends Error {}

export async function mobaGql<T>(query: string, variables: Record<string, unknown> = {}, operationName = 'Q'): Promise<T> {
  const body = JSON.stringify({ operationName, variables, query });
  let last = '';
  for (let attempt = 0; attempt < PROFILES.length + 1; attempt++) {
    const s = await getSession();
    const res = await s.post(ENDPOINT, { headers: { ...HEADERS, 'x-moba-proxy-gql-ops-name': operationName }, body });
    const text = await res.text();
    if (res.status === 403 || text.startsWith('<')) {
      last = `Cloudflare challenged the request (HTTP ${res.status})`;
      await nextProfile();
      continue;
    }
    if (res.status !== 200) throw new MobalyticsError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (json.errors?.length) throw new MobalyticsError(json.errors.map((e: any) => e.message).join('; ').slice(0, 500));
    return json.data as T;
  }
  throw new MobalyticsError(`${last} on every TLS profile — mobalytics.gg is refusing automated requests right now.`);
}

// ---------------------------------------------------------------------------
// Item lookup: build filters take mobalytics item ids ("950745251-sunbracers"),
// which are <bungieHash>-<slug>, so a name has to be resolved first. Substring match.

const ITEM_SEARCH = `query ItemSearch($f: DestinyItemFilter) {
  destiny { game { items(filter: $f, perPage: 8) {
    ... on DestinyItemPagination { items {
      id name itemTypeDisplayName
      rarity { ... on DestinyRarity { name } }
      equipmentSlotV2 { name }
    } } } } }
}`;

export type MobaItem = { id: string; name: string; itemTypeDisplayName?: string; rarity?: { name?: string }; equipmentSlotV2?: { name?: string } };

const itemCache = new Map<string, MobaItem[]>();

export async function searchItems(name: string): Promise<MobaItem[]> {
  const key = name.trim().toLowerCase();
  const hit = itemCache.get(key);
  if (hit) return hit;
  const d = await mobaGql<any>(ITEM_SEARCH, { f: { name } }, 'ItemSearch');
  const items: MobaItem[] = d?.destiny?.game?.items?.items ?? [];
  itemCache.set(key, items);
  return items;
}

// An id is already an id — only names need a round trip.
export async function resolveItemId(nameOrId: string): Promise<string> {
  if (/^\d+-/.test(nameOrId)) return nameOrId;
  const items = await searchItems(nameOrId);
  if (!items.length) throw new MobalyticsError(`No Destiny item matches "${nameOrId}" on mobalytics.`);
  // Exact name wins over a longer item that merely contains it ("Cuirass" -> "Celestial Cuirass").
  const exact = items.find((i) => i.name.toLowerCase() === nameOrId.trim().toLowerCase());
  return (exact ?? items[0]).id;
}

// ---------------------------------------------------------------------------
// Queries. Field selections copied from what mobalytics.gg itself sends.

export const BUILD_LIST_QUERY = `query BuildsList($filter: DestinyBuildsListFilter, $page: DestinyCursorPage, $sort: DestinyBuildsListSortingOption) {
  destiny { game { buildsV2(filter: $filter, page: $page, sort: $sort) {
    builds {
      id name updatedAt favoriteCounter isPublished
      metaInfo { slug isFeatured status }
      class { id name }
      subclass { id name }
      buildType { id name }
      tags { id name }
      superAbility { id name }
      abilities { position item { id name } }
      aspects { position item { id name } }
      weapons {
        slotType
        perks { position perk { id name } }
        weapon { id name type: itemTypeDisplayName rarityV2 { id } }
      }
      headArmor { ...I } chestArmor { ...I } handArmor { ...I } legsArmor { ...I } classItemArmor { ...I }
      author { id name user { username } twitch { login live } }
    }
    pageInfo { cursor hasMoreItems }
  } } }
}
fragment I on DestinyItem { id name rarityV2 { id } }`;

export const BUILD_DETAIL_QUERY = `query BuildDetail($filter: DestinyBuildFilterV2!) {
  destiny { game { build(filter: $filter) {
    error { __typename ... on DestinyNotFoundError { message } }
    build {
      id name updatedAt isPublished favoriteCounter isFavorite
      metaInfo { slug isFeatured status }
      class { ... on DestinyClass { id name } }
      subclass { ... on DestinyDamageType { id name } }
      buildType { id name }
      tags { id name }
      author {
        id name user { id username } twitch { login live }
        socialLinks: links { ... on DestinyAuthorLink { link: url type: network { id name } } }
      }
      superAbility { id name }
      abilities { position item { id name } }
      aspects { position item { id name } }
      fragments { position item { id name } }
      headMods { position item { id name } }
      handMods { position item { id name } }
      chestMods { position item { id name } }
      legsMods { position item { id name } }
      classItemMods { position item { id name } }
      weapons {
        slotType
        perks { position perk { id name } }
        weapon {
          id name itemTypeAndTierDisplayName
          rarity: rarityV2 { ... on DestinyRarity { id } }
          damageTypes { ... on DestinyDamageType { id name } }
        }
      }
      headArmor { ...A } chestArmor { ...A } handArmor { ...A } legsArmor { ...A } classItemArmor { ...A } armor { ...A }
      statsPriority { position isEnhanced stat { id name } }
      artifact { id name description type perks { id name description type } }
      artifactPerksV2 { position perk { id name description type } }
      gameplayLoop
      howItWorks
      inDepthExplanation { title content }
      strengthsWeaknesses { strengths weaknesses }
      dimLink
      videoGuide
    }
  } } }
}
fragment A on DestinyItem {
  id name itemTypeAndTierDisplayName
  rarity: rarityV2 { ... on DestinyRarity { id } }
  sockets { ... on DestinySocket { predefinedItem { ... on DestinyItem { id name description } } } }
  itemSet { id name setPerks { id name description requiredSetCount } }
}`;
