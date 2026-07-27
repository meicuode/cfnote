# CFNote - 私人知识库系统

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meicuode/cfnote)

基于 Cloudflare 全栈基础设施构建的私人知识库，支持笔记本管理、Markdown/富文本文章编辑、附件与图片、自动向量化与自然语言语义搜索、AI 问答、公开博客与私密分享、网页剪藏等。全程不依赖第三方 LLM API，所有 AI 能力由 Cloudflare Workers AI 提供，设计在免费额度内运行。

## 技术架构

```
┌────────────────────────────────────────────────────────────┐
│         Cloudflare Workers + Static Assets                 │
│                                                            │
│   React + Tailwind CSS (SPA, 静态资源直出)                  │
│   ┌────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────┐  │
│   │ 笔记本  │ │ 文章列表  │ │ 源码/富文本/ │ │ AI 多轮   │  │
│   │ 侧边栏  │ │ 标签/回收 │ │ 预览 编辑    │ │ 对话面板  │  │
│   └────────┘ └──────────┘ └──────────────┘ └───────────┘  │
│   公开博客 /blog · 私密分享 · 网页剪藏 /clip · 文件管理     │
│                    │ /api/*                                │
│         Worker (Hono 路由 + 月度归档 Cron)                  │
│                    │                                       │
│   ┌─────────┬─────────┬────────────┬──────────┐            │
│   │   D1    │Vectorize│ Workers AI │    R2     │            │
│   │ SQLite  │ 向量索引 │ 嵌入 + LLM │ 附件存储  │            │
│   └─────────┴─────────┴────────────┴──────────┘            │
└────────────────────────────────────────────────────────────┘
```

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS 4 + Vite 6（Workers Static Assets 直出，请求免费不限量） |
| 富文本 | Tiptap（ProseMirror）所见即所得编辑，标准 Markdown 存储；marked 渲染 + turndown 反向转换 |
| 后端 | Cloudflare Worker + Hono 路由，`/api/*` 走 Worker，其余走静态资源 |
| 数据库 | Cloudflare D1 (边缘 SQLite) |
| 向量搜索 | Cloudflare Vectorize (1024维, cosine) |
| 附件存储 | Cloudflare R2（图片/任意文件，免费额度 10GB） |
| 嵌入模型 | `@cf/baai/bge-m3` (多语言) |
| 文本生成 | 可在设置页面切换，默认 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| 定时任务 | Cron Triggers，每月自动归档用量统计 + 回收站过期清理 |

## 核心功能

### 编辑与组织

