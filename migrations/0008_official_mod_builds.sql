-- 官方赞助版构建注册表，以及设备授权链路中的构建身份快照。
-- 客户端提交自身最终 JAR 的 SHA-256；只有启用的官方构建才能绑定或续期。

CREATE TABLE IF NOT EXISTS official_mod_builds (
  id                TEXT PRIMARY KEY,
  mod_id            TEXT NOT NULL,
  minecraft_version TEXT NOT NULL,
  mod_version       TEXT NOT NULL,
  artifact_sha256   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  notes             TEXT NOT NULL DEFAULT '',
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_official_mod_builds_lookup
  ON official_mod_builds(mod_id, minecraft_version, mod_version, enabled);

ALTER TABLE mod_pairings ADD COLUMN build_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_pairings ADD COLUMN artifact_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_pairings ADD COLUMN minecraft_version TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_pairings ADD COLUMN mod_version TEXT NOT NULL DEFAULT '';

ALTER TABLE mod_devices ADD COLUMN build_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_devices ADD COLUMN artifact_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_devices ADD COLUMN minecraft_version TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_devices ADD COLUMN mod_version TEXT NOT NULL DEFAULT '';
