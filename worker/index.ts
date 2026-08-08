import { Hono } from 'hono'
import { err, getUser } from './utils'
import { runScheduledArchive } from './archive'
import { runAutoBackup } from './backup'
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
import { notify, sendDueReminders, sendDueTodos } from './routes/notify'
import { comments } from './routes/comments'
import { pages } from './routes/pages'
import { backups } from './routes/backups'
import { todos } from './routes/todos'
import type { AppEnv } from './types'
import type { Env } from '../src/types'

const app = new Hono<AppEnv>()

// Auth middleware: skip for public routes, enforce JWT for everything else
const PUBLIC_ROUTES = ['/api/status', '/api/init', '/api/auth/login', '/api/auth/register', '/api/auth/recover']

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
  // 访客提交评论:仅放行这一个确切的 POST 路径(路由内部再校验文章公开/限流/审核)
  if (c.req.method === 'POST' && c.req.path === '/api/blog/comments') return next()

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
app.route('/api/comments', comments)
app.route('/api/backups', backups)
app.route('/api/todos', todos)

// 页面级路由(P12.6):/blog/:id 预渲染、/blog/feed.xml、/sitemap.xml、/robots.txt。
// 免鉴权(上面的中间件只管 /api/*),放在 API 之后注册,互不重叠。
app.route('/', pages)

// /api/* 没匹配上就是接口不存在;其余路径说明 run_worker_first 放它进来了但没有对应页面路由,
// 原样交还静态资源层,由 SPA 回退处理。
// (P15.2 之前这里举的例子是 /blog/12/xxx——那条现在已经是详情页的正式路由了)
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return err('接口不存在: ' + c.req.path, 404)
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  return err('页面不存在: ' + c.req.path, 404)
})

// 静态资源由平台直接服务(wrangler.toml [assets]):
// - run_worker_first = ["/api/*"] 保证 API 请求进入 Worker
// - not_found_handling = "single-page-application" 提供 SPA 回退
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => {
    // 高频 cron(*/5)跑提醒推送 + 自动备份到 R2(P14.2:备份自己判到期,
    // 没到期就是一次 settings 读,所以不必为它单开一条 cron 触发器);
    // 每月那条跑用量归档 + 回收站清理
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(sendDueReminders(env))
      ctx.waitUntil(sendDueTodos(env))
      ctx.waitUntil(runAutoBackup(env))
      return
    }
    ctx.waitUntil(runScheduledArchive(env))
    // 回收站 30 天到期清理(cron 兜底;打开回收站时也会懒执行)
    ctx.waitUntil(purgeExpiredTrash(env))
  },
} satisfies ExportedHandler<Env>
