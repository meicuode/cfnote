import { Hono } from 'hono'
import { ok, err, trackEvent } from '../utils'
import type { AppEnv } from '../types'

export const files = new Hono<AppEnv>()

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

const NO_BUCKET_MSG = '未配置附件存储：请在 Cloudflare Dashboard 开通 R2 并创建名为 cfnote-files 的桶，然后重新部署'

// POST /api/files - 上传附件。请求体为文件原始字节,x-filename 头传 URL 编码的文件名。
// key 含 32 位随机段(不可猜测),因此下载接口可免登录访问(用于 <img> 直接引用)。
files.post('/', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const filename = decodeURIComponent(c.req.header('x-filename') || 'file')
    const contentType = c.req.header('content-type') || 'application/octet-stream'
    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) return err('文件为空')
    if (body.byteLength > MAX_SIZE) return err('文件超过 10MB 限制')

    const rand = crypto.randomUUID().replace(/-/g, '')
    const safeName = filename.replace(/[^\w.\-一-龥]/g, '_').slice(-80) || 'file'
    const key = `u${user.id}/${rand}/${safeName}`
    await c.env.BUCKET.put(key, body, { httpMetadata: { contentType } })

    trackEvent(c.env, 'upload', user.id)
    return ok({
      key,
      url: `/api/files/${key}`,
      name: filename,
      size: body.byteLength,
      content_type: contentType,
    })
  } catch (e: any) {
    return err('上传失败: ' + e.message, 500)
  }
})

// PUT /api/files/* - 原地覆盖已有附件(XMind 在线编辑回存用)。仅允许覆盖属于当前用户的 key。
files.put('/*', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''))
    if (!key.startsWith(`u${user.id}/`)) return err('无权修改该文件', 403)
    const existing = await c.env.BUCKET.head(key)
    if (!existing) return err('文件不存在', 404)

    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) return err('文件为空')
    if (body.byteLength > MAX_SIZE) return err('文件超过 10MB 限制')

    const contentType = c.req.header('content-type') || existing.httpMetadata?.contentType || 'application/octet-stream'
    await c.env.BUCKET.put(key, body, { httpMetadata: { contentType } })
    return ok({ key, size: body.byteLength })
  } catch (e: any) {
    return err('保存失败: ' + e.message, 500)
  }
})

// GET /api/files/* - 下载附件(免登录,靠 key 中的随机段保护;强缓存,内容不可变)
files.get('/*', async (c) => {
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''))
    if (!key) return err('文件不存在', 404)
    const obj = await c.env.BUCKET.get(key)
    if (!obj) return err('文件不存在', 404)

    const headers = new Headers()
    obj.writeHttpMetadata(headers as any)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('etag', obj.httpEtag)
    return new Response(obj.body as any, { headers })
  } catch (e: any) {
    return err('下载失败: ' + e.message, 500)
  }
})
