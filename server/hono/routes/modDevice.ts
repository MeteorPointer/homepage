// NSUK 模组授权：设备码配对、每设备续期凭证与短期签名 License。
// 旧 /validate 仅保留迁移兼容；新客户端不再生成或展示账号级明文长 token。
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../types'
import { requireAuth, requireLevel } from '../lib/rbac'
import { isRebindCooldownExempt, MOD_MIN_LEVEL } from '../lib/roles'
import { getConfig, nowIso } from '../lib/db'
import { clientIp, rateLimit } from '../lib/ratelimit'
import { AUDIT, recordAudit } from '../lib/audit'
import { licensePublicKey } from '../lib/license'
import { siteUrl } from '../lib/config'
import {
  MOD_ID,
  RoleCheckUnavailableError,
  freshSponsor,
  hardRateLimit,
  hashSecret,
  issueDeviceLicense,
  issueLegacyLicense,
  newDeviceCode,
  newUserCode,
  normalizeUserCode,
  validCredentialHash,
  validInstallId,
} from '../lib/modAuth'
import { findOfficialModBuild, parseModBuildIdentity } from '../lib/modBuilds'

const r = new Hono<AppBindings>()

interface PairingRow {
  id: string
  device_code_hash: string
  user_code: string
  credential_hash: string
  install_id: string
  device_name: string
  minecraft_name: string
  build_id: string
  artifact_sha256: string
  minecraft_version: string
  mod_version: string
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'
  confirmed_sub: string | null
  created_at: string
  expires_at: string
  approved_at: string | null
  consumed_at: string | null
}

interface DeviceRow {
  id: string
  sub: string
  credential_hash: string
  install_id: string
  device_name: string
  minecraft_name: string
  build_id: string
  artifact_sha256: string
  minecraft_version: string
  mod_version: string
  credential_version: number
  bound_at: string
  last_seen_at: string | null
  revoked_at: string | null
  revoke_reason: string | null
}

interface LegacyTokenRow {
  token: string
  sub: string
  bound_fingerprint: string | null
  bound_at: string | null
  reset_at: string | null
  created_at: string
  device_name: string
  last_seen_at: string | null
  revoked_at: string | null
}

function noStore(c: Context<AppBindings>): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
}

r.use('*', async (c, next) => {
  noStore(c)
  await next()
})

function invalid(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { valid: false as const, code, message, ...extra }
}

async function cooldownHours(db: D1Database): Promise<number> {
  return getConfig<number>(db, 'rebind_cooldown_hours', 24)
}

function remainingCooldown(boundAt: string | null, hours: number): number {
  if (!boundAt) return 0
  const elapsed = Date.now() - new Date(boundAt).getTime()
  const total = hours * 3600_000
  if (elapsed >= total) return 0
  return Math.ceil((total - elapsed) / 3600_000)
}

function pairingExpired(row: Pick<PairingRow, 'expires_at'>): boolean {
  return new Date(row.expires_at).getTime() <= Date.now()
}

async function expirePairing(db: D1Database, row: PairingRow): Promise<void> {
  if (!pairingExpired(row) || row.status === 'expired') return
  await db
    .prepare(
      `UPDATE mod_pairings SET status = 'expired'
        WHERE id = ? AND status IN ('pending', 'approved')`,
    )
    .bind(row.id)
    .run()
}

async function pairingByUserCode(db: D1Database, input: unknown): Promise<PairingRow | null> {
  const userCode = normalizeUserCode(input)
  if (!userCode) return null
  return db
    .prepare('SELECT * FROM mod_pairings WHERE user_code = ?')
    .bind(userCode)
    .first<PairingRow>()
}

// ─── License 公钥 ────────────────────────────────────────────────────────────

r.get('/license/keys', async (c) => {
  noStore(c)
  try {
    return c.json({ keys: [await licensePublicKey(c.env)] })
  } catch (error) {
    console.error('[mod] License 公钥不可用', String(error))
    return c.json({ error: 'license_unavailable' }, 503)
  }
})

