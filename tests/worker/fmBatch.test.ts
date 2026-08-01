import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'
import { buildAfileUrl } from '../../src/lib/fileRefs'

// 文件管理批量操作(P13.3)的端到端。这块此前完全没有覆盖,而它是唯一真正动 R2 的路径:
// R2 的 Workers binding 没有服务端 copy,复制必须 get 再 put、字节流经 Worker,
// 所以「副本是不是真的在桶里」「跳过的项有没有报回来」只有跑真桶才测得出。

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

async function newFolder(token: string, name: string): Promise<number> {
  const res = await api<{ id: number }>('/api/fm/folders', { method: 'POST', token, body: j({ name }) })
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.id
}

async function listFiles(token: string): Promise<FileRow[]> {
  const res = await api<{ files: FileRow[] }>('/api/fm/files', { token })
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.files
}

async function batch<T = any>(token: string, payload: Record<string, unknown>) {
  return api<T>('/api/fm/files/batch', { method: 'POST', token, body: j(payload) })
}

describe('文件管理批量操作', () => {
  beforeEach(dropAll)

  it('批量移动进文件夹,再批量移出', async () => {
    const token = await bootstrap()
    const folder = await newFolder(token, '归档')
    const a = await upload(token, 'a.txt')
    const b = await upload(token, 'b.txt')

    const moved = await batch<{ moved: number }>(token, { op: 'move', ids: [a.id, b.id], folder_id: folder })
    expect(moved.body.ok, moved.body.error).toBe(true)
    expect(moved.body.data!.moved).toBe(2)
    for (const f of await listFiles(token)) expect(f.folder_id).toBe(folder)

    // folder_id: null 就是「移出文件夹」(拖到那块虚线区域走的是同一条路)
    const out = await batch<{ moved: number }>(token, { op: 'move', ids: [a.id, b.id], folder_id: null })
    expect(out.body.data!.moved).toBe(2)
    for (const f of await listFiles(token)) expect(f.folder_id).toBe(null)
  })

  it('移动到不存在的文件夹是 404,且一个都不动', async () => {
    const token = await bootstrap()
    const a = await upload(token, 'a.txt')
    const res = await batch(token, { op: 'move', ids: [a.id], folder_id: 999999 })
    expect(res.status).toBe(404)
    expect((await listFiles(token))[0].folder_id).toBe(null)
  })

  it('批量复制:R2 里真多出一份,名字加「副本」,不继承分享', async () => {
    const token = await bootstrap()
    const a = await upload(token, '报告.pdf', 'PDF-BYTES')

    // 先给原件建一个分享,验证副本不继承
    const share = await api<{ token: string }>(`/api/fm/files/${a.id}/share`, { method: 'POST', token, body: j({ days: 7 }) })
    expect(share.body.ok, share.body.error).toBe(true)

    const res = await batch<{ copied: number; skipped: unknown[] }>(token, { op: 'copy', ids: [a.id] })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.copied).toBe(1)
    expect(res.body.data!.skipped).toEqual([])

    const files = await listFiles(token)
    expect(files).toHaveLength(2)
    const copy = files.find((f) => f.id !== a.id)!
    expect(copy.name).toBe('报告 副本.pdf')
    expect(copy.key).not.toBe(a.key)
    expect((copy as any).share_token ?? null).toBe(null)

    // 关键:字节真的写进了桶里,而不是只插了一行 D1
    const obj = await env.BUCKET.get(copy.key)
    expect(obj).not.toBeNull()
    expect(await obj!.text()).toBe('PDF-BYTES')
  })

  it('再复制一次副本,序号累加而不是叠成「副本 副本」', async () => {
    const token = await bootstrap()
    const a = await upload(token, '报告.pdf')
    await batch(token, { op: 'copy', ids: [a.id] })
    const copy1 = (await listFiles(token)).find((f) => f.id !== a.id)!
    await batch(token, { op: 'copy', ids: [copy1.id] })
    const names = (await listFiles(token)).map((f) => f.name).sort()
    expect(names).toEqual(['报告 副本 2.pdf', '报告 副本.pdf', '报告.pdf'].sort())
  })

  it('批量删除:D1 行与 R2 对象一起消失', async () => {
    const token = await bootstrap()
    const a = await upload(token, 'a.txt')
    const b = await upload(token, 'b.txt')

    const res = await batch<{ deleted: number }>(token, { op: 'delete', ids: [a.id, b.id] })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.deleted).toBe(2)
    expect(await listFiles(token)).toHaveLength(0)
    expect(await env.BUCKET.get(a.key)).toBeNull()
    expect(await env.BUCKET.get(b.key)).toBeNull()
  })

  it('仍被笔记引用的文件不直接删,先回一份引用清单等确认', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const a = await upload(token, 'pic.png')
    // 笔记正文引用该附件 → syncArticleFiles 会登记 article_files
    await newArticle(token, nb, '带图的笔记', `正文\n\n![图](/api/files/${a.key})\n`)

    const first = await batch<{ needs_force: boolean; referenced: { id: number; refs: number }[] }>(
      token, { op: 'delete', ids: [a.id] },
    )
    expect(first.body.ok, first.body.error).toBe(true)
    expect(first.body.data!.needs_force).toBe(true)
    expect(first.body.data!.referenced.map((r) => r.id)).toEqual([a.id])
    // 没确认之前,文件必须还在
    expect(await listFiles(token)).toHaveLength(1)

    const forced = await batch<{ deleted: number }>(token, { op: 'delete', ids: [a.id], force: true })
    expect(forced.body.data!.deleted).toBe(1)
    expect(await listFiles(token)).toHaveLength(0)
  })

  it('空选、超上限、未知操作各自被挡住', async () => {
    const token = await bootstrap()
    expect((await batch(token, { op: 'move', ids: [] })).status).toBe(400)
    expect((await batch(token, { op: 'move', ids: Array.from({ length: 201 }, (_, i) => i + 1) })).status).toBe(400)

    const a = await upload(token, 'a.txt')
    const bad = await batch(token, { op: 'archive', ids: [a.id] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('archive')
  })

  it('别人的文件 id 打不动(鉴权按 user_id 过滤,不是靠前端不给按钮)', async () => {
    const token = await bootstrap()
    const a = await upload(token, 'a.txt')
    // 手工插一行属于 user_id=999 的文件,再拿本人的 token 去批量删
    await env.DB.prepare(
      "INSERT INTO files (user_id, key, name, size, content_type, category) VALUES (999, 'u999/x/other.txt', 'other.txt', 5, 'text/plain', 'other')",
    ).run()
    const other = await env.DB.prepare("SELECT id FROM files WHERE user_id = 999").first<{ id: number }>()

    const res = await batch<{ deleted: number }>(token, { op: 'delete', ids: [a.id, other!.id] })
    expect(res.body.data!.deleted).toBe(1)
    const left = await env.DB.prepare('SELECT COUNT(*) AS c FROM files WHERE user_id = 999').first<{ c: number }>()
    expect(left!.c).toBe(1)
  })
})

