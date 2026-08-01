import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bungie.js', () => ({
  bungieFetch: vi.fn(async () => ({})),
  getAccount: vi.fn(async () => ({ membershipType: 3, membershipId: 'MID', characterIds: ['C1'] })),
  BungieError: class BungieError extends Error {},
}));
vi.mock('../src/manifest.js', () => ({
  defName: vi.fn((_t: string, hash: number) => `Item${hash}`),
  getDef: vi.fn(() => undefined),
  searchDefs: vi.fn(() => []),
  eachDef: vi.fn(() => []),
}));

const { registerReadTools } = await import('../src/tools/read.js');
const { bungieFetch } = await import('../src/bungie.js');
const { getDef } = await import('../src/manifest.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerReadTools({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}

const detail = (hash: number) => ({ item: { data: { itemHash: hash } }, sockets: { data: { sockets: [] } } });
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => {
  vi.mocked(bungieFetch).mockClear();
  vi.mocked(getDef).mockReset().mockReturnValue(undefined);
});

describe('get_item_details batching', () => {
  it('fetches every id in one call and tags each result with its instance id', async () => {
    vi.mocked(bungieFetch).mockImplementation(async (p: string) => detail(p.includes('/AAA/') ? 1 : 2) as any);
    const out = parse(await capture().get_item_details({
      item_instance_ids: ['AAA', 'BBB'], include_plug_options: false,
    }));
    expect(out.map((o: any) => o.itemInstanceId)).toEqual(['AAA', 'BBB']);
    expect(out.map((o: any) => o.name)).toEqual(['Item1', 'Item2']);
    const paths = vi.mocked(bungieFetch).mock.calls.map(([p]) => p);
    expect(paths).toContain('/Destiny2/3/Profile/MID/Item/AAA/');
    expect(paths).toContain('/Destiny2/3/Profile/MID/Item/BBB/');
  });

  it('reports a failed id in place and still returns the others', async () => {
    vi.mocked(bungieFetch).mockImplementation(async (p: string) => {
      if (p.includes('/BAD/')) throw new Error('DestinyItemNotFound');
      return detail(1) as any;
    });
    const out = parse(await capture().get_item_details({
      item_instance_ids: ['OK1', 'BAD', 'OK2'], include_plug_options: false,
    }));
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ itemInstanceId: 'BAD', error: 'DestinyItemNotFound' });
    expect(out[0].name).toBe('Item1');
    expect(out[2].name).toBe('Item1');
  });

  it('always asks Bungie for the reusable-plugs component, which god-roll matching needs', async () => {
    vi.mocked(bungieFetch).mockImplementation(async () => detail(1) as any);
    const tools = capture();
    await tools.get_item_details({ item_instance_ids: ['A'], include_plug_options: false });
    expect((vi.mocked(bungieFetch).mock.calls[0][1] as any).query.components).toContain('310');
    await tools.get_item_details({ item_instance_ids: ['A'], include_plug_options: true });
    expect((vi.mocked(bungieFetch).mock.calls[1][1] as any).query.components).toContain('310');
  });

  it('still lists plug options only when they are asked for', async () => {
    vi.mocked(bungieFetch).mockImplementation(async () => detail(1) as any);
    const [quiet] = parse(await capture().get_item_details({ item_instance_ids: ['A'], include_plug_options: false }));
    expect(quiet.sockets.every((s: any) => s.options === undefined)).toBe(true);
  });

  it('drops nameless hidden intrinsics from plug options and from the current plug', async () => {
    // 11 is a real mod; 12 is an armor intrinsic with an empty name — the game never offers it.
    vi.mocked(getDef).mockImplementation((_t: string, hash: number) =>
      hash === 11 ? { displayProperties: { name: 'Firepower' } } : { displayProperties: { name: '' } });
    vi.mocked(bungieFetch).mockImplementation(async () => ({
      item: { data: { itemHash: 1 } },
      sockets: { data: { sockets: [{ plugHash: 12, isEnabled: true }] } },
      reusablePlugs: { data: { plugs: { '0': [{ plugItemHash: 11, canInsert: true }, { plugItemHash: 12, canInsert: true }] } } },
    }) as any);
    const [out] = parse(await capture().get_item_details({
      item_instance_ids: ['A'], include_plug_options: true, socket_index: 0, option_limit: 12, option_offset: 0,
    }));
    expect(out.sockets[0].plug).toBeNull();
    expect(out.sockets[0].options).toEqual([{ hash: 11, name: 'Firepower' }]);
  });

  it('pages socket options to the end, and only the last page has no nextOffset', async () => {
    // 250 distinct plugs in one socket — the real shader/ornament case is 700+.
    const plugs = Array.from({ length: 250 }, (_, n) => ({ plugItemHash: n + 1, canInsert: true }));
    vi.mocked(getDef).mockImplementation((_t: string, hash: number) => ({ displayProperties: { name: `Plug${hash}` } }));
    vi.mocked(bungieFetch).mockImplementation(async () => ({
      item: { data: { itemHash: 1 } },
      sockets: { data: { sockets: [{ plugHash: 1, isEnabled: true }] } },
      reusablePlugs: { data: { plugs: { '0': plugs } } },
    }) as any);
    const page = async (option_offset: number) => (parse(await capture().get_item_details({
      item_instance_ids: ['A'], include_plug_options: true, socket_index: 0, option_limit: 200, option_offset,
    })))[0].sockets[0];

    const first = await page(0);
    expect(first).toMatchObject({ optionTotal: 250, optionOffset: 0, moreOptions: 50, nextOffset: 200 });
    expect(first.options).toHaveLength(200);

    const last = await page(first.nextOffset);
    expect(last).toMatchObject({ optionTotal: 250, optionOffset: 200, nextOffset: null });
    expect(last.options).toHaveLength(50);
    expect(last.moreOptions).toBeUndefined();
    expect(last.options.at(-1)).toEqual({ hash: 250, name: 'Plug250' });
  });
});

