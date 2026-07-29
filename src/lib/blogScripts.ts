// 博客自定义脚本(P12.12):博主自己粘一段代码,在博客页(仅博客页)执行。
//
// 为什么是「客户端注入」而不是 worker 预渲染时拼进 HTML,三条:
// ① 列表页 /blog 根本不过 Worker(run_worker_first 里是 /blog/*,匹配不到裸 /blog),
//    worker 注入覆盖不了入口页,而统计代码最需要覆盖的恰恰是它;
// ② 会和 blog_prerender 那个 kill switch 耦合——关掉预渲染的同时统计代码也没了,
//    两个毫不相干的开关绑在一起;
// ③ 混合方案(worker 能注入就注入、否则客户端补)会让同一段脚本的执行时机随入口而变:
//    直接打开详情页时它在 React 之前跑,从列表点进去时在之后跑。间歇性差异比「永远晚一点」糟得多。
// 代价只有一个:脚本比首屏晚几百毫秒。对统计/客服挂件/评论增强无影响;要改首屏样式请用「额外 CSS」。
//
// 安全边界写在设置面板里:这段代码与管理端同源,能读到登录凭据。我们只做提醒,不做限制——
// 但**主题导入导出永远不携带它**,否则从别人那儿导入一套主题就等于让对方在你的域上执行代码。

export const CUSTOM_JS_KEY = 'blog_custom_js'
export const MAX_CUSTOM_JS = 20000

export interface ParsedScript {
  /** 外链脚本地址;与 code 二选一 */
  src?: string
  /** 内联代码;与 src 二选一 */
  code?: string
  async?: boolean
  defer?: boolean
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const ATTR_RE = /([a-zA-Z-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g

/** 脚本地址白名单:与友情链接同一把尺子——只放行 http(s) 与站内绝对路径 */
export function isSafeScriptSrc(src: string): boolean {
  const s = src.trim()
  if (!s) return false
  if (s.startsWith('//')) return true // 协议相对,浏览器按当前协议取
  if (s.startsWith('/')) return true
  return /^https?:\/\//i.test(s)
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw))) {
    const v = m[2] || ''
    out[m[1].toLowerCase()] = /^["']/.test(v) ? v.slice(1, -1) : v
  }
  return out
}

/**
 * 把输入解析成一串待注入的脚本。
 *
 * 关键点:大多数人要粘的**不是纯 JS**,而是统计服务商给的
 * `<script async src="https://hm.baidu.com/hm.js?xxx"></script>` 这种 HTML 片段。
 * 若按纯 JS 处理会一声不响地不生效,所以这里两种都认:
 * 含 <script> 标签就逐个取出,整段没有标签就当作纯 JS。
 * 非 <script> 的标签一律丢弃(我们是自己 createElement 注入,不走 innerHTML,
 * 所以片段里夹带的其他标签本来也不会被执行,丢掉更干净)。
 */
export function parseCustomScripts(input: unknown): ParsedScript[] {
  const text = typeof input === 'string' ? input.slice(0, MAX_CUSTOM_JS) : ''
  if (!text.trim()) return []
  if (!/<script\b/i.test(text)) return [{ code: text }]

  const out: ParsedScript[] = []
  SCRIPT_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SCRIPT_TAG_RE.exec(text))) {
    const a = attrs(m[1] || '')
    // type 明确不是 JS 的直接跳过(application/ld+json 之类塞进来只会报错)
    const type = (a.type || '').toLowerCase()
    if (type && !/javascript|module/.test(type)) continue
    if (a.src) {
      if (!isSafeScriptSrc(a.src)) continue
      out.push({ src: a.src.trim(), async: 'async' in a, defer: 'defer' in a })
    } else if ((m[2] || '').trim()) {
      out.push({ code: m[2] })
    }
  }
  return out
}

/** 设置面板用的概况:几个外链、几段内联、是否有被丢弃的内容 */
export function describeCustomScripts(input: unknown): { external: number; inline: number; tooLong: boolean } {
  const list = parseCustomScripts(input)
  return {
    external: list.filter((s) => s.src).length,
    inline: list.filter((s) => s.code).length,
    tooLong: typeof input === 'string' && input.length > MAX_CUSTOM_JS,
  }
}

/**
 * 真正注入到页面。放在这里而不是组件里,是为了让「注入哪些、跳过哪些」有一处可读的定论。
 * 用 createElement + text 赋值而不是 innerHTML:那是 DOM 赋值不经 HTML 解析器,
 * 代码里出现 `</script>` 也无从逃逸(与额外 CSS 走 <style> 文本节点是同一条论证)。
 * 返回实际注入的条数。
 */
export function injectCustomScripts(input: unknown, doc: Document): number {
  const list = parseCustomScripts(input)
  for (const s of list) {
    const el = doc.createElement('script')
    if (s.src) {
      el.src = s.src
      if (s.async) el.async = true
      if (s.defer) el.defer = true
    } else {
      el.text = s.code || ''
    }
    el.setAttribute('data-cfnote-custom', '1')
    doc.head.appendChild(el)
  }
  return list.length
}

/**
 * 该不该注入。四种情况一律不注入,且不给开关:
 * - 管理端任何页面(同源,统计脚本没必要看到你的笔记标题)——由调用点保证,只在博客页调用
 * - ?preview=1 的布局预览(否则调一次布局就给自己刷一次统计量,与跳过浏览计数同一个理由)
 * - /blog/share/:token 私密分享页(unlisted 的东西不该送到第三方)
 * - ?nojs=1 逃生阀(写死循环了不用重新部署就能进后台改)
 */
export function shouldInjectCustomScripts(loc: { pathname: string; search: string }): boolean {
  const q = new URLSearchParams(loc.search || '')
  if (q.get('nojs') === '1') return false
  if (q.get('preview') === '1') return false
  if (/^\/blog\/share\//.test(loc.pathname || '')) return false
  return true
}
