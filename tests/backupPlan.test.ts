import { describe, it, expect } from 'vitest'
import {
  BACKUP_INTERVALS, DEFAULT_INTERVAL, DEFAULT_KEEP, MAX_KEEP,
  backupKey, backupPrefix, backupTimeOf, dueAt, isBackupName, isDue,
  intervalHours, keysToPrune, parseInterval, parseKeep, retentionSpan,
} from '../src/lib/backupPlan'

// P14.2 自动备份的编排规则。这些函数错了不会报错,只会「悄悄不备份」或者「删错文件」。

const T0 = Date.parse('2026-07-31T03:47:12Z')
const ANCHOR = new Date(T0).toISOString()
const HOUR = 3600_000

describe('频率解析', () => {
  it('认得四档,坏值回落到默认', () => {
    expect(parseInterval('5h')).toBe('5h')
    expect(parseInterval('1d')).toBe('1d')
    expect(parseInterval('7d')).toBe('7d')
    expect(parseInterval('off')).toBe('off')
    expect(parseInterval('每周二')).toBe(DEFAULT_INTERVAL)
    expect(parseInterval('')).toBe(DEFAULT_INTERVAL)
    expect(parseInterval(null)).toBe(DEFAULT_INTERVAL)
    expect(parseInterval(undefined)).toBe(DEFAULT_INTERVAL)
  })

  it('每一档的小时数都对得上', () => {
    expect(intervalHours('off')).toBe(0)
    expect(intervalHours('5h')).toBe(5)
    expect(intervalHours('1d')).toBe(24)
    expect(intervalHours('7d')).toBe(168)
    // 下拉框里的每一项都得能算出到期时间,不然选了等于关掉
    for (const o of BACKUP_INTERVALS) {
      expect(dueAt(ANCHOR, o.id) === null).toBe(o.id === 'off')
    }
  })
})

describe('保留份数', () => {
  it('坏值回落到默认,并夹在上限内', () => {
    expect(parseKeep('12')).toBe(12)
    expect(parseKeep('0')).toBe(DEFAULT_KEEP)
    expect(parseKeep('-3')).toBe(DEFAULT_KEEP)
    expect(parseKeep('abc')).toBe(DEFAULT_KEEP)
    expect(parseKeep(null)).toBe(DEFAULT_KEEP)
    expect(parseKeep('999')).toBe(MAX_KEEP)
    expect(parseKeep('3.9')).toBe(3)
  })
})

describe('到期判定', () => {
  it('没有锚点就是到期:刚开启立刻备一次,不用等一整个周期才知道能不能跑', () => {
    expect(isDue(T0, dueAt(null, '7d'))).toBe(true)
    expect(isDue(T0, dueAt('', '1d'))).toBe(true)
    expect(isDue(T0, dueAt('不是时间', '5h'))).toBe(true)
  })

  it('到点了才算到期', () => {
    const due = dueAt(ANCHOR, '5h')!
    expect(isDue(T0, due)).toBe(false)
    expect(isDue(T0 + 4 * HOUR, due)).toBe(false)
    expect(isDue(T0 + 5 * HOUR, due)).toBe(true)
    expect(isDue(T0 + 6 * HOUR, due)).toBe(true)
  })

  it('7 天那档确实是锚点之后 7 天', () => {
    expect(dueAt(ANCHOR, '7d')).toBe(new Date(T0 + 7 * 86400_000).toISOString())
  })
})

describe('存锚点而不是存到期时间', () => {
  it('改频率立刻生效:7 天改成 5 小时,不必先把那 7 天等完', () => {
    // 锚点不变,只换周期——不需要在 PUT /api/settings 里为备份特判,也不需要额外的夹取逻辑
    expect(isDue(T0 + 6 * HOUR, dueAt(ANCHOR, '7d'))).toBe(false)
    expect(isDue(T0 + 6 * HOUR, dueAt(ANCHOR, '5h'))).toBe(true)
  })

  it('同一份输入什么时候问答案都一样(不会每被唤醒一次就把截止时间往后挪)', () => {
    const a = dueAt(ANCHOR, '5h')
    const b = dueAt(ANCHOR, '5h')
    expect(a).toBe(b)
    expect(Date.parse(a!)).toBe(T0 + 5 * HOUR)
  })

  it('备份失败也不会变成每 5 分钟重试一次:锚点在开工前就推到了现在', () => {
    // 失败时锚点已是 T0(不回滚),所以下一次仍是一个完整周期之后
    const due = dueAt(ANCHOR, '7d')!
    expect(isDue(T0 + 5 * 60_000, due)).toBe(false)
    expect(isDue(T0 + 6 * 86400_000, due)).toBe(false)
    expect(isDue(T0 + 7 * 86400_000, due)).toBe(true)
  })

  it('关闭时没有到期时间', () => {
    expect(dueAt(ANCHOR, 'off')).toBeNull()
  })
})

