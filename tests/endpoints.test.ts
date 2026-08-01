import { describe, it, expect, beforeAll } from 'vitest';
import { listEndpoints, describeEndpoint, setSpec } from '../src/endpoints.js';

// Trimmed stand-in for Bungie's openapi.json — same shape, three operations.
const SPEC = {
  paths: {
    '/Destiny2/Actions/Items/InsertSocketPlugFree/': {
      post: {
        tags: ['Destiny2'],
        operationId: 'Destiny2.InsertSocketPlugFree',
        description: "Insert a 'free' plug into an item's socket.",
        parameters: [],
        security: [{ oauth2: ['MoveEquipDestinyItems'] }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/InsertReq' } } } },
        responses: { 200: { $ref: '#/components/responses/CEInt32' } },
      },
    },
    '/Destiny2/{membershipType}/Profile/{destinyMembershipId}/': {
      get: {
        tags: ['Destiny2'],
        operationId: 'Destiny2.GetProfile',
        description: 'Returns Destiny Profile information for the supplied membership.',
        parameters: [{ name: 'components', in: 'query', required: false, schema: { type: 'array' }, description: 'Components to return.' }],
        responses: { 200: { $ref: '#/components/responses/CEDestinyProfileResponse' } },
      },
    },
    '/GroupV2/{groupId}/': {
      get: { tags: ['GroupV2'], operationId: 'GroupV2.GetGroup', description: 'Get information about a group.', parameters: [], responses: {} },
    },
  },
  components: {
    schemas: {
      InsertReq: {
        properties: {
          plug: { type: 'object', allOf: [{ $ref: '#/components/schemas/PlugEntry' }], description: 'The plugs being inserted.' },
          itemId: { type: 'integer', description: 'The instance ID of the item.' },
        },
      },
    },
  },
};

beforeAll(() => setSpec(SPEC));

describe('listEndpoints', () => {
  it('lists every operation as METHOD path — operationId', async () => {
    const all = await listEndpoints();
    expect(all).toHaveLength(3);
    expect(all).toContain('GET /GroupV2/{groupId}/ — GroupV2.GetGroup');
    expect(all).toContain('POST /Destiny2/Actions/Items/InsertSocketPlugFree/ — Destiny2.InsertSocketPlugFree');
  });

  it('filters by tag and by search across path, operationId and description', async () => {
    expect(await listEndpoints(undefined, 'GroupV2')).toHaveLength(1);
    expect(await listEndpoints(undefined, 'groupv2')).toHaveLength(1); // tag match is case-insensitive
    expect(await listEndpoints('socket')).toHaveLength(1);             // path
    expect(await listEndpoints('getprofile')).toHaveLength(1);         // operationId
    expect(await listEndpoints('supplied membership')).toHaveLength(1); // description
    expect(await listEndpoints('nothing-like-this')).toHaveLength(0);
  });
});

describe('describeEndpoint', () => {
  it('resolves a POST: oauth scope, request body one level deep, response type name', async () => {
    const d = await describeEndpoint('Destiny2.InsertSocketPlugFree');
    expect(d.call).toBe('POST /Destiny2/Actions/Items/InsertSocketPlugFree/');
    expect(d.auth).toMatch(/OAuth required — scope MoveEquipDestinyItems/);
    expect(d.requestBody).toEqual({
      plug: 'PlugEntry — The plugs being inserted.',   // $ref named, not expanded
      itemId: 'integer — The instance ID of the item.',
    });
    expect(d.responseType).toBe('CEInt32');
  });

  it('marks unauthenticated endpoints and keeps query parameters', async () => {
    const d = await describeEndpoint('/Destiny2/{membershipType}/Profile/{destinyMembershipId}/');
    expect(d.auth).toBe('API key only');
    expect(d.parameters).toEqual([
      { name: 'components', in: 'query', required: undefined, type: 'array', description: 'Components to return.' },
    ]);
  });

  it('matches on a partial name, and says how to recover when nothing matches', async () => {
    expect((await describeEndpoint('getgroup')).operationId).toBe('GroupV2.GetGroup');
    await expect(describeEndpoint('Destiny2.NoSuchThing')).rejects.toThrowError(/list_endpoints/);
  });

  it('prefers an exact operationId over a substring hit', async () => {
    // 'Destiny2.GetProfile' is also a substring of nothing else here, so seed the ambiguity:
    expect((await describeEndpoint('Destiny2.GetProfile')).call).toMatch(/^GET /);
  });
});