describe('get_session_state', () => {
  const ORBIT = 82913930;
  // Warlock played most recently, so it is the active one; the other two report 0 like Bungie does.
  const session = (activeHash: number, online = true) => ({
    characters: { data: {
      W: { characterId: 'W', dateLastPlayed: '2026-08-01T00:16:06Z' },
      H: { characterId: 'H', dateLastPlayed: '2026-07-20T00:00:00Z' },
      T: { characterId: 'T', dateLastPlayed: '2026-07-01T00:00:00Z' },
    } },
    characterActivities: { data: {
      W: { currentActivityHash: activeHash },
      H: { currentActivityHash: 0 },
      T: { currentActivityHash: 0 },
    } },
    ...(online ? { profileTransitoryData: { data: { partyMembers: [] } } } : {}),
  });
  const state = async (activeHash: number, online = true, def?: any) => {
    vi.mocked(getDef).mockImplementation(() => def);
    vi.mocked(bungieFetch).mockImplementation(async () => session(activeHash, online) as any);
    return parse(await capture().get_session_state({}));
  };

  it('blocks equips when the ACTIVE character is in an activity, despite idle characters at hash 0', async () => {
    // The bug this guards: "any character qualifies" reads the two zeroed characters as
    // offline and green-lights a write the game will refuse.
    const out = await state(1234, true, { displayProperties: { name: "King's Fall" }, directActivityModeType: 4 });
    expect(out.state).toBe('activity');
    expect(out.activeCharacterId).toBe('W');
    expect(out.writeCapabilities).toEqual({ equip: false, socket: false, transfer: true, lock: true, postmaster: true });
    expect(out.reason).toContain("King's Fall");
  });

  it('allows equips in orbit, in a social space, and offline', async () => {
    expect((await state(ORBIT)).writeCapabilities.equip).toBe(true);
    expect((await state(ORBIT)).activity).toEqual({ hash: ORBIT, name: 'Orbit' });

    const social = await state(999, true, { displayProperties: { name: 'The Tower' }, directActivityModeType: 40 });
    expect(social.state).toBe('social');
    expect(social.writeCapabilities.equip).toBe(true);

    const off = await state(0, false);
    expect(off).toMatchObject({ online: false, state: 'offline' });
    expect(off.writeCapabilities.equip).toBe(true);
  });

  it('fails closed when in a session with an activity it cannot resolve', async () => {
    const out = await state(4321, true, undefined);
    expect(out.state).toBe('unknown');
    expect(out.writeCapabilities).toMatchObject({ equip: false, socket: false, transfer: true });
  });

  it('answers in one call', async () => {
    await state(ORBIT);
    expect(vi.mocked(bungieFetch)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(bungieFetch).mock.calls[0][1] as any).query.components).toBe('200,204,1000');
  });
});

describe('get_loadouts', () => {
  const profile = {
    characters: { data: { C1: { classHash: 7 } } },
    characterLoadouts: { data: { C1: { loadouts: [
      { nameHash: 500, items: [{ itemInstanceId: '123' }, { itemInstanceId: '0' }] },
      // Unused slot: Bungie still sends 16 items, all "0", with the FNV-basis nameHash.
      { nameHash: 2166136261, items: [{ itemInstanceId: '0' }, { itemInstanceId: '0' }] },
    ] } } },
  };

  it('marks a zero-filled slot empty and leaves an unset name null', async () => {
    vi.mocked(getDef).mockImplementation((table: string, hash: number) =>
      // real shape: LoadoutNameDefinition has no displayProperties, the name sits at the top level
      table === 'DestinyLoadoutNameDefinition' && hash === 500
        ? { name: 'PvP', hash: 500 } : undefined);
    vi.mocked(bungieFetch).mockImplementation(async () => profile as any);
    const [c] = parse(await capture().get_loadouts({}));
    expect(c.loadouts[0]).toMatchObject({ name: 'PvP', empty: false, itemInstanceIds: ['123'] });
    expect(c.loadouts[1]).toMatchObject({ name: null, empty: true, itemInstanceIds: [] });
  });
});

