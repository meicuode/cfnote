/**
 * 本地文件夹导入的计划(P16.4):把浏览器交出来的一堆 File 变成「备份形状」的载荷。
 *
 * 为什么复用备份格式而不是新开一个接口:`POST /api/import` 自 P16.3.1 起**按完整路径**
 * 匹配笔记本——路径已存在就复用、不存在就建。那正好就是文件夹导入需要的语义,
 * 客户端只要把目录结构翻译成 notebooks 数组,建树这件事服务端一行都不用改。
 *
 * 两条不显眼但必须守住的规矩:
 *
 *   1. **目标笔记本要发整条祖先链**。服务端拿「从根到自己」的路径当键,只发目标自己的
 *      名字的话,`技术/前端` 会被当成根上的 `前端`,对不上 → 在根上另建一本同名的,
 *      导入的文件全进了那本。P16.3.1 换成路径匹配之后这是必然结果,不是偶发。
 *
 *   2. **每一片都带完整的 notebooks**。分片上传时第一片把树建出来,后面几片按路径
 *      复用同一棵——路径匹配天生幂等,所以中途失败重发也不会长出第二棵树。
 */

import { importTitle, docStem, dirSegments } from './importTitle'

export interface ImportFileLike {
  name: string
  webkitRelativePath?: string
}

/** 载荷里的笔记本。id 只在这份载荷内部有意义(服务端拿它连 parent_id,不写进库) */
export interface PlanNotebook {
  id: number
  name: string
  parent_id: number | null
}

export interface PlanArticle {
  /** 在入参 files 里的下标——正文要调用方自己去读(异步),纯逻辑这层不碰 File */
  index: number
  notebook_id: number
  title: string
}

export interface ImportPlan {
  notebooks: PlanNotebook[]
  articles: PlanArticle[]
  /** 这次预计新建几本(祖先链那几节不算,它们是用来对上号的) */
  willCreate: number
}

/**
 * @param destPath 目标笔记本的完整路径(从根到它自己的名字链),见规矩 1
 * @param keepTree false = 退回 P15.4 的老行为:全部进目标笔记本,相对路径写进标题
 */
export function planImport(
  files: ImportFileLike[],
  destPath: string[],
  keepTree: boolean,
): ImportPlan {
  const notebooks: PlanNotebook[] = []
  let nextId = 1

  // 祖先链铺成一条脊,最后一节就是目标笔记本
  let parent: number | null = null
  for (const name of destPath) {
    notebooks.push({ id: nextId, name, parent_id: parent })
    parent = nextId
    nextId++
  }
  const destId = parent
  // 没有目标就没得导。调用方应当拦在前面,这里只是不产出一份「挂在根上」的计划——
  // 那会往库里凭空建一批顶层笔记本
  if (destId === null) return { notebooks: [], articles: [], willCreate: 0 }

  // 相对目录段 -> 载荷内的笔记本 id。键走 JSON.stringify 与服务端那份路径键保持一致
  // (worker/routes/system.ts)。这里其实撞不上:webkitRelativePath 拿斜杠当分隔符,
  // 段里不可能再有斜杠。写成一样只是不想让两处的键有两种构造法——哪天这个模块
  // 改从别处拿路径(比如 zip 包的条目名),差别就成真的了
  const byDir = new Map<string, number>([[JSON.stringify([]), destId]])

  const articles: PlanArticle[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (!keepTree) {
      articles.push({ index: i, notebook_id: destId, title: importTitle(f) })
      continue
    }
    let cur = destId
    const acc: string[] = []
    for (const seg of dirSegments(f)) {
      acc.push(seg)
      const key = JSON.stringify(acc)
      const got = byDir.get(key)
      if (got !== undefined) {
        cur = got
        continue
      }
      notebooks.push({ id: nextId, name: seg, parent_id: cur })
      byDir.set(key, nextId)
      cur = nextId
      nextId++
    }
    // 路径已经由树表达,标题就只剩文件名
    articles.push({ index: i, notebook_id: cur, title: docStem(String(f.name || '')) })
  }

  return { notebooks, articles, willCreate: notebooks.length - destPath.length }
}

// ---- 分片上传 ----
// 一次性把整个知识库塞进一个 POST,请求体、Worker CPU、D1 batch 三头都顶着上限,
// 而它恰恰是这个功能最该扛住的场景。切片之后进度也才有真数字可报。

export const CHUNK_FILES = 50
export const CHUNK_BYTES = 2 * 1024 * 1024

/**
 * 按「条数」和「累计大小」两个上限切片,谁先到算谁。
 * 单条自己就超上限时**自成一片**——否则它永远进不去,整批卡死在那一个文件上。
 */
export function chunkBySize<T>(
  items: T[],
  sizeOf: (x: T) => number,
  maxCount = CHUNK_FILES,
  maxBytes = CHUNK_BYTES,
): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let bytes = 0
  for (const it of items) {
    const n = Math.max(0, sizeOf(it) || 0)
    if (cur.length > 0 && (cur.length >= maxCount || bytes + n > maxBytes)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(it)
    bytes += n
  }
  if (cur.length > 0) out.push(cur)
  return out
}
