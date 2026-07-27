// 评论(P11.2)纯逻辑:校验、2 层嵌套夹取、线程组装、蜜罐判定。
// 前端表单、管理端与 worker 复用;可单测(tests/comments.test.ts)。评论正文一律纯文本展示(不解析 markdown/HTML)。

export type CommentStatus = 'pending' | 'approved' | 'rejected'

export const MAX_NAME = 40
export const MAX_CONTENT = 2000
export const MAX_DEPTH = 2 // 顶层 + 一层回复(更深的回复归并到同一楼)

export interface CommentInput {
  name: string
  content: string
  email?: string
}

export interface ValidationResult {
  ok: boolean
  error?: string
}

/** 校验访客提交:昵称必填且 ≤MAX_NAME,正文非空且 ≤MAX_CONTENT,邮箱(可选)格式合法 */
export function validateCommentInput(input: CommentInput): ValidationResult {
  const name = (input.name || '').trim()
  const content = (input.content || '').trim()
  if (!name) return { ok: false, error: '请填写昵称' }
  if (name.length > MAX_NAME) return { ok: false, error: `昵称不超过 ${MAX_NAME} 字` }
  if (!content) return { ok: false, error: '评论内容不能为空' }
  if (content.length > MAX_CONTENT) return { ok: false, error: `评论不超过 ${MAX_CONTENT} 字` }
  const email = (input.email || '').trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '邮箱格式不正确' }
  return { ok: true }
}

/** 被回复评论的最小信息(用于夹取到 2 层) */
export interface ParentRef {
  id: number
  root_id: number | null
}

/**
 * 2 层夹取:顶层评论 parent/root 均为空(root 由 worker 插入后隐含为自身);
 * 回复任意评论都归到其顶层楼——parent_id 记录被回复者(用于「回复 @X」),root_id 取顶层祖先。
 */
export function resolveThreadParent(parent: ParentRef | null | undefined): { parent_id: number | null; root_id: number | null } {
  if (!parent) return { parent_id: null, root_id: null }
  return { parent_id: parent.id, root_id: parent.root_id ?? parent.id }
}

export interface FlatComment {
  id: number
  parent_id: number | null
  root_id: number | null
  author_name: string
  content: string
  is_admin?: number | boolean
  created_at: string
}

export interface ThreadedComment extends FlatComment {
  replies: FlatComment[]
}

/**
 * 扁平评论 → 「顶层 + 扁平回复」两层结构。
 * 顶层:parent_id 为空。回复:按 root_id(缺省回退 parent_id)归到对应顶层。均按时间升序。
 */
export function buildThread(flat: FlatComment[]): ThreadedComment[] {
  const tops: ThreadedComment[] = []
  const repliesByRoot = new Map<number, FlatComment[]>()
  for (const c of flat) {
    if (c.parent_id == null) {
      tops.push({ ...c, replies: [] })
    } else {
      const root = c.root_id ?? c.parent_id
      const arr = repliesByRoot.get(root)
      if (arr) arr.push(c)
      else repliesByRoot.set(root, [c])
    }
  }
  const byTime = (a: FlatComment, b: FlatComment) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id)
  tops.sort(byTime)
  for (const t of tops) t.replies = (repliesByRoot.get(t.id) || []).sort(byTime)
  return tops
}

/** 蜜罐:隐藏字段应保持为空;非空即判为机器人 */
export function isHoneypotTripped(hp: string | null | undefined): boolean {
  return !!(hp && hp.trim())
}

// 头像占位(P11.7):不接 Gravatar——那要把访客邮箱哈希发到第三方(公开评论接口本就不返回邮箱),
// 且国内访问不稳。改为「昵称首字 + 按昵称确定性取色」的本地色块:零请求、同一昵称永远同色。
// 博主等特殊身份的配色由调用方覆盖(博客页红、管理端绿),这里只管中性调色板。
const AVATAR_COLORS = [
  '#dc2626', '#ea580c', '#d97706', '#65a30d', '#16a34a', '#0d9488',
  '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#c026d3', '#db2777',
]

/** 昵称 → 头像占位的首字与背景色(首字用码点切分,兼容 emoji 昵称;空昵称回退「?」) */
export function commentAvatar(name: string | null | undefined): { char: string; color: string } {
  const s = (name || '').trim()
  const char = s ? Array.from(s)[0].toUpperCase() : '?'
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return { char, color: AVATAR_COLORS[h % AVATAR_COLORS.length] }
}
