# CFNote - 私人知识库系统设计文档

> 本文档描述当前架构（Cloudflare Workers + Static Assets）。分期演进的详细需求见 `docs/`：
> `roadmap-2026-07.md`（总路线）、`wysiwyg-editor.md`（富文本）、`public-blog.md`（公开博客）、
> `file-manager.md`（附件与文件管理）、`notifications.md`（提醒与推送渠道配置）、`evernote-gap.md`（Evernote 功能对标与 P8/P9/P10 实现要点）。

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
| 定时任务 | Cron Triggers | 月度用量归档 + 回收站过期清理 |

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
  content TEXT NOT NULL,             -- 纯文本渲染，不解析 markdown/HTML
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
| POST | `/api/reindex` | 分批补向量索引 |
| GET/DELETE | `/api/system-logs` | 系统日志查询 / 清理 |

### 6.2 笔记本 / 文章（`/api/notebooks`, `/api/articles`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/notebooks[/:id]` | 笔记本 CRUD（删除级联文章+向量） |
| GET | `/api/notebooks/:id/articles` | 笔记本下文章列表（置顶优先） |
| POST | `/api/articles` | 创建（自动向量化） |
| GET/PUT/DELETE | `/api/articles/:id` | 详情 / 更新（内容变则重向量化）/ 软删除入回收站 |
| POST | `/api/articles/import` | URL 导入（Jina Reader） |
| GET | `/api/articles/private` `/published` `/tags` `/by-tag` `/trash` | 私有 / 已公开(博客管理,按 updated_at 降序) / 标签聚合 / 按标签 / 回收站视图 |
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
- JWT（HMAC-SHA256），有效期 7 天，密钥存 Worker Secret `JWT_SECRET`
- 附件读取额外接受同源 cookie 副本（`cfnote_t`，仅 `GET/HEAD /api/files` 认，写操作只认请求头，不引入 CSRF 面）

## 7. 前端页面设计

### 7.1 路由（前端 SPA + 平台分流）

**顶层分流**(`App.tsx` 模块级正则判定 `window.location.pathname`,独立懒加载 chunk):

| 路径 | 页面 | 鉴权 |
|------|------|------|
| `/blog`、`/blog/:id`、`/blog/share/:token` | 公开博客（独立 chunk，不进应用壳；自带 pushState/popstate） | 免登录 |
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

### 7.2 主应用布局（四栏，emerald 绿 Evernote 风格）

```
┌──────────────────────────────────────────────────────────────┐
│ ☰  🔍搜索           主题  统计  设置  AI  用户名  退出        │
├────────┬──────────────┬─────────────────────────┬────────────┤
│笔记本   │  文章列表     │  源码/富文本/预览 编辑器 │ AI 对话    │
│标签     │ (可拖宽,置顶) │  标题 / #标签 / 目录     │ 面板       │
│回收站   │              │  📎附件 🔗分享 公开/私有 │ (可拖宽)   │
│文件管理 │              │                         │            │
│网页剪藏 │              │                         │            │
└────────┴──────────────┴─────────────────────────┴────────────┘
```

- 左侧笔记本侧栏、预览目录、AI 面板、文章列表宽度均可折叠或拖拽，状态记忆于 localStorage
- 编辑器三模式：源码 Markdown / Tiptap 富文本 / 预览；标签行在标题下（虚线胶囊入口）；预览目录（H1–H4）可折叠

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

