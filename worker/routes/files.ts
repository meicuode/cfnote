import { Hono } from 'hono'
import { ok, err, trackEvent, getUserLoose } from '../utils'
import { parseFileRefs, buildAfileUrl, afileTailKind, categorizeFile, SIDECAR_SUFFIX } from '../../src/lib/fileRefs'
import type { AppEnv } from '../types'

export const files = new Hono<AppEnv>()

const MAX_SIZE = 10 * 1024 * 1024 // 10MB

const NO_BUCKET_MSG = '未配置附件存储：请在 Cloudflare Dashboard 开通 R2 并创建名为 cfnote-files 的桶，然后重新部署'

// 从文章 Markdown 中提取当前用户的旧式附件 key(/api/files/u{id}/<rand>/<name>)
export function extractFileKeys(content: string, userId: number): string[] {
  return parseFileRefs(content, userId).keys
}

// ---- 引用索引与访问分级(P8.1,见 docs/file-manager.md)----

/**
 * 文章保存后同步其附件引用索引(article_files)。内容是唯一事实源,索引仅派生:
 * 旧式链接直接得 key,新式 afile 链接查 files 表换 key,原子替换该文章的关联行。
 * 失败静默——下次保存自愈,不影响笔记保存本身。
 */
export async function syncArticleFiles(env: AppEnv['Bindings'], userId: number, articleId: number, content: string): Promise<void> {
  try {
    const { keys, ids } = parseFileRefs(content || '', userId)
    const all = new Set(keys)
    if (ids.length > 0) {
      const { results } = await env.DB.prepare(
        `SELECT key FROM files WHERE id IN (${ids.map(() => '?').join(',')}) AND user_id = ?`
      ).bind(...ids, userId).all<{ key: string }>()
      for (const r of results || []) all.add(r.key)
    }
    const stmts = [env.DB.prepare('DELETE FROM article_files WHERE article_id = ?').bind(articleId)]
    for (const k of all) {
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO article_files (article_id, file_key) VALUES (?, ?)').bind(articleId, k))
    }
    await env.DB.batch(stmts)
  } catch { /* 静默 */ }
}

/**
 * 免登录可访问判定:key 被任一「公开且非私有」文章引用即放行。
 * 索引查不到时兜底直查公开文章内容(存量文章在下一次保存前索引可能缺行;
 * 公开文章数量小,instr 全扫可接受,并兼容 URL 编码形态的中文文件名)。
 */
export async function isPubliclyReferenced(env: AppEnv['Bindings'], key: string): Promise<boolean> {
  try {
    const hit = await env.DB.prepare(
      `SELECT 1 FROM article_files af JOIN articles a ON a.id = af.article_id
       WHERE af.file_key = ? AND a.is_public = 1 AND a.is_private = 0 LIMIT 1`
    ).bind(key).first()
    if (hit) return true
    const encoded = key.split('/').map(encodeURIComponent).join('/')
    const like = await env.DB.prepare(
      `SELECT 1 FROM articles WHERE is_public = 1 AND is_private = 0
       AND (instr(content, ?) > 0 OR instr(content, ?) > 0) LIMIT 1`
    ).bind(key, encoded).first()
    return !!like
  } catch {
    return false
  }
}

/**
 * 删除文章(或整本笔记本)时的引用计数清理:先删这些文章的索引行,
 * 引用归零且未被收入文件管理目录(folder_id 为空)的附件,连同边车缩略图一起清 R2。
 * 修复旧行为的两个问题:共用附件被误删、xmind 边车缩略图残留。
 */
