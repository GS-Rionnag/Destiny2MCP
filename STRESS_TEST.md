# ChatGPT MCP Stress Test — Raw Notes

Date: 2026-08-01
Server version: (fill in)
Client: ChatGPT

## Paste responses below

### Tool calls / responses

Read-only run completed: tasks 1–26, 30 Destiny 2 connector calls, zero write calls. Task 14 produced the one expected connector error. The requested `data/mcp.log` audit could not run because that file was absent.

## A. Account

1. The connector did not return your Bungie display name.

| Character ID          |   Class | Power | Hours |
| --------------------- | ------: | ----: | ----: |
| `2305843009928315363` | Warlock |   276 |   493 |
| `2305843010548224292` |  Hunter |    10 |   115 |
| `2305843010575594865` |   Titan |    10 |    92 |

Glimmer: **343,727**

2. Detailed character: Warlock

Stats: Super 55, Health 162, Grenade 88, Power 276, Class 33, Weapons 20, Melee 56.

Equipped:

* Lost Signal — 315
* Graviton Lance — 313
* Edge Transit — 10
* Nezarec’s Sin — 312
* Wyrmguard Gloves — 318
* Wyrmguard Robe — 315
* Wyrmguard Boots — 308
* Luminopotent Bond — 318
* Restless Dreams — power not returned
* Unified Theory — 190
* Karve of the Worm — power not returned
* Voidwalker — -10
* True Valor — power not returned
* Finishers — power not returned
* Emotes — power not returned
* Slayer Baron Apothecary Satchel — 1

## B. Inventory search

3. Legendary hand cannons, highest power first:

* Service Revolver — 308, Warlock
* Power 10: Luna’s Howl, Zaouli’s Bane, Epochal Integration, Luna’s Howl, Rose, Exuviae, Bold Endings, Zaouli’s Bane (Harrowed), Maahes HC4, IKELOS_HC_v1.0.3, Luna’s Howl, Midnight Coup, Waking Vigil

Total: **14**. Sorting looked correct.

4. Hunter, non-exotic armor with at least 20 Resilience:

| Item                 | Resilience | Location         |
| -------------------- | ---------: | ---------------- |
| Wyrmguard Tunic      |         32 | Hunter, equipped |
| Photosuede Grips     |         24 | Hunter, equipped |
| Holdfast Vest        |         22 | Vault            |
| Untethered Edge Mask |         20 | Hunter, equipped |

5. Repeated using `Health`:

| Item                 | Health |
| -------------------- | -----: |
| Wyrmguard Tunic      |     32 |
| Photosuede Grips     |     24 |
| Holdfast Vest        |     22 |
| Untethered Edge Mask |     20 |

**Resilience matches: 4. Health matches: 4.** The alias worked and returned identical items and values.

6. Solar weapons with Incandescent:

* Epochal Integration — Hand Cannon
* Perfect Pitch — Submachine Gun
* The Summoner — Auto Rifle
* Heliocentric QSc — Sidearm
* No Hesitation — Auto Rifle

All five were in the vault. The result echoed Incandescent but did not echo the Solar field.

7. Vaulted legendary hand cannons or submachine guns: **31**

Grouped by name:

* IKELOS_SMG_v1.0.3 ×5
* The Recluse ×3
* Luna’s Howl ×3
* Parabellum ×3
* Noxious Vetiver ×2
* Yarovit MG4 ×2
* Zaouli’s Bane, Epochal Integration, Perfect Pitch, Rose, Exuviae, Bold Endings, Prolonged Engagement, Shayura’s Wrath, Zaouli’s Bane (Harrowed), Maahes HC4, IKELOS_HC_v1.0.3, Multimach CCX, Midnight Coup ×1 each

8. Unlocked duplicated legendary items:

The call reported **132 total**, but returned only the default first **50**. First-page name frequency:

