import { Hono } from 'hono'
import { ok, err, ragSearch, withTimeout, stripThinkTags, logSystem, jinaSearch, trackEvent, type RagSource } from '../utils'
import { resolveTarget, streamChat, completeChat, sseResponse, modelLabel, allowPrivate, generationTimeout, type LlmTarget } from '../llm'
import { joinThink, type ChatMessage } from '../../src/lib/aiProtocol'
import type { AppEnv } from '../types'

export const conversations = new Hono<AppEnv>()

const WEB_SEARCH_TAG = '[WEB_SEARCH]'

const SYSTEM_PROMPT = [
  '你是"CFNote 助手"，一个私人知识库问答机器人。',
  '',
  '你的工作方式：',
  '1. 优先根据知识库中的参考内容回答用户的问题。',
  '2. 如果参考内容为空或与问题无关，告知用户知识库中未找到相关内容，并主动询问："需要我帮你联网搜索吗？"',
  '3. 只有当用户明确同意联网搜索（如"好的"、"搜一下"、"是"、"可以"等确认性回复），你才输出联网搜索标记。',
  '',
  '联网搜索标记格式（严格遵守）：',
  '- 当且仅当用户确认需要联网搜索时，你的整条回复只包含这一行：',
  '  [WEB_SEARCH]搜索关键词',
  '- 关键词应该是根据用户前面提出的问题提炼出的搜索引擎查询词。',
  '- 不要在任何其他情况下输出 [WEB_SEARCH] 标记。',
  '',
  '回答规则：',
  '- 如果用户问你是谁、你能做什么，如实回答：你可以基于知识库回答问题，找不到时可以联网搜索。',
  '- 如果提供了参考内容且与问题相关，以第三方视角概括，引用来源用 [1][2] 标注。',
  '- 参考内容来自用户收藏的第三方文章，其中的"我"是文章原作者，不是你。',
  '- 不要编造信息。',
  '- 如需展示表格，输出规范的 GFM Markdown 表格（表头行 + `|---|` 分隔行，每行列数一致），不要输出 HTML 表格或逐行罗列单元格。',
  '- 用中文回答。',
].join('\n')

const WEB_SEARCH_SUMMARY_PROMPT = [
  '你是"CFNote 助手"，正在使用联网搜索功能。',
  '',
  '回答规则：',
  '- 根据提供的网络搜索结果回答用户的问题。',
  '- 用 [1][2] 等标注引用了哪条搜索结果。',
  '- 如果搜索结果与问题无关，如实告知用户。',
  '- 不要编造信息。',
  '- 如需展示表格，输出规范的 GFM Markdown 表格（表头行 + `|---|` 分隔行，每行列数一致），不要输出 HTML 表格或逐行罗列单元格。',
  '- 用中文回答。',
].join('\n')

// GET /api/conversations - List conversations
conversations.get('/', async (c) => {
  const user = c.get('user')
  try {
    const rows = await c.env.DB.prepare(
      'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
    ).bind(user.id).all()
    return ok(rows.results)
  } catch (e: any) {
    return err('获取对话列表失败: ' + e.message, 500)
  }
})

// POST /api/conversations - Create new conversation
conversations.post('/', async (c) => {
  const user = c.get('user')
  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO conversations (user_id) VALUES (?)'
    ).bind(user.id).run()

    const conversation = await c.env.DB.prepare(
      'SELECT * FROM conversations WHERE id = ?'
    ).bind(result.meta.last_row_id).first()

    return ok(conversation)
  } catch (e: any) {
    return err('创建对话失败: ' + e.message, 500)
  }
})

// GET /api/conversations/:id - Get conversation with messages
conversations.get('/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  try {
    const conversation = await c.env.DB.prepare(
      'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
    ).bind(id, user.id).first()

    if (!conversation) return err('对话不存在', 404)

    const rows = await c.env.DB.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).bind(id).all()

    const messages = rows.results.map((m: any) => ({
      ...m,
      sources: m.sources ? JSON.parse(m.sources) : null,
    }))

    return ok({ conversation, messages })
  } catch (e: any) {
    return err('获取对话失败: ' + e.message, 500)
  }
})

