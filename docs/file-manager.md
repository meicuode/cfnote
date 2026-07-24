# P8 文件管理与附件关联体系

**状态(2026-07-24)**:P8.1(数据层/间接链接/访问分级/发布弹窗附件清单)✅;P8.2 文件管理页、P8.3 编辑器文件库选择器待开工。与 [evernote-gap.md](evernote-gap.md) 的「附件公开治理(A1+A2)」共用地基,本文档为准(A2 的 LIKE 查询方案由关联索引表取代)。

## 核心决策零:间接链接(P8.1 实现)

采纳用户提议:新上传附件的链接为 **`/api/afile/{文件id}/{文件名}`**,真实 R2 key(含 32 位随机段)只存 files 表,不再出现在笔记内容里。要点:

- **不把 articleId 编进链接**(原议 `getFileLink(fileKey, articleId)`):① 笔记间复制粘贴会携带旧文章 id,新文章的附件访问被旧文章公开状态"遥控",除非保存时改写内容(违背零 diff);② 同一文件在 N 篇文章产生 N 个 URL,浏览器缓存全部失效;③ 安全无增益——A 私有 B 公开同引时,B 的链接反正开放,有效暴露面与 OR 规则相同。引用关系由保存时内容提取登记,判定走 article_files 反查。
- **尾部文件名保留**:`.xmind` 卡片识别与浏览器下载命名都靠 URL 尾巴;服务端按 id 定位、忽略尾巴内容。
- **边车缩略图零客户端改动**:客户端约定是"主文件链接 + `.thumb.png`"(卡片显示、查看器回存共三处),afile 路由按「尾巴=注册名 → 主文件;其余 .thumb.png 结尾 → 边车」分流,新旧链接同构。
- **双轨并存**:存量内容里的旧式 `/api/files/<key>` 链接不改写(不动用户数据),旧路由挂同一套访问分级继续服务;新上传/新插入一律新式链接。
- 上传响应的 `url` 字段直接变为新式链接,编辑器插入逻辑零改动。

## 背景与目标

附件现状:R2 key `u{id}/{32位随机}/{文件名}`,无 DB 登记、无目录、无法浏览与复用;文章与附件只靠"URL 出现在内容里"关联;删文章按自身内容清 R2(**已知缺陷:附件被多篇文章共用时会被误删**);免登录下载靠 key 不可枚举。

目标:文件管理页(浏览/目录/上传/搜索/清理)+ 编辑器文件库选择器(复用已上传文件)+ 附件↔文章关联索引(反查、引用计数删除、访问分级)。

## 核心决策一:附件↔文章如何关联

**内容是唯一事实源,`article_files` 是派生索引。**

- 保存文章(创建/更新)时,服务端用 `extractFileKeys` 正则从 Markdown 提取本用户附件 key,与该文章旧关联行做 D1 batch 原子替换(DELETE + INSERT)。
- 不在 articles 里存 JSON 附件列表:粘贴/拖拽/手写/删段落都会改内容,手工列表必然漂移;JSON 列也无法索引反查。
- 索引可全量重建(回填/自愈),沿用 reindex 传统。
- **删除语义改为引用计数**:删文章只删关联行;key 引用归零才清 R2(修复共用附件误删 bug)。文件管理中手动删文件时若仍被引用,列出引用文章并要求确认(删除后笔记中成死链)。

## 核心决策二:混合可见性(OR 规则)

**附件对外可见性 = 所有引用文章可见性的 OR**:任一引用文章 `is_public=1 AND is_private=0`,该附件即免登录可访问。公开文章要展示它就必须放行,私有引用无法"减去"这一事实——规则唯一自洽,工作量花在让它透明可控:

1. 发布弹窗列出附件清单(图片带缩略图),其中同时被私有/未公开笔记引用的项标注交叉警告;
2. 文件管理页每个文件显示有效可见性徽标(公开可访问/仅自己)+ 引用清单;
3. (可选进阶)「创建独立副本」把公开/私有纠缠的附件拆成两个 key。

访问分级实现(worker/routes/files.ts GET/HEAD):

- 登录态判定:Authorization 头之外,增加 cookie 副本(应用启动时把 token 写入 `path=/api/files; SameSite=Lax; Secure`,`<img>`/同源 fetch 自动携带);**仅附件 GET/HEAD 接受 cookie**,写操作只认头,不引入 CSRF 面。
- 有登录态 → 放行任意本人 key;无登录态 → `EXISTS(article_files ⋈ articles WHERE is_public=1 AND is_private=0)` 索引查询放行,否则 404。
- 零引用文件默认仅登录可见。公开附件保持 immutable 长缓存;取消公开后已加载的浏览器缓存不可收回(同"已被看过"),新访客即时失效。

## 数据模型(应用内幂等迁移:CREATE TABLE IF NOT EXISTS + 回填)

```sql
files(id PK, user_id, key UNIQUE, name, folder_id NULL, size, content_type,
      category,            -- image | doc | other,入库时按 content_type/扩展名推导
      created_at, updated_at)
folders(id PK, user_id, name, parent_id NULL, created_at)   -- 多级,仅管手工区
article_files(article_id, file_key, PRIMARY KEY(article_id, file_key))
              -- + INDEX(file_key) 反查
```

