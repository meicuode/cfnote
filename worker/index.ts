import { Hono } from 'hono'
import { err, getUser } from './utils'
import { runScheduledArchive } from './archive'
import { ensureSchema } from './migrate'
import { system } from './routes/system'
import { auth } from './routes/auth'
import { notebooks } from './routes/notebooks'
import { articles, purgeExpiredTrash } from './routes/articles'
import { search } from './routes/search'
import { conversations } from './routes/conversations'
import { files, afile, share } from './routes/files'
import { fm } from './routes/fm'
import { stats } from './routes/stats'
import { blog } from './routes/blog'
import { notify, sendDueReminders } from './routes/notify'
import type { AppEnv } from './types'
import type { Env } from '../src/types'

const app = new Hono<AppEnv>()

// Auth middleware: skip for public routes, enforce JWT for everything else
const PUBLIC_ROUTES = ['/api/status', '/api/init', '/api/auth/login', '/api/auth/register']

app.use('/api/*', async (c, next) => {
  // 幂等列迁移:memoized,每个 isolate 只查一次;失败静默(表未初始化时由 /api/init 建表)
  await ensureSchema(c.env).catch(() => {})

  if (PUBLIC_ROUTES.includes(c.req.path)) return next()
  // 附件读取免登录进入路由(新旧两种链接 + 分享链接),路由内部做访问分级:
  // 登录态(头或 cookie)放行,否则仅「被公开文章引用」的附件可读;分享链接按 token+有效期判定
  if (
    (c.req.method === 'GET' || c.req.method === 'HEAD') &&
    (c.req.path.startsWith('/api/files/') || c.req.path.startsWith('/api/afile/') || c.req.path.startsWith('/api/share/'))
  ) return next()
  // 公开博客只读接口免登录(仅暴露 is_public=1 且非私有的文章)
  if (c.req.method === 'GET' && c.req.path.startsWith('/api/blog/')) return next()

  const user = await getUser(c.req.raw, c.env)
  if (!user) {
    return err('未登录或登录已过期', 401)
  }
  c.set('user', user)
  return next()
})

app.route('/api', system)          // /api/status, /api/init, /api/settings, /api/system-logs
app.route('/api/auth', auth)
app.route('/api/notebooks', notebooks)
app.route('/api/articles', articles)
app.route('/api/search', search)
app.route('/api/conversations', conversations)
app.route('/api/files', files)
app.route('/api/afile', afile)
app.route('/api/share', share)
app.route('/api/fm', fm)
app.route('/api/stats', stats)
app.route('/api/blog', blog)
app.route('/api/notify', notify)

app.notFound((c) => err('接口不存在: ' + c.req.path, 404))

// 静态资源由平台直接服务(wrangler.toml [assets]):
// - run_worker_first = ["/api/*"] 保证 API 请求进入 Worker
// - not_found_handling = "single-page-application" 提供 SPA 回退
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => {
    // 高频 cron(*/5)只跑提醒推送;每月那条跑用量归档 + 回收站清理
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(sendDueReminders(env))
      return
    }
    ctx.waitUntil(runScheduledArchive(env))
    // 回收站 30 天到期清理(cron 兜底;打开回收站时也会懒执行)
    ctx.waitUntil(purgeExpiredTrash(env))
  },
} satisfies ExportedHandler<Env>
