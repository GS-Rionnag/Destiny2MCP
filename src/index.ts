import express from 'express';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { config } from './config.js';
import { openManifest } from './manifest.js';
import { startAuthServer } from './auth-server.js';
import { readTokens } from './auth.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerRawTool } from './tools/raw.js';

// ponytail: byte-count + JSONL append, no rotation. Add rotation if log outgrows the disk.
function logCalls(body: unknown, bytes: number, ms: number) {
  const calls = Array.isArray(body) ? body : [body];
  for (const c of calls as any[]) {
    const tool = c?.params?.name ? ` ${c.params.name}` : '';
    const args = c?.params?.arguments ? ` ${JSON.stringify(c.params.arguments).slice(0, 160)}` : '';
    const line = `${new Date().toISOString()} ${c?.method ?? '?'}${tool}${args} -> ${bytes}B ~${Math.round(bytes / 4)}tok ${ms}ms`;
    console.error(line);
    try { appendFileSync(join(config.dataDir, 'mcp.log'), line + '\n'); } catch { /* logging never breaks a request */ }
  }
}

function buildServer(): McpServer {
  // Bump on any tool-schema change — some clients cache the tool list and key it on version.
  const server = new McpServer({ name: 'destiny2', version: '1.2.0' });
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
    const t0 = Date.now();
    let bytes = 0;
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = ((chunk: any, ...a: any[]) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...a); }) as any;
    res.end = ((chunk: any, ...a: any[]) => { if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk); return end(chunk, ...a); }) as any;
    res.on('close', () => logCalls(req.body, bytes, Date.now() - t0));

    // ponytail: stateless — fresh server+transport per request, no session bookkeeping
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'POST only (stateless mode)' }); });

  app.listen(config.port, '127.0.0.1', () => {
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
