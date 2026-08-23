export interface Clock {
  now(): Date;
}

export function createFixedClock(instant: string | Date): Clock {
  const snapshot = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);

  if (Number.isNaN(snapshot.getTime())) {
    throw new RangeError('Fixed clock instant must be a valid date.');
  }

  return {
    now: () => new Date(snapshot.getTime()),
  };
}
