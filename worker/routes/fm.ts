import { Hono } from 'hono'
import { ok, err } from '../utils'
import { parseFileRefs, buildAfileUrl, SIDECAR_SUFFIX } from '../../src/lib/fileRefs'
import type { AppEnv } from '../types'

// 文件管理接口(P8:P8.1 先落发布前置检查;列表/目录/搜索等见 docs/file-manager.md,P8.2 实现)
export const fm = new Hono<AppEnv>()

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
