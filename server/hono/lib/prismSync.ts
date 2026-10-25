// 身份组的主动核实与降级处置。
//
// webhook 与静默复查都走这里，保证「确认掉组 → 吊销 License → 踢会话」
// 这套动作只有一处实现。
import type { Env } from '../types'
import { prismConfig, isPrismConfigured } from './config'
import { getDiscovery, refreshTokens, verifyIdToken } from './oidc'
import { anyRefreshToken, destroySessionsForUser } from './session'
import { roleFromClaims, roleFromGroupSlugs, syncRole } from './users'
import { revokeJti } from './license'
import { AUDIT, recordAudit } from './audit'
import { normalizeRoleKey, MOD_MIN_LEVEL, type RoleKey } from './roles'

/**
 * 向 Prism 核实某用户当前的身份组。
 *
 * 返回 null 表示核实不了（未配置、无可用 refresh token、Prism 不可达），
 * 调用方需要自己决定是信任 webhook payload 还是放弃处理。
 */
export async function verifyRoleWithPrism(env: Env, sub: string): Promise<RoleKey | null> {
  if (!isPrismConfigured(env)) return null

  const refreshToken = await anyRefreshToken(env.KV, sub)
  if (!refreshToken) return null

  try {
    const cfg = prismConfig(env)
    const discovery = await getDiscovery(env.KV, cfg)
    const tokens = await refreshTokens(discovery, cfg, refreshToken)
    const claims = await verifyIdToken(env.KV, cfg, discovery, tokens.id_token)
    if (claims.sub !== sub) return null
    return roleFromClaims(env.DB, claims, cfg.teamId)
  } catch (e) {
    console.warn('[prismSync] 核实身份组失败', sub, String(e))
    return null
  }
}

interface PrismTeamMember {
  user_id?: string
  groups?: Array<string | { slug?: string }>
}

/**
 * 使用团队长期只读令牌直接核实成员身份组。这个令牌不依赖网页会话的 7 天 TTL，
 * 是模组设备长期续期的权威路径。
 */
export async function verifyRoleWithTeamToken(env: Env, sub: string): Promise<RoleKey | null> {
  const token = String(env.PRISM_TEAM_READ_TOKEN ?? '').trim()
  if (!token || !isPrismConfigured(env)) return null

  try {
    const cfg = prismConfig(env)
    const response = await fetch(
      `${cfg.issuer}/api/oauth/me/team/${encodeURIComponent(cfg.teamId)}/members`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      },
    )
    if (!response.ok) {
      console.warn('[prismSync] 团队成员复核失败', response.status)
      return null
    }

    const payload = (await response.json()) as { members?: PrismTeamMember[] }
    const member = payload.members?.find((item) => item.user_id === sub)
    if (!member) return 'guest'
    const slugs = (member.groups ?? [])
      .map((group) => (typeof group === 'string' ? group : (group.slug ?? '')))
      .filter(Boolean)
    return roleFromGroupSlugs(env.DB, slugs)
  } catch (error) {
    console.warn('[prismSync] 团队服务令牌复核失败', sub, String(error))
    return null
  }
}

/** 优先使用长期团队令牌，未配置或暂时不可用时再尝试用户会话。 */
export async function verifyCurrentRole(env: Env, sub: string): Promise<RoleKey | null> {
  return (await verifyRoleWithTeamToken(env, sub)) ?? verifyRoleWithPrism(env, sub)
}

/** 吊销该用户当前的模组 License，并清掉记录上的 jti */
async function revokeUserLicense(env: Env, sub: string): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE mod_devices
        SET revoked_at = ?, revoke_reason = 'role_downgrade',
            credential_version = credential_version + 1
      WHERE sub = ? AND revoked_at IS NULL`,
  )
    .bind(now, sub)
    .run()

  const row = await env.DB.prepare('SELECT token, current_jti FROM mod_tokens WHERE sub = ?')
    .bind(sub)
    .first<{ token: string; current_jti: string | null }>()

  if (row?.current_jti) {
    await revokeJti(env.KV, row.current_jti, Math.floor(Date.now() / 1000) + 7 * 24 * 3600)
    await env.DB.prepare('UPDATE mod_tokens SET current_jti = NULL WHERE token = ?')
      .bind(row.token)
      .run()
  }

  await recordAudit(env.DB, {
    actor: 'system',
    action: AUDIT.MOD_LICENSE_REVOKE,
    target: sub,
    detail: { reason: 'role_downgrade' },
  })
}

export interface ApplyResult {
  changed: boolean
  role: RoleKey
  /** 是否因降级而吊销了 License */
  revoked: boolean
}

/**
 * 把新的身份组落到本地，并在降级时做处置。
 *
 * 降到 MOD_MIN_LEVEL 以下才吊销 License —— staff 变 developer 这类平级/升级
 * 变动不该打断玩家正在进行的游戏。
 */
export async function applyRole(
  env: Env,
  sub: string,
  role: RoleKey,
  source: string,
): Promise<ApplyResult> {
  const before = await env.DB.prepare(
    `SELECT r.level AS level FROM users u JOIN roles r ON r.role_key = u.role_key WHERE u.sub = ?`,
  )
    .bind(sub)
    .first<{ level: number }>()

  const changed = await syncRole(env.DB, sub, role)
  if (!changed) return { changed: false, role, revoked: false }

  const after = await env.DB.prepare('SELECT level FROM roles WHERE role_key = ?')
    .bind(role)
    .first<{ level: number }>()

  const beforeLevel = Number(before?.level ?? 0)
  const afterLevel = Number(after?.level ?? 0)
  const downgradedBelowMod = beforeLevel >= MOD_MIN_LEVEL && afterLevel < MOD_MIN_LEVEL

  await recordAudit(env.DB, {
    actor: 'system',
    action: AUDIT.USER_ROLE_SYNC,
    target: sub,
    detail: { from: beforeLevel, to: afterLevel, role, source },
  })

  if (downgradedBelowMod) {
    await revokeUserLicense(env, sub)
    // 会话里缓存着旧权限，掉到游客必须重新登录
    await destroySessionsForUser(env.KV, sub)
  }

  return { changed: true, role, revoked: downgradedBelowMod }
}

/**
 * 核实优先、payload 兜底。
 *
 * webhook 的 payload 只当提示：能核实就以 Prism 为准，核实不了才按事件内容
 * 推算。后者的前提是共享密钥没泄露 —— 这也是密钥必须常数时间比对的原因。
 */
export async function reconcileUser(
  env: Env,
  sub: string,
  fallbackRole: RoleKey | null,
  source: string,
): Promise<ApplyResult | null> {
  const verified = await verifyRoleWithPrism(env, sub)
  const role = verified ?? (fallbackRole ? normalizeRoleKey(fallbackRole) : null)
  if (!role) return null
  return applyRole(env, sub, role, verified ? `${source}:verified` : `${source}:payload`)
}
