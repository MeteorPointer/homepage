// 管理后台。
//
// 注意这里**没有任何修改用户角色的端点**：角色由 Prism 团队身份组派生
// （设计条目 C6），要调整某人的权限得去 Prism 的团队页面操作。
// 官网若也能改，两边就会各有一份真相，迟早不一致。
import { Hono } from 'hono'
import type { AppBindings } from '../types'
import { requireCap } from '../lib/rbac'
import { CAPS } from '../lib/roles'
import { getConfig, nowIso, parseJson, parsePaging } from '../lib/db'
import { AUDIT, recordAudit } from '../lib/audit'
import type { Developer, ExternalMod } from '../../../shared/types'

const r = new Hono<AppBindings>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** 运营内容中的站外资源只接受 HTTPS，避免把 javascript: 等协议交给前端。 */
function readHttpsUrl(value: unknown): string | null {
  const url = readText(value, 2048)
  if (!url) return ''
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function readImageUrl(value: unknown): string | null {
  const url = readText(value, 2048)
  if (url.startsWith('/uploads/developers/')) return url
  return readHttpsUrl(url)
}

function parseExternalMod(value: unknown): { data?: Omit<ExternalMod, 'id'>; error?: string } {
  if (!isRecord(value)) return { error: '请求体必须是 JSON 对象' }
  const name = readText(value.name, 120)
  const description = readText(value.description, 1000)
  const url = readHttpsUrl(value.url)
  const author = readText(value.author, 120)
  const icon = readImageUrl(value.icon)
  if (!name) return { error: '名称不能为空' }
  if (!url) return { error: '链接必须是有效的 HTTPS 地址' }
  if (icon === null) return { error: '图标必须是有效的 HTTPS 地址或本站开发者图片路径' }
  return {
    data: { name, description, url, ...(author ? { author } : {}), ...(icon ? { icon } : {}) },
  }
}

function parseDeveloper(value: unknown): { data?: Omit<Developer, 'slug'>; error?: string } {
  if (!isRecord(value)) return { error: '请求体必须是 JSON 对象' }
  const name = readText(value.name, 120)
  const role = readText(value.role, 120)
  const avatar = readImageUrl(value.avatar)
  const intro = readText(value.intro, 1000)
  const cover = readImageUrl(value.cover)
  const body = readText(value.body, 8000)
  const rawLinks = value.links
  if (!name) return { error: '名称不能为空' }
  if (avatar === null || cover === null) return { error: '头像和封面必须是有效的 HTTPS 地址或本站开发者图片路径' }
  if (rawLinks !== undefined && !Array.isArray(rawLinks)) return { error: 'links 必须是数组' }
  if (Array.isArray(rawLinks) && rawLinks.length > 12) return { error: '链接最多 12 条' }
  const links: { label: string; url: string }[] = []
  for (const link of rawLinks ?? []) {
    if (!isRecord(link)) return { error: '链接格式无效' }
    const label = readText(link.label, 80)
    const url = readHttpsUrl(link.url)
    if (!label || !url) return { error: '每条链接都需要名称和有效的 HTTPS 地址' }
    links.push({ label, url })
  }
  return {
    data: {
      name,
      role,
      avatar: avatar ?? '',
      intro,
      ...(cover ? { cover } : {}),
      ...(links.length ? { links } : {}),
      ...(body ? { body } : {}),
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 反馈处理
// ─────────────────────────────────────────────────────────────

interface AdminFeedbackRow {
  id: string
  author_sub: string | null
  category: string
  title: string
  content: string
  contact: string
  status: string
  reply: string
  handled_by: string | null
  created_at: string
  handled_at: string | null
  author_name: string | null
}

r.get('/feedback', requireCap(CAPS.FEEDBACK_MANAGE), async (c) => {
  const { limit, offset } = parsePaging(c.req.query())
  const status = c.req.query('status')?.trim() ?? ''

  const where = status ? 'WHERE f.status = ?' : ''
  const binds: unknown[] = status ? [status] : []

  const { results } = await c.env.DB.prepare(
    `SELECT f.*, u.display_name AS author_name
       FROM feedback f LEFT JOIN users u ON u.sub = f.author_sub
       ${where}
      ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<AdminFeedbackRow>()

  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM feedback f ${where}`)
    .bind(...binds)
    .first<{ n: number }>()

  return c.json({
    ok: true,
    total: total?.n ?? 0,
    items: results.map((f) => ({
      id: f.id,
      category: f.category,
      title: f.title,
      content: f.content,
      contact: f.contact,
      status: f.status,
      reply: f.reply,
      // 作者可能已在 Prism 侧注销，档案行还在但没有名字
      authorName: f.author_name ?? '已注销用户',
      createdAt: f.created_at,
      handledAt: f.handled_at,
    })),
  })
})

r.patch('/feedback/:id', requireCap(CAPS.FEEDBACK_MANAGE), async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const body = await c.req
    .json<{ status?: string; reply?: string }>()
    .catch((): { status?: string; reply?: string } => ({}))

  const status = String(body.status ?? '').trim()
  if (!['open', 'resolved', 'rejected'].includes(status)) {
    return c.json({ ok: false, error: '无效的状态' }, 400)
  }

  const result = await c.env.DB.prepare(
    `UPDATE feedback SET status = ?, reply = ?, handled_by = ?, handled_at = ? WHERE id = ?`,
  )
    .bind(status, String(body.reply ?? '').slice(0, 1000), user.sub, nowIso(), id)
    .run()

  if (!result.meta.changes) return c.json({ ok: false, error: '反馈不存在' }, 404)

  await recordAudit(c.env.DB, {
    actor: user.sub,
    action: AUDIT.FEEDBACK_HANDLE,
    target: id,
    detail: { status },
  })
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────
// 工坊审核
// ─────────────────────────────────────────────────────────────

r.get('/workshop', requireCap(CAPS.WORKSHOP_REVIEW), async (c) => {
  const { limit, offset } = parsePaging(c.req.query())
  const status = c.req.query('status')?.trim() || 'pending'

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, category, description, external_links, author_display_name,
            status, review_reason, created_at
       FROM workshop_items WHERE status = ?
      ORDER BY created_at ASC LIMIT ? OFFSET ?`,
  )
    .bind(status, limit, offset)
    .all<{
      id: string
      title: string
      category: string
      description: string
      external_links: string
      author_display_name: string
      status: string
      review_reason: string
      created_at: string
    }>()

  return c.json({
    ok: true,
    items: results.map((w) => ({
      id: w.id,
      title: w.title,
      category: w.category,
      description: w.description,
      // 审核时要人工核对外链与上传文件是否一致，所以这里必须给出链接
      externalLinks: parseJson(w.external_links, [], `workshop.${w.id}.links`),
      authorName: w.author_display_name,
      status: w.status,
      reviewReason: w.review_reason,
      createdAt: w.created_at,
    })),
  })
})

/**
 * 审核员下载投稿的结构文件（设计条目 W7）。
 *
 * 这是站内唯一能取到结构文件本体的入口 —— 公开的 /uploads 白名单不含它。
 * 目的是核对「上传的文件」与「站外链接里的文件」是否一致，因此每次下载
 * 都写审计。
 */
r.get('/workshop/:id/file/:index', requireCap(CAPS.WORKSHOP_REVIEW), async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id') ?? ''
  const index = Number(c.req.param('index') ?? -1)

  const row = await c.env.DB.prepare('SELECT files FROM workshop_items WHERE id = ?')
    .bind(id)
    .first<{ files: string }>()
  if (!row) return c.json({ ok: false, error: '作品不存在' }, 404)

  const files = parseJson<{ items?: { name: string; kind: string; key?: string }[] }>(
    row.files,
    {},
    `workshop.${id}.files`,
  )
  const target = files.items?.[index]
  if (!target?.key) return c.json({ ok: false, error: '文件不存在' }, 404)

  const obj = await c.env.R2.get(target.key)
  if (!obj) return c.json({ ok: false, error: '文件已丢失' }, 404)

  await recordAudit(c.env.DB, {
    actor: user.sub,
    action: 'workshop.file.download',
    target: id,
    detail: { name: target.name },
  })

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(target.name)}"`,
      'Cache-Control': 'no-store',
    },
  })
})

r.patch('/workshop/:id', requireCap(CAPS.WORKSHOP_REVIEW), async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const body = await c.req
    .json<{ status?: string; reason?: string }>()
    .catch((): { status?: string; reason?: string } => ({}))

  const status = String(body.status ?? '').trim()
  if (!['published', 'rejected', 'pending'].includes(status)) {
    return c.json({ ok: false, error: '无效的状态' }, 400)
  }

  const now = nowIso()
  const result = await c.env.DB.prepare(
    `UPDATE workshop_items
        SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?,
            published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN ? ELSE published_at END
      WHERE id = ?`,
  )
    .bind(status, String(body.reason ?? '').slice(0, 500), user.sub, now, now, status, now, id)
    .run()

  if (!result.meta.changes) return c.json({ ok: false, error: '作品不存在' }, 404)

  await recordAudit(c.env.DB, {
    actor: user.sub,
    action: AUDIT.WORKSHOP_REVIEW,
    target: id,
    detail: { status, reason: body.reason ?? '' },
  })
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────
// 更新日志
// ─────────────────────────────────────────────────────────────

r.post('/changelog', requireCap(CAPS.CHANGELOG_MANAGE), async (c) => {
  const user = c.get('user')!
  const body = await c.req
    .json<{ version?: string; title?: string; body?: string; publishedAt?: string }>()
    .catch(() => ({}) as Record<string, string>)

  const version = String(body.version ?? '').trim().slice(0, 32)
  const title = String(body.title ?? '').trim().slice(0, 120)
  if (!version || !title) return c.json({ ok: false, error: '版本号与标题不能为空' }, 400)

  const id = crypto.randomUUID()
  const now = nowIso()
  await c.env.DB.prepare(
    'INSERT INTO changelog (id, version, title, body, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, version, title, String(body.body ?? '').slice(0, 5000), body.publishedAt || now, now)
    .run()

  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.CHANGELOG_CREATE, target: id })
  return c.json({ ok: true, id })
})

r.delete('/changelog/:id', requireCap(CAPS.CHANGELOG_MANAGE), async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const result = await c.env.DB.prepare('DELETE FROM changelog WHERE id = ?').bind(id).run()
  if (!result.meta.changes) return c.json({ ok: false, error: '记录不存在' }, 404)

  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.CHANGELOG_DELETE, target: id })
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────
// 首页特色模组与开发者资料
// ─────────────────────────────────────────────────────────────

r.get('/external-mods', requireCap(CAPS.MODS_MANAGE), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, data FROM external_mods ORDER BY id').all<{
    id: string
    data: string
  }>()
  const mods = results.flatMap((row) => {
    const parsed = parseExternalMod(parseJson<unknown>(row.data, null, `external_mods.${row.id}`))
    return parsed.data ? [{ id: row.id, ...parsed.data }] : []
  })
  return c.json({ ok: true, mods })
})