// ─── RFC 8628 风格设备码配对 ─────────────────────────────────────────────────

r.post('/pair/start', async (c) => {
  noStore(c)
  const body = await c.req
    .json<{
      mod_id?: string
      install_id?: string
      device_name?: string
      minecraft_name?: string
      credential_hash?: string
      minecraft_version?: string
      mod_version?: string
      artifact_sha256?: string
    }>()
    .catch(
      (): {
        mod_id?: string
        install_id?: string
        device_name?: string
        minecraft_name?: string
        credential_hash?: string
        minecraft_version?: string
        mod_version?: string
        artifact_sha256?: string
      } => ({}),
    )
  const installId = String(body.install_id ?? '').trim()
  const credentialHash = String(body.credential_hash ?? '').trim()
  const buildIdentity = parseModBuildIdentity(body)
  const deviceName = String(body.device_name ?? 'Minecraft 客户端')
    .trim()
    .slice(0, 64)
  const minecraftName = String(body.minecraft_name ?? '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, 64)

  if (!buildIdentity || !validInstallId(installId) || !validCredentialHash(credentialHash)) {
    return c.json({ error: 'invalid_request', error_description: '设备配对参数不合法' }, 400)
  }

  const ip = clientIp(c.req.raw.headers)
  const [ipLimit, deviceLimit] = await Promise.all([
    rateLimit(c.env.KV, `mod:pair:start:ip:${ip}`, 10, 60),
    rateLimit(c.env.KV, `mod:pair:start:install:${installId}`, 5, 600),
  ])
  if (!ipLimit.ok || !deviceLimit.ok) {
    return c.json({ error: 'slow_down', error_description: '请求过于频繁，请稍后重试' }, 429)
  }

  const build = await findOfficialModBuild(c.env, buildIdentity)
  if (!build) {
    return c.json(
      { error: 'unofficial_build', error_description: '当前模组不是官网登记的官方赞助版构建' },
      403,
    )
  }

  const ttl = await getConfig<number>(c.env.DB, 'pairing_ttl_seconds', 600)
  const interval = await getConfig<number>(c.env.DB, 'pairing_poll_seconds', 5)
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + Math.max(120, ttl) * 1000).toISOString()

  await c.env.DB.prepare(
    `UPDATE mod_pairings SET status = 'expired'
      WHERE install_id = ? AND status IN ('pending', 'approved')`,
  )
    .bind(installId)
    .run()

  for (let attempt = 0; attempt < 8; attempt++) {
    const deviceCode = newDeviceCode()
    const deviceCodeHash = await hashSecret(deviceCode)
    const userCode = newUserCode()
    const id = crypto.randomUUID()
    const inserted = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO mod_pairings
        (id, device_code_hash, user_code, credential_hash, install_id, device_name,
         minecraft_name, build_id, artifact_sha256, minecraft_version, mod_version,
         status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(
        id,
        deviceCodeHash,
        userCode,
        credentialHash,
        installId,
        deviceName,
        minecraftName,
        build.buildId,
        build.artifactSha256,
        build.minecraftVersion,
        build.modVersion,
        createdAt,
        expiresAt,
      )
      .run()
    if (!inserted.meta.changes) continue

    const verificationUri = `${siteUrl(c.env)}/mod/pair`
    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
      expires_in: Math.max(120, ttl),
      interval: Math.max(5, interval),
    })
  }

  return c.json({ error: 'temporarily_unavailable', error_description: '暂时无法创建绑定码' }, 503)
})

