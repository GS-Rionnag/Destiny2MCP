import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// A watermark is the highest item instance id seen on a previous check. Bungie allocates
// instance ids monotonically, so "id greater than the mark" means "acquired since then" —
// no acquisition timestamp exists in the profile, and this is what DIM's item feed uses.
//
// It lives on disk because the clients that need it have no memory: a ChatGPT scheduled
// task starts every run with a fresh context and cannot remember what it already reported.

export interface Mark { id: string; at: string }

const file = () => path.join(config.dataDir, 'watermarks.json');

/** Ids are uint64 strings; pad so a lexical compare orders them numerically. */
export const idKey = (id?: string) => (id ?? '').padStart(20, '0');

export function readMarks(): Record<string, Mark> {
  try {
    const m = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {}; // missing or corrupt file re-baselines, which is quieter than throwing at 3am
  }
}

export function saveMark(cursor: string, id: string, at: string): void {
  const marks = readMarks();
  marks[cursor] = { id, at };
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Temp + rename: a scheduled run killed mid-write must not leave a truncated file that
  // wipes every cursor and re-reports the whole inventory on the next run.
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marks, null, 2));
  fs.renameSync(tmp, file());
}

/** Highest instance id in a snapshot, padded. '' when nothing is instanced. */
export function maxId(items: { itemInstanceId?: string }[]): string {
  return items.reduce((m, i) => (idKey(i.itemInstanceId) > m ? idKey(i.itemInstanceId) : m), '');
}

/** Items whose instance id is above `mark`. Uninstanced stacks have no id and never qualify. */
export function newerThan<T extends { itemInstanceId?: string }>(items: T[], mark: string): T[] {
  return items.filter((i) => !!i.itemInstanceId && idKey(i.itemInstanceId) > mark);
}
