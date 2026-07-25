import { describe, it, expect } from 'vitest'
import { dayKeyOf, versionsToPrune, type VersionRow } from '../src/lib/versionRetention'

// 造 n 个版本,时间倒序(最新在前),id 从 1 递增
function mk(list: { id: number; created_at: string }[]): VersionRow[] {
  return list
}

describe('dayKeyOf', () => {
  it('支持空格与 T 两种时间格式', () => {
    expect(dayKeyOf('2026-07-25 13:40:00')).toBe('2026-07-25')
    expect(dayKeyOf('2026-07-25T13:40:00.000Z')).toBe('2026-07-25')
  })
})

describe('versionsToPrune', () => {
  it('不足 recentKeep 时不删任何版本', () => {
    const vs = mk([
      { id: 3, created_at: '2026-07-25 12:00:00' },
      { id: 2, created_at: '2026-07-25 11:00:00' },
      { id: 1, created_at: '2026-07-24 10:00:00' },
    ])
    expect(versionsToPrune(vs, { recentKeep: 24, maxTotal: 60 })).toEqual([])
  })

  it('超过 recentKeep 后,同一天只保留最新一版', () => {
    // recentKeep=2:前 2 版全留;其后同为 07-20 的三版只留最新(id 5),删 4、3
    const vs = mk([
      { id: 7, created_at: '2026-07-25 12:00:00' },
      { id: 6, created_at: '2026-07-25 11:00:00' },
      { id: 5, created_at: '2026-07-20 18:00:00' },
      { id: 4, created_at: '2026-07-20 15:00:00' },
      { id: 3, created_at: '2026-07-20 09:00:00' },
      { id: 2, created_at: '2026-07-19 09:00:00' },
    ])
    expect(versionsToPrune(vs, { recentKeep: 2, maxTotal: 60 }).sort((a, b) => a - b)).toEqual([3, 4])
  })

  it('超过 maxTotal 的一律删除', () => {
    const vs: VersionRow[] = []
    // 60 个不同天各一版(倒序),第 61、62 个应被硬上限删掉
    for (let i = 0; i < 62; i++) {
      const day = String(62 - i).padStart(2, '0')
      vs.push({ id: 100 - i, created_at: `2026-05-${day} 10:00:00` })
    }
    const del = versionsToPrune(vs, { recentKeep: 24, maxTotal: 60 })
    // 最后两个(索引 60、61)被删
    expect(del).toEqual([vs[60].id, vs[61].id])
  })

  it('乱序输入也能按时间正确判定', () => {
    const vs = mk([
      { id: 1, created_at: '2026-07-20 09:00:00' },
      { id: 3, created_at: '2026-07-25 12:00:00' },
      { id: 2, created_at: '2026-07-20 15:00:00' },
    ])
    // recentKeep=1:只留最新(id 3);其后 07-20 两版留最新 id 2,删 id 1
    expect(versionsToPrune(vs, { recentKeep: 1, maxTotal: 60 })).toEqual([1])
  })
})