r.post('/pair/info', async (c) => {
  noStore(c)
  const ip = clientIp(c.req.raw.headers)
  const limit = await rateLimit(c.env.KV, `mod:pair:info:${ip}`, 30, 60)
  if (!limit.ok) return c.json({ error: 'slow_down' }, 429)

  const body = await c.req.json<{ user_code?: string }>().catch((): { user_code?: string } => ({}))
  const row = await pairingByUserCode(c.env.DB, body.user_code)
  if (!row) return c.json({ error: 'invalid_user_code' }, 404)
  await expirePairing(c.env.DB, row)
  return c.json({
    user_code: row.user_code,
    device_name: row.device_name,
    minecraft_name: row.minecraft_name,
    build_id: row.build_id,
    minecraft_version: row.minecraft_version,
    mod_version: row.mod_version,
    status: pairingExpired(row) ? 'expired' : row.status,
    expires_at: row.expires_at,
  })
})

r.post('/pair/confirm', requireLevel(MOD_MIN_LEVEL), async (c) => {
  noStore(c)
  const ip = clientIp(c.req.raw.headers)
  if (!(await hardRateLimit(c.env.DB, `pair-confirm:${ip}`, 10, 600))) {
    return c.json({ error: 'slow_down', error_description: '短码尝试次数过多' }, 429)
  }

  const body = await c.req.json<{ user_code?: string }>().catch((): { user_code?: string } => ({}))
  const row = await pairingByUserCode(c.env.DB, body.user_code)
  if (!row) return c.json({ error: 'invalid_user_code', error_description: '绑定码无效' }, 404)
  if (pairingExpired(row)) {
    await expirePairing(c.env.DB, row)
    return c.json({ error: 'expired_token', error_description: '绑定码已过期' }, 400)
  }
  if (row.status !== 'pending') {
    return c.json({ error: 'invalid_request', error_description: '绑定码已经处理' }, 409)
  }

  const user = c.get('user')!
  const existing = await c.env.DB.prepare(
    'SELECT credential_hash, bound_at FROM mod_devices WHERE sub = ?',
  )
    .bind(user.sub)
    .first<Pick<DeviceRow, 'credential_hash' | 'bound_at'>>()
  const hours = await cooldownHours(c.env.DB)
  const cooldownExempt = isRebindCooldownExempt(user.roleKey)
  const remaining =
    !cooldownExempt && existing && existing.credential_hash !== row.credential_hash
      ? remainingCooldown(existing.bound_at, hours)
      : 0
  if (remaining > 0) {
    return c.json(
      {
        error: 'rebind_cooldown',
        error_description: `换绑冷却中，还需等待 ${remaining} 小时`,
        remaining_hours: remaining,
      },
      429,
    )
  }

  const now = nowIso()
  const confirmed = await c.env.DB.prepare(
    `UPDATE mod_pairings
        SET status = 'approved', confirmed_sub = ?, approved_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?`,
  )
    .bind(user.sub, now, row.id, now)
    .run()
  if (!confirmed.meta.changes) {
    return c.json({ error: 'invalid_request', error_description: '绑定状态刚刚发生变化' }, 409)
  }

  await recordAudit(c.env.DB, {
    actor: user.sub,
    action: AUDIT.MOD_PAIR_APPROVE,
    target: row.id,
    detail: {
      installId: row.install_id,
      deviceName: row.device_name,
      minecraftName: row.minecraft_name,
    },
  })
  return c.json({
    ok: true,
    device_name: row.device_name,
    minecraft_name: row.minecraft_name,
  })
})

