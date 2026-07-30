import { Hono } from 'hono'
import { ok, err } from '../utils'
import { escapeLike } from './search'
import { syncArticleFiles, getPrivateFolderIds } from './files'
import { parseFileRefs, buildAfileUrl, categorizeFile, SIDECAR_SUFFIX } from '../../src/lib/fileRefs'
import { copyName } from '../../src/lib/fmUtils'
import type { AppEnv } from '../types'

// 文件管理接口(P8,见 docs/file-manager.md):refcheck 为发布前置检查(P8.1),
// overview/files/folders/scan 支撑文件管理页(P8.2),share/私密文件夹为 P8.2 增强批。
// 全部走全局鉴权。
export const fm = new Hono<AppEnv>()

interface FileRow {
  id: number; key: string; name: string; size: number; category: string
  content_type: string | null; folder_id: number | null
  share_token: string | null; share_expires_at: string | null
  created_at: string; updated_at: string
  ref_count?: number; pub_count?: number
}

// 列表/详情共用的展示字段:间接链接 + 预览缩略地址(图片用自身,xmind 用边车)+ 私密归属
function decorate(f: FileRow, privateIds?: Set<number>) {
  const url = buildAfileUrl(f.id, f.name)
  return {
    ...f,
    url,
    thumb: f.category === 'image' ? url : (/\.xmind$/i.test(f.name) ? url + SIDECAR_SUFFIX : null),
    is_private_file: !!(privateIds && f.folder_id != null && privateIds.has(f.folder_id)),
  }
}

// 不变式兜底:私密子树内不允许存在分享。任何文件/文件夹移动后统一执行一次,
// 返回撤销数量(前端据此提示"移入私密文件夹,原分享已取消")。
async function revokePrivateShares(env: AppEnv['Bindings'], userId: number): Promise<number> {
  const priv = await getPrivateFolderIds(env, userId)
  if (priv.size === 0) return 0
  const ids = [...priv]
  const r = await env.DB.prepare(
    `UPDATE files SET share_token = NULL, share_expires_at = NULL
     WHERE user_id = ? AND share_token IS NOT NULL AND folder_id IN (${ids.map(() => '?').join(',')})`
  ).bind(userId, ...ids).run()
  return r.meta.changes || 0
}

