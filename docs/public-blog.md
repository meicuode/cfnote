# P7 公开博客与笔记公开/私有体系

**状态(2026-07-24)**:✅ 全部完成。

**背景**:笔记本中的部分笔记希望对外分享。新增一个与 IT之家新闻页同布局同配色的深色博客页(列表/详情/热榜),文章来源为笔记本中标记「公开」的笔记。因个人笔记常存放账号密码等敏感信息,公开动作必须先经全文敏感信息检查;同时引入「私有」类型作为反向保险。

## 数据模型与迁移

`articles` 新增列:`is_public`(默认 0)、`is_private`(默认 0,与 is_public 互斥,服务端保证)、`published_at`(每次公开动作刷新)、`views`(博客浏览计数)。

**应用内幂等迁移**(worker/migrate.ts):线上已有真实数据,不能重建表。每个 isolate 的首个 `/api/*` 请求做一次 `PRAGMA table_info(articles)`,缺哪列 `ALTER TABLE ADD COLUMN` 补哪列,之后 memoize 零开销;失败(表未初始化)下次请求重试。全新部署走 `/api/init` 的 CREATE TABLE(已含新列)。

## 接口

- 认证接口:`PUT /api/articles/:id` 接受 `is_public`/`is_private`。规则:设私有强制取消公开;公开要求非私有(否则 400);每次公开刷新 `published_at`。`GET /api/articles/private` 返回全部私有笔记(「我的私有」虚拟笔记本)。
- 公开只读接口(免登录,worker/index.ts auth skip,仅暴露 `is_public=1 AND is_private=0`):
  - `GET /api/blog/posts` 列表:标题、纯文本摘要(mdExcerpt 剥语法)、首图缩略图(mdFirstImage,跳过代码块)、笔记本名作 Tags、发布时间
  - `GET /api/blog/posts/:id` 详情(浏览计数 +1,waitUntil 异步)
  - `GET /api/blog/hot?range=day|week|month` 热榜:时间窗内发布的文章按累计浏览量排序(未记录浏览时间明细,窗口按发布时间)

## 前端

- **编辑器**(ArticleEditor 顶栏):预览按钮右侧「公开」按钮(私有笔记与未落库草稿不显示)。点击先对标题+正文跑 `scanSensitive`:有风险 → 弹窗列出全部风险项(类型标签/打码摘录/行号),需明确点「我已逐条确认,仍要公开」(红色);无风险 → 普通确认。公开时连同当前编辑内容一并保存。已公开态显示绿色「已公开」(点击取消公开)+「在博客中查看」外链。
- **私有**:字数左侧,非私有显示「设为私有」按钮(确认弹窗),私有显示琥珀色 eye-off 标识+「私有」(点击可取消私有——规格未提,补充为可逆操作)。列表中私有笔记标题前显示 eye-off 眼睛图标。
- **我的私有**:笔记本列表末尾固定虚拟笔记本(id=-1,琥珀色),点击跨笔记本筛选全部私有笔记;该视图不提供新建/导入。
- **博客页**(/blog,免登录,懒加载 chunk):IT之家深色风格——黑色顶栏(CF 红色方块 logo)、列表(左缩略图/无图占位、标题白粗、两行灰摘要、Tags: 笔记本名、右侧红色时间「今日 9:12」)、右侧栏日/周/月榜卡片(前三红色序号徽标)+关于本站;详情页(面包屑/大标题/灰色元信息行/正文直铺深色底/「· 完 ·」/评论区样式壳「暂未开放评论」)、底部黑色页脚。`/blog/:id` pushState 路由,SPA 回退由 Static Assets `single-page-application` 承载。

## 敏感信息扫描(src/lib/sensitiveScan.ts)

类别:手机号、身份证号(出生段合理性校验)、银行卡号(Luhn 校验)、邮箱、私钥块(BEGIN PRIVATE KEY)、AWS AccessKey、sk- 系 API Key、GitHub Token、Google API Key、Slack Token、JWT、通用密钥赋值(key/secret/token/密钥 后跟值)、密码赋值(密码/password 后跟显式分隔)。命中项含中文标签、行号、打码摘录;同行区间去重(身份证不重复报银行卡);误报防护有单测(日期/订单号/快递单号/附件随机段/叙述文字)。

## 决策记录

- 热榜以「时间窗内发布 × 累计浏览量」近似(不建浏览明细表,免费额度友好)。
- 评论区只保留版式(黑色提示条),不做访客评论后端。
- 博客页与应用共用 SPA 入口(主包 112KB gzip),BlogPage 增量 3KB;个人博客流量下不单独拆入口。
- 深色样式:根节点挂 `dark cfnote-blog`,正文复用 `.cfnote-preview` 的集中深色映射,博客专属覆盖(红色链接/引用条)追加在映射之后按顺序生效。
