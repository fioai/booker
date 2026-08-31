CREATE TABLE IF NOT EXISTS owner_identities (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT owner_identities_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT owner_identities_email_length
    CHECK (char_length(btrim(email)) BETWEEN 3 AND 254),
  CONSTRAINT owner_identities_email_shape
    CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT owner_identities_password_hash_length
    CHECK (char_length(password_hash) BETWEEN 32 AND 512),
  CONSTRAINT owner_identities_password_hash_shape
    CHECK (
      password_hash ~ '^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_identities_email_uq
  ON owner_identities (lower(email));

CREATE TABLE IF NOT EXISTS organization_memberships (
  identity_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_memberships_pkey PRIMARY KEY (identity_id, organization_id),
  CONSTRAINT organization_memberships_identity_fkey
    FOREIGN KEY (identity_id) REFERENCES owner_identities (id) ON DELETE CASCADE,
  CONSTRAINT organization_memberships_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT organization_memberships_role
    CHECK (role IN ('owner', 'admin', 'manager', 'viewer')),
  CONSTRAINT organization_memberships_status
    CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS organization_memberships_active_lookup_idx
  ON organization_memberships (organization_id, identity_id)
  WHERE status = 'active';
