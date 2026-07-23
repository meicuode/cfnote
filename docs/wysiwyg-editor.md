# P6 所见即所得编辑器(WYSIWYG)——规划

**背景**:当前编辑(Markdown 源文 textarea)与预览(marked 渲染)是两个割裂的模式。已有的过渡方案——预览双击定位到源文、预览内拖拽调整图片宽度——缓解但不解决"看到的和改的不是同一份"。目标是 Typora 式体验:在渲染视图里直接编辑,底层始终是标准 Markdown。

**存储与格式约束(硬性)**:
- 持久化格式仍是**标准 Markdown**(CommonMark + GFM 表格/删除线),不引入编辑器私有 JSON。图片尺寸继续用内嵌 HTML `<img width>`(标准 Raw HTML),与现有内容完全兼容。
- 现存文章必须无损打开;往返(打开→不编辑→保存)必须字节级等价或语义等价,以快照测试守住。

## 技术选型

**推荐:TipTap(ProseMirror)+ tiptap-markdown**,懒加载独立 chunk(与 XmindViewer 同策略)。

| 候选 | 结论 |
|---|---|
| TipTap + tiptap-markdown | ✅ NodeView 支持 React 组件(xmind 卡片刚需);扩展生态成熟(图片、表格、代码块);MD 序列化经 tiptap-markdown,可控 |
| Milkdown | Markdown-first 但 API 迭代快、自定义 NodeView 文档薄,定制 xmind 卡片成本更高 |
| Vditor | 中文生态好、自带 IR 模式,但无扩展模型,xmind 卡片/图片直传 R2 等定制只能 hack DOM |
| contenteditable + turndown 往返 | ❌ 代码块/表格/嵌套结构往返失真,不可靠,已否决 |

## 分期

**P6.1 编辑器壳与标准语法往返**
- 懒加载 TipTap;标题/加粗/斜体/删除线/行内代码/代码块/引用/有序无序列表/表格/链接/分割线全量支持
- 「源码 ↔ 所见即所得」双模式切换,同一份 MD 字符串,切换零丢失
- 接入现有自动保存、字数统计、目录(TOC 从编辑器文档树取,替代正则)
- 验收:现存全部文章打开→不动→保存,diff 为空;每种语法在两种模式往返一致(快照测试)

**P6.2 图片体验**
- 粘贴/拖入/工具栏上传 → POST /api/files → 插入;拖拽手柄调宽,序列化为 `<img width>`
- 点击放大(lightbox)沿用现有组件
- 验收:粘贴截图直接入文;拖拽后源文出现标准 `<img width>`;10MB 上限与错误提示一致

**P6.3 XMind 卡片 NodeView(性能关键)**
- .xmind 链接渲染为独立 React 组件卡片:缩略图(边车 .thumb.png)+ 文件名 + 大小/时间悬浮
- **编辑器内绝不实例化 simple-mind-map**——卡片只是一张图,点击才懒加载 XmindViewer 弹窗(现有组件复用);一篇文章多个 xmind 也不卡
- 卡片上唯一可编辑的是**显示名**(即链接文字),改名只改 MD 里的链接文本,不动 R2 文件
- 验收:含 3+ xmind 的文章滚动/输入无卡顿;改名后 MD 为 `[新名](原url)`;删除卡片=删除链接

**P6.4 收尾**
- AI 引用定位高亮适配编辑器 DOM;深色模式;中文输入法(IME)组合输入不断字;移动端降级只读
- 验收:引用点击定位准确;IME 连续输入不丢字

## 风险
- tiptap-markdown 对边角语法(嵌套列表内代码块、HTML 块)的序列化偏差 → P6.1 快照测试先行,发现即写规则修正
- 包体积:懒加载 chunk 预估 +150~250KB gzip,首屏不受影响
- 与现有 MutationObserver 注入方案互斥:WYSIWYG 上线后预览态的卡片/手柄注入代码整体下线,归 NodeView

**优先级**:P5(应用内迁移)之后、数据量上来之前做 P6.1/P6.2;P6.3/P6.4 随用随排。
