import type { Env } from '../types'
import { getConfig, nowIso } from './db'
import { randomToken, sha256Base64Url } from './crypto'
import { licensePublicKey, signLicense, type LicenseClaims } from './license'
import { applyRole, verifyCurrentRole } from './prismSync'
import { MOD_MIN_LEVEL } from './roles'
import type { OfficialModBuild } from './modBuilds'

export const MOD_ID = 'simukraft' as const
export const DEVICE_CODE_BYTES = 32
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export interface SponsorRow {
  sub: string
  display_name: string
  username: string
  role_key: string
  level: number
  groups_synced_at: string | null
}

export interface DeviceLicenseInput {
  installId: string
  credentialVersion: number
  user: SponsorRow
  build: OfficialModBuild
}

export class RoleCheckUnavailableError extends Error {
  constructor() {
    super('暂时无法核实赞助资格，请稍后重试')
    this.name = 'RoleCheckUnavailableError'
  }
}

export function normalizeUserCode(input: unknown): string {
  const compact = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : ''
}

export function newUserCode(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

export function validInstallId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function validCredentialHash(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

export async function hashSecret(value: string): Promise<string> {
  return sha256Base64Url(value)
}

export function newDeviceCode(): string {
  return randomToken(DEVICE_CODE_BYTES)
}

/** D1 硬限流，用于短码确认；KV 软限流只负责削峰。 */
export async function hardRateLimit(
  db: D1Database,
  rawKey: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = await sha256Base64Url(rawKey)
  const now = Date.now()
  const row = await db
    .prepare('SELECT hits, expires_at FROM mod_pair_rate_limits WHERE key = ?')
    .bind(key)
    .first<{ hits: number; expires_at: string }>()

  if (!row || new Date(row.expires_at).getTime() <= now) {
    await db
      .prepare(
        `INSERT INTO mod_pair_rate_limits (key, hits, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET hits = 1, expires_at = excluded.expires_at`,
      )
      .bind(key, new Date(now + windowSeconds * 1000).toISOString())
      .run()
    return true
  }

  const updated = await db
    .prepare(
      `UPDATE mod_pair_rate_limits SET hits = hits + 1
        WHERE key = ? AND hits < ? AND expires_at > ?`,
    )
    .bind(key, limit, nowIso())
    .run()
  return Number(updated.meta.changes ?? 0) > 0
}

async function sponsorRow(env: Env, sub: string): Promise<SponsorRow | null> {
  return env.DB.prepare(
    `SELECT u.sub, u.display_name, u.username, u.role_key, u.groups_synced_at, r.level
       FROM users u JOIN roles r ON r.role_key = u.role_key
      WHERE u.sub = ? AND u.deleted_at IS NULL`,
  )
    .bind(sub)
    .first<SponsorRow>()
}

/**
 * 续期前按配置复核 Prism。超过最大陈旧时间仍无法核实时停止签发新 License，
 * 客户端可继续使用已有 License 到硬 exp，不会因临时网络错误立刻降级。
 */
export async function freshSponsor(env: Env, sub: string): Promise<SponsorRow | null> {
  let row = await sponsorRow(env, sub)
  if (!row) return null

  const recheckHours = await getConfig<number>(env.DB, 'role_recheck_hours', 6)
  const maxStaleHours = await getConfig<number>(env.DB, 'role_max_stale_hours', 24)
  const parsedSyncedAt = row.groups_synced_at ? new Date(row.groups_synced_at).getTime() : 0
  const syncedAt = Number.isFinite(parsedSyncedAt) ? parsedSyncedAt : 0
  const staleMs = Math.max(0, Date.now() - syncedAt)

  if (staleMs >= recheckHours * 3600_000) {
    const verified = await verifyCurrentRole(env, sub)
    if (verified) {
      await applyRole(env, sub, verified, 'mod.license_refresh')
      row = await sponsorRow(env, sub)
      if (!row) return null
    } else if (staleMs >= maxStaleHours * 3600_000) {
      throw new RoleCheckUnavailableError()
    }
  }

  return Number(row.level) >= MOD_MIN_LEVEL ? row : null
}

export async function issueDeviceLicense(env: Env, input: DeviceLicenseInput) {
  const refreshHours = await getConfig<number>(env.DB, 'license_ttl_hours', 24)
  const graceDays = await getConfig<number>(env.DB, 'offline_grace_days', 3)
  const iat = Math.floor(Date.now() / 1000)
  const refreshAfter = iat + Math.max(1, refreshHours) * 3600
  const exp = refreshAfter + Math.max(0, graceDays) * 24 * 3600
  const claims: LicenseClaims = {
    iss: (env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    aud: 'nsuk-mod',
    sub: input.user.sub,
    jti: crypto.randomUUID(),
    iat,
    refresh_after: refreshAfter,
    exp,
    mod_id: MOD_ID,
    license_version: 3,
    install_id: input.installId,
    credential_version: input.credentialVersion,
    build_id: input.build.buildId,
    artifact_sha256: input.build.artifactSha256,
    minecraft_version: input.build.minecraftVersion,
    mod_version: input.build.modVersion,
    entitlements: ['sponsor'],
    tier: input.user.role_key,
    name: input.user.display_name || input.user.username,
  }

  return {
    license: await signLicense(env, claims),
    license_key: await licensePublicKey(env),
    refresh_after: refreshAfter,
    expires_at: exp,
    tier: claims.tier,
    entitlements: claims.entitlements,
  }
}

/** 仅供旧 /validate 客户端迁移；新设备码链路始终签发构建绑定的 v3 License。 */
export async function issueLegacyLicense(env: Env, input: Omit<DeviceLicenseInput, 'build'>) {
  const refreshHours = await getConfig<number>(env.DB, 'license_ttl_hours', 24)
  const graceDays = await getConfig<number>(env.DB, 'offline_grace_days', 3)
  const iat = Math.floor(Date.now() / 1000)
  const refreshAfter = iat + Math.max(1, refreshHours) * 3600
  const exp = refreshAfter + Math.max(0, graceDays) * 24 * 3600
  const claims: LicenseClaims = {
    iss: (env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    aud: 'nsuk-mod',
    sub: input.user.sub,
    jti: crypto.randomUUID(),
    iat,
    refresh_after: refreshAfter,
    exp,
    mod_id: MOD_ID,
    license_version: 2,
    install_id: input.installId,
    credential_version: input.credentialVersion,
    entitlements: ['sponsor'],
    tier: input.user.role_key,
    name: input.user.display_name || input.user.username,
  }
  return {
    license: await signLicense(env, claims),
    license_key: await licensePublicKey(env),
    refresh_after: refreshAfter,
    expires_at: exp,
    tier: claims.tier,
    entitlements: claims.entitlements,
  }
}
