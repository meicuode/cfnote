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
| 代码高亮/公式 | highlight.js + KaTeX（`$…$`/`$$…$$`）| 渲染后增强，均按需懒加载 |
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

`wrangler.toml` 中 `[assets] not_found_handling = "single-page-application"` + `run_worker_first = ["/api/*"]`：`/api/*` 优先进 Worker，其余路径由平台直出静态资源，未命中回退 SPA 入口（`/blog`、`/clip` 等前端路由由此工作）。

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
| Workers 请求 | **10万次/天** | 静态资源请求不计入 |

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
  ip_hash TEXT,                      -- SHA-1(ip)，限流/溯源，不存明文
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
| GET/PUT | `/api/settings` | 设置读取（敏感 Key 脱敏）/ 更新（掩码跳过） |
| GET | `/api/export` | 导出全部数据为 JSON（排除敏感项） |
| POST | `/api/import` | 导入恢复 |
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
| GET | `/api/articles/private` `/published` `/tags` `/by-tag` `/trash` | 私有 / 已公开(博客管理) / 标签聚合 / 按标签 / 回收站视图 |
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

### 6.5 公开博客 / 统计（`/api/blog`, `/api/stats`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/blog/posts` `/:id` `/hot` | 博客列表 / 详情（计浏览）/ 热榜 |
| GET | `/api/blog/share/:token` | 私密分享详情（不入列表/不计浏览，过期 410） |
| GET/POST | `/api/blog/comments` | 某公开文章已通过评论（2 层线程）/ 访客提交（免登录，默认待审核，限流+蜜罐） |
| GET | `/api/comments` `/counts` | 评论审核列表 / 待审计数（鉴权，经文章所有权） |
| POST | `/api/comments/:id/approve` `/reject` `/reply` | 通过 / 拒绝 / 博主回复（自动通过） |
| DELETE | `/api/comments/:id` | 删除评论 |
| GET/POST | `/api/stats` `/stats/archive` | 统计仪表盘 / 用量归档 |
| POST | `/api/notify/test` | 用面板填写的渠道配置发一条测试消息 |

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
| `?panel=files\|settings\|stats\|logs\|blog` | 叠加在基础路径上的主模块面板(文件管理/设置/统计/日志/博客管理) |
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

## 10. 公开博客与分享（详见 public-blog.md、evernote-gap.md）

- `/blog` 免登录整站博客（IT之家风格，亮/暗双主题，热榜，浏览计数 Cache API 去重）；仅 `is_public=1 AND is_private=0 AND deleted_at IS NULL` 的笔记可见。
- 发布前对全文做敏感信息扫描 + 附件清单目视确认（`sensitiveScan`）。
- 私密分享：`articles.share_token/share_expires_at` 两列即全部状态（单分享），`/blog/share/<token>` 凭链接可看，不入列表/热榜、不计浏览量，过期 410；设为私有或移入回收站自动撤销。
- 博客管理（P11.1）：侧栏「博客管理」全屏模块（`?panel=blog`），列出本人全部已公开文章（`GET /api/articles/published`），搜索/按笔记本过滤/预览/打开编辑/取消公开。
- 评论（P11.2）：`comments` 表（`parent_id`/`root_id` 支持 2 层嵌套，`status` pending/approved/rejected，`is_admin` 博主回复，`ip_hash` 限流）；公开 `GET/POST /api/blog/comments`（POST 中间件单独放行，默认待审核、每 IP 每分钟限流、蜜罐、正文纯文本渲染防 XSS），鉴权 `/api/comments/*` 审核；开关与免审核存 `settings.comments_enabled/comments_auto_approve`；私密分享页不显示评论；待审可复用通知渠道推送。管理在「博客管理 → 评论」子 tab。

## 11. 项目结构

见 `README.md`「项目结构」一节（`worker/` 后端 Hono 路由 + `src/` React 前端 + `docs/` 设计文档 + `tests/` Vitest）。

## 12. Cloudflare 资源配置（wrangler.toml）

```toml
name = "cfnote"
main = "worker/index.ts"
compatibility_date = "2024-12-01"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]

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

1. **开发阶段 schema 约定**：只做增量幂等（加列/建表），不写数据迁移；不兼容变更时提示线上清空重初始化（见 §5）。
2. **内容哈希去重**：仅内容实际变化才重新向量化，避免重复消耗 neurons。
3. **搜索模式分离**：默认混合搜索仅消耗嵌入 neurons；AI 问答用户主动触发才消耗 LLM。
4. **附件私密性**：能力 URL + 访问分级 + 私密文件夹一票否决；取消公开后新访客约 5 分钟内失效（已看过的浏览器缓存不可收回，属预期不可逆）。
5. **删除语义**：单篇删除进回收站（软删除，30 天可恢复）；删除整本笔记本因 `ON DELETE CASCADE` 外键仍为彻底删除（弹窗注明）。
6. **版本历史保留**：内容变更保存时快照提交版本；「同小时合并」在 SQL 侧判定（每篇每小时至多一版），保留策略（最近若干版全留 + 更早每自然日一版 + 硬上限）由 `src/lib/versionRetention.ts` 纯函数算出待删 id，控制 D1 占用；文章硬删除时版本随 `ON DELETE CASCADE` 清除。
7. **提醒推送渠道**：Telegram / 企业微信 / 飞书 / 钉钉 / Server酱 / 自定义 Webhook 统一为「一个 URL + 一段 JSON」，纯逻辑（类型/字段/请求构造）在 `src/lib/notifyChannels.ts`（前端表单与单测复用），实际 fetch 与钉钉/飞书 HMAC 加签在 `worker/routes/notify.ts`。配置以 JSON 存 `settings.notify_channels`（含 token/webhook，**不导出**）；`*/5` cron 扫 `datetime(remind_at) <= now AND reminded_at IS NULL` 的笔记逐条推送后置 `reminded_at` 防重发，`scheduled` 按 `event.cron` 分支（高频跑提醒、月度跑归档/清理）。
8. **安全基线**：密码 PBKDF2 + 随机盐；`JWT_SECRET` 存 Secret 不硬编码；除免登录项外所有 API 经中间件验证 JWT；导出文件排除 `*_api_key`、`notify_channels` 等敏感项。
9. **Workers CPU 限制**：AI/DB 调用为 I/O 等待不计 CPU；实际 CPU 操作（JSON/字符串处理）远低于限额。
