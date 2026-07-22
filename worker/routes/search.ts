import { Hono } from 'hono'
import { ok, err, ragSearch, withTimeout, getSettingValue, DEFAULT_MODEL, isReasoningModel, stripThinkTags, trackEvent } from '../utils'
import type { AppEnv } from '../types'

export const search = new Hono<AppEnv>()

const RRF_K = 60

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

// 关键词命中时从正文摘录片段(首个命中位置前后)
export function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase()
  let idx = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0) return content.slice(0, 160)
  const start = Math.max(0, idx - 40)
  const end = Math.min(content.length, idx + 120)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}

type SearchItem = {
  article_id: number
  article_title: string
  notebook_id: number
  notebook_name: string
  chunk_text: string
  score: number
}

// POST /api/search - Hybrid search: vector + keyword (LIKE), merged with RRF.
// 不用 FTS5:默认分词器不切中文,trigram 要求查询≥3字符;单用户规模 LIKE 全扫足够且对中文子串天然正确。
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
    const vectorLeg = async (): Promise<SearchItem[]> => {
      try {
        const embedResult: any = await c.env.AI.run('@cf/baai/bge-m3' as any, { text: [q] })
        const queryVector = embedResult?.data?.[0] as number[] | undefined
        if (!queryVector || queryVector.length === 0) {
          vectorError = 'embedding empty'
          return []
        }
        vectorDims = queryVector.length

        const filter: Record<string, number> = { user_id: user.id }
        if (notebook_id) filter.notebook_id = notebook_id

        let matches = await c.env.VECTORIZE.query(queryVector, { topK: 10, filter, returnMetadata: 'all' })
        if (!matches.matches || matches.matches.length === 0) {
          matches = await c.env.VECTORIZE.query(queryVector, { topK: 10, returnMetadata: 'all' })
          usedFallback = true
        }
        if (!matches.matches) return []

        const results: SearchItem[] = []
        for (const match of matches.matches) {
          const articleId = match.metadata?.article_id as number
          const chunkIndex = match.metadata?.chunk_index as number
          if (!articleId && articleId !== 0) continue

          const article = await c.env.DB.prepare(
            `SELECT a.id, a.title, a.notebook_id, n.name as notebook_name
             FROM articles a LEFT JOIN notebooks n ON a.notebook_id = n.id
             WHERE a.id = ?`
          ).bind(articleId).first<any>()

          const chunk = await c.env.DB.prepare(
            'SELECT chunk_text FROM chunks WHERE article_id = ? AND chunk_index = ?'
          ).bind(articleId, chunkIndex).first<{ chunk_text: string }>()

          if (article && chunk) {
            if (usedFallback && notebook_id && article.notebook_id !== notebook_id) continue
            results.push({
              article_id: article.id,
              article_title: article.title,
              notebook_id: article.notebook_id,
              notebook_name: article.notebook_name || '',
              chunk_text: chunk.chunk_text,
              score: match.score,
            })
          }
        }

        // 按文章去重取最高分,按分数排序
        const seen = new Map<number, SearchItem>()
        for (const r of results) {
          const existing = seen.get(r.article_id)
          if (!existing || r.score > existing.score) seen.set(r.article_id, r)
        }
        return [...seen.values()].sort((a, b) => b.score - a.score)
      } catch (e: any) {
        vectorError = e.message
        return []
      }
    }

    // ---- 关键词召回(LIKE,标题命中权重高于正文) ----
    const keywordLeg = async (): Promise<SearchItem[]> => {
      if (terms.length === 0) return []
      let sql = `SELECT a.id, a.title, a.content, a.notebook_id, n.name as notebook_name
                 FROM articles a LEFT JOIN notebooks n ON a.notebook_id = n.id
                 WHERE a.user_id = ?`
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
      const scored = (rows.results ?? []).map((a: any) => {
        let s = 0
        const titleLower = (a.title as string).toLowerCase()
        const contentLower = (a.content as string).toLowerCase()
        for (const t of terms) {
          const tl = t.toLowerCase()
          if (titleLower.includes(tl)) s += 3
          let cnt = 0
          let i = contentLower.indexOf(tl)
          while (i >= 0 && cnt < 5) {
            cnt++
            i = contentLower.indexOf(tl, i + tl.length)
          }
          s += cnt
        }
        return { a, s }
      }).filter((x: any) => x.s > 0)
      scored.sort((x: any, y: any) => y.s - x.s)

      return scored.map(({ a }: any) => ({
        article_id: a.id,
        article_title: a.title,
        notebook_id: a.notebook_id,
        notebook_name: a.notebook_name || '',
        chunk_text: makeSnippet(a.content, terms),
        score: 0,
      }))
    }

    const [vectorList, keywordList] = await Promise.all([vectorLeg(), keywordLeg()])

    // ---- RRF 融合(k=60),按文章合并 ----
    const merged = new Map<number, { item: SearchItem; rrf: number; match: 'vector' | 'keyword' | 'both' }>()
    vectorList.forEach((r, i) => merged.set(r.article_id, { item: r, rrf: 1 / (RRF_K + i + 1), match: 'vector' }))
    keywordList.forEach((r, i) => {
      const ex = merged.get(r.article_id)
      if (ex) {
        ex.rrf += 1 / (RRF_K + i + 1)
        ex.match = 'both'
      } else {
        merged.set(r.article_id, { item: r, rrf: 1 / (RRF_K + i + 1), match: 'keyword' })
      }
    })

    const final = [...merged.values()]
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, 10)
      .map((x) => ({ ...x.item, match: x.match }))

    trackEvent(c.env, 'search', user.id)

    return ok({
      results: final,
      debug: { usedFallback, vectorDims, vector_hits: vectorList.length, keyword_hits: keywordList.length, ...(vectorError ? { vector_error: vectorError } : {}) },
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