// P14.2:私密文件夹对匿名访问是一票否决(files.ts anonReadable),所以把正被公开文章
// 引用的附件挪进去 = 博客上那张图当场变裂图。此前这个动作是静默成功的。
describe('移进私密文件夹前的公开引用预检', () => {
  beforeEach(dropAll)

  /** 「我的私密文件夹」由 overview 懒创建 */
  async function privateFolder(token: string): Promise<number> {
    const ov = await api<{ folders: { id: number; name: string; is_private?: number }[] }>('/api/fm/overview', { token })
    expect(ov.body.ok, ov.body.error).toBe(true)
    const p = (ov.body.data!.folders || []).find((f) => f.is_private)
    expect(p, '私密文件夹没有被懒创建').toBeTruthy()
    return p!.id
  }

  /** 传一张图,写进一篇笔记的正文里(走真正的引用索引,不手工插 article_files) */
  async function publishedWith(token: string, fileName: string, title: string, isPublic = true) {
    const nb = await newNotebook(token)
    const f = await upload(token, fileName)
    const art = await newArticle(token, nb, title, `正文\n\n![](${buildAfileUrl(f.id, f.name)})`)
    if (isPublic) {
      const pub = await api(`/api/articles/${art}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
      expect(pub.body.ok, pub.body.error).toBe(true)
    }
    return { file: f, article: art }
  }

  it('拦住并给出会失效的公开文章清单,文件一动不动', async () => {
    const token = await bootstrap()
    const priv = await privateFolder(token)
    const { file } = await publishedWith(token, '封面.png', '已发布的文章')

    const res = await batch<{ needs_force: boolean; public_refs: any[] }>(token, {
      op: 'move', ids: [file.id], folder_id: priv,
    })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.needs_force).toBe(true)
    expect(res.body.data!.public_refs).toHaveLength(1)
    expect(res.body.data!.public_refs[0].name).toBe('封面.png')
    expect(res.body.data!.public_refs[0].articles[0].title).toBe('已发布的文章')

    // 关键:被拦下时不能已经移过去了
    const after = await listFiles(token)
    expect(after.find((f) => f.id === file.id)!.folder_id).toBeNull()
  })

  it('确认之后才真的移进去', async () => {
    const token = await bootstrap()
    const priv = await privateFolder(token)
    const { file } = await publishedWith(token, '封面.png', '已发布的文章')

    const res = await batch<{ moved: number }>(token, { op: 'move', ids: [file.id], folder_id: priv, force: true })
    expect(res.body.data!.moved).toBe(1)
    const after = await listFiles(token)
    expect(after.find((f) => f.id === file.id)!.folder_id).toBe(priv)
  })

  it('只被未公开的笔记引用就不拦(访客本来也看不见)', async () => {
    const token = await bootstrap()
    const priv = await privateFolder(token)
    const { file } = await publishedWith(token, '草稿图.png', '还没发布', false)

    const res = await batch<{ moved: number }>(token, { op: 'move', ids: [file.id], folder_id: priv })
    expect(res.body.data!.moved).toBe(1)
  })

  it('移进普通文件夹不拦;私密目录之间互相搬也不拦', async () => {
    const token = await bootstrap()
    const priv = await privateFolder(token)
    const normal = await newFolder(token, '素材')
    const { file } = await publishedWith(token, '封面.png', '已发布的文章')

    expect((await batch<{ moved: number }>(token, { op: 'move', ids: [file.id], folder_id: normal })).body.data!.moved).toBe(1)

    // 先强行放进私密,再在私密子树内部搬:可见性没有任何变化,不该再问一遍
    await batch(token, { op: 'move', ids: [file.id], folder_id: priv, force: true })
    const sub = await api<{ id: number }>('/api/fm/folders', {
      method: 'POST', token, body: j({ name: '私密子目录', parent_id: priv }),
    })
    const res = await batch<{ moved: number }>(token, { op: 'move', ids: [file.id], folder_id: sub.body.data!.id })
    expect(res.body.data!.moved).toBe(1)
  })

  it('单个文件的移动走同一条规矩', async () => {
    const token = await bootstrap()
    const priv = await privateFolder(token)
    const { file } = await publishedWith(token, '封面.png', '已发布的文章')

    const blocked = await api<{ needs_force: boolean; public_refs: any[] }>(`/api/fm/files/${file.id}`, {
      method: 'PUT', token, body: j({ folder_id: priv }),
    })
    expect(blocked.body.data!.needs_force).toBe(true)
    expect((await listFiles(token)).find((f) => f.id === file.id)!.folder_id).toBeNull()

    const forced = await api(`/api/fm/files/${file.id}`, {
      method: 'PUT', token, body: j({ folder_id: priv, force: true }),
    })
    expect(forced.body.ok, forced.body.error).toBe(true)
    expect((await listFiles(token)).find((f) => f.id === file.id)!.folder_id).toBe(priv)
  })

  it('整个目录搬进私密子树时,连子目录里的文件一起算', async () => {
    const token = await bootstrap()
    const priv = await privateFolder(token)
    const outer = await newFolder(token, '外层')
    const inner = await api<{ id: number }>('/api/fm/folders', {
      method: 'POST', token, body: j({ name: '内层', parent_id: outer }),
    })
    const { file } = await publishedWith(token, '深处的图.png', '已发布的文章')
    await batch(token, { op: 'move', ids: [file.id], folder_id: inner.body.data!.id, force: true })

    const blocked = await api<{ needs_force: boolean; public_refs: any[] }>(`/api/fm/folders/${outer}`, {
      method: 'PUT', token, body: j({ parent_id: priv }),
    })
    expect(blocked.body.data!.needs_force).toBe(true)
    expect(blocked.body.data!.public_refs[0].name).toBe('深处的图.png')
    // 目录也不能已经搬过去了
    const fd = await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(outer).first<{ parent_id: number | null }>()
    expect(fd!.parent_id).toBeNull()

    const forced = await api(`/api/fm/folders/${outer}`, {
      method: 'PUT', token, body: j({ parent_id: priv, force: true }),
    })
    expect(forced.body.ok, forced.body.error).toBe(true)
  })
})