* Indebted Kindness ×5
* The Call ×5
* IKELOS_SMG_v1.0.3 ×5
* Tinasha’s Mastery ×4
* Breachlight ×3
* Adamantite ×3
* Dark Age Helm ×2
* The Recluse ×2
* Martyr’s Retribution ×2
* Ded Gramarye IV ×2
* Yarovit MG4 ×2
* Untethered Edge Plate ×2
* Masquerader’s Hood, No Hesitation, Luna’s Howl, The Summoner, VS Velocity Baton, Noxious Vetiver, Parabellum, Heliocentric QSc, Wyrmguard Helm, Dreambane Gauntlets, Insight Rover Boots, Shadestalker Helm and Nox Sidereal IV ×1 each on the returned page

9. Postmaster: **29 entries**

* Warlock: Enhancement Core ×9; Distorted Engram ×3; Nightshade
* Hunter: Boondoggle Mk. 55; Adverse Possession IX; Memory Vestige: Light ×10; Nightshade; Legendary Engram; Lucky Raspberry; Enhancement Core; Liturgy; Martyr’s Retribution
* Titan: Insurmountable; Encrypted Engram ×2; Anonymous Autumn ×2; Legendary Engram ×7; Prime Engram ×2; Shadestalker Gauntlets; Enhancement Core ×2

The connector labels these entries with their character location rather than explicitly saying “Postmaster.”

10. Masterworked armor on characters, excluding the vault: **19**

* Warlock: Prodigal Hood; Insight Vikti Boots; Nezarec’s Sin equipped; Wyrmguard Gloves equipped; Wyrmguard Robe equipped; Wyrmguard Boots equipped
* Hunter: Liar’s Handshake; Mothkeeper’s Wraps; Hinterland Strides; Scatterhorn Cloak; Wyrmguard Tunic equipped; Wyrmguard Strides equipped
* Titan: Dark Age Gauntlets; Shadestalker Plate; Wyrmguard Helm equipped; Synthoceps equipped; Wyrmguard Chestplate equipped; Dreambane Greaves equipped; Wyrmguard Mark equipped

11. `name:the`, limit 3:

* Curio of the Nine
* Parthenon Projection
* Etheric Spiral

Returned 3 of **102** total matches. All contain the substring `the`.

12. Count check:

* All items: **868**
* Vault: **500**
* Non-vault: **368**
* Check: **500 + 368 = 868 — yes**

This required three calls because each count is a separate query.

13. Requested 500 items:

* Returned: **200**
* Item-array length: **200**
* Total inventory: **868**

The limit was clamped to 200.

14. `is:nonsense` correctly failed. Exact error appears under “Errors” below.

## C. Item detail

15. Three weapon instance IDs were submitted in **one call**.

| Weapon           | Instance ID           | Power | Stats                                                                                                                                                    |
| ---------------- | --------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service Revolver | `6917530195251084379` |   308 | Stability 71, Handling 26, Range 32, Aim Assistance 67, Ammo Generation 48, Airborne 35, Recoil 98, Zoom 14, Magazine 13, Impact 78, Reload 40, RPM 180  |
| Luna’s Howl      | `6917530018153347595` |    10 | Stability 57, Handling 36, Range 51, Aim Assistance 79, Ammo Generation 60, Airborne 45, Recoil 100, Zoom 14, Magazine 12, Impact 84, Reload 54, RPM 140 |
| Zaouli’s Bane    | `6917530005644309671` |    10 | Stability 59, Handling 47, Range 50, Aim Assistance 77, Ammo Generation 50, Airborne 19, Recoil 89, Zoom 14, Magazine 12, Impact 84, Reload 43, RPM 140  |

Selected plugs:

* Service Revolver: Precision Frame, Chambered Compensator, Tactical Mag, Shoot to Loot, Rampage, Tier 4 Stability, Vanguard Determination
* Luna’s Howl: Precision Frame, Extended Barrel, Appended Mag, Heal Clip, Kill Clip, Indomitability, Tier 1 Handling
* Zaouli’s Bane: Adaptive Frame, Smallbore, Appended Mag, Well-Rounded, Firefly, Tier 1 Handling, Runneth Over

16. Wyrmguard Gloves plug acceptance

