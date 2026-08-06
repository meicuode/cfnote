import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'
import { buildAfileUrl } from '../../src/lib/fileRefs'

// 文件管理的两个「根层」视图(P17.3)。
//
// 文件夹树从侧栏搬进主窗口之后多了一个此前不存在的状态:**站在根上**。
// 侧栏那棵树整棵铺开,没有「当前在哪一层」这回事;主窗口一次只渲染一层,
// 就必须回答「根层显示什么」。同理「笔记附件」从按笔记本的一棵树变成
// 平铺列表 + 筛选 chips,也就需要一个「不按笔记本筛」的取数。
//
// 这两条都走既有的 /api/fm/files,只是省掉 folder / notebook 参数——
// 而省掉参数此前的行为是 `Number(...) || 0` 落成 id=0,永远查不到东西。

interface FileRow { id: number; name: string; folder_id: number | null; key: string }

async function upload(token: string, name: string, content = 'hello', folderId?: number): Promise<FileRow> {
  const headers: Record<string, string> = {
    'x-filename': encodeURIComponent(name),
    'content-type': 'text/plain',
  }
  if (folderId != null) headers['x-folder-id'] = String(folderId)
  const res = await api<{ id: number; key: string; name: string }>('/api/files', {
    method: 'POST', token, headers, body: content,
  })
  expect(res.body.ok, '上传失败: ' + res.body.error).toBe(true)
  return { id: res.body.data!.id, name: res.body.data!.name, key: res.body.data!.key, folder_id: folderId ?? null }
}

async function newFolder(token: string, name: string, parent?: number): Promise<number> {
  const res = await api<{ id: number }>('/api/fm/folders', {
    method: 'POST', token, body: j({ name, parent_id: parent ?? null }),
  })
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.id
}

async function list(token: string, qs: string): Promise<FileRow[]> {
  const res = await api<{ files: FileRow[] }>(`/api/fm/files${qs}`, { token })
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.files
}

const names = (rows: FileRow[]) => rows.map((f) => f.name).sort()

describe('文件管理的根层视图(P17.3)', () => {
  beforeEach(dropAll)

  it('view=folder 不带 folder 参数 = 根层(没归到任何文件夹的文件)', async () => {
    const token = await bootstrap()
    const fid = await newFolder(token, '截图')
    await upload(token, '散的.txt')
    await upload(token, '归档的.txt', 'x', fid)

    // 此前 Number(undefined) || 0 → folder_id = 0,一个也查不到
    expect(names(await list(token, '?view=folder'))).toEqual(['散的.txt'])
    expect(names(await list(token, `?view=folder&folder=${fid}`))).toEqual(['归档的.txt'])
  })

  it('根层不含子目录里的文件——一屏只显示一层', async () => {
    const token = await bootstrap()
    const parent = await newFolder(token, '截图')
    const child = await newFolder(token, '2026', parent)
    await upload(token, '根上的.txt')
    await upload(token, '一层.txt', 'x', parent)
    await upload(token, '两层.txt', 'x', child)

    expect(names(await list(token, '?view=folder'))).toEqual(['根上的.txt'])
    expect(names(await list(token, `?view=folder&folder=${parent}`))).toEqual(['一层.txt'])
    expect(names(await list(token, `?view=folder&folder=${child}`))).toEqual(['两层.txt'])
  })

  it('view=notebook 不带 notebook 参数 = 所有被笔记引用的附件', async () => {
    const token = await bootstrap()
    const nbA = await newNotebook(token, '技术')
    const nbB = await newNotebook(token, '生活')
    const inA = await upload(token, 'a.txt')
    const inB = await upload(token, 'b.txt')
    await upload(token, '没人引用.txt')
    await newArticle(token, nbA, '甲', `看图 ![](${buildAfileUrl(inA.id, inA.name)})`)
    await newArticle(token, nbB, '乙', `看图 ![](${buildAfileUrl(inB.id, inB.name)})`)

    expect(names(await list(token, '?view=notebook'))).toEqual(['a.txt', 'b.txt'])
    expect(names(await list(token, `?view=notebook&notebook=${nbA}`))).toEqual(['a.txt'])
  })

  it('被两个笔记本引用的文件,在「全部」里只出现一次', async () => {
    // 这正是「笔记附件不能做成树」的那条论证:它是投影不是容器。
    // 树形会让同一个文件挂在两个笔记本下面,各本计数加起来大于文件总数
    const token = await bootstrap()
    const nbA = await newNotebook(token, '技术')
    const nbB = await newNotebook(token, '生活')
    const shared = await upload(token, '共用.txt')
    await newArticle(token, nbA, '甲', `![](${buildAfileUrl(shared.id, shared.name)})`)
    await newArticle(token, nbB, '乙', `![](${buildAfileUrl(shared.id, shared.name)})`)

    const all = await list(token, '?view=notebook')
    expect(all.length).toBe(1)
    // 而按单本筛时,它在两本下面都查得到——各本之和 2 > 总数 1
    expect(names(await list(token, `?view=notebook&notebook=${nbA}`))).toEqual(['共用.txt'])
    expect(names(await list(token, `?view=notebook&notebook=${nbB}`))).toEqual(['共用.txt'])
  })

  it('回收站里的笔记不算引用', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '技术')
    const f = await upload(token, 'x.txt')
    const artId = await newArticle(token, nb, '甲', `![](${buildAfileUrl(f.id, f.name)})`)
    expect(names(await list(token, '?view=notebook'))).toEqual(['x.txt'])

    await api(`/api/articles/${artId}`, { method: 'DELETE', token })
    expect(await list(token, '?view=notebook')).toEqual([])
  })

  it('非法的 folder / notebook 参数退回根层,而不是查出空列表', async () => {
    // 0 / 负数 / 非数字都当成「没给」——URL 是人能改的,坏值不该变成一屏空白
    const token = await bootstrap()
    await upload(token, '散的.txt')
    for (const qs of ['?view=folder&folder=0', '?view=folder&folder=-1', '?view=folder&folder=abc']) {
      expect(names(await list(token, qs)), qs).toEqual(['散的.txt'])
    }
  })
})
