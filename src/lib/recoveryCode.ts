// 恢复码(P17.2)。忘了密码时唯一的自助出路。
//
// 在此之前,「登出了又忘了密码」这件事只能去 Cloudflare 控制台删掉 users 那一行
// 再重新注册——而那要同时清 sqlite_sequence(users.id 是 AUTOINCREMENT,不清的话
// 新用户拿到 id=2,而所有笔记还挂在 user_id=1 上,表现是「笔记全没了」)。
// 一条要求人记住冷知识、记错就以为数据全丢的恢复路径,等于没有恢复路径。
//
// **为什么不能直接在 SQL 控制台改密码**:password_hash 是 PBKDF2-SHA256 十万轮,
// D1 的 Console 里算不出来。所以「能读数据库」并不等于「能重置密码」——
// 恢复码补的正是这一段。

/** 128 bit。不是 6 位验证码那种要人念的东西,而是从数据库/设置页复制粘贴的 */
export const RECOVERY_CODE_BYTES = 16
/** 32 个 hex 字符 */
export const RECOVERY_CODE_LEN = RECOVERY_CODE_BYTES * 2

/**
 * 显示用的分组:每 8 个字符一段,`a3f9c1e0-8b7d4526-...`。
 * 抄在纸上时不分组极容易串行——而这个码的全部价值就在于「抄下来还能用」。
 */
export function formatRecoveryCode(code: string): string {
  const s = normalizeRecoveryCode(code)
  if (!s) return ''
  return (s.match(/.{1,8}/g) || []).join('-')
}

/**
 * 归一:去掉分组用的连字符与空白、转小写。
 *
 * 用户会从设置页复制带连字符的那个形态,也可能从 D1 控制台复制裸的 32 位,
 * 还可能手抄时带上空格。这三种都该认——**认不出来的时候他没有第二条路**,
 * 而放宽这里不损失任何熵(连字符与大小写都不是秘密的一部分)。
 */
export function normalizeRecoveryCode(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/[\s-]/g, '').toLowerCase()
}

/** 形态对不对(32 个 hex)。只是early-out,不是安全判断 */
export function isRecoveryCodeShape(raw: string | null | undefined): boolean {
  const s = normalizeRecoveryCode(raw)
  return s.length === RECOVERY_CODE_LEN && /^[0-9a-f]+$/.test(s)
}

/**
 * 常数时间比较。
 *
 * 这个接口是**公开未鉴权**的,而普通的 `===` 在第一个不同的字符就返回,
 * 逐位比较的耗时差理论上能被用来一位一位地试出正确值。128 bit 的空间本来就
 * 猜不动,但既然只是几行,就没有理由留这个口子。
 *
 * 长度不同直接返回 false —— 长度本身不是秘密(它是固定的 32)。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 恢复码对不对。归一 + 形态检查 + 常数时间比较。
 *
 * `stored` 为空(老库补出来的 NULL、或者还没生成)时**一律不通过**:
 * 否则空码 === 空输入会让任何人都能重置密码,而这正是 fail open 最坏的一种形态。
 */
export function recoveryCodeMatches(input: string | null | undefined, stored: string | null | undefined): boolean {
  const want = normalizeRecoveryCode(stored)
  if (want.length !== RECOVERY_CODE_LEN) return false
  return timingSafeEqual(normalizeRecoveryCode(input), want)
}
