// ---- Cloudflare Bindings ----
export interface Env {
  DB: D1Database
  VECTORIZE: VectorizeIndex
  AI: Ai
  ANALYTICS?: AnalyticsEngineDataset
  BUCKET?: R2Bucket
  /** 静态资源绑定(wrangler.toml [assets] binding);博客详情页预渲染要取 SPA 外壳 */
  ASSETS?: Fetcher
  JWT_SECRET: string
  CF_API_TOKEN?: string
  CF_ACCOUNT_ID?: string
  STATS_TZ_OFFSET?: string
}

// ---- Database Models ----
export interface User {
  id: number
  username: string
  password_hash: string
  salt: string
  /** P16.9 token 世代:改密码 +1,旧 token 因 epoch 不匹配而失效。老库为 NULL,按 0 处理 */
  token_epoch?: number | null
  /** P17.2 恢复码(明文,128 bit hex)。老库补出来是 NULL,由设置页生成 */
  recovery_code?: string | null
  created_at: string
}

export interface Notebook {
  id: number
  user_id: number
  name: string
  description: string
  color: string
  article_count: number
  /** P16.1 层级:null/缺省=挂在根上。虚拟笔记本(id 为负)永远没有父 */
  parent_id?: number | null
  /** P16.5 私密笔记本(这一批只建列不生效) */
  is_private?: number
  created_at: string
  updated_at: string
}

export interface Article {
  id: number
  notebook_id: number
  user_id: number
  title: string
  content: string
  content_hash: string | null
  is_vectorized: number
  /** 公开到博客(与 is_private 互斥,服务端保证) */
  is_public: number
  /** 私有笔记:不可公开,列表标题前显示私有标识 */
  is_private: number
  published_at?: string | null
  views?: number
  /** P9 标签:JSON 数组文本(服务端 json_each 查询);空为 null */
  tags?: string | null
  /** P9 置顶:列表内排最前 */
  pinned?: number
  /** P9 回收站:非空表示已软删除(只读,30 天后自动清除) */
  deleted_at?: string | null
  /** P9.3 私密分享链接(/blog/share/<token>,单分享;私有/回收站自动撤销) */
  share_token?: string | null
  share_expires_at?: string | null
  /** P10 应用内提醒时间(ISO UTC,NULL=无提醒;移入回收站自动清空) */
  remind_at?: string | null
  /** 回收站列表附带的原笔记本名 */
  notebook?: string | null
  /** P16.2 深视图与私密审计视图附带的归属路径(「技术 / 前端」);浅视图不给 */
  notebook_path?: string
  /** P16.2 私密审计视图:1 = 所在笔记本本身就在私密分支里(私有是"应该的") */
  inherited?: number
  created_at: string
  updated_at: string
}

/**
 * 私密审计视图里的**例外项**(P16.2):在私密分支里却没上锁的活笔记。
 *
 * P16.5.1 的不变式保证这个数恒为 0,所以它不为 0 只有两种可能:
 * 有写入路径绕过了拉平(bug),或者有人在某一篇上显式取消过私有(需要定期复核的决定)。
 * 两种都得看得见——这正是这个视图存在的理由。
 */
export interface PrivateException {
  id: number
  notebook_id: number
  title: string
  is_public: number
  notebook_path: string
  updated_at: string
}

