ALTER TABLE booking_requests DROP CONSTRAINT IF EXISTS booking_requests_status;

ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS hold_record_id TEXT,
  ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE booking_requests
SET status = 'rejected'
WHERE status = 'declined';

UPDATE booking_requests
SET idempotency_key = request_id,
    request_fingerprint = md5(request_id),
    hold_record_id = request_id,
    hold_expires_at = created_at + INTERVAL '15 minutes'
WHERE idempotency_key IS NULL
   OR request_fingerprint IS NULL
   OR hold_record_id IS NULL
   OR hold_expires_at IS NULL;

ALTER TABLE booking_requests
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ALTER COLUMN hold_record_id SET NOT NULL,
  ALTER COLUMN hold_expires_at SET NOT NULL;

ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  ADD CONSTRAINT booking_requests_idempotency_key_length
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 128),
  ADD CONSTRAINT booking_requests_fingerprint_shape
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$' OR request_fingerprint = md5(request_id)),
  ADD CONSTRAINT booking_requests_hold_record_id_format
    CHECK (hold_record_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  ADD CONSTRAINT booking_requests_hold_expiry_order
    CHECK (hold_expires_at > created_at);

DROP INDEX IF EXISTS booking_requests_idempotency_key_uq;

CREATE UNIQUE INDEX booking_requests_idempotency_key_uq
  ON booking_requests (organization_id, idempotency_key);

CREATE TABLE IF NOT EXISTS booking_outbox (
  outbox_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT 'none',
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_outbox_request_fkey
    FOREIGN KEY (organization_id, request_id)
    REFERENCES booking_requests (organization_id, request_id) ON DELETE CASCADE,
  CONSTRAINT booking_outbox_event_uq
    UNIQUE (organization_id, request_id, event_type),
  CONSTRAINT booking_outbox_event_type
    CHECK (event_type IN (
      'booking_request.submitted',
      'booking_request.approved',
      'booking_request.rejected',
      'booking_request.expired'
    )),
  CONSTRAINT booking_outbox_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT booking_outbox_status
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  CONSTRAINT booking_outbox_attempts_bounded
    CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT booking_outbox_error_code
    CHECK (last_error_code IN ('none', 'temporary', 'permanent', 'max_attempts')),
  CONSTRAINT booking_outbox_error_length
    CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);

CREATE INDEX IF NOT EXISTS booking_outbox_delivery_idx
  ON booking_outbox (status, available_at, created_at)
  WHERE status IN ('pending', 'processing');
