import { Hono } from 'hono'
import { ok, err } from '../utils'
import { escapeLike } from './search'
import { syncArticleFiles } from './files'
import { parseFileRefs, buildAfileUrl, categorizeFile, SIDECAR_SUFFIX } from '../../src/lib/fileRefs'
import type { AppEnv } from '../types'

// 文件管理接口(P8,见 docs/file-manager.md):refcheck 为发布前置检查(P8.1),
// overview/files/folders/scan 支撑文件管理页(P8.2)。全部走全局鉴权。
export const fm = new Hono<AppEnv>()

interface FileRow {
  id: number; key: string; name: string; size: number; category: string
  content_type: string | null; folder_id: number | null
  created_at: string; updated_at: string
  ref_count?: number; pub_count?: number
}

// 列表/详情共用的展示字段:间接链接 + 预览缩略地址(图片用自身,xmind 用边车)
function decorate(f: FileRow) {
  const url = buildAfileUrl(f.id, f.name)
  return {
    ...f,
    url,
    thumb: f.category === 'image' ? url : (/\.xmind$/i.test(f.name) ? url + SIDECAR_SUFFIX : null),
  }
}

// GET /api/fm/overview - 左栏与统计:总量、未引用数、笔记附件按笔记本分组计数、文件夹列表
fm.get('/overview', async (c) => {
  const user = c.get('user')
  try {
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
         WHERE n.user_id = ?
         GROUP BY n.id, n.name, n.color ORDER BY n.name`
      ).bind(user.id).all(),
      c.env.DB.prepare('SELECT id, name, parent_id, created_at FROM folders WHERE user_id = ? ORDER BY name')
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

    let sql = `SELECT f.id, f.key, f.name, f.size, f.category, f.content_type, f.folder_id, f.created_at, f.updated_at,
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
               WHERE af4.file_key = f.key AND a4.notebook_id = ?)`
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
    return ok({ files: (results || []).map(decorate) })
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
      `SELECT a.id, a.title, a.is_public, a.is_private, n.name AS notebook
       FROM article_files af
       JOIN articles a ON a.id = af.article_id
       LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE af.file_key = ? ORDER BY a.updated_at DESC LIMIT 50`
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
    return ok(decorate({ ...f, name: newName, folder_id: newFolder }))
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

fm.put('/folders/:id', async (c) => {
  const user = c.get('user')
  try {
    const { name } = await c.req.json<{ name?: string }>()
    const n = String(name || '').trim()
    if (!n) return err('名称不能为空')
    const r = await c.env.DB.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?')
      .bind(n, c.req.param('id'), user.id).run()
    if (!r.meta.changes) return err('文件夹不存在', 404)
    return ok({ message: '已更新' })
  } catch (e: any) {
    return err('更新失败: ' + e.message, 500)
  }
})

// 仅允许删除空目录(无子目录、无文件),避免语义分歧
fm.delete('/folders/:id', async (c) => {
  const user = c.get('user')
  try {
    const id = c.req.param('id')
    const fd = await c.env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').bind(id, user.id).first()
    if (!fd) return err('文件夹不存在', 404)
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
fm.post('/refcheck', async (c) => {
  const user = c.get('user')
  try {
    const { content, article_id } = await c.req.json<{ content?: string; article_id?: number }>()
    const { keys, ids } = parseFileRefs(content || '', user.id)

    // 双方案统一到 files 表行:afile 按 id 查,旧式按 key 查(未登记的旧附件降级为 key 展示)
    const byKey = new Map<string, { id: number; key: string; name: string; size: number; category: string }>()
    const lookup = async (where: string, params: unknown[]) => {
      const { results } = await c.env.DB.prepare(
        `SELECT id, key, name, size, category FROM files WHERE ${where} AND user_id = ?`
      ).bind(...params, user.id).all<{ id: number; key: string; name: string; size: number; category: string }>()
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
         WHERE af.file_key = ? AND a.id != ? LIMIT 10`
      ).bind(key, article_id || 0).all<{ id: number; title: string; is_public: number; is_private: number }>()
      items.push({
        key,
        name,
        url,
        size: f?.size || 0,
        category,
        // 预览:图片用自身,xmind 用边车缩略图,其余无
        thumb: category === 'image' ? url : (/\.xmind$/i.test(name) ? url + SIDECAR_SUFFIX : null),
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
