# CFNote - 私人知识库系统

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meicuode/cfnote)

基于 Cloudflare 全栈基础设施构建的私人知识库，支持笔记本管理、Markdown 文章编辑、自动向量化和自然语言语义搜索。全程不依赖第三方 LLM API，所有 AI 能力由 Cloudflare Workers AI 提供，设计在免费额度内运行。

## 技术架构

```
┌────────────────────────────────────────────────────────────┐
│         Cloudflare Workers + Static Assets                 │
│                                                            │
│   React + Tailwind CSS (SPA, 静态资源直出)                  │
│   ┌────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────┐  │
│   │ 笔记本  │ │ 文章列表  │ │ Markdown编辑 │ │ AI 多轮   │  │
│   │ 侧边栏  │ │          │ │ / 预览       │ │ 对话面板  │  │
│   └────────┘ └──────────┘ └──────────────┘ └───────────┘  │
│                    │ /api/*                                │
│         Worker (Hono 路由 + 月度归档 Cron)                  │
│                    │                                       │
│      ┌─────────┬───┴────┬────────────┐                     │
│      │   D1    │Vectorize│ Workers AI │                     │
│      │ SQLite  │ 向量索引 │ 嵌入 + LLM │                     │
│      └─────────┴────────┴────────────┘                     │
└────────────────────────────────────────────────────────────┘
```

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS 4 + Vite 6（Workers Static Assets 直出，请求免费不限量） |
| 后端 | Cloudflare Worker + Hono 路由，`/api/*` 走 Worker，其余走静态资源 |
| 数据库 | Cloudflare D1 (边缘 SQLite) |
| 向量搜索 | Cloudflare Vectorize (1024维, cosine) |
| 嵌入模型 | `@cf/baai/bge-m3` (多语言) |
| 文本生成 | 可在设置页面切换，默认 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| 定时任务 | Cron Triggers，每月自动归档用量统计 |

## 核心功能

- **笔记本管理**：创建/删除笔记本，每个笔记本包含多篇文章
- **Markdown 编辑**：编辑模式 + 预览模式切换，3秒无操作自动保存
- **自动向量化**：文章保存后自动分块（500字/块）→ 嵌入 → 存入 Vectorize
- **混合搜索**：向量语义召回 + 关键词召回（标题权重更高），RRF 融合排序——既能"按意思找"也能精确匹配函数名、专有名词等短词，不消耗 LLM 额度
- **AI 多轮对话**：右侧常驻聊天面板，支持基于知识库的多轮问答，**流式逐字输出**（推理模型自动回退整段输出），历史对话持久化
- **联网搜索**：AI 助手支持联网搜索，输入"搜索 xxx"触发，搜索结果可一键保存为笔记
- **AI 模型设置**：支持切换 Workers AI 模型（Llama 3.1 8B / Llama 3.3 70B / DeepSeek R1 32B / QwQ 32B），推理模型自动清理 `<think>` 标签
- **URL 导入**：通过 Jina Reader 抓取网页内容并自动向量化入库
- **统计仪表盘**：实时查看知识库规模、Workers AI 额度消耗、向量存储使用率、调用次数趋势和按模型分组的调用统计
- **首次初始化引导**：自动检测系统状态，引导创建数据库和用户
- **数据导出备份**：设置面板一键导出全部笔记本、文章与对话为 JSON 文件（不含 API Key 等敏感配置），建议定期备份

## 免费额度适配

以 200 篇 3000 字文章、每日 100 次搜索为基准：

| 资源 | 消耗 | 免费额度 | 占比 |
|------|------|---------|------|
| 向量存储 | 1,433,600 维 | 5,000,000 维 | 28.7% |
| 向量查询 | 3,072,000 维/月 | 30,000,000 维/月 | 10.2% |
| Workers AI | ~215 neurons/天 | 10,000 neurons/天 | 2.15% |
| D1 读写 | <5,000 行/天 | 5,000,000 读 + 100,000 写/天 | <0.1% |

> 实际 neurons 消耗取决于所选模型：Llama 3.1 8B (~15/次) 最节省，DeepSeek R1 32B (~178/次) 最高。

## 部署

数据库建表由应用内完成（`POST /api/init`，表结构唯一来源是 `worker/routes/system.ts`），用量统计由 Cron 自动归档，`wrangler.toml` 不含任何账号相关的资源 ID（按名称绑定）——部署和维护全程不需要在本地执行数据库命令，也不需要修改任何文件。三种部署方式任选：

### 方式一：一键部署（最快上手）

