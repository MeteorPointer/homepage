-- 一账号只能有一条模组令牌记录。保留已有重复记录中最新创建的一条。
DELETE FROM mod_tokens
WHERE rowid NOT IN (
  SELECT rowid
  FROM (
    SELECT rowid,
           ROW_NUMBER() OVER (PARTITION BY sub ORDER BY created_at DESC, rowid DESC) AS row_number
    FROM mod_tokens
  )
  WHERE row_number = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_tokens_one_per_user ON mod_tokens(sub);
