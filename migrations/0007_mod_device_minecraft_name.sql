-- 记录发起绑定时 Minecraft 客户端实际登录的账号名。
-- 仅用于玩家核对和账号页展示，不参与授权判定。

ALTER TABLE mod_pairings ADD COLUMN minecraft_name TEXT NOT NULL DEFAULT '';
ALTER TABLE mod_devices ADD COLUMN minecraft_name TEXT NOT NULL DEFAULT '';
