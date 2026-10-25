-- 设备码配对与每设备续期凭证。
-- 长期 device_token 由模组本地生成；服务端只保存 SHA-256(base64url) 哈希。

CREATE TABLE IF NOT EXISTS mod_devices (
  id                 TEXT PRIMARY KEY,
  sub                TEXT NOT NULL UNIQUE REFERENCES users(sub),
  credential_hash    TEXT NOT NULL UNIQUE,
  install_id         TEXT NOT NULL,
  device_name        TEXT NOT NULL DEFAULT '',
  credential_version INTEGER NOT NULL DEFAULT 1,
  bound_at           TEXT NOT NULL,
  last_seen_at       TEXT,
  revoked_at         TEXT,
  revoke_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_mod_devices_credential
  ON mod_devices(credential_hash);

CREATE TABLE IF NOT EXISTS mod_pairings (
  id                 TEXT PRIMARY KEY,
  device_code_hash   TEXT NOT NULL UNIQUE,
  user_code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  credential_hash    TEXT NOT NULL,
  install_id         TEXT NOT NULL,
  device_name        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  confirmed_sub      TEXT REFERENCES users(sub),
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  approved_at        TEXT,
  consumed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_mod_pairings_status_expiry
  ON mod_pairings(status, expires_at);

-- 短码确认需要硬限制。KV 仍可承担削峰，但不能承担这个安全边界。
CREATE TABLE IF NOT EXISTS mod_pair_rate_limits (
  key        TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO site_config (key, value) VALUES
 ('pairing_ttl_seconds',        '600'),
 ('pairing_poll_seconds',       '5'),
 ('role_recheck_hours',         '6'),
 ('role_max_stale_hours',       '24');
