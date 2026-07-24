// 网页剪藏(P9 #5)bookmarklet 生成:
// 书签在任意网页上执行 → 抓取选区(优先)或正文 HTML → window.open 打开本站 /clip 页
// → 轮询 postMessage 传输(收到 ack 停止;跨域无法探测子窗口就绪,轮询是唯一可靠方式)。
// HTML 上限 800KB,防止超大页面撑爆 postMessage/后续入库。

/** 剪藏消息载荷(bookmarklet → /clip 页) */
export interface ClipPayload {
  type: 'cfnote-clip'
  title: string
  url: string
  html: string
}

export const CLIP_ACK = 'cfnote-clip-ack'
export const CLIP_MAX_HTML = 800000

/** 生成完整 bookmarklet URL(javascript: 协议,内容 URI 编码) */
export function buildBookmarklet(origin: string): string {
  const src =
    `(function(){var s=getSelection(),h='';` +
    `if(s&&s.rangeCount&&!s.isCollapsed){var d=document.createElement('div');for(var i=0;i<s.rangeCount;i++)d.appendChild(s.getRangeAt(i).cloneContents());h=d.innerHTML}` +
    `else{var a=document.querySelector('article')||document.querySelector('main')||document.body;h=a?a.innerHTML:''}` +
    `if(h.length>${CLIP_MAX_HTML})h=h.slice(0,${CLIP_MAX_HTML});` +
    `var o='${origin}';var w=window.open(o+'/clip','_blank');` +
    `if(!w){alert('弹窗被拦截,请允许本站弹窗后重试');return}` +
    `var p={type:'cfnote-clip',title:document.title,url:location.href,html:h};` +
    `var n=0,t=setInterval(function(){if(n++>50){clearInterval(t);return}try{w.postMessage(p,o)}catch(e){}},300);` +
    `window.addEventListener('message',function(e){if(e.origin===o&&e.data==='${CLIP_ACK}')clearInterval(t)})` +
    `})()`
  return 'javascript:' + encodeURIComponent(src)
}
