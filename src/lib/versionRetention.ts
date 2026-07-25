// 版本历史保留策略(P10):
// - 「同小时合并」在 SQL 侧完成(每篇每小时至多一版,见 articles.ts 的快照逻辑),此处不处理;
// - 本模块为纯函数:给定某篇文章的全部版本(按时间倒序),算出应删除哪些 id 以控制 D1 占用。
// 策略:最近 recentKeep 版全留;更早的每个自然日只保留最新一版;总量超过 maxTotal 一律删。
// D1 的 created_at 为 UTC 'YYYY-MM-DD HH:MM:SS'(无时区),按字符串前 10 位即自然日。

export interface VersionRow {
  id: number
  created_at: string
}

/** 取自然日键:'YYYY-MM-DD HH:MM:SS' 或 ISO 'YYYY-MM-DDTHH:...' → 'YYYY-MM-DD' */
export function dayKeyOf(ts: string): string {
  return (ts || '').slice(0, 10)
}

/** 返回应删除的版本 id 列表(输入按 created_at 倒序;内部再排一次做防御) */
export function versionsToPrune(
  versions: VersionRow[],
  opts: { recentKeep?: number; maxTotal?: number } = {},
): number[] {
  const recentKeep = opts.recentKeep ?? 24
  const maxTotal = opts.maxTotal ?? 60
  const sorted = [...versions].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  )
  const del: number[] = []
  const seenDay = new Set<string>()
  sorted.forEach((v, i) => {
    if (i < recentKeep) return // 最近若干版无条件保留
    if (i >= maxTotal) { del.push(v.id); return } // 超硬上限一律删
    const day = dayKeyOf(v.created_at)
    if (seenDay.has(day)) del.push(v.id) // 该自然日已保留过更新的一版
    else seenDay.add(day)
  })
  return del
}
