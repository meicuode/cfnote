import { describe, it, expect } from 'vitest'
import {
  formatRecoveryCode, normalizeRecoveryCode, isRecoveryCodeShape,
  timingSafeEqual, recoveryCodeMatches, RECOVERY_CODE_LEN,
} from '../src/lib/recoveryCode'

const CODE = 'a3f9c1e08b7d45261f0e9c7a4b2d8e50' // 32 hex

describe('normalizeRecoveryCode', () => {
  it('去掉分组连字符', () => {
    expect(normalizeRecoveryCode('a3f9c1e0-8b7d4526-1f0e9c7a-4b2d8e50')).toBe(CODE)
  })

  it('去掉手抄时带进来的空白、认大写', () => {
    // 三种形态都要认:设置页复制的带连字符、D1 控制台复制的裸 32 位、手抄带空格的。
    // 认不出来的时候用户没有第二条路,而放宽这里不损失任何熵
    expect(normalizeRecoveryCode('  A3F9C1E0 8B7D4526 1F0E9C7A 4B2D8E50 ')).toBe(CODE)
  })

  it('null / undefined 归一成空串而不是抛', () => {
    expect(normalizeRecoveryCode(null)).toBe('')
    expect(normalizeRecoveryCode(undefined)).toBe('')
  })
})

describe('formatRecoveryCode', () => {
  it('每 8 个字符一段', () => {
    expect(formatRecoveryCode(CODE)).toBe('a3f9c1e0-8b7d4526-1f0e9c7a-4b2d8e50')
  })

  it('已经带连字符的再格式化一次不会变形(幂等)', () => {
    const once = formatRecoveryCode(CODE)
    expect(formatRecoveryCode(once)).toBe(once)
  })

  it('空值给空串', () => {
    expect(formatRecoveryCode('')).toBe('')
    expect(formatRecoveryCode(null as any)).toBe('')
  })
})

describe('isRecoveryCodeShape', () => {
  it('32 个 hex 才算', () => {
    expect(isRecoveryCodeShape(CODE)).toBe(true)
    expect(isRecoveryCodeShape(formatRecoveryCode(CODE))).toBe(true)
  })

  it('长度不对、有非 hex 字符都不算', () => {
    expect(isRecoveryCodeShape(CODE.slice(0, 31))).toBe(false)
    expect(isRecoveryCodeShape(CODE + 'a')).toBe(false)
    expect(isRecoveryCodeShape('z'.repeat(RECOVERY_CODE_LEN))).toBe(false)
    expect(isRecoveryCodeShape('')).toBe(false)
  })
})

describe('timingSafeEqual', () => {
  it('相同为真,不同为假', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
  })

  it('长度不同直接假(长度不是秘密,它固定是 32)', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })

  it('两个空串相等——所以调用方必须自己先排除空值', () => {
    // recoveryCodeMatches 正是靠「先查长度」来挡住这一条的
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('recoveryCodeMatches', () => {
  it('对得上就通过,连字符形态也认', () => {
    expect(recoveryCodeMatches(CODE, CODE)).toBe(true)
    expect(recoveryCodeMatches(formatRecoveryCode(CODE), CODE)).toBe(true)
    expect(recoveryCodeMatches(CODE.toUpperCase(), CODE)).toBe(true)
  })

  it('差一位就不通过', () => {
    expect(recoveryCodeMatches(CODE.slice(0, 31) + '1', CODE)).toBe(false)
  })

  it('库里没有码(老库补出来是 NULL)时一律不通过', () => {
    // 这是 fail open 最坏的一种形态:空码 === 空输入,任何人都能重置密码
    expect(recoveryCodeMatches('', null)).toBe(false)
    expect(recoveryCodeMatches('', '')).toBe(false)
    expect(recoveryCodeMatches(null, null)).toBe(false)
    expect(recoveryCodeMatches(CODE, null)).toBe(false)
    expect(recoveryCodeMatches(CODE, undefined)).toBe(false)
  })

  it('库里存了个长度不对的脏值也不通过', () => {
    // 手动改过库、或者哪次迁移写歪了。宁可谁都进不来,也不要放宽成前缀比较
    expect(recoveryCodeMatches('abc', 'abc')).toBe(false)
  })
})