- **笔记本管理**：创建/删除笔记本，每个笔记本包含多篇文章；侧栏可折叠（状态记忆）
- **三模式编辑**：源码 Markdown / 富文本所见即所得 / 预览，一键切换，3秒无操作自动保存；全程标准 Markdown 存储（无私有方言，可自由迁移）
- **富文本编辑器**：基于 Tiptap，支持标题/列表/引用/代码块/表格/图片等，粘贴网页富文本自动转 Markdown，粘贴代码/Markdown 原样保留
- **代码高亮 / 数学公式 / 图表**：预览与博客对代码块做语法高亮（highlight.js）、渲染 `$…$` / `$$…$$` LaTeX 公式（KaTeX）、把 ` ```mermaid ` 代码块渲染为流程图/时序图等（mermaid）；三库均按需懒加载，无对应内容的页面零开销
- **附件与图片**：拖入/粘贴截图直传 R2，任意文件上传；XMind 文件在线预览+编辑回存；编辑器可从文件库选择已有附件插入
- **标签**：文章标题下打标签（Enter/逗号添加，datalist 补全已有标签，上限 20）；侧栏标签区可折叠、按使用频次排序显示常用标签为紧凑 chips，标签多时点「全部标签」开可搜索浏览器；列表项显示前 3 个
- **置顶**：列表悬浮 📌 切换，置顶排最前
- **回收站**：删除进回收站（软删除），30 天内可恢复（重建向量索引）或彻底删除，30 天后自动清理
- **版本历史**：内容变更保存时自动快照（每小时合并为一版，更早的按天保留），编辑器「历史」按钮查看/预览/一键恢复任一版本
- **提醒**：为笔记设置提醒时间（今晚/明天/下周预设或自定义），顶栏铃铛按到期/即将到期分组展示并显示到期数徽标，点击打开或标记完成；到期还可**推送到企业微信 / 飞书 / 钉钉 / 个人微信(Server酱) / Telegram / 自定义 Webhook**（设置面板配置，每 5 分钟 cron 扫描）
- **任务清单**：GFM `- [ ]` 在预览模式可直接点击勾选并回写源文
- **笔记间链接 + 反向链接**：工具栏插入笔记链接（标题搜索），预览中点击应用内跳转；编辑器顶部显示反链
- **笔记模板**：约定「模板」笔记本，新建笔记时可选择套用
- **深色模式**：跟随系统或手动切换（记忆）

### 检索与 AI

- **混合搜索**：向量语义召回 + 关键词召回（标题权重更高），RRF 融合排序——既能"按意思找"也能精确匹配函数名、专有名词等短词，不消耗 LLM 额度
- **AI 多轮对话**：右侧常驻聊天面板，基于知识库多轮问答，**流式逐字输出**（推理模型下发 think 思考过程，前端折叠展示），历史对话持久化，面板宽度可拖拽
- **联网搜索**：AI 助手支持联网搜索，输入"搜索 xxx"触发，结果可一键保存为笔记
- **AI 模型设置**：切换 Workers AI 模型（Llama 3.1 8B / Llama 3.3 70B / DeepSeek R1 32B / QwQ 32B），推理模型自动清理 `<think>` 标签

### 采集与发布

- **URL 导入**：通过 Jina Reader 抓取网页内容并自动向量化入库
- **网页剪藏**：书签栏 bookmarklet 抓取选区/正文 → `/clip` 页 turndown 转 Markdown → 选笔记本存为笔记
- **公开博客**：一键公开笔记到整站博客 `/blog`（IT之家风格，亮/暗双主题，浏览计数去重，热榜）；发布前对全文做敏感信息检查
- **博客管理**：侧栏「博客管理」内联展示（非弹窗）所有已公开文章，**按修改时间降序**，支持标题搜索、按笔记本过滤、预览、打开编辑、一键取消公开（`?panel=blog` 可刷新保持）；其下「评论管理」为二级菜单（`?panel=comments`）
- **评论**：公开博客文章底部支持访客评论（昵称必填、邮箱可选不公开），**默认需审核**（设置可切免审核），支持 2 层嵌套回复与博主回复；侧栏「博客管理 → 评论管理」审核（通过/拒绝/删除/回复），待审计数徽标；轻量防刷（每 IP 每分钟限流 + 蜜罐 + 长度上限），有待审评论可推送到已配置的通知渠道
- **私密分享**：为单篇笔记生成带有效期的私密链接 `/blog/share/<token>`，凭链接可看但不入博客列表/热榜，设为私有或删除自动撤销
- **私有/私密文件夹**：私有笔记不可公开、列表标识；「我的私密文件夹」中的附件对访客一票否决

### 系统

- **统计仪表盘**：实时查看知识库规模、Workers AI 额度消耗、向量存储使用率、调用次数趋势和按模型分组的调用统计
- **附件访问分级**：未公开笔记的附件对匿名访客返回 404（登录态 cookie 副本放行同源 `<img>`），取消公开后新访客最多 5 分钟内失效
- **URL 路由与刷新恢复**：当前笔记本/文章/主模块面板（文件管理·设置·统计·日志·博客管理·评论管理）编入地址栏，刷新与浏览器前进/后退可恢复视图；可把某篇笔记作为链接分享（`/nb/:id/:articleId`）。手写轻量路由，不引入 react-router
- **首次初始化引导**：自动检测系统状态，引导创建数据库和用户
- **数据导出/导入**：一键导出全部笔记本、文章、标签与对话为 JSON（不含敏感配置）；支持导入恢复与本地 md/txt 批量导入

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
2. 向导中选择或创建 D1 数据库（`cfnote-db`）、Vectorize 索引（`cfnote-index`）和 R2 存储桶（`cfnote-files`，用于图片/附件；R2 需在账号中先开通，免费额度 10GB）
3. 新建 Vectorize 索引时，dimensions 填 **`1024`**，metric 选 **`cosine`**（1024 是嵌入模型 `@cf/baai/bge-m3` 的输出维度）。注意这两项创建后不可修改：dimensions 填错向量化会直接报错，metric 选错搜索排序会完全失真，只能删除索引后重建
4. 部署向导中按提示填写 `JWT_SECRET`（随机字符串即可）；部署完成后到 Worker 的 **Settings → Variables and Secrets** 确认它以 **Secret** 类型存在，没有就补加一条
5. 访问站点，按引导完成初始化：建表 → 创建账户 → 进入主界面

> 注意：按钮创建的是独立仓库，与本仓库**没有 fork 关系**，日后无法一键同步上游更新（即使你先 fork 再点按钮，它仍会另建一个新仓库）。想持续跟进更新，请用方式二。

### 方式二：Fork + 仪表盘连接 Git（推荐，可持续更新）

1. Fork 本仓库到你的 GitHub 账号
2. Cloudflare 仪表盘中创建 D1 数据库 `cfnote-db`、Vectorize 索引 `cfnote-index`（1024 维，cosine）和 R2 存储桶 `cfnote-files`（需先在 R2 页面开通，免费额度 10GB；不创建该桶部署会失败，创建后重试构建即可）
3. Workers 页面选择「连接 Git 仓库」指向你的 fork（构建命令 `npm run build`，部署命令 `npx wrangler deploy`）。`wrangler.toml` 按名称绑定资源，fork 无需修改任何文件；若首次构建报 database_id 相关错误，把仪表盘中 D1 详情页的 ID 填入 `wrangler.toml` 再 push 一次即可
4. 在 Worker 的 Settings → Variables and Secrets 中添加 Secret `JWT_SECRET`（以及可选的 `CF_API_TOKEN` / `CF_ACCOUNT_ID`）
5. 访问站点，按引导完成初始化
6. **后续更新**：本仓库发新版后，在你 fork 的 GitHub 页面点 **Sync fork → Update branch**，push 后自动重新构建部署

### 方式三：本地 CLI

```bash
wrangler login
wrangler d1 create cfnote-db
wrangler vectorize create cfnote-index --dimensions=1024 --metric=cosine
wrangler r2 bucket create cfnote-files
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

