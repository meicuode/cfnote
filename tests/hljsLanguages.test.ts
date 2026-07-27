import { describe, it, expect } from 'vitest'
import { EXTRA_LANGS, resolveLangAlias } from '../src/lib/hljsLanguages'

describe('hljsLanguages(代码高亮补充语言,P11.7)', () => {
  it('补充表直接命中(大小写/空白容错)', () => {
    expect(resolveLangAlias('powershell')).toBe('powershell')
    expect(resolveLangAlias('PowerShell')).toBe('powershell')
    expect(resolveLangAlias('  dockerfile  ')).toBe('dockerfile')
  })

  it('常见别名归一', () => {
    expect(resolveLangAlias('ps1')).toBe('powershell')
    expect(resolveLangAlias('pwsh')).toBe('powershell')
    expect(resolveLangAlias('docker')).toBe('dockerfile')
    expect(resolveLangAlias('bat')).toBe('dos')
    expect(resolveLangAlias('cmd')).toBe('dos')
    expect(resolveLangAlias('tex')).toBe('latex')
    expect(resolveLangAlias('proto')).toBe('protobuf')
  })

  it('表外语言与空值返回 null(调用方据此降级为自动检测)', () => {
    expect(resolveLangAlias('brainfuck')).toBeNull()
    expect(resolveLangAlias('')).toBeNull()
    expect(resolveLangAlias('   ')).toBeNull()
    // common 基础包已含的语言不该进补充表(避免重复注册)
    expect(resolveLangAlias('python')).toBeNull()
    expect(resolveLangAlias('json')).toBeNull()
  })

  it('别名一律指向补充表中真实存在的键', () => {
    for (const key of Object.keys(EXTRA_LANGS)) {
      expect(typeof EXTRA_LANGS[key]).toBe('function')
      // 键自身可被解析回自己
      expect(resolveLangAlias(key)).toBe(key)
    }
  })
})
