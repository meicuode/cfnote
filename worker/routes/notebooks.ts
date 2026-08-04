import { Hono } from 'hono'
import { ok, err, recountNotebook } from '../utils'
import { purgeUnreferencedAttachments } from './files'
import { vectorizeArticle } from './articles'
import { wouldCycle, subtreeIds, inPrivateBranch } from '../../src/lib/notebookTree'
import { loadNotebookRows, hasLiveNotebook, chunked, trashedAncestors } from '../notebookPrivacy'
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

// GET /api/notebooks/:id/impact - 这一支现在有多少东西、其中多少是别人看得见的
//
// 两个确认框共用同一份统计(P16.3 把 private-impact 泛化过来):
// 「设为私密」要看的是「还没上锁的有几篇、其中几篇公开、几个分享链接」;
// 「删除笔记本」要看的是「会连同几本几篇一起进回收站、其中几篇会从博客下线」。
// 两者问的都是**确认之后别人看不见了什么**,数量本身反而不是重点,
// 所以没必要开两个接口各查一遍。
//
// 取消私密还要「已经上锁的有几篇」:那几篇**不会**跟着解锁,得说清楚,
// 否则就留下「笔记本没锁、里面全是私有」这个乍看很怪的状态没人解释。
notebooks.get('/:id/impact', async (c) => {
  const user = c.get('user')
  try {
    const rows = await loadNotebookRows(c.env, user.id)
    const id = Number(c.req.param('id'))
    if (!hasLiveNotebook(rows, id)) return err('笔记本不存在', 404)
    // 统计口径是**活着的**子树:回收站里的子孙本来就已经在回收站,再删一次不改变什么,
    // 而把它们算进「将连同 N 个子笔记本一起移入回收站」会让数字对不上眼见的侧栏
    const live = subtreeIds(rows, id).filter((n) => hasLiveNotebook(rows, n))
    const acc = { open_cnt: 0, pub: 0, shared: 0, priv: 0 }
    for (const part of chunked(live)) {
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
      notebooks: live.length,
      // articles/published/shared 只数**未私有**的:设为私密时它们是「会被转私有」的那批,
      // 删除时私有笔记本来就不在博客上,下线数也只该数这批
      articles: acc.open_cnt,
      published: acc.pub,
      shared: acc.shared,
      private: acc.priv,
      // 删除确认要的是「一共几篇进回收站」,私有的那些也要算进去
      total: acc.open_cnt + acc.priv,
    })
  } catch (e: any) {
    return err('检查失败: ' + e.message, 500)
  }
})

