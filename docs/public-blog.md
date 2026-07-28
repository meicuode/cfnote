# P7 公开博客与笔记公开/私有体系

**状态(2026-07-24)**:✅ 全部完成。同日修订:博客亮/暗双主题、详情页回到顶部、浏览计数去重、确认弹窗按钮文案修复(见文末「修订」)。

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
- 评论(P11.2):公开文章底部访客评论,昵称必填、邮箱可选(不公开),正文**纯文本渲染**(不解析 markdown/HTML,杜绝 XSS);默认需审核(设置可切免审核),2 层嵌套回复(更深回复归并同楼)+ 博主回复(带标识);轻量防刷(Cache API 每 IP 每分钟 1 条 + 蜜罐隐藏字段 + 长度上限,fork 者零配置);后端 `comments` 表 + 公开 `GET/POST /api/blog/comments`(POST 在中间件单独放行)+ 鉴权 `/api/comments/*` 审核;私密分享页不显示评论;有待审评论时复用通知渠道推送管理员。管理入口在「博客管理 → 评论管理」二级菜单。
- 待审评论就地显示(P11.7,参考 WordPress):`GET /api/blog/comments` 只返回已通过的评论,所以访客提交后**自己那条**另存 `localStorage`(键 `cfnote-pending-cmt-<articleId>`,类比 WordPress 用 `comment_author` cookie 记住作者),渲染时并入线程但整行降调 + 「待审核」徽标、无「回复」按钮、不计入总数——避免"提交后内容当场消失像丢了"。POST 因此额外回传 `{id, parent_id, root_id, created_at}`(仅加字段,无 schema 改动)。清理规则:id 出现在服务端已批准线程里(博主已通过)或超过 7 天(多半被拒)即丢弃。合并/清理是 `src/lib/pendingComments.ts` 的纯函数,不碰 localStorage 本身(读写留给组件),便于单测。
- 评论锚点(P11.7):评论行带 `id="comment-<id>"` + `scroll-mt-24`,`/blog/:id#comment-<id>` 打开后平滑滚到该楼并套既有 `.cfnote-highlight` 动画(与全文搜索定位复用同一套 6s 淡出效果)。评论管理的「查看↗」据此生成链接;待审评论在博客页尚不存在锚点,按钮加 title 说明但不禁用(点开仍能到文章)。
- 头像占位(P11.7):**不接 Gravatar**——需把访客邮箱哈希发给第三方,而公开评论接口本就不返回邮箱(邮箱只在管理端可见),国内访问 gravatar 也不稳。改为 `commentAvatar(name)`:昵称首字(按码点切分,兼容 emoji 昵称;空昵称回退 `?`)+ 按昵称哈希从 12 色中性调色板取色,同一昵称永远同色。零请求、明暗主题通用;博主固定用主题色(博客页 `#d43030`,管理端 emerald)。
- 章节目录(P11.8):详情页左侧浮层,**默认收起**、点按钮展开,状态记 `localStorage['cfnote-blog-toc']`。位置不占布局——右栏(热榜)是 `hidden xl:block` 只有 ≥1280px 才在,目录挂那儿等于窄屏读者全看不到;正文容器又是 `max-w-[1400px] mx-auto`,容器内左侧并无空位(看到的留白是容器外的)。故用 `left-[max(0.75rem,calc((100vw-1400px)/2-15rem))]`:视口 ≥1880px 时整个浮层落在留白里不遮正文、可以一直开着,再窄就贴边并按抽屉处理(遮罩点击关闭、点章节跳完即关,这种临时收起不写 localStorage)。**≥3 个标题才出现**(`MIN_TOC_HEADINGS`)——短文挂目录纯属噪音。正文渲染后扫 h1~h3 打稳定 id(`slugifyHeading`,中文原样保留所以 `/blog/12#部署步骤` 可读,重名自动 `-2`),点章节走 `replaceState` 更新地址栏(可复制分享到某一节)但不往历史里塞条目,并复用 `.cfnote-highlight` 短暂高亮。写 id 是属性变更,不会触发详情页那个只观察 `childList/subtree` 的 MutationObserver,无循环。
- 博客页与应用共用 SPA 入口(主包 112KB gzip),BlogPage 增量 3KB;个人博客流量下不单独拆入口。
- 评论来源(P11.9):管理端列表显示提交时的**明文 IP 与原始 UA**(`comments.ip` / `comments.user_agent`,幂等加列不用清库;UA 截断 300 字符;老评论为空则整行不显示)。原先只存 `ip_hash = SHA-1(ip)` 且**无盐**——IPv4 空间仅 43 亿,建彩虹表几秒即可还原,那点保护是自我安慰,既没有明文的实用性也没有哈希该有的保护性,故 P11.9 起不再写入(列保留,SQLite 删列要重建表,违反「只做增量幂等」的约定)。要真隐私就得加盐哈希,但那样没法按 IP 段封禁/查归属,对个人博客反垃圾不划算;WordPress 默认也是明文存 `comment_author_IP`。**公开接口永远不返回这两列**(`GET /api/blog/comments` 只出 `id/parent_id/root_id/author_name/content/is_admin/created_at`,与邮箱同等对待);限流走 Cache API,与这两列无关。
- 模块化布局(P12.1 骨架,P12.2 补全):列表页与详情页各自把模块放进「顶部 / 左侧栏 / 右侧栏 / 底部」四个槽位,配置存 `settings.blog_layout`(JSON 字符串,零 schema 改动),**随 `GET /api/blog/posts`(响应改为 `{ posts, layout }`)与 `/posts/:id`、`/share/:token` 一起下发**——不单开端点,布局晚到会让首屏模块位置跳动。默认配置刻意等于改造前的样子,不配置则页面零变化。`parseBlogLayout` 对坏 JSON/未知类型一律回落默认:展示层配置不该有能力让博客页打不开。侧栏 `sticky top-20` + 限高内部滚动,宽度各自可调(200–420px),只在该侧有启用模块时才占位;配置页实时提示正文剩余宽度(`contentWidth`),低于 700px 警告。窄屏(<1280px)侧栏模块按配置并到顶部/底部或隐藏,用**两份渲染 + CSS 断点**实现而非 JS 判断视口(否则首屏会先按错误分支渲染再跳)。模块类型:热榜、关于本站、自定义 Markdown、最新文章、标签云、友情链接——后三种全部复用已有数据(`posts`)或纯配置,不新增端点。友情链接的 URL **只放行 `http(s)://` 与站内 `/` 开头的路径**。
- 正文 HTML 必须 `useMemo`(P11.8.1 血的教训):React 对 `dangerouslySetInnerHTML` 是**按引用**比较 prop 的,每次渲染新建 `{ __html }` 就会重设整段 innerHTML——任何一次重渲染(主题切换、热榜/评论到达、滚动、开合目录)都把正文节点整体换掉。表现是打在标题上的锚点 id 消失(目录点了不跳)、代码高亮时有时无。缓存住引用后正文节点全程稳定;`enhanceRendered` 的 MutationObserver 仍保留(mermaid 会异步替换 `pre`),但不再是遮丑用的。
- 深色样式:根节点挂 `dark cfnote-blog`,正文复用 `.cfnote-preview` 的集中深色映射,博客专属覆盖(红色链接/引用条)追加在映射之后按顺序生效。
- Tags 显示的是所属笔记本名(笔记暂无独立标签系统;若要真标签需加表+编辑器打标 UI,列为备选需求)。
- 浏览计数存 D1 `articles.views` 而非 Cloudflare 统计产品:Workers Analytics Engine 数据只保留 90 天且查询要走账号级 SQL API(需另存 API Token、每次页面渲染多一跳 HTTP),Web Analytics 免费版只有仪表盘无逐页 API——都无法在页面上展示"累计浏览 N"。D1 免费档每天 10 万行写入,个人博客量级下每次详情 1 行写入毫无压力,再配 Cache API 去重进一步省写。