Power 318; energy 10/10. Stats: Super 4, Health 42, Grenade 23, Class 4, Weapons 4, Melee 12.

* Socket 0, current Health Mod: displayed Empty Mod Socket, Health/Minor Health, Melee/Minor Melee, Grenade/Minor Grenade, Super/Minor Super, Class/Minor Class and Weapons Mod; **3 additional options omitted**.
* Sockets 1–3, current Firepower/Bolstering Detonation/Bolstering Detonation: displayed Empty Mod Socket, Fastball, Firepower, Impact Induction, Bolstering Detonation, Grenade Kickstart, Grenade Font, Heavy Handed, Momentum Transfer, Focusing Strike, Melee Kickstart and Melee Font; **16 additional options per socket omitted**.
* Socket 4, current Superblack: displayed Astrograph and 11 named Keepsakes; **699 additional options omitted**.
* Socket 5, current Upgrade Armor: Upgrade Armor or Random Masterwork. This was the only complete-looking option list.
* Sockets 6–7: current plug `#1835957490`; displayed only unresolved hash names such as `#969663972`; **51 additional options per socket omitted**.
* Sockets 8–9: current plugs `#166910052` and `#134899365`; displayed unresolved hash names such as `#2819908046`; **51 additional options per socket omitted**.
* Socket 10, current Chromacloak Gloves: displayed Default Ornament, Hollow Heart Gloves, Tattie-Bogle Gloves, Outlaw Rider Gloves, Gloves of the New Pilgrim Guard, Ever Sunrise Gloves, Dionaea Gloves, Gloves of the Houseless, Autonomous Flayer Gloves, Frontline Gloves, Neotenic Starfarer Gloves and Immortal Legend Gloves; **285 additional options omitted**.

The connector therefore did not expose every accepted option—only samples plus `moreOptions`.

## D. Definitions and endpoints

17. First manifest result:

* **Gjallarhorn**
* Hash: `1363886209`
* Type: Rocket Launcher
* Tier: Exotic

18. Three definitions in one call:

|         Hash | Definition                               |
| -----------: | ---------------------------------------- |
| `3796682229` | Service Revolver — Legendary Hand Cannon |
| `2763843899` | Luna’s Howl — Legendary Hand Cannon      |
|  `431721920` | Zaouli’s Bane — Legendary Hand Cannon    |

Each returned an empty trimmed `perks` array.

19. Postmaster endpoint:

`POST /Destiny2/Actions/Items/PullFromPostmaster/`
Operation ID: `Destiny2.PullFromPostmaster`

OAuth scope: `MoveEquipDestinyItems`

Request body:

* `itemReferenceHash`: integer
* `stackSize`: integer
* `itemId`: integer instance ID
* `characterId`: integer
* `membershipType`: `BungieMembershipType`

No URL parameters were listed. This used connector endpoint discovery only—no browsing.

## E. Everything else

20. Vendors

The connector returned **206 enabled vendor records with 109 distinct labels**. Repeated generic submenu labels include Movement ×12, Aspects ×12, Melees ×12, Supers ×12, Grenades ×10, Fragments ×10, Class Abilities ×9, Weapons ×6, Legacy Gear ×6 and Armor ×5.

Named/distinct labels also included Commander Zavala, The Drifter, Ada-1, Devrim Kay, Banshee-44, Saint-14, Valus Saladin, Nimbus, Spider, Mechanic Deoriks, Armorer Aghol, Failsafe, Eris Morn, Quinn Laghari, Reformancer Guzheng, Shaw Han, Petra Venj, Ikora Rey, Xûr, Master Rahool, Fynch, Variks the Loyal, Solstice Forge, Suraya Hawthorne, Micah’s Conduit, Tess Everis, Starhorse, Lord Shaxx, Exo Stranger, Monument to Lost Lights, Quest Archive, Lectern of Enchantment and the expansion/season/subclass/attunement subvendors.

Example stock from Xûr, hash `2190858386`:

* **Oathkeeper — 41 Strange Coin**

