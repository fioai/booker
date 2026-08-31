ALTER TABLE booking_requests
  ALTER COLUMN hold_record_id DROP NOT NULL,
  ALTER COLUMN hold_expires_at DROP NOT NULL;

DROP TABLE IF EXISTS public_hold_controls;
