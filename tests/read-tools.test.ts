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
}));

const { registerReadTools } = await import('../src/tools/read.js');
const { bungieFetch } = await import('../src/bungie.js');

function capture() {
  const tools: Record<string, Function> = {};
  registerReadTools({ registerTool: (name: string, _cfg: any, h: Function) => (tools[name] = h) } as any);
  return tools;
}

const detail = (hash: number) => ({ item: { data: { itemHash: hash } }, sockets: { data: { sockets: [] } } });
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => { vi.mocked(bungieFetch).mockClear(); });

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

  it('only asks Bungie for the reusable-plugs component when plug options are wanted', async () => {
    vi.mocked(bungieFetch).mockImplementation(async () => detail(1) as any);
    const tools = capture();
    await tools.get_item_details({ item_instance_ids: ['A'], include_plug_options: false });
    expect((vi.mocked(bungieFetch).mock.calls[0][1] as any).query.components).not.toContain('310');
    await tools.get_item_details({ item_instance_ids: ['A'], include_plug_options: true });
    expect((vi.mocked(bungieFetch).mock.calls[1][1] as any).query.components).toContain('310');
  });
});