export async function purgeUnreferencedAttachments(
  env: AppEnv['Bindings'], userId: number, articleIds: number[], contents: string[],
): Promise<void> {
  try {
    const candidates = new Set<string>()
    for (const ct of contents) {
      for (const k of parseFileRefs(ct || '', userId).keys) candidates.add(k)
    }
    if (articleIds.length > 0) {
      const ph = articleIds.map(() => '?').join(',')
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT file_key FROM article_files WHERE article_id IN (${ph})`
      ).bind(...articleIds).all<{ file_key: string }>()
      for (const r of results || []) candidates.add(r.file_key)
      await env.DB.prepare(`DELETE FROM article_files WHERE article_id IN (${ph})`).bind(...articleIds).run()
    }
    if (candidates.size === 0) return

    const toDelete: string[] = []
    for (const key of candidates) {
      const stillRef = await env.DB.prepare('SELECT 1 FROM article_files WHERE file_key = ? LIMIT 1').bind(key).first()
      if (stillRef) continue
      const row = await env.DB.prepare('SELECT id, folder_id FROM files WHERE key = ?').bind(key).first<{ id: number; folder_id: number | null }>()
      if (row && row.folder_id != null) continue // 已收入文件管理目录:视为独立资产,不随文清理
      toDelete.push(key, key + SIDECAR_SUFFIX)
      if (row) await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(row.id).run()
    }
    if (env.BUCKET) {
      for (let i = 0; i < toDelete.length; i += 500) {
        try { await env.BUCKET.delete(toDelete.slice(i, i + 500)) } catch { /* 静默:残留只占容量 */ }
      }
    }
  } catch { /* 静默 */ }
}

// ---- 上传与旧式(按 key)读写 ----

// POST /api/files - 上传附件。请求体为文件原始字节,x-filename 头传 URL 编码的文件名,
// x-folder-id 头可选(文件管理页上传时落到指定目录)。
// 上传即登记 files 表,返回新式间接链接 /api/afile/<id>/<名>(不暴露真实 key);
// 登记失败时退回旧式直链,功能不受影响。
files.post('/', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const filename = decodeURIComponent(c.req.header('x-filename') || 'file')
    const contentType = c.req.header('content-type') || 'application/octet-stream'
    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) return err('文件为空')
    if (body.byteLength > MAX_SIZE) return err('文件超过 10MB 限制')

    let folderId: number | null = null
    const folderHeader = Number(c.req.header('x-folder-id') || '')
    if (Number.isInteger(folderHeader) && folderHeader > 0) {
      const fd = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
        .bind(folderHeader, user.id).first().catch(() => null)
      if (fd) folderId = folderHeader
    }

    const rand = crypto.randomUUID().replace(/-/g, '')
    const safeName = filename.replace(/[^\w.\-一-龥]/g, '_').slice(-80) || 'file'
    const key = `u${user.id}/${rand}/${safeName}`
    await c.env.BUCKET.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { created: new Date().toISOString() },
    })

    let fileId: number | null = null
    try {
      const r = await c.env.DB.prepare(
        'INSERT INTO files (user_id, key, name, folder_id, size, content_type, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(user.id, key, safeName, folderId, body.byteLength, contentType, categorizeFile(safeName, contentType)).run()
      fileId = r.meta.last_row_id as number
    } catch { /* 表未就绪等:退回旧式直链 */ }

    trackEvent(c.env, 'upload', user.id)
    return ok({
      key,
      id: fileId,
      url: fileId ? buildAfileUrl(fileId, safeName) : `/api/files/${key}`,
      name: filename,
      size: body.byteLength,
      content_type: contentType,
    })
  } catch (e: any) {
    return err('上传失败: ' + e.message, 500)
  }
})

// PUT /api/files/* - 按指定 key 写入附件:覆盖已有文件(旧式 xmind 链接的编辑回存),或按原 key 恢复(ZIP 备份导入)。
// 仅允许操作属于当前用户前缀(u{id}/)的 key;非边车对象同步登记/更新 files 表。
files.put('/*', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''))
    if (!key.startsWith(`u${user.id}/`)) return err('无权修改该文件', 403)

    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) return err('文件为空')
    if (body.byteLength > MAX_SIZE) return err('文件超过 10MB 限制')

    const existing = await c.env.BUCKET.head(key)
    const contentType = c.req.header('content-type') || existing?.httpMetadata?.contentType || 'application/octet-stream'
    // 覆盖写入时保留首次上传时间(创建时间);全新 key 则记为现在
    const created = existing?.customMetadata?.created || new Date().toISOString()
    await c.env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: { created } })

    if (!key.endsWith(SIDECAR_SUFFIX)) {
      const name = key.split('/').pop() || 'file'
      try {
        await c.env.DB.prepare(
          `INSERT INTO files (user_id, key, name, size, content_type, category) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, updated_at = datetime('now')`
        ).bind(user.id, key, name, body.byteLength, contentType, categorizeFile(name, contentType)).run()
      } catch { /* 静默 */ }
    }
    return ok({ key, size: body.byteLength })
  } catch (e: any) {
    return err('保存失败: ' + e.message, 500)
  }
})

// 免登录读取的访问分级:登录态(头或 cookie)放行;否则仅「被公开文章引用」的附件可读,
// 边车缩略图随主文件的可见性。不满足一律 404(不区分"不存在/无权",避免探测)。
async function gateRead(c: any, key: string): Promise<Response | null> {
  const user = await getUserLoose(c.req.raw, c.env)
  if (user) return null
  const mainKey = key.endsWith(SIDECAR_SUFFIX) ? key.slice(0, -SIDECAR_SUFFIX.length) : key
  if (await isPubliclyReferenced(c.env, mainKey)) return null
  return err('文件不存在', 404)
}

// HEAD /api/files/* - 查询附件元信息(供前端展示文件大小,不传输内容)
files.on('HEAD', '/*', async (c) => {
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''))
    if (!key) return err('文件不存在', 404)
    const denied = await gateRead(c, key)
    if (denied) return denied
    const obj = await c.env.BUCKET.head(key)
    if (!obj) return err('文件不存在', 404)
    return headResponse(obj)
  } catch (e: any) {
    return err('查询失败: ' + e.message, 500)
  }
})

// GET /api/files/* - 下载附件(强缓存,内容不可变)
files.get('/*', async (c) => {
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  try {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''))
    if (!key) return err('文件不存在', 404)
    const denied = await gateRead(c, key)
    if (denied) return denied
    const obj = await c.env.BUCKET.get(key)
    if (!obj) return err('文件不存在', 404)
    return getResponse(obj)
  } catch (e: any) {
    return err('下载失败: ' + e.message, 500)
  }
})

function headResponse(obj: R2Object): Response {
  const headers = new Headers()
  obj.writeHttpMetadata(headers as any)
  headers.set('Content-Length', String(obj.size))
  headers.set('Last-Modified', obj.uploaded.toUTCString())
  if (obj.customMetadata?.created) headers.set('x-created', obj.customMetadata.created)
  // 元信息随覆盖保存变化(大小/修改时间),只做短缓存,与 GET 的 immutable 不同
  headers.set('Cache-Control', 'public, max-age=60')
  headers.set('etag', obj.httpEtag)
  return new Response(null, { headers })
}

function getResponse(obj: R2ObjectBody): Response {
  const headers = new Headers()
  obj.writeHttpMetadata(headers as any)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('etag', obj.httpEtag)
  return new Response(obj.body as any, { headers })
}

// ---- 新式间接路由 /api/afile/:id/:tail? ----
// 真实 key 只存 files 表;尾巴用于区分主文件/边车缩略图(<链接>.thumb.png),其余内容忽略。

export const afile = new Hono<AppEnv>()

async function resolveAfile(c: any): Promise<{ fileRow: { id: number; user_id: number; key: string; name: string }; key: string } | Response> {
  if (!c.env.BUCKET) return err(NO_BUCKET_MSG, 501)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('文件不存在', 404)
  const fileRow = (await c.env.DB.prepare('SELECT id, user_id, key, name FROM files WHERE id = ?')
    .bind(id).first()) as { id: number; user_id: number; key: string; name: string } | null
  if (!fileRow) return err('文件不存在', 404)
  let tail = c.req.param('tail') || ''
  try { tail = decodeURIComponent(tail) } catch { /* 保持原样 */ }
  const key = afileTailKind(tail, fileRow.name) === 'sidecar' ? fileRow.key + SIDECAR_SUFFIX : fileRow.key
  return { fileRow, key }
}

afile.get('/:id/:tail?', async (c) => {
  try {
    const r = await resolveAfile(c)
    if (r instanceof Response) return r
    const user = await getUserLoose(c.req.raw, c.env)
    if (!user && !(await isPubliclyReferenced(c.env, r.fileRow.key))) return err('文件不存在', 404)
    const obj = await c.env.BUCKET!.get(r.key)
    if (!obj) return err('文件不存在', 404)
    return getResponse(obj)
  } catch (e: any) {
    return err('下载失败: ' + e.message, 500)
  }
})

afile.on('HEAD', '/:id/:tail?', async (c) => {
  try {
    const r = await resolveAfile(c)
    if (r instanceof Response) return r
    const user = await getUserLoose(c.req.raw, c.env)
    if (!user && !(await isPubliclyReferenced(c.env, r.fileRow.key))) return err('文件不存在', 404)
    const obj = await c.env.BUCKET!.head(r.key)
    if (!obj) return err('文件不存在', 404)
    return headResponse(obj)
  } catch (e: any) {
    return err('查询失败: ' + e.message, 500)
  }
})

// PUT /api/afile/:id/:tail? - 覆盖写回(新式 xmind 链接的编辑保存与边车缩略图上传)。
// 走全局鉴权中间件(afile 仅 GET/HEAD 免登录),再校验属主。
afile.put('/:id/:tail?', async (c) => {
  const user = c.get('user')
  try {
    const r = await resolveAfile(c)
    if (r instanceof Response) return r
    if (r.fileRow.user_id !== user.id) return err('无权修改该文件', 403)

    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) return err('文件为空')
    if (body.byteLength > MAX_SIZE) return err('文件超过 10MB 限制')

    const existing = await c.env.BUCKET!.head(r.key)
    const contentType = c.req.header('content-type') || existing?.httpMetadata?.contentType || 'application/octet-stream'
    const created = existing?.customMetadata?.created || new Date().toISOString()
    await c.env.BUCKET!.put(r.key, body, { httpMetadata: { contentType }, customMetadata: { created } })

    if (r.key === r.fileRow.key) {
      try {
        await c.env.DB.prepare("UPDATE files SET size = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(body.byteLength, r.fileRow.id).run()
      } catch { /* 静默 */ }
    }
    return ok({ key: r.key, size: body.byteLength })
  } catch (e: any) {
    return err('保存失败: ' + e.message, 500)
  }
})
