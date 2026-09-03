export declare const SAMPLE_DATA: {
  readonly organization: {
    readonly id: 'sample-tenant';
    readonly name: 'Booking Engine local sample tenant';
  };
  readonly property: {
    readonly id: 'sample-bungalow';
    readonly name: 'Sample Garden Bungalow';
    readonly summary: 'A one-bedroom bungalow with a private garden for short stays.';
    readonly country: 'CA';
    readonly timezone: 'America/Toronto';
    readonly currency: 'CAD';
    readonly propertyType: 'bungalow';
    readonly bedroomCount: 1;
    readonly bedConfiguration: readonly [{ readonly type: 'double'; readonly quantity: 1 }];
    readonly bathroomCount: 1;
    readonly maximumGuests: 2;
    readonly amenities: readonly [
      'private garden',
      'fibre Wi-Fi',
      'air conditioning',
      'Smart TV',
      'free street parking',
    ];
    readonly hostNotes: 'A quiet sample property for local verification.';
    readonly operationalNotes: 'PRIVATE SAMPLE MARKER: confirm the guest key is returned on checkout.';
  };
  readonly rate: {
    readonly currency: 'CAD';
    readonly baseNightlyRateMinor: 12500;
    readonly cleaningFeeMinor: 0;
    readonly minimumStayNights: 2;
  };
  readonly owner: {
    readonly id: 'sample-owner';
    readonly email: 'sample-owner@example.test';
    readonly role: 'owner';
  };
};
