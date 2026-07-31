import { BungieError } from '../bungie.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

export const tool =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e: any) {
      const msg = e instanceof BungieError ? `${e.errorStatus}: ${e.message}` : String(e?.message ?? e);
      return { content: [{ type: 'text', text: `Error — ${msg}` }], isError: true };
    }
  };