Xûr’s returned stock also included Mask of the Quiet One, Chromatic Fire, Mantle of Battle Harmony, Blight Ranger, Arbor Warden and Solipsism at 41 Strange Coin each.

21. In-game loadouts

Each character returned slots **0–15**:

* Warlock: slots 0–8 contain nonzero item IDs; slots 9–15 contain only zero IDs.
* Hunter: slots 0–1 contain nonzero IDs; slots 2–15 contain only zero IDs.
* Titan: slots 0–5 contain nonzero IDs; slots 6–15 contain only zero IDs.

Names were unresolved hashes such as `#752612103`. Every slot—including zero-filled slots—was marked `empty:false`, which looks incorrect.

22. Weekly milestones:

* King’s Fall
* Crota’s End
* Deep Stone Crypt
* Vault of Glass
* Vow of the Disciple
* Garden of Salvation
* The Desert Perpetual
* Last Wish
* Purification
* Root of Nightmares
* Salvation’s Edge
* Weekly Clan Engrams

All dated entries end `2026-08-04T17:00:00Z`; Purification had no end time.

23. Last three Warlock activities:

| UTC date            | Activity          | Completed | Kills | Deaths |    K/D |
| ------------------- | ----------------- | --------- | ----: | -----: | -----: |
| 2026-08-01 00:16:06 | Quickplay: Normal | Yes       |   147 |      0 | 147.00 |
| 2026-08-01 00:05:41 | Quickplay: Normal | Yes       |    94 |      1 |  94.00 |
| 2026-07-31 23:15:09 | Quickplay: Normal | Yes       |    84 |      0 |  84.00 |

24. Lifetime PvE vs PvP:

| Metric                           |             PvE |     PvP |
| -------------------------------- | --------------: | ------: |
| Activities entered               |           1,836 |      83 |
| Activities cleared/won           |     848 cleared |  36 won |
| Kills                            |         139,778 |     608 |
| Deaths                           |           4,197 |     965 |
| Assists                          |          31,168 |     366 |
| K/D                              |           33.30 |    0.63 |
| K/D/A                            |           37.02 |    0.82 |
| Efficiency                       |           40.73 |    1.01 |
| Opponents defeated               |         170,946 |     974 |
| Time played                      |          16d 7h | 11h 36m |
| Total activity duration          |          22d 2h | 12h 25m |
| Score                            |      20,149,458 |   1,470 |
| Best single-game kills           |           1,415 |      21 |
| Best single-game score           |       1,291,792 |      52 |
| Precision kills                  |          17,362 |     224 |
| Longest spree                    |             468 |      10 |
| Longest life                     |         45m 22s |  3m 57s |
| Suicides                         |           1,546 |      19 |
| Orbs dropped/gathered            | 24,608 / 25,223 | 81 / 87 |
| Resurrections performed/received |   1,712 / 1,563 | 49 / 50 |
| Highest light                    |           2,012 |   2,012 |
| Fireteam activities              |             961 |       6 |

Weapon kills:

| Weapon/type      |    PvE | PvP |
| ---------------- | -----: | --: |
| Auto Rifle       | 13,358 | 192 |
| Beam Rifle       |    708 |   0 |
| Bow              |  3,625 |   0 |
| Glaive           |     41 |   0 |
| Fusion Rifle     |    916 |   0 |
| Hand Cannon      | 28,402 | 138 |
| Trace Rifle      |     64 |   0 |
| Machine Gun      |    560 |   0 |
| Pulse Rifle      | 15,753 |  30 |
| Rocket Launcher  |    647 |   1 |
| Scout Rifle      |    487 |   1 |
| Shotgun          |    643 |   8 |
| Sniper           |    232 |   0 |
| Submachine Gun   |  7,042 |  44 |
| Relic            |    353 |   0 |
| Sidearm          |  5,140 |  14 |
| Sword            |  1,431 |   3 |
| Ability          |  2,597 |   0 |
| Grenade          |  5,718 |  26 |
| Grenade Launcher |  4,564 |   7 |
| Super            |  4,476 |  32 |
| Melee            | 18,544 |  90 |