r.post('/external-mods', requireCap(CAPS.MODS_MANAGE), async (c) => {
  const user = c.get('user')!
  const parsed = parseExternalMod(await c.req.json<unknown>().catch(() => null))
  if (!parsed.data) return c.json({ ok: false, error: parsed.error }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO external_mods (id, data) VALUES (?, ?)')
    .bind(id, JSON.stringify(parsed.data))
    .run()
  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.EXTERNAL_MOD_CREATE, target: id, detail: { name: parsed.data.name } })
  return c.json({ ok: true, id }, 201)
})

r.put('/external-mods/:id', requireCap(CAPS.MODS_MANAGE), async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id') ?? ''
  const parsed = parseExternalMod(await c.req.json<unknown>().catch(() => null))
  if (!parsed.data) return c.json({ ok: false, error: parsed.error }, 400)
  const result = await c.env.DB.prepare('UPDATE external_mods SET data = ? WHERE id = ?')
    .bind(JSON.stringify(parsed.data), id)
    .run()
  if (!result.meta.changes) return c.json({ ok: false, error: '特色模组不存在' }, 404)
  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.EXTERNAL_MOD_UPDATE, target: id, detail: { name: parsed.data.name } })
  return c.json({ ok: true })
})

r.delete('/external-mods/:id', requireCap(CAPS.MODS_MANAGE), async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id') ?? ''
  const result = await c.env.DB.prepare('DELETE FROM external_mods WHERE id = ?').bind(id).run()
  if (!result.meta.changes) return c.json({ ok: false, error: '特色模组不存在' }, 404)
  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.EXTERNAL_MOD_DELETE, target: id })
  return c.json({ ok: true })
})

