import { describe, it, expect } from 'vitest'
import {
  parseCustomScripts, describeCustomScripts, isSafeScriptSrc, shouldInjectCustomScripts,
  MAX_CUSTOM_JS,
} from '../src/lib/blogScripts'

describe('parseCustomScripts', () => {
  it('纯 JS 原样当作一段内联代码', () => {
    const r = parseCustomScripts('console.log(1)')
    expect(r).toEqual([{ code: 'console.log(1)' }])
  })

  it('识别服务商给的 <script src> 片段(大多数人粘的是这个,按纯 JS 处理会一声不响不生效)', () => {
    const r = parseCustomScripts('<script async src="https://hm.baidu.com/hm.js?abc"></script>')
    expect(r).toHaveLength(1)
    expect(r[0].src).toBe('https://hm.baidu.com/hm.js?abc')
    expect(r[0].async).toBe(true)
    expect(r[0].defer).toBeFalsy()
  })

  it('一段里混着外链与内联时逐个取出,顺序保持', () => {
    const r = parseCustomScripts(`
      <script src="/a.js"></script>
      <script>window.x=1</script>
    `)
    expect(r.map((s) => s.src || s.code?.trim())).toEqual(['/a.js', 'window.x=1'])
  })

  it('丢弃非 script 标签(我们走 createElement,片段里夹带的标签本来也不会执行)', () => {
    const r = parseCustomScripts('<img src=x onerror=alert(1)><script>ok()</script>')
    expect(r).toHaveLength(1)
    expect(r[0].code?.trim()).toBe('ok()')
  })

  it('挡掉 javascript: 之类的脚本地址', () => {
    expect(parseCustomScripts('<script src="javascript:alert(1)"></script>')).toEqual([])
    expect(isSafeScriptSrc('javascript:alert(1)')).toBe(false)
    expect(isSafeScriptSrc('https://a.com/x.js')).toBe(true)
    expect(isSafeScriptSrc('//cdn.a.com/x.js')).toBe(true) // 协议相对
    expect(isSafeScriptSrc('/local.js')).toBe(true)
    expect(isSafeScriptSrc('')).toBe(false)
  })

  it('type 明确不是 JS 的跳过(ld+json 塞进来只会报错)', () => {
    expect(parseCustomScripts('<script type="application/ld+json">{}</script>')).toEqual([])
    expect(parseCustomScripts('<script type="module">import "./a.js"</script>')).toHaveLength(1)
  })

  it('空内容不产出空脚本节点', () => {
    expect(parseCustomScripts('')).toEqual([])
    expect(parseCustomScripts('   ')).toEqual([])
    expect(parseCustomScripts('<script></script>')).toEqual([])
    expect(parseCustomScripts(null)).toEqual([])
  })

  it('超长输入截断到上限', () => {
    const long = 'a'.repeat(MAX_CUSTOM_JS + 100)
    expect(parseCustomScripts(long)[0].code!.length).toBe(MAX_CUSTOM_JS)
    expect(describeCustomScripts(long).tooLong).toBe(true)
  })

  it('describeCustomScripts 数外链与内联', () => {
    const info = describeCustomScripts('<script src="/a.js"></script><script>x()</script>')
    expect(info).toEqual({ external: 1, inline: 1, tooLong: false })
  })
})

describe('shouldInjectCustomScripts', () => {
  it('普通博客页注入', () => {
    expect(shouldInjectCustomScripts({ pathname: '/blog', search: '' })).toBe(true)
    expect(shouldInjectCustomScripts({ pathname: '/blog/12', search: '?tag=x' })).toBe(true)
  })

  it('布局预览不注入(否则调一次布局就给自己刷一次统计量)', () => {
    expect(shouldInjectCustomScripts({ pathname: '/blog', search: '?preview=1' })).toBe(false)
  })

  it('私密分享页不注入(unlisted 的内容不该送到第三方)', () => {
    expect(shouldInjectCustomScripts({ pathname: '/blog/share/abc123', search: '' })).toBe(false)
  })

  it('?nojs=1 是逃生阀:脚本写崩了用它打开再回后台改', () => {
    expect(shouldInjectCustomScripts({ pathname: '/blog/12', search: '?nojs=1' })).toBe(false)
  })
})
