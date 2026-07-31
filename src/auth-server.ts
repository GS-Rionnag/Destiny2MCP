import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { exchangeCode } from './auth.js';

export function startAuthServer(): void {
  const certDir = path.join(config.dataDir, 'certs');
  let key: Buffer, cert: Buffer;
  try {
    key = fs.readFileSync(path.join(certDir, 'key.pem'));
    cert = fs.readFileSync(path.join(certDir, 'cert.pem'));
  } catch {
    console.warn('No TLS certs found — run `npm run setup` first. OAuth server not started.');
    return;
  }

  const app = express();

  app.get('/auth', (_req, res) => {
    const u = new URL('https://www.bungie.net/en/oauth/authorize');
    u.searchParams.set('client_id', config.clientId);
    u.searchParams.set('response_type', 'code');
    res.redirect(u.toString());
  });

  app.get('/callback', async (req, res) => {
    try {
      await exchangeCode(String(req.query.code ?? ''));
      res.send('Bungie account linked. You can close this tab.');
      console.log('Bungie auth complete — tokens saved.');
    } catch (e: any) {
      res.status(500).send(`Auth failed: ${e?.message ?? e}`);
    }
  });

  https.createServer({ key, cert }, app).listen(config.authPort, () => {
    console.log(`OAuth: open https://localhost:${config.authPort}/auth to link your Bungie account`);
  });
}
