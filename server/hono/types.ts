/// <reference types="@cloudflare/workers-types" />

/** Worker 绑定与配置，与 wrangler.toml 一一对应 */
export interface Env {
  DB: D1Database
  KV: KVNamespace
  R2: R2Bucket
  ASSETS: Fetcher

  // ─── vars ───
  SITE_URL?: string
  PRISM_ISSUER?: string
  PRISM_CLIENT_ID?: string
  /** NSUK 团队 ID，用于读取 groups_in_team_<id> / in_team_<id> claim */
  PRISM_TEAM_ID?: string
  /** 团队邀请链接注册入口，形如 https://<prism>/join/<teamId> */
  PRISM_JOIN_URL?: string
  /** License JWT header.kid；轮换密钥时同步更新 */
  MOD_LICENSE_KEY_ID?: string

  // ─── secrets ───
  PRISM_CLIENT_SECRET?: string
  /** 拥有 team:<teamId>:member:read 的长期服务令牌，用于模组续期时复核赞助资格 */
  PRISM_TEAM_READ_TOKEN?: string
  MOD_LICENSE_PRIVATE_KEY?: string
  WEBHOOK_SECRET?: string
}

/** 登录用户。身份来自 Prism，role 由团队身份组派生 */
export interface SessionUser {
  sub: string
  username: string
  displayName: string
  roleKey: string
  level: number
  permissions: string[]
}

export type AppBindings = {
  Bindings: Env
  Variables: {
    user: SessionUser | null
  }
}
