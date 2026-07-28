# P8 规划:附件公开治理 + Evernote 功能对标

**状态(2026-07-24)**:P8 附件体系四期 ✅(见 [file-manager.md](file-manager.md));P9 首批(回收站/标签/置顶,下表 #2/3/4)✅,实现要点:

- **回收站**:`articles.deleted_at` 软删除;删除即清向量/分块并取消公开与置顶(搜索、AI、博客立即不可见),附件引用行保留防误清;侧栏「回收站」虚拟视图支持恢复(重建向量)/彻底删除/清空;30 天自动清理(打开回收站懒执行 + cron 兜底);回收站笔记打开为只读(横幅提示)。**注意:删除整本笔记本仍是彻底删除不进回收站**(articles 对 notebooks 有 ON DELETE CASCADE 外键,改约束需重建表,弹窗文案已注明)。
- **标签**:`articles.tags` JSON 数组列 + SQLite `json_each` 聚合/筛选(单用户量级不建 tags/article_tags 两表,无孤儿行无同步问题);编辑器标题下 chips 输入(Enter/逗号添加,datalist 补全已有标签,上限 20 个);侧栏标签区带计数,点击进标签虚拟视图;列表项显示前 3 个标签;导出/导入保留。博客页展示标签暂缓(后续顺势补)。
- **置顶**:`articles.pinned` 列;列表悬浮 📌 切换,置顶排最前(各视图统一 `pinned DESC, updated_at DESC`)。

**P9.2(2026-07-24)✅**:下表 #6/7 + 博客标签展示。

- **任务勾选**:GFM `- [ ]` 在预览模式中可直接点击勾选,按渲染顺序回写源文对应标记(`toggleTaskItem`,跳过代码围栏防索引错位),走 3s 自动保存;博客侧保持只读。富文本模式暂按普通文本处理(引入 TaskList 扩展有序列化往返风险,后评估)。
- **笔记间链接+反向链接**:两模式工具栏「插入笔记链接」按钮 → 标题搜索对话框(NoteLinkDialog 懒加载共享 chunk),插入标准 MD 链接 `[标题](/?article=<id>)`(复用深链,新窗口/应用内都可打开);预览中点击此类链接应用内直接切换(复用 AI 引用定位通道);`GET /articles/:id/backlinks` 用 `instr(content, '?article=<id>)')` 反查(右括号一并匹配避免 12 命中 123),编辑器顶部显示反向链接条,点击可跳转。
- **博客标签**:列表卡片与详情页 Tags 行显示 笔记本名+真标签。

**P9.3(2026-07-24)✅**:下表 #8/9。

- **笔记私密分享链接**:`articles.share_token/share_expires_at` 两列(与文件分享同构,单分享,重新生成即替换,七档有效期复用 `EXPIRY_PRESETS`);编辑器顶栏「🔗 分享」按钮开弹窗(生成即复制,显示剩余有效期/取消);公开路由 `/blog/share/<token>` 复用博客详情渲染(面包屑标「私密分享」),不入列表/热榜、不计浏览量,过期 410;私有笔记禁分享,设为私有/移入回收站自动撤销;附件放行规则扩展:被「有未过期分享的非私有笔记」引用的附件对访客可见(索引判定,私密文件夹一票否决仍然优先)。
- **笔记模板**:约定名为「模板」的笔记本;新建笔记时若其中有内容,先弹「空白笔记/套用模板」选择,套用即以模板的标题/正文/标签开草稿(本地草稿,首次输入才落库);在「模板」笔记本内新建不弹(直接写模板)。
- 网页剪藏(#5)为 P9 剩余项,单独排期。

**P9.4(2026-07-24)✅**:下表 #5 网页剪藏,P9 全部完成。

- **网页剪藏**:侧栏「网页剪藏」入口打开 `/clip` 安装引导页(独立懒加载 chunk 3.1KB gzip);bookmarklet 拖入书签栏,在任意网页点击即抓取**选区(优先)或正文**(`article`/`main`/`body`,上限 800KB)→ `window.open` 打开 `/clip` → 轮询 postMessage 传输(收到 ack 停止;跨域无法探测子窗口就绪,轮询是唯一可靠方式);接收页做相对链接绝对化(含懒加载图 data-src 还原、剔除 script/style/iframe)→ turndown 转标准 Markdown 并附「剪藏自」来源行 → 可编辑标题/正文、选笔记本后 POST /api/articles 保存(走既有向量化管线),保存后可直接深链打开笔记。未登录提示先去主应用登录(token 同源共享)。CSP 严格站点(如 GitHub)会拦截书签脚本,引导页已注明改用复制粘贴。零后端改动。

**P10.1(2026-07-25)✅**:下表 #10 版本历史。

- **版本历史**:`article_versions` 表(article_id/user_id/title/content/tags/created_at,`ON DELETE CASCADE` 随文章硬删除清除;system.ts SCHEMA + migrate.ts 幂等建表,纯增量无需清库)。PUT 保存且内容变更时快照当前提交版本——**同小时合并**在 SQL 侧判定(`strftime('%Y-%m-%d %H')` 匹配则原地覆盖,每篇每小时至多一版,压住自动保存churn);新插一版后按保留策略裁剪:`versionsToPrune` 纯函数(`src/lib/versionRetention.ts`,worker 复用)算出待删 id——最近 24 版全留、更早每自然日只留最新一版、总量硬上限 60。`GET /:id/versions`(仅元信息+字数)、`GET /:id/versions/:vid`(全文)。编辑器顶栏「历史」按钮开对话框(懒加载 2.13KB gzip):左列版本时间/标题/字数,右侧全文预览,「恢复此版本」二次确认后把该版作为当前工作副本落库(既有保存链路会再快照,可反复回退)。回收站只读态不显示入口。版本不入导出(本地安全网,非主数据)。

**P10.2(2026-07-25)✅**:下表 #12 提醒(应用内面板)。

- **提醒**:`articles.remind_at` 一列(ISO UTC,NULL=无;移入回收站的 UPDATE 一并置空)。`PUT /:id/reminder`(body `{remind_at: ISO|null}`,服务端 `new Date().toISOString()` 归一,回收站拒设)、`GET /articles/reminders`(设了提醒且未删除的笔记,LEFT JOIN 笔记本名,按 remind_at 升序)。纯逻辑抽 `src/lib/reminders.ts`(`isDue`/`formatRemindTime`/`splitReminders`,now 传入毫秒便于测试与避免隐藏时钟依赖,补 Z 处理无时区时间)。编辑器顶栏「提醒」按钮开设置弹窗(今晚 20:00/明天 09:00/下周 09:00 预设 + datetime-local 自定义 + 清除;remindOverride 本地覆盖,切换文章重置);Layout 顶栏铃铛按到期数显红色徽标,面板按「已到期/即将到期」分组,点击行打开笔记、「完成」清除提醒。铃铛列表每 60s 轮询 + 设置后即时刷新(编辑器经 onRemindersChanged 通知)。远期若接入 Email(#11)可加邮件推送,当前为纯应用内。

**P10.3(2026-07-25)✅**:下表 #12 提醒的推送渠道扩展(超出 Evernote 单一提醒)。

- **多渠道提醒推送**:通知渠道抽象——Telegram / 企业微信 / 飞书 / 钉钉 / Server酱(个人微信)/ 自定义 Webhook 统一为「一个 URL + 一段 JSON」,纯逻辑(类型/字段描述/请求构造)在 `src/lib/notifyChannels.ts`(前端表单与单测复用),fetch 与钉钉/飞书 HMAC-SHA256 加签在 `worker/routes/notify.ts`。配置以 JSON 存 `settings.notify_channels`(含 token/webhook,导出时排除)。新增 `articles.reminded_at` 列(纯增量)防重发。cron 加 `*/5 * * * *`(唯一一处 wrangler.toml 改动,forker 仍不用碰),`scheduled` 按 `event.cron` 分支:高频那条跑 `sendDueReminders`(扫 `datetime(remind_at)<=now AND reminded_at IS NULL AND deleted_at IS NULL` 逐条推送到所有启用渠道,含标题+深链,发送后置 `reminded_at`;失败写系统日志仍标记防刷屏),月度那条照旧归档/清理。`PUT /:id/reminder` 设置时清 `reminded_at` 重新武装。`POST /api/notify/test` 用面板当前配置发测试消息。SettingsPanel 加「通知渠道」区:渠道卡片(启用开关+按类型字段+测试/删除)、虚线按钮添加、保存写 `notify_channels` 并自动存 `site_url`(取 `window.location.origin` 用于深链)。QQ 因官方机器人需审核/或自建常驻 bridge、不契合 Workers 无状态,不做一等公民(可走自定义 webhook 接第三方)。**各渠道逐步配置见 [notifications.md](notifications.md)。**

**P10.4(2026-07-25)✅**:侧栏标签区重构(标签多时不再杂乱)。

- **标签区紧凑化 + 浏览器**:原来一标签一整行平铺、夹在笔记本与固定入口之间,标签多了撑长侧栏并把回收站/文件管理挤下去。改为:标签区可折叠(状态存 localStorage);内容按**使用频次降序**显示常用前 10 个为自动换行的紧凑 chips(`#名 计数`);超过 10 个时「全部标签(N)›」按钮打开可搜索浏览器 `TagBrowserDialog`(搜索框实时过滤 + 频次排序全部标签,点击进入该标签视图)。纵向占用有界,固定入口不再被挤走。纯前端,无 schema/后端改动。

**P10.5(2026-07-25)✅**:补齐技术笔记渲染——代码高亮 + 数学公式。

- **代码高亮 + 数学公式(KaTeX)**:渲染面(预览 + 博客)增强,源码/富文本编辑器不动(避免 Tiptap 序列化往返风险)。`src/lib/markdown.ts` 加 marked 扩展把 `$…$`(行内)/`$$…$$`(块级)**切为占位元素**(`.cfnote-math[data-math]`,不解析内部 markdown、避开 `$5 与 $10` 价格误判、下标不被当强调),GitHub/Pandoc 通行写法非私有方言。`src/lib/renderEnhance.ts` 的 `enhanceRendered(root)` 在渲染后**懒加载** highlight.js/lib/common 高亮 `pre code`、懒加载 KaTeX+CSS 渲染占位公式(打 `data-hl`/`data-rendered` 幂等,MutationObserver 反复触发不重复处理);无代码/无公式的页面完全不拉这两个库。ArticleEditor 预览 upgrade 与 BlogPage 详情各挂一次。代码块明暗主题下均深底,统一 GitHub Dark 配色写进 index.css。产物:highlight.js 懒 chunk ~54KB gzip、KaTeX ~77.6KB gzip + CSS 8KB gzip,主包仅 +0.5KB。

**P10.6(2026-07-26)✅**:主应用 URL 路由(刷新/前进后退恢复视图)。

- **URL 路由**:此前主应用是单棵组件树、视图全在 `Layout.tsx` 内存 state,刷新丢失文件管理/设置/统计等模块(仅 localStorage 恢复上次笔记本+文章),且无法把某篇笔记作为链接分享。改为把「当前笔记本/虚拟视图 + 打开的文章 + 主模块面板」编进 URL,刷新与浏览器前进/后退按 URL 恢复。纯逻辑抽 `src/lib/route.ts`(`parseLocation`/`buildLocation`/`isEmptyRoute`,前端与单测复用):路径 `/nb/:id[/:articleId]`、`/private`、`/trash`、`/tag/:name`(各可带文章),query `?panel=files|settings|stats|logs` 叠加主模块面板;兼容既有 `/?article=<id>` 深链(消费后规范化为 `/nb/:nbId/:id`)。`Layout.tsx` 双向同步:`URL→视图` 在首次笔记本加载后及 `popstate` 套用;`视图→URL` 20ms 去抖把「选笔记本→清空文章」等级联并为一次 `pushState`,**幂等等值比较 + applyingRef 抑制**防环(状态落位后自动释放,2s 兜底)。AI 对话折叠状态存 localStorage 不进 URL;搜索/提醒/导入/模板等临时弹层不进 URL。手写实现(与博客页一致),不引入 `react-router`,几乎零打包增量。`wrangler.toml` 的 SPA 回退已支持任意路径深链刷新,无后端/schema 改动。


**P11.1(2026-07-26)✅**:博客管理(已公开文章的统一管理入口)。

- **博客管理**:此前「已公开」文章散在各笔记本里,只能靠列表项小标识辨认,无统一入口。侧栏加「博客管理」→ 懒加载全屏模块 `BlogManager.tsx`(照搬 FileManager 叠层骨架),列出本人所有 `is_public=1 AND is_private=0 AND deleted_at IS NULL` 文章,支持标题搜索 + 按笔记本过滤,每行显示笔记本/发布时间/浏览量,操作「预览↗(新标签开 /blog/:id)/ 打开(回主应用 `/nb/:nbId/:id` 编辑)/ 取消公开」。后端新增鉴权端点 `GET /api/articles/published?q=&notebook_id=`(仿 `/articles/private`);取消公开复用既有 `PUT /articles/:id {is_public:0}`。接入 P10.6 路由:`?panel=blog` 刷新保持(`route.ts` 的 `RoutePanel`/`PANELS` 加 `blog`,Layout `showBlog` 双向同步)。评论管理子视图将在 P11.2 加入。纯增量,无 schema 改动。

**P11.2(2026-07-26)✅**:访客评论(默认审核 + 2 层嵌套)。

- **评论**:公开博客文章底部支持访客评论(昵称必填、邮箱可选不公开),**默认需审核**(设置 `comments_auto_approve` 可切免审核;`comments_enabled` 总开关)。新表 `comments`(`parent_id`/`root_id` 支持 2 层嵌套——回复的回复归并到同一顶层楼;`status` pending/approved/rejected;`is_admin` 博主回复;`ip_hash` 限流溯源不存明文;system.ts + migrate.ts 双声明幂等建表,无需清库)。纯逻辑抽 `src/lib/comments.ts`(`validateCommentInput`/`resolveThreadParent` 2 层夹取/`buildThread`/蜜罐,前端与 worker 复用,+12 用例)。公开 `GET/POST /api/blog/comments`(GET 已免登录,POST 在 `worker/index.ts` 中间件按确切路径单独放行);提交防刷=**强制审核 + Cache API 每 IP 每分钟 1 条(照搬浏览量去重)+ 蜜罐隐藏字段 + 昵称/正文长度上限**,fork 者零配置。鉴权 `worker/routes/comments.ts` 管理(列表/待审计数/通过/拒绝/回复/删除,所有权经 JOIN `articles.user_id`)。**评论正文一律纯文本渲染**(React 自动转义 + `whitespace-pre-wrap`,不过 marked——仓库无 HTML 消毒库,杜绝 XSS)。`BlogPage` 替换原「暂未开放评论」占位为真实评论区(表单 + 2 层线程 + 博主标识),私密分享页(`detail.shared`)不显示。`BlogManager` 加「评论」子 tab(待审/全部过滤 + 通过/拒绝/删除/回复,待审计数徽标)。`SettingsPanel` 加评论开关两项。有待审评论且配了通知渠道→复用 `sendToChannel` 推送管理员(`notifyPendingComment`)。QQ/富文本评论/邮件回复访客暂不做。

**P11.3(2026-07-26)✅**:Mermaid 图表渲染。

- **Mermaid**:预览 + 博客把 ` ```mermaid ` 代码块渲染为流程图/时序图/甘特图等 SVG。沿用 P10.5 的「渲染后懒加载增强」路子:`src/lib/renderEnhance.ts` 加 `renderMermaid`——扫描 `pre code.language-mermaid`(打 `data-mermaid` 幂等)→ **懒加载 mermaid 整库**(仅当页面含 mermaid 块才拉取,主包不受影响)→ `mermaid.render` 产出 SVG 替换代码块;`highlightCode` 选择器排除 `.language-mermaid` 以免被当普通代码高亮糊掉;跟随明暗主题(`dark`/`default`),`securityLevel:'strict'` 兜底;语法错误保留原始代码块并清理临时节点,绝不崩整页。无需 marked 扩展(mermaid 是标准围栏代码块,marked 原生输出 `language-mermaid`)。CSS `.cfnote-mermaid` 居中 + 过宽横向滚动。ArticleEditor 预览与 BlogPage 详情各自已挂 `enhanceRendered`,自动生效。纯前端,无 schema 改动。


**P11.4(2026-07-27)✅**:博客管理改为内联模块 + 评论管理升为二级菜单。

- **内联化**:此前「博客管理」是 `fixed inset-0` 全屏弹窗遮罩(照搬 FileManager),与「文章列表/编辑器」这类常驻工作区体验割裂,且评论审核藏在模块内部的 tab 里、侧栏看不出来。改为**内联占据侧栏右侧整个工作区**(文章列表+编辑器+AI 面板整体让位),侧栏始终可见可切换,顶栏提供「返回笔记」。侧栏「博客管理」下挂**二级菜单「评论管理」**(缩进 + 独立高亮),两者是同级子视图。路由:`RoutePanel` 加 `'comments'`,`?panel=blog`(文章)/`?panel=comments`(评论)各自刷新保持;Layout 的 `showBlog` 布尔换成 `blogView: 'articles'|'comments'|null` 三态,`applyRoute`/`currentTarget` 双向映射。选中任意笔记本/标签、或从搜索/AI/博客管理里打开文章,都会自动退出博客管理回到笔记(否则内联模块会挡住编辑器)。
- **排序**:`GET /api/articles/published` 的 `ORDER BY` 从 `COALESCE(published_at, updated_at) DESC` 改为 **`updated_at DESC`**(按修改时间降序,最近改动的公开文章置顶),列表行相应显示「修改 时间」(发布时间移到 title 提示)。标题搜索与笔记本过滤保持不变。
- 纯前端 + 1 处 SQL 排序调整,无 schema 改动;`+1` 路由用例(212 全绿)。

**P11.5(2026-07-27)✅**:文件管理同样内联化。

- **文件管理内联**:与 P11.4 同一处理——`FileManager.tsx` 去掉 `fixed inset-0` 遮罩 + 居中卡片外壳,改为 `h-full flex flex-col` **内联占据侧栏右侧整个工作区**,关闭按钮由「✕」改为「返回笔记」文字按钮;侧栏「文件管理」条目在激活时高亮(`filesActive`)。**移除整个视图的 Esc 关闭监听**——内联后在搜索框里按 Esc 会误关整个工作区(各子弹窗重命名/移动/分享/预览自身的 Esc 关闭保留)。内部各类弹窗仍是 `fixed z-[80]` 叠层,不受影响。路由沿用既有 `?panel=files`,无需改动。博客管理与文件管理互斥(打开一个自动关另一个),选笔记本/标签或打开文章时都会退出回到笔记工作区。纯前端,无 schema 改动。

**P11.6(2026-07-27)✅**:文件管理左栏上移为侧栏二级菜单。

- **二级菜单**:P11.5 内联化后出现「应用侧栏 + 模块内左栏」两条并列导航,视觉重复且压缩列表宽度。现把左栏四项(`全部文件` / `未引用` / `笔记附件`·各笔记本 / `我的文件夹`·多级树含新建/改名/移动/删除与私密子树)整体上移为侧栏「文件管理」下的**二级菜单**(`FileManagerNav.tsx`),与 P11.4「评论管理挂在博客管理下」同构;**仅在进入文件管理时展开,退出即收起**——侧栏已有笔记本列表+标签区+固定入口,常驻展开会被文件夹树撑长。`FileManager.tsx` 只剩右侧列表(分类/搜索/预览/分享/上传),可用宽度变大。
- **共享数据**:侧栏导航与右侧列表是两棵独立组件树,但共用同一份 `overview` 与同一套文件夹增删改——抽 `src/hooks/useFileManager.ts` 做单一数据源(只拉一次 `/api/fm/overview`,由 Layout 在进入文件管理时触发),任一侧改动后两边一起刷新:文件夹结构变动经 `tick` 自增让右侧重拉文件,上传/删除文件经 `refresh()` 回灌 overview 更新侧栏计数;`notice/flash` 也共享,侧栏的文件夹操作提示照样显示在模块顶栏。文件夹三个弹窗随之迁入 nav(仍是 `fixed z-[80]` 叠层,不受侧栏容器裁剪)。
- **子视图进 URL**:`route.ts` 加 `fm` 参数——`?panel=files&fm=unref|nb:<id>|folder:<id>`(默认「全部文件」不写,保持 URL 干净;非法值与非 files 面板一律回落 null),刷新与前进/后退可回到同一个文件夹。视图里**不再存名字**,标题按 id 从 overview 现取,顺带修掉「文件夹改名后标题不更新」。删除当前所在文件夹自动回落「全部文件」;退出文件管理时子视图重置。
- 纯前端,无 schema 改动;+4 路由用例(216 全绿)。

**P11.7(2026-07-27)✅**:代码高亮补语言 + WordPress 式待审评论 + 评论锚点 + 博客管理内联编辑。

- **高亮补语言**:文章里的 PowerShell 代码块导致控制台 `WARN: Could not find the language 'powershell'`。根因是 `renderEnhance.ts` 用的 `highlight.js/lib/common` **只注册 36 种**语言(xml/bash/c/cpp/csharp/css/markdown/diff/ruby/go/graphql/ini/java/javascript/json/kotlin/less/lua/makefile/perl/objectivec/php/plaintext/python/r/rust/scss/shell/sql/swift/yaml/typescript/vbnet/wasm 等),而包内实际有 192 种,其余约 156 种(dockerfile/nginx/dos/http/scala/dart/elixir/haskell/groovy/matlab/latex/vim/awk/cmake/pgsql/protobuf…)都会报同样警告。**不引入完整 highlight.js**(高亮块会从 54KB gz 涨到 200KB+ gz,拖累博客访客),改为新增 `src/lib/hljsLanguages.ts`:`EXTRA_LANGS` 收录 31 个常用且不在 common 里的语言,值是 `() => import('highlight.js/lib/languages/powershell')` 这类**静态可分析的懒导入**(Vite 才能各切一个小块;模板字符串拼 node_modules 路径不可靠);`resolveLangAlias` 做别名归一(`ps`/`ps1`/`pwsh`→powershell、`docker`→dockerfile、`bat`/`cmd`→dos、`tex`→latex、`proto`→protobuf…)。`highlightCode` 先扫本次代码块用到的语言,对 `hljs.getLanguage()` 为空的按需 `import` + `registerLanguage`(模块级 `Set` 去重,同名只拉一次);**仍未注册的表外冷门语言则移除其 `language-xxx` 类**再交给自动检测——既不报警告也不至于完全无高亮。+4 用例。
- **待审评论就地显示(参考 WordPress)**:匿名提交后原本只留一行「已提交,待审核」文字,刚写的内容当场消失像丢了。现在服务端 `POST /api/blog/comments` 额外回传 `id`/`parent_id`/`root_id`/`created_at`(仅加字段,无 schema 改动),前端把这条评论**就地渲染进线程**:整行 `opacity-60` 降调 + 「待审核」徽标 + 一行说明,不显示「回复」按钮、不计入评论总数。因为 `GET /comments` 只返回已通过的,待审那条另存 `localStorage`(键 `cfnote-pending-cmt-<articleId>`,类比 WordPress 用 cookie 记住作者),**刷新后仍在**;博主通过后其 id 出现在服务端线程里即自动清掉,超过 7 天未处理(多半被拒)也清掉。合并逻辑抽 `src/lib/pendingComments.ts` 纯函数(`addPending`/`prunePending`/`collectApprovedIds`/`mergePending`,回复挂到对应楼层、父楼被删则降级为顶层不丢失),+8 用例。
- **评论锚点**:评论行外层加 `id="comment-<id>"` 与 `scroll-mt-24`;线程渲染完成后读 `location.hash`,命中则平滑滚到该楼并套**既有** `.cfnote-highlight`(6s 淡出动画,明暗两套,直接复用)。评论管理的「查看↗」相应改为 `/blog/<article_id>#comment-<id>`;待审评论在博客页尚无锚点,给按钮加 title 说明但不禁用。
- **博客管理两栏可编辑**:原「已公开文章」是只读列表,想改内容得跳回笔记工作区。改为**常驻两栏**——左列表(搜索 + 笔记本过滤,两行式行:标题 / 笔记本 · 修改时间 · 浏览量,选中 emerald 高亮,悬浮才出「预览↗ / 取消公开」,右缘可拖拽,宽度存 `cfnote-blog-list-w`),右侧点选后 `GET /api/articles/:id` 取全文并**直接复用 `ArticleEditor`**,源码/富文本/预览三模式、标签、附件、公开开关、历史、提醒全部免费获得。保存走同一个 `PUT /api/articles/:id`,但**只就地更新该行的标题/时间、不重排列表**(列表按 `updated_at` 降序,立即重排会让正在编辑的条目从脚下跳走);在编辑器里取消公开/设为私有,或点行上的「取消公开」→ 该行移出列表并清空右栏。
- **头像占位**:评论人名前加圆形头像占位——**不接 Gravatar**(要把访客邮箱哈希发给第三方,而公开评论接口本就不返回邮箱,国内访问也不稳),改为「昵称首字 + 按昵称确定性取色」的本地色块(`commentAvatar`,12 色中性调色板,首字按码点切分兼容 emoji 昵称,空昵称回退 `?`);同一昵称永远同色便于辨认,博主固定用主题色(博客页红 / 管理端绿)。博客详情页与评论管理共用同一函数。+4 用例。
- 纯前端 + 1 处接口返回值扩充,无 schema 改动;+16 用例(232 全绿)。

**P11.8(2026-07-27)✅**:博客详情页章节目录。

- **左侧浮层目录**:编辑器早有目录(`ArticleEditor.tsx` 从 Markdown 源码抽 H1–H4,≥2 条显示),博客页没有——同一篇文章作者能跳、读者反而不能。现补上,但**不占布局**:右栏(热榜)是 `hidden xl:block`,目录挂那儿窄屏读者全看不到;正文容器是 `max-w-[1400px] mx-auto`,容器内左侧也没有空位(肉眼看到的留白在容器外)。故做成 `fixed` 浮层,`left-[max(0.75rem,calc((100vw-1400px)/2-15rem))]` 自适应:视口 ≥1880px 时整个浮层落在留白里,不遮正文、可一直开着;再窄就贴边并按抽屉处理(遮罩点击关闭、点章节跳完即关)。**默认收起**,点左侧 `≡` 按钮展开,展开状态记 `localStorage['cfnote-blog-toc']`(点章节导致的临时收起不写入);**≥3 个标题才出现**——短文挂目录纯属噪音,连按钮都不该有。
- **可分享的章节锚点**:正文渲染后扫 h1~h3,用 `slugifyHeading` 生成稳定 id(中文原样保留,`/blog/12#部署步骤` 可读;英文转小写、空白转 `-`、标点丢弃;重名自动 `-2`/`-3`)。点目录走 `replaceState` 更新地址栏——可直接复制分享到某一节,但不往历史里塞一堆条目;跳转后复用既有 `.cfnote-highlight` 短暂高亮,与评论锚点同一套观感。带 `#章节` 打开页面时自动滚过去;与 P11.7 的 `#comment-<id>` 靠 id 形态区分,互不干扰。写 id 属于属性变更,不会触发详情页那个只观察 `childList/subtree` 的 MutationObserver,无循环。纯逻辑抽 `src/lib/toc.ts`(+8 用例)。
- 纯前端,无 schema 与接口改动;240 用例全绿。

**P11.8.1(2026-07-28)✅**:修目录点了不跳(顺带修掉正文被反复重建的老问题)。

- **根因**:`BlogPage` 的正文是 `dangerouslySetInnerHTML={renderMd(detail.content)}`,每次渲染都新建一个 `{ __html }` 对象;而 React 对这个 prop 是**按引用**比较的(`nextProp !== lastProp` 就重设),于是**任何一次重渲染**(主题切换、热榜/评论数据到达、滚动切换「回到顶部」、开合目录)都会把整段正文 HTML 重新解析、节点整体换掉。P11.8 打在 `h1~h3` 上的 id 就是这样被抹掉的——目录面板的数据还在(存在 state 里),但 `document.getElementById` 拿不到元素,`gotoHeading` 直接 return,所以点了毫无反应、地址栏也不变。
- 这同时是 P10.5/P11.x「博客页高亮时有时无」的**真正原因**:当初用 MutationObserver 兜底重跑增强,治的是症状(节点被换掉后重新增强),没治因。
- **改法**:正文 HTML 改用 `useMemo` 按 `detail` 缓存,引用稳定 → React 不再重设 innerHTML,正文节点在整个阅读过程中保持同一份。顺带把「扫标题打 id」并进原来那个 MutationObserver(mermaid 会异步把 `pre` 换成 SVG,标题扫描本就需要可重跑):id 相同则不重写、列表未变则不 `setState`,不会循环。副作用是每次重渲染不再重新解析整篇文章的 HTML,长文滚动明显更省。
- 顺手修:目录展开时的遮罩是 `fixed inset-0 z-20`,与 `sticky top-0 z-20` 的顶栏同级且在 DOM 里更靠后,会盖住顶栏导致主题切换/「进入笔记本」点不动;改为 `top-14` 让开顶栏。
- 纯前端,无 schema 与接口改动;240 用例全绿。

**P11.9(2026-07-28)✅**:评论管理显示来源 IP 与 UA。

- **动机**:审核时只看到昵称和正文,判断不了「是不是同一个人换个昵称又来刷」。
- **为什么直接存明文**:原先只有 `ip_hash = SHA-1(ip)` 且**无盐**——IPv4 空间仅 43 亿,建彩虹表几秒即可还原,所谓「只存哈希更安全」在 IPv4 上基本是自我安慰。维持现状是最差的一档:既没有明文的实用性(不能按段封禁、不能查归属),也没有哈希该有的保护性。要真隐私就得加盐哈希,但那样连「这是哪个网段」都看不到,对个人博客反垃圾不划算。参照 WordPress 默认也是明文存 `comment_author_IP`。故 P11.9 起写明文 `ip` 与原始 `user_agent`(截断 300 字符,防超长 UA 撑大行),`ip_hash` 不再写入——列保留不动,SQLite 删列要重建表,违反「只做增量幂等」的约定。
- **可见范围**:只有鉴权的 `GET /api/comments` 返回这两列,**公开的 `GET /api/blog/comments` 永远不返回**(与邮箱同等对待,只出 `id/parent_id/root_id/author_name/content/is_admin/created_at`)。博主自己的回复不带来源(从管理端发的)。评论管理列表在原有「于《标题》· 邮箱」下面多一行小字:等宽 IP + 可省略的 UA(`title` 给全文)。
- **不做**:不引 ua-parser-js 解析成「Chrome / Windows」(十几 kB 只为管理端用,不值),不查 IP 归属地库,原样展示。限流仍走 Cache API,与这两列无关。
- schema 走 `ALTER TABLE ADD COLUMN` 幂等迁移(`migrate.ts` 在评论表建出之后补列),**不需要清库**;老评论这两列为空,该行整行不显示。240 用例全绿。

**P12.1(2026-07-28)✅**:博客页面模块化布局(骨架批)+ 右栏 sticky。

- **右栏固定**:此前 `<aside>` 只是右列里的普通块,跟着页面滚,长文读几屏后右侧就是一片空白。改为 `sticky top-20`(让开 h-14 的 sticky 顶栏,与左侧目录浮层对齐)+ `max-h-[calc(100vh-6rem)] overflow-y-auto`(热榜 12 条 + 关于本站在小笔记本屏上会比视口高)。父容器本就是 `flex items-start`,这是 sticky 在 flex 里生效的前提,不用动。列表页与详情页共用同一个 `<aside>`,一处改动两边生效。
- **模块化槽位**:仿 WordPress 小工具,列表页与详情页**各一套**配置,模块摆进「顶部 / 右侧栏 / 底部」三个槽位。配置存 `settings` 表的 `blog_layout` 键(一个 JSON 字符串)——**零 schema 改动**,复用既有的 `GET/PUT /api/settings`。
- **随内容接口下发,不单开端点**:布局决定页面骨架,晚到会让首屏模块位置跳动。故 `GET /api/blog/posts` 响应由裸数组改为 `{ posts, layout }`,`/posts/:id` 与 `/share/:token` 各加 `layout` 字段。前端先用默认布局渲染(默认即改造前的样子),拿到配置再覆盖,正常情况下无闪动。
- **容错优先**:`src/lib/blogLayout.ts` 的 `parseBlogLayout` 对空值/坏 JSON/未知模块类型/槽位不是数组/options 含非字符串**一律回落或丢弃**——布局是展示层配置,任何情况下都不该让博客页打不开。默认布局刻意等于 P12.1 之前的样子(列表页右栏「热榜 + 关于本站」,详情页右栏只有热榜),所以不配置则页面零变化。+16 用例。
- **配置界面**:「博客管理 → 页面布局」二级菜单(`?panel=layout`,`RoutePanel` 加 `'layout'`,Layout 的 `blogView` 由三态扩为四态)。列表页/详情页两个 tab,三槽位并排;每个模块可上/下移、跨槽位移动、停用(保留配置)、删除、改标题;「关于本站」可改正文。有未保存改动时保存按钮才可点,另有「恢复默认」。
- **左侧栏留到 P12.2**:容器是 `max-w-[1400px]`,右栏 380px 时正文已只剩约 950px,再切一列左栏正文会压到 ~560px,代码块和表格会没法看。得先做「侧栏宽度可配 + 左右同开时提示正文剩余宽度 + 窄屏侧栏降级到上/下而不是直接消失」才敢开。自定义 Markdown 模块、其余模块类型、拖拽排序同批。
- 纯前端 + 3 处接口返回值扩充,无 schema 改动;tsc 零报错,256 用例全绿(+16)。

**P12.2(2026-07-28)✅**:布局第二批——左侧栏、侧栏宽度、窄屏降级、拖拽排序、四种新模块。

- **左侧栏 + 宽度可配**:槽位由三个扩为「顶部 / 左侧栏 / 右侧栏 / 底部」。左栏之所以拖到这一批,是因为宽度问题必须先解决:容器 `max-w-[1400px]`,右栏 380px 时正文已只剩 952px,再切一列左栏会压到 ~560px。现在两侧宽度各自可调(200–420px),配置页**实时算出正文剩余宽度**并在低于 700px 时给出「偏窄,代码块和表格会难看」的警告(`contentWidth`,与 `gap-7`/`px-5` 的实际值对齐)。侧栏只在**该侧有启用模块**时才占位,否则正文自动铺满。
- **窄屏降级**:此前右栏是 `hidden xl:block`——窄屏直接消失,模块内容对手机访客等于不存在。现在每个页面可选侧栏模块在 <1280px 时「并到顶部 / 并到底部 / 不显示」(默认并到底部)。实现是**两份渲染 + CSS 断点切换**(侧栏 `hidden xl:block`,降级块 `xl:hidden`),不做 JS 视口判断——否则首屏会先按错误分支渲染再跳一下。
- **拖拽排序**:模块卡片可直接拖到别的槽位或换序,悬停槽位高亮;↑↓ 按钮与「移到槽位」按钮保留作兜底(触屏/无鼠标场景)。落点语义是「插到该行之前」,因 `moveWidget` 是先摘出再插入,同槽位且源在目标之前时下标减 1,否则视觉上会少挪一位。用原生 HTML5 drag-and-drop,不引 dnd 库。
- **四种新模块**:`markdown` 自定义内容(走 `marked`——内容由博主在管理端撰写,与文章正文同等信任,同一条渲染路径;仓库无 HTML 消毒库,故不开裸 HTML 入口)、`recent` 最新文章(复用 BlogPage 本就在挂载时拉的 `posts`,零额外请求,详情页也能用)、`tags` 标签云(从 `posts` 的笔记本名与标签客户端聚合,取前 30)、`links` 友情链接(一行一条「名称|URL」,`parseLinks` **只放行 `http(s)://` 与站内 `/` 开头的路径**,挡掉 `javascript:`/`data:`)。都不需要新端点。
- 纯前端,无 schema 与接口改动;tsc 零报错,266 用例全绿(+10)。

**P12.3(2026-07-28)✅**:列表分页 + 服务端筛选 + 标签可点 + 导航菜单 + 请求瘦身。

- **列表分页**:此前是硬 `LIMIT 100` 且完全没有分页,第 101 篇之后在列表里根本看不到(直接给 URL 仍能打开)。改为每页 20 篇 + 「加载更多」——不选页码组件(每翻一页一次往返,个人博客量级不值当),也不选无限滚动(读者永远够不到页脚)。`has_more` 靠**多取一行**判断,不做 `COUNT(*)`。首屏由读 100 行 × 2000 字符降到 20 行。
- **标签为什么原先点不动**:`tags` 模块渲染的是 `<span>` 不是按钮——因为博客页压根没有筛选机制,点了没地方去。现在标签云、列表行 Tags、详情页 Tags 与面包屑全部可点,跳 `/blog?tag=xxx`;新增 `search` 模块跳 `/blog?q=关键词`。筛选进地址栏,可复制、可后退。
- **筛选必须放服务端**:分页之后本地只有已加载的那几页,客户端过滤等于「只在前 20 篇里找」,结果是错的。`?tag=` 匹配笔记本名或 `tags` 的 JSON 子串(连引号一起匹配 `%"a"%`,否则搜 `a` 会命中 `abc`),`?q=` 匹配标题或正文;`LIKE` 的 `\ % _` 在新增的 `src/lib/blogQuery.ts` 里统一转义并配 `ESCAPE '\'`。代价是点标签多一次请求,但那是用户主动操作、不占首屏。
- **导航菜单可配置**(仿 WordPress「外观 → 菜单」):项类型 `home` / `tag` / `page`(指向某篇已公开笔记,当「关于我」这类单页用)/ `link`(URL 白名单与友情链接同一把尺子)。**存在 `blog_layout.menu` 里而不是单开 settings 键**——每多一个键就是每次博客请求多一趟 D1。`menuHref()` 返回 `null` 的项直接不渲染,配置填一半不会变成死链;窄屏收进汉堡抽屉。只做一级。
- **请求瘦身,目标「一个页面一次 API 请求」**:此前列表页 2 次、详情页 4 次,其中详情页那次 `/blog/posts` 是无条件拉的,而默认详情页布局只有热榜、根本用不上那 100 行。现在 worker 按当前页布局装配数据随响应下发(`pageUsesWidget()` 决定查不查;热榜三档一次给全,切 tab 零请求;最新文章/标签云各自一次只读几列的小查询),评论区改 `IntersectionObserver` 滚到附近才拉。列表页 2 → 1,详情页 4 → 1。**依据是免费额度里请求数(10 万/天)比 D1 行读(500 万/天)紧张得多**——宁可多几次只读几行的小查询,也不要多一次 HTTP 往返。
- 前端 + worker 接口扩充(纯新增参数与返回字段),无 schema 改动;tsc 零报错,292 用例全绿(+26)。

**P12.4(2026-07-28)✅**:五个顶部/底部模块 + iframe 真预览 + 主色变量化。

- **真预览:我上一轮判断错了**。原本打算画一份「仿真画布」,理由是 iframe 要传未保存的布局、且会多打请求。两条都站不住:postMessage 传布局约 15 行,而 iframe 只在打开面板时加载一次(之后编辑不重载、零请求)。更要命的是画布要为每种模块各画一个缩略形态,加一个模块就得补一份,早晚走样——iframe 不可能不同步,它就是那个页面。WordPress 的自定义器(外观 → 自定义)本来就是真 iframe 预览,是我把它和「外观 → 小工具」那个纯列表页搞混了。
- **预览的两个关键细节**:① **按真实宽度渲染再整体缩放**——管理端那块区域通常不到 900px,若 iframe 就按这个宽度渲染,里面的 `xl:`(1280px)会一直判为窄屏,预览永远是降级后的样子;故固定 1400/1000px 再 `transform: scale()`,「窄屏」按钮触发的是真的 CSS 断点。② `?preview=1` 让 worker 跳过浏览计数,否则调一次布局就给自己刷一次量。点预览里的模块回传 id 让左侧选中它;拖拽仍留在左面板(HTML5 拖拽跨 iframe 文档不可靠,自定义器也是这么分工的)。
- **五个新模块**(对标 WordPress 主题的 header/footer 组件):`slider` 幻灯片、`banner` 站点横幅、`prevnext` 上一篇/下一篇、`related` 相关文章、`postgrid` 文章宫格。数据一律由 worker 按布局装配,**不新增端点、请求数不变**。公告条并进横幅(勾「可关闭」+ 矮高度即是),不为此单列模块。
- **幻灯片是唯一有真实成本的**:DOM 里的 lazy 图会被浏览器判为「接近视口」提前全拉,所以**只渲染当前 ±1 张**,首图 eager 其余 lazy,默认 5 张。宫格与相关文章都在页面底部,lazy 天然生效。
- **不硬性禁止跨槽位**:宽度都是自适应的,硬禁反而让人困惑(WordPress 也只是给主题划出小工具区),只在添加菜单里分「常用/其他」。但「上一篇/下一篇」「相关文章」要有当前文章才成立,列表页与私密分享页直接不渲染。
- **主色变量化**:`#d43030`/`#e05252` 原先硬编码三十多处,配色主题无从下手,现收进 `--blog-accent` 等变量。纯机械替换、零行为变化,是 P12.5「配色主题」的前置。
- 前端为主 + worker 按布局多几份小查询,无 schema 与端点改动;tsc 零报错,303 用例全绿(+11)。

## 一、附件与「公开」的关系(现状盘点)

附件模型(worker/routes/files.ts):

- R2 key 形如 `u{用户id}/{32位随机段}/{文件名}`,上传后以 `/api/files/<key>` 写入 Markdown。
- `GET/HEAD /api/files/*` **免登录**(worker/index.ts 的 auth skip)——这是 `<img>` 标签能直接引用的前提(img 请求带不上 Authorization 头);私密性完全依赖 key 中 128 位随机段不可枚举(能力 URL 模型)。
- 响应 `Cache-Control: immutable, max-age=1年` 强缓存。
- 文章与附件**无表级关联**,靠内容中出现的 URL 关联(`extractFileKeys` 正则);删除文章时据此清理 R2。

因此,**文章公开 = 其附件事实上跟着公开**:附件 URL 直接出现在博客页 HTML 里(正文图片、文件链接、xmind 卡片、列表缩略图),任何访客可取。这也是博客图片能正常显示的原因。未公开笔记的附件则是"实际私有"——URL 猜不出来,但**任何拿到 URL 的人永远可以访问**。

三个缺口:

1. **取消公开收不回附件**:URL 一旦被看到/被爬,永久有效;浏览器侧还有长缓存。
2. **敏感扫描只扫文本**:截图里的密码、密钥、身份证照片,扫描器无能为力。
3. **交叉引用**:同一附件同时被私有笔记和公开笔记引用时,公开侧会把它暴露出去。

## 二、处理方案(建议 A1 + A2)

**A1 发布弹窗附件清单**(前端,低成本,先做):公开确认弹窗中列出文中全部附件——图片显示缩略图、文件显示名称——作为独立风险区块要求目视确认。覆盖"截图含敏感信息"这类扫描器管不了的场景。

**A2 附件访问分级**(后端,提供真正的撤销能力):

- **登录态 cookie 副本**:应用启动时把 token 写入 `path=/api/files; SameSite=Lax; Secure` 的 cookie,`<img>`/同源 fetch 自动携带;服务端**仅在 `GET/HEAD /api/files/*` 接受 cookie**,一切写操作仍只认 Authorization 头——不引入 CSRF 面。
- **免登录分支加校验**:无登录态时,仅当该 key 被某篇 `is_public=1 AND is_private=0` 的文章内容引用(`content LIKE '%<key>%'`,单用户几百行全扫无压力)才放行;判定结果用 Cache API 缓存约 5 分钟。
- **效果**:未公开/私有笔记的附件从"拿到链接就能看"变成 404;取消公开后,新访客最多 5 分钟内失效(已看过的人浏览器缓存无法收回——与"内容已被看过"同属不可逆,属预期)。
- 公开附件保持长缓存不变。

**备选 B(零改动)**:维持能力 URL 模型,只做 A1 提示。可接受,但没有撤销能力。

**不采用**:签名 URL(需改写源码/富文本/预览三条渲染管线,破坏字节级往返);发布时复制附件到公开前缀(存储翻倍、发布后新增附件同步复杂)。

## 三、与 Evernote 的功能差异

### 已对齐或超出

笔记本/笔记管理、富文本+源码+预览编辑(标准 Markdown 存储)、附件(任意文件,XMind 在线编辑超出)、混合搜索(语义部分超出)、AI 问答与引用定位(对标 Evernote AI)、公开发布(博客整站,超出单篇分享)、全量导出/批量导入、深色模式、用量统计。

### 建议补(按价值/成本排序)

| # | 功能 | Evernote 对应 | 方案要点 | 成本 |
|---|------|--------------|---------|------|
| 1 | 附件公开治理 | (安全基座) | 上文 A1+A2 | 中 |
| 2 | 回收站(软删除) | 回收站 | `deleted_at` 标记,虚拟笔记本「回收站」,30 天后由现有 cron(scheduled 已接 archive)自动清理,彻底删除时才清 R2 附件 | 中低 |
| 3 | 标签系统 | 标签(核心组织维度) | `tags` + `article_tags` 表(幂等迁移),编辑器打标,侧栏标签筛选,搜索按标签过滤;博客 Tags 顺势展示真标签 | 中 |
| 4 | 置顶/快捷方式 | 快捷方式 | 笔记 `pinned` 列,列表置顶区 | 低 |
| 5 | 网页剪藏 | Web Clipper(招牌) | 书签栏 bookmarklet 抓选区/正文 HTML → 打开 CFNote 剪藏页 → 前端 turndown(已有依赖)转 MD 存笔记 | 中 |
| 6 | 笔记间链接+反链 | 笔记链接 | 编辑器 `[[`/`@` 搜索笔记插入标准 MD 链接;详情侧栏反向链接(LIKE 查询);反链超出 Evernote | 中低 |
| 7 | 任务清单勾选 | 任务 | GFM `- [ ]` 在预览/富文本中可点击勾选并回写源文(标准语法内) | 低中 |
| 8 | 私密分享链接 | 共享链接(unlisted) | 随机 token 的 `/blog/share/<token>`,可看不入博客列表/热榜 | 低中 |
| 9 | 笔记模板 | 模板 | 「模板」约定笔记本 + 新建时选择套用 | 低 |
| 10 | 版本历史 | 历史(付费功能) | `article_versions` 快照(同小时合并,保留近 N 版+每日 1 版),对比/回滚;注意 D1 容量 | 中 |
| 11 | Email 收集箱 | Email 转发进笔记 | CF Email Routing + Email Workers(免费)收信建笔记;需自有域名,作为可选功能 | 中 |
| 12 | 提醒 | 提醒推送 | 笔记设提醒时间,cron 扫描 → 邮件(依赖 11)或应用内「今日提醒」面板 | 中 |
| 13 | OCR/附件内搜索 | 图片文字/PDF 搜索(招牌) | Workers AI 视觉模型抽图片文字、unpdf 提取 PDF 文本层入向量索引;免费额度受限,远期 | 高 |
| 14 | PWA 离线/移动完整版 | 客户端离线 | 已在 backlog | 高 |
| 15 | 笔记本分组(Stack) | 笔记本组 | 平铺够用,后排 | 中低 |

### 不做(理由)

- 多人协作/共享编辑:单用户定位。
- 字体颜色/高亮笔等专有富文本:违背"标准 Markdown 无私有方言"硬约束(如确需高亮,`<mark>` 属 CommonMark 合法内嵌 HTML,可作为例外单独评估)。
- 名片扫描、地理位置:场景不存在。

## 四、建议批次

- **P8 安全与组织基座**:附件治理(A1+A2)、回收站、标签、置顶。
- **P9 采集与互联**:网页剪藏、笔记间链接+反链、任务勾选、私密分享链接、模板。
- **P10 进阶选做**:版本历史、Email 收集箱、提醒、OCR、PWA。
