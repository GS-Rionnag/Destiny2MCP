// Read-only live smoke test. Requires .env + completed OAuth (tokens.json).
import { openManifest, searchDefs } from '../src/manifest.js';
import { getAccount, bungieFetch } from '../src/bungie.js';
import { readTokens } from '../src/auth.js';

if (!readTokens()) {
  console.error('No tokens.json — run `npm start` and complete https://localhost:7778/auth first.');
  process.exit(1);
}

await openManifest();

const gjally = searchDefs('Gjallarhorn')[0];
console.log('manifest lookup:', gjally);
if (gjally?.name !== 'Gjallarhorn') throw new Error('Manifest search failed');

const a = await getAccount();
console.log('account:', a.membershipType, a.membershipId, `${a.characterIds.length} characters`);

const prof = await bungieFetch<any>(`/Destiny2/${a.membershipType}/Profile/${a.membershipId}/`, {
  auth: true, query: { components: '200' },
});
for (const c of Object.values<any>(prof.characters.data)) {
  console.log(`character ${c.characterId}: power ${c.light}`);
}
console.log('SMOKE OK');
