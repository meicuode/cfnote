import { Hono } from 'hono'
import { ok, err, ragSearch, withTimeout, getSettingValue, DEFAULT_MODEL, isReasoningModel, stripThinkTags, trackEvent } from '../utils'
import {
  makeSnippets, dedupeSnippets, compareExact, splitSlots,
  MAX_SNIPPETS, HITS_PER_TERM, type Snippet, type ExactStat,
} from '../../src/lib/searchSnippets'
import type { AppEnv } from '../types'

export const search = new Hono<AppEnv>()

// 第二层要排出名次来就得有足够多的候选。此前是 10——跨全库只取 10 个切片,
// 挤在几篇文章里的话能召回的文章数还不到 10 篇,更别说每篇给出多个片段。
// 敢提上来的前提是下面那两处查询已经批量化:此前每个 match 串行两次 D1,
// topK=10 就是 20 次往返,提到 30 会变成 60 次。
const VECTOR_TOPK = 30

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

/** 一篇文章在向量腿的命中(可能多个切片) */
type VecHit = {
  article_id: number
  article_title: string
  notebook_id: number
  notebook_name: string
  /** 按相似度降序 */
  chunks: { text: string; score: number }[]
  maxScore: number
}

/** 一篇文章在关键词腿的命中 */
type KwHit = {
  article_id: number
  article_title: string
  notebook_id: number
  notebook_name: string
  stat: ExactStat
  /** 互不重叠的命中窗口,按出现位置 */
  windows: string[]
}

