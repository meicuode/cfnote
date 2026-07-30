import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

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