The connector reported “best weapon type” as Trace Rifle for PvE and Auto Rifle for PvP.

25. Clan: **Not in a clan.**

26. `Guardian#0000`: returned `[]`—no player found, without an error.

## F. Call report

| Task | Tool(s) used                          | Calls | Looked correct?     | Notes                                             |
| ---: | ------------------------------------- | ----: | ------------------- | ------------------------------------------------- |
|    1 | `get_profile`                         |     1 | Partial             | Characters/currency present; no account name      |
|    2 | `get_character`                       |     1 | Yes                 | Stats and equipped inventory returned             |
|    3 | `search_inventory`                    |     1 | Yes                 | Correct descending power                          |
|    4 | `search_inventory`                    |     1 | Yes                 | Correct filter and stat sort                      |
|    5 | `search_inventory`                    |     1 | Yes                 | Health alias matched Resilience                   |
|    6 | `search_inventory`                    |     1 | Yes                 | Five Incandescent matches                         |
|    7 | `search_inventory`                    |     1 | Yes                 | Boolean OR and vault filters worked               |
|    8 | `search_inventory`                    |     1 | Partial             | 50 returned out of 132                            |
|    9 | `search_inventory`                    |     1 | Mostly              | Results correct; location does not say Postmaster |
|   10 | `search_inventory`                    |     1 | Yes                 | 19 non-vault masterworked armor pieces            |
|   11 | `search_inventory`                    |     1 | Yes                 | Limit 3 and substring matching worked             |
|   12 | `search_inventory`                    |     3 | Yes                 | Three independent counts                          |
|   13 | `search_inventory`                    |     1 | Yes                 | 500 clamped to 200                                |
|   14 | `search_inventory`                    |     1 | Yes, expected error | Invalid filter rejected                           |
|   15 | `get_item_details`                    |     1 | Yes                 | Three instances batched                           |
|   16 | `get_item_details`                    |     1 | Partial             | Options truncated; unresolved hashes              |
|   17 | `search_manifest`                     |     1 | Yes                 | Exact match ranked first                          |
|   18 | `get_definition`                      |     1 | Yes                 | Three hashes batched                              |
|   19 | `list_endpoints`, `describe_endpoint` |     2 | Yes                 | Discovery then full signature                     |
|   20 | `get_vendors`, `get_vendor_items`     |     2 | Yes, awkward        | Vendor index then Xûr stock                       |
|   21 | `get_loadouts`                        |     1 | Partial             | Unresolved names and bad-looking empty flags      |
|   22 | `get_milestones`                      |     1 | Yes                 | 12 milestones                                     |
|   23 | `get_activity_history`                |     1 | Yes                 | Exactly three records                             |
|   24 | `get_stats`                           |     1 | Yes                 | PvE/PvP lifetime split                            |
|   25 | `get_clan`                            |     1 | Yes                 | Not in a clan                                     |
|   26 | `search_player`                       |     1 | Yes                 | Empty result, not an error                        |

Total Destiny 2 connector calls: **30**

Tasks requiring multiple calls:

* **12:** three separate inventory populations had to be counted.
* **19:** endpoint discovery returns only the endpoint name; `describe_endpoint` supplies its parameters.
* **20:** vendor listing and vendor stock are separate tools.

### Errors, verbatim

Task 14:

```text
Error — Unknown filter "is:nonsense".
is: arc, blue, common, crafted, dupe, equipment, equippable, equipped, exotic, green, haslight, haspower, heavy, hunter, incurrentchar, inpostmaster, invault, kinetic, legendary, locked, masterwork, modded, movable, oncharacter, postmaster, primary, purple, rare, shaped, solar, special, stackable, stackfull, stasis, strand, titan, tracked, transferable, uncommon, unlocked, void, warlock, white, yellow
is: also accepts any item type from the manifest — is:handcannon, is:sniperrifle, is:helmet, is:gauntlets, is:weapon, is:armor, is:lfr, is:lmg, is:smg
text: name:, exactname:, description:, type:, perk:, perkname:, or a bare word
numbers (<, <=, =, >, >= or a bare number): power:, light:, stack:, count:, energycapacity:
stats: stat:<name>:<comparison>, e.g. stat:resilience:>=20 or stat:total:>=65
logic: implicit and, or, and, not, - prefix, ( ) grouping, "quoted phrases"
```