// GET /api/fm/overview - 左栏与统计:总量、未引用数、笔记附件按笔记本分组计数、文件夹列表。
// 顺带懒创建「我的私密文件夹」系统根目录(is_private=1,不可改名/移动/删除)。
fm.get('/overview', async (c) => {
  const user = c.get('user')
  try {
    await c.env.DB.prepare(
      `INSERT INTO folders (user_id, name, is_private) SELECT ?, '我的私密文件夹', 1
       WHERE NOT EXISTS (SELECT 1 FROM folders WHERE user_id = ? AND is_private = 1 AND parent_id IS NULL)`
    ).bind(user.id, user.id).run().catch(() => { /* 列未就绪等,下次再建 */ })
    const [stat, unref, nbs, folders] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM files WHERE user_id = ?')
        .bind(user.id).first<{ c: number; s: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM files f WHERE f.user_id = ? AND f.folder_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM article_files af WHERE af.file_key = f.key)`
      ).bind(user.id).first<{ c: number }>(),
      c.env.DB.prepare(
        `SELECT n.id, n.name, n.color, COUNT(DISTINCT f.id) AS file_count
         FROM article_files af
         JOIN articles a ON a.id = af.article_id
         JOIN notebooks n ON n.id = a.notebook_id
         JOIN files f ON f.key = af.file_key
         WHERE n.user_id = ? AND a.deleted_at IS NULL
         GROUP BY n.id, n.name, n.color ORDER BY n.name`
      ).bind(user.id).all(),
      c.env.DB.prepare('SELECT id, name, parent_id, is_private, created_at FROM folders WHERE user_id = ? ORDER BY name')
        .bind(user.id).all(),
    ])
    return ok({
      stats: { count: stat?.c || 0, size: stat?.s || 0 },
      unref_count: unref?.c || 0,
      notebooks: nbs.results || [],
      folders: folders.results || [],
    })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/fm/files?view=all|notebook|folder|unref&notebook=&folder=&category=&q=
// 单用户量级:最多返回 500 条(按更新时间倒序),不做游标分页
fm.get('/files', async (c) => {
  const user = c.get('user')
  try {
    const view = c.req.query('view') || 'all'
    const category = c.req.query('category') || ''
    const q = (c.req.query('q') || '').trim()

    let sql = `SELECT f.id, f.key, f.name, f.size, f.category, f.content_type, f.folder_id,
      f.share_token, f.share_expires_at, f.created_at, f.updated_at,
      (SELECT COUNT(*) FROM article_files af WHERE af.file_key = f.key) AS ref_count,
      (SELECT COUNT(*) FROM article_files af2 JOIN articles a2 ON a2.id = af2.article_id
         WHERE af2.file_key = f.key AND a2.is_public = 1 AND a2.is_private = 0) AS pub_count
      FROM files f WHERE f.user_id = ?`
    const binds: unknown[] = [user.id]

    if (view === 'folder') {
      sql += ' AND f.folder_id = ?'
      binds.push(Number(c.req.query('folder')) || 0)
    } else if (view === 'unref') {
      sql += ' AND f.folder_id IS NULL AND NOT EXISTS (SELECT 1 FROM article_files af3 WHERE af3.file_key = f.key)'
    } else if (view === 'notebook') {
      sql += ` AND EXISTS (SELECT 1 FROM article_files af4 JOIN articles a4 ON a4.id = af4.article_id
               WHERE af4.file_key = f.key AND a4.notebook_id = ? AND a4.deleted_at IS NULL)`
      binds.push(Number(c.req.query('notebook')) || 0)
    }
    if (category === 'image' || category === 'doc' || category === 'other') {
      sql += ' AND f.category = ?'
      binds.push(category)
    }
    if (q) {
      sql += " AND f.name LIKE ? ESCAPE '\\'"
      binds.push(`%${escapeLike(q)}%`)
    }
    sql += ' ORDER BY f.updated_at DESC, f.id DESC LIMIT 500'

    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<FileRow>()
    const priv = await getPrivateFolderIds(c.env, user.id)
    return ok({ files: (results || []).map((f) => decorate(f, priv)) })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/fm/files/:id/refs - 引用该附件的笔记(删除警告/引用清单弹窗共用)
fm.get('/files/:id/refs', async (c) => {
  const user = c.get('user')
  try {
    const f = await c.env.DB.prepare('SELECT key FROM files WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id).first<{ key: string }>()
    if (!f) return err('文件不存在', 404)
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.is_public, a.is_private, a.updated_at, n.name AS notebook
       FROM article_files af
       JOIN articles a ON a.id = af.article_id
       LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE af.file_key = ? AND a.deleted_at IS NULL ORDER BY a.updated_at DESC LIMIT 50`
    ).bind(f.key).all()
    return ok({ refs: results || [] })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// PUT /api/fm/files/:id - 重命名(仅显示名,key 与链接不变)/ 移动目录(folder_id,null 为移出)
fm.put('/files/:id', async (c) => {
  const user = c.get('user')
  try {
    const { name, folder_id } = await c.req.json<{ name?: string; folder_id?: number | null }>()
    const f = await c.env.DB.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id).first<FileRow>()
    if (!f) return err('文件不存在', 404)

    let newName = f.name
    if (name !== undefined) {
      newName = String(name).trim()
      if (!newName) return err('名称不能为空')
    }
    let newFolder = f.folder_id
    if (folder_id !== undefined) {
      if (folder_id === null) {
        newFolder = null
      } else {
        const fd = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
          .bind(folder_id, user.id).first()
        if (!fd) return err('目标文件夹不存在', 404)
        newFolder = folder_id
      }
    }
    await c.env.DB.prepare("UPDATE files SET name = ?, folder_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(newName, newFolder, f.id).run()
    // 移入私密子树 → 撤销分享(不变式:私密文件禁止公开);顺带全量兜底
    const revoked = folder_id !== undefined ? await revokePrivateShares(c.env, user.id) : 0
    const priv = await getPrivateFolderIds(c.env, user.id)
    const after = { ...f, name: newName, folder_id: newFolder }
    if (newFolder != null && priv.has(newFolder)) { after.share_token = null; after.share_expires_at = null }
    return ok({ ...decorate(after, priv), revoked_shares: revoked })
  } catch (e: any) {
    return err('更新失败: ' + e.message, 500)
  }
})

// DELETE /api/fm/files/:id?force=1 - 删除附件(连同边车缩略图与引用索引行);
// 仍被笔记引用时需 force(前端先经 refs 弹窗确认,删除后相关笔记中的链接失效)
fm.delete('/files/:id', async (c) => {
  const user = c.get('user')
  try {
    const f = await c.env.DB.prepare('SELECT id, key FROM files WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id).first<{ id: number; key: string }>()
    if (!f) return err('文件不存在', 404)
    const refCount = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM article_files WHERE file_key = ?')
      .bind(f.key).first<{ c: number }>()
    if ((refCount?.c || 0) > 0 && c.req.query('force') !== '1') {
      return err(`仍被 ${refCount!.c} 篇笔记引用,请在确认弹窗中强制删除`, 400)
    }
    if (c.env.BUCKET) {
      try { await c.env.BUCKET.delete([f.key, f.key + SIDECAR_SUFFIX]) } catch { /* 静默 */ }
    }
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM article_files WHERE file_key = ?').bind(f.key),
      c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(f.id),
    ])
    return ok({ message: '已删除' })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// POST /api/fm/files/batch {op:'move'|'delete'|'copy', ids:number[], folder_id?, force?}
// 批量操作(P13.3)。为什么不让前端循环打 N 次 PUT/DELETE:移动 20 个文件就是 20 次计费请求,
// 而免费额度里请求数(10 万/天)比 D1 行读紧张得多——一次请求 + 一次 D1 batch 就能干完。
const MAX_BATCH = 200            // 移动/删除:一次最多这么多,防手滑全选几千个
const MAX_COPY = 20              // 复制要把字节读出来再写回去,单请求内不能太多
const MAX_COPY_BYTES = 10 * 1024 * 1024
fm.post('/files/batch', async (c) => {
  const user = c.get('user')
  try {
    const body = await c.req.json<{ op: string; ids: unknown; folder_id?: number | null; force?: boolean }>()
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
    if (ids.length === 0) return err('没有选中任何文件')
    if (ids.length > MAX_BATCH) return err(`一次最多处理 ${MAX_BATCH} 个文件`)

    const ph = ids.map(() => '?').join(',')
    const { results: rows } = await c.env.DB.prepare(
      `SELECT * FROM files WHERE user_id = ? AND id IN (${ph})`
    ).bind(user.id, ...ids).all<FileRow>()
    const files = rows || []
    if (files.length === 0) return err('文件不存在', 404)

    // ---- 移动 ----
    if (body.op === 'move') {
      let target: number | null = null
      if (body.folder_id != null) {
        const fd = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
          .bind(body.folder_id, user.id).first()
        if (!fd) return err('目标文件夹不存在', 404)
        target = Number(body.folder_id)
      }
      await c.env.DB.prepare(
        `UPDATE files SET folder_id = ?, updated_at = datetime('now')
         WHERE user_id = ? AND id IN (${files.map(() => '?').join(',')})`
      ).bind(target, user.id, ...files.map((f) => f.id)).run()
      const revoked = await revokePrivateShares(c.env, user.id)
      return ok({ moved: files.length, revoked_shares: revoked })
    }

    // ---- 删除 ----
    if (body.op === 'delete') {
      const keys = files.map((f) => f.key)
      const { results: refRows } = await c.env.DB.prepare(
        `SELECT file_key, COUNT(*) AS c FROM article_files
          WHERE file_key IN (${keys.map(() => '?').join(',')}) GROUP BY file_key`
      ).bind(...keys).all<{ file_key: string; c: number }>()
      const refBy = new Map((refRows || []).map((r) => [r.file_key, r.c]))
      // 有引用的文件必须显式 force:与单个删除同一条规矩,只是这里一次把名单全给出来
      if (!body.force) {
        const blocked = files.filter((f) => (refBy.get(f.key) || 0) > 0)
        if (blocked.length > 0) {
          return ok({
            needs_force: true,
            referenced: blocked.map((f) => ({ id: f.id, name: f.name, refs: refBy.get(f.key) || 0 })),
          })
        }
      }
      if (c.env.BUCKET) {
        // R2 的 delete 接受数组;缩略图边车一并删。分批避免单次列表过长
        const all = files.flatMap((f) => [f.key, f.key + SIDECAR_SUFFIX])
        for (let i = 0; i < all.length; i += 100) {
          try { await c.env.BUCKET.delete(all.slice(i, i + 100)) } catch { /* 静默:D1 行已删,对象留守由 scan 兜底 */ }
        }
      }
      await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM article_files WHERE file_key IN (${keys.map(() => '?').join(',')})`).bind(...keys),
        c.env.DB.prepare(`DELETE FROM files WHERE user_id = ? AND id IN (${files.map(() => '?').join(',')})`)
          .bind(user.id, ...files.map((f) => f.id)),
      ])
      return ok({ deleted: files.length })
    }

    // ---- 复制 ----
    // R2 的 Workers binding **没有服务端 copy**,必须把对象读出来再写回去,字节要流经 Worker。
    // 所以这里限死数量与单个体积,超出的跳过并原样报回去,而不是闷头把 CPU 打爆。
    if (body.op === 'copy') {
      if (!c.env.BUCKET) return err('未配置对象存储', 500)
      if (files.length > MAX_COPY) return err(`复制一次最多 ${MAX_COPY} 个文件(要把内容读出来再写回去)`)
      let target: number | null = null
      if (body.folder_id != null) {
        const fd = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
          .bind(body.folder_id, user.id).first()
        if (!fd) return err('目标文件夹不存在', 404)
        target = Number(body.folder_id)
      }
      const skipped: { name: string; reason: string }[] = []
      const inserts: D1PreparedStatement[] = []
      for (const f of files) {
        if ((f.size || 0) > MAX_COPY_BYTES) {
          skipped.push({ name: f.name, reason: `超过 ${Math.round(MAX_COPY_BYTES / 1024 / 1024)}MB` })
          continue
        }
        const obj = await c.env.BUCKET.get(f.key)
        if (!obj) { skipped.push({ name: f.name, reason: '对象不存在' }); continue }
        const tail = f.key.split('/').pop() || 'file'
        const newKey = `u${user.id}/${crypto.randomUUID().replace(/-/g, '')}/${tail}`
        await c.env.BUCKET.put(newKey, obj.body, {
          httpMetadata: { contentType: f.content_type || 'application/octet-stream' },
          customMetadata: { created: new Date().toISOString() },
        })
        inserts.push(c.env.DB.prepare(
          'INSERT INTO files (user_id, key, name, folder_id, size, content_type, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(user.id, newKey, copyName(f.name), target, f.size || 0, f.content_type,
          categorizeFile(f.name, f.content_type || '')))
      }
      if (inserts.length > 0) await c.env.DB.batch(inserts)
      // 副本刻意不继承分享(分享是「这一份」的授权,复制一份就该重新决定)
      return ok({ copied: inserts.length, skipped })
    }

    return err('不支持的操作: ' + body.op)
  } catch (e: any) {
    return err('批量操作失败: ' + e.message, 500)
  }
})

/** 「报告.pdf」→「报告 副本.pdf」;重复复制不会叠成「副本 副本」而是加序号(实现见 src/lib/fmUtils.ts) */

// ---- 文件分享(P8.2 增强批)----
// 一个文件同时只有一个分享(files 表 share_token/share_expires_at 即全部状态):
// 重新生成即替换旧 token(旧链接立即失效),取消置空。私密文件夹内禁止分享。

// POST /api/fm/files/:id/share {expires_in: 秒数|null(永久)} → {token, url, share_expires_at}
fm.post('/files/:id/share', async (c) => {
  const user = c.get('user')
  try {
    const { expires_in } = await c.req.json<{ expires_in?: number | null }>()
    if (expires_in != null && (!Number.isFinite(expires_in) || expires_in < 60 || expires_in > 10 * 366 * 86400)) {
      return err('有效期不合法')
    }
    const f = await c.env.DB.prepare('SELECT id, name, folder_id FROM files WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id).first<{ id: number; name: string; folder_id: number | null }>()
    if (!f) return err('文件不存在', 404)
    if (f.folder_id != null) {
      const priv = await getPrivateFolderIds(c.env, user.id)
      if (priv.has(f.folder_id)) return err('私密文件夹中的文件禁止分享,请先移出')
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    const expiresAt = expires_in == null ? null : new Date(Date.now() + expires_in * 1000).toISOString()
    await c.env.DB.prepare('UPDATE files SET share_token = ?, share_expires_at = ? WHERE id = ?')
      .bind(token, expiresAt, f.id).run()
    return ok({
      token,
      share_expires_at: expiresAt,
      url: `/api/share/${token}/${encodeURIComponent(f.name)}`,
    })
  } catch (e: any) {
    return err('分享失败: ' + e.message, 500)
  }
})

// DELETE /api/fm/files/:id/share - 取消分享(链接立即失效)
fm.delete('/files/:id/share', async (c) => {
  const user = c.get('user')
  try {
    const r = await c.env.DB.prepare(
      'UPDATE files SET share_token = NULL, share_expires_at = NULL WHERE id = ? AND user_id = ?'
    ).bind(c.req.param('id'), user.id).run()
    if (!r.meta.changes) return err('文件不存在', 404)
    return ok({ message: '已取消分享' })
  } catch (e: any) {
    return err('取消失败: ' + e.message, 500)
  }
})

// ---- 文件夹(仅管手工上传区;目录是 D1 虚拟结构,移动/改名不影响任何链接)----

fm.post('/folders', async (c) => {
  const user = c.get('user')
  try {
    const { name, parent_id } = await c.req.json<{ name?: string; parent_id?: number | null }>()
    const n = String(name || '').trim()
    if (!n) return err('名称不能为空')
    let parent: number | null = null
    if (parent_id != null) {
      const p = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
        .bind(parent_id, user.id).first()
      if (!p) return err('上级文件夹不存在', 404)
      parent = parent_id
    }
    const r = await c.env.DB.prepare('INSERT INTO folders (user_id, name, parent_id) VALUES (?, ?, ?)')
      .bind(user.id, n, parent).run()
    return ok({ id: r.meta.last_row_id, name: n, parent_id: parent })
  } catch (e: any) {
    return err('创建失败: ' + e.message, 500)
  }
})

// PUT /api/fm/folders/:id {name?, parent_id?} - 改名或移动(parent_id 为 null 表示移到根)。
// 系统私密根目录不可改名/移动;移动做祖先链防环;移入私密子树后撤销其中文件的分享。
fm.put('/folders/:id', async (c) => {
  const user = c.get('user')
  try {
    const body = await c.req.json<{ name?: string; parent_id?: number | null }>()
    const fd = await c.env.DB.prepare('SELECT id, name, parent_id, is_private FROM folders WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id).first<{ id: number; name: string; parent_id: number | null; is_private: number }>()
    if (!fd) return err('文件夹不存在', 404)
    if (fd.is_private) return err('「我的私密文件夹」是系统目录,不可改名或移动')

    let newName = fd.name
    if (body.name !== undefined) {
      newName = String(body.name).trim()
      if (!newName) return err('名称不能为空')
    }
    let newParent = fd.parent_id
    if ('parent_id' in body) {
      if (body.parent_id == null) {
        newParent = null
      } else {
        if (body.parent_id === fd.id) return err('不能移动到自己内部')
        const { results } = await c.env.DB.prepare('SELECT id, parent_id FROM folders WHERE user_id = ?')
          .bind(user.id).all<{ id: number; parent_id: number | null }>()
        const parentOf = new Map((results || []).map((r) => [r.id, r.parent_id]))
        if (!parentOf.has(body.parent_id)) return err('目标文件夹不存在', 404)
        // 沿目标的祖先链向上走,撞到自己说明目标在自己子树内(防环)
        let cur: number | null = body.parent_id
        for (let i = 0; cur != null && i < 1000; i++) {
          if (cur === fd.id) return err('不能移动到自己的子目录')
          cur = parentOf.get(cur) ?? null
        }
        newParent = body.parent_id
      }
    }
    await c.env.DB.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?')
      .bind(newName, newParent, fd.id).run()
    const revoked = 'parent_id' in body ? await revokePrivateShares(c.env, user.id) : 0
    return ok({ message: '已更新', revoked_shares: revoked })
  } catch (e: any) {
    return err('更新失败: ' + e.message, 500)
  }
})

// 仅允许删除空目录(无子目录、无文件),避免语义分歧;系统私密根目录不可删除
fm.delete('/folders/:id', async (c) => {
  const user = c.get('user')
  try {
    const id = c.req.param('id')
    const fd = await c.env.DB.prepare('SELECT id, is_private FROM folders WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first<{ id: number; is_private: number }>()
    if (!fd) return err('文件夹不存在', 404)
    if (fd.is_private) return err('「我的私密文件夹」是系统目录,不可删除')
    const child = await c.env.DB.prepare('SELECT 1 FROM folders WHERE parent_id = ? LIMIT 1').bind(id).first()
    if (child) return err('文件夹内还有子目录,请先清空')
    const hasFile = await c.env.DB.prepare('SELECT 1 FROM files WHERE folder_id = ? LIMIT 1').bind(id).first()
    if (hasFile) return err('文件夹内还有文件,请先移出或删除')
    await c.env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id).run()
    return ok({ message: '已删除' })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// POST /api/fm/scan - 存量维护:R2 全量对象登记 files 表 + 全量重建引用索引。
// 幂等可重复执行;用于登记 P8.1 之前上传的旧附件,或修复索引不一致。
fm.post('/scan', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err('未配置附件存储(R2)', 501)
  try {
    let registered = 0
    let cursor: string | undefined
    do {
      const page = await c.env.BUCKET.list({ cursor, limit: 500, include: ['httpMetadata', 'customMetadata'] })
      const stmts: D1PreparedStatement[] = []
      for (const o of page.objects) {
        if (o.key.endsWith(SIDECAR_SUFFIX)) continue // 边车缩略图不作为独立文件
        const um = /^u(\d+)\//.exec(o.key)
        if (!um) continue
        const name = o.key.split('/').pop() || 'file'
        const ct = o.httpMetadata?.contentType || null
        stmts.push(
          c.env.DB.prepare(
            `INSERT INTO files (user_id, key, name, size, content_type, category, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`
          ).bind(Number(um[1]), o.key, name, o.size, ct, categorizeFile(name, ct),
            o.customMetadata?.created || o.uploaded.toISOString())
        )
      }
      for (let i = 0; i < stmts.length; i += 80) {
        const rs = await c.env.DB.batch(stmts.slice(i, i + 80))
        for (const r of rs) registered += r.meta.changes || 0
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)

    // 全量重建引用索引(逐篇原子替换;顺带把内容里 afile id 换算成 key 登记)
    const { results: arts } = await c.env.DB.prepare('SELECT id, user_id, content FROM articles').all<{
      id: number; user_id: number; content: string
    }>()
    for (const a of arts || []) {
      await syncArticleFiles(c.env, a.user_id, a.id, a.content || '')
    }

    const total = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM files WHERE user_id = ?')
      .bind(user.id).first<{ c: number }>()
    return ok({ registered, articles_indexed: (arts || []).length, files_total: total?.c || 0 })
  } catch (e: any) {
    return err('扫描失败: ' + e.message, 500)
  }
})

// POST /api/fm/refcheck - 发布前附件清单:解析当前编辑内容引用的附件,
// 返回每件的名称/大小/分类/预览地址,以及「除本文外还被哪些笔记引用」(带公开/私有态,
// 供发布弹窗标注"该附件同时被私有笔记引用"的交叉警告)。
// private_file=true 表示附件在私密文件夹内:笔记公开后该附件对访客不可见(弹窗单列提示)。
fm.post('/refcheck', async (c) => {
  const user = c.get('user')
  try {
    const { content, article_id } = await c.req.json<{ content?: string; article_id?: number }>()
    const { keys, ids } = parseFileRefs(content || '', user.id)
    const priv = await getPrivateFolderIds(c.env, user.id)

    // 双方案统一到 files 表行:afile 按 id 查,旧式按 key 查(未登记的旧附件降级为 key 展示)
    type Row = { id: number; key: string; name: string; size: number; category: string; folder_id: number | null }
    const byKey = new Map<string, Row>()
    const lookup = async (where: string, params: unknown[]) => {
      const { results } = await c.env.DB.prepare(
        `SELECT id, key, name, size, category, folder_id FROM files WHERE ${where} AND user_id = ?`
      ).bind(...params, user.id).all<Row>()
      for (const r of results || []) byKey.set(r.key, r)
    }
    if (ids.length > 0) await lookup(`id IN (${ids.map(() => '?').join(',')})`, ids)
    if (keys.length > 0) await lookup(`key IN (${keys.map(() => '?').join(',')})`, keys)

    const allKeys = new Set<string>([...keys, ...byKey.keys()])
    const items = []
    for (const key of allKeys) {
      const f = byKey.get(key)
      const name = f?.name || key.split('/').pop() || 'file'
      const url = f ? buildAfileUrl(f.id, f.name) : `/api/files/${key.split('/').map(encodeURIComponent).join('/')}`
      const category = f?.category || 'other'
      const { results: refs } = await c.env.DB.prepare(
        `SELECT a.id, a.title, a.is_public, a.is_private
         FROM article_files af JOIN articles a ON a.id = af.article_id
         WHERE af.file_key = ? AND a.id != ? AND a.deleted_at IS NULL LIMIT 10`
      ).bind(key, article_id || 0).all<{ id: number; title: string; is_public: number; is_private: number }>()
      items.push({
        key,
        name,
        url,
        size: f?.size || 0,
        category,
        // 预览:图片用自身,xmind 用边车缩略图,其余无
        thumb: category === 'image' ? url : (/\.xmind$/i.test(name) ? url + SIDECAR_SUFFIX : null),
        private_file: !!(f && f.folder_id != null && priv.has(f.folder_id)),
        other_refs: (refs || []).map((r) => ({
          id: r.id, title: r.title, is_public: !!r.is_public, is_private: !!r.is_private,
        })),
      })
    }
    return ok({ files: items })
  } catch (e: any) {
    return err('附件检查失败: ' + e.message, 500)
  }
})
