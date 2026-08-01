# Mobalytics Destiny 2 Builds API (reverse-engineered 2026-08-01)

## Endpoint

```
POST https://mobalytics.gg/api/dst/v3/graphql/query
Content-Type: application/json
```

Body: standard GraphQL `{"operationName": ..., "variables": {...}, "query": "..."}`.
(A second endpoint `/api/destiny-2/v1/graphql/query` exists but only serves site
gamification: battle pass, challenges, banners. Not builds.)

Optional headers the site sends (not required):
`x-moba-client: mobalytics-web`, `x-moba-proxy-gql-ops-name: <operationName>`,
`origin`/`referer: https://mobalytics.gg`.

### Access requirements

| Thing | Required? |
|---|---|
| Auth token / login | No, for all read queries below |
| Cookies | No |
| `content-type: application/json` | **Yes** — omit it and Cloudflare 403s |
| POST | **Yes** — GET is 403 |
| Browser-like TLS fingerprint | **Yes** — plain curl/node fetch gets a Cloudflare managed challenge (403 "Just a moment...") |

Cloudflare keys on JA3/TLS fingerprint, not cookies: a `cf_clearance` cookie
copied out of a real browser still 403s from curl. Working options:

- `curl_cffi` (python) with `impersonate="chrome"` — verified, no cookies needed
- curl-impersonate / rquest / any TLS-impersonating client
- a real browser (Playwright with `channel: "chrome"` passes; Playwright's
  bundled Firefox got stuck in a permanent challenge loop)

Introspection is disabled (`INTROSPECTION_DISABLED`), but **input-type validation
errors dump full SDL** — send a bogus field and the error prints the whole
`input` definition. That's how the filter types below were recovered.
15 rapid requests in 1.7 s: no rate-limiting observed.

## Schema (relevant parts)

Root path: `destiny { game { ... } }`. Federated (`@join__type(graph: DST_BUILDS)`).

```graphql
destiny.game.buildsV2(filter: DestinyBuildsListFilter, page: DestinyCursorPage, sort: DestinyBuildsListSortingOption): DestinyBuildsListPayload
destiny.game.build(filter: DestinyBuildFilterV2!): DestinyBuildPayload
destiny.game.definitions: DestinyDefinitions
destiny.game.items(filter: DestinyItemFilter, page: Int, perPage: Int)
```

```graphql
" Filter for getting list of builds "
input DestinyBuildsListFilter {
  """Creator of the build (User) IDs.
     1. empty - means any author. 2. 'me' means current logged in user. 3. UUID means specific user"""
  author: String
  """Filter builds by author username. If both `author` and `username` are provided
     and the username resolves to a user, the resolved user ID overrides `author`."""
  username: String
  class: ID           # warlock | titan | hunter
  subClass: ID        # prismatic | arc | void | solar | stasis | strand | kinetic
  buildType: ID       # pve | pvp
  weaponId: ID        # e.g. "3049715579-praxic-blade"
  armorId: ID
  isFavourite: Boolean  # true also includes deleted; author MUST BE 'me'
  isPublished: Boolean  # empty = all; false requires author 'me'
  " Multiple tags are AND "
  tags: [ID!]
  " Show only meta builds "
  metaBuilds: Boolean
  " Featured builds you can see only if meta builds are provided "
  featuredBuilds: Boolean
  " Filter by date first published "
  publishedDuring: DestinyTimeframe   # DAY | WEEK | MONTH
}

" Filter for getting single build "
input DestinyBuildFilterV2 { id: ID  slug: String }

input DestinyCursorPage { count: Int  cursor: String }

enum DestinyBuildsListSortingOption { DEFAULT  IS_FEATURED  NEW  TOP  TRENDING }
enum DestinyTimeframe { DAY  WEEK  MONTH }
```

Two build populations, same field, different filter:

- **Meta builds** (editorial, `/destiny-2/builds`): `filter: {metaBuilds: true}`, sort `IS_FEATURED`. 204 total today; 50 of them featured.
- **Community builds** (`/destiny-2/community-builds`): `filter: {isPublished: true}`, sort `TRENDING`, optional `publishedDuring`.

Pagination is cursor-based: `pageInfo { cursor hasMoreItems }`, feed `cursor` back
in `page.cursor`. The cursor is base64 of tab-separated
`destinyCursorV2 <publishedAt> <favCount> <updatedAt> <isFeatured> <randomTiebreak>`.
`count: 1000` returned all 204 meta builds in one shot — no cap hit.