r.get('/developers', requireCap(CAPS.DEVELOPERS_MANAGE), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT slug, data FROM developers ORDER BY slug').all<{
    slug: string
    data: string
  }>()
  const developers = results.flatMap((row) => {
    const parsed = parseDeveloper(parseJson<unknown>(row.data, null, `developers.${row.slug}`))
    return parsed.data ? [{ slug: row.slug, ...parsed.data }] : []
  })
  return c.json({ ok: true, developers })
})

r.put('/developers/:slug', requireCap(CAPS.DEVELOPERS_MANAGE), async (c) => {
  const user = c.get('user')!
  const slug = (c.req.param('slug') ?? '').trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    return c.json({ ok: false, error: 'slug 只能包含小写字母、数字和连字符，且不能以连字符开头或结尾' }, 400)
  }
  const parsed = parseDeveloper(await c.req.json<unknown>().catch(() => null))
  if (!parsed.data) return c.json({ ok: false, error: parsed.error }, 400)
  await c.env.DB.prepare(
    `INSERT INTO developers (slug, data) VALUES (?, ?)
     ON CONFLICT(slug) DO UPDATE SET data = excluded.data`,
  ).bind(slug, JSON.stringify(parsed.data)).run()
  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.DEVELOPER_UPSERT, target: slug, detail: { name: parsed.data.name } })
  return c.json({ ok: true, slug })
})