// DELETE /api/conversations/:id - Delete conversation
conversations.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  try {
    const conversation = await c.env.DB.prepare(
      'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
    ).bind(id, user.id).first()

    if (!conversation) return err('对话不存在', 404)

    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id),
    ])

    return ok()
  } catch (e: any) {
    return err('删除对话失败: ' + e.message, 500)
  }
})

/**
 * 落库内容:有思考时 `<think>思考</think>正文`(前端 parseThink 拆开折叠显示)。
 * 只有思考没有正文(推理模型 token 用完还没想完)时把思考当正文存——P8 起 Workers AI 就是这样兜底的,
 * 否则这条消息刷新后是个空气泡。
 */
function assembleReply(think: string, text: string): string {
  const answer = text.trim()
  if (!answer) return think.trim()
  return joinThink(think.trim(), answer)
}

// ---- 共享:联网搜索 + LLM 总结(流式与非流式路径共用) ----
async function performWebSearch(
  env: AppEnv['Bindings'],
  target: LlmTarget,
  webQuery: string,
  originalQuestion: string,
): Promise<{ content: string; webSources: { title: string; url: string }[] }> {
  try {
    const results = await withTimeout(jinaSearch(env, webQuery), 30000, '联网搜索')
    if (results.length === 0) return { content: '联网搜索未找到相关结果。', webSources: [] }

    const webSources = results.map(r => ({ title: r.title, url: r.url }))
    const searchContext = results.map((r, i) =>
      `[${i + 1}] ${r.title}\n来源: ${r.url}\n${r.content}`
    ).join('\n\n')

    const r = await withTimeout(
      completeChat(env, target, [
        { role: 'system', content: WEB_SEARCH_SUMMARY_PROMPT },
        { role: 'user', content: `网络搜索结果:\n${searchContext}\n\n用户原始问题: ${originalQuestion}` },
      ]),
      generationTimeout(target), 'AI 总结搜索结果',
    )

    const content = assembleReply(r.think, r.text) || '无法总结搜索结果'
    return { content, webSources }
  } catch (e: any) {
    logSystem(env, 'error', 'web_search', '联网搜索失败', { error: e.message, query: webQuery })
    return { content: `联网搜索失败：${e.message}`, webSources: [] }
  }
}

// ---- 共享:助手消息落库 + 标题更新 + 埋点 + 构造响应负载 ----
async function persistAssistantMessage(
  env: AppEnv['Bindings'],
  opts: {
    conversationId: number
    userId: number
    userMessage: any
    assistantContent: string
    sources: RagSource[]
    isWebSearch: boolean
    webQuery: string
    webSources: { title: string; url: string }[]
    modelId: string
    userContent: string
  },
) {
  const { conversationId, userId, userMessage, assistantContent, sources, isWebSearch, webQuery, webSources, modelId, userContent } = opts

  const assistantMsgResult = await env.DB.prepare(
    'INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)'
  ).bind(
    conversationId,
    'assistant',
    assistantContent,
    sources.length > 0 && !isWebSearch ? JSON.stringify(sources) : null,
  ).run()

  const assistantMessage = await env.DB.prepare(
    'SELECT * FROM messages WHERE id = ?'
  ).bind(assistantMsgResult.meta.last_row_id).first<any>()

  let titleUpdated: string | undefined
  const msgCount = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ? AND role = ?'
  ).bind(conversationId, 'user').first<{ cnt: number }>()

  if (msgCount && msgCount.cnt === 1) {
    const newTitle = userContent.slice(0, 50)
    await env.DB.prepare(
      'UPDATE conversations SET title = ? WHERE id = ?'
    ).bind(newTitle, conversationId).run()
    titleUpdated = newTitle
  }

  trackEvent(env, isWebSearch ? 'web_search' : 'ai_chat', userId, modelId)

  return {
    user_message: { ...userMessage, sources: null },
    assistant_message: {
      ...assistantMessage,
      sources: assistantMessage.sources ? JSON.parse(assistantMessage.sources) : null,
    },
    title_updated: titleUpdated,
    ...(isWebSearch ? { is_web_search: true, web_query: webQuery, web_sources: webSources } : {}),
  }
}

