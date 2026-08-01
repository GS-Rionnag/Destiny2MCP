# get_progress — design

Date: 2026-08-01

## Problem

The server exposes 21 tools but never fetches Bungie's progression components. Nothing can
answer "what should I do today" or "where do I stand":

- `get_milestones` reads `/Destiny2/Milestones/` — the **public** weekly reset list. It cannot
  say whether *this account* has cleared its weekly raid.
- Nothing reads ranks, reset counts, season pass tier, or the seasonal artifact.
- Nothing reads bounty or quest objective progress.

`get_progress` covers all of it in one call.

## Scope

In scope: ranks, season pass, seasonal artifact, per-character milestones, bounty and quest
progress.

Out of scope (separate specs): collections/records/craftables (`get_collections`), post-game
carnage reports (`get_pgcr`), catalyst and crafting progress on instanced items (folds into
`get_item_details` via component 309).

## Tool surface

```
get_progress({
  sections?: ("ranks"|"seasonpass"|"artifact"|"milestones"|"bounties")[]   // default: all
  character_id?: string          // default: most-recently-played
  all_characters?: boolean       // default false
  all_ranks?: boolean            // default false
  include_complete?: boolean     // default false
  limit?: number                 // default 25, max 100 — bounty rows only
})
```

`character_id` defaults to the most-recently-played character, using the same
`dateLastPlayed` picker `get_session_state` already uses (`src/tools/read.ts`). Bungie leaves
stale activity hashes behind after logoff, so `dateLastPlayed` is the only reliable signal.

## Data flow

One profile GET, components `100,104,200,201,202,301,1200`. The existing 60s GET cache in
`src/bungie.ts` covers repeat calls within a turn.

| Component | Feeds |
|---|---|
| 100 Profiles | `profile.data.currentSeasonHash` — resolves the season pass without date math |
| 104 ProfileProgression | profile-scoped seasonal artifact, checklists |
| 200 Characters | active-character pick, class name, power |
| 202 CharacterProgressions | ranks, milestones, quests, `uninstancedItemObjectives`, character artifact |
| 201 CharacterInventories | bounty (`itemType` 26) and quest-step (`itemType` 12) items |
| 301 ItemObjectives | x/y progress for those items, via `itemComponents.objectives` |
| 1200 StringVariables | substitutes `{var:hash}` in objective text |

**The fetch is fat, the response is thin.** Bungie returns every character regardless of what
we ask for; we project to one. Server-side bytes are free, model context is not. This is the
governing principle for every section: compact by default, opt-in expansion.

### Season pass resolution

Never hardcode a season pass hash — it changes several times a year.

```
profile.data.currentSeasonHash
  -> DestinySeasonDefinition.seasonPassList
  -> the entry whose [seasonPassStartDate, seasonPassEndDate) window contains now
  -> DestinySeasonPassDefinition.rewardProgressionHash   (tiers 1-100)
                                .prestigeProgressionHash (tiers past the cap)
```

Verified against the local manifest: season 28 ("Monument of Triumph") carries two passes; the
live one starts 2026-06-09. `DestinySeasonDefinition.seasonPassProgressionHash` is `0` on
current seasons and must not be used.

### Rank selection

Default list, all verified present in the local manifest:

| Hash | Name |
|---|---|
| 457612306 | Vanguard Rank |
| 2083746873 | Crucible Rank |
| 3008065600 | Gambit Rank |
| 2755675426 | Trials Rank |
| 1471185389 | Gunsmith Rank |
| 3011295063 | Ghost Rank |

`all_ranks:true` instead keeps every progression with a manifest display name, minus a denylist
of known-noise names: `XP`, `Classified`, `Prestige`, `Gifted Subs`. The manifest holds 172
progression definitions, 86 named, and roughly 15 of those named ones are all literally `"XP"` —
so "keep the named ones" alone is not a usable filter.

The hardcoded list is a deliberate trade: one code edit when a season adds a rank, in exchange
for clean default output. `all_ranks` is the escape hatch when something new appears before the
list is updated.

## Output shape

Flat strings over nested objects. Full example, default args:

