import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { config } from './config.js';
import { openManifest } from './manifest.js';
import { startAuthServer } from './auth-server.js';
import { readTokens } from './auth.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerRawTool } from './tools/raw.js';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'destiny2', version: '1.0.0' });
  registerReadTools(server);
  registerWriteTools(server);
  registerRawTool(server);
  return server;
}

async function main() {
  for (const k of ['apiKey', 'clientId', 'clientSecret'] as const) {
    if (!config[k]) {
      console.error(`Missing Bungie credential in .env (see .env.example). Missing: ${k}`);
      process.exit(1);
    }
  }

  await openManifest();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/mcp', async (req, res) => {
    // ponytail: stateless — fresh server+transport per request, no session bookkeeping
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'POST only (stateless mode)' }); });

  app.listen(config.port, () => {
    console.log(`MCP endpoint: http://localhost:${config.port}/mcp`);
    const t = readTokens();
    if (!t) console.log(`Not authenticated yet — open https://localhost:${config.authPort}/auth`);
    else if (Date.now() > t.refreshExpiresAt - 7 * 24 * 3600 * 1000) {
      console.warn(`WARNING: Bungie refresh token expires soon — re-auth at https://localhost:${config.authPort}/auth`);
    }
  });

  startAuthServer();
}

main().catch((e) => { console.error(e); process.exit(1); });