// DELETE /api/notebooks/:id - 整棵子树移入回收站(P14.1 软删除,P16.3 改为级联)
//
// 此前这里是硬删:清向量 → **立即** purgeUnreferencedAttachments(R2 上的图当场没了)
// → DELETE FROM notebooks 靠外键 CASCADE 带走全部文章。一次误点,两百篇笔记连同附件一起消失,
// 回收站里什么都没有——这是整个知识库里唯一一处不可逆的破坏性操作。
//
// 现在改为:笔记本与其名下**仍活着**的笔记一起打 deleted_at,附件一个不动。
// 只要不 DELETE notebooks 那一行,CASCADE 就永远不会触发,因此**不必去改外键约束**
// (那要重建表,违反「只做增量幂等」的约定)。附件的清理推迟到彻底删除时,走与单篇一致的引用计数。
//
// P16.3:有子笔记本时不再拒绝,而是**整棵子树一起进回收站**。P16.1 当时拦住是因为
// 「删父连子孙一起进、恢复时整棵回来」这套还没做,宁可拦住也不能让回收站里对不上账;
// 现在恢复侧补齐了(整本恢复带子孙 + 祖先链),级联才敢开。
// 危险性由确认框承担:它摊开的是「其中几篇已发布会从博客下线」,超过 50 篇还要求打字确认。
notebooks.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const rows = await loadNotebookRows(c.env, user.id)
    const nbId = Number(id)
    if (!hasLiveNotebook(rows, nbId)) return err('笔记本不存在', 404)

    // 只级联**活着的**子孙:回收站里的子孙各有各的 30 天倒计时,不该被重置
    const targets = subtreeIds(rows, nbId).filter((n) => hasLiveNotebook(rows, n))

    // 与单篇软删一致:向量与分块即刻清除,搜索/AI 立刻看不到(恢复时重建)
    for (const part of chunked(targets)) {
      const { results: chunks } = await c.env.DB.prepare(
        `SELECT c.vector_id FROM chunks c INNER JOIN articles a ON c.article_id = a.id
          WHERE a.notebook_id IN (${part.map(() => '?').join(',')}) AND a.deleted_at IS NULL`
      ).bind(...part).all<{ vector_id: string }>()
      if (chunks.length > 0 && c.env.VECTORIZE) {
        const vectorIds = chunks.map((ch) => ch.vector_id)
        for (let i = 0; i < vectorIds.length; i += 100) {
          try { await c.env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 100)) } catch { /* 静默,可由 reindex 补 */ }
        }
      }
    }

    let moved = 0
    for (const part of chunked(targets)) {
      const holes = part.map(() => '?').join(',')
      // 只碰仍活着的笔记:此前已单独删掉的那些各有各的 30 天倒计时,不该被重置
      const r = await c.env.DB.prepare(
        `UPDATE articles SET deleted_at = datetime('now'), is_public = 0, pinned = 0, is_vectorized = 0,
                share_token = NULL, share_expires_at = NULL, remind_at = NULL
         WHERE user_id = ? AND deleted_at IS NULL AND notebook_id IN (${holes})`
      ).bind(user.id, ...part).run()
      moved += r.meta?.changes ?? 0

      await c.env.DB.batch([
        c.env.DB.prepare(
          `DELETE FROM chunks WHERE article_id IN (SELECT id FROM articles WHERE notebook_id IN (${holes}))`
        ).bind(...part),
        c.env.DB.prepare(
          `UPDATE notebooks SET deleted_at = datetime('now'), article_count = 0
            WHERE user_id = ? AND id IN (${holes})`
        ).bind(user.id, ...part),
      ])
    }

    const subs = targets.length - 1
    const what = subs > 0 ? `${subs} 个子笔记本、${moved} 篇笔记` : `${moved} 篇笔记`
    return ok({ message: `已移入回收站(${what}),30 天后自动清除`, articles: moved, notebooks: targets.length })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// POST /api/notebooks/:id/restore - 从回收站恢复整棵子树(P14.1,P16.3 补子孙与祖先链)
