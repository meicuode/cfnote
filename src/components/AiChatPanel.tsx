import { useState, useEffect, useRef, useCallback } from 'react'
import { marked } from '../lib/markdown'
import { useApi } from '../hooks/useApi'
import type { Conversation, Message, SendMessageResponse, Notebook, Article } from '../types'

interface Props {
  token: string
  onClose: () => void
  onOpenArticle: (id: number, snippet?: string) => void
}

export default function AiChatPanel({ token, onClose, onOpenArticle }: Props) {
  const api = useApi(token)
  const [view, setView] = useState<'list' | 'chat'>('list')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendingLong, setSendingLong] = useState(false)
  const [streamingStarted, setStreamingStarted] = useState(false)
  const [webSearching, setWebSearching] = useState(false)
  const [copiedMsgId, setCopiedMsgId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const sendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Web search save-to-note state
  const [webSearchMsgIds, setWebSearchMsgIds] = useState<Set<number>>(new Set())
  const [webSourcesMap, setWebSourcesMap] = useState<Map<number, { title: string; url: string }[]>>(new Map())
  const [savingMsgId, setSavingMsgId] = useState<number | null>(null)
  const [savedMsgIds, setSavedMsgIds] = useState<Set<number>>(new Set())
  const [saveNotebooks, setSaveNotebooks] = useState<Notebook[]>([])
  const [saveNotebookId, setSaveNotebookId] = useState<number | null>(null)
  const [saveTitle, setSaveTitle] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Load conversation list
  const loadConversations = useCallback(async () => {
    const res = await api.get<Conversation[]>('/conversations')
    if (res.ok && res.data) setConversations(res.data)
  }, [api])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // Open a conversation
  const openConversation = async (conv: Conversation) => {
    setLoading(true)
    const res = await api.get<{ conversation: Conversation; messages: Message[] }>(`/conversations/${conv.id}`)
    if (res.ok && res.data) {
      setActiveConversation(res.data.conversation)
      setMessages(res.data.messages)
      setView('chat')
    }
    setLoading(false)
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  // Create new conversation and enter chat
  const newConversation = async () => {
    const res = await api.post<Conversation>('/conversations', {})
    if (res.ok && res.data) {
      setActiveConversation(res.data)
      setMessages([])
      setView('chat')
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  // Delete a conversation
  const deleteConversation = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    await api.del(`/conversations/${id}`)
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeConversation?.id === id) {
      setActiveConversation(null)
      setMessages([])
      setView('list')
    }
  }

  // Send / regenerate (streaming SSE with JSON fallback)
  const runChat = async (opts: { content?: string; regenerate?: boolean }) => {
    if (!activeConversation || sending) return
    const content = opts.content ?? ''
    const convId = activeConversation.id
    setSending(true)
    setSendingLong(false)
    setStreamingStarted(false)
    setWebSearching(false)
    sendingTimerRef.current = setTimeout(() => setSendingLong(true), 5000)

    // 重新生成:本地先移除末尾的旧助手回复;发送:乐观插入用户消息
    const tempUserMsg: Message = {
      id: -Date.now(),
      conversation_id: convId,
      role: 'user',
      content,
      sources: null,
      created_at: new Date().toISOString(),
    }
    const tempAssistantId = -(Date.now() + 1)
    if (opts.regenerate) {
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        return last?.role === 'assistant' ? prev.slice(0, -1) : prev
      })
    } else {
      setMessages((prev) => [...prev, tempUserMsg])
    }

    const applyDone = (data: SendMessageResponse) => {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempUserMsg.id && m.id !== tempAssistantId && m.id !== data.user_message.id),
        data.user_message,
        data.assistant_message,
      ])
      if (data.is_web_search) {
        const msgId = data.assistant_message.id
        setWebSearchMsgIds((prev) => new Set(prev).add(msgId))
        if (data.web_sources?.length) {
          setWebSourcesMap((prev) => new Map(prev).set(msgId, data.web_sources!))
        }
      }
      if (data.title_updated) {
        setActiveConversation((prev) => prev ? { ...prev, title: data.title_updated! } : prev)
        setConversations((prev) =>
          prev.map((c) => c.id === convId ? { ...c, title: data.title_updated! } : c)
        )
      }
    }

    const applyError = (message: string) => {
      const errorMsg: Message = {
        id: -(Date.now() + 2),
        conversation_id: convId,
        role: 'assistant',
        content: `**请求失败**：${message || '未知错误'}`,
        sources: null,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempUserMsg.id && m.id !== tempAssistantId),
        ...(opts.regenerate ? [] : [{ ...tempUserMsg, id: -(Date.now() + 3) }]),
        errorMsg,
      ])
    }

    try {
      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(opts.regenerate ? { regenerate: true, stream: true } : { content, stream: true }),
      })

      const ctype = res.headers.get('Content-Type') || ''

      if (ctype.includes('text/event-stream') && res.body) {
        // ---- 流式:逐事件解析,think/delta 渐进渲染 ----
        let acc = ''
        let thinkAcc = ''
        let donePayload: SendMessageResponse | null = null
        let errorMessage = ''
        let placeholderAdded = false

        // 临时消息内容:有思考时拼成 <think>...</think>正文,复用 parseThink 渲染
        const updateTemp = () => {
          const content = thinkAcc ? `<think>${thinkAcc}</think>${acc}` : acc
          setStreamingStarted(true)
          if (!placeholderAdded) {
            placeholderAdded = true
            setMessages((prev) => [...prev, {
              id: tempAssistantId,
              conversation_id: convId,
              role: 'assistant',
              content,
              sources: null,
              created_at: new Date().toISOString(),
            }])
          } else {
            setMessages((prev) => prev.map((m) => m.id === tempAssistantId ? { ...m, content } : m))
          }
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const l = line.trim()
            if (!l.startsWith('data:')) continue
            let evt: any
            try { evt = JSON.parse(l.slice(5).trim()) } catch { continue }
            if (evt.type === 'delta') {
              acc += evt.text
              updateTemp()
            } else if (evt.type === 'think') {
              thinkAcc += evt.text
              updateTemp()
            } else if (evt.type === 'status') {
              // 真实的联网搜索状态事件(不再靠超时猜测)
              setWebSearching(true)
              setStreamingStarted(false)
            } else if (evt.type === 'done') {
              donePayload = evt as SendMessageResponse
            } else if (evt.type === 'error') {
              errorMessage = evt.message
            }
          }
        }

        if (donePayload) applyDone(donePayload)
        else applyError(errorMessage || '连接中断，请刷新对话查看结果')
      } else {
        // ---- 非流式(推理模型等):原 JSON 行为 ----
        const json = await res.json() as any
        if (json.ok && json.data) applyDone(json.data as SendMessageResponse)
        else applyError(json.error || `请求失败 (${res.status})`)
      }
    } catch (e: any) {
      applyError(e.message)
    }

    setSending(false)
    setSendingLong(false)
    setStreamingStarted(false)
    setWebSearching(false)
    if (sendingTimerRef.current) { clearTimeout(sendingTimerRef.current); sendingTimerRef.current = null }
  }

  const sendMessage = async () => {
    if (!input.trim()) return
    const content = input.trim()
    setInput('')
    await runChat({ content })
  }

  const regenerateLast = () => runChat({ regenerate: true })

  const copyMessage = async (msg: Message) => {
    try {
      await navigator.clipboard.writeText(parseThink(msg.content).answer || msg.content)
      setCopiedMsgId(msg.id)
      setTimeout(() => setCopiedMsgId((prev) => prev === msg.id ? null : prev), 2000)
    } catch { /* 剪贴板权限被拒 */ }
  }

  // Save web search result as note
  const openSaveDialog = async (msgId: number) => {
    setSavingMsgId(msgId)
    setSaveTitle('')
    setSaveNotebookId(null)
    const res = await api.get<Notebook[]>('/notebooks')
    if (res.ok && res.data) {
      setSaveNotebooks(res.data)
      if (res.data.length > 0) setSaveNotebookId(res.data[0].id)
    }
  }

  const doSave = async () => {
    if (!saveNotebookId || !savingMsgId || saveBusy) return
    const msg = messages.find((m) => m.id === savingMsgId)
    if (!msg) return
    setSaveBusy(true)
    const title = saveTitle.trim() || '联网搜索笔记'
    const res = await api.post<Article>('/articles', {
      notebook_id: saveNotebookId,
      title,
      content: msg.content,
    })
    if (res.ok) {
      setSavedMsgIds((prev) => new Set(prev).add(savingMsgId))
      setSavingMsgId(null)
    }
    setSaveBusy(false)
  }

  // Back to list
  const goBack = () => {
    setView('list')
    setActiveConversation(null)
    setMessages([])
    setWebSearchMsgIds(new Set())
    setWebSourcesMap(new Map())
    setSavedMsgIds(new Set())
    setSavingMsgId(null)
    loadConversations()
  }

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr + 'Z')
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 86400000) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  const renderMarkdown = (text: string) => {
    return { __html: marked.parse(text) as string }
  }

  // 拆分思考过程与正文(推理模型输出 <think>...</think> 前缀,后端已规范化)
  const parseThink = (content: string): { think: string | null; answer: string } => {
    if (!content.startsWith('<think>')) return { think: null, answer: content }
    const end = content.indexOf('</think>')
    if (end < 0) return { think: content.slice('<think>'.length).trim(), answer: '' }
    return {
      think: content.slice('<think>'.length, end).trim(),
      answer: content.slice(end + '</think>'.length).trim(),
    }
  }

  // 助手消息:把 [n] 引用渲染为可点击元素(知识库来源打开文章,联网来源打开 URL)
  const renderAssistant = (msg: Message) => {
    const web = webSourcesMap.get(msg.id)
    const n = web?.length ?? msg.sources?.length ?? 0
    let text = parseThink(msg.content).answer
    if (n > 0) {
      text = text.replace(/\[(\d+)\]/g, (m, d) => {
        const i = Number(d)
        return i >= 1 && i <= n ? `<sup class="cfnote-cite" data-cite="${i}">[${i}]</sup>` : m
      })
    }
    return { __html: marked.parse(text) as string }
  }

  const handleCiteClick = (msg: Message) => (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('.cfnote-cite') as HTMLElement | null
    if (!el) return
    const i = Number(el.dataset.cite) - 1
    const web = webSourcesMap.get(msg.id)
    if (web?.[i]) { window.open(web[i].url, '_blank', 'noreferrer'); return }
    if (msg.sources?.[i]) onOpenArticle(msg.sources[i].article_id, msg.sources[i].chunk_text)
  }

  // ---- List View ----
  if (view === 'list') {
    return (
      <div className="h-full flex flex-col bg-gray-50/70">
        {/* Header */}
        <div className="h-13 border-b border-gray-200 flex items-center px-4 shrink-0 bg-white">
          <svg className="w-5 h-5 text-emerald-600 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span className="font-semibold text-sm text-gray-900 flex-1">AI 助手</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* New conversation button */}
        <div className="p-3">
          <button
            onClick={newConversation}
            className="w-full flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg py-2 text-sm font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新对话
          </button>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {conversations.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              <p className="text-sm">还没有对话</p>
              <p className="text-xs mt-1">点击上方按钮开始新对话</p>
            </div>
          ) : (
            <div className="space-y-1">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => openConversation(conv)}
                  className="group w-full text-left bg-white hover:bg-gray-100 rounded-lg px-3 py-2.5 transition-colors relative"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900 truncate pr-8">{conv.title}</span>
                    <span className="text-xs text-gray-400 shrink-0">{formatTime(conv.updated_at)}</span>
                  </div>
                  <button
                    onClick={(e) => deleteConversation(conv.id, e)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-red-100 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ---- Chat View ----
  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-13 border-b border-gray-200 flex items-center px-3 shrink-0">
        <button onClick={goBack} className="p-1 rounded hover:bg-gray-100 text-gray-500 mr-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-medium text-gray-900 truncate flex-1">
          {activeConversation?.title || '新对话'}
        </span>
        <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {loading ? (
          <div className="text-center py-8">
            <div className="inline-block w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">向 AI 助手提问吧</p>
            <p className="text-xs mt-1">基于知识库回答，或输入"搜索 xxx"联网查找</p>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div key={msg.id} className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] ${msg.role === 'user' ? 'order-1' : ''}`}>
                {/* Web search badge */}
                {msg.role === 'assistant' && webSearchMsgIds.has(msg.id) && (
                  <div className="flex items-center gap-1 mb-1">
                    <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                    </svg>
                    <span className="text-[10px] text-blue-500 font-medium">联网搜索</span>
                  </div>
                )}

                {/* 思考过程(推理模型,折叠展示;流式生成中默认展开) */}
                {msg.role === 'assistant' && parseThink(msg.content).think && (
                  <details
                    key={`think-${msg.id}-${msg.id < 0 ? 'open' : 'closed'}`}
                    open={msg.id < 0}
                    className="mb-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5"
                  >
                    <summary className="cursor-pointer select-none text-gray-400 hover:text-gray-600">
                      💭 思考过程{msg.id < 0 && !parseThink(msg.content).answer ? '(思考中...)' : ''}
                    </summary>
                    <div className="mt-1.5 whitespace-pre-wrap leading-relaxed text-gray-500 max-h-60 overflow-y-auto">
                      {parseThink(msg.content).think}
                    </div>
                  </details>
                )}

                {(msg.role === 'user' || parseThink(msg.content).answer || msg.id > 0) && (
                <div
                  className={`rounded-xl px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-emerald-500 text-white'
                      : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div
                      className="cfnote-preview prose prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                      onClick={handleCiteClick(msg)}
                      dangerouslySetInnerHTML={renderAssistant(msg)}
                    />
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                </div>
                )}

                {/* 复制 / 重新生成(仅已落库的助手消息;重新生成只对最后一条) */}
                {msg.role === 'assistant' && msg.id > 0 && (
                  <div className="flex items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => copyMessage(msg)}
                      className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                    >
                      {copiedMsgId === msg.id ? (
                        <>
                          <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          已复制
                        </>
                      ) : (
                        <>
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          复制
                        </>
                      )}
                    </button>
                    {idx === messages.length - 1 && !sending && (
                      <button
                        onClick={regenerateLast}
                        className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        重新生成
                      </button>
                    )}
                  </div>
                )}

                {/* Sources */}
                {msg.sources && msg.sources.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {msg.sources.map((s, i) => (
                      <button
                        key={`${s.article_id}-${i}`}
                        onClick={() => onOpenArticle(s.article_id, s.chunk_text)}
                        className="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-md px-2 py-0.5 transition-colors truncate max-w-[180px]"
                        title={s.article_title}
                      >
                        [{i + 1}] {s.article_title}
                      </button>
                    ))}
                  </div>
                )}

                {/* Web sources */}
                {webSourcesMap.has(msg.id) && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {webSourcesMap.get(msg.id)!.map((ws, i) => (
                      <a
                        key={`${ws.url}-${i}`}
                        href={ws.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-md px-2 py-0.5 transition-colors truncate max-w-[200px] inline-flex items-center gap-0.5"
                        title={ws.url}
                      >
                        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                        [{i + 1}] {ws.title || ws.url}
                      </a>
                    ))}
                  </div>
                )}

                {/* Save as note button for web search results */}
                {msg.role === 'assistant' && webSearchMsgIds.has(msg.id) && (
                  <div className="mt-2">
                    {savedMsgIds.has(msg.id) ? (
                      <span className="text-xs text-emerald-600 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        已保存为笔记
                      </span>
                    ) : savingMsgId === msg.id ? (
                      <div className="bg-gray-50 rounded-lg p-2 space-y-2">
                        <select
                          value={saveNotebookId ?? ''}
                          onChange={(e) => setSaveNotebookId(Number(e.target.value))}
                          className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white"
                        >
                          {saveNotebooks.map((nb) => (
                            <option key={nb.id} value={nb.id}>{nb.name}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder="笔记标题..."
                          value={saveTitle}
                          onChange={(e) => setSaveTitle(e.target.value)}
                          className="w-full text-xs border border-gray-200 rounded px-2 py-1"
                        />
                        <div className="flex gap-1.5">
                          <button
                            onClick={doSave}
                            disabled={!saveNotebookId || saveBusy}
                            className="flex-1 text-xs bg-emerald-500 hover:bg-emerald-600 text-white rounded py-1 disabled:opacity-50 transition-colors"
                          >
                            {saveBusy ? '保存中...' : '保存'}
                          </button>
                          <button
                            onClick={() => setSavingMsgId(null)}
                            className="text-xs text-gray-400 hover:text-gray-600 px-2"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => openSaveDialog(msg.id)}
                        className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                        </svg>
                        保存为笔记
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {/* Sending indicator(流式内容开始渲染后隐藏) */}
        {sending && !streamingStarted && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-xl px-4 py-3">
              {webSearching ? (
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-xs text-blue-600">联网搜索中...</span>
                </div>
              ) : sendingLong ? (
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-xs text-gray-500">生成中，请稍候...</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 p-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
            placeholder={'输入问题，或"搜索 xxx"联网查找...'}
            disabled={sending}
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 disabled:opacity-50 bg-white"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            className="p-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-500 text-white rounded-lg transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