r.delete('/developers/:slug', requireCap(CAPS.DEVELOPERS_MANAGE), async (c) => {
  const user = c.get('user')!
  const slug = c.req.param('slug') ?? ''
  const result = await c.env.DB.prepare('DELETE FROM developers WHERE slug = ?').bind(slug).run()
  if (!result.meta.changes) return c.json({ ok: false, error: '开发者不存在' }, 404)
  await recordAudit(c.env.DB, { actor: user.sub, action: AUDIT.DEVELOPER_DELETE, target: slug })
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────
// 站点配置（公告等运行期可调参数）
// ─────────────────────────────────────────────────────────────

/** 允许后台改的键。白名单而非黑名单：新增配置项默认不可从后台改 */
const EDITABLE_CONFIG = new Set([
  'announcements',
  'license_ttl_hours',
  'rebind_cooldown_hours',
  'offline_grace_days',
])

/** 防止后台误填负数或字符串，直接让新签发的 License 失效。 */
function validateEditableConfig(key: string, value: unknown): { value?: unknown; error?: string } {
  if (key === 'announcements') {
    if (!Array.isArray(value) || value.length > 20) return { error: '公告必须是最多 20 条的数组' }
    const announcements: { id: string; title: string; body: string; level: string; publishedAt: string }[] = []
    for (const item of value) {
      if (!isRecord(item)) return { error: '公告格式无效' }
      const id = readText(item.id, 80)
      const title = readText(item.title, 160)
      const body = readText(item.body, 2000)
      const level = readText(item.level, 16)
      const publishedAt = readText(item.publishedAt, 64)
      if (!id || !title || !body || !['info', 'warning', 'important'].includes(level) || !publishedAt || Number.isNaN(Date.parse(publishedAt))) {
        return { error: '公告缺少必要字段或级别、发布时间无效' }
      }
      announcements.push({ id, title, body, level, publishedAt })
    }
    return { value: announcements }
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return { error: '配置值必须是整数' }
  const ranges: Record<string, [number, number]> = {
    license_ttl_hours: [1, 24 * 31],
    rebind_cooldown_hours: [1, 24 * 30],
    offline_grace_days: [0, 30],
  }
  const range = ranges[key]
  if (!range || value < range[0] || value > range[1]) return { error: '配置值超出允许范围' }
  return { value }
}

r.get('/config', requireCap(CAPS.SITE_CONFIGURE), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value FROM site_config').all<{
    key: string
    value: string
  }>()
  return c.json({
    ok: true,
    config: Object.fromEntries(
      results
        .filter((row) => EDITABLE_CONFIG.has(row.key))
        .map((row) => [row.key, parseJson<unknown>(row.value, null, `site_config.${row.key}`)]),
    ),
  })
})

r.put('/config/:key', requireCap(CAPS.SITE_CONFIGURE), async (c) => {
  const user = c.get('user')!
  const key = c.req.param('key') ?? ''
  if (!EDITABLE_CONFIG.has(key)) return c.json({ ok: false, error: '该配置项不可修改' }, 400)

  const body = await c.req.json<{ value?: unknown }>().catch(() => ({}) as { value?: unknown })
  if (body.value === undefined) return c.json({ ok: false, error: '缺少 value' }, 400)
  const validated = validateEditableConfig(key, body.value)
  if (validated.value === undefined) return c.json({ ok: false, error: validated.error }, 400)

  await c.env.DB.prepare('INSERT OR REPLACE INTO site_config (key, value) VALUES (?, ?)')
    .bind(key, JSON.stringify(validated.value))
    .run()

  await recordAudit(c.env.DB, {
    actor: user.sub,
    action: AUDIT.SITE_CONFIG_UPDATE,
    target: key,
    detail: validated.value,
  })
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────
// 审计与用户（只读）
// ─────────────────────────────────────────────────────────────

r.get('/audit', requireCap(CAPS.AUDIT_VIEW), async (c) => {
  const { limit, offset } = parsePaging(c.req.query(), 100)
  const action = c.req.query('action')?.trim() ?? ''

  const where = action ? 'WHERE action LIKE ?' : ''
  const binds: unknown[] = action ? [`${action}%`] : []

  const { results } = await c.env.DB.prepare(
    `SELECT id, actor, action, target, detail, created_at FROM audit_log ${where}
      ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<{
      id: number
      actor: string | null
      action: string
      target: string | null
      detail: string | null
      created_at: string
    }>()

  return c.json({
    ok: true,
    items: results.map((a) => ({
      id: a.id,
      actor: a.actor,
      action: a.action,
      target: a.target,
      detail: a.detail ? parseJson<unknown>(a.detail, null, 'audit.detail') : null,
      createdAt: a.created_at,
    })),
  })
})

/**
 * 用户列表。**只读** —— 角色在 Prism 侧管理，这里只是让管理员能查到
 * 某人当前是什么身份、什么时候登录过，便于排查问题。
 */
r.get('/users', requireCap(CAPS.AUDIT_VIEW), async (c) => {
  const { limit, offset } = parsePaging(c.req.query())
  const q = c.req.query('q')?.trim() ?? ''

  const where = q ? 'WHERE u.username LIKE ? OR u.display_name LIKE ?' : ''
  const binds: unknown[] = q ? [`%${q}%`, `%${q}%`] : []

  const { results } = await c.env.DB.prepare(
    `SELECT u.sub, u.username, u.display_name, u.role_key, r.level,
            u.last_login_at, u.groups_synced_at, u.deleted_at
       FROM users u JOIN roles r ON r.role_key = u.role_key ${where}
      ORDER BY u.last_login_at DESC NULLS LAST LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<{
      sub: string
      username: string
      display_name: string
      role_key: string
      level: number
      last_login_at: string | null
      groups_synced_at: string | null
      deleted_at: string | null
    }>()

  return c.json({
    ok: true,
    items: results.map((u) => ({
      sub: u.sub,
      username: u.username,
      displayName: u.display_name,
      roleKey: u.role_key,
      level: u.level,
      lastLoginAt: u.last_login_at,
      groupsSyncedAt: u.groups_synced_at,
      deleted: !!u.deleted_at,
    })),
  })
})

/** 后台首页用的概览数字 */
r.get('/stats', requireCap(CAPS.AUDIT_VIEW), async (c) => {
  const [pendingWorkshop, openFeedback, users, licenseTtl] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM workshop_items WHERE status = 'pending'").first<{
      n: number
    }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'").first<{
      n: number
    }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').first<{
      n: number
    }>(),
    getConfig<number>(c.env.DB, 'license_ttl_hours', 24),
  ])

  return c.json({
    ok: true,
    stats: {
      pendingWorkshop: pendingWorkshop?.n ?? 0,
      openFeedback: openFeedback?.n ?? 0,
      users: users?.n ?? 0,
      licenseTtlHours: licenseTtl,
    },
  })
})

export default r
