# CFNote - 私人知识库系统设计文档

> 本文档描述当前架构（Cloudflare Workers + Static Assets），并且是**逐批决策与取舍的唯一记录**（见 §10）。
> 专题文档在 `docs/`，哪份是活的、哪份是历史存档见 [`docs/README.md`](docs/README.md) 文档地图：
> **活** — `file-manager.md`（附件与文件管理）、`notifications.md`（提醒与推送渠道配置）、`evernote-gap.md` 的对标表（还差什么、哪些明确不做）；
> **历史** — `public-blog.md`（P7 博客初版）、`wysiwyg-editor.md`（P6 富文本）、`roadmap-2026-07.md`（P1–P7 原始需求，已冻结）。

## 1. 项目概述

基于 Cloudflare 全栈基础设施构建的单用户私人知识库系统，支持笔记本管理、Markdown/富文本编辑、附件与图片、自动向量化、自然语言语义搜索、AI 问答与多轮对话、公开博客与私密分享、网页剪藏等。全程不依赖第三方 LLM API，所有 AI 能力均由 Cloudflare Workers AI 提供，设计在免费额度内运行。

## 2. 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端框架 | React 19 + TypeScript | SPA 单页应用 |
| 样式 | Tailwind CSS 4 | 原子化 CSS，含深色映射 |
| 构建工具 | Vite 6 | 快速构建，前端产物由 Workers Static Assets 直出 |
| Markdown | marked（渲染）+ turndown（HTML→MD 反向转换） | 标准 Markdown |
| 代码高亮/公式/图表 | highlight.js（`lib/common` 36 种 + `hljsLanguages.ts` 补 31 种按需注册）+ KaTeX（`$…$`/`$$…$$`）+ mermaid（```mermaid）| 渲染后增强，均按需懒加载 |
| 富文本 | Tiptap（ProseMirror） | 所见即所得编辑，序列化回标准 Markdown |
| 后端 API | Cloudflare Worker + Hono 路由 | `/api/*` 走 Worker，其余走静态资源（SPA 回退） |
| 数据库 | Cloudflare D1 | 边缘 SQLite 数据库 |
| 向量搜索 | Cloudflare Vectorize | 1024 维，cosine |
| 附件存储 | Cloudflare R2 | 图片/任意文件，免费额度 10GB |
| AI 推理 | Cloudflare Workers AI | 嵌入 + 文本生成 |
| 用量采集 | Cloudflare Analytics Engine | 不占 D1 写配额 |
| 定时任务 | Cron Triggers | 月度用量归档 + 回收站过期清理；每 5 分钟：到期提醒推送 + 自动备份到期判定 |

### AI 模型选择

| 用途 | 模型 | 维度/参数 | 选择理由 |
|------|------|-----------|----------|
| 文本嵌入 | `@cf/baai/bge-m3` | 1024维 | 多语言专用，中文检索效果最佳 |
| 文本生成（默认） | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B | 综合能力强，可在设置页切换 |

文本生成模型可在设置页面切换：Llama 3.1 8B（~15 neurons/次，最省）、Llama 3.3 70B（默认）、DeepSeek R1 32B（推理）、QwQ 32B（推理，中文佳）。推理模型输出中的 `<think>...</think>` 会被自动清理。

## 3. 系统架构

```
┌────────────────────────────────────────────────────────────┐
│              Cloudflare Workers + Static Assets            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            React SPA (Tailwind CSS 4)                 │  │
│  │  ┌──────┐ ┌──────────┐ ┌──────────────┐ ┌─────────┐ │  │
│  │  │笔记本│ │文章列表   │ │源码/富文本/  │ │AI 对话  │ │  │
│  │  │标签  │ │(置顶/回收)│ │预览 编辑器   │ │面板     │ │  │
│  │  └──────┘ └──────────┘ └──────────────┘ └─────────┘ │  │
│  │  公开博客 /blog · 私密分享 · 网页剪藏 /clip · 文件管理 │  │
│  └──────────────────────────────────────────────────────┘  │
│                     │ /api/*（Hono 路由，run_worker_first） │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Worker（Hono）+ 月度/清理 Cron           │  │
│  └──────┬──────────┬──────────┬──────────┬───────────────┘  │
│         │          │          │          │                  │
│    ┌────▼───┐ ┌────▼────┐ ┌──▼───────┐ ┌▼─────┐            │
│    │   D1   │ │Vectorize│ │Workers AI│ │  R2  │            │
│    │ SQLite │ │ 向量索引 │ │ 嵌入+LLM │ │ 附件 │            │
│    └────────┘ └─────────┘ └──────────┘ └──────┘            │
└────────────────────────────────────────────────────────────┘
```

`wrangler.toml` 中 `[assets] not_found_handling = "single-page-application"` + `run_worker_first = ["/api/*", "/blog/*", "/robots.txt", "/sitemap.xml"]`：这几类路径优先进 Worker，其余路径由平台直出静态资源，未命中回退 SPA 入口（`/clip`、博客列表页 `/blog` 等前端路由由此工作）。

`/blog/*`（P12.6）是详情页服务端预渲染，代价要记清楚：**它把博客详情页从「静态资源请求（免费不限量）」变成了「Worker 请求（计入 10 万/天）」**，且这一步无法在运行时关闭——`run_worker_first` 是部署时配置。完整预渲染档同时省掉了 `/api/blog/posts/:id`（数据内联进 HTML），所以每次访问仍是 1 次计费请求；「仅 meta」与「关闭」两档则是 2 次。见 `docs/public-blog.md`。

### 核心流程

**文章保存 → 自动向量化：**
```
保存文章 → D1存储 → 计算 content_hash（内容未变则跳过）
         → 文本分块(500字/块,100字重叠) → Workers AI 嵌入
         → Vectorize 存储向量 → 记录 chunks → is_vectorized=1
```

**自然语言搜索（混合）：**
```
用户查询 →（并行）向量召回：查询嵌入 → Vectorize topK
              关键词召回：按空白切词 → title/content LIKE（标题权重更高）
         → RRF(k=60) 融合去重排序 → 返回片段
         → [AI问答] 取 top5 分块原文 → LLM 生成回答 + 引用
```

## 4. Cloudflare 免费额度分析

### 4.1 各服务免费限额

| 服务 | 免费额度 | 说明 |
|------|---------|------|
| Workers AI | **10,000 neurons/天** | 超出后请求失败，每日 UTC 0 点重置 |
| Vectorize 存储 | **500万维度** | 总量限制 |
| Vectorize 查询 | **3000万维度/月** | 月度限制 |
| D1 读取 | **500万行/天** | 每日重置 |
| D1 写入 | **10万行/天** | 每日重置 |
| D1 存储 | **5 GB** | 总量限制 |
| R2 存储 | **10 GB** | 附件总量 |
| Workers 请求 | **10万次/天** | 静态资源请求不计入；但 `run_worker_first` 覆盖的路径计入（P12.6 起博客详情页 `/blog/:id` 在内） |

### 4.2 目标场景适配（200篇3000字文章，100次/天搜索）

| 资源 | 消耗 | 免费额度 | 占比 |
|------|------|---------|------|
| 向量存储 | 1,433,600 维（1400 块 × 1024） | 5,000,000 维 | 28.7% ✅ |
| 向量查询 | 3,072,000 维/月（3000 次 × 1024） | 30,000,000 维/月 | 10.2% ✅ |
| Workers AI | ~215 neurons/天 | 10,000 neurons/天 | 2.15% ✅ |
| D1 读写 | <5,000 行/天 | 500万读 + 10万写/天 | <0.1% ✅ |

**结论：该场景下所有指标均在免费额度约 30% 以内，有充足余量。**

## 5. 数据库设计（D1）

表结构的**唯一来源**是 `worker/routes/system.ts` 的 `SCHEMA`（`POST /api/init` 全新建库执行）。`worker/migrate.ts` 对已有旧库做**幂等增量**补列/建表（每个 isolate 首个 API 请求执行一次后 memoize），两者保持同步。

> **开发阶段 schema 约定（重要）**：只写增量幂等语句（`ALTER TABLE ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`），不做数据迁移/回填。若发生不兼容的表结构变更，不写迁移机制，直接提示用户在线上清空并重新 `/api/init`。

### 5.1 核心表

```sql
-- 用户
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 笔记本
CREATE TABLE notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#10B981',
  article_count INTEGER DEFAULT 0,
  deleted_at TEXT,                    -- P14.1 回收站软删除时间戳（30 天后清理）；非空即从侧栏隐藏
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 文章
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notebook_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  is_vectorized INTEGER DEFAULT 0,
  is_public INTEGER DEFAULT 0,        -- 公开到博客（与 is_private 互斥）
  is_private INTEGER DEFAULT 0,       -- 私有笔记：不可公开
  is_page INTEGER DEFAULT 0,          -- 单页（P13.4）：仍可公开访问，但不进列表/热榜/相关/上下篇/RSS
  published_at TEXT,                  -- 首次公开时间
  views INTEGER DEFAULT 0,            -- 博客浏览计数（Cache API 去重）
  deleted_at TEXT,                    -- 回收站软删除时间戳（30 天后清理）
  tags TEXT,                          -- JSON 数组文本，json_each 聚合/筛选
  pinned INTEGER DEFAULT 0,           -- 置顶
  share_token TEXT,                   -- 私密分享 token（单分享）
  share_expires_at TEXT,              -- 分享有效期（NULL=永久）
  remind_at TEXT,                     -- 应用内提醒时间（ISO UTC，NULL=无；移入回收站自动清空）
  reminded_at TEXT,                   -- 提醒已推送时间（防 cron 重发；设置/清除提醒时置 NULL 重新武装）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 文章分块（向量化追踪）
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  vector_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

-- 文章版本快照（P10 版本历史）
CREATE TABLE article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX idx_articles_notebook ON articles(notebook_id);
CREATE INDEX idx_articles_user ON articles(user_id);
CREATE INDEX idx_articles_share ON articles(share_token);
CREATE INDEX idx_chunks_article ON chunks(article_id);
CREATE INDEX idx_article_versions ON article_versions(article_id, created_at);
CREATE INDEX idx_notebooks_user ON notebooks(user_id);

-- 访客评论（P11.2）
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  parent_id INTEGER,                 -- 被回复评论 id（NULL=顶层）
  root_id INTEGER,                   -- 顶层祖先 id；2 层展示按它分组
  author_name TEXT NOT NULL,
  author_email TEXT,                 -- 可选，不公开
  content TEXT NOT NULL,             -- 存原文；博客页按极小 Markdown 子集渲染（P13.9），管理端仍纯文本
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  is_admin INTEGER DEFAULT 0,        -- 博主回复
  ip_hash TEXT,                      -- 历史列（P11.9 起不再写入，见下）
  ip TEXT,                           -- P11.9：明文来源 IP，仅管理端可见
  user_agent TEXT,                   -- P11.9：原始 UA（截断 300 字符），仅管理端可见
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);
CREATE INDEX idx_comments_article ON comments(article_id, status, created_at);
CREATE INDEX idx_comments_status ON comments(status, created_at);
```

### 5.2 AI 对话

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversations_user ON conversations(user_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,               -- user | assistant
  content TEXT NOT NULL,
  sources TEXT,                     -- 引用来源 JSON
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

### 5.3 附件与文件（P8）

```sql
-- 附件对象（R2 key 唯一）
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,          -- R2 key: u{uid}/{32位随机}/{文件名}
  name TEXT NOT NULL,
  folder_id INTEGER,                 -- 所属文件夹（NULL=根）
  size INTEGER DEFAULT 0,
  content_type TEXT,
  category TEXT DEFAULT 'other',     -- image | file | xmind | other
  share_token TEXT,                  -- 文件分享 token（单分享）
  share_expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_files_share ON files(share_token);

-- 文件夹（可嵌套；is_private 子树为「我的私密文件夹」）
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  is_private INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 文章↔附件引用索引（内容为事实源，此表派生）
CREATE TABLE article_files (
  article_id INTEGER NOT NULL,
  file_key TEXT NOT NULL,
  PRIMARY KEY (article_id, file_key)
);
CREATE INDEX idx_article_files_key ON article_files(file_key);
```

### 5.4 系统与统计

```sql
CREATE TABLE settings (           -- 键值设置（AI 模型、API Key 等）
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE system_logs (        -- 系统日志（error/warn/info）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL, source TEXT, message TEXT NOT NULL, detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_system_logs_level_time ON system_logs(level, created_at);
CREATE TABLE usage_archive (...); -- 用量按月归档（AE 只留 90 天，见 §统计）
```

## 6. API 接口设计

所有接口（除下列免登录项）需携带 `Authorization: Bearer <token>`。免登录：`GET /api/status`、`POST /api/init`、`POST /api/auth/*`、`GET /api/blog/*`、`GET|HEAD /api/files/*`、`GET /api/share/*`、`GET /api/afile/*`（后三者内部做访问分级）。

### 6.1 系统 / 认证（`/api`, `/api/auth`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 是否已初始化 + `jwt_secret_configured` |
| POST | `/api/init` | 建表（SCHEMA 唯一来源） |
| POST | `/api/auth/register` `/login` | 注册（初始化后首次）/ 登录返回 JWT |
| GET/PUT | `/api/settings` | 设置读取（敏感 Key 脱敏，`notify_channels` 逐字段脱敏）/ 更新（掩码跳过；渠道按 id 逐字段合并回真值） |
| GET | `/api/export` | 导出全部数据为 JSON（排除敏感项）。含文章公开状态/浏览数、评论、博客展示层设置；`?versions=1` 额外带历史版本 |
| POST | `/api/import` | 导入恢复（笔记本/文章/评论/博客设置；评论按文章映射重挂，设置不覆盖已有值） |
| GET | `/api/backups` | 自动备份列表 + 当前配置（频率/保留份数/上次结果，P14.2） |
| POST | `/api/backups/run` | 立即备份一次到 R2 |
| GET/DELETE | `/api/backups/:name` | 下载 / 删除某一份（`:name` 必须匹配备份命名，否则 404） |
| POST | `/api/reindex` | 分批补向量索引 |
| GET/DELETE | `/api/system-logs` | 系统日志查询 / 清理 |

### 6.2 笔记本 / 文章（`/api/notebooks`, `/api/articles`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/notebooks[/:id]` | 笔记本 CRUD（DELETE 为**软删除**，连同其中笔记一起进回收站，P14.1） |
| GET | `/api/notebooks/trash`、POST `/:id/restore`、DELETE `/:id/purge` | 回收站中的笔记本 / 整本恢复（连带其中笔记）/ 彻底删除（附件走引用计数） |
| GET | `/api/notebooks/:id/articles` | 笔记本下文章列表（置顶优先） |
| POST | `/api/articles` | 创建（自动向量化） |
| GET/PUT/DELETE | `/api/articles/:id` | 详情 / 更新（内容变则重向量化）/ 软删除入回收站 |
| POST | `/api/articles/import` | URL 导入（Jina Reader） |
| GET | `/api/articles/private` `/published` `/tags` `/by-tag` `/trash` | 私有 / 已公开(博客管理,按 updated_at 降序) / 标签聚合 / 按标签 / 回收站视图 |
| GET | `/api/articles/trash/impact` | 清空回收站的只读预检：会连带清掉几个附件、共多大（P14.1） |
| POST | `/api/articles/trash/empty`、`/:id/restore`、DELETE `/:id/purge` | 清空/恢复/彻底删除 |
| GET | `/api/articles/titles?q=`、`/:id/backlinks` | 笔记链接标题搜索 / 反向链接 |
| GET | `/api/articles/:id/versions[/:vid]` | 版本历史列表（元信息）/ 单版本全文 |
| GET | `/api/articles/reminders` | 提醒列表（设了 remind_at 且未删除的笔记，按时间升序） |
| PUT | `/api/articles/:id/reminder` | 设置/清除提醒时间（body `{remind_at: ISO \| null}`） |
| POST/DELETE | `/api/articles/:id/share` | 生成/撤销私密分享链接 |

### 6.3 搜索 / 对话（`/api/search`, `/api/conversations`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/search` | 混合搜索（向量 + 关键词 RRF，不消耗 LLM） |
| POST | `/api/search/ai` | AI 问答（检索 + LLM 生成） |
| GET/POST/DELETE | `/api/conversations[/:id]` | 对话管理 |
| POST | `/api/conversations/:id/messages` | 发消息（流式；支持联网搜索） |

### 6.4 附件 / 文件管理（`/api/files`, `/api/afile`, `/api/share`, `/api/fm`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/HEAD | `/api/files/*` | 附件读取（免登录 + 访问分级，`<img>` 直引） |
| POST | `/api/files` | 上传到 R2 并登记 |
| GET | `/api/afile/*` | 间接链接读取（同访问分级） |
| GET/HEAD | `/api/share/:token/:tail?` | 文件分享链接（过期 410） |
| — | `/api/fm/*` | 文件管理：目录树总览、文件列表、移动、引用查询、私密文件夹、文件分享增删 |
| POST | `/api/fm/files/batch` | 批量移动 / 删除 / 复制（一次请求，见 §10 P13.3） |

### 6.5 公开博客 / 统计（`/api/blog`, `/api/stats`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/blog/posts` `/:id` `/hot` | 博客列表（分页 `?limit&offset` + 筛选 `?tag&q`，返回 `{ posts, has_more, layout, skin, hot?, recent?, tag_cloud?, slider?, grid? }`，P12.3/12.4/12.5）/ 详情（计浏览，同样带 layout+skin 与该页模块数据，`?preview=1` 不计浏览）/ 热榜（保留供直接调用，页面已不再单独请求） |
| GET | `/api/blog/share/:token` | 私密分享详情（不入列表/不计浏览，过期 410） |
| GET/POST | `/api/blog/comments` | 某公开文章已通过评论（2 层线程）/ 访客提交（免登录，默认待审核，限流+蜜罐；POST 回传 `{status,id,parent_id,root_id,created_at}` 供前端就地渲染待审那条，P11.7） |
| GET | `/api/comments` `/counts` | 评论审核列表 / 待审计数（鉴权，经文章所有权） |
| POST | `/api/comments/:id/approve` `/reject` `/reply` | 通过 / 拒绝 / 博主回复（自动通过） |
| DELETE | `/api/comments/:id` | 删除评论 |
| GET/POST | `/api/stats` `/stats/archive` | 统计仪表盘 / 用量归档 |
| POST | `/api/notify/test` | 用面板填写的渠道配置发一条测试消息 |

页面级路由（P12.6，`worker/routes/pages.ts`，免登录，不在 `/api` 下）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/blog/:id` | 详情页 HTML。按 `settings.blog_prerender` 三档处理：`full` 注入 `<head>`（title/description/og/twitter/canonical/JSON-LD）+ 正文 + 纯链接内链 + `window.__CFNOTE_BLOG__` 内联状态（前端因此不再打 `/api/blog/posts/:id`）；`meta` 只注入 `<head>`；`off` 原样透传。文章不存在返回真 404 + `noindex`；`?preview=1` 透传且 `noindex`；边缘缓存 60 秒（键含档位），命中缓存仍计浏览数 |
| GET | `/blog/share/:token` | 透传 + `X-Robots-Tag: noindex, nofollow`（unlisted，不该进索引） |
| GET | `/blog/feed.xml` | RSS 2.0，最近 20 篇，`<description>` 为摘要非全文 |
| GET | `/sitemap.xml` | 全部公开文章 + 列表页；「加载更多」的必要配套 |
| GET | `/robots.txt` | `Sitemap:` 用请求自身 origin；挡掉 `/api/`、`/blog/share/`、`/blog?` 筛选页 |

### 认证机制

- 密码 PBKDF2-SHA256（Web Crypto，100,000 次迭代）+ 随机盐
- JWT（HMAC-SHA256），有效期 7 天，密钥存 Worker Secret `JWT_SECRET`；**无吊销机制**（无 `jti`/黑名单，登出只清客户端），token 泄露后最长 7 天内仍可用
- 登录限流（P16.6）：每 IP 每 15 分钟 8 次失败，超限 429 + `Retry-After`，**判断排在密码校验之前**（超限时不跑 PBKDF2）；成功登录清账。缓存不可用时降级为放行
- 用户不存在时也照算一遍等价的 PBKDF2（固定假盐，结果丢弃），使两条失败路径耗时一致，不从响应时间泄露用户名是否存在
- 附件读取额外接受同源 cookie 副本（`cfnote_t`，仅 `GET/HEAD /api/files` 认，写操作只认请求头，不引入 CSRF 面）

## 7. 前端页面设计

### 7.1 路由（前端 SPA + 平台分流）

**顶层分流**(`App.tsx` 模块级正则判定 `window.location.pathname`,独立懒加载 chunk):

| 路径 | 页面 | 鉴权 |
|------|------|------|
| `/blog`、`/blog/:id`、`/blog/:id/:slug`、`/blog/share/:token` | 公开博客（独立 chunk，不进应用壳；自带 pushState/popstate）。slug 段（P15.2）纯属装饰，判定视图的正则只取 `:id` | 免登录 |
| `/clip` | 网页剪藏接收页（独立 chunk） | 需登录 |
| 其余全部 | 主应用 `MainApp`（setup/login/app 三态自动切换） | 需登录 |

**主应用内部路由**(P10.6,`src/lib/route.ts` 纯函数解析/生成 + `Layout.tsx` 双向同步;刷新与前进/后退按 URL 恢复视图):

| 路径 / 参数 | 视图 |
|------|------|
| `/` | 未选笔记本(或回退 localStorage 恢复上次) |
| `/nb/:id`、`/nb/:id/:articleId` | 真实笔记本(可带打开的文章) |
| `/private`、`/trash`、`/tag/:name`(可各带 `/:articleId`) | 私有 / 回收站 / 标签 虚拟视图 |
| `?panel=files\|settings\|stats\|logs\|blog\|comments\|layout` | 叠加在基础路径上的主模块面板。**文件管理(files)与博客管理(blog/comments/layout)为内联工作区视图**(占据侧栏右侧区域,非弹窗);设置/统计/日志仍为叠层面板 |
| `&fm=unref\|nb:<id>\|folder:<id>` | 文件管理子视图(P11.6,侧栏二级菜单选中项);默认「全部文件」不写入,非法值与非 files 面板一律忽略 |
| `/?article=<id>` | 兼容深链(`window.open` 生产):拉文章定位笔记本后 `replaceState` 规范化为 `/nb/:nbId/:id` |

- **双向同步机制**:`URL→视图` 在首次笔记本加载后(及 `popstate`)`parseLocation` 套用到 `activeNotebook/activeArticle/面板`;`视图→URL` 以 20ms 去抖把「选笔记本→清空文章」等同步级联并为一次 `pushState`。**防环**靠幂等等值比较(目标 URL 已等于当前则不写)+ `applyingRef` 在套用期间抑制回写(状态落位后自动释放)。
- AI 对话折叠状态、各列宽度等布局偏好仍存 localStorage(不进 URL);搜索/提醒/导入/模板等临时弹层不进 URL。

### 7.2 主应用布局（桌面四栏，窄屏单列返回栈；emerald 绿 Evernote 风格）

```
桌面（≥1024px）
┌──────────────────────────────────────────────────────────────┐
│ ☰  🔍搜索           主题  统计  设置  AI  用户名  退出        │
├────────┬──────────────┬─────────────────────────┬────────────┤
│笔记本   │  文章列表     │  源码/富文本/预览 编辑器 │ AI 对话    │
│标签     │ (可拖宽,置顶) │  标题 / #标签 / 目录     │ 面板       │
│回收站   │              │  📎附件 🔗分享 公开/私有 │ (可拖宽)   │
│文件管理 │              │                         │            │
│网页剪藏 │              │                         │            │
└────────┴──────────────┴─────────────────────────┴────────────┘

窄屏（<1024px，P15.1）— 一次一层，顶栏 ← 退栈
┌───────────┐   ┌───────────┐   ┌───────────┐
│ 🔍 🔔 💬 ⋯ │   │ ← 🔍 🔔 ⋯ │   │ ← 🔍 🔔 ⋯ │
├───────────┤ → ├───────────┤ → ├───────────┤
│  侧栏     │   │  文章列表  │   │  编辑器    │
│  (整屏)   │ ← │  (整屏)   │ ← │  (默认预览)│
└───────────┘   └───────────┘   └───────────┘
```

- 左侧笔记本侧栏、预览目录、AI 面板、文章列表宽度均可折叠或拖拽，状态记忆于 localStorage
- 编辑器三模式：源码 Markdown / Tiptap 富文本 / 预览；标签行在标题下（虚线胶囊入口）；预览目录（H1–H4）可折叠
- 窄屏（P15.1）：当前停在哪一层由 `src/lib/pane.ts` 算，样式全部挂 `max-lg:`（桌面分支未改动）；AI 对话变全屏覆盖层，编辑器默认进预览，悬浮才出的行内操作改为常驻或收进「⋯」菜单

### 7.3 配色方案

```
主色调:   #10B981 (Emerald 绿)     背景:  #FFFFFF / #F9FAFB(侧栏)
文字:     #111827(标题) / #6B7280   边框:  #E5E7EB
危险:     #EF4444(删除)             深色:  index.css 深色映射 + 手动/跟随系统
博客 chrome: #0d0d0d 顶栏 / #d43030 品牌红（独立配色，见 public-blog.md）
```

## 8. 向量化与搜索方案

### 8.1 文本分块

```
分块大小 500 字符，重叠 100 字符，步进 400 字符
每块元数据：{ article_id, notebook_id, user_id, chunk_index }
```
重叠确保跨块语义不丢失。

### 8.2 向量化流程（保存时自动触发）

```
1. 文章存 D1 → 2. 计算 content_hash（SHA-256）
3. 与旧 hash 比对，未变则跳过（省 neurons）
4. 删旧向量（Vectorize）+ 旧分块（D1）
5. 分块 → 6. 批量嵌入 → 7. 批量上传向量（附元数据）
8. 记录 chunks → 9. is_vectorized=1
```

### 8.3 混合搜索

**语义搜索（默认，低消耗）：** 查询嵌入 → Vectorize topK → 关键词 LIKE 召回（标题权重高）→ RRF(k=60) 融合去重 → 返回文章 + 片段 + `match` 标注（vector/keyword/both）。仅关键词命中的文章摘录首个命中位置前后文作为片段。

> 不用 SQLite FTS5：默认分词器不切中文，trigram 要求查询 ≥3 字符；单用户规模下 `LIKE '%词%'` 全扫足够，对中文子串天然正确、零表结构变更。

**AI 问答（可选，消耗 LLM）：** 同上取 top5 分块原文 → 构造 prompt（系统提示 + 上下文 + 问题，`max_tokens: 300`）→ LLM 生成回答 + 引用。

## 9. 附件与文件体系（详见 file-manager.md）

- R2 key `u{uid}/{32位随机}/{文件名}`，上传后以 `/api/files/<key>` 写入 Markdown；`<img>` 直接引用（能力 URL 模型 + 访问分级）。
- 文章与附件无表级强关联，靠内容中的 URL（`extractFileKeys`）派生 `article_files` 引用索引；删除文章按引用计数清理 R2。
- **访问分级**：匿名请求仅当 key 被某篇「公开且非私有」或「有未过期私密分享」的文章引用才放行，否则 404；「我的私密文件夹」子树的附件对匿名一票否决。取消公开后新访客最多 5 分钟内失效（Cache API 缓存判定）。
- XMind 文件在编辑器内以缩略图卡片呈现，双击打开在线查看/编辑并回存 R2。
- 文件管理界面（P11.5/P11.6）：内联占据侧栏右侧工作区；导航（全部文件/未引用/笔记附件/我的文件夹树）是侧栏「文件管理」下的二级菜单，仅进入时展开。侧栏导航与右侧列表共用 `src/hooks/useFileManager.ts` 的 `overview` 与文件夹增删改，单次拉取、双向同步刷新。

## 10. 逐批的决策与取舍

> 这一节是**批次记录的唯一去处**（P14.3 起明确）。它从「公开博客与分享」长成了全仓库的决策日志——
> 因为一批往往横跨博客、附件、编辑器三处，拆开写在三份专题文档里等于维护三份变更日志。
> 条目大体按批次顺序，写的是**为什么这么做、当时排除了什么**，不是功能说明书（那在 `README.md`）。
> 博客最初那一批的设计见 `docs/public-blog.md`，附件体系当前形态见 `docs/file-manager.md`。

- `/blog` 免登录整站博客（IT之家风格，亮/暗双主题，热榜，浏览计数 Cache API 去重）；仅 `is_public=1 AND is_private=0 AND deleted_at IS NULL` 的笔记可见。
- 发布前对全文做敏感信息扫描 + 附件清单目视确认（`sensitiveScan`）。
- 章节目录（P11.8）：详情页左侧 `fixed` 浮层，**默认收起**、状态存 `localStorage['cfnote-blog-toc']`，**≥3 个标题才出现**（`MIN_TOC_HEADINGS`）。不占布局——`left-[max(0.75rem,calc((100vw-1400px)/2-15rem))]` 自适应，视口 ≥1880px 时落在 1400px 容器外的留白里不遮正文，再窄则贴边并按抽屉处理（遮罩关闭、点章节跳完即关）。正文渲染后扫 h1~h3 打稳定 id（`src/lib/toc.ts` 的 `slugifyHeading`，中文原样保留、重名加 `-2`），点章节用 `replaceState` 写 `#章节` 到地址栏（可复制分享到某一节，不塞历史），跳转后复用 `.cfnote-highlight` 高亮；与评论锚点 `#comment-<id>` 靠 id 形态区分。
- 私密分享：`articles.share_token/share_expires_at` 两列即全部状态（单分享），`/blog/share/<token>` 凭链接可看，不入列表/热榜、不计浏览量，过期 410；设为私有或移入回收站自动撤销。
- 页面布局（P12.1 骨架，P12.2 补全）：博客列表页与详情页各自把模块摆进「顶部 / 左侧栏 / 右侧栏 / 底部」四个槽位，配置存 `settings.blog_layout`（一个 JSON 字符串，**无 schema 改动**），随 `GET /api/blog/posts` 与 `/posts/:id`、`/share/:token` 一起下发——不单开端点，避免布局晚到导致首屏模块位置跳动。模块类型：`hot` 热榜 / `about` 关于本站 / `markdown` 自定义内容 / `recent` 最新文章 / `tags` 标签云 / `links` 友情链接 / `search` 站内搜索，均无新增端点。侧栏宽度各自可调 200–420px、只在该侧有启用模块时占位，配置页按 `contentWidth()` 实时提示正文剩余宽度并在 <700px 时警告；窄屏（<1280px）侧栏模块按 `narrow` 设置并到顶部/底部或隐藏（两份渲染 + CSS 断点，不做 JS 视口判断）。纯逻辑在 `src/lib/blogLayout.ts`（容错解析：坏 JSON/未知类型/越界宽度一律回落或夹取，绝不让配置错误使博客页打不开；`parseLinks` 只放行 http(s) 与站内相对路径）。配置界面在「博客管理 → 页面布局」（`?panel=layout`），支持 HTML5 拖拽跨槽位与换序。
- 列表分页与筛选（P12.3）：列表改为**每页 20 篇 + 「加载更多」**（多取一行判断 `has_more`，不做 `COUNT(*)`）。此前是硬 `LIMIT 100` 且无分页，第 101 篇之后在列表里根本看不到。**筛选放服务端**（`?tag=` 匹配笔记本名或 `tags` JSON 子串、`?q=` 匹配标题或正文）——分页后本地只有已加载的那几页，客户端过滤等于「只在前 20 篇里找」。标签云、列表行 Tags、详情页 Tags 与面包屑全部可点，跳 `/blog?tag=xxx`；筛选进地址栏所以可复制、可后退。SQL 的 `LIKE` 通配符在 `src/lib/blogQuery.ts` 里统一转义（`\ % _`，配 `ESCAPE '\'`）。
- 导航菜单（P12.3）：博客顶栏菜单可配置，对应 WordPress 的「外观 → 菜单」。作为 `blog_layout.menu` 与布局同存同发（**不另开 settings 键**：每多一个键就是每次博客请求多一趟 D1）。项类型 `home` / `tag` / `page`（指向某篇已公开笔记）/ `link`（只放行 http(s) 与站内 `/`，与友情链接同一把尺子）。`menuHref()` 返回 `null` 的项直接不渲染，配置不全不会变成死链；窄屏收进汉堡抽屉。
- 文章块部件（P12.8）：详情页正文区由「面包屑 / 标题 / 元信息 / 正文 / 标签行 / 结束标记 / 版权声明 / 评论区」组成，可排序、可开关，存 `blog_layout.article`（同样与布局同存同发）。这是模块系统管不到的部分——那四个槽位管的是**文章周围**，文章块本身此前写死。**成员固定**（只能排序与开关，不能增删），也**不做模板语言**：那会让「服务端预渲染」与「客户端 React」变成两个模板引擎必然走样，而部件是一份声明式清单，预渲染侧只需改 `articleBlockHtml` 一个函数。正文与评论区锁定为启用——评论的真开关在「设置 → 评论」，同一件事有两个开关迟早出现「这里关了那里还能提交」。
- 请求预算（P12.3）：**一个页面一次 API 请求**。侧栏模块要的数据由 worker 按当前页布局装配后随响应下发——`pageUsesWidget()` 决定查不查，热榜三档一次给全（切 tab 零请求），最新文章/标签云各自一次小查询；该页没启用的模块一行都不读。详情页因此不再单独拉列表与热榜（此前无条件拉 100 行只为侧栏），评论区改 `IntersectionObserver` 滚到附近才拉（带 `#comment-<id>` 锚点进入时立即拉，否则锚点无从定位）。结果：列表页首屏 2 → 1 次，详情页 4 → 1 次（评论按需）。取舍依据是免费额度里**请求数（10 万/天）比 D1 行读（500 万/天）紧张得多**，宁可多几次只读几行的小查询，也不要多一次 HTTP 往返。
- 顶部/底部模块（P12.4）：对标 WordPress 主题的 header/footer 组件，新增 `slider` 幻灯片 / `banner` 站点横幅 / `prevnext` 上一篇下一篇 / `related` 相关文章 / `postgrid` 文章宫格。数据同样由 worker 按布局装配（`fetchCards` 一份小查询喂幻灯片与宫格，`fetchRelated` 候选集 + `scoreRelated` 打分，`fetchNeighbors` 两条 `LIMIT 1`），**不新增端点、不增加请求数**。`WIDGET_SLOT_HINT` 只做「常用/其他」分组不做硬性禁止（宽度都是自适应的）；`DETAIL_ONLY_WIDGETS` 里的两个模块在列表页与私密分享页直接不渲染。幻灯片是唯一有真实带宽成本的模块，故**只渲染当前 ±1 张**（否则 DOM 里的 lazy 图会被浏览器判为"接近视口"提前全拉）、首图 eager、默认 5 张。横幅勾上「可关闭」+ 矮高度即公告条，故不再单列公告条模块；背景值经 `parseBannerBg` 只放行图片 URL 与规范颜色。
- 布局实时预览（P12.4）：配置页右侧是**真的博客页**——`/blog?preview=1` 装进 iframe，未保存的布局由父窗口 `postMessage` 下发（不重载，故不产生请求），点预览里的模块回传 id 让左侧面板选中它，`?preview=1` 让 worker 跳过浏览计数。不自己画一份「仿真示意图」：那要为每种模块各画一个缩略形态，加一个模块就得补一份，早晚跟真实渲染走样；iframe 不可能不同步。**按真实宽度渲染再整体缩放**（iframe 固定 1400/1000px，`transform: scale()` 缩进容器）——否则管理端那点宽度会让 `xl:` 断点一直判为窄屏，预览出来永远是降级后的样子。形态与 WordPress 自定义器一致：左控件、右真站点、拖拽仍在左侧做（HTML5 拖拽跨 iframe 文档不可靠）。
- 主色变量化（P12.4）：`#d43030`/`#e05252` 此前硬编码在 BlogPage 三十多处，配色主题无从下手；现收进 `--blog-accent` / `--blog-accent-hover` / `--blog-accent-soft`，顶栏页脚的黑色收进 `--blog-chrome`。纯机械替换、零行为变化，是后续「配色主题」的前置——布局（模块+槽位）与皮肤（颜色+排版）本就是正交两层。
- 博客皮肤（P12.5）：配色与排版存 `settings.blog_skin`（与 `blog_layout` 一次 `IN` 查询取回，不多一趟 D1），随三个博客端点一起下发。`src/lib/blogSkin.ts` 是数据模型 + 容错解析 + 颜色派生（`lighten` 从主色自动生成悬浮色、`withAlpha` 生成引用块底色），`skinVars()` 产出挂在博客根节点上的内联 CSS 变量（内联优先级高于 index.css 里的同名默认值）。旋钮刻意只有 8 个：主色 / 顶栏色 / 圆角 / 字号 / 容器宽度 / 字体 / 列表样式 / 额外 CSS——中性色是成对调过的明暗值，单独放开很容易配出读不了的组合，要精细控制交给额外 CSS（可覆盖任意 `--blog-*`）。5 套预设只改主色与顶栏色，排版设置保留。`listStyle: 'text'` 的纯文字列表不出缩略图，除观感外也省掉每篇一次的图片请求。额外 CSS 走 React 的 `<style>` 文本节点（不经 HTML 解析器，不存在闭合标签逃逸），`sanitizeCss` 另做 `</style` 过滤与 8000 字符上限。容器宽度可调后 `contentWidth(page, containerMax)` 接受宽度参数，博客页里 `max-w-[1400px]` 与目录浮层的 `calc()` 全部改走 `--blog-max`。
- 主题库（P12.7，P12.9 独立成页签）：整套皮肤配置可命名保存，存 `settings.blog_skin_library`（`{id, name, skin}[]`，上限 30 套）。**刻意与 `blog_skin` 分成两个键、两个模块**——`blog_skin` 是「当前生效的那一套」，要随博客响应下发、worker 侧预渲染也要用；主题库只有管理端读，因此存多少套都不增加公开路径的 D1 查询与响应体积，`blogThemes.ts` 也不会被打进 worker 包。id 取现有 `t<数字>` 最大值 +1（不用时间戳/随机数，免得单测跟时钟打交道），重名自动加序号但**打字过程中不去重**（否则输到与已有主题同名的那一刻就被改名），只在失焦时归一。P12.9 把它从「主题外观」页签里挪成第五个页签：整套主题的管理与「当前这一套的旋钮」不是一个粒度，挤在同一个滚动流里的结果就是没人找得到重命名和导出；同时补「复制一份」（`addTheme` 自带重名归一，复制出来就是「墨绿 2」）与删除二次确认（主题库没有回收站）。导出/导入是配置 JSON（`{app, version, name, skin}`），**不含 JS**，导入一律过 `parseBlogSkin` + `sanitizeCss` 并剥掉 `@import`。
- 备份完整性（P12.11）：此前导出只有「笔记本 + 正文 + 对话 + 附件」，拿它恢复的结果是**所有文章变回未公开、评论全丢、主题全丢**（主题其实在文件里，但 `/api/import` 压根不处理 `settings`）。现在导出补上文章的 `is_public/is_private/published_at/views`、`comments` 全表与可选的 `article_versions`（`?versions=1`，体积会翻几倍故默认不带）；导入侧按 `artMap`（**含被去重跳过的那些文章**，否则它们的评论会全丢）重挂评论，`parent_id/root_id` 分两步重映射（先插入拿新 id，再回填父子），父楼没跟着进来就降级成顶层而不是挂个悬空 id；设置只恢复 `blog_*` / `comments_*` 且 `ON CONFLICT DO NOTHING`——往一个已经配好的站里导备份，不该把人家现在的主题冲掉；`site_url` 不在白名单内（换域名恢复会把 RSS/sitemap 的绝对地址写错）。评论含邮箱与 IP：这是本人的完整备份，备份丢数据就不叫备份，而同一个文件里本来就是整个知识库；那条「公开接口永不返回 ip/user_agent/author_email」的规矩只管 `/api/blog/comments`。
- 博客自定义脚本（P12.12）：存 `settings.blog_custom_js`，与布局/皮肤同一次 `IN` 查询取回、随博客响应下发（零新增请求、零新增 D1 往返），由 `src/lib/blogScripts.ts` 解析后在客户端注入。**为什么不在 worker 预渲染时拼进 HTML**：① 列表页 `/blog` 根本不过 Worker（`run_worker_first` 是 `/blog/*`，匹配不到裸 `/blog`），worker 注入覆盖不了入口页；② 会和 `blog_prerender` 那个 kill switch 耦合，关掉预渲染的同时统计代码也没了；③ 混合方案（能注入就注入、否则客户端补）会让同一段脚本的执行时机随入口而变——直接打开详情页时在 React 之前跑、从列表点进去时在之后跑，这种间歇性差异比「永远晚一点」糟得多。解析同时认 HTML 片段与纯 JS：大多数人粘的是服务商给的 `<script async src=…>`，按纯 JS 处理会一声不响地不生效；非 `<script>` 标签丢弃，`src` 过与友情链接同一把 URL 尺子。注入用 `createElement` + `el.text=`（DOM 赋值不经 HTML 解析器，`</script>` 无从逃逸，与额外 CSS 走 `<style>` 文本节点同一条论证），模块级 flag 保证整个 SPA 生命周期只执行一次（列表→详情是 pushState，放 state 里会被重复插入、统计 PV 记成两倍）。
- 单页（P13.4）：对标 WordPress 的「文章 vs 页面」。`articles` 加一列 `is_page`（migrate 幂等加列）。`POST_WHERE = PUBLIC_WHERE AND COALESCE(is_page,0)=0` 用于列表/热榜/标签云/卡片取数/相关文章/上下篇/RSS；详情与 **sitemap 仍用 `PUBLIC_WHERE`**——单页是真实可访问、也该被索引的 URL，只是不该被当成新文章推给订阅者。URL 保持 `/blog/:id`（单页仍是一篇 article，预渲染/边缘缓存/真 404 原样复用，`run_worker_first` 不动；URL slug 与它正交）。布局加第三种页面 `blog_layout.page` 与单页专用部件表 `blog_layout.pageArticle`（默认只留标题 + 正文）。`prevnext`/`related` 在单页不可用，`loadBlogDetail` 也不给单页传 seed。**单页可以停用评论区**，是 P12.8 那条锁的唯一例外：全局开关仍是唯一决定「能不能提交」的地方，这里只是不渲染；实现上 `isPartLocked(type, scope)` / `parseArticleParts(v, scope)` 多一个 scope 参数，默认 `'post'` 保持既有调用点不变。管理入口在「博客管理 → 已公开文章」的 `全部/文章/单页` 筛选（`?kind=post|page`）与行内「设为单页」，**不进 `ArticleEditor` 顶栏**（那是笔记工作区共用的组件，而这是博客呈现层的概念）；`is_page` 与 `is_public` 正交，取消公开不清它。
- 文件管理多选与批量操作（P13.3，P13.7 改选择语义）：多选改成 Windows 资源管理器语义——单击独选 / Ctrl 点选 / Shift 连选（替换）/ Ctrl+Shift 连选（追加）/ Ctrl+A 全选 / Esc 清空 / 双击打开；判定在 `src/lib/fmUtils.nextSelection`（纯函数 + 单测：四种修饰键组合 × 有无锚点 × 锚点已被筛掉，手点穷举不了，而选错行等于批量删掉没打算删的）。Shift 的锚点不随 Shift 点击移动，可反复调整同一段的另一端。行首复选框降级为可选项（`auto` 仅触屏 / `on` / `off`），存 **localStorage** 而非 settings 表——它是每台设备各自的显示偏好（桌面有修饰键、触屏没有），且放服务端会让每次打开文件管理多打一次 `/api/settings`；开关仍陈列在「设置 → 文件管理」，文件管理右上角齿轮直达并高亮该节。触屏判定用 `matchMedia('(pointer: coarse)')` 而不是窗口宽度。底部状态栏取代 P13.3 顶部那条批量条（选择状态在两处显示迟早对不上），未选中时显示当前视图合计。批量仍走**一个** `POST /api/fm/files/batch`，而不是前端循环打 N 次 `PUT`/`DELETE`——移动 20 个文件就是 20 次计费请求。删除沿用「仍被笔记引用需确认」的规矩，只是一次把名单全给出来（`needs_force` + `referenced`）。**复制**是唯一有真实成本的：R2 的 Workers binding 没有服务端 copy，必须 `get` 出来再 `put` 回去、字节流经 Worker，且存储真的翻倍，故限一次 ≤20 个、单个 ≤10MB，超出的跳过并原样报回；副本刻意不继承分享（分享是「这一份」的授权）。副本名由 `copyName()`（`src/lib/fmUtils.ts`，可单测）算出，反复复制加序号而不是叠「副本 副本」。拖拽移动：行 `draggable` + 载荷 `application/x-cfnote-files`，落点在 `FileManagerNav` 的每个目录节点（自定义 type 在 `dragover` 阶段读不到数据，只能靠 `dataTransfer.types` 判高亮，真正的 id 到 `drop` 才取）；「拖到此处移出文件夹」那块**只在拖拽进行中出现**（P13.7 修：此前常驻，不拖时、切目录后都还挂着），状态 `draggingFiles` 与 `moveFilesToFolder` 同放 `useFileManager`——拖起来的是右侧列表的行、落下的是侧栏的节点，两个组件只共享这个 hook；清高亮挂在 `dragend`（一定触发）而不是 `dragleave`（不保证成对）。
- 文件右键菜单（P13.8）：行内那条悬浮动作条要先命中行、再命中六个挤在一起的 emoji，本来就难点。右键菜单不新开任何代码路径——每一项都调已有的处理函数：**单选**走和悬浮按钮完全一样的单文件弹窗（移动/删除都带那份列出笔记标题的确认），**多选与「复制到…」**走 `POST /api/fm/files/batch`，与底部状态栏同一条路径；因此零新增端点、零 schema 改动，而「复制到…」顺带对单个文件也可用了（此前只有多选才有）。**右键与选择的关系**：右键一个未选中的行先把选择替换成它，右键选中集里的行则整段保持——这样菜单永远作用在 `sel` 上，不必再引入一个「右键目标」的平行状态去和拖拽、底部状态栏三方同步。落点计算抽成 `fmUtils.menuPosition()`（纯函数 + 单测）：四条边界各自只错一次都要正好在某个角上右键才看得见，而错了的表现是「菜单一半在屏幕外、点不到删除」；菜单高度按条目数估算而不是渲染后测量——估算够准就能定出翻转方向，而「先渲染再量再挪」会闪一帧。**关闭用一块透明遮罩而不是全局捕获监听**：`mousedown` 和 `click` 是两个独立事件，在捕获阶段吞掉前者并不能阻止后者落到某一行上顺手改掉选择，而补一个一次性的 `click` 拦截会和 effect 清理时机赛跑（`setMenu(null)` 触发的卸载可能先于那次 `click`）；遮罩关在 `click` 而不是 `mousedown`，是因为它必须活到这次点击走完，否则 `mouseup` 时它已不在、`click` 会改派到底下的元素身上。代价是在别处右键要按两次（第一次关菜单），换来的是行为确定。搜索框里不接管右键（那里要粘贴），只在行与列表空白处 `preventDefault`。**不做触屏长按**：移动端长按会和浏览器原生的选中/菜单打架且各家不一致，而 P13.7 已给触屏默认开了复选框，多选与批量在那条路上是通的。侧栏文件夹树本批不加。
- 博客管理切换卡顿（P13.1）：`openInEditor` 原来 `await` 完 `/articles/:id` 才 `setSelected`，于是点了 B、右边还杵着 A 转圈。改成与 `Layout.openArticle` 同一套乐观切换：先用列表行（标题 + `summary`）立刻换，正文异步补全（`ArticleEditor` 的 `loadingContent` 早就有了）。慢请求回来时若已切走则丢弃结果。这里不存在 P12.6 里「不同调用方字段形态不一」那个顾虑——列表行只有 `PublishedArticle` 一种形态。
- 博客管理（P11.1，P11.4 改内联，P11.7 改两栏可编辑）：侧栏「博客管理」**内联占据右侧工作区**（非弹窗，`?panel=blog`）。左侧为已公开文章列表（`GET /api/articles/published`，**按 `updated_at` 降序**，搜索/按笔记本过滤/按文章·单页过滤，悬浮出「预览↗ / 设为单页 / 取消公开」，右缘可拖拽、宽度存 `cfnote-blog-list-w`），右侧点选后取全文并**复用 `ArticleEditor`** 直接编辑（源码/富文本/预览三模式）；保存走 `PUT /api/articles/:id`，只就地更新该行、**不重排列表**，取消公开/设为私有则移出列表并清空右栏。其下「评论管理」（`?panel=comments`）与「页面布局」（`?panel=layout`）为二级菜单。
- 评论（P11.2，P11.7 增待审就地显示与锚点，P11.9 记来源）：`comments` 表（`parent_id`/`root_id` 支持 2 层嵌套，`status` pending/approved/rejected，`is_admin` 博主回复，`ip`/`user_agent` 明文来源仅管理端可见）；公开 `GET/POST /api/blog/comments`（POST 中间件单独放行，默认待审核、每 IP 每分钟限流、蜜罐、正文只存原文不解析），鉴权 `/api/comments/*` 审核；开关与免审核存 `settings.comments_enabled/comments_auto_approve`；私密分享页不显示评论；待审可复用通知渠道推送。访客提交后其待审评论存 `localStorage`（`cfnote-pending-cmt-<articleId>`）并就地降调显示为「待审核」，通过或超 7 天自动清除（合并逻辑见 `src/lib/pendingComments.ts`）；评论行带 `id="comment-<id>"` 锚点，`/blog/:id#comment-<id>` 可直达并短暂高亮。管理在「博客管理 → 评论管理」二级菜单，列表显示来源 IP 与 UA。
- 评论正文的极小 Markdown 子集与表情（P13.9）：先分清两件事。**表情本来就能用**——emoji 是普通 Unicode 字符，`whitespace-pre-wrap` 一直正常渲染，缺的只是输入方便，故加了个约 64 个常用表情的面板（不引第三方 emoji 库：动辄几十上百 KB 还常带一份元数据，为一个评论框不值），插到光标处而非追加到末尾。**Markdown 则不能走 `marked`**：它默认原样放行裸 HTML，而仓库没有 HTML 消毒库，任何访客写个 `<script>` 就是存储型 XSS——文章能用 `marked` 是因为作者是博主自己。做法是 `src/lib/commentMarkup.ts` 自己解析成 **token 而不是 HTML 字符串**，由 `BlogPage` 渲染成白名单 React 元素：文本节点 React 自动转义，标签集合被 token 类型枚举死，结构上无从逃逸（与 P12.12「`createElement + el.text` 而非 `innerHTML`」同一条论证）。子集刻意贫瘠：`**粗体**`/`*斜体*`/`~~删除线~~`/`` `行内代码` ``、`> 引用`（单层）、`- 列表`（单层不嵌套）、`[文字](链接)` 与裸链接；不给标题、图片、表格、代码块、分割线、裸 HTML、嵌套列表——评论区不是文章，标题在评论里就是刷屏，外链图片等于追踪像素 + 刷屏 + 挂了变裂图，代码块要拖进 highlight.js 且能刷出很高的楼。**链接是唯一真正的风险面**，三道：`safeHref` 协议白名单只放 http/https（React 只转义文本节点、**不审 href**，`javascript:`/`data:` 得自己挡）、一律 `rel="nofollow ugc noopener noreferrer"`、一条评论最多 3 个链接超出则整条降级为纯文本（链接刷屏是垃圾评论的主要形态；降级而非提交时拒绝——审核制下拒绝只会让正常人莫名其妙，而半边渲染半边不渲染更难读）。协议非法的链接**原样当文本显示**而不是悄悄扔掉，读者该看见作者写了什么。顺手修掉一个既有的洞：`pre-wrap` 下 2000 字全打回车能刷出一整屏空白楼，现在 3 个以上连续换行折成 2 个。加粗/删除线内部允许出现**单个** `*`/`~`（只有成对才是结束标记），否则 `**a*b*c**` 会解析成散落的星号加两段斜体——不嵌套不等于内部不许出现这个字符；这是写完单测才发现的。**管理端刻意仍是纯文本**：审核时要看到访客写的原始字符，`[点这里](http://恶意站)` 的真面目渲染过就藏起来了；博主回复也走同一条渲染路径、无特权，少一个分叉。worker 零改动（评论从不预渲染，见 P12.8），无 schema、无端点变化。相应地那条长期约束改写为更准确的版本：~~评论正文一律纯文本~~ → **评论正文永不经过 `marked`、永不 `dangerouslySetInnerHTML`，只走白名单 React 元素**。
- 评论管理列表的悬浮与回复高亮（P13.9）：那个 `<li>` 此前只有静态边框，没有任何 hover 态，评论一多就不知道鼠标在哪一行。灰底 = 鼠标在这儿，绿底 = 正在回复它——后者是因为回复输入框就长在卡片内部，滚动之后分不清在回复谁。两种状态互斥而不是叠加，否则「正在回复的那条」被鼠标扫过时会变色，反而弱化了它。
- 自动备份到 R2（P14.2）：P12.11 补的是备份的**完整性**，这一批补的是备份的**存在性**——在此之前唯一的备份手段是你手动点「导出」，手不点就没有备份。D1 自带的 Time Travel 只在同一个 Cloudflare 账号里有效，账号本身出问题时它一起没，所以要的是一份能搬走的 JSON。**只备 D1，不备附件字节**：附件本来就在 R2 里，把 R2 复制到 R2 只是把同一份风险买两遍；含附件的 ZIP 完整备份仍走浏览器端打包。**没有新开 cron 触发器**，而是搭在既有那条「每 5 分钟」上，用 settings 里的调度锚点当闸门——① 免费版每个 Worker 能挂几条 cron 无从核实，加一条如果撞上限会让**整个部署失败**，这是所有人都看得见的、最坏的失败方式；② 于是频率变成设置项（关闭 / 5 小时 / 1 天 / 7 天）而不是写死的 cron 表达式，改频率不用重新部署，「forker 不必改 `wrangler.toml`」那条约定也一并保住；③ 代价是每 5 分钟多读一行 settings，一天 288 次行读，而那条 cron 本来就要为提醒推送查 D1。**存的是锚点（上一次调度决定的时刻）而不是算好的到期时间**，下次到期 = 锚点 + 周期，这一个选择顺手解决两件事：改频率立刻生效（存到期时间的话，7 天改 5 小时还得先把那 7 天等完，要么在 `PUT /api/settings` 里为备份特判，要么再补一层夹取逻辑）；备份失败不会退化成每 5 分钟重试一次（锚点在**开工前**就推到了现在，成败都一样，下次仍是一个完整周期之后，错误落 `backup_last_error` 与 `system_logs`，设置面板红字显示）。开工前推锚点同时也是抢占：两个 isolate 同时被唤醒时后进来的直接判「未到期」。**没有锚点 = 到期**，所以刚开启会立刻备一份，免得「设置里明明开着，却要等七天才知道它到底能不能跑」；另有「立即备份一次」按钮。对象键 `backups/u{id}/cfnote-YYYY-MM-DD-HHMMSS.json` 命名即排序，裁剪保留份数只排序键名、不必逐个读元数据；不匹配 `^u\d+/` 所以 `fm/scan` 不会把备份登记成附件，孤儿清理也只从 `files` 表出发。下载/删除的 `:name` 必须过 `isBackupName`（正则不含斜杠与点点），没有跨用户或跨前缀的余地；「恢复」= 下载那一份再走既有的 `/api/import`，服务端不另写一套恢复逻辑。手动导出与自动备份**共用同一个 `buildExportPayload`**——分两份写法的话总有一天其中一份会漏掉新表，而漏掉的那份多半就是没人看的那份。
- 移入私密文件夹的公开引用预检（P14.2）：把正被已公开笔记引用的附件拖进私密文件夹，博客上那张图当场变裂图，而这个动作此前是静默成功的——更难发现的是你自己登录着看什么都正常。三条移动路径（批量 / 单个 / 目录整体）现在先做只读预检并返回受影响的公开文章清单，确认后才带 `force` 重发。详见 [file-manager.md](docs/file-manager.md)。
- 文档收口（P14.3）：`docs/` 下六份文档新鲜度天差地别，而每份看上去都像还在维护——`roadmap-2026-07.md` 的状态行停在 P8.1（当时已到 P14），`evernote-gap.md` 里「删整本笔记本仍是彻底删除不进回收站」「评论正文一律纯文本」两句已被 P14.1／P13.9 推翻却仍写在那儿。**根因是「批次记录该写哪份文档」取决于那一批碰了什么，而一批往往横跨博客、附件、编辑器三处**，于是同一件事被拆成三段写在三个地方，过几个月谁也说不清哪段最新。定下规矩：**决策与取舍统一进本文件 §10（§10 的标题也随之从「公开博客与分享」改为「逐批的决策与取舍」，名副其实），专题文档只维护「这个子系统现在是什么样」**。据此：新增 [`docs/README.md`](docs/README.md) 文档地图（每份标注活／半活／历史 + 覆盖到哪一批）；`roadmap-2026-07.md`、`public-blog.md`、`wysiwyg-editor.md` 顶部加历史横幅并点名最容易误导的过期结论；`evernote-gap.md` 的批次记录明确冻结在 P12.5，但**第三节的 Evernote 对标表继续维护**——「还差什么、哪些明确不做」是这份文档真正的长期价值，故补上状态列与「明确不做」的理由（#11 Email 收集箱、#13 OCR、#15 笔记本分组），另记下两个还想做的（URL slug、归档页）与一个待定项（移动端：先要定「只看还是也要写」，两者成本差一个量级）；`file-manager.md` 补 P13.3／P13.7／P13.8／P14.1／P14.2 并改成「活文档，覆盖到 P14.2」。**过期的结论就地标注推翻它的批次而不是删掉**——删了就看不出当初为什么那么想，而那恰恰是最有用的部分。零代码改动。
- 管理端窄屏适配（P15.1）：博客读者侧早在 P12.2 就做过窄屏降级，烂的一直是**自己用的那一面**——`Layout`／`Sidebar`／`ArticleList`／`FileManager`／`BlogManager` 五个文件加起来一个断点都没有，而 `index.html` 的 viewport 是 `width=device-width`，手机不会缩成桌面视图，是把「侧栏 224 + 列表 288 + 编辑器 + AI 栏」硬塞进 390px。**定位为「只看」而不是「也能写」**：真正贵的是离线与冲突（Service Worker + 冲突合并），那和响应式是两码事；而响应式外壳是两条路共同的前置，先做不会白做。
  - **窄屏改成返回栈，一次只显示一层**：侧栏 → 列表 → 正文，顶栏出返回箭头。「在哪一层」是状态（`src/lib/pane.ts`，纯函数 + 单测），「显示几层」是 CSS——全程**不读 `window.innerWidth`、不用 `matchMedia` 判视口**，沿用 P12.2 的结论：JS 判视口会先按错误分支渲染一帧再跳。桌面下 `pane` 照常变化，只是被断点整个盖住，等于不起作用。
  - **所有改动都挂在 `max-lg:` 上，桌面那一支的类一个字没动**。这不是风格偏好：写成 `hidden lg:flex` 等于把桌面布局也重写一遍，而这一批没有任何桌面侧的诉求，任何桌面回归都是纯亏。例外只有拖拽条与几处仅桌面可见的提示文案，它们加的是 `max-lg:hidden`——同样只在窄屏生效。
  - **返回栈有几层取决于工作区**：笔记与「已公开文章」是「列表 + 正文」两层；文件管理（目录树 P11.6 已并进侧栏，文件列表本身就是主内容）与评论管理／页面布局是单层，从正文一步回侧栏，不插一层空列表。刷新与前进后退按 URL 重算停在哪一层（`paneForRoute`），不额外存 localStorage——它是「刚才点到哪」，不是布局偏好。
  - 拖拽出来的列宽（`listWidth`／`chatWidth`／博客管理列表宽）原本是内联 `style={{width}}`，而内联样式压得过任何类，窄屏的 `w-full` 会被它顶掉。改成挂 CSS 变量、宽度用 `w-[var(--cf-list-w)]` 这一族写法，于是宽度与断点回到同一个层叠层里，断点说了算。（顺带一课：Tailwind v4 连仓库根的 `.md` 一起扫，本条最初写成带通配符的 `--cf-` 前缀，被当成类名候选生成了一条非法的 `width: var(...)`，构建会报 CSS 警告——文档里举类名的例子要举**真实存在的那一个**。）
  - AI 对话在窄屏改为顶栏之下的全屏覆盖层（桌面仍是可拖宽的第四栏）；编辑器在移动端**默认进预览**（复用既有的 `IS_MOBILE`，与 P6.4 富文本降级只读同一个判据）——手机上多数时候是看，一进来就是等宽字体的源码没有意义，要写点「源码」即可。
  - **悬浮才出的操作在触屏上等于不存在**：文章列表的置顶／删除、博客管理行的预览／设为单页／取消公开改为窄屏常驻；文件管理那六个挤在一起的 emoji 换成一个「⋯」，开的就是 P13.8 那份右键菜单本身（判据用 `matchMedia('(pointer: coarse)')` 指针类型而不是视口宽度，与 P13.7 的复选框同一把尺子）——长按能不能触发 `contextmenu` 各家浏览器并不一致，不能作为唯一入口。
  - 顶栏窄屏塞不下八个入口：留搜索／提醒／AI，其余（主题、统计、设置、日志、用户名、退出）收进一个「⋯」溢出菜单。**没有做的**：离线、PWA、Service Worker、冲突合并；`BlogLayoutPanel` 早已是 `w-full lg:w-[27rem]` + 预览区 `hidden lg:flex`，本批未动；各弹窗本就带 `max-w-[92vw]`／`w-full max-w-lg`，同样未动。无 schema、无端点、worker 零改动。
- 博客 URL slug（P15.2）：`/blog/12` → `/blog/12/部署-cloudflare-workers`。
  - **id 在前、slug 装饰**，不是 `/blog/部署-cloudflare-workers`。这个形态的红利是决定性的：查表永远只认 id，`:slug` 一行代码都不读，所以**改标题不会断链**、不需要唯一约束、不需要冲突处理、不需要迁移；`run_worker_first = /blog/*` 照样匹配；客户端那条 `^/blog/(\d+)` 是前缀匹配，多一段本来就能解析。
  - **slug 从标题现算，不存库**：id-first 之下 slug 纯属装饰，存一列就要配套「什么时候生成、改标题动不动、能不能手改」三个状态和一套 UI，换不来任何稳定性收益。零 schema 改动。
  - **不复用 `toc.ts` 的 `slugifyHeading`**：两者规则眼下几乎一样，但诉求不同——URL slug 要长度上限（60 字，中文 percent-encode 后每字 9 字节）、要 percent-encode、**空标题要退回「没有 slug 段」而不是回落成 `section`**（`/blog/12/section` 谁也看不懂）；章节锚点要的是同名去重。耦合在一起改一边就会伤另一边。
  - **不做 301**：开发阶段没有需要照顾的存量外链，而 301 要花一次额外的计费请求。老地址照常出内容，`<link rel="canonical">` 指向规范形态即可——这一条本来就有，零成本。
  - **站内一律直发规范地址**，所以正常浏览不会出现非规范 URL：列表／热榜／最新／相关／上下篇／幻灯片／宫格／sitemap／RSS／预渲染内链／博客管理「预览↗」与评论「查看↗」／编辑器「在博客中查看」／评论待审推送。`listSitemapPosts` 因此多取一列 `title`。**唯一的例外是导航菜单的 `page` 项**——它的配置值是手填的文章 id，那里根本没有标题可算，要修就得让配置页存一份 slug，不值当；它照常打得开，只是地址栏不好看。
  - `openPost` 的入参从 `id: number` 改成了 `{id, title}`，几个模块部件的 `onOpen` 跟着改——只给 id 就只能发裸地址。预渲染的边缘缓存键**仍只按 id + 档位**：同一篇文章不管从哪个地址进来产出的 HTML 完全一样，slug 进缓存键只会把同一份内容缓存成好几份。
  - 测试的边界要说清楚：算法在 `tests/blogSlug.test.ts` 单测；路由注册与 sitemap 在 `tests/worker/blogSlug.test.ts` e2e。**预渲染出来的 HTML 与 canonical 测不到**——`wrangler.test.toml` 刻意不声明 `[assets]`（否则测试就依赖 `./dist` 的构建产物），详情页一律走 passthrough。这反倒给了「路由是否注册」一个干净的判据：命中详情路由是 passthrough 的 `Not found`，没有任何路由是 `app.notFound` 的 `页面不存在: …`，两者响应体不同。

- 新建笔记重复保存（P15.3，修 bug）：连按 Ctrl+S 会多出好几篇笔记。
  - **根因是「草稿的 id 要等网络回来才变正」**。草稿是本地假记录（`id: -Date.now()`，不落库），`saveArticle` 靠 `id < 0` 判断该 POST 还是 PUT，而 `article.id` 只有在 `POST /api/articles` 回来、`setActiveArticle(res.data)` 之后才变正。**在途这段时间里任何第二次保存都会再 INSERT 一行**（服务端不去重，`worker/routes/articles.ts` 的 `POST /` 直接 INSERT）。
  - **主犯是自动保存定时器，不是 Ctrl+S 本身**。它的 effect 依赖是 `[handleSave, saved, trashed]`——**不含 `saving`**，所以手动保存不触发 cleanup，上一次击键排下的 3 秒定时器照样到点开火，而定时器回调里一个判断都没有。「打完最后一个字顺手 Ctrl+S」的间隔天然小于 3 秒，定时器必然还在倒计时；国内访问的 POST 只要慢过剩下那点时间就必现，不是偶发。
  - **闸门放在 `Layout.saveArticle`，不是放在按钮上**：`src/lib/singleFlight.ts` 按草稿 id 合并在途请求，后来者复用同一个 Promise（不是报错、不是丢弃，所以调用方不需要知道自己被合并了）。放这一层是因为调用方只会越来越多——Ctrl+S、定时器、保存按钮、`applyFlags`（点「公开」，它压根不经过 `handleSave`）——**修在任何一个按钮上都会漏，而且以后加一个就复发一次**。
  - `handleSave` 里另加 `savingRef`（`useRef`，同步赋值）：`saving` 是 state，要等重渲染才更新，拦不住同一 tick 的第二次调用。它挡的是「无谓的第二个请求根本别发出去」——免费额度里请求数（10 万/天）比 D1 行读（500 万/天）紧得多。真正保证不重复建记录的仍是单飞闸门。
  - **顺带修好「保存失败后自动保存永远停摆」**：失败时依赖一个都没变，effect 不重跑、不再排定时器，而界面只写「未保存」，不说为什么。把 `saving` 加进依赖后，`saving` 落回 false 会自然重排一次。但**必须配一个重试上限**（`MAX_SAVE_RETRY = 3`）：不设的话离线时开着的标签页每 3 秒打一次接口，一夜近 3 万次请求，正好打在最紧的那条额度上。失败三次就停手，状态栏改成「保存失败，点『保存』重试」，内容一动重试额度归零。
  - 「公开」按钮补上 `article.id <= 0` 禁用，跟 `submitShare` 早就有的那条判断对齐——它是唯一一个对草稿开着的写入口。私有／取消公开本来就在 `article.id > 0` 里。
  - 测试只能测到闸门本身（`tests/singleFlight.test.ts`）：仓库没有 `@testing-library/react`，组件里的 effect 时序测不了。这也正是把闸门抽成纯函数的理由——**「同一篇草稿的创建请求同时只能有一个」是一句与 UI 无关的话，能单独证**，剩下的是接线。

- 本地导入一个文件都读不到（P15.4，修 bug）：选文件夹（或选文件）一律报「所选内容中没有 .md / .markdown / .txt 文件」。
  - **根因是「清空 input 会就地清空已经拿到的那个 FileList」**。原代码是 `const fl = e.target.files; e.target.value = ''; handleFiles(fl)`。清 `value` 是为了下次选同一个文件夹还能触发 `change`（否则选不动），本身没错；错在 `e.target.files` 是**活引用**——Blink 的 `FileInputType::SetValue` 走 `file_list_->clear()`，就地把那个对象清空，于是 `fl.length` 在传下去之前已经是 0。改成先 `Array.from` 快照再重置：`File` 对象本身在 FileList 被清空后仍然有效。
  - **错误信息要能区分两种失败**。「一个文件都没拿到」和「拿到了但类型不对」原来是同一句话，这正是这个 bug 藏得住的原因。现在前者说「浏览器没有交出任何文件」，后者说「收到 N 个文件，其中没有 …」——N 是多少直接指出问题在哪一侧。
  - 文件夹 input 补 `multiple`：`webkitdirectory` 在 Chrome 下单独也能递归返回整棵树，但各浏览器不完全一致（MDN 自己的例子是两个一起写的），补上无副作用，顺带支持一次选多个文件夹。
  - **子目录里的文档标题带相对路径**（`src/lib/importTitle.ts`）：`File.name` 只有基名，`技术/index.md` 与 `读书/index.md` 会变成两篇都叫 `index`。服务端去重键是**标题 + 内容哈希**（`worker/routes/system.ts`），所以内容不同的还是都能进来——主要是认不出谁是谁；真正会丢的是同名**且**同内容那种（每个子目录各放一份一样的 `README.md`）。带上路径两种都解决。
  - **剥掉相对路径的第一段**：那一段就是用户选中的文件夹本身，每篇标题里重复它一遍没有意义。根目录下的文件因此仍然只有文件名，跟改造前一模一样——**斜杠只出现在真正来自子目录的笔记上**。选单个文件时 `webkitRelativePath` 是空串，自然走回 `name`。
  - **扩展名只能从最后一段去**：拼好整条路径再 `replace(DOC_EXT, '')` 是错的——`sub/.markdown` 会剩下一个吊着斜杠的 `sub/`，而它非空，「什么都不剩就退回原名」那道兜底根本接不住。单测逮到的就是这条（顺带也保住了 `archive.md/note.md` 这种目录名）。
  - **不做批内重名编号**：路径已经把标题分开了，再加 `(2)` 只会破坏服务端那套「标题 + 内容都一样就跳过」的去重——重复导入同一个文件夹本来就该只留一份。

- 笔记本层级：真树，不是路径标签（P16.1，系列第一批）
  - **为什么推翻了 `docs/evernote-gap.md` 第 15 行**：那条「笔记本分组不做」的理由是「加一层树只会让『这篇该放哪』多一个纠结点」，针对的是**自己从头建层级**。而真实场景是**把已经按目录整理好的本地知识库迁进来**——结构是现成的，不存在该放哪的纠结，反倒是保不住结构就没法迁、没法维护。那一行按 P14.3 的规矩就地标注推翻批次，不删。
  - **也推翻了我自己上一轮提的「Bear 式路径标签」**：标签是字符串，改中间一层目录名就要批量改所有后代标签，必然与本地目录漂移。迁移 + 长期维护这个诉求，模拟品撑不住。
  - **迁移是纯增量**：`notebooks.parent_id` / `is_private` 两列一次加进 `NOTEBOOK_COLUMNS`（`is_private` 这批只建列不生效，留给 P16.5，省一次迁移往返）。`parent_id` 为 NULL = 挂在根上，**所以老库天然就是一层平铺，零行为变化**。不加外键约束——那要重建表，违反「只做增量幂等」。
  - **照抄文件夹那棵树，不另立规矩**：子孙收集、移动时的环检测、有子节点时禁止删除，`worker/routes/fm.ts` 里已经跑了好几个版本。两边行为一致，用户不用学两套；环检测抽进 `src/lib/notebookTree.ts` 的 `wouldCycle`，前后端共用同一份判断，免得两边各写一遍还写歪。
  - **两条容错是把树抽成纯函数的主要理由**：① `parent_id` 指向已删除或不存在的笔记本时，**挂到根**而不是消失——笔记本可以放错位置，绝不能从侧栏消失；② 数据成环（备份恢复、并发写入都可能造出来）时**就地打断成根**，而不是整条链从树上失踪。这两条散在组件里迟早写漏。
  - **这一批故意不动删除语义**：有子笔记本时直接拒绝删除（右键菜单同步置灰，免得点了没反应还看不到原因）。「删父连子孙一起进回收站、恢复时整棵回来」留给 P16.3——在那之前宁可拦住，也不能让回收站里对不上账。
  - **同级顺序不改**：服务端仍是 `ORDER BY updated_at DESC`，`buildTree` 原样沿用入参顺序。目录树按名字排更自然，但那会让所有老用户的侧栏顺序无缘无故变掉，单独再议。
  - 缩进第 6 层封顶：再深名字就被挤没了，层级关系靠展开状态已经看得清。

- 私密笔记本（P16.5，系列第二批，提到 P16.2 之前做——私有那部分是先要迁进来的）
  - **软继承，不是推导**：`notebooks.is_private` 的含义是「**新建或移进这一支的笔记，自动带上 `is_private = 1`**」，**不是**「这一支里的笔记被推导为私有」。这条是安全设计的核心：事实源始终只有 `articles.is_private` 一列，博客发布、分享链接、备份、公开预检**没有一处需要同时看两个地方**。做成推导的话，任何一处漏看��是泄露。
  - **私有沿树向下继承，且不允许在私有子树里挖公开的洞**：标了「内部资料」私有而「内部资料/薪酬」不跟着私有，就是个陷阱——你以为整棵锁了实际漏一层，而侧栏一排锁图标里混一个没锁的根本看不出来。要放公开的东西就挪到私有子树外面去。界面上继承来的那一档直接置灰成「已随上级私密」，要解就去标了私有的那个祖先上解。
  - **单篇仍可显式取消私有**，这不是矛盾而是软继承的必然结果，而且有用（私有支里某篇整理好了要发博客）。规矩是**容器决定默认，个体可以例外，例外必须是显式动作**——忘了标不会漏，主动放行才会。
  - **写入路径一个都不能漏**，所以判断收进 `worker/notebookPrivacy.ts` 一处：`POST /api/articles`（覆盖新建笔记、网页剪藏、AI 对话保存）、`POST /api/articles/import`（URL 导入）、`PUT /api/articles/:id` 的换本、`POST /api/import`（本地导入 + 备份恢复，整批只取一次笔记本表）。放 worker 根而不是 `routes/notebooks.ts`：后者已���引了 `routes/articles.ts` 的 `vectorizeArticle`，反向再引就成循环依赖。
  - **备份恢复时分支优先**：`is_private = 备份值 || 目标本在私密分支`。备份里说不私有也照锁，安全方向宁可多锁。
  - **改标志位从不动已有笔记**，两个方向都不动。所以「设为私密」和「移进私密分支」之后都问同一句「这一支里还有 N 篇没上锁，要一并设为私有吗」——这两个动作制造的是同一种危险状态：*你以为整棵锁了，其实老笔记全是敞的*。数量为 0 就不打扰。
  - **只有 `apply-private`，没有反向的批量解锁接口**：那是个一按就泄露的按钮。要放行某一篇就去那一篇上单独取消。
  - **移出私密分支不解锁**：不能因为拖错了地方就把一堆私有笔记暴露出去。
  - **上面两条在 P16.5.1 就被推翻了，原样留着当反面教材**：我先写下「一排锁图标里混一个没锁的根本看不出来」，转头又设计了一个能批量制造这种状态的按钮（问「要一并上锁吗」，选「取消」即得）。**安全功能给出「不安全」的选项，就是给人一个在没想清楚后果时点错的机会。**

- 私密笔记本改成强制（P16.5.1，推翻上一条的可选上锁）
  - **确认即强制，没有「只锁新的」这个选项**。落进私密分支的那一刻，整支已有笔记一并转私有。
  - **不变式由服务端保证**：`PUT /api/notebooks/:id` 每次更新后都重新拉平一次「私密分支里不存在 `is_private = 0` 的活笔记」（通常匹配 0 行）。**不��调用方记得多打一个接口**——保证不了不变式的接口，迟早会有一条路径绕过去（导入、脚本、以后的新入口）。`apply-private` 因此删掉，少一个接口就少一个漏洞。
  - **确认框摊开的是「别人看不见了什么」，不是一个数字**：`private-impact` 返回 `{articles, published, shared}`，其中 `published`（会从博客下线）和 `shared`（分享链接会失效）才是有外部影响、不可逆的部分。三者全 0 就不打扰，直接做。
  - **顺序是先问后做**，不是先做再问要不要补救。
  - 取消私密仍然**不解锁**已有笔记，也不问：它不会泄露任何东西，而安全方向的默认永远是「不解密」。要放行某一篇，去那一篇上显式取消——个体例外的规矩不变。

- 私密开关与笔记本图标（P16.5.2）
  - **取消私密也弹框，但它不是安全闸门，是解释**。原来「不会泄露所以不问」的理由不成立：泄露风险是**延迟**的——之后新写进这一支的笔记不再自动私有，而你不会注意到。同时它会留下「笔记本没锁、里面 47 篇却全是私有」这个乍看很怪的状态（是被禁掉那个危险状态的镜像：锁多了不是锁少了），没人解释就成了困惑。所以弹的是「已有的仍然保持私有，变的是以后新写的」。里面一篇私有笔记都没有就不弹。
  - `private-impact` 因此同时给出两个方向的数字：未上锁的（含其中几篇已公开、几个分享链接）与已上锁的。
  - **图标从小色块换成书本，但颜色必须留着**——那是用户给每本笔记本设的属性，不能因为换了个图形就丢。
  - **刻意不用「敞开/合上」区分公开与私密**：① 这是安全信号，14 像素下开合两种书形很难一眼分清，而锁的轮廓在任何尺寸都不会认错，认错的代价是把该私密的当成公开的；② 开/合在树形侧栏里的既定含义是展开/折叠，同一个视觉维度表达两件事迟早看串；③ 会与右侧的锁标记重复编码同一个事实，而锁还要分实色（自己标的）与淡色（继承的），那是开/合表达不出来的。开/合真正合适的位置是展开态，暂不做。

- 安全审计与修复（P16.5.3）。全仓过了一遍注入 / XSS / 越权，**没有发现可利用的注入或 XSS**；修掉的是三处逻辑漏。
  - **回收站是私密不变式的绕过路径（最严重，且是 P16.5.1 自己留的）**。不变式挂在 `PUT /api/notebooks/:id` 上，而它只扫 `deleted_at IS NULL`。于是：删掉一篇公开笔记（软删清 `is_public` 但刻意不清 `is_private`）→ 把它的笔记本设为私密（拉平扫不到回收站里那篇）→ 恢复 → **一篇非私有笔记落回私密支，而你以为整棵是锁着的**。两条恢复路径（单篇 `POST /api/articles/:id/restore`、整本 `POST /api/notebooks/:id/restore`）都补上了判断。我在 P16.5.1 写下「保证不了不变式的接口迟早会有路径绕过去」，然后自己就漏了恢复这条——**这正说明「服务端保证不变式」还不够，得把所有写入路径列全**。
  - **`loadNotebookRows` 改成连回收站里的笔记本一起取**。私密性沿祖先链继承，而祖先可能也在回收站里（P16.1 只挡「有活着的子本时不许删」，父子一起删是允许的）。漏掉已删的祖先，链就断了，`inPrivateBranch` 会误判成「不在私密分支」。私密判断只用 `id / parent_id / is_private`，与「活没活着」无关。**但存在性校验必须另走 `hasLiveNotebook`**——那道校验的语义是「能不能往这儿写」，回收站里的笔记本不能。同一次查询，两种判断，不能混用。
  - **`IN (...)` 补分片**：`notebooks.ts` 的批量上锁与 `private-impact` 的统计，`ids` 等于「这一支的笔记本数」，SQLite 绑定变量上限 999。个人库眼下到不了，但 P16.4 把整个本地知识库的目录树导进来就不好说，而 `files.ts` / `fm.ts` 本来就都分片，这里不分是不一致。`chunked` 从两处重复定义收进 `worker/notebookPrivacy.ts`。
  - **`POST /api/init` 匿名防刷**：它免鉴权（部署后第一件事就是它，那时还没账号），全套 `IF NOT EXISTS` 因此拿不到也删不掉数据——但每次十几条 D1 语句，匿名可无限调等于一个免费放大器，而**请求数 10 万/天是这个部署最紧的额度**。改成「已初始化 + 未登录 → 短路」；**登录态照旧无条件重跑**，因为「改 `SCHEMA` 后通过 `/api/init` 应用」是既定用法（加新表就靠它），不能因为防刷把这条路堵死。
  - 查过没问题的：所有 `IN (${...})` 只拼占位符、值走 `bind`；`blogRepo` 的 `ORDER BY ${order}` 是三元产出的两个字面量，不接外部字符串；`PRAGMA table_info(${table})` 的 table 来自硬编码数组；`stats` 的 `boundary` 有 `^\d{4}-\d{2}-\d{2}$` 把关；`escapeLike` 转 `\ % _` 且所有调用点都跟了 `ESCAPE '\'`。`escapeHtml`/`escapeAttr` 覆盖 `& < > " '`，`jsonForScript` 转 `<` 阻断 `</script>` 并处理 U+2028/2029，`absImage` 只放行 `https?://` 与 `/` 开头（`javascript:` 进不去）。评论正文确认没有任何路径碰 `marked` 或 `dangerouslySetInnerHTML`。鉴权中间件覆盖 `/api/*`，免登录清单是显式白名单且逐条限定方法。公开评论接口不返回 `ip`/`user_agent`/`author_email`。
  - **留着没修的**：`PUT /api/articles/:id` 换本时用 `article_count = article_count ± 1` 增量写，其他地方都是 `= (SELECT COUNT(*) ...)` 重算。增量在并发或 batch 部分失败时会永久漂移。这是 P16.1 之前的老账，与本次审计的三条无关，单独一批处理。**已由 P16.6 修掉，见下条。**

- 登录爆破防护与认证面收尾（P16.6）。上一批的审计只看了注入 / XSS / 越权，**认证机制本身在边界之外**；这批把那块补扫完并修掉两条。
  - **`POST /api/auth/login` 此前完全没有限流**，而同一个 Worker 里评论提交是有的（`blog.ts` 的 Cache API 计数）——**手段现成，登录这条却没用**，这种不一致的成因就是「每处各写各的」。所以先把计数与窗口抽成一份（`src/lib/rateLimit.ts` 纯逻辑 + `worker/rateLimit.ts` 的 Cache API 后端），评论那条改成调用它，登录用同一套：**每 IP 每 15 分钟 8 次失败**。
  - **限流判断排在密码校验之前，这是这条改动真正的目的**。每次校验是 10 万轮 PBKDF2，不拦的话一行 `curl` 循环就能持续烧 CPU 时间，而攻击者连密码都不用猜对。注意它**省不下请求数**——请求进到 Worker 时那一次已经计了，10 万/天该扣照扣；能省的是 CPU 与 D1 读。真要在请求数这一层挡，得用 Cloudflare 控制台的 WAF 速率限制规则（免费套餐就有），那是配置不是代码。
  - **两条边界都是刻意的**：① 缓存不可用（本地 dev、`workers.dev` 域名、缓存故障）**一律放行**——限流唯一可接受的降级方向，单用户系统里把主人锁在门外没有第二条补救路径；② Cache API **按 colo 计数不是全局**，换机房就是一份新配额，所以它挡的是「一台机器对着登录接口猛敲」，不是分布式爆破。
  - **窗口不因为多记一次而顺延**（固定窗口，不是滑动）。顺延的话一个一直在敲的攻击者会把自己永久锁住——听着不亏，但同一个出口 IP 后面可能就坐着知识库的主人。登录成功则清账，手滑几次再输对不该给后面留个半满的窗口。
  - **用户名枚举**：此前用户不存在时立刻返回、口令错误时要先算完 10 万轮 PBKDF2 才返回，**响应时间差着几十毫秒，可以稳定区分用户名对不对**。改成用户不存在时也拿一份固定假盐照算一遍再丢掉——只要迭代次数一致，耗时就一致。单用户系统里就一个账号，枚举出用户名等于把爆破的靶子从两维降到一维。
  - **`hash !== user.password_hash` 刻意保留非恒定时间比较**：比的是 PBKDF2 的输出而不是密钥本身，且网络抖动远大于逐字符比较的差异，拿不到可用的时序信号。审计过，记在这里免得下次再推一遍。
  - **口令下限维持 6 位，也是刻意的**：限流之后在线猜测被压到约 768 次/天/IP，6 位口令在这个速率下不构成现实风险；而抬高下限只对全新部署有意义（注册接口首个用户之后自锁），却会在「清库重初始化」时给自己添堵。真正的兜底是**离线爆破不在威胁模型内**——能读到 `users` 表的人已经拿到全部笔记了。
  - **JWT 仍然无法吊销**（7 天有效期、无 `jti`、服务端不存状态，改密码也不会让已签发的 token 失效——何况现在还没有改密码接口）。要修得加列 + 加接口，是独立一批；单用户自用场景下优先级低于上面两条，明确记在这里而不是让它悄悄留着。
  - **顺带清掉上一批留的老账**：`article_count` 全部改成重算，`± 1` 一处不留（`worker/utils.ts` 的 `recountNotebook`，全仓唯一一份该 SQL）。换本那处还挪了位置——原先把计数写在文章真正搬走**之前**，重算会读到旧状态，增量写则会在主 `UPDATE` 失败时留下漂移。`/api/import` 的批量重算补上 `deleted_at IS NULL`，与其余重算点口径对齐：同一个派生值有两种算法，迟早对不上。
  - **测试自身的坑，记下来免得再踩**：这批第一次跑全量挂了 4 个用例，其中 **3 个在我根本没碰的文件里**（`autoBackup` / `fmBatch` / `trash`），于是排查方向一开始被带偏成「是不是改到共用面了」（怀疑 `json()/err()` 的签名或 `recountNotebook` 多写的 `updated_at`）。真因是新测试文件用「连打 8 次真实登录」去填满限流窗口，一个用例就是 8 轮 10 万次迭代的 PBKDF2；**worker 项目单独跑 84 个用例全绿，但 `npm test` 里 unit 与 worker 两个 project 是并行的**，CPU 一抢隔壁文件就集体撞上 5 秒默认超时。正确的第一步是先分离变量（单独跑 worker 项目）而不是先读自己的 diff。两条一起改：填窗口改成直接调 `rateBump` 预置计数（**填窗口本来就不是被测对象**，被测的是「拦不拦、拦在哪一步」），`vitest.worker.config.ts` 的 `testTimeout` 抬到 20 秒——这些用例每个都真的丢表建表加两轮 PBKDF2，5 秒本来就紧，真卡死照样会被抓住，但并行调度的抖动不该伪装成断言失败。预置计数带来一个新缺口（窗口是自己填的，`auth.ts` 万一忘了调 `rateBump` 也照样绿），所以补了「差一次到上限仍放行」与「真实失败确实会计数」两条把它堵上。

- 生产验证核对表（P16.7）。零代码改动，新增 [`docs/verify.md`](docs/verify.md)。
  - **起因是积压到了 10 批**（P13.7 → P16.6 全部推上线但一条都没在生产上验过）。积压真正的代价不是「没验」，是**故障定位会归错帐**：P16.1 / P16.5 系列动了笔记本结构与可见性，P14.1 / P14.2 动了删除语义与备份，如果 P14.1 其实有问题，症状现在会以「私密笔记本表现怪」的形式冒出来，而人一定会往最近那批上找。
  - **筛选规则是这份表唯一有价值的部分：已被自动化测试覆盖的一律不进**。回收站语义、备份往返、私密不变式的四条写入路径、限流窗口算术、单页不进文章流、slug 路由注册，都在 workerd + 真 D1 + 真 R2 里证过了，手点一遍只是重复劳动。留下的只有测试**够不着**的三类：① 真浏览器行为（`FileList` 的活引用只有 Blink 里才有、拖拽、右键落点、窄屏返回栈——仓库没有 `@testing-library/react`）；② 真绑定（Vectorize / Workers AI / Cache API / R2 + cron，`wrangler.test.toml` 刻意不声明）；③ 真部署配置（`run_worker_first`、预渲染 HTML，测试配置刻意不声明 `[assets]`，否则测试就依赖 `dist/`）。按这个筛，10 批压进 21 条。
  - **顺序是有约束的，不是随便排的**：① 先验「部署本身活着」，这层坏了后面全白验；② P15.3 那条**必须在打完最后一个字的 3 秒内连按 Ctrl+S**——主犯是自动保存定时器而不是按键本身，等久了定时器已经开火过，测不出来；③ 登录限流放最后且**必须用手机流量**——清账只在登录成功时发生，被锁住就登不进去也清不了账，只能等窗口过期；④ P16.5.3 那条要严格按「先删 → 再设私密 → 后恢复」的顺序，换个顺序就绕不到那条路径上。
  - **每条都标了覆盖批次**，出问题时照着回 §10 查当初的设计意图，而不是从代码倒推。表尾单列「已知不在验证范围内」（JWT 无吊销、限流按 colo、删父不连子孙、导入不保留目录结构），把「明确没做」和「漏验了」分开——不分开的话，下次看到这份表全绿会误以为这些也验过。

- 备份丢了笔记本的层级与私密标志（P16.8，修 bug，插队做）。**P16.1 建了树、P16.5 加了私密标志，而 `buildExportPayload` 那条 `SELECT` 一直没跟上**——`parent_id` 与 `is_private` 从来没进过备份文件。
  - **失败方式是最难发现的那种**：备份文件看着挺大、导入也报成功。真正的后果是 ① 树被压平成一层；② **私密笔记本变回普通笔记本**——老笔记的 `is_private` 在 `articles` 自己那一列里带着，看起来一切正常，可笔记本本身不再私密，**此后新写进这一支的笔记不再自动上锁**。这正是我在 P16.5.2 写下的「泄露风险是延迟的，而你不会注意到」，只不过这次是我自己在备份这条路上留的口子。与仓库自己那条原则直接冲突：P12.11 写的是「备份丢数据就不叫备份」。
  - **顺带发现恢复侧更秃**：`INSERT INTO notebooks (user_id, name)` 连 `color` / `description` 都没写回，而这两列备份里一直有——有笔记本设过颜色的话，恢复出来全是默认绿。
  - **`parent_id` 必须两遍法回填**：备份里的 `parent_id` 是**备份自己的 id**，要过 `nbMap` 换成本库 id，而父本可能与子本同在一个 `batch` 里刚建出来、插入时还拿不到新 id。与 P12.11 重挂评论父子关系同一个套路。
  - **回填必须排在 `loadNotebookRows` 之前**，这是这批唯一容易写错的地方：私密沿祖先链继承，链还没接上就取表，子本里的笔记会被判成「不在私密分支」而漏锁——一个纯粹的顺序问题，症状却是安全的。
  - **同名复用的笔记本一概不动**（不改层级、不改私密、不改颜色），与「settings 只在当前没有该项时才恢复」同一条规矩：往一个已经配好的站里导备份，不该把人家现在的结构挪走。私密这一条尤其不能顺手做——把一个现存笔记本悄悄设成私密，就会造出 P16.5.1 明令禁止的状态（笔记本挂着锁、里面老笔记全是敞的），而拉平整支要走 `PUT /api/notebooks/:id` 那套不变式机器，不是导入该顺带干的事。
  - **环不在这里挡**：手改过的备份可能带环，但 `buildTree` 与 `inPrivateBranch` 都带 `seen` 集合，就地打断成根且不会死循环——P16.1 立的两条容错已经覆盖，不另立第二道。
  - 补三条 e2e：树与私密标志往返、**恢复之后往私密支里新建笔记仍然自动上锁**（前一条验标志位存回来了，这条验行为真的跟着回来了——`parent_id` 没接上时标志位对着也没用）、以及同名复用不冲掉现有层级。中间那条是关键：只断言列的值相等，接不上链这个 bug 照样漏得过去。

- 笔记本树的删除与恢复语义（P16.3）。P16.1 当时**直接拒绝**「删有子本的笔记本」，理由是「宁可拦住，也不能让回收站里对不上账」。这批把拦截换成级联——而**级联敢不敢开，取决于恢复侧接不接得回来**，所以这批的重量全在恢复，不在删除。
  - **删父级联整棵活着的子树**：自己 + 全部活着的子孙，连同它们活着的笔记一起打 `deleted_at`，清向量与分块，`article_count` 归零。附件一个不动（P14.1 的规矩不变）。**已经在回收站里的子孙不碰**——它们各有各的 30 天倒计时，重置等于偷偷延长。
  - **恢复要往两头走**：① **子孙**——删除级联了，恢复不跟着级联就等于恢复不回来；② **祖先链上还在回收站里的那些，但只恢复壳**。不恢复祖先会留下「子本活着、父本在回收站」，`buildTree` 于是把它兜回根（P16.1 的容错），**你恢复的东西没回到原来的位置，而层级一深根本看不出来它挪过**。只恢复壳是因为你点的是恢复这一本，不该顺带把另一本的笔记也捞回来。
  - **单篇恢复也补祖先链，而这个洞在 P16.3 之前就能踩到**：P16.1 加了树之后，`POST /api/articles/:id/restore` 只恢复直属笔记本，它的 `parent_id` 照样可能指向回收站里的行。不是级联删除引入的，是加树时漏掉的。
  - **孤儿改成结构上不可能，而不是靠推理**：`purgeExpiredTrash` 与 `/trash/empty` 都补了「有子本残留就这一轮不删」。原本可以论证「父本的 `deleted_at` 一定不早于子本，所以父本总是最后到期」——但级联之后父子时间戳相同，而单条 `DELETE` 内的处理顺序是未指定的。**要绕一圈才成立的保证，迟早会被某次改动踩掉**；改成守卫之后，父本留到下一轮扫描，子本清完自然轮到它。
  - **`purge` 跟着清整棵子树，但活着的子本一律拒绝**：那是不可逆操作，绝不能因为「顺手」把用户刚恢复的东西删掉。拒绝而不是静默跳过——「点了没反应」比报错更糟。删除顺序从叶子往根（`subtreeIds` 是 DFS 序，倒着来）。
  - **`private-impact` 泛化成 `impact`，两个确认框共用**。「设为私密」与「删除笔记本」问的都是**确认之后别人看不见了什么**，没必要开两个接口各查一遍。口径改成**活着的**子树——回收站里的子孙再删一次不改变什么，算进「将连同 N 个子笔记本一起移入回收站」只会让数字和眼见的侧栏对不上。新增 `total`（含私有）给删除用：进回收站的是全部，而 `articles` 那个数只数未私有的（设为私密时它才是「会被转私有」的那批）。
  - **确认框的文案与强度做成纯函数**（`src/lib/deleteNotebook.ts` + 11 条单测）。不是为了复用——只有一个调用点——而是因为**这里的每一句话都是安全决策**：`published` 为 0 时那句该消失、按钮上写不写数量、什么时候升级成打字确认。埋在 JSX 里就只能靠人眼复核，而人眼复核不了分支。
  - **超过 50 篇要求打出笔记本名**。50 是判断不是计算：再多几篇也谈不上灾难（30 天可逆、附件不动），但到这个量级，「我以为只删了一个空本」和事实之间的差距已经大到值得强制停一下。**阈值定低了更糟**——会让人养成盲目打字的习惯，顺带稀释真正该停下的那几处（清空回收站、彻底删除，它们会真的清 R2）。`ConfirmDialog` 的 `Enter` 也要过同一个 `armed` 判断，否则输入框里一回车就提交，这道闸形同虚设。
  - **确认框必须讲可逆性**（「30 天内可从回收站整棵恢复，附件不会被删除」）。不讲的话，人要么因为怕而不敢用，要么因为不知道而乱用。

- 导入按完整路径匹配笔记本（P16.3.1，P16.4 的前置）。`/api/import` 此前是**平铺按名字**复用（`nbByName`），加了树之后这是错的：不同分支可以有同名笔记本（`技术/归档` 与 `读书/归档`），会被并成一本，而且并进去的那本还带着另一支的层级与私密性。改成按从根到自己的完整路径匹配。
  - **路径键走 `JSON.stringify(段数组)`，不拼分隔符**。笔记本名字里可以有任何字符（包括斜杠），挑不出一个「一定不会出现」的分隔符——那正是「一个叫 `a/b` 的根笔记本」和「`a` 下面的 `b`」会撞成同一个键的由来。JSON 自己负责转义，键还是纯 ASCII、能直接打印出来看。
    - 写这段时我先用了 `\0` 当分隔符，**结果把真实 NUL 字节写进了源文件**，`grep` 直接把它当二进制文件、`Edit` 也匹配不上那两行。这不是分隔符选得好不好的问题，是「需要挑一个不可能出现的字符」这个思路本身就该换掉。
    - **于是在 `run.local` 加了一道闸**（`src/` `worker/` `tests/` 里任何文件被判成二进制就拦下提交），而它立刻揪出了 `src/lib/blogQuery.ts` 的 `filterKey` —— **同一个错误早在 P12.3 就写进仓库了，一直没人发现**，那个文件的 diff 谁也没法正常看。一起修掉（同样换成 `JSON.stringify`，这个键只在内存里比较、不落库，没有兼容问题）。**这条闸的价值不在拦住我这次，在于它翻出了一处沉了几个月的同类问题。**
  - **老备份天然退化为按名字匹配**：P16.8 之前导出的文件没有 `parent_id`，每条路径就只有一段（= 名字），与改造前的行为逐字一致。所以不必为老文件另开一条兼容分支——**能靠数据形态自然退化的，就别写 `if`**。补了一条 e2e 专门钉住这一点（伪造一份删掉 `parent_id` 的备份，断言同名仍复用）。
  - 同路径重复（同一层两个同名笔记本，应用是允许的）取先出现的那个，与此前「同名复用取第一个」保持一致。

- 文件夹导入直接建笔记本树（P16.4）。这是「无缝迁移本地知识库」这条线的正题，P16.8 → P16.3 → P16.3.1 三批都是它的前置：备份得能带 `parent_id`、删除恢复得能兜住一棵树、导入得能按路径认笔记本。
  - **前端把目录翻译成备份格式，服务端一行没改**。`POST /api/import` 自 P16.3.1 起就是「路径在就复用、不在就建」，那正好是文件夹导入要的语义。与其为导入开第二个建树接口，不如让它产出同一种载荷——**两个入口共用一条写入路径，私密继承、去重、计数重算这些规则就只有一份实现**。
  - **顺带修掉 P16.3.1 引进的一处回归**：`Layout.tsx` 合成的载荷里笔记本只发了 `{id:1, name}`，没有 `parent_id`。改成路径匹配之后，目标笔记本但凡不在根上（`技术/前端`），这条记录的路径就是 `["前端"]`，与库里的 `["技术","前端"]` 对不上 → 在根上另建一本同名的，导入的文件全进了那本。不丢数据，但落点是错的，而且侧栏只是多出一本同名笔记本，**看不出来**。修法就是发整条祖先链，而那正是 P16.4 本来就要写的代码——所以没有拆成独立批次，拆了等于把同一个函数写两遍。
  - **去重键从「标题 + 内容哈希」改成「笔记本 + 标题 + 内容哈希」**。建树之后标题从 `技术/README` 变回 `README`，而「每个子目录各放一份一样的 README.md」是知识库的常态——旧键会让第一份进库、其余全被判重跳过，**那是真丢数据**（`importTitle.ts` 顶上那段注释早就警告过这个情形，只是当时靠"路径进标题"绕开了）。代价是导出后把某篇挪了个笔记本再导入会多出一份；**「静默少一篇」比「看得见的重复一篇」坏得多**，取后者。
  - **`localByPath` 只从没删的笔记本建**。路径撞上回收站里的一本时若复用它，导进来的笔记直接躺进回收站——界面上等于凭空消失。这跟 `loadNotebookRows` 刻意连已删的一起取不冲突：那边算的是私密继承（与死活无关），这边问的是「能不能往这儿写」，同 `hasLiveNotebook` 一个口径。
  - **分片上传，每片都带完整的 `notebooks`**。第一片建树、后面几片按路径复用同一棵——**路径匹配天生幂等，所以中途失败重发不会长出第二棵树**。这是把 P16.3.1 的性质当基础设施用，而不是另加一套幂等键。切片按「50 篇 / 2MB 谁先到算谁」，单个文件自己就超上限时自成一片（否则整批会卡死在那一个文件上）。正文也按片读，不先把整库读进内存——切片本来就是为了别一次拿那么多。顺带清掉了「导入没有进度显示」那笔旧账。
  - **跳过数必须说出来，且有跳过就不关对话框**。静默少几篇是这个功能最坏的失败方式，而它恰恰不报错。
  - **保留结构做成可关的开关（默认开）**，关掉退回 P15.4 的老行为（路径写进标题、全部平铺）。留逃生口的理由和别处一样：新语义万一在某种目录结构上判断错了，用户得有办法把东西先弄进来。
  - **补：本地导入这条循环一直在丢 `/api/reindex` 的 `errors`**（P16.4.1）。接口从一开始就返回它，设置页那条循环也一直在报，只有 `Layout.tsx` 这条没收。于是索引失败的唯一表现是「以后搜不到这几篇」——不报错、不留痕、查都没法查。一次导进来几百篇时这几乎必然发生（超长正文、嵌入调用超额）。**同一个接口有两个调用点、只有一个处理了错误，这种不对称比两个都不处理更难发现**：设置页能报，会让人以为整条链路都能报。

- 深/浅视图与「我的私有」审计视图（P16.2，笔记本树系列收官）。P16.1 建了树、P16.3 补齐删除恢复、P16.4 把本地知识库导了进来，但一直没有「看这一支下面有什么」的办法——树越深这个缺口越明显。这批被前面五个批次连续插队，是系列里最后一个空档。
  - **深视图默认关**。「点笔记本 = 看这一本」是所有文件管理器的既定行为，改掉它会让每一次点击的结果都变得不可预期；而 P16.4 之后一支下面可能有几百篇，默认深等于把每次点击都变成一次大查询。开关**只在真有子笔记本时出现**——没有子级时它是个恒等于无意义的勾，摆在那里只会让人怀疑自己是不是漏看了什么。
  - **深视图必须给归属路径，否则这个功能是负分**。「技术/前端/React」和「读书/前端」里两篇同名的笔记，不给路径就是列表里两行一模一样的字——比看不到还糟，因为你会点错。路径在服务端拼好（那里本来就有整张笔记本表），不让前端再查一遍树。
  - **浅视图是「ids 只有自己」这一种特例，不为它另写一条 SQL**。两条查询走两套 `WHERE`，迟早在某一条上漏掉 `deleted_at`——这类漏洞的表现是回收站里的东西出现在正常列表里，而没有任何报错。
  - **分片查回来必须重排序**。`IN (...)` 按 100 一片拆开，各片之间的顺序不作数；少了这一次 `sort`，置顶的笔记会散落在列表中间。排序口径与原来的 `ORDER BY pinned DESC, updated_at DESC` 逐字一致。
  - **`hasLiveNotebook` 校验排在取数之前**，`deep` 不能成为绕过存在性检查的旁路。这条用 awk 钉在 `run.local` 里——它的失败方式是「传一个别人的 id 就能连整棵子树一起读出来」。

- **「我的私有」改成审计视图**（P16.2，这批真正重要的一半）。P16.5 系列反复写「容器决定默认，个体可以例外，例外必须是显式动作」——**可在此之前，没有任何地方能把这些例外列出来看一眼**。设过一次就再也想不起来，而它们恰恰是「我以为整支锁着」这个判断的反例。
  - 每条带 `notebook_path` 与 `inherited`（私有是继承来的，还是自己在这一篇上标的）。后者是取消私密笔记本时**不会**跟着变的那批，必须能一眼认出来。
  - **单列 `exceptions`：在私密分支里却没上锁的活笔记。** 正常恒为 0——P16.5.1 的不变式保证。所以它不为 0 只有两种可能：有写入路径绕过了拉平（bug），或者有人显式取消过（需要复核的决定）。两种都得看得见，而这是唯一能看见它们的地方。P16.5.3 修的那类破口，当初就是靠人肉推演才发现的；现在有了常驻的对账页。
  - 例外项还标出**哪些仍公开在博客上**——那是有外部影响、且不可逆的部分，与删除/设私密的确认框同一条口径：摊开的永远是「别人看得见什么」，不是一个数字。
  - **返回形状从裸数组变成 `{articles, exceptions}`，是破坏性改动。** 例外项跟列表一起拿而不另开接口：免费额度里紧的是请求数（10 万/天）不是行读（500 万/天）。漏改前端的表现是「我的私有」永远空列表、**不报错**，所以 `run.local` 加了闸同时盯服务端的返回与前端的收法。
  - 例外项只扫私密分支下的笔记本，不做全表扫描。

- **JWT 吊销与改密码**（P16.9，笔记本树系列收官后立刻补的一批）。此前根本没有改密码接口，而 token 有 7 天有效期、服务端不存状态——「我怀疑 token 泄露了」这件事无法处理，你能做的只有等它过期。
  - **吊销靠 `users.token_epoch`**：改密码时 +1，签发时写进 token，鉴权时比对 `payload.epoch === row.token_epoch`，于是所有旧 token 因不匹配而失效。epoch 是 payload 的一部分，签进 HMAC 签名里——**不能靠改 `JWT_SECRET` 来吊销**（那会让注册时签发的那张、以及所有人手里的全部失效，单用户的就直接把自己锁在外面了）。
  - **退出登录不 bump epoch**：你在手机上退出，不该把桌面也踢掉。只有改密码才表达「断掉所有旧会话」这个意思——两者是不同的诉求，共用一个开关就没法只做前者。
  - **每次鉴权多一次 D1 查询（单行主键查询）**：从纯 HMAC 签名校验变成签名 + 查 `users` 表。免费额度行读 500 万/天、请求 10 万/天，**请求数上限本身就把行读框住了**——就算把请求数打满，epoch 查询也只能吃掉行读额度的 2%，你先撞上的一定是请求数那道墙（早 50 倍）。而且这是最便宜的一种 D1 查询：`WHERE id = ?`，单行主键命中。
  - **fail closed，但 P16.6 的限流是 fail open**：同一个系统里两个相反的降级方向。epoch 查询失败 → 拒绝，看着更狠，**但 D1 挂了整个应用本来就用不了**（所有数据都在 D1），fail closed 不额外损失任何可用性，却能保证被吊销的 token 不会因为一次抖动就复活。限流失败 → 放行，拦不住暴力破解，但至少不会把主人锁在门外（单用户没有第二条路进去）。「安全方向的默认」不是口号，得看那个方向具体损失什么。
  - **`getUserLoose`（附件读取的宽松鉴权）也要过 epoch**：漏了它，改完密码旧 token 仍能靠 cookie 读到全部附件——而附件里正是截图、扫描件这类最私密的东西。两条路共用同一个 `epochValid()` 函数。
  - **改密码接口返回 400 而不是 401 表示「旧密码不对」**：走到这个 handler 说明中间件已经认过 token，会话是有效的，错的是请求体里的一个字段。前端 `useApi` 把所有 401 统一改写成「未登录或登录已过期」——用 401 的话，用户打错一个字会看到「登录已过期」，而他明明登录着。同一个状态码在一个接口上表达两件事，客户端就分不开了。
  - **改完密码直接返回一张新 token**：不给的话用户改完密码，自己手里那张也失效了，表现是「改密码成功，然后整个界面开始报未登录」——正确但难看，而且会让人以为改坏了。前端复用 `login()` 换掉本地 token + 附件读取用的 `cfnote_t` cookie + React state，一气呵成。
  - **老 token（没有 epoch 字段）与老库（`token_epoch` 为 NULL）仍然认**：两边都归一到 0 后相等，所以这批上线不会把已经登录的人踢出去，不必为老 token 另写兼容分支。DEFAULT 0 让新注册的用户与新签发的 token 天然对得上。
  - **`SCHEMA` 必须与 `migrate.ts` 同步**（P16.9.1 踩坑）：`/api/init` 的建表语句没加 `token_epoch`，测试里 `dropAll` → 重建时缺这一列，`epochValid` 一查就抛错 → 所有鉴权 fail closed → 全是 401。`migrate.ts` 的 `USER_COLUMNS` 只在老库上跑，测试走的是全新建表那条路。所以两边都要加，一个都不能漏。
- **P17，设置面板改成左导航分类**：`SettingsPanel` 是从 P3 一路加到 P16.9 的，每批新增一节往下续，到这一批已经是 **9 节挤在一个 `max-w-lg` 的窄浮窗里、十几屏往下滚**。症状很具体：改个模型要滚过整段通知渠道；P16.9 刚加的改密码在倒数第二节，问「在哪里改密码」是完全合理的。节与节之间只有一行灰色小标题，滚起来是一整片。
  - **分成 7 类而不是继续加节**：AI 对话 / 博客 / 评论 / 文件 / 通知 / 备份 / 账号。左侧固定 176px 的导航，右侧只渲染当前那一类——一屏看完一类，往后再加设置项也只是让某一类变长，不会让整个面板变长。窗口从 `max-w-lg` 放宽到 `max-w-3xl`：分两栏之后再挤在 512px 里，右边就只剩三百多像素。
  - **不做「系统」这一类**：系统日志是顶栏那个独立面板，在设置里放一个「请从顶栏打开」的空分类比不放还差。同理评论**审核**在「博客管理 → 评论管理」，这里只有开关。
  - **保存按钮仍是全局的一个**：`PUT /api/settings` 本来就是整份提交，分类只是显示上的分组，不是提交单元。拆成每类一个保存按钮会让「改了 AI 又改了博客」变成两次请求、两次失败可能——而免费额度里紧的正是请求数。底部那行灰字说明这一点；「文件」那一类走 localStorage、改完立即生效，所以那一类的提示换成「不用保存」。
  - **窄屏是返回栈而不是把导航折成横向 tab**：7 个分类横着排在 390px 里必然要横向滚动，而横向滚动的 tab 条是最容易被没看见的控件之一。沿用 P15.1 主界面那一套：`cat === null` 显示分类列表，点进去显示那一类，顶栏出返回箭头，Esc 也先退回列表再关面板。桌面下 `cat` 恒不为 null（初值就落在第一类），那条 `max-sm:` 分支等于不存在。
  - **`focus` 从「滚到某一节并高亮」变成「直接落在某一类」**：文件管理右上角的齿轮此前传 `focus='files'`，效果是打开后 `scrollIntoView` + 闪一下 `.cfnote-highlight` 六秒——那是「一整片里怎么让人找到一节」的补偿动作，分了类之后不再需要，直接把 `cat` 初值设成 `'files'` 即可。`focus` 的类型也从 `'files' | null` 放开成 `SettingsCategory | null`，以后任何入口都能直达任意一类。
  - 零接口改动、零 schema 改动：所有字段、所有请求、所有校验逻辑一行没动，纯粹是这些字段摆在哪儿。
- **P17.1，笔记本重命名**：`PUT /api/notebooks/:id` 从 P16.1 起就接受 `name`（那行注释一直写着「改名/改色/移动」），但**前端从来没给过入口**——右键菜单只有新建子本 / 移动 / 私密 / 删除。于是改名的唯一办法是新建一本再把笔记一篇篇拖过去，而这既慢又会丢掉笔记本自己的颜色与私密标志。这一批只补 UI，worker 一行没改。
  - **就地编辑而不是弹窗**：与资源管理器 / VS Code 一致，改完立刻在树里看到结果。弹窗的问题不是多一层，是**改名时看不见兄弟节点**——而「这名字和旁边那本是不是重了」正是改名时最需要看见的上下文。
  - **三个入口**：右键菜单「重命名」（放在最上面，它是最常用的那一项）、双击笔记本名、选中后按 F2。双击此前没有既定含义（展开/折叠挂在左边那个箭头上），不冲突。
  - **失焦即提交，Esc 取消**：改完点别处走人是最自然的收尾。反过来做（失焦即取消）在树形侧栏里毫无提示——你看到的还是旧名字，会以为改过了。
  - **没改就不发请求**：改名是最容易「点进去又退出来」的操作，`name === cur.name` 直接关掉编辑态。每次都发一趟 PUT 等于把免费额度里最紧的请求数花在没有变化的写入上。
  - **同级重名放行、只提示**（`siblingNameTaken`，纯函数 + 单测）：服务端没有唯一约束，重名不会让任何**现有**功能出错，拦下来是凭空造一条规则。但它坏的是**以后**——P16.3.1 起 `/api/import` 按「从根到自己的完整路径」匹配笔记本，两本同级同名会算出同一条路径，导入落进哪一本取决于 SQL 的行序。这个后果是延迟的、静默的，发现时早忘了当初重的名，所以要在改名那一刻说出来；看见了还按 Enter 就是知情的选择。**不做大小写归一**：笔记本名是用户写的字面量，「ERP」与「erp」是两个名字，归一之后「为什么提示重名，明明不一样」比漏一次提示更难解释。
  - **改完要同步 `activeNotebook`**：只重拉侧栏的话，文章列表标题栏还挂着旧名字，看着像没改成。
  - **顺手把侧栏右键菜单对齐 P13.8**：那个菜单是 P16.1 随手写的，`px-4 py-2` + `whitespace-nowrap`，宽度被最长那条「取消私密笔记本」撑开；而且没有任何边界判断，贴着屏幕底部右键时菜单有一半在视口外。文件管理那个（P13.8）早就把这两件事解了——定宽 + `menuPosition()` 翻转，那个纯函数本来就与文件无关。这里直接复用，宽度 160（最长的一条是「新建子笔记本」，不必跟着它的 184），并把「取消私密笔记本」缩成「取消私密」——菜单里不必重复「笔记本」三个字，右键的对象就是它。
- **P17.2，恢复码（忘记密码的自助出路）**：在此之前，「登出了 + 忘了密码」**完全无解**——改密码要旧密码，注册接口在已有用户时 403。唯一的路是去 Cloudflare 控制台删掉 `users` 那一行再重新注册，而那条路有个静默陷阱：`users.id` 是 `AUTOINCREMENT`，不同时 `DELETE FROM sqlite_sequence WHERE name='users'` 的话新用户拿到 `id=2`，而所有笔记还挂在 `user_id=1` 上，表现是**「笔记全没了」**。一条要求人记住冷知识、记错就以为数据全丢的恢复路径，等于没有恢复路径。
  - **为什么「能读数据库」不等于「能重置密码」**：`password_hash` 是 PBKDF2-SHA256 十万轮（`worker/utils.ts`），D1 的 Console 里算不出来。所以恢复码补的不是「读库权限」，是**「有读库权限也做不到的那一步」**——这是它相对「直接改库」的真实增量，最初我判断反了。
  - **明文存，而且刻意存在 `users` 表上**：`buildExportPayload` 导的是 notebooks / articles / conversations / messages / settings / files / folders / comments / versions——**没有 users 表**（`backup.ts` 里那句 `SELECT id, username FROM users` 只用来遍历用户，不进载荷）。所以放这儿是**结构性地**不进备份，而不是靠「记得维护 `SENSITIVE_PATTERNS` 那条正则」；放 `settings` 里的话，键名不含 key/token/secret 就会随每一份自动备份与手动导出的 ZIP 下载到本地。**不哈希**：它要能被人读出来（设置页显示、D1 控制台直接复制），哈希之后这两件事都做不了，而它的全部价值就在这两件事上。
  - **不做「错 N 次作废」**（这是最初方案里唯一被推翻的一条）：那会变成**永久锁死向量**——攻击者随手猜几次就能把你唯一的兑回路径弄废，而你正处在「忘了密码」的状态，只能回去改 D1。这个方向的失败伤主人、拦不住攻击者，与 P16.6 限流 fail open 是同一条论证。「3 次作废」那套规矩来自 6 位短信验证码（10⁶ 的空间，不限次真能穷举）；而这个码是 **128 bit**，熵本身就是防线，限次只剩副作用。挡刷改用既有的 IP 限流（5 次 / 15 分钟，比登录的 8 次更紧——恢复码从来不是记的，是复制粘贴的）。
  - **一次性**：用掉即换一张，随响应返回并在界面上摆出来让人抄。用过的凭据不该继续有效——万一它是从某张旧截图、旧笔记里泄出来的，重置完还留着就等于那条路一直开着。
  - **重置顺带 `token_epoch + 1`**（复用 P16.9）：走到这条路上说明密码可能已经不受控了，那么「别的地方还登着」这件事本身就是要清理的对象。
  - **不要用户名**：单用户系统里用户名不是秘密（登录页那个框就摆在那儿），多要一个字段只是多一个能填错的地方，挡不住任何人。
  - **归一而不是严格匹配**（`normalizeRecoveryCode`）：设置页显示的是 `a3f9c1e0-8b7d4526-…` 分组形态，D1 控制台里是裸的 32 位，手抄还可能带空格。三种都认——**认不出来的时候用户没有第二条路**，而放宽这里不损失任何熵（连字符与大小写都不是秘密的一部分）。比较走常数时间（公开未鉴权接口，几行的事没理由留这个口子）。
  - **空码不能当万能钥匙**：老库补出来是 NULL，`recoveryCodeMatches` 先查长度再比较——否则空 === 空，任何人都能重置密码，这是 fail open 最坏的一种形态。老库不自动塞随机值，而是在设置页提示生成：迁移里塞一个值意味着用户从不知道它存在，而这个码只有抄下来才有意义。
  - **注册与重置后都强制摆一次**：不摆的话唯一的时机就只剩「某天主动逛到设置里」，而那时候他还不知道有这个东西。
- **P17.3，侧栏滚动条与文件夹树的归位**：症状是「笔记本一多，侧栏出一个整体滚动条」，但根因不是滚动条样式，是**结构**——`Sidebar` 那个 `overflow-y-auto` 从笔记本树一直包到最底下的「网页剪藏」，于是可增长的内容（笔记本树、标签、文件夹树、按笔记本列的笔记附件）和恒定的导航骨架（我的私有 / 回收站 / 博客管理 / 文件管理 / 网页剪藏）挤在同一个滚动容器里。笔记本一多，那几个入口就被顶到看不见，要点「文件管理」得先滚过几十本笔记本。
  - **拆成两个滚动区**：笔记本树 + 标签区 `flex-1 min-h-0 overflow-y-auto`，固定入口区 `shrink-0` 钉在底部。内容才该滚，导航骨架位置恒定才形成肌肉记忆。固定入口区自己也带 `max-h-[55%] overflow-y-auto`——进文件管理时它会多出四个二级菜单项，窗口拖得很矮时它自己滚，仍然不去挤上面的笔记本树。
  - **文件夹树从侧栏搬进主窗口**：侧栏二级菜单收成四个**高度恒定**的入口（全部文件 / 未引用 / 笔记附件 / 我的文件夹），侧栏于是彻底不随数据增长。主窗口按资源管理器语义：文件夹行排在文件之前、双击进入、面包屑逐级跳回、一次只渲染一层（`childFolders` / `folderPath`，纯函数 + 单测）。顺带解决的不只是滚动——原来那些操作是文件夹行 hover 出来的三个 12px 小图标，是整个应用里最难点中的控件；现在是正常尺寸的行 + 右键菜单（复用 P13.8 的 `menuPosition`）。三个文件夹弹窗一并迁到 `FileManager`，逻辑一行没改：它们本来就是 `fixed` 叠层，挂在哪棵组件树上都一样。
  - **拖拽落点从侧栏目录树变成文件夹行与面包屑**：命中区反而更大。原来那块只在拖拽时出现的「拖到此处移出文件夹」虚线区（P13.7）被面包屑的根那一级替掉——拖到「我的文件夹」就是移出所有子目录，语义相同而少一个只在特定时刻出现的控件。
  - **「笔记附件」不做成树**，这是这一批唯一需要论证的取舍。它看起来该跟着 P16.1 的笔记本树走，但三条都不成立：① **它是投影不是容器**——`GROUP BY n.id` 的那个查询里，同一个文件被两个笔记本的文章引用时会在两本下面各算一次，各本计数之和大于文件总数；树形结构承诺的「包含且互斥」在这里是假的，而附件真正的归属是 `files.folder_id`（同一个界面里两套矛盾的归属，树会强化错的那套）。② **树一定有洞**——那个 JOIN 只返回**确实有附件的**笔记本，`技术/前端/React` 有附件而 `技术`、`前端` 没有时，树要么渲染两个点进去是空的壳节点，要么跳级（那就不是树）；补齐空壳就要把全部笔记本拉过来，正是刚搬走的那个问题。③ **深/浅视图的账要重算一遍**——P16.2 刚为文章列表定下「默认只看这一本」，这里会是同一个问题的第二个实例，而答案还不一定一样：找附件的诉求通常是「我在哪篇笔记里插的那张图」，那更接近搜索。所以改成**平铺列表 + 按笔记本筛的 chips**：一次看到全部被引用的附件，同一个文件只出现一次，行内显示 `被 N 篇引用`（`ref_count` 本来就在 SQL 里），要问「在哪篇插的」走现成的 `GET /api/fm/files/:id/refs`。一句话：**「我的文件夹」是目录（有层级、有归属、可拖放），「笔记附件」是视图（无层级、只读、多对多）**——此前两者都长成侧栏里的树，是把不同性质的东西套进了同一个形状。
  - **多了「站在根上」这个状态**：`FmView` 的 `folder` / `notebook` id 放开为可空，URL 写成不带冒号的 `?fm=folder` / `?fm=nb`。服务端相应地把 `Number(...) || 0` 换成「参数缺失或非法 → 根层」——此前落成 `id=0` 是永远查不到东西，而 URL 是人能改的，坏值不该变成一屏空白。
  - **「我的文件夹」根层列的是「没归到任何文件夹的文件」**（`folder_id IS NULL`），与资源管理器一致：根目录既显示子文件夹，也显示散在根上的文件。它和「全部文件」的区别是后者不分层、连子目录里的一并列出。这一层也因此是拖拽「移出文件夹」的天然落点。
- **P17.4，拖拽移动的即时反馈**：拖完一个文件到别的目录，界面上**什么都不会发生**，直到那趟请求回来、列表重拉完，行才消失。网络慢时就是好几秒的"像没点动"。两个原因叠在一起：
  - **没有进行中的状态**。现在拖完立刻把那几行置灰 + 不可点（`fm.movingIds`），一松手就有反馈。**不直接删行**是因为 P14.2 那条路：落点是私密文件夹而文件正被公开文章引用时，服务端先回 `needs_force` 弹确认框——那时候还没移动，行要是已经没了，人就是在给几个看不见的文件做确认。所以 `needs_force` 分支会把置灰撤掉，等确认后再置一次。
  - **`fm.tick` 变化时 `setFiles(null)`**，整个列表闪成一个加载圈。而拖拽移动每次都 bump tick，于是每拖一次全表白一下——比慢更难受。拆成两个 effect：换视图才清空（那确实是另一份列表），tick 只是「结构变了，对个账」，原地重拉不清空。
  - **成功后立刻把行拿掉**，不等重拉。但**不是每个视图移完都会少一行**：在「全部文件」里换个目录它还在，「笔记附件」里换目录也不影响引用关系。判断抽成 `movedOutOfView(view, target)`（纯函数 + 单测）——判错的两种后果都难看：该消失的没消失等于没优化，不该消失的消失了则是行凭空少一个、几秒后自己又回来。
  - **落点就是当前这一层时直接返回**，不发请求：否则白打一趟接口，而且那几行会闪一下灰再变回来，看着像出了错。
- **P17.5，搜索结果分两层 + 多片段 + 关键词高亮**：默认搜索一直是混合检索（向量 + LIKE），但结果用 **RRF（k=60）融合**成一条平铺列表，每篇只给一个片段、且不高亮。三处都换掉了：
  - **RRF 换成硬分层**。RRF 是给「两个同样可信、分数不可比的检索器」用的融合法，而这里两条腿并不同样可信：精确命中是自明的（那个词就在眼前），语义命中要人相信。RRF 把精确命中排到语义命中下面时**无法向人解释**，而个人知识库里主流用法恰恰是"我记得有过这么个词"。现在第一层是有精确命中的（`compareExact`：全部词命中 > 部分命中 → 标题命中 > 仅正文 → 命中次数），第二层是只有语义命中的（按最高切片相似度）。中间画一条「以下为语义相关」的线——**不画的话边界处看着像排序坏了**：最后一条精确命中可能明显不如第一条语义命中，而人看不出为什么它在上面。
  - **代价说在明处，并且留了保底名额**。中文 LIKE 没有词边界（不用 FTS5 的决定见 §10 P8），搜「本」会命中笔记本 / 本地 / 日本 / 基本，而关键词腿没有最低阈值。所以 `splitSlots` 给第二层**保底 3 个位置**，第一层最多占 7：一个高频短词不能把语义腿整个挤没，那是搜索里唯一能找到"说的是这件事但用词不同"的路。第二层不足时名额还给第一层。多词查询还有「全部词命中优先」这一档挡噪音——关键词腿的 SQL 是 `OR`，没有这一档时搜「向量 检索」会让只含「检索」的文章和两个词都有的并列。单字查询挡不住，那是无词边界的固有代价。
  - **每篇最多 3 个片段，各自是一个跳转落点**。定位机器（`ArticleEditor` 收 snippet 去正文里找段落）本来就收一段任意文本，同一篇的几处命中天然可以各跳各的。**不做成可配置**：P17 刚把设置面板拆成七类就是因为设置项太多，而这个数字没有人会有偏好；多出来的写一行「另有 N 处匹配」，信息量一样，省一个开关。
  - **片段之间必须去重**。向量切片本就重叠 100 字（`CHUNK_OVERLAP`），而关键词摘要（命中点前 40 后 120 字）常常整段落在某个切片内部——不处理就是同一段文字在同一篇下面出现两遍，看着像坏了。`dedupeSnippets` 保留先出现的，而精确片段排在前面，于是精确的赢。
  - **`makeSnippet` 无命中时回落成正文前 160 字，这是错的**，换成返回空数组：调用方要能区分「命中了但摘不出来」和「压根没命中」，旧行为让纯语义结果看着像关键词命中。
  - **高亮走 React 元素而不是 HTML 字符串**（`highlightParts` 产出 token 数组）。片段是任意正文，仓库里没有 HTML 消毒库，永不经过 `dangerouslySetInnerHTML`——与评论正文同一条论证。长词优先匹配，否则搜「笔记 笔」时「笔记」会被「笔」先切开。**只高亮精确片段**：语义片段里可能一个查询词都没有，硬凑就是骗人，改用一个灰色「语义」角标自己解释自己。
  - **顺带清掉一个 N+1**。向量腿此前在循环里**串行**两次 D1 查询（查文章 + 查切片），`topK=10` 就是 20 次往返。而第二层要排出名次来 topK 得提到 30，不改就是 60 次串行。现在收齐后两条 `IN (...)` 一次取完。降级那条路（去掉 filter 重查）也补上了 `a.user_id = ?`：单用户应用里不是可利用的漏洞，但让「取谁的文章」依赖 Vectorize 的 filter 而不是 SQL 的 where，是把正确性押在一个可以静默失效的东西上。
- **P18，待办模块**：做成一个**可选模块的形状**（表 + 路由 + cron 钩子 + 面板，五处），以后加日记、账本照这个填。这是「插件」这个诉求在 Workers 上唯一免费且不过度工程的落法，两条更花哨的路都实测过否：
  - **Worker Loader / Dynamic Workers 确实存在**（2026-07-22 开放测试，官方形容 "like a secure version of `eval()`"），但它解决的是**跑不可信代码**——沙箱、限制绑定、拦网络请求。而这段代码是自己写的。为它套沙箱要付：默认碰不到 D1（得自己设计一套 RPC 宿主 API，那恰恰是插件系统里最难的部分）、每改一次代码算一个新计费单位、跨 isolate 调试。而它属于 Workers Paid 生态，与「免费额度内的单用户知识库」这个前提冲突。
  - **WASM + QuickJS 那条路技术上成立**（`quickjs.wasm` 静态 import 由平台预编译，`plugin.js` 是喂给解释器的**字符串**——对运行时是数据不是代码，所以合规），但 Workers Free 的 **3 MB 体积**（QuickJS 产物 ~1 MB，吃掉三分之一）与 **10 ms CPU**（官方说平均 Worker 2.2 ms，而「鉴权/SSR/大 payload 解析」这类已经 10–20 ms）两条顶着；跨边界 async 要 Asyncify 或重入泵，是独立项目量级。**而且就算做出来，待办也装不进那个沙箱**：`todos` 表建不了、React 面板走的是 vite 打的前端 bundle。为大约 15% 的动态性建一整套解释器沙箱，剩下 85% 照样改代码照样部署。
  - **「该不该推」全部收在 `src/lib/todoRules.ts` 的 `dueAction` 里**，纯函数 + 单测。不这么做的话这个判断会散在 SQL 的 `WHERE`、cron 循环里的几个 `if`、前端的显示逻辑三处，而**这类 bug 不报错**：只是提醒在错误的时间到达、或者压根不到达，人要等到错过截止时间才发现。没有堆栈、没有红条，只能靠穷举钉住。所以 SQL 只做粗筛（未完成、未删、有时间），精确判定交给纯函数——把三段语义翻译成 SQL 会得到一条没人看得懂也没法单测的 `WHERE`。
  - **逾期提醒与提前提醒必须是两个独立计数**。这是整个功能最容易写错、且错了完全静默的一处：提前提醒推过之后 `reminded_at` 就有值了，若沿用「`reminded_at IS NULL` 才推」那条件，**逾期提醒永远不会发生**。改用 `overdue_reminds` 独立计数。改时间时两个都要复位（「重新武装」）——否则把截止时间往后挪之后，新的提醒时间到了也不会推，而人明明改了。
  - **历法单位是本地概念，不是 UTC**。UTC+8 的人把截止设在本地周一 06:00，在 UTC 上是**周日** 22:00，按 UTC 数工作日会把周日当成要跳过的那天，差一整天。所以每条存一个 `tz_offset`（创建时的本地偏移分钟），所有历法运算先移进本地墙上时间再做、算完移回。月末加月要**夹取**（1/31 + 1 个月 = 2/28 而不是 3/3），否则「每月最后一天」这种周期会越滚越靠后，几个月后跑到月中。只跳周末、**不认法定节假日**：那需要逐年维护的日历，而过期的节假日表会让「提前 3 个工作日」算出一个静悄悄的错时间，比没有更坏。
  - **逾期连续提醒有上限（2 次，每天一次）**。不设的话它会一直响到你删掉它，而那时你已经不看这个渠道了——**通知疲劳会把其他待办的提醒一起废掉**，这是不设上限最贵的代价。第一次逾期推送不等满 24 小时，否则「到点了」这条消息要隔一天才来。
  - **周期任务从上一次的截止时间往后推**，不是从完成时刻：按现在推的话晚做一天就把整个周期挪一天，「每周一交周报」会慢慢漂到周三。
  - **没配通知渠道时能用，但横幅常驻**。硬拦会挡住「只想记一下事情」这个合理用法；而一个设了提醒却永远不会响的待办比没有提醒更坏，人以为自己被兜住了。自检走一个**只回布尔**的新接口（`GET /api/notify/channels`），连掩码后的凭据都不必下发。界面上每行还显示推送状态（待提醒 / 已提醒 / 逾期 n/2 / 不再提醒），让「它响过没有、还会不会响」一眼可见。
  - 删除是**软删**（`deleted_at`），与 P14.1 立的那条规矩一致：这个库里没有不可逆的破坏性操作。
- **P18.1，`dark:` 工具类从来没接上主题开关**：明亮模式下待办的编辑弹窗是深色的。根因不在待办——`src/index.css` 只有一行 `@import "tailwindcss"`，全仓库没有 `@custom-variant dark`、没有 `tailwind.config`、没有任何 `darkMode` 设置，而 **Tailwind v4 的 `dark:` 默认跟 `prefers-color-scheme` 走**，也就是操作系统；应用的明暗开关加的是 `<html class="dark">`（`Layout.tsx`）。两者从来没接上。
  - **受影响的是全部六个用 `dark:` 的组件**：`ArticleEditor`、`ClipPage`、`RemindersPanel`、`TagBrowserDialog`、`VersionHistoryDialog`、`TodosPanel`。触发条件是「系统深色 + 应用切亮色」（那几处仍然深）或反过来（那几处顽固地亮）。`main.tsx` 首次加载跟随系统，所以只有**手动切过主题**的人才会撞见——而这个应用有切换按钮，所以它一直在那儿。
  - 修法是一行 `@custom-variant dark (&:where(.dark, .dark *));`。`index.css` 里那 70 多条手写的 `.dark xxx` 规则**一直是对的**，这一行只是让工具类与它们同一个口径，那些规则一条没动。这类 bug 值得记一笔：它不报错、不进日志，而且**只在两个开关不一致时才出现**——开发机的系统主题跟应用主题长期一致的话，可以很久都撞不见。
  - **待办面板同时从居中弹窗改成右侧抽屉。** 理由不是审美：待办是「边做边看」的东西——在写笔记时想确认今天还剩什么，居中弹窗把正文整个盖住，抽屉只推开一条边。设置 / 统计 / 日志是「专门去一趟再回来」，那些仍然居中，**这是两类面板的功能差别，不是风格不统一**。形状上也更合：待办是一列纵向条目，居中的 `3xl` 框横向全是留白、纵向反而挤。入口本来就在右上角挨着铃铛，从右边推出来方向也一致。
  - **编辑对话框仍然居中浮在抽屉之上**：列表在抽屉、表单在弹窗是标准组合，而那个表单有两列网格，塞进 26rem 会很挤（窄处退成一列）。行内的编辑 / 删除按钮从 hover 才显形改成**常显**——触屏没有 hover，那样等于在手机上够不到。滑入动画走 CSS 类并尊重 `prefers-reduced-motion`：横向滑动会诱发前庭功能障碍的人不适，而这个动画没有任何信息量。
- **P18.2，截止时间的缺省与即时反馈**：三处小改，但第一处影响的是这个模块成不成立。
  - **新建时默认给一个截止时间**（明天此刻、分钟归零）。此前默认空着，而**没有截止时间 = 永远不会提醒**——`dueAction` 里 `remind_at` 与 `due_at` 都为空时直接返回 `none`。一个以通知为重点的模块，缺省状态却落在「记了但不会响」上，是把最常见的路径指向了最没用的结果。
  - **提前量补上「分钟」维度**，排在单位列表最前。同时**如实说明精度**：cron 是每 5 分钟一次（`SCAN_INTERVAL_MIN`），所以分钟级提前量实际有 ±5 分钟误差——填「提前 30 分钟」有意义，填「提前 2 分钟」和填 5 分钟收到推送的时刻可能完全一样。选中「分钟」时界面上多一行琥珀提示，不藏着：让人以为能精确到分，比不提供这个维度更坏。
  - **填完截止时间即时显示「距离截止还有…」**，而且**给多个维度**（`3 天` + `3 个工作日` + `约 2 周`）。单给一个不够用：选提前量时想的往往是工作日，而跨周末时「3 天」与「2 个工作日」差出整整一天，不换算就得自己数日历。不足一天时不提工作日（「0 个工作日」是废话），不足一周时不提周数。
  - 顺带确认了一件用户担心的事**不需要改**：正常完成之后不会再提醒。三道独立的闸挡着——`dueAction` 第一行 `status === 'done'` 直接出局、cron 的 SQL 粗筛就带 `status = 'pending'`、周期任务滚出的是**全新一行**（旧那条已是 `done`，两条是独立记录而不是「同一条响两次」）。`todoBucket` 也把已完成排在逾期判定**之前**：截止时间早就过了但标了完成的，归「已完成」桶，不算逾期。

## 11. 项目结构

见 `README.md`「项目结构」一节（`worker/` 后端 Hono 路由 + `src/` React 前端 + `docs/` 设计文档 + `tests/` Vitest）。

分层是 `src/lib/*`（纯函数、可单测）与 `worker/routes/*`（HTTP + D1 + 拼装），**没有全仓库的 repository 层**，只有一处例外：

### 11.0 `worker/repo/blogRepo.ts`（P13.5）

公开博客的取数集中在这一个文件里，`blog.ts` 与 `pages.ts` 只调函数、不见 SQL。抽它的理由不是「分层应该这样」，而是这块有两条**安全不变量**：

- `PUBLIC_WHERE = a.is_public = 1 AND a.is_private = 0 AND a.deleted_at IS NULL` —— 哪些文章能被公开读到；
- `POST_WHERE = PUBLIC_WHERE AND COALESCE(a.is_page,0)=0` —— 其中哪些进文章流（P13.4）；
- 以及「哪些列能进公开响应」（`getPublicArticle` 选出的那几列就是全部；`notebook_id` 只用于相关文章打分，由调用方摘掉）。

改造前它们散在一个 400 多行文件的十来个查询点上：P12.4 加五个模块要抄一遍 WHERE，P13.4 加单页要逐个改过去，抄漏一次就是把未公开的文章漏出去。搬家时发现的实证：`GET/POST /api/blog/comments` 里「目标文章必须公开」那个条件是**手抄**的（没用 `PUBLIC_WHERE`），现在共用同一个常量——条件逐字相同，行为不变。

刻意**不**扩展成全仓库 repository 层：仓库里没有 D1 的测试替身，把 `articles.ts`/`fm.ts` 的 SQL 也搬一遍不会让它们变得可测，只会多一层间接。真正让这些 SQL 可测的是 P13.6 的 Worker e2e（真 workerd + 真 D1，见 §11.1）——这次纯搬运正是靠那 27 个用例兜住的。

边界：`blogRepo.ts` 只有取数与「行 → 公开响应字段」的映射；请求解析、浏览计数去重与评论限流（都用 Cache API，不碰 D1）、线程装配仍在 `blog.ts`。`blog.ts` 由 515 行降到 269 行。

### 11.1 测试分层（P13.6）

两个 Vitest project（`vitest.config.ts` → `vitest.unit.config.ts` / `vitest.worker.config.ts`）：

- **单元（node 环境）**：`src/lib/*` 与 `worker/utils.ts` 里的纯函数。这一层此前是唯一的一层，代价是 `worker/routes/*` 里的 SQL **零覆盖**——而本项目的安全不变量（哪些文章能公开、哪些字段能进公开响应）恰恰都写在 SQL 里。
- **Worker 端到端（workerd）**：`@cloudflare/vitest-pool-workers` 在 miniflare 里跑真的 `worker/index.ts`，配真的 D1 与 R2，用 `SELF.fetch()` 打接口。

几处必须记住的取舍：

1. **`wrangler.test.toml` 只声明 D1 + R2**。Vectorize 与 Workers AI 没有本地实现，声明了直接起不来；能这么做是因为 `vectorizeArticle` 整个包在 try/catch 里、失败只返回 `vectorize_error` 字符串（`worker/routes/articles.ts`），绑定缺失不影响笔记与博客这条主链路。代价是 `/api/search`、`/api/conversations`、`/api/stats` 进不了 e2e。同理不声明 `[assets]`——否则测试就依赖 `dist/` 构建产物，`test` 与 `build` 的先后一变就红。
2. **存储隔离是按测试文件的，不按 `it` 回滚**（0.19 起 `isolatedStorage` 不再是可配置项）。所以夹具里有 `dropAll()`，每个用例先把库丢干净。它必须**多轮重试**：D1 的 `foreign_keys` 常开且不允许 `PRAGMA` 关掉，先丢父表 `users` 再丢带 `REFERENCES users(id)` 的子表会报 `no such table: main.users`；与其硬编码依赖顺序（加一张表就要记得改），不如失败的留到下一轮。
3. **`ensureSchema` 的 memo 是模块级的**（每个 isolate 只真跑一次），所以「老库迁移」这类断言一个文件里只放一个 `it`。这条测试必须**直接调** `ensureSchema` 而不是靠发请求触发——中间件里那次是 `.catch(() => {})` 吞掉的，吞掉的异常测不出来，而这正是「SCHEMA 加了列、migrate 也加了列」时 `duplicate column name` 的翻车点。
4. **另有一道静态锁** `tests/schema.test.ts`：按文本比对 `system.ts` 的 `SCHEMA` 与 `migrate.ts` 的幂等语句（列与表两个方向）。它证明的是两份定义一致，不是 SQLite 能接受这份 DDL——后者由 e2e 在真 D1 上跑。两者都要，因为漏改任何一边都不会立刻报错。
5. **类型检查此前不覆盖 `tests/`**（`tsconfig.json` 的 `include` 只有 `src`/`worker`），改了函数签名时类型检查一声不吭、要跑到 vitest 才炸。现在多一份 `tsconfig.tests.json`（`npm run typecheck`）把 `tests` 也纳入，`cloudflare:test` 的类型走 `@cloudflare/vitest-pool-workers/types` 子路径。**主 `tsconfig.json` 保持不变**——`npm run build` 用的是它，不该让生产构建依赖测试文件能否编译。绑定类型要自己声明（`tests/env.d.ts`），而 **0.19 起 `env` 的类型是 `Cloudflare.Env` 而不是旧文档里的 `ProvidedEnv`**：照抄旧写法 `declare module 'cloudflare:test' { interface ProvidedEnv … }` 不会报错、但完全不生效，`env.DB` 照旧是类型错误。文件里有 `import` 就是模块，所以增强全局命名空间必须包一层 `declare global`。顺带这道检查一开就抓出一处：应用里 `BUCKET?` 是可选的（生产可能没配 R2），测试代码却直接用——在测试的 Env 里收窄为必填，而不是到处加判空（那会把「真的没拿到 bucket」和「类型上可能没有」混成一件事）。
6. **`PRAGMA table_info` 对不存在的表返回 0 行而不报错**（P14.1 踩到）。给已有表补列前必须判空，否则 `ALTER TABLE` 直接撞 `no such table`；而 `ensureSchema` 的异常在 `worker/index.ts` 里被吞掉，抛在中途会让它**后面所有迁移步骤静默不执行**。`migrate.ts` 从不建 `notebooks`（那是 `/api/init` 的事），只给已存在的表补列。

## 12. Cloudflare 资源配置（wrangler.toml）

```toml
name = "cfnote"
main = "worker/index.ts"
compatibility_date = "2024-12-01"

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/blog/*", "/robots.txt", "/sitemap.xml"]

[triggers]
crons = ["47 2 2 * *", "*/5 * * * *"]    # 月度用量归档+回收站清理;每 5 分钟扫描到期提醒推送 + 判一次自动备份是否到期

