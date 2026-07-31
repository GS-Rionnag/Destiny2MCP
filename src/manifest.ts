import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { config } from './config.js';
import { bungieFetch } from './bungie.js';

let db: Database.Database | null = null;

export function openManifestFile(file: string): void {
  db = new Database(file, { readonly: true });
}

export async function openManifest(): Promise<void> {
  const info = await bungieFetch<any>('/Destiny2/Manifest/');
  const remotePath: string = info.mobileWorldContentPaths.en;
  const file = path.join(config.dataDir, 'manifest', path.basename(remotePath));
  if (!fs.existsSync(file)) {
    console.log('Downloading Destiny 2 manifest (one-time, ~200MB)...');
    const res = await fetch('https://www.bungie.net' + remotePath);
    if (!res.ok) throw new Error(`Manifest download failed: HTTP ${res.status}`);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zip.getEntries()[0].getData());
    console.log('Manifest ready.');
  }
  openManifestFile(file);
}

export const hashToId = (hash: number): number => (hash > 0x7fffffff ? hash - 0x1_0000_0000 : hash);

function need(): Database.Database {
  if (!db) throw new Error('Manifest not loaded — server still starting up.');
  return db;
}

export function getDef(table: string, hash: number): any | undefined {
  if (!/^Destiny\w+Definition$/.test(table)) throw new Error(`Invalid manifest table: ${table}`);
  const row = need().prepare(`SELECT json FROM ${table} WHERE id = ?`).get(hashToId(hash)) as any;
  return row ? JSON.parse(row.json) : undefined;
}

export const defName = (table: string, hash: number): string =>
  getDef(table, hash)?.displayProperties?.name || `#${hash}`;

export function searchDefs(query: string, table = 'DestinyInventoryItemDefinition', limit = 25) {
  if (!/^Destiny\w+Definition$/.test(table)) throw new Error(`Invalid manifest table: ${table}`);
  // ponytail: LIKE prefilter + JS scan over ~30k rows, ~100ms; index it if ever too slow
  const rows = need().prepare(`SELECT json FROM ${table} WHERE json LIKE ?`).all(`%${query}%`) as any[];
  const q = query.toLowerCase();
  const out: { hash: number; name: string; type?: string; tier?: string }[] = [];
  for (const r of rows) {
    const d = JSON.parse(r.json);
    const name: string | undefined = d.displayProperties?.name;
    if (name && name.toLowerCase().includes(q)) {
      out.push({ hash: d.hash, name, type: d.itemTypeDisplayName, tier: d.inventory?.tierTypeName });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function firstHash(table: string): number {
  if (!/^Destiny\w+Definition$/.test(table)) throw new Error(`Invalid manifest table: ${table}`);
  const row = need().prepare(`SELECT json FROM ${table} LIMIT 1`).get() as any;
  return JSON.parse(row.json).hash;
}
