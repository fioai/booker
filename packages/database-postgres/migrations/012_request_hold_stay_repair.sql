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
      AND lower(hold.stay) = request.arrival
      AND upper(hold.stay) = request.departure
  );
