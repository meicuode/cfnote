import { describe, it, expect } from 'vitest'
import { marked } from '../src/lib/markdown'

const html = (md: string) => marked(md) as string

describe('marked 数学公式扩展', () => {
  it('行内 $…$ 切为 cfnote-math 占位(display=0),不解析内部 markdown', () => {
    const out = html('能量 $E = mc^2$ 完')
    expect(out).toContain('class="cfnote-math"')
    expect(out).toContain('data-display="0"')
    expect(out).toContain('data-math="E = mc^2"')
  })

  it('下标不被当作强调:$a_b$ 原样进 data-math', () => {
    const out = html('$a_b + c_d$')
    expect(out).toContain('data-math="a_b + c_d"')
    expect(out).not.toContain('<em>')
  })

  it('块级 $$…$$ 切为 display=1 的 div', () => {
    const out = html('$$\n\\int_0^1 x\\,dx\n$$')
    expect(out).toContain('data-display="1"')
    expect(out).toMatch(/<div class="cfnote-math"/)
  })

  it('价格写法 $5 与 $10 不被误判为公式', () => {
    const out = html('花了 $5 与 $10')
    expect(out).not.toContain('cfnote-math')
    expect(out).toContain('$5')
  })

  it('特殊字符做属性转义(引号/尖括号)', () => {
    const out = html('$a < "b"$')
    expect(out).toContain('data-math="a &lt; &quot;b&quot;"')
  })
})
