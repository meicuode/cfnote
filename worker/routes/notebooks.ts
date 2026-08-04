import { Hono } from 'hono'
import { ok, err, recountNotebook } from '../utils'
import { purgeUnreferencedAttachments } from './files'
import { vectorizeArticle } from './articles'
import { wouldCycle, subtreeIds, inPrivateBranch } from '../../src/lib/notebookTree'
import { loadNotebookRows, hasLiveNotebook, chunked } from '../notebookPrivacy'
import type { AppEnv } from '../types'

export const notebooks = new Hono<AppEnv>()

/**
 * 校验请求里的 parent_id(P16.1)。
 * 缺省/null/0 一律当「挂在根上」;给了值就必须是自己的、未删除的笔记本。
 * 负数是前端的虚拟笔记本(我的私有 -1 / 回收站 -2 / 标签视图 -3),它们不是真实行,
 * 绝不能成为谁的父——这里直接按「不存在」拒掉。
 */
async function resolveParent(
  c: { env: AppEnv['Bindings'] },
  userId: number,
  raw: number | null | undefined,
): Promise<{ id: number | null; error?: string; status?: 400 | 404 }> {
  if (raw == null || raw === 0) return { id: null }
  if (!Number.isInteger(raw) || raw < 0) return { id: null, error: '父笔记本无效', status: 400 }
  const row = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(raw, userId).first()
  if (!row) return { id: null, error: '父笔记本不存在', status: 404 }
  return { id: raw }
}

// GET /api/notebooks - List user's notebooks(不含回收站中的)
notebooks.get('/', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM notebooks WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC'
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取笔记本失败: ' + e.message, 500)
  }
})

