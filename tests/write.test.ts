import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/bungie.js', () => ({
  bungieFetch: vi.fn(async () => ({})),
  getAccount: vi.fn(async () => ({ membershipType: 3, membershipId: 'MID', characterIds: ['C1'] })),
  BungieError: class BungieError extends Error {},
}));
vi.mock('../src/manifest.js', () => ({
  searchDefs: vi.fn((q: string) => (q === 'Sunshot' ? [{ hash: 555, name: 'Sunshot' }] : [])),
  firstHash: vi.fn(() => 111),
  defName: vi.fn(() => 'X'),
  getDef: vi.fn((_t: string, hash: number) => hash === 777
    ? { itemType: 16, displayProperties: { name: 'Gunslinger' }, talentGrid: { hudDamageType: 3 } }
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

  it('set_lock_state posts state', async () => {
    await capture().set_lock_state({ item_instance_id: 'IID', character_id: 'C1', locked: true });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/SetLockState/', {
      method: 'POST', auth: true,
      body: { state: true, itemId: 'IID', characterId: 'C1', membershipType: 3 },
    });
  });
});