//
// 会**一并恢复它名下所有仍在回收站的笔记**,包括此前单独删掉的那几篇。
// 宁可多恢复(你再删一次就是了)也不要少恢复——否则得从两百篇里把属于这本的挑出来。
//
// P16.3 起还要恢复两头:
// ① **子孙**——删除是级联的,恢复不跟着级联就等于恢复不回来;
// ② **祖先链上还在回收站里的那些,但只恢复壳,它们自己的笔记留在回收站**。
//    不恢复祖先的话会留下「子本活着、父本在回收站」的状态:buildTree 会把它兜回根
//    (P16.1 的容错),于是你恢复的东西没回到原来的位置,而层级一深根本看不出来它挪过。
//    只恢复壳是因为你点的是恢复这一本,不该顺带把另一本的笔记也捞回来。
notebooks.post('/:id/restore', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const nbId = Number(id)
    const nb = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .bind(id, user.id).first<any>()
    if (!nb) return err('笔记本不在回收站中', 404)

    // loadNotebookRows 连回收站里的一起取,所以祖先即使也在回收站里,链仍然是完整的
    const privRows = await loadNotebookRows(c.env, user.id)
    // 要连笔记一起恢复的:自己 + 还在回收站里的子孙
    const withArticles = subtreeIds(privRows, nbId).filter((n) => !hasLiveNotebook(privRows, n))
    // 只恢复壳的:祖先链上还在回收站里的
    const shellOnly = trashedAncestors(privRows, nbId)

    const { results: arts } = await (async () => {
      const out: { id: number; title: string; content: string; notebook_id: number }[] = []
      for (const part of chunked(withArticles)) {
        const { results } = await c.env.DB.prepare(
          `SELECT id, title, content, notebook_id FROM articles
            WHERE user_id = ? AND deleted_at IS NOT NULL AND notebook_id IN (${part.map(() => '?').join(',')})`
        ).bind(user.id, ...part).all<{ id: number; title: string; content: string; notebook_id: number }>()
        out.push(...(results || []))
      }
      return { results: out }
    })()

    const stmts: D1PreparedStatement[] = []
    for (const n of withArticles) {
      // P16.5.3:恢复也要过私密不变式(回收站里的笔记躲得过 PUT 时的拉平,
      // 它只扫 deleted_at IS NULL)。逐本判断——同一棵子树里各本的私密性可以不同
      const forcePriv = inPrivateBranch(privRows, n)
      stmts.push(
        forcePriv
          ? c.env.DB.prepare(
              `UPDATE articles SET deleted_at = NULL, is_private = 1, is_public = 0,
                      share_token = NULL, share_expires_at = NULL, updated_at = datetime('now')
               WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL`
            ).bind(n, user.id)
          : c.env.DB.prepare("UPDATE articles SET deleted_at = NULL, updated_at = datetime('now') WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL")
              .bind(n, user.id)
      )
    }
    for (const n of [...withArticles, ...shellOnly]) {
      stmts.push(c.env.DB.prepare("UPDATE notebooks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(n, user.id))
      stmts.push(recountNotebook(c.env, n))
    }
    await c.env.DB.batch(stmts)

    // 重建向量:逐篇失败不阻塞恢复(可由 /api/reindex 补)
    let failed = 0
    for (const a of arts) {
      if (!(a.content || '').trim()) continue
      const e = await vectorizeArticle(c.env, a.id, user.id, a.notebook_id, a.title, a.content)
      if (e) failed++
    }
    return ok({
      message: `已恢复「${nb.name}」`,
      articles: arts.length,
      notebooks: withArticles.length,
      ancestors: shellOnly.length,
      vectorize_failed: failed,
    })
  } catch (e: any) {
    return err('恢复失败: ' + e.message, 500)
  }
})

// DELETE /api/notebooks/:id/purge - 彻底删除回收站中的笔记本(P14.1,P16.3 改为整棵子树)
// 附件走与单篇彻底删除完全相同的引用计数管线,不另开规则。
//
// P16.3:此前是 DELETE 单独一行,而删除已经级联了——父子会一起在回收站里,
// 单独清掉父本就留下一个 parent_id 指向空号的子本。这里跟着清整棵子树,
// 但**只清回收站里的**:活着的子本(在父本进回收站后又被恢复)绝不能被彻底删掉,
// 那是不可逆的。这种情况下拒绝操作,而不是悄悄跳过——「点了没反应」比报错更糟。
notebooks.delete('/:id/purge', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const nbId = Number(id)
    const rows = await loadNotebookRows(c.env, user.id)
    const self = rows.find((n) => n.id === nbId)
    if (!self || !self.deleted_at) return err('笔记本不在回收站中', 404)

    const all = subtreeIds(rows, nbId)
    const alive = all.filter((n) => hasLiveNotebook(rows, n))
    if (alive.length > 0) return err('它下面有已恢复的子笔记本,请先移走或删除它们')

    let purged = 0
    for (const part of chunked(all)) {
      const { results: arts } = await c.env.DB.prepare(
        `SELECT id, content FROM articles WHERE user_id = ? AND notebook_id IN (${part.map(() => '?').join(',')})`
      ).bind(user.id, ...part).all<{ id: number; content: string }>()
      const ids = (arts || []).map((a) => a.id)
      if (ids.length > 0) {
        await purgeUnreferencedAttachments(c.env, user.id, ids, (arts || []).map((a) => a.content || ''))
        for (const idPart of chunked(ids)) {
          await c.env.DB.prepare(`DELETE FROM articles WHERE id IN (${idPart.map(() => '?').join(',')})`).bind(...idPart).run()
        }
        purged += ids.length
      }
    }
    // 此时名下已无文章,CASCADE 无事可做。从叶子往根删:子本先没,父本才不会中途成为孤儿的父亲
    for (const n of [...all].reverse()) {
      await c.env.DB.prepare('DELETE FROM notebooks WHERE id = ? AND user_id = ?').bind(n, user.id).run()
    }
    return ok({ message: '已彻底删除', articles: purged, notebooks: all.length })
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