// GET /api/notebooks/trash - 回收站中的笔记本(P14.1),附其中仍在回收站的笔记数
// 必须注册在 /:id 系列之前
notebooks.get('/trash', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.name, n.color, n.deleted_at,
              (SELECT COUNT(*) FROM articles a WHERE a.notebook_id = n.id AND a.deleted_at IS NOT NULL) AS article_count
       FROM notebooks n
       WHERE n.user_id = ? AND n.deleted_at IS NOT NULL
       ORDER BY n.deleted_at DESC`
    ).bind(user.id).all()
    return ok(results || [])
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// POST /api/notebooks {name, parent_id?} - Create notebook
// parent_id 为空/缺省=建在根上;指定则必须是自己的、未删除的笔记本(P16.1)
notebooks.post('/', async (c) => {
  const user = c.get('user')
  try {
    const { name, description, color, parent_id } = await c.req.json<{
      name: string; description?: string; color?: string; parent_id?: number | null
    }>()
    if (!name?.trim()) return err('笔记本名称不能为空')

    const parent = await resolveParent(c, user.id, parent_id)
    if (parent.error) return err(parent.error, parent.status)

    const result = await c.env.DB.prepare(
      'INSERT INTO notebooks (user_id, name, description, color, parent_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(user.id, name.trim(), description || '', color || '#10B981', parent.id).run()

    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first()
    return ok(notebook)
  } catch (e: any) {
    return err('创建笔记本失败: ' + e.message, 500)
  }
})

// PUT /api/notebooks/:id {name?, description?, color?, parent_id?} - 改名/改色/移动
//
// 移动(带 parent_id)与文件夹那边同规:不能移到自己身上,也不能移进自己的子孙里
// (worker/routes/fm.ts 的 PUT /folders/:id 是同一条规则)。环检测放在 src/lib/notebookTree
// 的 wouldCycle 里,前后端共用同一份判断,免得两边各写一遍还写歪。
notebooks.put('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const body = await c.req.json<{ name?: string; description?: string; color?: string; parent_id?: number | null; is_private?: number | boolean }>()
    const { name, description, color } = body
    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(id, user.id).first<{ id: number; parent_id: number | null; is_private: number }>()
    if (!notebook) return err('笔记本不存在', 404)

    let newParent = notebook.parent_id
    if ('parent_id' in body) {
      const parent = await resolveParent(c, user.id, body.parent_id)
      if (parent.error) return err(parent.error, parent.status)
      if (parent.id !== null) {
        const { results: all } = await c.env.DB.prepare(
          'SELECT id, name, parent_id FROM notebooks WHERE user_id = ? AND deleted_at IS NULL'
        ).bind(user.id).all<{ id: number; name: string; parent_id: number | null }>()
        if (wouldCycle(all || [], notebook.id, parent.id)) return err('不能把笔记本移到它自己或它的子笔记本下')
      }
      newParent = parent.id
    }

    // P16.5 私密笔记本:这一位只决定「新写进来的笔记自动私有」,但**不能只管新的**。
    // 「笔记本挂着锁、里面的老笔记全是敞的」是最危险的状态——侧栏一排锁图标里混一个
    // 没锁的根本看不出来。所以这里不给选择:只要更新之后它落在私密分支里,
    // 就无条件把整支已有的笔记一并上锁。
    const newPrivate = body.is_private === undefined ? (notebook.is_private ? 1 : 0) : (body.is_private ? 1 : 0)

    await c.env.DB.prepare(
      `UPDATE notebooks SET name = COALESCE(?, name), description = COALESCE(?, description),
              color = COALESCE(?, color), parent_id = ?, is_private = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(name || null, description ?? null, color || null, newParent, newPrivate, id).run()

    // 不变式:私密分支里不存在 is_private = 0 的活笔记。
    // 每次 PUT 都重新拉平一次(通常匹配 0 行),而不是靠调用方记得再打一个接口——
    // 保证不了不变式的接口,迟早会有一条路径绕过去。取消私密时**不解锁**已有笔记:
    // 安全方向的默认永远是「不解密」,要放行某一篇就去那一篇上显式取消。
    let locked = 0
    const after = await loadNotebookRows(c.env, user.id)
    if (inPrivateBranch(after, notebook.id)) {
      // 分片:ids 等于「这一支的笔记本数」,SQLite 绑定变量上限 999。
      // 眼下个人库到不了,但 P16.4 把整个本地知识库的目录树导进来之后就不好说了,
      // 而其他地方(files.ts / fm.ts)本来就都分片,这里不分是不一致
      for (const part of chunked(subtreeIds(after, notebook.id))) {
        const r = await c.env.DB.prepare(
          `UPDATE articles SET is_private = 1, is_public = 0, share_token = NULL, share_expires_at = NULL,
                  updated_at = datetime('now')
           WHERE user_id = ? AND deleted_at IS NULL AND is_private = 0
             AND notebook_id IN (${part.map(() => '?').join(',')})`
        ).bind(user.id, ...part).run()
        locked += r.meta?.changes ?? 0
      }
    }

    const updated = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ?').bind(id).first()
    return ok({ ...(updated as any), locked_articles: locked })
  } catch (e: any) {
    return err('更新失败: ' + e.message, 500)
  }
})

// GET /api/notebooks/:id/private-impact - 私密开关两个方向的后果清单(P16.5)
//
// 设为私密要看的是「还没上锁的有几篇、**其中几篇是公开的、几个分享链接**」——
// 数量不是重点,别人看得见、确认之后会当场消失的那部分才是。
// 取消私密要看的是「已经上锁的有几篇」:那几篇**不会**跟着解锁,得说清楚,
// 否则就留下「笔记本没锁、里面全是私有」这个乍看很怪的状态没人解释。
notebooks.get('/:id/private-impact', async (c) => {
  const user = c.get('user')
  try {
    const rows = await loadNotebookRows(c.env, user.id)
    const id = Number(c.req.param('id'))
    if (!hasLiveNotebook(rows, id)) return err('笔记本不存在', 404)
    const acc = { open_cnt: 0, pub: 0, shared: 0, priv: 0 }
    for (const part of chunked(subtreeIds(rows, id))) {
      const row = await c.env.DB.prepare(
        `SELECT SUM(CASE WHEN is_private = 0 THEN 1 ELSE 0 END) AS open_cnt,
                SUM(CASE WHEN is_private = 0 AND is_public = 1 THEN 1 ELSE 0 END) AS pub,
                SUM(CASE WHEN is_private = 0 AND share_token IS NOT NULL THEN 1 ELSE 0 END) AS shared,
                SUM(CASE WHEN is_private = 1 THEN 1 ELSE 0 END) AS priv
         FROM articles
         WHERE user_id = ? AND deleted_at IS NULL AND notebook_id IN (${part.map(() => '?').join(',')})`
      ).bind(user.id, ...part).first<{ open_cnt: number; pub: number; shared: number; priv: number }>()
      acc.open_cnt += row?.open_cnt ?? 0
      acc.pub += row?.pub ?? 0
      acc.shared += row?.shared ?? 0
      acc.priv += row?.priv ?? 0
    }
    return ok({
      notebooks: subtreeIds(rows, id).length,
      articles: acc.open_cnt,
      published: acc.pub,
      shared: acc.shared,
      private: acc.priv,
    })
  } catch (e: any) {
    return err('检查失败: ' + e.message, 500)
  }
})

