import { describe, it, expect, vi, beforeEach } from 'vitest';

// A tiny stand-in manifest: mods in three different plug categories, an armour piece that belongs
// to a set, and an exotic with an intrinsic. Enough to pin what is ours — url parsing, slot
// grouping, set bonuses — without a 200MB sqlite file.
const ITEMS: Record<number, any> = {
  1: { hash: 1, displayProperties: { name: 'Big Class Mod' }, plug: { plugCategoryIdentifier: 'enhancements.v2_general', energyCost: { energyCost: 3 } } },
  3: { hash: 3, displayProperties: { name: 'Grenade Kickstart' }, plug: { plugCategoryIdentifier: 'enhancements.v2_arms', energyCost: { energyCost: 4 } } },
  4: { hash: 4, displayProperties: { name: 'Balanced Tuning' }, plug: { plugCategoryIdentifier: 'core.gear_systems.armor_tiering.plugs.tuning.mods' } },
  50: {
    hash: 50, itemType: 2, itemTypeDisplayName: 'Gauntlets', displayProperties: { name: 'Test Gloves' },
    inventory: { bucketTypeHash: 3551918588, tierTypeName: 'Legendary' },
  },
  60: {
    hash: 60, itemType: 2, itemTypeDisplayName: 'Helmet', displayProperties: { name: 'Test Exotic Helm' },
    inventory: { bucketTypeHash: 3448274439, tierTypeName: 'Exotic' },
    sockets: { socketEntries: [{ singleInitialItemHash: 61 }] },
  },
  61: { hash: 61, displayProperties: { name: 'Big Perk', description: 'Does the thing.' }, plug: { plugCategoryIdentifier: 'intrinsics' } },
  70: { hash: 70, itemType: 16, displayProperties: { name: 'Stormcaller' }, inventory: { bucketTypeHash: 3284755031 } },
  71: { hash: 71, displayProperties: { name: 'Chaos Reach' }, plug: { plugCategoryIdentifier: 'warlock.arc.supers' } },
  72: { hash: 72, displayProperties: { name: 'Arc Soul' }, plug: { plugCategoryIdentifier: 'warlock.arc.aspects' } },
  73: { hash: 73, displayProperties: { name: 'Spark of Ions' }, plug: { plugCategoryIdentifier: 'shared.arc.fragments' } },
  81: { hash: 81, displayProperties: { name: 'Overload Bow' } },
  82: { hash: 82, displayProperties: { name: 'Elemental Siphon' } },
  83: { hash: 83, displayProperties: { name: 'Retired Perk' } },
  84: { hash: 84, displayProperties: { name: 'Retired Artifact' } },
  85: { hash: 85, displayProperties: { name: 'Live Artifact' } },
};

vi.mock('../src/manifest.js', () => ({
  getDef: (table: string, hash: number) =>
    table === 'DestinySandboxPerkDefinition'
      ? { displayProperties: { name: 'Set Perk', description: 'Two pieces do something.' } }
      : ITEMS[hash],
  defName: (_t: string, hash: number) => ITEMS[hash]?.displayProperties?.name ?? `#${hash}`,
  eachDef: (table: string) => table === 'DestinyArtifactDefinition'
    // Only the live artifact ships with tiers; retired ones are a name in the item table.
    ? [{ hash: 800, displayProperties: { name: 'Live Artifact' }, tiers: [{ items: [{ itemHash: 81 }, { itemHash: 82 }] }] }]
    : table === 'DestinySeasonDefinition'
    ? [{ seasonNumber: 26, artifactItemHash: 84 }, { seasonNumber: 27, artifactItemHash: 85 }]
    : [{
      hash: 900, displayProperties: { name: 'Testwear' }, setItems: [50],
      setPerks: [{ requiredSetCount: 2, sandboxPerkHash: 901 }],
    }],
}));

const { parseShareUrl, fetchDimLoadout, modsBySlot, describeLoadout, resetSetCache, DimShareError } =
  await import('../src/dim.js');