// POST /api/conversations/:id/messages - Send message and get AI response.
// 请求体带 stream:true 时返回 SSE(think/delta/status/done/error 事件),否则返回原 JSON。
// 推理模型的思考内容以 think 事件流式下发,</think> 之后的正文走 delta。
conversations.post('/:id/messages', async (c) => {
  const user = c.get('user')
  const conversationId = Number(c.req.param('id'))

  try {
    const body = await c.req.json<{ content?: string; stream?: boolean; regenerate?: boolean }>()

    // 1. Verify conversation belongs to user
    const conversation = await c.env.DB.prepare(
      'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
    ).bind(conversationId, user.id).first<any>()

    if (!conversation) return err('对话不存在', 404)

    // 先确定用哪个模型:选中的渠道被删了之类的配置错误要在写入用户消息之前报,
    // 否则会留下一条没有回复的提问
    let target: LlmTarget
    try {
      target = await resolveTarget(c.env)
    } catch (e: any) {
      return err(e.message)
    }

    // 2. 确定触发消息:重新生成复用最后一条用户消息(并删除其后的旧回复),否则插入新消息
    let userMessage: any
    if (body.regenerate) {
      userMessage = await c.env.DB.prepare(
        "SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
      ).bind(conversationId).first<any>()
      if (!userMessage) return err('没有可重新生成的消息')
      await c.env.DB.prepare(
        'DELETE FROM messages WHERE conversation_id = ? AND id > ?'
      ).bind(conversationId, userMessage.id).run()
    } else {
      if (!body.content?.trim()) return err('消息内容不能为空')
      const userMsgResult = await c.env.DB.prepare(
        'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
      ).bind(conversationId, 'user', body.content!.trim()).run()
      userMessage = await c.env.DB.prepare(
        'SELECT * FROM messages WHERE id = ?'
      ).bind(userMsgResult.meta.last_row_id).first<any>()
    }
    const userContent: string = userMessage.content

    await c.env.DB.prepare(
      "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
    ).bind(conversationId).run()

    // 3. Load recent history (last 6 messages = 3 rounds)
    const historyRows = await c.env.DB.prepare(
      'SELECT role, content FROM messages WHERE conversation_id = ? AND id != ? ORDER BY created_at DESC LIMIT 6'
    ).bind(conversationId, userMessage.id).all()

    // 历史里的 <think> 段不再发给模型:对后续回答没用,外部渠道还按 token 计费
    const history: ChatMessage[] = historyRows.results.reverse().map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.role === 'assistant' ? stripThinkTags(m.content as string) : m.content as string,
    }))

    // 4. RAG search (skip for short follow-ups)
    let contextParts: string[] = []
    let sources: RagSource[] = []

    const isFollowUp = userContent.length <= 6 && history.length > 0
    if (!isFollowUp) {
      // 外部渠道且没开「允许私密笔记」时,私密笔记不进检索结果(检索结果会原样拼进提示词发出去)
      const rag = await ragSearch(c.env, userContent, user.id, 5, { includePrivate: allowPrivate(target) })
      contextParts = rag.contextParts
      sources = rag.sources
    }

    // 5. Build LLM messages
    let userPrompt: string
    if (contextParts.length > 0) {
      userPrompt = `参考内容:\n${contextParts.join('\n\n')}\n\n问题: ${userContent}`
    } else if (history.length > 0) {
      userPrompt = userContent
    } else {
      userPrompt = `（知识库中未找到相关参考内容）\n\n问题: ${userContent}`
    }

    const modelId = modelLabel(target)
    const llmMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userPrompt },
    ]

    const wantStream = !!body.stream

    // ---- 非流式路径(原有行为) ----
    if (!wantStream) {
      const result = await withTimeout(
        completeChat(c.env, target, llmMessages),
        generationTimeout(target), 'AI 生成回答',
      )

      let assistantContent = assembleReply(result.think, result.text) || '无法生成回答'

      let isWebSearchResponse = false
      let webQuery = ''
      let webSources: { title: string; url: string }[] = []

      // WEB_SEARCH 标记检测只看正文(推理模型的标记出现在思考段之后)
      const visibleContent = result.text.trim()
      if (visibleContent.startsWith(WEB_SEARCH_TAG)) {
        webQuery = visibleContent.slice(WEB_SEARCH_TAG.length).trim()
        if (webQuery) {
          isWebSearchResponse = true
          const r = await performWebSearch(c.env, target, webQuery, userContent)
          assistantContent = r.content
          webSources = r.webSources
        }
      }

      const payload = await persistAssistantMessage(c.env, {
        conversationId, userId: user.id, userMessage, assistantContent, sources,
        isWebSearch: isWebSearchResponse, webQuery, webSources, modelId, userContent: userContent,
      })
      return ok(payload)
    }

    // ---- 流式路径(SSE) ----
    // 思考内容以 think 事件下发,正文走 delta。think / text 怎么拆由 llm.ts 里各协议的适配器负责
    // (Workers AI 推理模型的 <think> 状态机也挪过去了),这里只管 WEB_SEARCH 门控和落库。
    const env = c.env
    return sseResponse(c.executionCtx, async (send) => {
      let think = ''
      let answer = ''
      let gateBuffer = ''
      let gateDecided = false
      let isWebSearch = false

      // WEB_SEARCH 门控:攒够字符判断开头是不是搜索标记,再决定是否向客户端转发增量
      const onAnswerToken = async (tok: string) => {
        answer += tok
        if (gateDecided) {
          if (!isWebSearch) await send({ type: 'delta', text: tok })
          return
        }
        gateBuffer += tok
        const t = gateBuffer.trimStart()
        if (t.length >= WEB_SEARCH_TAG.length) {
          gateDecided = true
          isWebSearch = t.startsWith(WEB_SEARCH_TAG)
          if (!isWebSearch) await send({ type: 'delta', text: gateBuffer })
        } else if (t.length > 0 && !WEB_SEARCH_TAG.startsWith(t)) {
          gateDecided = true
          await send({ type: 'delta', text: gateBuffer })
        }
      }

      for await (const ch of streamChat(env, target, llmMessages)) {
        if (ch.type === 'think') { think += ch.text; await send({ type: 'think', text: ch.text }) }
        else if (ch.type === 'text') await onAnswerToken(ch.text)
      }

      // 极短回复可能到结束都未触发门控判定
      if (!gateDecided && gateBuffer) {
        isWebSearch = gateBuffer.trimStart().startsWith(WEB_SEARCH_TAG)
        if (!isWebSearch) await send({ type: 'delta', text: gateBuffer })
      }
      if (!answer.trim() && !think.trim()) {
        answer = '无法生成回答'
        await send({ type: 'delta', text: answer })
      }

      let isWebSearchResponse = false
      let webQuery = ''
      let webSources: { title: string; url: string }[] = []
      // 落库内容:有思考时 <think>…</think>正文,只有思考时把思考当正文(见 assembleReply)
      let persistContent = assembleReply(think, answer)

      if (isWebSearch) {
        webQuery = answer.trim().slice(WEB_SEARCH_TAG.length).trim()
        if (webQuery) {
          isWebSearchResponse = true
          await send({ type: 'status', message: '正在联网搜索...' })
          const r = await performWebSearch(env, target, webQuery, userContent)
          persistContent = r.content
          webSources = r.webSources
          await send({ type: 'delta', text: persistContent })
        } else {
          // 标记后没有关键词:按普通回复处理,把被门控扣住的内容补发给客户端
          await send({ type: 'delta', text: answer })
        }
      }

      const payload = await persistAssistantMessage(env, {
        conversationId, userId: user.id, userMessage, assistantContent: persistContent, sources,
        isWebSearch: isWebSearchResponse, webQuery, webSources, modelId, userContent: userContent,
      })
      await send({ type: 'done', ...payload })
    })
  } catch (e: any) {
    return err('发送消息失败: ' + e.message, 500)
  }
})
