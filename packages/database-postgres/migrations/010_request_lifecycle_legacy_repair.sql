ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS fingerprint_version TEXT;

UPDATE booking_requests
SET fingerprint_version = 'legacy-md5-request-id'
WHERE fingerprint_version IS NULL;

ALTER TABLE booking_requests
  ALTER COLUMN fingerprint_version SET NOT NULL;

ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_fingerprint_version
    CHECK (fingerprint_version IN ('legacy-md5-request-id', 'sha256-v1'));

UPDATE booking_requests AS request
SET hold_record_id = NULL,
    hold_expires_at = NULL
WHERE request.status = 'pending'
  AND request.hold_record_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM availability_blocks AS hold
    WHERE hold.organization_id = request.organization_id
      AND hold.property_id = request.property_id
      AND hold.record_id = request.hold_record_id
      AND hold.block_kind = 'hold'
      AND hold.status = 'active'
  );