/** 解析 Article.tags(JSON 数组文本)为字符串数组,坏值容错为空 */
export function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return []
  try {
    const v = JSON.parse(tags)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** 「我的私有」虚拟笔记本:固定显示在笔记本列表末尾,筛选所有私有笔记(不落库) */
export const PRIVATE_NOTEBOOK: Notebook = {
  id: -1,
  user_id: 0,
  name: '我的私有',
  description: '所有私有笔记',
  color: '#f59e0b',
  article_count: 0,
  created_at: '',
  updated_at: '',
}

/** 「回收站」虚拟笔记本(P9):软删除的笔记,只读,可恢复/彻底删除 */
export const TRASH_NOTEBOOK: Notebook = {
  id: -2,
  user_id: 0,
  name: '回收站',
  description: '已删除的笔记,30 天后自动清除',
  color: '#9ca3af',
  article_count: 0,
  created_at: '',
  updated_at: '',
}

/** 标签虚拟视图 id(P9):name 字段即标签名 */
export const TAG_VIEW_ID = -3

export function tagNotebook(tag: string): Notebook {
  return { id: TAG_VIEW_ID, user_id: 0, name: tag, description: `标签「${tag}」`, color: '#10b981', article_count: 0, created_at: '', updated_at: '' }
}

export interface Chunk {
  id: number
  article_id: number
  chunk_index: number
  chunk_text: string
  vector_id: string
  created_at: string
}

export interface Conversation {
  id: number
  user_id: number
  title: string
  created_at: string
  updated_at: string
}

export interface Message {
  id: number
  conversation_id: number
  role: 'user' | 'assistant'
  content: string
  sources: SearchResult[] | null
  created_at: string
}

export interface SendMessageResponse {
  user_message: Message
  assistant_message: Message
  title_updated?: string
  is_web_search?: boolean
  web_query?: string
  web_sources?: { title: string; url: string }[]
}

// ---- API Types ----
export interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface SearchResult {
  article_id: number
  article_title: string
  notebook_name: string
  chunk_text: string
  score: number
  match?: 'vector' | 'keyword' | 'both'
}

/**
 * 默认搜索的一条结果(P17.5)。与 SearchResult 分开是因为它们的性质不同:
 * SearchResult 是 AI 对话的引用来源(一条 = 一个切片),这里一条 = 一篇文章,
 * 底下挂若干片段。硬合并成一个类型会让「chunk_text 到底是哪一段」永远含糊。
 */
export interface SearchHit {
  article_id: number
  article_title: string
  notebook_id: number
  notebook_name: string
  /** exact = 正文/标题里有你搜的词;semantic = 只是意思相近 */
  tier: 'exact' | 'semantic'
  /** 最高切片相似度。exact 层可能为 0(向量腿没召回它) */
  score: number
  snippets: { text: string; kind: 'exact' | 'semantic' }[]
  /** 还有几处匹配没展示 */
  more: number
}

export interface SearchResponse {
  results: SearchHit[]
  /** 服务端切好的查询词,前端拿它做高亮(不重复实现一遍切词) */
  terms: string[]
}

export interface AiSearchResult {
  answer: string
  sources: SearchResult[]
}

// ---- Frontend State ----
export interface AuthState {
  token: string | null
  username: string | null
}

// ---- System Logs ----
export interface SystemLog {
  id: number
  level: 'error' | 'warn' | 'info'
  source: string
  message: string
  detail: string | null
  created_at: string
}

export interface SystemLogsResponse {
  logs: SystemLog[]
  total: number
  limit: number
  offset: number
}

// ---- Settings ----
export interface Settings {
  llm_model: string
  [key: string]: string
}

export interface ModelInfo {
  id: string
  label: string
  description: string
  type: '通用' | '推理'
  cost: string
}

// ---- Stats ----
export interface StatsAiModel {
  modelId: string
  count: number
  neurons: number
  inputTokens: number
  outputTokens: number
}

export interface StatsAiUsage {
  neurons_today: number
  neurons_limit: number
  models: StatsAiModel[]
  daily: { date: string; neurons: number; count: number }[]
}

export interface StatsUsage {
  search_today: number
  search_7d: number
  search_total: number
  ai_qa_today: number
  ai_qa_7d: number
  ai_qa_total: number
  ai_chat_today: number
  ai_chat_7d: number
  ai_chat_total: number
  web_search_today: number
  web_search_7d: number
  web_search_total: number
  vectorize_total: number
  import_total: number
  model_usage: { model: string; today: number; week: number }[]
}

export interface Stats {
  notebooks: number
  articles: number
  articles_vectorized: number
  vectors_count: number
  vectors_limit: number
  vector_usage_percent: number
  ai_usage: StatsAiUsage | null
  usage: StatsUsage
  daily_trend: { date: string; search: number; ai_qa: number; ai_chat: number; web_search: number }[]
}