## 10. 公开博客与分享（详见 public-blog.md、evernote-gap.md）

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
- 博客管理切换卡顿（P13.1）：`openInEditor` 原来 `await` 完 `/articles/:id` 才 `setSelected`，于是点了 B、右边还杵着 A 转圈。改成与 `Layout.openArticle` 同一套乐观切换：先用列表行（标题 + `summary`）立刻换，正文异步补全（`ArticleEditor` 的 `loadingContent` 早就有了）。慢请求回来时若已切走则丢弃结果。这里不存在 P12.6 里「不同调用方字段形态不一」那个顾虑——列表行只有 `PublishedArticle` 一种形态。
- 博客管理（P11.1，P11.4 改内联，P11.7 改两栏可编辑）：侧栏「博客管理」**内联占据右侧工作区**（非弹窗，`?panel=blog`）。左侧为已公开文章列表（`GET /api/articles/published`，**按 `updated_at` 降序**，搜索/按笔记本过滤/按文章·单页过滤，悬浮出「预览↗ / 设为单页 / 取消公开」，右缘可拖拽、宽度存 `cfnote-blog-list-w`），右侧点选后取全文并**复用 `ArticleEditor`** 直接编辑（源码/富文本/预览三模式）；保存走 `PUT /api/articles/:id`，只就地更新该行、**不重排列表**，取消公开/设为私有则移出列表并清空右栏。其下「评论管理」（`?panel=comments`）与「页面布局」（`?panel=layout`）为二级菜单。
- 评论（P11.2，P11.7 增待审就地显示与锚点，P11.9 记来源）：`comments` 表（`parent_id`/`root_id` 支持 2 层嵌套，`status` pending/approved/rejected，`is_admin` 博主回复，`ip`/`user_agent` 明文来源仅管理端可见）；公开 `GET/POST /api/blog/comments`（POST 中间件单独放行，默认待审核、每 IP 每分钟限流、蜜罐、正文纯文本渲染防 XSS），鉴权 `/api/comments/*` 审核；开关与免审核存 `settings.comments_enabled/comments_auto_approve`；私密分享页不显示评论；待审可复用通知渠道推送。访客提交后其待审评论存 `localStorage`（`cfnote-pending-cmt-<articleId>`）并就地降调显示为「待审核」，通过或超 7 天自动清除（合并逻辑见 `src/lib/pendingComments.ts`）；评论行带 `id="comment-<id>"` 锚点，`/blog/:id#comment-<id>` 可直达并短暂高亮。管理在「博客管理 → 评论管理」二级菜单，列表显示来源 IP 与 UA。

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
crons = ["47 2 2 * *", "*/5 * * * *"]    # 月度用量归档+回收站清理;每 5 分钟扫描到期提醒推送

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
5. **删除语义**：单篇删除进回收站（软删除，30 天可恢复）；删除整本笔记本因 `ON DELETE CASCADE` 外键仍为彻底删除（弹窗注明）。
6. **版本历史保留**：内容变更保存时快照提交版本；「同小时合并」在 SQL 侧判定（每篇每小时至多一版），保留策略（最近若干版全留 + 更早每自然日一版 + 硬上限）由 `src/lib/versionRetention.ts` 纯函数算出待删 id，控制 D1 占用；文章硬删除时版本随 `ON DELETE CASCADE` 清除。
7. **提醒推送渠道**：Telegram / 企业微信 / 飞书 / 钉钉 / Server酱 / 自定义 Webhook 统一为「一个 URL + 一段 JSON」，纯逻辑（类型/字段/请求构造/**凭据掩码与合并**）在 `src/lib/notifyChannels.ts`（前端表单与单测复用），实际 fetch 与钉钉/飞书 HMAC 加签在 `worker/routes/notify.ts`。配置以 JSON 存 `settings.notify_channels`（含 token/webhook，**不导出**）；`*/5` cron 扫 `datetime(remind_at) <= now AND reminded_at IS NULL` 的笔记逐条推送后置 `reminded_at` 防重发，`scheduled` 按 `event.cron` 分支（高频跑提醒、月度跑归档/清理）。**凭据不回显（P12.10）**：settings 表的掩码是按**键名**匹配 `/key|token|secret/` 的，而这些渠道全挤在 `notify_channels` 一个键里，此前整块 JSON 明文下发；现在按**字段**掩码——token/sendkey/加签密钥，以及企业微信、钉钉的 Webhook 地址（`?key=` / `?access_token=` 就在 URL 里，那串地址本身就是凭据），`chat_id` 不遮（拿到也发不了消息，遮了反而看不出配给哪个会话）。写回不能像标量那样「整键跳过」——同一份 JSON 里还有 `enabled` 等要保存的改动，故 `mergeMaskedChannels` 按 id 逐字段合并；`/api/notify/test` 走同一个合并，否则测试会把 `****` 当 token 发出去。
8. **安全基线**：密码 PBKDF2 + 随机盐；`JWT_SECRET` 存 Secret 不硬编码；除免登录项外所有 API 经中间件验证 JWT；导出文件排除 `*_api_key`、`notify_channels` 等敏感项。**博客自定义脚本（P12.12）是个例外**：它明确允许博主注入任意 JS，安全性由博主自负、我们只做提醒——但边界是硬的（不注入管理端/预览/私密分享页、有 `?nojs=1` 逃生阀、主题导入导出永不携带 JS），因为博客与 `/api/*` 同源，一段被投毒的第三方脚本能带着登录 cookie 读走整个知识库。
9. **Workers CPU 限制**：AI/DB 调用为 I/O 等待不计 CPU；实际 CPU 操作（JSON/字符串处理）远低于限额。
