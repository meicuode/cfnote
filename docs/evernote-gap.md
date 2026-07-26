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
