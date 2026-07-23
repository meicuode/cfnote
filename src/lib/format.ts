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
