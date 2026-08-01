import { Hono } from 'hono'
import { ok, err, getSettingValues } from '../utils'
import { listBackups, runBackup } from '../backup'
import {
  BACKUP_KEYS, backupPrefix, dueAt, isBackupName, parseInterval, parseKeep, retentionSpan,
} from '../../src/lib/backupPlan'
import type { AppEnv } from '../types'

// 自动备份的管理接口(P14.2,见 worker/backup.ts 的调度说明)。全部走全局鉴权:
// 备份文件里有全部正文、评论者邮箱与 IP,只能本人取。
//
// 匿名走不到这里,也走不到 /api/files/<key>:anonReadable 在 files 表里查不到备份的 key,
// 直接判 false(备份从不登记进 files 表,fm/scan 也只认 ^u\d+/ 前缀,不会把它们当成附件)。
export const backups = new Hono<AppEnv>()

/** :name 拼进对象键之前必须过这一关(正则不含斜杠与点点,没有跨用户/跨前缀的余地) */
function keyOf(userId: number, name: string): string | null {
  return isBackupName(name) ? backupPrefix(userId) + name : null
}

// GET /api/backups - 备份列表 + 当前配置(设置面板一次拉完,不为一个开关多打一趟请求)
backups.get('/', async (c) => {
  const user = c.get('user')
  try {
    const s = await getSettingValues(c.env, [
      BACKUP_KEYS.interval, BACKUP_KEYS.keep, BACKUP_KEYS.lastAt,
      BACKUP_KEYS.lastSize, BACKUP_KEYS.lastError, BACKUP_KEYS.anchorAt,
    ])
    const interval = parseInterval(s.get(BACKUP_KEYS.interval))
    const keep = parseKeep(s.get(BACKUP_KEYS.keep))
    return ok({
      available: !!c.env.BUCKET,
      interval,
      keep,
      span: retentionSpan(interval, keep),
      last_at: s.get(BACKUP_KEYS.lastAt) || '',
      last_size: Number(s.get(BACKUP_KEYS.lastSize) || 0),
      last_error: s.get(BACKUP_KEYS.lastError) || '',
      next_at: interval === 'off' ? '' : (dueAt(s.get(BACKUP_KEYS.anchorAt), interval) || ''),
      files: c.env.BUCKET ? await listBackups(c.env, user.id) : [],
    })
  } catch (e: any) {
    return err('读取备份列表失败: ' + e.message, 500)
  }
})

// POST /api/backups/run - 立即备份一次。有它才不用等一整个周期才知道这功能到底能不能跑
backups.post('/run', async (c) => {
  if (!c.env.BUCKET) return err('未配置附件存储(R2),无法备份到云端', 501)
  try {
    const r = await runBackup(c.env, Date.now())
    return ok(r)
  } catch (e: any) {
    return err('备份失败: ' + e.message, 500)
  }
})

// GET /api/backups/:name - 下载某一份(下载后走既有的「导入备份」即可恢复,不另写服务端恢复逻辑)
backups.get('/:name', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err('未配置附件存储(R2)', 501)
  const name = c.req.param('name')
  const key = keyOf(user.id, name)
  if (!key) return err('备份不存在', 404)
  try {
    const obj = await c.env.BUCKET.get(key)
    if (!obj) return err('备份不存在', 404)
    return new Response(obj.body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    })
  } catch (e: any) {
    return err('下载失败: ' + e.message, 500)
  }
})

// DELETE /api/backups/:name - 手动删掉某一份
backups.delete('/:name', async (c) => {
  const user = c.get('user')
  if (!c.env.BUCKET) return err('未配置附件存储(R2)', 501)
  const key = keyOf(user.id, c.req.param('name'))
  if (!key) return err('备份不存在', 404)
  try {
    await c.env.BUCKET.delete(key)
    return ok({ message: '已删除' })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})
