# 模组设备码授权（v2）

本文件是当前授权协议的规范。旧的账号级长 token 只保留迁移兼容，不再生成或在账号页展示。

鉴权客户端只在模组以 `-PsponsorEdition` 构建时启用。普通公开构建不会初始化鉴权、联网、注册授权快捷键或命令，也不会显示授权入口；`-Prelease` 与赞助版开关相互独立。

## 安全目标

- 保护官方构建中的赞助体验，不承诺客户端侧不可绕过 DRM。
- Minecraft 启动和世界加载不等待网络；授权失败只影响赞助权益。
- 不采集 MAC、硬盘号、`user.home` 等硬件或目录特征；授权判定只使用随机 `install_id`。当前电脑名称和 Minecraft 账号名仅在玩家主动发起绑定时提交，用于确认页和设备管理页展示，不参与判权。
- 长期 `device_token` 由模组本地生成，官网仅保存 SHA-256 哈希。
- Windows 客户端使用 DPAPI CurrentUser 加密 `device_token`、License 和配对凭证，并将授权目录 ACL 收紧为仅当前用户可访问；复制授权文件到另一台电脑或另一个 Windows 用户后无法解密。
- License 是短期 RS256 JWT；`refresh_after` 后后台续期，`exp` 是包含离线宽限的硬截止时间。

## 配对流程

1. 模组生成 256-bit `device_token`，向 `POST /api/mod/pair/start` 提交其哈希、随机安装 ID、当前电脑名称和本次 Minecraft 会话的账号名。
2. 官网返回高熵 `device_code`、短 `user_code`、绑定页地址、有效期和轮询间隔。
3. 用户在 `/mod/pair` 登录并核对短码、电脑名称与 Minecraft 账号名，再显式批准或拒绝。
4. 模组通过 `POST /api/mod/pair/poll` 轮询。批准后官网写入设备记录并返回 License 与公开 JWK。
5. 模组已持有自己生成的 `device_token`，因此无需由官网回传长期秘密；配对响应丢失后仍可调用续期端点恢复。

轮询错误使用 RFC 8628 名称：`authorization_pending`、`slow_down`、`access_denied`、`expired_token`。

## 日常续期

`POST /api/mod/license/refresh` 接收 `device_token`、`install_id` 和 `mod_id`。服务端对 token 哈希后查询 D1，检查凭证、安装 ID、赞助资格和签发配置。

服务端优先使用拥有 `team:<teamId>:member:read` 的 `PRISM_TEAM_READ_TOKEN` 复核资格，未配置时暂时回退到仍有效的用户会话。身份数据超过 `role_max_stale_hours` 且无法复核时停止签发新 License；已有 License 仍可离线使用到 `exp`。

## License v2

JWT header：`alg=RS256`、`typ=JWT`、`kid=<MOD_LICENSE_KEY_ID>`。

主要 claims：`iss`、`aud=nsuk-mod`、`sub`、`jti`、`iat`、`refresh_after`、`exp`、`mod_id=simukraft`、`license_version=3`、`install_id`、`credential_version`、`build_id`、`artifact_sha256`、`minecraft_version`、`mod_version`、`entitlements`、`tier`、`name`。

客户端必须校验签名、`kid`、issuer、audience、mod ID、安装 ID、时间字段和 License 版本。超过 `exp` 后不得继续接受。

## 吊销和换绑

- 账号页“紧急吊销”立即禁止旧设备再次续期，不受冷却限制。
- 绑定新设备继续受 `rebind_cooldown_hours` 限制；`admin` 账号为方便授权链路测试而免除该冷却。
- 纯离线 License 无法被远程瞬时删除；联网收到明确拒绝时立即降级，否则最迟在 `exp` 失效。
- Prism 降级会吊销 `mod_devices` 凭证并提高 `credential_version`。

## 官方构建完整性

- 最终赞助版 JAR 构建完成后计算 SHA-256，并由管理员登记到 `official_mod_builds`。
- 设备码创建和日常续期都提交当前 JAR 的 SHA-256、Minecraft 版本和模组版本。
- 官网只给启用的官方构建签发 v3 License；License 同时绑定 `build_id` 和上述构建身份。
- 直接修改、重新打包或使用未登记构建会得到 `unofficial_build`，但客户端自校验不能替代服务端功能权限边界。
- 旧 `/validate` 只返回 `410 CLIENT_UPGRADE_REQUIRED`，不再签发缺少构建绑定的 v2 License。

## 存储边界

- D1：配对状态、设备凭证哈希、硬确认次数与授权版本。
- KV：会话、OIDC/JWKS 缓存和削峰型软限流。
- KV 最终一致，不能承担配对消费、凭证轮换或硬吊销状态。
- 客户端 `auth.properties` 使用版本化格式。Windows 使用 DPAPI CurrentUser；Linux 使用本机 `machine-id` + 当前系统用户派生的 AES-GCM 密钥；macOS 使用 `IOPlatformUUID` + 当前系统用户派生的 AES-GCM 密钥。所有平台同时收紧文件权限，旧明文文件首次成功读取后自动迁移。
- Linux/macOS 的系统标识只在本机参与密钥派生，绝不上传官网；无法读取系统标识时拒绝持久化长期凭证，而不是降级成明文。
- 不使用主板 UUID、MAC 或磁盘序列作为硬件指纹；它们并非不可变，也不是可靠的物理设备证明。

## 客户端入口

客户端提供 Mods 配置页入口、可配置快捷键和客户端命令 `/nsuk auth`。授权页使用 Minecraft 原版 `Screen`，不依赖 Swing、JavaFX、内嵌浏览器或 LDLib2 能否正常渲染。

具体赞助功能必须调用客户端 entitlement API；若权益影响世界、服务端逻辑或特权网络包，还必须另行加入服务端判权。当前基础设施不会自行猜测或关闭未定义的游戏功能。