点击 README 顶部的 **Deploy to Cloudflare** 按钮：

1. Cloudflare 会把代码克隆成你 GitHub/GitLab 账号下的一个**独立新仓库**，并接好自动构建（以后 push 即部署）
2. 向导中选择或创建 D1 数据库（`cfnote-db`）和 Vectorize 索引（`cfnote-index`）
3. 新建 Vectorize 索引时，dimensions 填 **`1024`**，metric 选 **`cosine`**（1024 是嵌入模型 `@cf/baai/bge-m3` 的输出维度）。注意这两项创建后不可修改：dimensions 填错向量化会直接报错，metric 选错搜索排序会完全失真，只能删除索引后重建
4. 部署向导中按提示填写 `JWT_SECRET`（随机字符串即可）；部署完成后到 Worker 的 **Settings → Variables and Secrets** 确认它以 **Secret** 类型存在，没有就补加一条
5. 访问站点，按引导完成初始化：建表 → 创建账户 → 进入主界面

> 注意：按钮创建的是独立仓库，与本仓库**没有 fork 关系**，日后无法一键同步上游更新（即使你先 fork 再点按钮，它仍会另建一个新仓库）。想持续跟进更新，请用方式二。

### 方式二：Fork + 仪表盘连接 Git（推荐，可持续更新）

1. Fork 本仓库到你的 GitHub 账号
2. Cloudflare 仪表盘中创建 D1 数据库 `cfnote-db` 和 Vectorize 索引 `cfnote-index`（1024 维，cosine）
3. Workers 页面选择「连接 Git 仓库」指向你的 fork（构建命令 `npm run build`，部署命令 `npx wrangler deploy`）。`wrangler.toml` 按名称绑定资源，fork 无需修改任何文件；若首次构建报 database_id 相关错误，把仪表盘中 D1 详情页的 ID 填入 `wrangler.toml` 再 push 一次即可
4. 在 Worker 的 Settings → Variables and Secrets 中添加 Secret `JWT_SECRET`（以及可选的 `CF_API_TOKEN` / `CF_ACCOUNT_ID`）
5. 访问站点，按引导完成初始化
6. **后续更新**：本仓库发新版后，在你 fork 的 GitHub 页面点 **Sync fork → Update branch**，push 后自动重新构建部署

### 方式三：本地 CLI

```bash
wrangler login
wrangler d1 create cfnote-db
wrangler vectorize create cfnote-index --dimensions=1024 --metric=cosine
wrangler secret put JWT_SECRET
npm install && npm run deploy    # 部署按名称绑定资源,如提示选择数据库,选刚创建的 cfnote-db
```

部署成功后输出访问地址（形如 `https://cfnote.<你的子域>.workers.dev`），首次访问按引导初始化即可。

## 统计仪表盘

点击顶栏右侧的柱状图图标打开统计面板，可查看：

- **概览卡片**：笔记本数、文章数、已索引文章数、向量存储使用率
- **Workers AI 额度**：今日 neurons 消耗进度条、按模型细分、近7天趋势图
- **使用量统计**：搜索/AI问答/AI对话/联网搜索 的今日/7天/累计调用次数
- **模型调用统计**：按模型分组的今日/7天调用次数
- **7天趋势**：纯 CSS 柱状图，展示近7天各功能的调用走势

### 统计数据来源

使用量数据通过 **Cloudflare Analytics Engine (AE)** 采集，不消耗 D1 写入配额。AE 数据保留 90 天，通过 `POST /api/stats/archive` 归档到 D1 `usage_archive` 表实现长期保存（见下文「数据归档」）。

「今日/近7天」按本地自然日统计，时区由 `STATS_TZ_OFFSET` 控制；Workers AI neurons 额度按 Cloudflare 官方口径以 UTC 日重置。

统计面板需要配置以下环境变量才能显示完整数据：

| 变量 | 必需 | 说明 |
|------|------|------|
| `CF_API_TOKEN` | 可选 | Cloudflare API Token，需包含 `Account Analytics: Read` 权限 |
| `CF_ACCOUNT_ID` | 可选 | Cloudflare 账户 ID（在仪表盘首页 URL 中可找到） |
| `STATS_TZ_OFFSET` | 可选 | 统计使用的时区偏移（小时），默认 `8`（东八区） |

设置方式：在 Worker 的 **Settings → Variables and Secrets** 中添加（类型选 Secret），或本地执行：

```bash
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID
```

### 统计接口 `GET /api/stats`

需认证（Bearer Token），无请求参数。返回结构如下：

