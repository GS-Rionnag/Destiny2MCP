import 'dotenv/config';

export const config = {
  apiKey: process.env.BUNGIE_API_KEY ?? '',
  clientId: process.env.BUNGIE_CLIENT_ID ?? '',
  clientSecret: process.env.BUNGIE_CLIENT_SECRET ?? '',
  port: Number(process.env.PORT ?? 7777),
  authPort: Number(process.env.AUTH_PORT ?? 7778),
  dataDir: process.env.DATA_DIR ?? './data',
  // Off by default: one line per call fills data/mcp.log and the journal for a log nobody reads
  // until something breaks. Set MCP_LOG=1 in .env to get it back for a debugging session.
  logCalls: process.env.MCP_LOG === '1',
};
