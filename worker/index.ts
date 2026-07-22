import { Hono } from 'hono'
import { err, getUser } from './utils'
import { runScheduledArchive } from './archive'
import { system } from './routes/system'
import { auth } from './routes/auth'
import { notebooks } from './routes/notebooks'
import { articles } from './routes/articles'
import { search } from './routes/search'
import { conversations } from './routes/conversations'
import { stats } from './routes/stats'
import type { AppEnv } from './types'
import type { Env } from '../src/types'

const app = new Hono<AppEnv>()

// Auth middleware: skip for public routes, enforce JWT for everything else
const PUBLIC_ROUTES = ['/api/status', '/api/init', '/api/auth/login', '/api/auth/register']

app.use('/api/*', async (c, next) => {
  if (PUBLIC_ROUTES.includes(c.req.path)) return next()

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
app.route('/api/stats', stats)

app.notFound((c) => err('接口不存在: ' + c.req.path, 404))

// 静态资源由平台直接服务(wrangler.toml [assets]):
// - run_worker_first = ["/api/*"] 保证 API 请求进入 Worker
// - not_found_handling = "single-page-application" 提供 SPA 回退
export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(runScheduledArchive(env))
  },
} satisfies ExportedHandler<Env>
