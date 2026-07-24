import { describe, it, expect } from 'vitest'
import { toggleTaskItem, enableTaskCheckboxes } from '../src/lib/markdownTasks'

describe('toggleTaskItem', () => {
  const md = ['# 计划', '', '- [ ] 买菜', '- [x] 洗碗', '  - [ ] 嵌套项', '普通行', '1. [ ] 有序任务'].join('\n')

  it('按渲染顺序切换第 n 个任务', () => {
    expect(toggleTaskItem(md, 0)).toContain('- [x] 买菜')
    expect(toggleTaskItem(md, 1)).toContain('- [ ] 洗碗')
    expect(toggleTaskItem(md, 2)).toContain('  - [x] 嵌套项')
    expect(toggleTaskItem(md, 3)).toContain('1. [x] 有序任务')
  })

  it('围栏代码块内的任务样式行不计数', () => {
    const withCode = ['```', '- [ ] 代码里的假任务', '```', '- [ ] 真任务'].join('\n')
    const out = toggleTaskItem(withCode, 0)!
    expect(out).toContain('- [ ] 代码里的假任务')
    expect(out).toContain('- [x] 真任务')
  })

  it('引用块中的任务可切换', () => {
    expect(toggleTaskItem('> - [ ] 引用任务', 0)).toBe('> - [x] 引用任务')
  })

  it('大写 X 也能切回', () => {
    expect(toggleTaskItem('- [X] 完成', 0)).toBe('- [ ] 完成')
  })

  it('越界或无任务返回 null', () => {
    expect(toggleTaskItem(md, 99)).toBeNull()
    expect(toggleTaskItem('没有任务', 0)).toBeNull()
  })
})

describe('enableTaskCheckboxes', () => {
  it('去掉任务复选框的 disabled,不影响其他输入框', () => {
    const html = '<li><input checked="" disabled="" type="checkbox"> a</li><input disabled="" type="text">'
    const out = enableTaskCheckboxes(html)
    expect(out).toContain('<input checked="" type="checkbox">')
    expect(out).toContain('<input disabled="" type="text">')
  })
})