r.post('/pair/poll', async (c) => {
  noStore(c)
  const body = await c.req
    .json<{ device_code?: string }>()
    .catch((): { device_code?: string } => ({}))
  const deviceCode = String(body.device_code ?? '').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(deviceCode)) {
    return c.json({ error: 'invalid_request' }, 400)
  }

  const deviceCodeHash = await hashSecret(deviceCode)
  const limit = await rateLimit(c.env.KV, `mod:pair:poll:${deviceCodeHash}`, 20, 60)
  if (!limit.ok) return c.json({ error: 'slow_down' }, 429)

  const row = await c.env.DB.prepare('SELECT * FROM mod_pairings WHERE device_code_hash = ?')
    .bind(deviceCodeHash)
    .first<PairingRow>()
  if (!row) return c.json({ error: 'expired_token' }, 400)
  if (pairingExpired(row)) {
    await expirePairing(c.env.DB, row)
    return c.json({ error: 'expired_token' }, 400)
  }
  if (row.status === 'pending') return c.json({ error: 'authorization_pending' }, 400)
  if (row.status === 'denied') return c.json({ error: 'access_denied' }, 400)
  if (!row.confirmed_sub || (row.status !== 'approved' && row.status !== 'consumed')) {
    return c.json({ error: 'expired_token' }, 400)
  }

  let user
  try {
    user = await freshSponsor(c.env, row.confirmed_sub)
  } catch (error) {
    if (error instanceof RoleCheckUnavailableError) {
      return c.json({ error: 'temporarily_unavailable', error_description: error.message }, 503)
    }
    throw error
  }
  if (!user)
    return c.json({ error: 'access_denied', error_description: '当前账号没有赞助资格' }, 403)

  const build = await findOfficialModBuild(c.env, {
    modId: MOD_ID,
    minecraftVersion: row.minecraft_version,
    modVersion: row.mod_version,
    artifactSha256: row.artifact_sha256,
  })
  if (!build || build.buildId !== row.build_id) {
    return c.json(
      { error: 'unofficial_build', error_description: '此构建已停用或不再属于官方赞助版' },
      403,
    )
  }

  const now = nowIso()
  const hours = await cooldownHours(c.env.DB)
  const cooldownExempt = isRebindCooldownExempt(user.role_key)
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString()
  let bound
  try {
    bound = await c.env.DB.prepare(
      `INSERT INTO mod_devices
        (id, sub, credential_hash, install_id, device_name, minecraft_name, credential_version,
         build_id, artifact_sha256, minecraft_version, mod_version,
         bound_at, last_seen_at, revoked_at, revoke_reason)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(sub) DO UPDATE SET
         credential_hash = excluded.credential_hash,
         install_id = excluded.install_id,
         device_name = excluded.device_name,
         minecraft_name = excluded.minecraft_name,
         build_id = excluded.build_id,
         artifact_sha256 = excluded.artifact_sha256,
         minecraft_version = excluded.minecraft_version,
         mod_version = excluded.mod_version,
         credential_version = CASE
           WHEN mod_devices.credential_hash = excluded.credential_hash
             THEN mod_devices.credential_version
           ELSE mod_devices.credential_version + 1
         END,
         bound_at = CASE
           WHEN mod_devices.credential_hash = excluded.credential_hash
             THEN mod_devices.bound_at
           ELSE excluded.bound_at
         END,
         last_seen_at = excluded.last_seen_at,
         revoked_at = NULL,
         revoke_reason = NULL
       WHERE (mod_devices.credential_hash = excluded.credential_hash
              AND mod_devices.revoked_at IS NULL)
          OR (mod_devices.credential_hash != excluded.credential_hash
              AND (? = 1 OR mod_devices.bound_at <= ?))`,
    )
      .bind(
        crypto.randomUUID(),
        user.sub,
        row.credential_hash,
        row.install_id,
        row.device_name,
        row.minecraft_name,
        build.buildId,
        build.artifactSha256,
        build.minecraftVersion,
        build.modVersion,
        now,
        now,
        cooldownExempt ? 1 : 0,
        cutoff,
      )
      .run()
  } catch (error) {
    console.warn('[mod] 设备绑定冲突', user.sub, String(error))
    return c.json({ error: 'credential_conflict', error_description: '设备凭证冲突' }, 409)
  }

  if (!bound.meta.changes) {
    return c.json({ error: 'rebind_cooldown', error_description: '换绑仍在冷却中' }, 429)
  }

  const device = await c.env.DB.prepare(
    'SELECT credential_version FROM mod_devices WHERE sub = ? AND credential_hash = ?',
  )
    .bind(user.sub, row.credential_hash)
    .first<{ credential_version: number }>()
  if (!device) return c.json({ error: 'temporarily_unavailable' }, 503)

  const result = await issueDeviceLicense(c.env, {
    installId: row.install_id,
    credentialVersion: Number(device.credential_version),
    user,
    build,
  })
  await c.env.DB.prepare(
    `UPDATE mod_pairings
        SET status = 'consumed', consumed_at = COALESCE(consumed_at, ?)
      WHERE id = ?`,
  )
    .bind(now, row.id)
    .run()

  if (row.status !== 'consumed') {
    await recordAudit(c.env.DB, {
      actor: user.sub,
      action: AUDIT.MOD_DEVICE_BIND,
      target: row.install_id,
      detail: {
        deviceName: row.device_name,
        minecraftName: row.minecraft_name,
        buildId: build.buildId,
        artifactSha256: build.artifactSha256,
      },
    })
  }
  return c.json({ ok: true, ...result })
})