describe('对象键命名', () => {
  it('按用户分前缀,字典序即时间序', () => {
    expect(backupPrefix(1)).toBe('backups/u1/')
    const k1 = backupKey(1, T0)
    const k2 = backupKey(1, T0 + 5 * 3600_000)
    expect(k1).toBe('backups/u1/cfnote-2026-07-31-034712.json')
    expect(k1 < k2).toBe(true)
    // 跨年、跨月也必须仍然有序(纯字符串比较,不解析日期)
    expect(backupKey(1, Date.parse('2026-12-31T23:59:59Z')) < backupKey(1, Date.parse('2027-01-01T00:00:00Z'))).toBe(true)
  })

  it('同一分钟内连备两次不会互相覆盖(带秒)', () => {
    expect(backupKey(1, T0)).not.toBe(backupKey(1, T0 + 1000))
  })

  it('文件名校验挡掉路径穿越', () => {
    expect(isBackupName('cfnote-2026-07-31-034712.json')).toBe(true)
    expect(isBackupName('../../u2/cfnote-2026-07-31-034712.json')).toBe(false)
    expect(isBackupName('cfnote-2026-07-31-0347.json')).toBe(false)
    expect(isBackupName('别的文件.json')).toBe(false)
    expect(isBackupName('cfnote-2026-07-31-034712.json.bak')).toBe(false)
  })

  it('文件名能还原成时间', () => {
    expect(backupTimeOf('cfnote-2026-07-31-034712.json')).toBe('2026-07-31T03:47:12.000Z')
    expect(backupTimeOf('乱七八糟')).toBeNull()
  })
})

describe('保留份数裁剪', () => {
  const keys = [
    'backups/u1/cfnote-2026-07-03-000000.json',
    'backups/u1/cfnote-2026-07-01-000000.json',
    'backups/u1/cfnote-2026-07-05-000000.json',
    'backups/u1/cfnote-2026-07-02-000000.json',
  ]

  it('留最新的 N 份,删剩下的(输入乱序也行)', () => {
    expect(keysToPrune(keys, 2)).toEqual([
      'backups/u1/cfnote-2026-07-02-000000.json',
      'backups/u1/cfnote-2026-07-01-000000.json',
    ])
  })

  it('份数没超就一个都不删', () => {
    expect(keysToPrune(keys, 4)).toEqual([])
    expect(keysToPrune(keys, 10)).toEqual([])
    expect(keysToPrune([], 3)).toEqual([])
  })

  it('keep 为 0 也至少留一份:宁可多占一点空间,不能把最后一份删掉', () => {
    expect(keysToPrune(keys, 0)).toHaveLength(3)
  })
})

describe('保留时长换算', () => {
  it('把「几份 × 多久」说成人话', () => {
    expect(retentionSpan('7d', 8)).toBe('约 56 天')
    expect(retentionSpan('1d', 8)).toBe('约 8 天')
    expect(retentionSpan('off', 8)).toBe('')
  })

  it('不足两天的用小时说,别把 40 小时说成「约 2 天」', () => {
    expect(retentionSpan('5h', 8)).toBe('约 40 小时')
    expect(retentionSpan('5h', 4)).toBe('约 20 小时')
    // 48 小时是分界:到了这儿改用天,再往下数字太大反而不好读
    expect(retentionSpan('5h', 10)).toBe('约 2 天')
    expect(retentionSpan('1d', 2)).toBe('约 2 天')
  })
})
