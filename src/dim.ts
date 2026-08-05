/**
 * DIM loadout shares.
 *
 * dim.gg/<shareId>/<slug> is a redirect page whose "Open in DIM" link carries the whole loadout as
 * a urlencoded JSON query param. The same document is served straight from DIM's API with no key
 * and no auth:  GET https://api.destinyitemmanager.com/loadout_share?shareId=<id>
 * (https://github.com/DestinyItemManager/dim-api — the profile endpoints need X-API-Key and a
 * bearer token, loadout_share is deliberately public so shared links work for anyone.)
 *
 * Everything in the share is hashes. The instance ids inside it belong to the person who shared it
 * and mean nothing on another account, so matching is always by hash.
 */
import { defName, eachDef, getDef } from './manifest.js';

const I = 'DestinyInventoryItemDefinition';
const API = 'https://api.destinyitemmanager.com/loadout_share';

export class DimShareError extends Error {}

export interface DimLoadoutItem {
  id: string;
  hash: number;
  /** Socket index -> plug hash. Subclass config lives here; so do chosen weapon perks. */
  socketOverrides?: Record<string, number>;
}

export interface DimLoadout {
  id?: string;
  name: string;
  classType: number;
  equipped: DimLoadoutItem[];
  unequipped?: DimLoadoutItem[];
  notes?: string;
  createdAt?: number;
  parameters?: {
    /** Flat list of armor mod hashes. Which piece each belongs to is derived, not stored. */
    mods?: number[];
    /** Fashion: bucket hash -> [shader, ornament]. */
    modsByBucket?: Record<string, number[]>;
    artifactUnlocks?: { seasonNumber: number; unlockedItemHashes: number[] };
    statConstraints?: { statHash: number; minTier?: number; maxTier?: number; ignored?: boolean }[];
    exoticArmorHash?: number;
    query?: string;
  };
}

const CLASS_NAMES = ['Titan', 'Hunter', 'Warlock'];

/** Armor mod plug categories -> the slot the mod belongs to. */
const MOD_SLOTS: Record<string, string> = {
  'enhancements.v2_head': 'helmet',
  'enhancements.v2_arms': 'gauntlets',
  'enhancements.v2_chest': 'chest',
  'enhancements.v2_legs': 'legs',
  'enhancements.v2_class_item': 'classItem',
  'enhancements.v2_general': 'general',
  'enhancements.artifice': 'artifice',
};
const TUNING = 'core.gear_systems.armor_tiering.plugs.tuning.mods';

// ---------------------------------------------------------------- fetching

/** dim.gg link, an app.destinyitemmanager.com ?loadout=... link, or a bare share id. */
export function parseShareUrl(url: string): { shareId?: string; loadout?: DimLoadout } {
  const trimmed = url.trim();

  // The long form embeds the loadout itself — no network call needed.
  const inline = /[?&]loadout=([^&]+)/.exec(trimmed);
  if (inline) {
    try {
      return { loadout: JSON.parse(decodeURIComponent(inline[1].replace(/\+/g, ' '))) };
    } catch (e: any) {
      throw new DimShareError(`That ?loadout= link did not contain valid JSON: ${e?.message ?? e}`);
    }
  }

  const short = /dim\.gg\/([A-Za-z0-9_-]+)/.exec(trimmed)
    ?? /[?&]shareId=([A-Za-z0-9_-]+)/.exec(trimmed)
    ?? (/^[A-Za-z0-9_-]{4,16}$/.test(trimmed) ? [trimmed, trimmed] : null);
  if (!short) {
    throw new DimShareError(
      `Not a DIM loadout link: "${url.slice(0, 120)}". Expected https://dim.gg/<id>/<name>, a DIM url with ?loadout=..., or a bare share id.`);
  }
  return { shareId: short[1] };
}