// ─── 日常续期 ────────────────────────────────────────────────────────────────

r.post('/license/refresh', async (c) => {
  noStore(c)
  const body = await c.req
    .json<{
      mod_id?: string
      install_id?: string
      device_token?: string
      minecraft_version?: string
      mod_version?: string
      artifact_sha256?: string
    }>()
    .catch(
      (): {
        mod_id?: string
        install_id?: string
        device_token?: string
        minecraft_version?: string
        mod_version?: string
        artifact_sha256?: string
      } => ({}),
    )
  const installId = String(body.install_id ?? '').trim()
  const deviceToken = String(body.device_token ?? '').trim()
  const buildIdentity = parseModBuildIdentity(body)
  if (!buildIdentity || !validInstallId(installId) || !/^[A-Za-z0-9_-]{43}$/.test(deviceToken)) {
    return c.json({ error: 'invalid_request' }, 400)
  }

  const credentialHash = await hashSecret(deviceToken)
  const ip = clientIp(c.req.raw.headers)
  const [ipLimit, credentialLimit] = await Promise.all([
    rateLimit(c.env.KV, `mod:refresh:ip:${ip}`, 30, 60),
    rateLimit(c.env.KV, `mod:refresh:credential:${credentialHash}`, 10, 60),
  ])
  if (!ipLimit.ok || !credentialLimit.ok) return c.json({ error: 'slow_down' }, 429)

  const build = await findOfficialModBuild(c.env, buildIdentity)
  if (!build) {
    return c.json(
      { error: 'unofficial_build', error_description: '当前模组不是官网登记的官方赞助版构建' },
      403,
    )
  }

  const device = await c.env.DB.prepare('SELECT * FROM mod_devices WHERE credential_hash = ?')
    .bind(credentialHash)
    .first<DeviceRow>()
  if (!device || device.install_id !== installId) {
    return c.json({ error: 'invalid_grant', error_description: '设备凭证无效' }, 401)
  }
  if (device.revoked_at) {
    return c.json({ error: 'device_revoked', error_description: '此设备授权已被吊销' }, 403)
  }

  let user
  try {
    user = await freshSponsor(c.env, device.sub)
  } catch (error) {
    if (error instanceof RoleCheckUnavailableError) {
      return c.json({ error: 'temporarily_unavailable', error_description: error.message }, 503)
    }
    throw error
  }
  if (!user)
    return c.json({ error: 'access_denied', error_description: '当前账号没有赞助资格' }, 403)

  const now = nowIso()
  await c.env.DB.prepare(
    `UPDATE mod_devices
        SET last_seen_at = ?, build_id = ?, artifact_sha256 = ?,
            minecraft_version = ?, mod_version = ?
      WHERE id = ?`,
  )
    .bind(
      now,
      build.buildId,
      build.artifactSha256,
      build.minecraftVersion,
      build.modVersion,
      device.id,
    )
    .run()
  return c.json({
    ok: true,
    ...(await issueDeviceLicense(c.env, {
      installId,
      credentialVersion: Number(device.credential_version),
      user,
      build,
    })),
  })
})