## Reference values (`destiny.game.definitions`)

- classes: `warlock`, `titan`, `hunter`
- damageTypes (= subclass): `prismatic`, `arc`, `kinetic`, `void`, `strand`, `stasis`, `solar`
- buildTypes: `pve`, `pvp`
- tags: `easy-to-play`, `boss-damage`, `ad-clear`, `high-survivabilty` *(sic)*, `support`,
  `anti-champion`, `casual-pvp`, `competitive-pvp`, `raids`, `dungeons`, `master-content`,
  `grandmaster-nightfall`, `solo`, `super-focused`, `ability-focused`, `weapon-focused`,
  `high-damage`, `end-game`, `crowd-control`
- statsPriority: `144602215-super`, `392767087-health`, `2996146975-weapons`,
  `1735777505-grenade`, `1943323491-class`, `4244567218-melee`

Item IDs are `<bungieHash>-<slug>` (`3049715579-praxic-blade`), so they map back to
the Bungie manifest by stripping the suffix.

## Web URLs → API calls

| URL | Query |
|---|---|
| `/destiny-2/builds` | `buildsV2 filter:{metaBuilds:true} sort:IS_FEATURED` |
| `/destiny-2/builds/{class}` | + `class` |
| `/destiny-2/builds/{class}/{subclass}/{slug}` | `build(filter:{slug})` — **server-rendered**, no client call |
| `/destiny-2/community-builds` | `buildsV2 filter:{isPublished:true} sort:TRENDING` |
| query params | `q_weapon`, `q_armor`, `q_build_type`, `q_subclass`, `q_sort`, `q_time_period` |

## List query (what the site actually sends)

`operationName: DestinyMetaBuildsPageQuery` (community version is identical apart
from the name):

```graphql
query DestinyMetaBuildsPageQuery($filter: DestinyBuildsListFilter, $page: DestinyCursorPage, $sort: DestinyBuildsListSortingOption) {
  destiny { game { buildsV2(filter: $filter, page: $page, sort: $sort) {
    builds {
      id  name  isFavorite  isPublished  favoriteCounter  updatedAt
      metaInfo { slug isFeatured status }
      class { id name iconUrl }  subclass { id name iconUrl }  buildType { id name iconUrl }
      superAbility { id name iconUrl }
      abilities { position item { id name iconUrl } }
      aspects   { position item { id name iconUrl } }
      tags { id name }
      weapons { slotType perks { position perk { id name iconUrl } }
                weapon { id name iconUrl type: itemTypeDisplayName iconWatermarkUrl rarityV2 { id } } }
      armor { ...ItemFragment } headArmor { ...ItemFragment } chestArmor { ...ItemFragment }
      handArmor { ...ItemFragment } legsArmor { ...ItemFragment } classItemArmor { ...ItemFragment }
      author { id name twitch { live login } user { id username }
               socialLinks: links { link: url type: network { id name iconUrl } } }
    }
    pageInfo { cursor hasMoreItems }
  } } }
}
fragment ItemFragment on DestinyItem {
  id name iconUrl iconWatermarkUrl categories { ... on DestinyCategory { id name } }
  rarity { ... on DestinyRarity { id name } } rarityV2 { id }
}
```

`slotType` values: `WEAPON_KINETIC | WEAPON_ENERGY | WEAPON_POWER | HEAD | HEAD_ARMOR |
HANDS | HANDS_ARMOR | CHEST | CHEST_ARMOR | LEGS | LEGS_ARMOR | CLASS_ITEM |
CLASS_ITEM_ARMOR | SUBCLASS | ARTIFACT_PERKS | ARMOR`.

## Single build (all the good stuff)

`build(filter: {id})` or `build(filter: {slug})`. This is where the guide prose,
DIM link, mods, fragments, artifact perks and stat priority live — none of it is in
the list query.

