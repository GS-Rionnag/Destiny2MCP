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
  getDef: vi.fn(() => undefined),
}));

const { registerWriteTools, resolvePlugHash } = await import('../src/tools/write.js');
const { bungieFetch } = await import('../src/bungie.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerWriteTools({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}

beforeEach(() => vi.mocked(bungieFetch).mockClear());

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

  it('insert_plug resolves plug name to hash', async () => {
    await capture().insert_plug({ item_instance_id: 'IID', character_id: 'C1', socket_index: 4, plug: 'Sunshot' });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/InsertSocketPlugFree/', {
      method: 'POST', auth: true,
      body: {
        plug: { socketIndex: 4, socketArrayType: 0, plugItemHash: 555 },
        itemId: 'IID', characterId: 'C1', membershipType: 3,
      },
    });
  });

  it('resolvePlugHash: numeric passthrough, unknown name throws readable', () => {
    expect(resolvePlugHash('12345')).toBe(12345);
    expect(() => resolvePlugHash('Nope Nothing')).toThrowError(/search_manifest/);
  });

  it('set_lock_state posts state', async () => {
    await capture().set_lock_state({ item_instance_id: 'IID', character_id: 'C1', locked: true });
    expect(bungieFetch).toHaveBeenCalledWith('/Destiny2/Actions/Items/SetLockState/', {
      method: 'POST', auth: true,
      body: { state: true, itemId: 'IID', characterId: 'C1', membershipType: 3 },
    });
  });
});
