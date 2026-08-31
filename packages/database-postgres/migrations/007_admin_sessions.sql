CREATE TABLE IF NOT EXISTS admin_sessions (
  session_digest TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  csrf_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT admin_sessions_owner_fkey
    FOREIGN KEY (owner_id) REFERENCES owner_identities (id) ON DELETE CASCADE,
  CONSTRAINT admin_sessions_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT admin_sessions_membership_fkey
    FOREIGN KEY (owner_id, organization_id)
    REFERENCES organization_memberships (identity_id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT admin_sessions_digest_shape
    CHECK (session_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT admin_sessions_csrf_digest_shape
    CHECK (csrf_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT admin_sessions_email_length
    CHECK (char_length(btrim(email)) BETWEEN 3 AND 254),
  CONSTRAINT admin_sessions_role
    CHECK (role IN ('owner', 'admin', 'manager', 'viewer')),
  CONSTRAINT admin_sessions_expiry_order
    CHECK (expires_at > created_at AND last_seen_at >= created_at)
);

CREATE INDEX IF NOT EXISTS admin_sessions_active_owner_idx
  ON admin_sessions (organization_id, owner_id, last_seen_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx
  ON admin_sessions (expires_at)
  WHERE revoked_at IS NULL;
