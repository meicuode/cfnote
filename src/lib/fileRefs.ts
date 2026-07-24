// 附件链接双方案(P8.1,见 docs/file-manager.md):
// - 旧式(存量内容,继续支持):/api/files/<真实R2 key>,key = u{用户}/{32位随机}/{文件名}
// - 新式(P8.1 起生成):/api/afile/{文件id}/{文件名} —— 间接链接,真实 key 只存 files 表;
//   尾部文件名仅供扩展名识别(.xmind 卡片)与浏览器下载命名,服务端按 id 定位、忽略尾巴。
// 边车缩略图统一为「主文件链接 + .thumb.png」,两种方案同构,客户端拼接逻辑无需区分。

export const SIDECAR_SUFFIX = '.thumb.png'

const LEGACY_RE = /\/api\/files\/(u(\d+)\/[A-Za-z0-9]+\/[^\s)"'<>\]]+)/g
const AFILE_RE = /\/api\/afile\/(\d+)(?:\/[^\s)"'<>\]]*)?/g

export interface FileRefs {
  /** 旧式链接直接携带的真实 key(已 URL 解码) */
  keys: string[]
  /** 新式链接携带的文件 id(由调用方查 files 表换 key) */
  ids: number[]
}

/** 从 Markdown 内容提取附件引用;userId 过滤旧式 key 的属主前缀 */
export function parseFileRefs(content: string, userId?: number): FileRefs {
  const keys = new Set<string>()
  const ids = new Set<number>()
  let m: RegExpExecArray | null
  const legacy = new RegExp(LEGACY_RE.source, 'g')
  while ((m = legacy.exec(content || ''))) {
    if (userId !== undefined && Number(m[2]) !== userId) continue
    try { keys.add(decodeURIComponent(m[1])) } catch { keys.add(m[1]) }
  }
  const afile = new RegExp(AFILE_RE.source, 'g')
  while ((m = afile.exec(content || ''))) ids.add(Number(m[1]))
  return { keys: [...keys], ids: [...ids] }
}

/** 生成新式间接链接 */
export function buildAfileUrl(id: number, name: string): string {
  return `/api/afile/${id}/${encodeURIComponent(name)}`
}

/**
 * afile 路由尾巴分流:等于注册名 → 主文件;其余以 .thumb.png 结尾 → 边车缩略图。
 * 容忍改名后的陈旧尾巴(陈旧名 → 主文件,陈旧名.thumb.png → 边车);
 * 文件本身就叫 *.thumb.png 时尾巴与注册名相等,仍正确命中主文件。
 */
export function afileTailKind(tail: string, name: string): 'main' | 'sidecar' {
  if (tail === name) return 'main'
  return tail.endsWith(SIDECAR_SUFFIX) ? 'sidecar' : 'main'
}

export type FileCategory = 'image' | 'doc' | 'other'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i
const DOC_EXT = /\.(md|markdown|txt|pdf|docx?|xlsx?|csv|pptx?|rtf|json|ya?ml|xml|html?|css|jsx?|tsx?|py|java|go|rs|c|cpp|h|sh|sql|log)$/i

/** 分类推导(文件管理页与选择器按 图片/文档/其他 筛选) */
export function categorizeFile(name: string, contentType?: string | null): FileCategory {
  if (contentType?.startsWith('image/')) return 'image'
  if (IMAGE_EXT.test(name)) return 'image'
  if (contentType === 'application/pdf' || contentType?.startsWith('text/')) return 'doc'
  if (DOC_EXT.test(name)) return 'doc'
  return 'other'
}
