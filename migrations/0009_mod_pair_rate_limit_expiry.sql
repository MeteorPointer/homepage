-- 硬限流记录需要按过期时间清理，避免随机 IP/短码长期堆积。
CREATE INDEX IF NOT EXISTS idx_mod_pair_rate_limits_expiry
  ON mod_pair_rate_limits(expires_at);
