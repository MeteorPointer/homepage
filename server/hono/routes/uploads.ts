// R2 对象读取。
//
// 采用**白名单**而非黑名单（设计条目 W5）：只有明确列出的路径可以公开访问，
// 其余一律 403。旧实现是黑名单（只拦 workshop/*/nbt/），新增一种结构文件
// 格式或换个子目录就会漏出去。
import { Hono } from 'hono'
import type { AppBindings } from '../types'
import { edgeCache } from '../lib/cache'
import { CAPS, hasPerm, resolveUser } from '../lib/rbac'

// 挂在 /uploads 而非 /api 下：R2 对象的 URL 直接对外，路径要稳定好看
const r = new Hono<AppBindings>().basePath('/uploads')

/** 可公开访问的 key 形态 */
const PUBLIC_PATTERNS = [
  /^uploads\/workshop\/[^/]+\/images\/[^/]+$/,
  /^uploads\/developers\/[^/]+\/[^/]+$/,
  /^uploads\/site\/[^/]+$/,
]

function isPublic(key: string): boolean {
  return PUBLIC_PATTERNS.some((re) => re.test(key))
}

const WORKSHOP_IMAGE = /^uploads\/workshop\/([^/]+)\/images\/[^/]+$/
type WorkshopImageAccess = 'public' | 'private' | 'denied'

/** 待审核作品的图片只能由作者或审核员访问，且不得读取公开边缘缓存。 */
async function workshopImageAccess(
  c: Parameters<typeof resolveUser>[0],
  key: string,
): Promise<WorkshopImageAccess> {
  const matched = key.match(WORKSHOP_IMAGE)
  if (!matched) return 'public'

  const row = await c.env.DB.prepare('SELECT status, author_sub FROM workshop_items WHERE id = ?')
    .bind(matched[1])
    .first<{ status: string; author_sub: string | null }>()
  if (!row) return 'denied'
  if (row.status === 'published') return 'public'

  const user = await resolveUser(c)
  return user && (user.sub === row.author_sub || hasPerm(user, CAPS.WORKSHOP_REVIEW))
    ? 'private'
    : 'denied'
}

r.get('/*', async (c) => {
  const path = new URL(c.req.url).pathname
  // 逐段 decode 后再判定：先判定后 decode 会被 %2e%2e 之类绕过
  const key = path
    .replace(/^\/+/, '')
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .join('/')

  if (!key.startsWith('uploads/') || key.includes('..')) return c.notFound()

  if (!isPublic(key)) {
    // 结构文件只能在站内预览，下载请走作品的站外链接
    return c.json(
      { ok: false, code: 'NOT_PUBLIC', error: '该文件不提供直接下载，请使用作品页的站外链接' },
      403,
    )
  }

  // 必须在读取边缘缓存前校验发布状态，撤回作品不能继续命中旧缓存。
  const access = await workshopImageAccess(c, key)
  if (access === 'denied') return c.notFound()
  const cacheable = access === 'public'

  const cache = edgeCache()
  const cached = cacheable ? await cache?.match(c.req.raw) : undefined
  if (cached) return cached

  const obj = await c.env.R2.get(key)
  if (!obj) return c.notFound()

  const headers = new Headers()
  headers.set('Content-Type', obj.httpMetadata?.contentType ?? 'application/octet-stream')
  headers.set('Cache-Control', cacheable ? 'public, max-age=86400' : 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag)

  const res = new Response(obj.body, { headers })
  if (cacheable && cache) c.executionCtx?.waitUntil(cache.put(c.req.raw, res.clone()))
  return res
})

export default r