// POST /api/search - 混合检索:精确(LIKE)与语义(向量)两条腿,结果**分两层**呈现。
// 不用 FTS5:默认分词器不切中文,trigram 要求查询≥3字符;单用户规模 LIKE 全扫足够且对中文子串天然正确。
//
// P17.5 换掉了 RRF。RRF 是给「两个同样可信的检索器、分数不可比」用的融合法,
// 而这里两条腿并不同样可信:精确命中是自明的(那个词就在眼前),语义命中要人相信。
// RRF 把精确命中排到语义命中下面时无法向人解释,于是改成硬分层——
// 第一层有你搜的词,第二层意思相近,中间画一条线。
search.post('/', async (c) => {
  const user = c.get('user')
  try {
    const { query, notebook_id } = await c.req.json<{ query: string; notebook_id?: number }>()
    if (!query?.trim()) return err('搜索内容不能为空')
    const q = query.trim()
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))]

    let usedFallback = false
    let vectorDims = 0
    let vectorError = ''

    // ---- 向量召回(失败时降级为纯关键词,不再整体报错) ----
    const vectorLeg = async (): Promise<Map<number, VecHit>> => {
      const out = new Map<number, VecHit>()
      try {
        const embedResult: any = await c.env.AI.run('@cf/baai/bge-m3' as any, { text: [q] })
        const queryVector = embedResult?.data?.[0] as number[] | undefined
        if (!queryVector || queryVector.length === 0) {
          vectorError = 'embedding empty'
          return out
        }
        vectorDims = queryVector.length

        const filter: Record<string, number> = { user_id: user.id }
        if (notebook_id) filter.notebook_id = notebook_id

        let matches = await c.env.VECTORIZE.query(queryVector, { topK: VECTOR_TOPK, filter, returnMetadata: 'all' })
        if (!matches.matches || matches.matches.length === 0) {
          matches = await c.env.VECTORIZE.query(queryVector, { topK: VECTOR_TOPK, returnMetadata: 'all' })
          usedFallback = true
        }
        const rows = matches.matches ?? []
        if (rows.length === 0) return out

        // 先把 (文章, 切片) 收齐,再各用**一条**语句取回。
        // 此前是在循环里串行两次 await(N+1):topK=10 就是 20 次串行往返,
        // 而这一趟的耗时是搜索延迟里最大的一块
        const want = new Map<number, { index: number; score: number }[]>()
        for (const m of rows) {
          const aid = m.metadata?.article_id as number
          const ci = m.metadata?.chunk_index as number
          if (typeof aid !== 'number') continue
          const list = want.get(aid) ?? []
          list.push({ index: typeof ci === 'number' ? ci : 0, score: m.score })
          want.set(aid, list)
        }
        if (want.size === 0) return out

        const ids = [...want.keys()]
        // user_id 这一条是 P17.5 补的:降级那条路(去掉 filter 重查)此前只按
        // notebook_id 过滤,不校验归属。应用是单用户的(注册接口在已有用户时 403),
        // 所以不是可利用的漏洞,但让「取谁的文章」依赖 Vectorize 的 filter 而不是
        // SQL 的 where,是把正确性押在一个可以静默失效的东西上
        const artRows = await c.env.DB.prepare(
          `SELECT a.id, a.title, a.notebook_id, n.name as notebook_name
             FROM articles a LEFT JOIN notebooks n ON a.notebook_id = n.id
            WHERE a.user_id = ? AND a.deleted_at IS NULL AND a.id IN (${ids.map(() => '?').join(',')})`
        ).bind(user.id, ...ids).all<any>()
        const arts = new Map<number, any>((artRows.results ?? []).map((a: any) => [a.id, a]))
        if (arts.size === 0) return out

        const conds: string[] = []
        const binds: unknown[] = []
        for (const [aid, list] of want) {
          if (!arts.has(aid)) continue
          for (const ch of list) {
            conds.push('(article_id = ? AND chunk_index = ?)')
            binds.push(aid, ch.index)
          }
        }
        if (conds.length === 0) return out
        const chunkRows = await c.env.DB.prepare(
          `SELECT article_id, chunk_index, chunk_text FROM chunks WHERE ${conds.join(' OR ')}`
        ).bind(...binds).all<any>()
        const chunkAt = new Map<string, string>(
          (chunkRows.results ?? []).map((r: any) => [`${r.article_id}:${r.chunk_index}`, r.chunk_text as string])
        )

        for (const [aid, list] of want) {
          const article = arts.get(aid)
          if (!article) continue
          if (usedFallback && notebook_id && article.notebook_id !== notebook_id) continue
          const chunks = list
            .map((ch) => ({ text: chunkAt.get(`${aid}:${ch.index}`) || '', score: ch.score }))
            .filter((ch) => ch.text)
            .sort((x, y) => y.score - x.score)
          if (chunks.length === 0) continue
          out.set(aid, {
            article_id: article.id,
            article_title: article.title,
            notebook_id: article.notebook_id,
            notebook_name: article.notebook_name || '',
            chunks,
            maxScore: chunks[0].score,
          })
        }
        return out
      } catch (e: any) {
        vectorError = e.message
        return out
      }
    }

    // ---- 关键词召回(LIKE) ----
    const keywordLeg = async (): Promise<Map<number, KwHit>> => {
      const out = new Map<number, KwHit>()
      if (terms.length === 0) return out
      let sql = `SELECT a.id, a.title, a.content, a.notebook_id, n.name as notebook_name
                 FROM articles a LEFT JOIN notebooks n ON a.notebook_id = n.id
                 WHERE a.user_id = ? AND a.deleted_at IS NULL`
      const binds: unknown[] = [user.id]
      if (notebook_id) {
        sql += ' AND a.notebook_id = ?'
        binds.push(notebook_id)
      }
      const conds = terms.map(() => `(a.title LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')`)
      for (const t of terms) {
        const p = `%${escapeLike(t)}%`
        binds.push(p, p)
      }
      sql += ` AND (${conds.join(' OR ')}) LIMIT 50`

      const rows = await c.env.DB.prepare(sql).bind(...binds).all<any>()
      for (const a of rows.results ?? []) {
        const title = (a.title as string) || ''
        const content = (a.content as string) || ''
        const titleLower = title.toLowerCase()
        const contentLower = content.toLowerCase()
        let hits = 0
        let titleHit = false
        let allTerms = true
        for (const t of terms) {
          const tl = t.toLowerCase()
          const inTitle = titleLower.includes(tl)
          if (inTitle) titleHit = true
          let cnt = 0
          let i = contentLower.indexOf(tl)
          while (i >= 0 && cnt < HITS_PER_TERM) {
            cnt++
            i = contentLower.indexOf(tl, i + tl.length)
          }
          hits += cnt + (inTitle ? 1 : 0)
          if (!inTitle && cnt === 0) allTerms = false
        }
        if (hits === 0) continue
        out.set(a.id, {
          article_id: a.id,
          article_title: title,
          notebook_id: a.notebook_id,
          notebook_name: a.notebook_name || '',
          stat: { allTerms, titleHit, hits },
          // 标题命中而正文没有时窗口为空:那篇的「命中」就在标题上,
          // 前端会把标题里的词高亮出来,不需要凑一段正文冒充摘要
          windows: makeSnippets(content, terms),
        })
      }
      return out
    }

    const [vecMap, kwMap] = await Promise.all([vectorLeg(), keywordLeg()])

    // ---- 两层排序 ----
    // 第一层:有精确命中的(哪怕同时也有语义命中)。第二层:只有语义命中的。
    const tier1 = [...kwMap.values()].sort((a, b) => compareExact(a.stat, b.stat))
    const tier2 = [...vecMap.values()]
      .filter((v) => !kwMap.has(v.article_id))
      .sort((a, b) => b.maxScore - a.maxScore)

    const slots = splitSlots(tier1.length, tier2.length)

    const build = (
      base: { article_id: number; article_title: string; notebook_id: number; notebook_name: string },
      tier: 'exact' | 'semantic',
      score: number,
      exactWindows: string[],
      semanticChunks: { text: string; score: number }[],
    ) => {
      // 精确的排前面,语义的按相似度接在后面;去重时先来的赢,所以精确的不会被切片顶掉
      const all: Snippet[] = [
        ...exactWindows.map((text) => ({ text, kind: 'exact' as const })),
        ...semanticChunks.map((ch) => ({ text: ch.text, kind: 'semantic' as const })),
      ]
      const deduped = dedupeSnippets(all)
      return {
        ...base,
        tier,
        score,
        snippets: deduped.slice(0, MAX_SNIPPETS),
        more: Math.max(0, deduped.length - MAX_SNIPPETS),
      }
    }

    const results = [
      ...tier1.slice(0, slots.exact).map((k) => {
        const v = vecMap.get(k.article_id)
        return build(k, 'exact', v?.maxScore ?? 0, k.windows, v?.chunks ?? [])
      }),
      ...tier2.slice(0, slots.semantic).map((v) => build(v, 'semantic', v.maxScore, [], v.chunks)),
    ]

    trackEvent(c.env, 'search', user.id)

    return ok({
      results,
      terms,
      debug: {
        usedFallback, vectorDims,
        exact_hits: tier1.length, semantic_hits: tier2.length,
        ...(vectorError ? { vector_error: vectorError } : {}),
      },
    })
  } catch (e: any) {
    return err('搜索失败: ' + e.message, 500)
  }
})