describe('share links', () => {
  it('pulls the share id out of every link shape DIM hands out', () => {
    expect(parseShareUrl('https://dim.gg/o3incja/Chaos-Engine').shareId).toBe('o3incja');
    expect(parseShareUrl('o3incja').shareId).toBe('o3incja');
    expect(parseShareUrl('https://api.destinyitemmanager.com/loadout_share?shareId=abc12').shareId).toBe('abc12');
  });

  it('reads a loadout straight out of a ?loadout= link without a network call', () => {
    const lo = { name: 'Inline', classType: 2, equipped: [{ id: '1', hash: 50 }] };
    const url = `https://app.destinyitemmanager.com/loadouts?loadout=${encodeURIComponent(JSON.stringify(lo))}`;
    expect(parseShareUrl(url).loadout).toEqual(lo);
  });

  it('rejects a link that is not a DIM share', () => {
    expect(() => parseShareUrl('https://example.com/build')).toThrow(DimShareError);
  });

  it('reports a dead share id rather than returning an empty build', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(fetchDimLoadout('https://dim.gg/gone/Nope')).rejects.toThrow(/expired/);
  });
});

describe('describeLoadout', () => {
  beforeEach(() => { vi.unstubAllGlobals(); resetSetCache(); });

  it('groups the flat mod list by the slot each plug category restricts it to', () => {
    const by = modsBySlot([3, 1, 4]);
    expect(by.gauntlets.map((m) => m.name)).toEqual(['Grenade Kickstart']);
    expect(by.general.map((m) => m.name)).toEqual(['Big Class Mod']);
    expect(by.tuning.map((m) => m.name)).toEqual(['Balanced Tuning']);
    expect(by.gauntlets[0].energy).toBe(4);
  });

  it('splits subclass socketOverrides into super, aspects and fragments with their socket indexes', () => {
    const out: any = describeLoadout({
      name: 'B', classType: 2,
      equipped: [{ id: '1', hash: 70, socketOverrides: { '2': 71, '5': 72, '7': 73 } }],
    } as any, 'abc');
    expect(out.subclass.super).toEqual({ name: 'Chaos Reach', description: undefined, socket: 2 });
    expect(out.subclass.aspects.map((a: any) => a.name)).toEqual(['Arc Soul']);
    expect(out.subclass.fragments.map((f: any) => f.socket)).toEqual([7]);
  });

  it('reports set bonuses and whether the piece count activates them', () => {
    const out: any = describeLoadout({
      name: 'B', classType: 2, equipped: [{ id: '1', hash: 50 }],
    } as any);
    expect(out.setBonuses).toEqual([{
      set: 'Testwear', piecesInBuild: 1,
      perks: [{ requires: 2, active: false, name: 'Set Perk', description: 'Two pieces do something.' }],
    }]);
  });

  it('pulls the intrinsic off an exotic so the build explains itself', () => {
    const out: any = describeLoadout({ name: 'B', classType: 2, equipped: [{ id: '1', hash: 60 }] } as any);
    expect(out.armor[0].exoticPerk).toEqual({ name: 'Big Perk', description: 'Does the thing.' });
  });

  const withArtifact = (unlockedItemHashes: number[], notes?: string) => describeLoadout({
    name: 'B', classType: 2, equipped: [], notes,
    parameters: { artifactUnlocks: { seasonNumber: 28, unlockedItemHashes } },
  } as any) as any;

  it('names the artifact a build was saved on so the notes cannot be believed over it', () => {
    expect(withArtifact([81, 82]).artifact).toEqual({
      savedInSeason: 28, name: 'Live Artifact', current: true, note: undefined,
      notesMentionArtifact: undefined, conflict: undefined,
      perks: ['Overload Bow', 'Elemental Siphon'],
    });
  });

  it('resolves the disagreement when the notes name a different artifact', () => {
    const a = withArtifact([81, 82], 'Run Retired Artifact: dielectric, flashover').artifact;
    expect(a.notesMentionArtifact).toBe('Retired Artifact');
    expect(a.conflict).toMatch(/"Retired Artifact" \(the Season 26 artifact\).*NOTES are out of date/s);
    // The live artifact carries across seasons, so no season number is claimed for it.
    expect(a.conflict).not.toMatch(/Season 27/);
  });

  it('says nothing when the notes name the artifact the build was actually saved on', () => {
    expect(withArtifact([81, 82], 'Live Artifact: siphon').artifact.conflict).toBeUndefined();
  });

  it('flags perks that are not all from the artifact in the game today', () => {
    const a = withArtifact([81, 83]).artifact;
    expect(a.current).toBe(false);
    expect(a.name).toBeUndefined();
    expect(a.note).toMatch(/Live Artifact.*1 of 2 still current/);
  });

  it('keeps the author notes verbatim rather than parsing gear out of them', () => {
    const notes = 'Exotic armor: Fallen sunstar\nTablet of Ruin: dielectric\n\n';
    const out: any = describeLoadout({ name: 'B', classType: 2, equipped: [], notes } as any);
    expect(out.notes).toBe(notes.trim());
  });
});
