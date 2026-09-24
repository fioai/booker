import { describe, expect, it, vi } from 'vitest';
import {
  createBookingEngineClientV1,
  validatePublicAvailabilityMonthRequestV1,
} from '../src/index.js';

function snapshot(month = '2028-02', length = 29) {
  return {
    propertyId: 'retreat',
    month,
    checkedAt: '2026-09-13T12:00:00.000Z',
    days: Array.from({ length }, (_, index) => ({
      date: `${month}-${String(index + 1).padStart(2, '0')}`,
      available: index !== 9,
    })),
  };
}
function client(body: unknown) {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  return {
    fetcher,
    api: createBookingEngineClientV1({ baseUrl: 'https://engine.example.test', fetch: fetcher }),
  };
}

describe('monthly public availability', () => {
  it('returns a complete leap month through one GET without private details', async () => {
    const { api, fetcher } = client(snapshot());
    expect(await api.getAvailabilityMonth('retreat', { month: '2028-02' })).toEqual(snapshot());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'https://engine.example.test/v1/properties/retreat/availability/month?month=2028-02',
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
  });
  it.each(['0000-01', '9999-12', '2028-2', '2028-00', '2028-13', '2028-02-01', '2028-02 extra'])(
    'rejects invalid month %s before fetching',
    async (month) => {
      const { api, fetcher } = client(snapshot());
      await expect(api.getAvailabilityMonth('retreat', { month })).rejects.toMatchObject({
        name: 'PublicContractValidationErrorV1',
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('accepts bounded years and rejects absent or extra request fields', () => {
    for (const month of ['0001-01', '9998-12', '2027-02'])
      expect(validatePublicAvailabilityMonthRequestV1({ month }).ok).toBe(true);
    for (const input of [undefined, null, {}, { month: 2028 }, { month: '2028-02', private: true }])
      expect(validatePublicAvailabilityMonthRequestV1(input).ok).toBe(false);
  });
  it('rejects mismatched properties/months, missing, unordered, duplicate, invalid nights and malformed timestamps', async () => {
    const good = snapshot();
    const bodies = [
      { ...good, propertyId: 'another-property' },
      snapshot('2028-03', 31),
      { ...good, days: good.days.slice(1) },
      { ...good, days: [...good.days].reverse() },
      { ...good, days: good.days.map((day, index) => (index === 1 ? good.days[0] : day)) },
      {
        ...good,
        days: good.days.map((day, index) => (index === 0 ? { ...day, available: 'yes' } : day)),
      },
      {
        ...good,
        days: good.days.map((day, index) =>
          index === 0 ? { ...day, guestEmail: 'private@example.test' } : day,
        ),
      },
      { ...good, checkedAt: '2026-02-30T12:00:00Z' },
      { ...good, checkedAt: 'yesterday' },
      { ...good, organizationId: 'private-tenant' },
    ];
    for (const body of bodies)
      await expect(
        client(body).api.getAvailabilityMonth('retreat', { month: '2028-02' }),
      ).rejects.toMatchObject({ name: 'BookingEngineApiErrorV1' });
  });
});