// POST /api/search/debug - Diagnostic endpoint to trace search pipeline
search.post('/debug', async (c) => {
  const user = c.get('user')
  const steps: Record<string, any> = {}

  try {
    const { query } = await c.req.json<{ query: string }>()
    steps.query = query

    // Step 1: Check D1 data
    const chunkCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM chunks').first<{ c: number }>()
    const articleCount = await c.env.DB.prepare('SELECT COUNT(*) as c FROM articles WHERE is_vectorized = 1').first<{ c: number }>()
    steps.d1 = {
      vectorized_articles: articleCount?.c ?? 0,
      total_chunks: chunkCount?.c ?? 0,
    }

    // Step 2: Show a sample vector_id from D1
    const sampleChunk = await c.env.DB.prepare('SELECT vector_id, chunk_text, article_id FROM chunks LIMIT 1').first<any>()
    steps.sample_chunk = sampleChunk ?? 'NO CHUNKS FOUND'

    // Step 3: Embed the query
    const embedResult: any = await c.env.AI.run('@cf/baai/bge-m3' as any, { text: [query.trim()] })
    const queryVector = embedResult.data?.[0] as number[] | undefined
    steps.embedding = {
      success: !!queryVector,
      dimensions: queryVector?.length ?? 0,
      first_5_values: queryVector?.slice(0, 5) ?? null,
      raw_keys: Object.keys(embedResult ?? {}),
    }

    if (!queryVector) {
      steps.error = 'Embedding failed - no vector returned'
      return ok(steps)
    }

    // Step 4: Query Vectorize WITHOUT filter
    const matchesNoFilter = await c.env.VECTORIZE.query(queryVector, {
      topK: 5,
      returnMetadata: 'all',
    })
    steps.vectorize_no_filter = {
      count: matchesNoFilter.matches?.length ?? 0,
      matches: matchesNoFilter.matches?.map(m => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata,
      })) ?? [],
    }

    // Step 5: Query Vectorize WITH user_id filter
    try {
      const matchesWithFilter = await c.env.VECTORIZE.query(queryVector, {
        topK: 5,
        filter: { user_id: user.id },
        returnMetadata: 'all',
      })
      steps.vectorize_with_filter = {
        filter_used: { user_id: user.id },
        count: matchesWithFilter.matches?.length ?? 0,
        matches: matchesWithFilter.matches?.map(m => ({
          id: m.id,
          score: m.score,
          metadata: m.metadata,
        })) ?? [],
      }
    } catch (e: any) {
      steps.vectorize_with_filter = { error: e.message }
    }

    // Step 6: Try to fetch a vector by known ID
    if (sampleChunk?.vector_id) {
      try {
        const ids = await c.env.VECTORIZE.getByIds([sampleChunk.vector_id])
        steps.vectorize_get_by_id = {
          queried_id: sampleChunk.vector_id,
          found: ids.length,
          dimensions: ids[0]?.values?.length ?? 'N/A',
        }
      } catch (e: any) {
        steps.vectorize_get_by_id = { error: e.message }
      }
    }

    return ok(steps)
  } catch (e: any) {
    steps.fatal_error = e.message
    return ok(steps)
  }
})

