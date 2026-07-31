import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { config } from '../src/config.js';

const dir = path.join(config.dataDir, 'certs');
// selfsigned v5: async-only, `days` replaced by notAfterDate
const notAfterDate = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { notAfterDate, keySize: 2048 });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
console.log(`Self-signed cert written to ${dir}`);
console.log(`Register your Bungie app redirect URL as: https://localhost:${config.authPort}/callback`);
console.log(`Then: npm start, and open https://localhost:${config.authPort}/auth`);