```graphql
query B($f: DestinyBuildFilterV2!) {
  destiny { game { build(filter: $f) {
    error { __typename ... on DestinyNotFoundError { message } }
    build {
      id name updatedAt isPublished favoriteCounter
      metaInfo { slug isFeatured status }
      class { ... on DestinyClass { id name } }
      subclass { ... on DestinyDamageType { id name iconUrl } }
      buildType { id name iconUrl }  tags { name }
      author { id name user { id username } twitch { live login }
               socialLinks: links { ... on DestinyAuthorLink { link: url type: network { id name } } } }

      superAbility { id name iconUrl }
      abilities { position item { id name iconUrl } }
      aspects   { position item { id name iconUrl } }
      fragments { position item { id name iconUrl } }
      headMods  { position item { id name iconUrl } }
      handMods  { position item { id name iconUrl } }
      chestMods { position item { id name iconUrl } }
      legsMods  { position item { id name iconUrl } }
      classItemMods { position item { id name iconUrl } }

      weapons { slotType perks { position perk { id name iconUrl } }
                weapon { id name iconUrl iconWatermarkUrl itemTypeAndTierDisplayName
                         rarity: rarityV2 { ... on DestinyRarity { id } }
                         damageTypes { ... on DestinyDamageType { id name } }
                         sockets { ... on DestinySocket {
                           socketType { ... on DestinySocketType { id } }
                           plugSetItems { ... on DestinyItem { id name description itemTypeDisplayName } }
                           predefinedItem { ... on DestinyItem { id name description iconUrl } } } } } }
      headArmor { ...A } handArmor { ...A } chestArmor { ...A } legsArmor { ...A } classItemArmor { ...A } armor { ...A }

      statsPriority { position isEnhanced stat { id name iconUrl } }
      artifact { id name description iconUrl type perks { id name description type } }
      artifactPerksV2 { position perk { id name description type } }

      gameplayLoop            # markdown
      howItWorks              # markdown
      inDepthExplanation { title content }
      strengthsWeaknesses { strengths weaknesses }
      dimLink                 # https://dim.gg/... one-click loadout import
      videoGuide              # youtube url
    }
  } } }
}
fragment A on DestinyItem {
  id name iconUrl iconWatermarkUrl itemTypeAndTierDisplayName
  categories { ... on DestinyCategory { id } }
  rarity: rarityV2 { ... on DestinyRarity { id } }
  sockets { ... on DestinySocket { socketType { ... on DestinySocketType { id } }
            predefinedItem { ... on DestinyItem { id name description iconUrl } } } }
  itemSet { id name setPerks { id name description iconURL requiredSetCount } }
}
```

## Other operations found in the bundle

Reads: `Destiny2GearsAndItemsTooltipData`, `Destiny2ItemTooltipQuery`,
`Destiny2WeaponTooltipQuery`, `Destiny2PerkTooltipQuery`, `Destiny2PerksDataQuery`,
`DestinyBuildPlannerPageQuery`, `Destiny2BuildPlannerItems`, `Destiny2BuildDimImport`,
`DestinyWeaponsPageQuery`, `Destiny2ProfilePageQuery`, `DestinyBuildSuggestedMetaBuildsQuery`,
`DestinyMetaBuildsPageMainInfoQuery` (page SEO + all classes/tags/gear lists).

Mutations (all need a logged-in session): `destiny.setFavourite`, `destiny.setPublished`,
`destiny.deleteBuild`, `destiny.duplicateBuild`.

## Working example

```python
from curl_cffi import requests

URL = "https://mobalytics.gg/api/dst/v3/graphql/query"

def gql(query, variables=None, op="Q"):
    r = requests.post(URL, impersonate="chrome",
                      headers={"content-type": "application/json"},
                      json={"operationName": op, "variables": variables or {}, "query": query})
    r.raise_for_status()
    return r.json()["data"]

LIST = """query Q($f: DestinyBuildsListFilter, $p: DestinyCursorPage, $s: DestinyBuildsListSortingOption) {
  destiny { game { buildsV2(filter: $f, page: $p, sort: $s) {
    builds { id name metaInfo { slug isFeatured } class { id } subclass { id } buildType { id }
             tags { id } favoriteCounter updatedAt author { name } }
    pageInfo { cursor hasMoreItems } } } } }"""

def meta_builds(**filt):
    cursor, out = None, []
    while True:
        p = gql(LIST, {"f": {"metaBuilds": True, **filt}, "p": {"count": 100, "cursor": cursor},
                       "s": "IS_FEATURED"})["destiny"]["game"]["buildsV2"]
        out += p["builds"]
        if not p["pageInfo"]["hasMoreItems"]:
            return out
        cursor = p["pageInfo"]["cursor"]

print(len(meta_builds()))                              # 204
print(len(meta_builds(**{"class": "titan", "tags": ["boss-damage"]})))
```

Cheapest full crawl: one `count: 1000` list call for ids/slugs, then one
`build(filter:{id})` per build for the detailed loadout + guide text.