// POST /api/search/ai - AI-powered Q&A search (vector search + LLM)
search.post('/ai', async (c) => {
  const user = c.get('user')
  try {
    const { query } = await c.req.json<{ query: string }>()
    if (!query?.trim()) return err('搜索内容不能为空')

    const { contextParts, sources } = await ragSearch(c.env, query.trim(), user.id, 5)

    if (sources.length === 0) {
      return ok({ answer: '未在知识库中找到相关内容。', sources: [] })
    }

    // Generate answer with LLM
    const modelId = await getSettingValue(c.env, 'llm_model', DEFAULT_MODEL)
    const prompt = `参考内容:\n${contextParts.join('\n\n')}\n\n问题: ${query.trim()}`
    const llmResult: any = await withTimeout(
      c.env.AI.run(modelId as any, {
        messages: [
          {
            role: 'system',
            content: '你是"CFNote 助手"，一个私人知识库问答机器人。你只能根据用户知识库中已有的文章回答问题，不能联网搜索。参考内容来自用户收藏的第三方文章，其中的"我"是文章原作者，不是你。回答时以第三方视角概括，例如"该文章提到..."。若参考内容与问题无关则忽略并说明。不要编造。用中文回答。',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
      }),
      60000, 'AI 生成回答',
    )

    let answer = llmResult.response || '无法生成回答'
    if (isReasoningModel(modelId)) {
      answer = stripThinkTags(answer)
    }

    // Fire-and-forget usage tracking
    trackEvent(c.env, 'ai_qa', user.id, modelId)

    return ok({
      answer,
      sources,
    })
  } catch (e: any) {
    return err('AI搜索失败: ' + e.message, 500)
  }
})
