# 模组设备码授权（v2）

本文件是当前授权协议的规范。旧的账号级长 token 只保留迁移兼容，不再生成或在账号页展示。

鉴权客户端只在模组以 `-PsponsorEdition` 构建时启用。普通公开构建不会初始化鉴权、联网、注册授权快捷键或命令，也不会显示授权入口；`-Prelease` 与赞助版开关相互独立。

## 安全目标

- 保护官方构建中的赞助体验，不承诺客户端侧不可绕过 DRM。
- Minecraft 启动和世界加载不等待网络；授权失败只影响赞助权益。
- 不采集 MAC、硬盘号、`user.home` 等硬件或目录特征，只使用随机 `install_id`。
- 长期 `device_token` 由模组本地生成，官网仅保存 SHA-256 哈希。
- License 是短期 RS256 JWT；`refresh_after` 后后台续期，`exp` 是包含离线宽限的硬截止时间。

## 配对流程

1. 模组生成 256-bit `device_token`，向 `POST /api/mod/pair/start` 只提交其哈希、随机安装 ID 和设备名称。
2. 官网返回高熵 `device_code`、短 `user_code`、绑定页地址、有效期和轮询间隔。
3. 用户在 `/mod/pair` 登录并核对短码与设备名称，再显式批准或拒绝。
4. 模组通过 `POST /api/mod/pair/poll` 轮询。批准后官网写入设备记录并返回 License 与公开 JWK。
5. 模组已持有自己生成的 `device_token`，因此无需由官网回传长期秘密；配对响应丢失后仍可调用续期端点恢复。

轮询错误使用 RFC 8628 名称：`authorization_pending`、`slow_down`、`access_denied`、`expired_token`。

## 日常续期

`POST /api/mod/license/refresh` 接收 `device_token`、`install_id` 和 `mod_id`。服务端对 token 哈希后查询 D1，检查凭证、安装 ID、赞助资格和签发配置。

服务端优先使用拥有 `team:<teamId>:member:read` 的 `PRISM_TEAM_READ_TOKEN` 复核资格，未配置时暂时回退到仍有效的用户会话。身份数据超过 `role_max_stale_hours` 且无法复核时停止签发新 License；已有 License 仍可离线使用到 `exp`。

## License v2

JWT header：`alg=RS256`、`typ=JWT`、`kid=<MOD_LICENSE_KEY_ID>`。

主要 claims：`iss`、`aud=nsuk-mod`、`sub`、`jti`、`iat`、`refresh_after`、`exp`、`mod_id=simukraft`、`license_version=2`、`install_id`、`credential_version`、`entitlements`、`tier`、`name`。

客户端必须校验签名、`kid`、issuer、audience、mod ID、安装 ID、时间字段和 License 版本。超过 `exp` 后不得继续接受。

## 吊销和换绑

- 账号页“紧急吊销”立即禁止旧设备再次续期，不受冷却限制。
- 绑定新设备继续受 `rebind_cooldown_hours` 限制。
- 纯离线 License 无法被远程瞬时删除；联网收到明确拒绝时立即降级，否则最迟在 `exp` 失效。
- Prism 降级会吊销 `mod_devices` 凭证并提高 `credential_version`。

## 存储边界

- D1：配对状态、设备凭证哈希、硬确认次数与授权版本。
- KV：会话、OIDC/JWKS 缓存和削峰型软限流。
- KV 最终一致，不能承担配对消费、凭证轮换或硬吊销状态。

## 客户端入口

客户端提供 Mods 配置页入口、可配置快捷键和客户端命令 `/nsuk auth`。授权页使用 Minecraft 原版 `Screen`，不依赖 Swing、JavaFX、内嵌浏览器或 LDLib2 能否正常渲染。

具体赞助功能必须调用客户端 entitlement API；若权益影响世界、服务端逻辑或特权网络包，还必须另行加入服务端判权。当前基础设施不会自行猜测或关闭未定义的游戏功能。