describe('search_inventory summaries', () => {
  // Two distinct item hashes sharing one name — the case that makes group_by:"name" lie.
  const NAMES: Record<number, string> = { 100: "Luna's Howl", 200: "Luna's Howl", 300: 'Rose' };
  const inventory = {
    profileInventory: { data: { items: [
      { itemHash: 100, itemInstanceId: 'a' }, { itemHash: 100, itemInstanceId: 'b' },
      { itemHash: 200, itemInstanceId: 'c' }, { itemHash: 300, itemInstanceId: 'd' },
    ] } },
  };
  const args = {
    limit: 50, count_only: false, group_limit: 50,
    group_by: undefined, query: undefined, sort: undefined, queries: undefined,
  };
  const run = async (over: Record<string, unknown>) => {
    vi.mocked(getDef).mockImplementation((t: string, hash: number) =>
      t === 'DestinyInventoryItemDefinition' ? { displayProperties: { name: NAMES[hash] } } : undefined);
    vi.mocked(bungieFetch).mockImplementation(async () => inventory as any);
    return parse(await capture().search_inventory({ ...args, ...over }));
  };

  it('returns a bare count for count_only', async () => {
    expect(await run({ count_only: true })).toEqual({ total: 4 });
  });

  it('groups by itemHash without merging same-named items, and by name with them merged', async () => {
    const byHash = await run({ group_by: 'itemHash' });
    expect(byHash.groups).toEqual([
      { key: '100', itemHash: 100, name: "Luna's Howl", count: 2 },
      { key: '200', itemHash: 200, name: "Luna's Howl", count: 1 },
      { key: '300', itemHash: 300, name: 'Rose', count: 1 },
    ]);
    expect(byHash).toMatchObject({ total: 4, groupTotal: 3, truncated: false });
    expect((await run({ group_by: 'name' })).groups[0]).toEqual({ key: "Luna's Howl", count: 3 });
  });

  it('counts every match before group_limit truncates the list', async () => {
    const out = await run({ group_by: 'itemHash', group_limit: 1 });
    expect(out).toMatchObject({ total: 4, groupTotal: 3, truncated: true });
    expect(out.groups).toEqual([{ key: '100', itemHash: 100, name: "Luna's Howl", count: 2 }]);
  });

  it('answers several queries from a single inventory fetch', async () => {
    const out = await run({ queries: [
      { id: 'all', query: '', count_only: true },
      { id: 'roses', query: 'name:rose', count_only: true },
    ] });
    expect(out.results).toEqual([{ id: 'all', total: 4 }, { id: 'roses', total: 1 }]);
    expect(vi.mocked(bungieFetch)).toHaveBeenCalledTimes(1);
  });
});

describe('get_vendors', () => {
  const vendors = {
    vendors: { data: {
      1: { vendorHash: 1, enabled: true },   // Xur — a real NPC, has a title
      2: { vendorHash: 2, enabled: true },   // "Aspects" — a subclass submenu, no title
    } },
  };
  const defs = (_t: string, hash: number) => hash === 1
    ? { displayProperties: { name: 'Xûr', subtitle: 'Agent of the Nine' } }
    : { displayProperties: { name: 'Aspects', subtitle: '' } };

  it('hides subclass submenus by default and returns them on request', async () => {
    vi.mocked(getDef).mockImplementation(defs as any);
    vi.mocked(bungieFetch).mockImplementation(async () => vendors as any);
    const tools = capture();
    expect(parse(await tools.get_vendors({ character_id: 'C1', include_submenus: false })))
      .toEqual([{ vendorHash: 1, name: 'Xûr', subtitle: 'Agent of the Nine', enabled: true }]);
    expect(parse(await tools.get_vendors({ character_id: 'C1', include_submenus: true })).map((v: any) => v.name))
      .toEqual(['Xûr', 'Aspects']);
  });
});

describe('search_inventory keyword discovery', () => {
  it('carries every supported keyword in its description, so no filter has to be guessed', () => {
    const cfgs: Record<string, any> = {};
    registerReadTools({ registerTool: (name: string, cfg: any) => (cfgs[name] = cfg) } as any);
    const d: string = cfgs.search_inventory.description;
    // One per group in keywordList() — if a group stops reaching the model, this fails.
    for (const kw of ['is:godroll', 'is:godrollequipped', 'godroll:<text>', 'exactname:',
      'energycapacity:', 'stat:<name>:<comparison>', 'is:masterwork', 'quoted phrases']) {
      expect(d).toContain(kw);
    }
  });
});
