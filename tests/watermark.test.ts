import { describe, it, expect } from 'vitest';
import { idKey, maxId, newerThan } from '../src/watermark.js';

const item = (itemInstanceId?: string) => ({ itemInstanceId });

describe('watermark', () => {
  it('orders instance ids numerically despite being strings', () => {
    // The whole feature rests on this: a plain string compare puts '9' above '10'.
    expect(idKey('9') < idKey('10')).toBe(true);
    expect(idKey('6917529000000000010') > idKey('6917529000000000009')).toBe(true);
  });

  it('reports only ids above the mark, ignoring uninstanced stacks', () => {
    const all = [item('100'), item('9'), item(undefined), item('101')];
    const fresh = newerThan(all, idKey('100'));
    expect(fresh.map((i) => i.itemInstanceId)).toEqual(['101']);
  });

  it('advances the mark past the whole snapshot so nothing is reported twice', () => {
    const run1 = [item('10'), item('11')];
    const mark1 = maxId(run1);
    expect(newerThan(run1, mark1)).toEqual([]); // same snapshot again = silence

    const run2 = [...run1, item('12')];
    expect(newerThan(run2, mark1).map((i) => i.itemInstanceId)).toEqual(['12']);
    expect(newerThan(run2, maxId(run2))).toEqual([]);
  });

  it('marks an all-uninstanced inventory at zero, below every real id', () => {
    const mark = maxId([item(undefined)]);
    expect(mark).toBe(idKey(''));
    expect(newerThan([item('1')], mark).length).toBe(1);
  });
});
