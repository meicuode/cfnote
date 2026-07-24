// GFM 任务勾选(P9.2,tests/markdownTasks.test.ts 覆盖):
// 预览中点击第 index 个任务复选框 → 回写源文对应的 [ ]/[x] 标记。
// 计数必须与 marked 的渲染顺序一致:跳过围栏代码块内的行,否则索引错位。

const FENCE_RE = /^\s*(```|~~~)/
// 允许引用块前缀(> )与有序/无序列表;GFM 要求 ] 后接空白或行尾
const TASK_RE = /^((?:\s|>)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?=\s|$))/

/** 切换源文中第 index 个(按渲染顺序)任务项的勾选态;越界或无任务返回 null */
export function toggleTaskItem(md: string, index: number): string | null {
  const lines = md.split('\n')
  let inFence = false
  let fenceMark = ''
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (f) {
      if (!inFence) {
        inFence = true
        fenceMark = f[1]
      } else if (f[1] === fenceMark) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = TASK_RE.exec(line)
    if (!m) continue
    if (n === index) {
      const next = m[2] === ' ' ? 'x' : ' '
      lines[i] = line.slice(0, m[1].length) + next + line.slice(m[1].length + 1)
      return lines.join('\n')
    }
    n++
  }
  return null
}

/** marked 渲染出的任务复选框带 disabled;编辑器预览中去掉使其可点击(博客侧保持只读不经过此函数) */
export function enableTaskCheckboxes(html: string): string {
  return html.replace(/<input((?:(?!>).)*type="checkbox"(?:(?!>).)*)>/g, (m) =>
    m.replace(/\sdisabled(?:="")?/g, '')
  )
}
