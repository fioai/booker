import { describe, expect, it } from 'vitest';

import { createFixedClock } from '../src/fixed-clock.js';

describe('createFixedClock', () => {
  it('returns an independent Date snapshot on each read', () => {
    const clock = createFixedClock('2026-07-12T19:00:00.000Z');
    const firstRead = clock.now();

    firstRead.setUTCDate(1);

    expect(clock.now().toISOString()).toBe('2026-07-12T19:00:00.000Z');
  });

  it('rejects invalid instants', () => {
    expect(() => createFixedClock('not-a-date')).toThrow(RangeError);
  });
});
