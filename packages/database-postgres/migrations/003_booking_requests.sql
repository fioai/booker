CREATE TABLE IF NOT EXISTS booking_requests (
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  arrival DATE NOT NULL,
  departure DATE NOT NULL,
  guest_count INTEGER NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  quote_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_requests_pkey PRIMARY KEY (organization_id, request_id),
  CONSTRAINT booking_requests_property_fkey
    FOREIGN KEY (organization_id, property_id)
    REFERENCES properties (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_requests_id_format CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT booking_requests_stay_bounded CHECK (
    departure > arrival AND departure - arrival <= 3660
  ),
  CONSTRAINT booking_requests_guest_count_bounded CHECK (guest_count BETWEEN 1 AND 200),
  CONSTRAINT booking_requests_guest_name_length CHECK (char_length(btrim(guest_name)) BETWEEN 1 AND 120),
  CONSTRAINT booking_requests_guest_email_length CHECK (char_length(btrim(guest_email)) BETWEEN 3 AND 254),
  CONSTRAINT booking_requests_message_length CHECK (
    message IS NULL OR char_length(message) <= 2000
  ),
  CONSTRAINT booking_requests_status CHECK (status IN ('pending', 'approved', 'declined')),
  CONSTRAINT booking_requests_quote_object CHECK (jsonb_typeof(quote_json) = 'object')
);