Requested log audit:

```text
wc: data/mcp.log: No such file or directory
grep: data/mcp.log: No such file or directory
grep: data/mcp.log: No such file or directory
grep: data/mcp.log: No such file or directory
sort: cannot read: data/mcp.log: No such file or directory
```

Therefore the round-trip count, search count, `tools/list` count, raw-call lines and largest-response report could not be independently checked.

Main awkward/impossible points:

* Plug-option responses expose only 12 options plus `moreOptions`, so task 16 could not list everything accepted.
* Several plug and loadout names remained unresolved hashes.
* Zero-filled loadout slots still reported `empty:false`.
* Vendor discovery returned 206 records, including internal submenus and repeated generic labels.
* The duplicate query returned only 50 of 132 by default.
* `get_profile` omitted the Bungie display name.
* The local MCP log was unavailable.

Tasks 27–28 were not run because you did not authorize section G, and the run remained fully read-only.


Section G completed.

27. Service Revolver (`6917530195251084379`):

28. Lock: `Locked.`

29. Verified with `exactname:"Service Revolver" is:locked is:oncharacter`—same instance returned.

30. Unlock: `Unlocked.`

Original unlocked state was restored.

28. Wyrmguard Gloves, socket 99, plug `Health Mod` returned exactly:

```text
Socket 99 FAILED: The requested socket could not be found.
```

The tool reported `isError:false`, so the per-socket failure did not abort the overall call. No valid socket was changed.

Calls: 12 read-only orbit-preflight calls, 4 calls for task 27, and 1 call for task 28—**17 connector calls total**. No web or shell calls.


### "What should be added to make it easier to call stuff?"

The biggest improvement wouldn’t be more write tools—it would be better state checks, batching, and structured responses. Those caused nearly all the friction.

## Highest priority

| Addition                    | What it should do                                                                                                            | Why                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `get_session_state`         | Return active character, online/offline, `orbit/social/activity`, current activity name/hash, and whether writes are allowed | Verifying orbit required 12 read calls and triggered a raw response reported at roughly 463k tokens |
| `search_inventory_batch`    | Accept multiple named DIM queries against one consistent inventory snapshot                                                  | Tasks 3–14 required many separate calls that repeatedly examined the same inventory                 |
| Pagination everywhere       | Return `returned`, `total`, `truncated`, `nextCursor`                                                                        | The duplicate query silently returned only 50 of 132                                                |
| Native structured responses | Put actual objects in `structuredContent`, rather than JSON encoded inside text                                              | Currently every result needs an extra JSON parse and error handling is inconsistent                 |
| Safe write preconditions    | Support `require_state:"orbit"`, `expected_locked:false`, `dry_run:true`, and `verify:true`                                  | Makes writes both safer and much cheaper to validate                                                |

A good `get_session_state` response would look like:

```json
{
  "online": true,
  "activeCharacterId": "2305843009928315363",
  "state": "orbit",
  "activity": {
    "hash": 82913930,
    "name": "Orbit"
  },
  "writeEligibility": {
    "transfer": true,
    "equip": true,
    "socket": true
  },
  "checkedAt": "2026-08-01T04:06:49Z"
}
```

The important part is that the connector should label the state itself. I shouldn’t have to infer orbit from blank manifest definitions.

## Inventory improvements

Add these options to `search_inventory`:

* `count_only:true`
* `group_by:"name"` for duplicate audits
* `fields:["name","instanceId","power"]` to control response size
* `cursor` or `offset`
* `instance_id:` filtering
* `locations:["vault","characters","postmaster"]`
* `include_lock_state:true`
* `explain:true`, returning the normalized query and aliases used

For example, task 12 could become one call:

```json
{
  "queries": [
    {"id":"all","query":""},
    {"id":"vault","query":"is:invault"},
    {"id":"nonvault","query":"-is:invault"}
  ],
  "count_only": true
}
```

The Health alias should also echo something like:

```json
{
  "normalizedQuery": "stat:resilience:>=20",
  "aliasesApplied": {
    "health": "resilience"
  }
}
```

That would make alias testing unambiguous.

## Socket and item-detail improvements

`get_item_details` needs a dedicated socket-option mode or separate `get_socket_options` tool.

It should return:

* Every option through pagination—not 12 options followed by `moreOptions:699`
* Resolved names instead of `#1835957490`
* Description/effect
* Energy cost
* Whether the player owns/unlocked it
* Whether it is currently insertable
* If not insertable, an exact reason
* Which plug category the socket accepts
* Multiple requested socket indexes in one call

Something like:

```json
{
  "socketIndex": 1,
  "category": "Arms Armor Mod",
  "optionCount": 28,
  "options": [
    {
      "hash": 2485657760,
      "name": "Firepower",
      "energyCost": 3,
      "owned": true,
      "insertable": true,
      "description": "..."
    }
  ],
  "nextCursor": null
}
```

Also add `validate_plug_changes`, which runs all socket validation without writing.

## Better write results

Task 28 returned:

```text
Socket 99 FAILED: The requested socket could not be found.
```

…but top-level `isError` was `false`. That behavior may be intentional for batched operations, but it needs structured status:

```json
{
  "status": "partial_failure",
  "appliedCount": 0,
  "failureCount": 1,
  "results": [
    {
      "socketIndex": 99,
      "plug": "Health Mod",
      "applied": false,
      "errorCode": "SOCKET_NOT_FOUND",
      "message": "The requested socket could not be found."
    }
  ]
}
```

For locking, `set_lock_state` should support `verify:true` and return:

```json
{
  "itemInstanceId": "...",
  "previousState": "unlocked",
  "currentState": "locked",
  "verified": true
}
```

That removes the extra inventory verification call while remaining safe.

## Other worthwhile fixes

* Include Bungie name, membership ID/type and cross-save membership in `get_profile`. It originally couldn’t answer “Who am I?”
* Add response projection to `bungie_api_call`, such as `select:"characterActivities.data.*.currentActivityHash"`, so raw calls cannot return hundreds of thousands of unnecessary tokens.
* Combine `list_endpoints` and `describe_endpoint` into `find_endpoints(include_signatures:true)`.
* Let `get_vendors` filter to actual NPCs, submenus, enabled vendors or a specific name. Returning 206 entries—including many repeated “Movement,” “Melees,” and “Aspects” menus—is noisy.
* Fix `get_loadouts`: zero-filled slots should be `empty:true`, and names should be resolved instead of `#2166136261`.
* Make Postmaster results explicitly say `locationType:"postmaster"` rather than only naming the owning character.
* Include activity hashes and correctly resolved activity/mode names in history.
* Add diagnostics metadata to every response: request ID, round trips, duration, cache hit, response bytes and truncation status.
* Add a read-only `get_connector_diagnostics` tool. That would replace reliance on an inaccessible local `data/mcp.log`.
* Shorten tool descriptions. Every Destiny tool repeats the same long “full read/write access” introduction, which caused the tool registry output itself to be truncated.

If you only build three things, I’d pick:

1. `get_session_state`
2. Batched/paginated inventory search
3. Fully structured results and per-operation write errors

Those three would have cut this test from roughly 47 connector calls across both runs to probably under 15, while also making the writes safer.


## Takeaways

### Verdict on the run

26/26 tasks answered, 30 calls, one intentional error. Search engine (DIM syntax, aliases, boolean/parens, clamping, sort) held up under everything thrown at it — that's the hard part and it works. Failures were all in the *thin* tools: loadouts, vendors, profile, socket options.

### Real bugs (server is wrong, fix these) — all 5 FIXED in v1.5.0