// ─── 官网设备管理 ────────────────────────────────────────────────────────────

r.get('/devices', requireAuth(), async (c) => {
  noStore(c)
  const user = c.get('user')!
  const device = await c.env.DB.prepare(
    `SELECT id, install_id, device_name, minecraft_name, credential_version,
            build_id, artifact_sha256, minecraft_version, mod_version, bound_at,
            last_seen_at, revoked_at, revoke_reason
       FROM mod_devices WHERE sub = ?`,
  )
    .bind(user.sub)
    .first<Omit<DeviceRow, 'sub' | 'credential_hash'>>()
  const hours = await cooldownHours(c.env.DB)
  const cooldownExempt = isRebindCooldownExempt(user.roleKey)
  const legacy = await c.env.DB.prepare(
    'SELECT 1 AS active FROM mod_tokens WHERE sub = ? AND revoked_at IS NULL',
  )
    .bind(user.sub)
    .first<{ active: number }>()
  return c.json({
    ok: true,
    legacyActive: !!legacy,
    device: device
      ? {
          id: device.id,
          installId: device.install_id,
          deviceName: device.device_name,
          minecraftName: device.minecraft_name,
          credentialVersion: device.credential_version,
          buildId: device.build_id,
          artifactSha256: device.artifact_sha256,
          minecraftVersion: device.minecraft_version,
          modVersion: device.mod_version,
          boundAt: device.bound_at,
          lastSeenAt: device.last_seen_at,
          revokedAt: device.revoked_at,
          revokeReason: device.revoke_reason,
          cooldownHours: hours,
          cooldownExempt,
          remainingCooldownHours: cooldownExempt ? 0 : remainingCooldown(device.bound_at, hours),
        }
      : null,
  })
})

r.post('/devices/revoke', requireAuth(), async (c) => {
  noStore(c)
  const user = c.get('user')!
  const now = nowIso()
  const result = await c.env.DB.prepare(
    `UPDATE mod_devices
        SET revoked_at = ?, revoke_reason = 'user_revoked',
            credential_version = credential_version + 1
      WHERE sub = ? AND revoked_at IS NULL`,
  )
    .bind(now, user.sub)
    .run()
  await c.env.DB.prepare(
    `UPDATE mod_pairings SET status = 'denied'
      WHERE confirmed_sub = ? AND status IN ('pending', 'approved', 'consumed')`,
  )
    .bind(user.sub)
    .run()

  if (result.meta.changes) {
    await recordAudit(c.env.DB, {
      actor: user.sub,
      action: AUDIT.MOD_DEVICE_REVOKE,
      target: user.sub,
      detail: { reason: 'user_revoked' },
    })
  }
  return c.json({ ok: true, revoked: Number(result.meta.changes ?? 0) > 0 })
})

// ─── 旧 token 迁移兼容 ───────────────────────────────────────────────────────

