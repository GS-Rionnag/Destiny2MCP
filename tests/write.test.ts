import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bungie.js', () => ({
  bungieFetch: vi.fn(async () => ({})),
  getAccount: vi.fn(async () => ({ membershipType: 3, membershipId: 'MID', characterIds: ['C1'] })),
  BungieError: class BungieError extends Error {},
}));
vi.mock('../src/manifest.js', () => ({
  searchDefs: vi.fn((q: string) => (
    q === 'Sunshot' ? [{ hash: 555, name: 'Sunshot' }]
    : q === 'Void Resistance' ? [{ hash: 999999, name: 'Void Resistance' }] // wrong global variant
    : [])),
  eachDef: vi.fn(() => [{ name: 'Raid', hash: 900 }, { name: 'PvP', hash: 901 }]),
  firstHash: vi.fn(() => 111),
  defName: vi.fn(() => 'X'),
  getDef: vi.fn((_t: string, hash: number) =>
    hash === 777 ? { itemType: 16, displayProperties: { name: 'Gunslinger' }, talentGrid: { hudDamageType: 3 } }
    : hash === 424242 ? { displayProperties: { name: 'Void Resistance' } }
    : undefined),
}));

const { registerWriteTools, resolvePlugHash } = await import('../src/tools/write.js');
const { bungieFetch } = await import('../src/bungie.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerWriteTools({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}

// braces matter: mockClear() returns the mock, and vitest calls a function returned from beforeEach as a cleanup hook
beforeEach(() => { vi.mocked(bungieFetch).mockClear(); });

describe('write tools', () => {
  it('transfer_item posts correct body', async () => {
    await capture().transfer_item({
      item_instance_id: 'IID', item_hash: 999, character_id: 'C1', to_vault: true, stack_size: 1,
    });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/TransferItem/', {
      method: 'POST', auth: true,
      body: { itemReferenceHash: 999, stackSize: 1, transferToVault: true, itemId: 'IID', characterId: 'C1', membershipType: 3 },
    });
  });

  it('insert_plug resolves plug names and sockets every plug in one call', async () => {
    const res = await capture().insert_plug({
      item_instance_id: 'IID', character_id: 'C1',
      plugs: [{ socket_index: 4, plug: 'Sunshot' }, { socket_index: 5, plug: '888' }],
    });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/InsertSocketPlugFree/', {
      method: 'POST', auth: true,
      body: {
        plug: { socketIndex: 4, socketArrayType: 0, plugItemHash: 555 },
        itemId: 'IID', characterId: 'C1', membershipType: 3,
      },
    });
    expect(vi.mocked(bungieFetch).mock.calls.filter(([p]) => p.includes('InsertSocketPlugFree'))).toHaveLength(2);
    expect(res.isError).toBeUndefined();
  });

  it('insert_plug reports a failed socket without abandoning the rest', async () => {
    const res = await capture().insert_plug({
      item_instance_id: 'IID', character_id: 'C1',
      plugs: [{ socket_index: 4, plug: 'Nope Nothing' }, { socket_index: 5, plug: 'Sunshot' }],
    });
    expect(res.content[0].text).toMatch(/Socket 4 FAILED/);
    expect(vi.mocked(bungieFetch).mock.calls.filter(([p]) => p.includes('InsertSocketPlugFree'))).toHaveLength(1);
  });

  it('insert_plug resolves a name against the socket\'s own options, not the global name index', async () => {
    vi.mocked(bungieFetch).mockImplementation(async (path: string) =>
      (path.includes('/Item/')
        ? {
            item: { data: { itemHash: 1 } },
            reusablePlugs: { data: { plugs: { '3': [{ plugItemHash: 424242, canInsert: true }] } } },
          }
        : {}) as any);
    await capture().insert_plug({
      item_instance_id: 'IID', character_id: 'C1',
      plugs: [{ socket_index: 3, plug: 'Void Resistance' }],
    });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/InsertSocketPlugFree/', {
      method: 'POST', auth: true,
      body: {
        plug: { socketIndex: 3, socketArrayType: 0, plugItemHash: 424242 },
        itemId: 'IID', characterId: 'C1', membershipType: 3,
      },
    });
  });

  it('insert_plug failure line names the plug hash it sent and the Bungie error status', async () => {
    const { BungieError } = await import('../src/bungie.js');
    vi.mocked(bungieFetch).mockImplementation(async (path: string) => {
      if (path.includes('InsertSocketPlugFree')) {
        const e: any = new (BungieError as any)();
        e.message = 'This action can only be done in-game.';
        e.errorStatus = 'DestinyItemActionForbidden';
        throw e;
      }
      return {} as any;
    });
    const res = await capture().insert_plug({
      item_instance_id: 'IID', character_id: 'C1',
      plugs: [{ socket_index: 4, plug: 'Sunshot' }],
    });
    expect(res.content[0].text).toMatch(/555/);
    expect(res.content[0].text).toMatch(/DestinyItemActionForbidden/);
  });

  it('resolvePlugHash: numeric passthrough, unknown name throws readable', () => {
    expect(resolvePlugHash('12345')).toBe(12345);
    expect(() => resolvePlugHash('Nope Nothing')).toThrowError(/search_manifest/);
  });

  it('change_subclass matches by element, skips equip when already equipped, still sockets plugs', async () => {
    vi.mocked(bungieFetch).mockImplementation(async (path: string) => {
      if (path.includes('/Profile/')) return {
        characterInventories: { data: { C1: { items: [] } } },
        characterEquipment: { data: { C1: { items: [{ itemHash: 777, itemInstanceId: 'SUB1' }] } } },
      } as any;
      return {} as any;
    });
    const res = await capture().change_subclass({
      character_id: 'C1', subclass_name: 'Solar', plugs: [{ socket_index: 2, plug: '555' }],
    });
    const paths = vi.mocked(bungieFetch).mock.calls.map(([p]) => p);
    expect(paths).not.toContain('/Destiny2/Actions/Items/EquipItem/');
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/InsertSocketPlugFree/', {
      method: 'POST', auth: true,
      body: {
        plug: { socketIndex: 2, socketArrayType: 0, plugItemHash: 555 },
        itemId: 'SUB1', characterId: 'C1', membershipType: 3,
      },
    });
    expect(res.content[0].text).toContain('Already equipped');
  });

  it('rename_loadout keeps the identifiers it was not given', async () => {
    vi.mocked(bungieFetch).mockImplementation(async (path: string) =>
      (path.includes('/Profile/')
        ? { characterLoadouts: { data: { C1: { loadouts: [{ nameHash: 1, colorHash: 2, iconHash: 3 }] } } } }
        : {}) as any);
    await capture().rename_loadout({ loadout_index: 0, character_id: 'C1', name: 'raid' });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Loadouts/UpdateLoadoutIdentifiers/', {
      method: 'POST', auth: true,
      body: { loadoutIndex: 0, characterId: 'C1', nameHash: 900, colorHash: 2, iconHash: 3, membershipType: 3 },
    });
  });

  it('rename_loadout rejects a name that is not on the in-game list, and lists the real ones', async () => {
    const res = await capture().rename_loadout({ loadout_index: 0, character_id: 'C1', name: 'Boss DPS' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Raid, PvP/);
    expect(vi.mocked(bungieFetch).mock.calls.filter(([p]) => p.includes('UpdateLoadoutIdentifiers'))).toHaveLength(0);
  });

  it('rename_loadout refuses an index the character does not have', async () => {
    vi.mocked(bungieFetch).mockImplementation(async () =>
      ({ characterLoadouts: { data: { C1: { loadouts: [{ nameHash: 1 }] } } } }) as any);
    const res = await capture().rename_loadout({ loadout_index: 9, character_id: 'C1', name: 'Raid' });
    expect(res.isError).toBe(true);
    expect(vi.mocked(bungieFetch).mock.calls.filter(([p]) => p.includes('UpdateLoadoutIdentifiers'))).toHaveLength(0);
  });

  it('clear_loadout posts the slot', async () => {
    await capture().clear_loadout({ loadout_index: 3, character_id: 'C1' });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Loadouts/ClearLoadout/', {
      method: 'POST', auth: true,
      body: { loadoutIndex: 3, characterId: 'C1', membershipType: 3 },
    });
  });

  it('snapshot_loadout resolves a name string to its hash', async () => {
    await capture().snapshot_loadout({ loadout_index: 1, character_id: 'C1', name: 'PvP' });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Loadouts/SnapshotLoadout/', {
      method: 'POST', auth: true,
      body: { loadoutIndex: 1, characterId: 'C1', nameHash: 901, colorHash: 111, iconHash: 111, membershipType: 3 },
    });
  });

  it('set_lock_state posts state', async () => {
    await capture().set_lock_state({ item_instance_id: 'IID', character_id: 'C1', locked: true });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/SetLockState/', {
      method: 'POST', auth: true,
      body: { state: true, itemId: 'IID', characterId: 'C1', membershipType: 3 },
    });
  });
});