export async function fetchDimLoadout(url: string): Promise<{ loadout: DimLoadout; shareId?: string }> {
  const parsed = parseShareUrl(url);
  if (parsed.loadout) return { loadout: parsed.loadout };

  const res = await fetch(`${API}?shareId=${encodeURIComponent(parsed.shareId!)}`, {
    headers: { accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new DimShareError(res.status === 404
      ? `DIM has no loadout with share id "${parsed.shareId}" — the link may have expired.`
      : `DIM API returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let body: any;
  try { body = JSON.parse(text); } catch { throw new DimShareError(`DIM API returned non-JSON: ${text.slice(0, 200)}`); }
  const loadout = body.loadout ?? body;
  if (!loadout?.equipped) throw new DimShareError(`DIM API response had no loadout in it: ${text.slice(0, 200)}`);
  return { loadout, shareId: parsed.shareId };
}

// ---------------------------------------------------------------- describing

const desc = (d: any): string | undefined => {
  const own = d?.displayProperties?.description;
  if (own) return own;
  // Armor mods keep their text on a sandbox perk, not on the item.
  for (const p of d?.perks ?? []) {
    const t = getDef('DestinySandboxPerkDefinition', p.perkHash)?.displayProperties?.description;
    if (t) return t;
  }
  return undefined;
};

const energyCost = (d: any): number => d?.plug?.energyCost?.energyCost ?? 0;

/** Every armor set, indexed by member item hash — for "same set" matching and set-bonus reporting. */
let setsByItem: Map<number, any> | null = null;
export function armorSet(itemHash: number): any | undefined {
  if (!setsByItem) {
    setsByItem = new Map();
    for (const s of eachDef('DestinyEquipableItemSetDefinition')) {
      for (const h of s.setItems ?? []) setsByItem.set(h, s);
    }
  }
  return setsByItem.get(itemHash);
}
export function resetSetCache(): void { setsByItem = null; liveArtifact = undefined; }

/**
 * Only the artifact that is live right now ships with its tiers populated — retired ones survive
 * in the item table as a name and nothing else. So the perk hashes themselves say whether a
 * share's artifact is current, and no account call is needed to find out.
 */
let liveArtifact: { name?: string; perks: Set<number> } | null | undefined;
function currentArtifact() {
  if (liveArtifact === undefined) {
    const a = eachDef('DestinyArtifactDefinition').find((x: any) => x.tiers?.length);
    liveArtifact = a
      ? {
        name: a.displayProperties?.name,
        perks: new Set<number>((a.tiers ?? []).flatMap((t: any) => (t.items ?? []).map((i: any) => i.itemHash))),
      }
      : null;
  }
  return liveArtifact;
}

/**
 * A share stores the artifact perks that were unlocked when it was saved. Report which artifact
 * they are, and whether that is the one in the game today — otherwise the only artifact signal in
 * the response is a season number and whatever the author typed in the notes, and those two
 * disagreeing is exactly how a stale build gets read as the current one.
 */
function describeArtifact(art: NonNullable<DimLoadout['parameters']>['artifactUnlocks']) {
  if (!art) return undefined;
  const live = currentArtifact();
  const hashes = art.unlockedItemHashes ?? [];
  const fromLive = live ? hashes.filter((h) => live.perks.has(h)).length : 0;
  const current = !!live && hashes.length > 0 && fromLive === hashes.length;
  return {
    // The share's own count, which is DIM's season numbering — not the manifest's.
    seasonPerDim: art.seasonNumber,
    name: current ? live!.name : undefined,
    current,
    note: current
      ? undefined
      : `these perks are not (all) from ${live?.name ?? 'the live artifact'}, the seasonal artifact in the game today — they are a snapshot from when the build was saved${fromLive ? ` (${fromLive} of ${hashes.length} still current)` : ''}`,
    perks: hashes.map((h) => defName(I, h)),
  };
}

/** Split subclass socketOverrides into the pieces a player actually talks about. */
function subclassSetup(item: DimLoadoutItem) {
  const out: Record<string, any> = { name: defName(I, item.hash), aspects: [], fragments: [] };
  for (const [idx, plug] of Object.entries(item.socketOverrides ?? {})) {
    const d = getDef(I, plug);
    const pci: string = d?.plug?.plugCategoryIdentifier ?? '';
    const entry = { name: d?.displayProperties?.name ?? `#${plug}`, description: desc(d), socket: Number(idx) };
    if (pci.endsWith('.supers')) out.super = entry;
    else if (pci.endsWith('.class_abilities')) out.classAbility = entry;
    else if (pci.endsWith('.movement')) out.movement = entry;
    else if (pci.endsWith('.melee')) out.melee = entry;
    else if (pci.endsWith('.grenades')) out.grenade = entry;
    else if (pci.endsWith('.aspects')) out.aspects.push(entry);
    else if (pci.endsWith('.fragments')) out.fragments.push(entry);
    else (out.other ??= []).push(entry);
  }
  return out;
}

/** Group the flat mod list by the slot each mod's plug category restricts it to. */
export function modsBySlot(mods: number[] = []) {
  const out: Record<string, { hash: number; name: string; energy: number; description?: string }[]> = {};
  for (const h of mods) {
    const d = getDef(I, h);
    const pci: string = d?.plug?.plugCategoryIdentifier ?? '';
    const slot = pci === TUNING ? 'tuning' : MOD_SLOTS[pci] ?? 'other';
    (out[slot] ??= []).push({
      hash: h, name: d?.displayProperties?.name ?? `#${h}`, energy: energyCost(d), description: desc(d),
    });
  }
  return out;
}

/** Everything the share says, resolved to names. No account, no auth. */
export function describeLoadout(loadout: DimLoadout, shareId?: string) {
  const items = loadout.equipped.map((e) => ({ e, d: getDef(I, e.hash) }));
  const weapons: any[] = [];
  const armor: any[] = [];
  const other: any[] = [];
  let subclass: any;

  for (const { e, d } of items) {
    const base = {
      name: d?.displayProperties?.name ?? `#${e.hash}`,
      hash: e.hash,
      type: d?.itemTypeDisplayName,
      tier: d?.inventory?.tierTypeName,
      slot: defName('DestinyInventoryBucketDefinition', d?.inventory?.bucketTypeHash ?? 0),
    };
    if (d?.itemType === 16) { subclass = subclassSetup(e); continue; }
    if (d?.itemType === 3) {
      weapons.push({
        ...base,
        // Only present when the sharer pinned specific perks (crafted / enhanced weapons).
        perks: e.socketOverrides
          ? Object.entries(e.socketOverrides).map(([s, p]) => ({ socket: Number(s), name: defName(I, p) }))
          : undefined,
      });
    } else if (d?.itemType === 2) {
      const set = armorSet(e.hash);
      armor.push({ ...base, set: set?.displayProperties?.name, exoticPerk: d?.inventory?.tierTypeName === 'Exotic' ? exoticPerk(d) : undefined });
    } else {
      other.push(base);
    }
  }

  // A set bonus is usually the whole reason the build wears four matching legendaries.
  const setBonuses = [];
  const counts = new Map<any, number>();
  for (const a of armor) {
    const set = armorSet(a.hash);
    if (set) counts.set(set, (counts.get(set) ?? 0) + 1);
  }
  for (const [set, n] of counts) {
    const perks = (set.setPerks ?? []).map((p: any) => {
      const sp = getDef('DestinySandboxPerkDefinition', p.sandboxPerkHash);
      return {
        requires: p.requiredSetCount,
        active: n >= p.requiredSetCount,
        name: sp?.displayProperties?.name,
        description: sp?.displayProperties?.description || undefined,
      };
    });
    setBonuses.push({ set: set.displayProperties?.name, piecesInBuild: n, perks });
  }

  const fashion: Record<string, any> = {};
  for (const [bucket, plugs] of Object.entries(loadout.parameters?.modsByBucket ?? {})) {
    const slot = defName('DestinyInventoryBucketDefinition', Number(bucket));
    const entry: Record<string, string> = {};
    for (const h of plugs) {
      const d = getDef(I, h);
      entry[/armor_skins/.test(d?.plug?.plugCategoryIdentifier ?? '') ? 'ornament' : 'shader'] =
        d?.displayProperties?.name ?? `#${h}`;
    }
    fashion[slot] = entry;
  }

  return {
    shareId: shareId ?? loadout.id,
    name: loadout.name,
    class: CLASS_NAMES[loadout.classType] ?? 'Any',
    classType: loadout.classType,
    createdAt: loadout.createdAt ? new Date(loadout.createdAt).toISOString() : undefined,
    // Free text the author wrote. Often names gear or artifact perks the loadout itself does not
    // carry (weapon perk picks, artifact columns) — report it, never treat it as equipment.
    notes: loadout.notes?.trim() || undefined,
    subclass,
    weapons,
    armor,
    setBonuses: setBonuses.length ? setBonuses : undefined,
    otherItems: other.length ? other : undefined,
    mods: modsBySlot(loadout.parameters?.mods),
    fashion: Object.keys(fashion).length ? fashion : undefined,
    artifact: describeArtifact(loadout.parameters?.artifactUnlocks),
    searchQuery: loadout.parameters?.query,
    unequipped: loadout.unequipped?.length
      ? loadout.unequipped.map((e) => ({ name: defName(I, e.hash), hash: e.hash })) : undefined,
  };
}

function exoticPerk(d: any): { name: string; description?: string } | undefined {
  // The intrinsic is socket 0's initial item on every exotic armour piece.
  const h = d?.sockets?.socketEntries?.find((s: any) => s.singleInitialItemHash
    && getDef(I, s.singleInitialItemHash)?.plug?.plugCategoryIdentifier === 'intrinsics')?.singleInitialItemHash;
  if (!h) return undefined;
  const p = getDef(I, h);
  return { name: p?.displayProperties?.name, description: desc(p) };
}