```jsonc
{
  // ---- 内容统计 ----
  "notebooks": 5,               // 笔记本总数
  "articles": 42,               // 文章总数
  "articles_vectorized": 38,    // 已向量化文章数

  // ---- 向量存储 ----
  "vectors_count": 156,         // 当前存储的向量数（来自 Vectorize.describe()）
  "vectors_limit": 4882,        // 免费额度上限（5,000,000 维 ÷ 1024 维/向量）
  "vector_usage_percent": 3.2,  // 使用百分比

  // ---- Workers AI 用量（CF GraphQL API，未配置时为 null）----
  "ai_usage": {
    "neurons_today": 215,       // 今日已消耗 neurons
    "neurons_limit": 10000,     // 每日免费上限
    "models": [                 // 按模型细分
      {
        "modelId": "@cf/baai/bge-m3",
        "count": 12,            // 调用次数
        "neurons": 80,          // 消耗 neurons
        "inputTokens": 5600,    // 输入 token 数
        "outputTokens": 0       // 输出 token 数
      }
    ],
    "daily": [                  // 近7天每日趋势
      { "date": "2026-03-08", "neurons": 180, "count": 10 }
    ]
  },

  // ---- 调用次数统计（Analytics Engine + D1 归档）----
  "usage": {
    "search_today": 8,          // 语义搜索 — 今日
    "search_7d": 45,            // 语义搜索 — 近7天
    "search_total": 320,        // 语义搜索 — 累计
    "ai_qa_today": 3,           // AI问答 — 今日
    "ai_qa_7d": 18,             // AI问答 — 近7天
    "ai_qa_total": 95,          // AI问答 — 累计
    "ai_chat_today": 5,         // AI对话 — 今日
    "ai_chat_7d": 22,           // AI对话 — 近7天
    "ai_chat_total": 110,       // AI对话 — 累计
    "web_search_today": 1,      // 联网搜索 — 今日
    "web_search_7d": 4,         // 联网搜索 — 近7天
    "web_search_total": 15,     // 联网搜索 — 累计
    "vectorize_total": 42,      // 向量化 — 累计
    "import_total": 6,          // URL导入 — 累计
    "model_usage": [            // 按模型分组的调用统计
      { "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "today": 7, "week": 35 },
      { "model": "@cf/qwen/qwq-32b", "today": 1, "week": 5 }
    ]
  },

  // ---- 7天趋势 ----
  "daily_trend": [
    { "date": "2026-03-08", "search": 5, "ai_qa": 2, "ai_chat": 3, "web_search": 0 },
    { "date": "2026-03-09", "search": 8, "ai_qa": 1, "ai_chat": 4, "web_search": 1 }
    // ...共7天
  ]
}
```

#### TypeScript 类型定义

```typescript
interface Stats {
  notebooks: number
  articles: number
  articles_vectorized: number
  vectors_count: number
  vectors_limit: number
  vector_usage_percent: number
  ai_usage: StatsAiUsage | null
  usage: StatsUsage
  daily_trend: { date: string; search: number; ai_qa: number; ai_chat: number; web_search: number }[]
}

interface StatsAiUsage {
  neurons_today: number
  neurons_limit: number
  models: StatsAiModel[]
  daily: { date: string; neurons: number; count: number }[]
}

interface StatsAiModel {
  modelId: string
  count: number
  neurons: number
  inputTokens: number
  outputTokens: number
}

interface StatsUsage {
  search_today: number
  search_7d: number
  search_total: number
  ai_qa_today: number
  ai_qa_7d: number
  ai_qa_total: number
  ai_chat_today: number
  ai_chat_7d: number
  ai_chat_total: number
  web_search_today: number
  web_search_7d: number
  web_search_total: number
  vectorize_total: number
  import_total: number
  model_usage: { model: string; today: number; week: number }[]
}
```

### 使用量追踪（Analytics Engine）

使用量数据通过 Cloudflare Analytics Engine 采集（`env.ANALYTICS.writeDataPoint()`），不消耗 D1 写入配额：

| 接口 | action 值 | 触发时机 |
|------|----------|---------|
| `POST /api/search` | `search` | 语义搜索成功返回结果后 |
| `POST /api/search/ai` | `ai_qa` | AI问答成功生成回答后 |
| `POST /api/conversations/:id/messages` | `ai_chat` / `web_search` | AI对话/联网搜索后 |
| `POST /api/articles` 向量化 | `vectorize` | 文章向量化成功后 |
| `POST /api/articles/import` | `import` | URL导入文章成功后 |