// DELETE /api/notebooks/:id - 移入回收站(P14.1 软删除)
//
// 此前这里是硬删:清向量 → **立即** purgeUnreferencedAttachments(R2 上的图当场没了)
// → DELETE FROM notebooks 靠外键 CASCADE 带走全部文章。一次误点,两百篇笔记连同附件一起消失,
// 回收站里什么都没有——这是整个知识库里唯一一处不可逆的破坏性操作。
//
// 现在改为:笔记本与其名下**仍活着**的笔记一起打 deleted_at,附件一个不动。
// 只要不 DELETE notebooks 那一行,CASCADE 就永远不会触发,因此**不必去改外键约束**
// (那要重建表,违反「只做增量幂等」的约定)。附件的清理推迟到彻底删除时,走与单篇一致的引用计数。
notebooks.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(id, user.id).first()
    if (!notebook) return err('笔记本不存在', 404)

    // P16.1:有子笔记本时禁止删除,与文件夹那边同规(fm.ts 的 DELETE /folders/:id)。
    // 「删父连子孙一起进回收站、恢复时整棵回来」要等 P16.3——在那之前宁可拦住,
    // 也不能让子本变成指向已删父本的孤儿(虽然 buildTree 会把它兜回根,但回收站里对不上账)
    const child = await c.env.DB.prepare(
      'SELECT 1 FROM notebooks WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(id, user.id).first()
    if (child) return err('请先删除或移走它的子笔记本')

    // 与单篇软删一致:向量与分块即刻清除,搜索/AI 立刻看不到(恢复时重建)
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT c.vector_id FROM chunks c INNER JOIN articles a ON c.article_id = a.id WHERE a.notebook_id = ? AND a.deleted_at IS NULL'
    ).bind(id).all<{ vector_id: string }>()
    if (chunks.length > 0 && c.env.VECTORIZE) {
      const vectorIds = chunks.map((ch) => ch.vector_id)
      for (let i = 0; i < vectorIds.length; i += 100) {
        try { await c.env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 100)) } catch { /* 静默,可由 reindex 补 */ }
      }
    }

    // 只碰仍活着的笔记:此前已单独删掉的那些各有各的 30 天倒计时,不该被重置
    const moved = await c.env.DB.prepare(
      `UPDATE articles SET deleted_at = datetime('now'), is_public = 0, pinned = 0, is_vectorized = 0,
              share_token = NULL, share_expires_at = NULL, remind_at = NULL
       WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(id, user.id).run()

    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM chunks WHERE article_id IN (SELECT id FROM articles WHERE notebook_id = ?)'
      ).bind(id),
      c.env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now'), article_count = 0 WHERE id = ?").bind(id),
    ])

    const count = moved.meta?.changes ?? 0
    return ok({ message: `已移入回收站(${count} 篇笔记),30 天后自动清除`, articles: count })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// POST /api/notebooks/:id/restore - 从回收站整本恢复(P14.1)
//
// 会**一并恢复它名下所有仍在回收站的笔记**,包括此前单独删掉的那几篇。
// 宁可多恢复(你再删一次就是了)也不要少恢复——否则得从两百篇里把属于这本的挑出来。
// 返回恢复数量,前端在确认框里明说。
notebooks.post('/:id/restore', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const nb = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .bind(id, user.id).first<any>()
    if (!nb) return err('笔记本不在回收站中', 404)

    const { results: arts } = await c.env.DB.prepare(
      'SELECT id, title, content FROM articles WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, user.id).all<{ id: number; title: string; content: string }>()

    // P16.5.3:整本恢复同样要过私密不变式(与单篇恢复同一条理由——回收站里的笔记
    // 躲得过 PUT 时的拉平,它只扫 deleted_at IS NULL)。
    // loadNotebookRows 连回收站里的一起取,所以祖先即使也在回收站里,链仍然是完整的。
    const privRows = await loadNotebookRows(c.env, user.id)
    const forcePriv = inPrivateBranch(privRows, Number(id))

    await c.env.DB.batch([
      forcePriv
        ? c.env.DB.prepare(
            `UPDATE articles SET deleted_at = NULL, is_private = 1, is_public = 0,
                    share_token = NULL, share_expires_at = NULL, updated_at = datetime('now')
             WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL`
          ).bind(id, user.id)
        : c.env.DB.prepare("UPDATE articles SET deleted_at = NULL, updated_at = datetime('now') WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL")
            .bind(id, user.id),
      c.env.DB.prepare("UPDATE notebooks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(id),
      recountNotebook(c.env, Number(id)),
    ])

    // 重建向量:逐篇失败不阻塞恢复(可由 /api/reindex 补)
    let failed = 0
    for (const a of arts || []) {
      if (!(a.content || '').trim()) continue
      const e = await vectorizeArticle(c.env, a.id, user.id, Number(id), a.title, a.content)
      if (e) failed++
    }
    return ok({ message: `已恢复「${nb.name}」`, articles: (arts || []).length, vectorize_failed: failed })
  } catch (e: any) {
    return err('恢复失败: ' + e.message, 500)
  }
})

// DELETE /api/notebooks/:id/purge - 彻底删除回收站中的笔记本(P14.1)
// 附件走与单篇彻底删除完全相同的引用计数管线,不另开规则。
notebooks.delete('/:id/purge', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .bind(id, user.id).first()
    if (!nb) return err('笔记本不在回收站中', 404)

    const { results: arts } = await c.env.DB.prepare(
      'SELECT id, content FROM articles WHERE notebook_id = ? AND user_id = ?'
    ).bind(id, user.id).all<{ id: number; content: string }>()
    const ids = (arts || []).map((a) => a.id)
    if (ids.length > 0) {
      await purgeUnreferencedAttachments(c.env, user.id, ids, (arts || []).map((a) => a.content || ''))
      await c.env.DB.prepare(`DELETE FROM articles WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run()
    }
    // 此时名下已无文章,CASCADE 无事可做
    await c.env.DB.prepare('DELETE FROM notebooks WHERE id = ?').bind(id).run()
    return ok({ message: '已彻底删除', articles: ids.length })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// GET /api/notebooks/:id/articles - List articles in a notebook
notebooks.get('/:id/articles', async (c) => {
  const user = c.get('user')
  const notebookId = c.req.param('id')
  try {
    // Verify notebook belongs to user
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(notebookId, user.id).first()
    if (!nb) return err('笔记本不存在', 404)

    const { results } = await c.env.DB.prepare(
      `SELECT id, notebook_id, title,
              SUBSTR(content, 1, 150) as summary,
              is_vectorized, is_public, is_private, tags, pinned, created_at, updated_at
       FROM articles WHERE notebook_id = ? AND deleted_at IS NULL
       ORDER BY pinned DESC, updated_at DESC`
    ).bind(notebookId).all()
    return ok(results)
  } catch (e: any) {
    return err('获取文章列表失败: ' + e.message, 500)
  }
})