## 修订(2026-07-24 下午)

- **亮/暗双主题**:默认跟随系统 `prefers-color-scheme`(未手动选择时监听系统实时切换),导航栏日/月按钮手动切换并持久化 `localStorage['cfnote:blog-theme']`(src/lib/blogTheme.ts,含解析优先级单测)。顶栏与页脚固定黑色 chrome(IT之家日间模式同为深色顶栏),内容区配色集中为 index.css 的 `--blog-*` 变量两套取值,深色时根元素额外挂 `dark`。App.tsx 的懒加载 fallback 底色同步主题,避免首屏闪色。顺带修复:深色下导航文字曾被应用层 `.dark .text-gray-300` 集中映射改暗,现导航/页脚全部用固定色值。
- **详情页回到顶部**:滚过 480px 右下角淡入圆形按钮(透明度+位移 300ms 过渡),平滑滚动到顶,悬浮转主题红,配色走 `--blog-*` 变量与两主题一致。
- **浏览计数去重**:详情接口先查 `caches.default` 标记(键=SHA-1(IP)+文章 id,`max-age=3600`)——同一 IP 一小时内重复访问不再写 D1,防刷新灌水;未命中才 `waitUntil` 执行 `views+1`。Cache API 免费零配额,但按数据中心(colo)独立生效,且 workers.dev 域名/本地 dev 下不可用——这些场景自动退化为每次计数(即原行为)。
- **确认弹窗**:ConfirmDialog 的确认按钮文案默认「删除」,私有/公开三个弹窗此前未传 `confirmText` 导致按钮误显示「删除」;现分别为「设为私有」(琥珀)/「取消私有」(绿)/「取消公开」(红),并给组件增加 `variant` 配色参数(图标与按钮同步变色),删除类调用不受影响。