- **目录是 D1 虚拟结构,R2 key 永不变**:移动/重命名(显示名)不改 URL,永不破坏笔记里的链接。
- 「笔记附件」区按 笔记本→笔记 从 article_files 派生,只读组织;「我的文件夹」区存手工上传;两区之外零引用文件进「未引用」视图(清理入口,顺带回收草稿废弃上传)。
- **xmind 边车缩略图**:上传 xmind 时生成的缩略图对象不出现在正文,若不处理会被判"未引用"而误清。规则:边车 key 关联主文件(按命名约定识别),列表中隐藏、随主文件删除、不计入未引用。实现时以代码里的实际边车命名为准。

## 文件管理页(侧栏入口,主区视图)

- 左侧树:笔记附件(按笔记本分组)/ 我的文件夹(可多级,新建/重命名/删除空目录)/ 未引用。
- 右侧列表:分类 chips(全部/图片/文档/其他)+ 名称搜索(LIKE);网格(图片缩略图)或行视图。
- 文件操作:预览、重命名(显示名)、移动到文件夹、复制链接、插入笔记链接文本、删除(引用警告);可见性徽标 + 引用清单。
- 预览能力:图片 lightbox;xmind 复用 XmindViewer;md/txt/csv/js 等文本类拉取渲染;pdf 浏览器原生(新标签);office(doc/docx/xls/xlsx)不做在线预览只下载(在线预览需把 URL 交给外部服务,隐私不可接受)。
- 顶部统计:文件数 / 总占用 vs R2 免费 10GB。
- 上传:沿用 POST /api/files(10MB 限制),带 folder_id 落到当前目录;常见格式不设白名单限制(维持 P4 通用附件语义)。

## 编辑器文件库选择器

编辑器上传入口改为对话框双 Tab:「上传新文件」(现有流程)/「从文件库选择」(分类 chips + 名称搜索,选中插入既有 URL,不重复占用存储)。源码/富文本两模式共用。

## API 概要

- `GET /api/fm/files?folder=|category=|q=|unref=1`(分页)、`PUT /api/fm/files/:id`(name/folder_id)、`DELETE /api/fm/files/:id`(被引用时须 force)、`GET /api/fm/files/:id/refs`
- `POST/PUT/DELETE /api/fm/folders`
- `GET /api/fm/stats`
- 文章保存/删除钩子维护 article_files;files.ts GET/HEAD 接入访问分级。

## 迁移(开发阶段简化)

按用户约定:**开发阶段不做数据迁移/回填机制**。三表(files/folders/article_files)进 system.ts SCHEMA(全新初始化)+ migrate.ts 幂等 `CREATE TABLE IF NOT EXISTS`(旧库纯增量,无需清库);若未来出现不兼容表结构变更,直接提示线上清空并重新 `/api/init`。

存量文章的引用索引不回填:每次保存文章都会全量重建该文章的关联行(自愈),索引查不到时访问判定兜底直查公开文章内容(`instr`,公开文章量小,兼容 URL 编码的中文文件名)。存量 R2 对象不批量登记 files 表——旧式链接双轨继续可用;P8.2 文件管理页如需展示全部存量,届时提供一次「扫描 R2 登记」维护入口。

## 分期

- **P8.1 数据层与访问分级** ✅(2026-07-24):三表 schema、afile 间接路由(GET/HEAD/PUT,主/边车尾巴分流)、cookie 登录态(`cfnote_t`,path=/api,仅附件 GET/HEAD 认)、新旧双轨访问分级(登录 OR 公开引用,索引缺行 instr 兜底)、文章创建/更新/URL 导入/备份导入的引用登记钩子、引用计数删除(修复共用附件误删与边车残留)、上传登记+新式链接、导出补 files/folders 表、发布弹窗附件清单+私有交叉引用警告。
- **P8.2 文件管理页** ✅(2026-07-24):侧栏「文件管理」入口 → 全屏面板(懒加载 chunk)。左栏:全部文件/未引用(计数)/笔记附件按笔记本分组(派生只读)/我的文件夹树(多级,新建/改名/删空目录,悬浮操作);右侧:分类 chips(全部/图片/文档/其他)+ 名称搜索(防抖,LIKE 转义)+ 列表(缩略图、大小、引用数弹窗、公开可访问/仅自己徽标,悬浮 复制链接/重命名/移动/删除);预览分流(图片 lightbox、xmind 复用 XmindViewer 可编辑回存、md/txt/代码等文本弹窗渲染、pdf 新标签、office/其他下载);删除带引用警告(列出笔记名,须"仍要删除");上传落当前目录(x-folder-id);顶部统计(文件数/占用 vs 10GB)与「扫描登记」(存量 R2 对象登记 + 全量重建引用索引,幂等)。接口:GET overview/files/files-refs、PUT/DELETE files、folders CRUD、POST scan。
- **P8.3 编辑器文件库选择器**。
- 原 P8 其余项(回收站、标签、置顶)顺延为 P9,原 P9/P10 依次后移(见 evernote-gap.md)。
