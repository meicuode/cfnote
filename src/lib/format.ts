// 字节数 → 人类可读大小(附件卡片等处展示;附件上限 10MB,无需 GB 档)
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) {
    const kb = n / 1024
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// 时间 → 本地 "YYYY-MM-DD HH:mm"(附件悬浮信息等处展示)
export function formatDateTime(input: string | number | Date): string {
  const d = new Date(input)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