```json
{
  "character": { "characterId": "C1", "class": "Hunter", "power": 2010 },
  "ranks": [
    { "name": "Crucible", "rank": "Heroic III", "level": 12, "progress": "4230/5000", "resets": 2 },
    { "name": "Gambit",   "rank": "Brave I",    "level": 5,  "progress": "1200/3000", "resets": 0 }
  ],
  "seasonPass": { "season": "Monument of Triumph", "tier": 84, "progress": "2100/4000", "prestigeTier": null },
  "artifact":   { "name": "Seasonal Artifact", "powerBonus": 12, "pointsAcquired": 19, "nextPointAt": "8400/12000" },
  "milestones": [
    { "name": "Weekly Raid", "complete": false,     "progress": "0/1", "ends": "2026-08-04T17:00:00Z" },
    { "name": "Nightfall",   "complete": "unknown", "ends": "2026-08-04T17:00:00Z" }
  ],
  "bounties": [
    { "name": "Arc Purge", "kind": "Bounty", "pct": 90,
      "objectives": ["9/10 Defeat combatants with Arc damage"],
      "expires": "2026-08-02T17:00:00Z" }
  ],
  "hidden": { "bountiesComplete": 4, "milestonesComplete": 3 }
}
```

Rules:

- **Ranks** — label from `DestinyProgressionDefinition.steps[stepIndex].stepName`. `progress` is
  `progressToNextLevel`/`nextLevelAt` joined into one string, not two fields.
- **Season pass** — `prestigeTier` is `null` below the cap, otherwise the prestige progression's
  level.
- **Bounties** — sorted nearest-to-complete first (`pct` descending). That ordering is the
  section's entire value; an unsorted list is just the inventory again. `pct` is the mean of
  `progress/completionValue` across visible objectives, rounded to an integer; an item with no
  visible objectives gets `pct: 0` and sorts last rather than dividing by zero. `expires` comes
  from `DestinyItemComponent.expirationDate`, omitted when absent.
- **Objective text** — `DestinyObjectiveDefinition.progressDescription`, with `{var:hash}`
  substituted from StringVariables. Objectives with `visible:false` are dropped.
- **Completed rows hidden by default**, but counted in `hidden` — so the model knows they exist
  and does not re-fetch looking for them. `include_complete:true` inlines them instead.
- **Empty sections omitted entirely**, not emitted as `[]`.
- `all_characters:true` returns an array of the whole object, one entry per character. Ranks,
  season pass and artifact are account-scoped in practice but stay per-entry rather than being
  hoisted — hoisting would make the two response shapes structurally different for no gain.

## Milestone completion

Derived in this order:

1. every `availableQuests[].status.completed` → `true`/`false`
2. else every `activities[].challenges[].objective.complete` → `true`/`false`
3. else `"unknown"`

Bungie is inconsistent about which milestones carry quests versus challenges, and about whether
completed milestones are pruned from the response at all. The field is therefore
`true | false | "unknown"`, and **fails open to `"unknown"` rather than guessing** — the same
philosophy as `get_session_state`, where a confident wrong answer costs a wasted turn and an
honest one costs a clarifying sentence.

## Error handling

- Unknown `character_id` → throw, naming the valid ids. Never return an empty result for a typo.
- Missing component (Bungie omits `characterProgressions` when the account's privacy settings
  restrict it) → omit that section, add a one-line entry to a `notes` array explaining why.
- Unresolvable hash → keep the row, name it `#<hash>`. Never drop data because the local
  manifest is behind.
- No response size guard. `limit` caps the only unbounded section; every other section is
  fixed-width. Add a guard if it ever bites.

## Testing

`tests/progress.test.ts`, following the existing pattern in `tests/read-tools.test.ts`: mock
`../src/bungie.js` and `../src/manifest.js`, capture handlers through a fake `registerTool`.

1. Rank label and progress string resolve from `stepIndex` and `progressToNextLevel`
2. Season pass picks the pass whose date window contains now, given a two-pass season
3. Bounties sort by `pct` descending; completed ones excluded from `bounties` but counted in
   `hidden.bountiesComplete`
4. A milestone with neither `availableQuests` nor `activities[].challenges` reports
   `"unknown"`, not `false`

## Follow-on

Bump the server version in `src/index.ts` (tool-schema change) and add a line to the
`INSTRUCTIONS` block pointing at `get_progress` for "what should I do today", so the model does
not reach for `get_milestones` — which only knows the public reset list.
