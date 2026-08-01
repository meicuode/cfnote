// 自动备份的编排规则(P14.2)。
//
// 放在 src/lib 而不是 worker/ 里,是因为这几条判断决定「什么时候备、留哪几份、删哪几份」,
// 而它们出错的样子是**悄悄不备份**或者**把还要用的那一份删了**——两种都不抛异常、
// 不进日志,等你想恢复的时候才发现。只能靠纯函数单测钉住。

export type BackupInterval = 'off' | '5h' | '1d' | '7d'

export interface IntervalOption {
  id: BackupInterval
  label: string
  hours: number
}

export const BACKUP_INTERVALS: IntervalOption[] = [
  { id: 'off', label: '关闭', hours: 0 },
  { id: '5h', label: '每 5 小时', hours: 5 },
  { id: '1d', label: '每天', hours: 24 },
  { id: '7d', label: '每 7 天', hours: 24 * 7 },
]

export const DEFAULT_INTERVAL: BackupInterval = '7d'
export const DEFAULT_KEEP = 8
export const MAX_KEEP = 30
export const BACKUP_ROOT = 'backups/'
const HOUR_MS = 3600_000

/** 设置键(前端与 Worker 共用字面量,少一处拼错的机会) */
export const BACKUP_KEYS = {
  interval: 'backup_interval',
  keep: 'backup_keep',
  /** 上一次「调度决定」的时刻:下一次到期 = 它 + 周期。见 dueAt 的论证 */
  anchorAt: 'backup_anchor_at',
  lastAt: 'backup_last_at',
  lastSize: 'backup_last_size',
  lastError: 'backup_last_error',
} as const

export function parseInterval(raw?: string | null): BackupInterval {
  const v = String(raw ?? '').trim()
  return BACKUP_INTERVALS.some((o) => o.id === v) ? (v as BackupInterval) : DEFAULT_INTERVAL
}

export function intervalHours(id: BackupInterval): number {
  return BACKUP_INTERVALS.find((o) => o.id === id)?.hours ?? 0
}

export function parseKeep(raw?: string | null): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KEEP
  return Math.min(MAX_KEEP, n)
}

/**
 * 下一次到期时间(ISO)。
 *
 * 存的是**锚点**(上一次调度决定的时刻)而不是算好的到期时间,这一个选择顺手解决两件事:
 *  - 改频率立刻生效。存到期时间的话,7 天改成 5 小时还得先把那 7 天等完;
 *    要么在 `PUT /api/settings` 里为备份特判,要么再补一层夹取逻辑。
 *  - 备份失败不会变成每 5 分钟重试一次。锚点在**开工前**就推到了现在,
 *    失败与否都一样,下一次仍是一个完整周期之后(错误落 last_error 与系统日志,
 *    不靠疯狂重试来补救)。
 *
 * 返回 null 表示「没有锚点」= 立刻到期(交给 isDue 判);关闭状态由调用方先行处理。
 */
export function dueAt(anchorIso: string | null | undefined, interval: BackupInterval): string | null {
  const h = intervalHours(interval)
  const a = Date.parse(String(anchorIso ?? ''))
  if (h <= 0 || !Number.isFinite(a)) return null
  return new Date(a + h * HOUR_MS).toISOString()
}

/**
 * 到期没有。**没有锚点 = 到期**:刚开启(或刚部署)后立刻备一次,
 * 免得「设置里明明开着,却要等七天才知道它到底能不能跑」。
 */
export function isDue(nowMs: number, dueIso?: string | null): boolean {
  const t = Date.parse(String(dueIso ?? ''))
  return !Number.isFinite(t) || t <= nowMs
}

export function backupPrefix(userId: number): string {
  return `${BACKUP_ROOT}u${userId}/`
}

/**
 * 对象键。命名刻意做成字典序 = 时间序,这样裁剪保留份数时只排序键名就够了,
 * 不必为每个对象再读一次元数据(list 一趟就能定夺)。
 */
export function backupKey(userId: number, atMs: number): string {
  const iso = new Date(atMs).toISOString()
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  return `${backupPrefix(userId)}cfnote-${stamp}.json`
}

const NAME_RE = /^cfnote-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.json$/

/**
 * 是不是备份文件名。同时兼作下载/删除接口的路径校验:
 * 这个正则不含斜杠也不含点点,拼进 key 前先过它,就没有跨用户或跨前缀的余地。
 */
export function isBackupName(name: string): boolean {
  return NAME_RE.test(name)
}

/** 文件名 → UTC 时间(ISO);不是备份命名则返回 null */
export function backupTimeOf(name: string): string | null {
  const m = NAME_RE.exec(name)
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : null
}

/** 超出保留份数的那些键(最新的 keep 份留下)。传进来的可以是乱序 */
export function keysToPrune(keys: string[], keep: number): string[] {
  const sorted = [...keys].sort().reverse()
  return sorted.slice(Math.max(1, keep))
}

/** 「保留 8 份 ≈ 覆盖最近 56 天」——把两个数字的乘积说给人听,免得自己心算 */
export function retentionSpan(interval: BackupInterval, keep: number): string {
  const h = intervalHours(interval) * Math.max(1, keep)
  if (h <= 0) return ''
  if (h < 48) return `约 ${h} 小时`
  return `约 ${Math.round(h / 24)} 天`
}