### 提醒与推送渠道

给笔记设提醒后，到期会在顶栏铃铛提示；还可在 **设置 → 通知渠道 / 提醒推送** 配置企业微信 / 飞书 / 钉钉 / 个人微信(Server酱) / Telegram / 自定义 Webhook，到期由每 5 分钟的 Cron 推送到手机。各渠道逐步配置说明见 **[docs/notifications.md](docs/notifications.md)**（每个渠道从哪里拿 Webhook/token、填哪个字段、如何用「测试」按钮验证）。

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

用 Vitest 覆盖后端 `worker/utils.ts` 中的纯函数（分块、JWT、密码哈希、内容哈希、think 标签清理、模型白名单、超时保护、AE 埋点结构）与前端纯逻辑（标签解析、任务勾选回写、私密文件夹判定与分享有效期、剪藏 bookmarklet 生成、URL 路由解析、评论校验与嵌套线程、敏感扫描、图片调宽等），共 22 个测试文件、212 个用例，无需任何 Cloudflare 环境即可运行。

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
│   ├── migrate.ts              # 应用内幂等 schema 保障（增量加列/建表，与 system.ts 同步）
│   ├── archive.ts              # 用量归档（POST /api/stats/archive 与月度 Cron 共用）
│   └── routes/
│       ├── system.ts           # /api/status、/api/init（表结构唯一来源）、/api/settings、/api/system-logs
│       ├── auth.ts             # /api/auth/register、/api/auth/login
│       ├── notebooks.ts        # /api/notebooks CRUD + /api/notebooks/:id/articles
│       ├── articles.ts         # 文章增删改查/import/回收站/标签/置顶/私密分享/backlinks/titles
│       ├── search.ts           # /api/search（混合搜索）、/api/search/ai（AI问答）
│       ├── conversations.ts    # /api/conversations 及消息（AI 对话 + 联网搜索）
│       ├── blog.ts             # /api/blog/*（公开博客列表/详情/热榜 + 私密分享）
│       ├── files.ts            # /api/files/*（附件读写，免登录 GET + 访问分级）、/api/share/*（文件分享）
│       ├── fm.ts               # /api/fm/*（文件管理：目录树、移动、引用、私密文件夹）
│       └── stats.ts            # /api/stats（统计仪表盘）、/api/stats/archive
├── src/                        # 前端 React SPA
│   ├── components/
│   │   ├── SetupPage.tsx      # 初始化 + 注册引导
│   │   ├── LoginPage.tsx      # 登录页
│   │   ├── Layout.tsx         # 四栏主布局（含 AI 面板，列宽可拖拽/侧栏可折叠）
│   │   ├── Sidebar.tsx        # 笔记本 + 标签 + 回收站 + 文件管理 + 网页剪藏侧边栏
│   │   ├── ArticleList.tsx    # 文章列表（置顶/标签/回收站视图）
│   │   ├── ArticleEditor.tsx  # 源码/富文本/预览三模式编辑器
│   │   ├── WysiwygEditor.tsx  # Tiptap 所见即所得编辑器（懒加载）
│   │   ├── AiChatPanel.tsx    # AI 多轮对话面板
│   │   ├── SearchPanel.tsx    # 混合搜索面板
│   │   ├── BlogPage.tsx       # 公开博客页 /blog（免登录，独立 chunk）
│   │   ├── ClipPage.tsx       # 网页剪藏接收页 /clip（独立 chunk）
│   │   ├── FileManager.tsx    # 文件管理（目录/搜索/预览/分享/清理）
│   │   ├── FilePickerDialog.tsx # 编辑器文件库选择器（懒加载共享 chunk）
│   │   ├── NoteLinkDialog.tsx # 笔记间链接标题搜索（懒加载共享 chunk）
│   │   ├── XmindViewer.tsx    # XMind 在线查看/编辑器（懒加载）
│   │   ├── StatsPanel.tsx     # 统计仪表盘面板
│   │   ├── SettingsPanel.tsx  # AI 模型 + API Key + 数据备份设置面板
│   │   ├── SystemLogsPanel.tsx # 系统日志面板
│   │   ├── ConfirmDialog.tsx  # 通用确认对话框
│   │   └── ImportDialog.tsx   # URL导入 / 本地文件导入对话框
│   ├── lib/                   # 前端纯逻辑（markdown 渲染、URL 路由解析、剪藏、缩略图、敏感扫描、图片调宽、xmind、fm 工具等）
│   ├── hooks/
│   │   ├── useAuth.ts         # 登录状态 + 附件 cookie 副本
│   │   └── useApi.ts          # API 请求封装
│   ├── types.ts               # TypeScript 类型
│   ├── App.tsx                # 应用入口 + 路由（/blog、/clip 分流懒加载）
│   ├── main.tsx               # React 挂载
│   └── index.css              # Tailwind 入口 + 深色映射
├── docs/                       # 需求与设计文档（roadmap、evernote-gap、file-manager、public-blog、wysiwyg-editor、notifications）
├── tests/                      # Vitest 单元测试
├── wrangler.toml               # Worker 入口 + 静态资源 + Cron + 绑定（D1/Vectorize/AI/R2/AE）
├── vite.config.ts
├── tsconfig.json
└── package.json
```
