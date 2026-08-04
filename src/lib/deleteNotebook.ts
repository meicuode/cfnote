/**
 * 删除笔记本的确认文案与强度判定(P16.3)。
 *
 * 抽成纯函数不是为了复用——只有一个调用点——而是因为**这里的每一句话都是安全决策**:
 * 说不说「已发布 N 篇」、什么时候升级成打字确认、按钮上写什么。
 * 埋在 JSX 里就只能靠人眼复核,而人眼复核不了「published 为 0 时那句该消失」这种分支。
 */

export interface DeleteImpact {
  /** 整棵子树的笔记本数,含自己 */
  notebooks: number
  /** 子树里活着的笔记数 */
  articles: number
  /** 其中已公开的(会从博客下线) */
  published: number
  /** 其中带分享链接的(链接会失效) */
  shared: number
}

/**
 * 超过这个篇数就要求打字确认。
 *
 * 50 是个判断不是计算:再多几篇也谈不上灾难(30 天可逆、附件不动),但到了这个量级,
 * 「我以为只删了一个空本」和事实之间的差距已经大到值得强制停一下。
 * 阈值定低了会让人养成盲目打字的习惯,那比没有这道闸更糟。
 */
export const TYPE_TO_CONFIRM_ARTICLES = 50

export interface DeletePrompt {
  title: string
  message: string
  confirmText: string
  /** 非空 = 要求用户原样打出这个词才放行 */
  typeToConfirm: string
}

export function deleteNotebookPrompt(name: string, im: DeleteImpact): DeletePrompt {
  const sub = im.notebooks - 1
  // 数量那句:只有真有子本或真有笔记时才提,空本删除不该弹一堆 0
  const scope = sub > 0
    ? `将连同 ${sub} 个子笔记本、${im.articles} 篇笔记一起移入回收站。`
    : im.articles > 0
      ? `其中 ${im.articles} 篇笔记会一并移入回收站。`
      : '这个笔记本是空的。'

  // 外部影响:0 就不提。与 P16.5.1「三者全 0 就不打扰」同一条规矩——
  // 没有别人看得见的后果时,制造焦虑只会稀释真正该停下的那几次
  const outside = [
    im.published > 0 ? `其中 ${im.published} 篇已发布，会从博客下线` : '',
    im.shared > 0 ? `${im.shared} 个分享链接会失效` : '',
  ].filter(Boolean).join('；')

  // 可逆性必须讲出来:不讲的话,人要么因为怕而不敢用,要么因为不知道而乱用
  const reversible = '30 天内可从回收站整棵恢复，附件不会被删除。'

  return {
    title: `删除「${name}」？`,
    message: [scope, outside ? outside + '。' : '', reversible].filter(Boolean).join(' '),
    // 按钮上写明动作与数量,不写「确定」——点之前至少会扫一眼(与 P16.5.2 的
    // 「设为私密并下线 N 篇」同一条做法)
    confirmText: im.articles > 0 ? `移入回收站（${im.articles} 篇）` : '移入回收站',
    typeToConfirm: im.articles > TYPE_TO_CONFIRM_ARTICLES ? name : '',
  }
}