[[d1_databases]]
binding = "DB"
database_name = "cfnote-db"       # 不写 database_id，按名称绑定

[[vectorize]]
binding = "VECTORIZE"
index_name = "cfnote-index"       # 1024 维，cosine

[ai]
binding = "AI"

[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "cfnote_usage"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "cfnote-files"      # 需先在 Dashboard 开通 R2
```

`wrangler.toml` 不含任何账号相关的资源 ID（按名称绑定）——部署与维护全程不需要在本地执行数据库命令，fork 无需修改任何文件。资源创建与三种部署方式见 README。

## 13. 安全性与注意事项

1. **开发阶段 schema 约定**：只做增量幂等（加列/建表），不写数据迁移；不兼容变更时提示线上清空重初始化（见 §5）。**这条约定现在有测试兜底（P13.6，见 §11.1）**：`tests/worker/init.test.ts` 在真 D1 上验全新建表带齐所有列、`/api/init` 可重复执行、全新库上跑 `ensureSchema` 不撞 `duplicate column`；`tests/worker/migrate.test.ts` 手工造一张早期 `articles` 表验补列后老数据不丢；`tests/schema.test.ts` 静态比对两份定义。此前这三件事全靠读代码确认，而 `migrate` 的失败在 `worker/index.ts` 里是被吞掉的——漏改一边不会有任何报错。
2. **内容哈希去重**：仅内容实际变化才重新向量化，避免重复消耗 neurons。
3. **搜索模式分离**：默认混合搜索仅消耗嵌入 neurons；AI 问答用户主动触发才消耗 LLM。
4. **附件私密性**：能力 URL + 访问分级 + 私密文件夹一票否决；取消公开后新访客约 5 分钟内失效（已看过的浏览器缓存不可收回，属预期不可逆）。
5. **删除语义（P14.1 起全部可逆）**：单篇与**整本笔记本**都是软删除，30 天内可恢复。笔记本此前是硬删——清向量 → **立即**清 R2 附件 → `DELETE FROM notebooks` 靠外键 CASCADE 带走全部文章，一次误点两百篇笔记连同图片一起消失，回收站里什么都不留；这是整个知识库里唯一一处不可逆的破坏性操作。改法是给 `notebooks` 加 `deleted_at`：**只要永远不 DELETE 那一行，CASCADE 就永远不会触发**，因此不必去改外键约束（那要重建表，违反「只做增量幂等」）。附件的三档判定见下一条。
6. **附件与回收站的关系**：软删除（进回收站）**完全不碰附件**——`article_files` 行保留、R2 一个字节不动。附件是多对多的：同一张图可能被三篇笔记引用而只有一篇进了回收站，「附件跟着进回收站」要么让文件在文件管理里消失（另外两篇活着的笔记当场变死链，可逆的回收站反而把活着的东西弄坏了），要么只是个不影响任何行为的装饰标记。正确语义是**附件的生死只看还有没有活着的引用，而回收站里的笔记算活着的引用**（它可能被恢复）。彻底删除时（单篇 purge / 清空回收站 / 30 天 cron / 笔记本 purge，同一条管线）按三档判定：① 还被别的文章引用 → 留；② 引用归零但 `folder_id` 非空 → 留，落到「未引用」视图（一旦收进文件夹它就从「某篇笔记的附身之物」变成「你主动收藏的资产」）；③ 引用归零且从没归过文件夹 → 连同 xmind 边车一起清 R2。判定抽成 `orphanKeysAfterPurge()`，**清空前的只读预检 `GET /api/articles/trash/impact` 与真正的清理共用它**，确认框里那句「将清理 N 个附件（共 X）」因此不会和实际结果对不上。该函数同时从逐 key 循环改成集合查询：清空一个 200 篇 × 5 附件的回收站，老写法是约 3000 次串行 D1 往返，很容易撞上 Worker 的挂钟上限。
7. **版本历史保留**：内容变更保存时快照提交版本；「同小时合并」在 SQL 侧判定（每篇每小时至多一版），保留策略（最近若干版全留 + 更早每自然日一版 + 硬上限）由 `src/lib/versionRetention.ts` 纯函数算出待删 id，控制 D1 占用；文章硬删除时版本随 `ON DELETE CASCADE` 清除。
8. **提醒推送渠道**：Telegram / 企业微信 / 飞书 / 钉钉 / Server酱 / 自定义 Webhook 统一为「一个 URL + 一段 JSON」，纯逻辑（类型/字段/请求构造/**凭据掩码与合并**）在 `src/lib/notifyChannels.ts`（前端表单与单测复用），实际 fetch 与钉钉/飞书 HMAC 加签在 `worker/routes/notify.ts`。配置以 JSON 存 `settings.notify_channels`（含 token/webhook，**不导出**）；`*/5` cron 扫 `datetime(remind_at) <= now AND reminded_at IS NULL` 的笔记逐条推送后置 `reminded_at` 防重发，`scheduled` 按 `event.cron` 分支（高频跑提醒、月度跑归档/清理）。**凭据不回显（P12.10）**：settings 表的掩码是按**键名**匹配 `/key|token|secret/` 的，而这些渠道全挤在 `notify_channels` 一个键里，此前整块 JSON 明文下发；现在按**字段**掩码——token/sendkey/加签密钥，以及企业微信、钉钉的 Webhook 地址（`?key=` / `?access_token=` 就在 URL 里，那串地址本身就是凭据），`chat_id` 不遮（拿到也发不了消息，遮了反而看不出配给哪个会话）。写回不能像标量那样「整键跳过」——同一份 JSON 里还有 `enabled` 等要保存的改动，故 `mergeMaskedChannels` 按 id 逐字段合并；`/api/notify/test` 走同一个合并，否则测试会把 `****` 当 token 发出去。
9. **安全基线**：密码 PBKDF2 + 随机盐；`JWT_SECRET` 存 Secret 不硬编码；除免登录项外所有 API 经中间件验证 JWT；导出文件排除 `*_api_key`、`notify_channels` 等敏感项。**博客自定义脚本（P12.12）是个例外**：它明确允许博主注入任意 JS，安全性由博主自负、我们只做提醒——但边界是硬的（不注入管理端/预览/私密分享页、有 `?nojs=1` 逃生阀、主题导入导出永不携带 JS），因为博客与 `/api/*` 同源，一段被投毒的第三方脚本能带着登录 cookie 读走整个知识库。
10. **Workers CPU 限制**：AI/DB 调用为 I/O 等待不计 CPU；实际 CPU 操作（JSON/字符串处理）远低于限额。
11. **登录爆破与限流的边界（P16.6）**：登录每 IP 每 15 分钟 8 次失败，超限直接 429 且**不跑那次 10 万轮 PBKDF2**——这条限流省的是 CPU 与 D1 读，**不是请求数**（请求进到 Worker 时那一次已经计了）。要在请求数这层挡，用 Cloudflare 控制台的 WAF 速率限制规则，那是配置不是代码。存储是 Cache API，**按 colo 计数**：挡得住一台机器猛敲，挡不住分布式爆破；缓存不可用时**降级为放行**（把主人锁在门外没有第二条补救路径）。评论限流改用同一份实现（`src/lib/rateLimit.ts` 纯逻辑 + `worker/rateLimit.ts` 后端），免得再出现「有的接口有、有的接口没有」。**已知未做**：JWT 无吊销（7 天内泄露即有效），无改密码接口；口令下限 6 位是限流之后的刻意取舍。
12. **派生值只用重算，不用增量（P16.6）**：`notebooks.article_count` 全仓只有 `worker/utils.ts` 的 `recountNotebook` 一种写法。`± 1` 漏一次就永久漂移且无自愈路径；重算多一次走 `idx_articles_notebook` 的 `COUNT(*)`，换来「下一次写入自动纠正」。重算语句必须排在文章行真正落库**之后**，否则读到的是旧状态；口径统一为 `deleted_at IS NULL`。