| # | Bug | Fix |
|---|-----|-----|
| 1 | Every loadout slot reports `empty:false`, incl. zero-filled ones. Bungie always sends 16 slots with `itemInstanceId:"0"` | filter `"0"` ids, then flag off what's left |
| 2 | Loadout name `#2166136261` — the FNV-1a offset basis = "no name set", confirmed absent from `DestinyLoadoutNameDefinition` (22 rows) | `getDef(...)?.name ?? null` instead of `defName` |
| 3 | `get_profile` can't answer "who am I" | `getAccount()` now keeps `bungieName`; profile returns it + membershipId/Type |
| 4 | `get_vendors` returns 206 records; `!name.startsWith('#')` doesn't strip subclass submenus | real NPCs are the ones with a `subtitle` ("Agent of the Nine"); submenus have none. `include_submenus:true` to opt back in |
| 5 | Sockets 6–9 options come back as `#969663972` | not a lookup failure — those defs exist with `name:""`, `plugCategoryIdentifier:"intrinsics"`. Hidden intrinsics the game never offers; now filtered out of options, and a nameless current plug reads `null` |

Trade-off on #4: "Solstice Forge" and a couple of seasonal kiosks have no subtitle either, so they fall out of the default list. `include_submenus:true` gets them back.

### Highest-ROI additions — all 4 BUILT in v1.6.0, verified live

1. **`get_session_state`** — one call (components `200,204,1000`) returns `state` and per-operation `writeCapabilities`. Eligibility comes from the **active** character only (newest `dateLastPlayed`): idle characters sit at `currentActivityHash: 0`, so an "any character is in orbit" rule would green-light an equip mid-raid. Unresolvable state fails closed. Live: correctly reported `orbit` / `equip: true` with the other two characters at 0.
2. **`select:` + 100KB guard on `bungie_api_call`** — re-ran the exact call that produced the ~463k-token response: **2,731,391 bytes → 587 chars**, returned as a per-key size map pointing at the weight (`itemComponents` was 2.13MB of it). Projected, the same answer is 272 chars. Bad paths come back in `unmatchedSelect` rather than vanishing. `allow_large_response:true` to override.
3. **`queries` / `count_only` / `group_by` on `search_inventory`** — task 12 live: 868 = 500 + 368 in **one** call instead of three. Task 8 live: all **132** dupes counted across 51 groups instead of the first 50. `group_by:"itemHash"` exists because `name` merges distinct items — Luna's Howl has two hashes.
4. **Paginated socket options** — `option_limit` (max 200) + `option_offset`. Raising the cap to 500 would still have stranded the 693-option shader socket; live paging walked it 200/200/200/93 with `nextOffset: null` only on the last page.

Call count for the 26 tasks lands near 27, not "under half" — projection and `count_only` shrink responses, they don't remove round trips. `queries` is the only one that removes calls. The win here is response size and completeness.

### Rejected / non-issues

- **"Dupe query silently returned 50 of 132"** — not silent, `total` is in every response. Model just didn't re-call with a higher limit. Working as designed.
- **`data/mcp.log` "unavailable"** — the log exists server-side (`src/index.ts:22`). ChatGPT has no shell on that box. Model confusion, not a gap.
- **`search_inventory_batch`** — a batch-of-queries tool is a whole new schema to solve what `count_only` + `group_by` already cover. Skip until those aren't enough.
- **Per-response diagnostics metadata (request id, bytes, cache hit, duration)** — pays tokens on every single response to answer a question asked once. Server log already has it.
- **`get_connector_diagnostics`** — same, and it exists to work around #2 above (the log). Fix the log access story, not the symptom.
- **Write preconditions (`require_state`, `dry_run`, `verify`)** — `require_state` is `get_session_state` again; `verify:true` on lock is the only one worth it, and it's cheap.
- **`structuredContent` migration** — legitimate MCP-spec improvement, but nothing in this run actually broke from JSON-in-text. Later.
- **Shorten tool descriptions** — worth doing (it claims the tool registry itself got truncated), but the long descriptions are what make one-call DIM queries happen. Trim the repeated preamble, keep the examples.
