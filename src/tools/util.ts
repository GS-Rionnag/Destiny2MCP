import { BungieError } from '../bungie.js';
import { getDef } from '../manifest.js';

/** What socket i of an item actually accepts. The API only fills reusablePlugs for weapon-style
 * sockets; armor mods and subclass fragments have to come from the manifest plug set the socket
 * points at. */
export function socketPlugPool(reusable: Record<string, any[]>, socketEntries: any[], i: number): number[] {
  const live = (reusable[String(i)] ?? []).filter((p) => p.canInsert).map((p) => p.plugItemHash);
  if (live.length) return live;
  const e = socketEntries[i] ?? {};
  const setHash = e.reusablePlugSetHash ?? e.randomizedPlugSetHash;
  const fromSet = setHash
    ? (getDef('DestinyPlugSetDefinition', setHash)?.reusablePlugItems ?? [])
    : (e.reusablePlugItems ?? []);
  return fromSet.filter((p: any) => p.currentlyCanRoll !== false).map((p: any) => p.plugItemHash);
}

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
      // numeric code included so a caller can tell a Bungie refusal from a transport failure
      const msg = e instanceof BungieError ? `${e.errorStatus} (${e.errorCode}): ${e.message}` : String(e?.message ?? e);
      return { content: [{ type: 'text', text: `Error — ${msg}` }], isError: true };
    }
  };