AE 数据点结构：`blobs = [action, model, userId]`，`doubles = [1]`，`indexes = [action]`

### 数据归档

AE 数据只保留 90 天。**系统每月 2 日自动归档**（Cron Trigger，见 `worker/archive.ts`）：把归档边界之后所有已完成的月份逐月汇总写入 D1 `usage_archive` 表并推进边界，结果记录在系统日志中。也可以随时手动触发：

```bash
curl -X POST https://your-site/api/stats/archive -H "Authorization: Bearer <token>"
```

- 归档按月顺序推进，每个月的数据行与边界更新在同一个 D1 事务中原子提交，中途失败后重跑不会重复计数
- `/api/stats` 的累计值 = AE 边界之后的数据 + `usage_archive` 归档值，因此归档前后累计数保持一致，不会双重计算
- 未配置 `CF_API_TOKEN` / `CF_ACCOUNT_ID` 时，自动归档静默跳过

## 设置

点击顶栏右侧的齿轮图标打开设置面板。

### AI 模型

可切换 AI 对话和问答使用的 LLM 模型。设置保存后立即生效。

| 模型 | 类型 | 单次消耗 | 说明 |
|------|------|---------|------|
| Llama 3.1 8B | 通用 | ~15 neurons | 轻量快速，适合简单问答 |
| Llama 3.3 70B | 通用 | ~88 neurons | 大模型，综合能力强（默认） |
| DeepSeek R1 32B | 推理 | ~178 neurons | 推理能力强，适合复杂分析 |
| QwQ 32B | 推理 | ~87 neurons | 推理型，中文表现优秀 |

推理模型（DeepSeek R1、QwQ）的输出中可能包含 `<think>...</think>` 思维过程标签，系统会自动清理后再返回给用户。

### API Keys

在设置页面中可配置第三方 API Key，存储在 D1 `settings` 表中。GET 接口自动脱敏（仅返回末尾 4 位），PUT 接口跳过掩码值不覆盖。