r.post('/validate', async (c) => {
  noStore(c)
  const body = await c.req
    .json<{ token?: string; fingerprint?: string; device_name?: string }>()
    .catch((): { token?: string; fingerprint?: string; device_name?: string } => ({}))
  const token = String(body.token ?? '').trim()
  const fingerprint = String(body.fingerprint ?? '').trim()
  if (!token || !fingerprint) return c.json(invalid('BAD_REQUEST', '缺少 token 或 fingerprint'))

  const tokenHash = await hashSecret(token)
  const limit = await rateLimit(c.env.KV, `mod:legacy:${tokenHash}`, 10, 60)
  if (!limit.ok) return c.json(invalid('RATE_LIMITED', '请求过于频繁，请稍后再试'))

  const row = await c.env.DB.prepare('SELECT * FROM mod_tokens WHERE token = ?')
    .bind(token)
    .first<LegacyTokenRow>()
  if (!row) return c.json(invalid('TOKEN_NOT_FOUND', 'token 不存在'))
  if (row.revoked_at) return c.json(invalid('TOKEN_REVOKED', '此令牌已作废，请重新绑定设备'))

  const firstBind = !row.bound_fingerprint
  const now = nowIso()
  if (firstBind) {
    const bound = await c.env.DB.prepare(
      `UPDATE mod_tokens
          SET bound_fingerprint = ?, bound_at = ?, device_name = ?
        WHERE token = ? AND bound_fingerprint IS NULL AND revoked_at IS NULL`,
    )
      .bind(fingerprint, now, String(body.device_name ?? '').slice(0, 64), token)
      .run()
    if (!bound.meta.changes) return c.json(invalid('DEVICE_MISMATCH', '此 token 已绑定其他设备'))
  } else if (row.bound_fingerprint !== fingerprint) {
    return c.json(invalid('DEVICE_MISMATCH', '此 token 已绑定其他设备'))
  }

  let user
  try {
    user = await freshSponsor(c.env, row.sub)
  } catch (error) {
    if (error instanceof RoleCheckUnavailableError) {
      return c.json(invalid('ROLE_CHECK_UNAVAILABLE', error.message))
    }
    throw error
  }
  if (!user) return c.json(invalid('NOT_SPONSOR', '权限不足，需要赞助者身份'))

  const result = await issueLegacyLicense(c.env, {
    installId: fingerprint,
    credentialVersion: 1,
    user,
  })
  await c.env.DB.prepare('UPDATE mod_tokens SET last_seen_at = ? WHERE token = ?')
    .bind(now, token)
    .run()
  return c.json({
    valid: true,
    username: user.display_name || user.username,
    message: firstBind ? '首次激活成功' : '',
    ...result,
  })
})

r.get('/token', requireLevel(MOD_MIN_LEVEL), async (c) => {
  noStore(c)
  const row = await c.env.DB.prepare(
    `SELECT bound_fingerprint, bound_at, created_at, device_name, last_seen_at, revoked_at
       FROM mod_tokens WHERE sub = ?`,
  )
    .bind(c.get('user')!.sub)
    .first<LegacyTokenRow>()
  return c.json({
    ok: true,
    legacy: row
      ? {
          hasBound: !!row.bound_fingerprint,
          boundAt: row.bound_at,
          createdAt: row.created_at,
          deviceName: row.device_name,
          lastSeenAt: row.last_seen_at,
          revokedAt: row.revoked_at,
        }
      : null,
    deprecated: true,
  })
})

r.post('/token/generate', requireLevel(MOD_MIN_LEVEL), (c) => {
  noStore(c)
  return c.json(
    {
      ok: false,
      code: 'LEGACY_TOKEN_DISABLED',
      error: '已停止生成旧式长 token，请在模组内使用绑定码授权',
    },
    410,
  )
})

/** 旧 token 紧急吊销不受换绑冷却限制；新设备绑定仍按 mod_devices.bound_at 计算冷却。 */
r.post('/token/reset', requireAuth(), async (c) => {
  noStore(c)
  const user = c.get('user')!
  const now = nowIso()
  const result = await c.env.DB.prepare(
    `UPDATE mod_tokens
        SET revoked_at = ?, current_jti = NULL, reset_at = ?
      WHERE sub = ? AND revoked_at IS NULL`,
  )
    .bind(now, now, user.sub)
    .run()
  if (result.meta.changes) {
    await recordAudit(c.env.DB, {
      actor: user.sub,
      action: AUDIT.MOD_TOKEN_RESET,
      target: user.sub,
      detail: { migration: 'device_code' },
    })
  }
  return c.json({ ok: true, message: '旧式 token 已吊销' })
})

export default r