| Key | 用途 | 获取方式 |
|-----|------|---------|
| `jina_api_key` | 联网搜索 + URL 导入（Jina AI） | [jina.ai](https://jina.ai) 免费注册 |

优先级：设置页面配置 > 环境变量（`JINA_API_KEY`）。不配置也可使用，但可能受 Jina 限流影响。

### 联网搜索

AI 助手支持联网搜索功能。在对话中输入"搜索 xxx"、"帮我查 xxx"等关键词触发。搜索使用 Jina Search API (`s.jina.ai`)，总结后可点击"保存为笔记"按钮将结果存入知识库。

### 设置接口

- `GET /api/settings` — 获取所有设置（敏感 Key 自动脱敏）
- `PUT /api/settings` — 批量更新设置，掩码值（`****xxxx`）自动跳过

## 开发与调试

### 本地开发（推荐）

```bash
npm run build    # 首次需要先构建一次
npm run dev
```

`npm run dev` 同时启动 Vite 前端（端口 5173，支持 HMR）和 Wrangler 后端（`wrangler dev`，端口 8788）。Vite 自动将 `/api/*` 请求代理到 Wrangler。浏览器访问 `http://localhost:5173`。

本地环境变量通过项目根目录的 `.dev.vars` 文件配置（已在 `.gitignore` 中）：

```
JWT_SECRET=your-local-dev-secret
```

> 注意：本地 D1 使用 `.wrangler/` 目录下的 SQLite 文件，与线上数据库独立。本地环境下 Vectorize 和 Workers AI 需要联网访问 Cloudflare 服务，不可用时相关功能会静默跳过。

### 常见问题排查

页面报 `Unexpected end of JSON input` 或所有 API 请求失败，说明 8788 端口的后端没起来，查看 `npm run dev` 输出中绿色 `api` 部分的报错：

- **`Authentication error [code: 10000]`**：wrangler 当前登录的账号与项目缓存的账号不一致（换过 `wrangler login` 账号会出现）。删除 `node_modules/.cache/wrangler` 目录后重试。
- **`connect ETIMEDOUT`**：Workers AI 绑定启动时需连接 Cloudflare 边缘节点（`*.workers.dev` 域名），国内网络下该域名可能被 DNS 污染。wrangler 不读取系统代理，需在启动前显式设置：`export HTTPS_PROXY=http://127.0.0.1:<代理HTTP端口>` 再 `npm run dev`，或在代理客户端开启 TUN 模式。
- **`The expression evaluated to a falsy value: (databaseId)`**：`wrangler.toml` 里 D1 的 `database_id` 被写成了空字符串。本项目按名称绑定，正确做法是**整行删掉** `database_id`，不要留空值。

线上部署问题：

- **登录提示 `JWT_SECRET 未配置`**：Worker 运行时读不到该变量。浏览器直接访问 `https://你的域名/api/status`，看 `jwt_secret_configured` 字段——为 `false` 说明**当前访问的这个 Worker** 确实没读到（登录页/初始化页也会显示黄色警告条）。依次检查：① 配置位置必须是 Worker 的 **Settings → Variables and Secrets**（运行时变量），不是构建（Build）设置里的环境变量；② 类型选 **Secret**——仪表盘手工添加的 Text 类型变量在旧版本（未设置 `keep_vars` 时）会被下一次 push 部署清除，Secret 类型永不受影响，当前版本已设置 `keep_vars = true`，两种类型都会保留；③ 如果账号里有多个类似 Worker（反复部署产生），确认改的是当前访问域名对应的那个。添加保存后立即生效，无需重新构建，刷新 `/api/status` 应变为 `true`。

本地开发需要 `wrangler login`（AI 绑定要建立远程连接会话）；线上部署与维护不依赖本地 CLI。

### 全栈预览

```bash
npm run build
npm run preview
```

`npm run preview` 执行 `wrangler dev`，在本地完整模拟 Worker + 静态资源环境（含 SPA 回退）。默认地址 `http://localhost:8787`。测试月度归档 Cron 可运行 `wrangler dev --test-scheduled` 后访问 `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=47+2+2+*+*"`。

### 类型检查

```bash
npx tsc --noEmit
```

### 单元测试

```bash
npm test          # 单次运行
npm run test:watch  # 监听模式
```

用 Vitest 覆盖 `worker/utils.ts` 中的纯函数（分块、JWT、密码哈希、内容哈希、think 标签清理、模型白名单、超时保护、AE 埋点结构），用例在 `tests/utils.test.ts`，无需任何 Cloudflare 环境即可运行。

### 构建

```bash
npm run build
```

输出到 `dist/` 目录。

## 项目结构

```
cfnote/
├── worker/                     # 后端 Worker（Hono）
│   ├── index.ts                # 入口：认证中间件 + 路由挂载 + scheduled 导出
│   ├── types.ts                # Hono 应用环境类型
│   ├── utils.ts                # 工具函数（JWT/哈希/分块/模型/AE/Jina）
│   ├── archive.ts              # 用量归档（POST /api/stats/archive 与月度 Cron 共用）
│   └── routes/
│       ├── system.ts           # /api/status、/api/init（表结构唯一来源）、/api/settings、/api/system-logs
│       ├── auth.ts             # /api/auth/register、/api/auth/login
│       ├── notebooks.ts        # /api/notebooks CRUD + /api/notebooks/:id/articles
│       ├── articles.ts         # /api/articles 增删改查 + /import（含向量化）
│       ├── search.ts           # /api/search（语义搜索）、/api/search/ai（AI问答）
│       ├── conversations.ts    # /api/conversations 及消息（AI 对话 + 联网搜索）
│       └── stats.ts            # /api/stats（统计仪表盘）、/api/stats/archive
├── src/                        # 前端 React SPA
│   ├── components/
│   │   ├── SetupPage.tsx      # 初始化 + 注册引导
│   │   ├── LoginPage.tsx      # 登录页
│   │   ├── Layout.tsx         # 四栏主布局（含 AI 面板）
│   │   ├── Sidebar.tsx        # 笔记本侧边栏
│   │   ├── ArticleList.tsx    # 文章列表
│   │   ├── ArticleEditor.tsx  # Markdown 编辑/预览
│   │   ├── AiChatPanel.tsx    # AI 多轮对话面板
│   │   ├── SearchPanel.tsx    # 语义搜索面板
│   │   ├── StatsPanel.tsx     # 统计仪表盘面板
│   │   ├── SettingsPanel.tsx  # AI 模型设置面板
│   │   └── ImportDialog.tsx   # URL导入对话框
│   ├── hooks/
│   │   ├── useAuth.ts         # 登录状态管理
│   │   └── useApi.ts          # API 请求封装
│   ├── types.ts               # TypeScript 类型
│   ├── App.tsx                # 应用入口 + 路由
│   ├── main.tsx               # React 挂载
│   └── index.css              # Tailwind 入口
├── tests/                      # Vitest 单元测试
├── wrangler.toml               # Worker 入口 + 静态资源 + Cron + 绑定配置
├── vite.config.ts
├── tsconfig.json
└── package.json
```
