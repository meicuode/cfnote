// 图片降采样:限宽重绘为小尺寸 PNG,用于 XMind 缩略图。
// 画布原尺寸截图可能有几 MB,直接嵌入 zip / 上传边车会让文件体积大幅膨胀,
// 统一缩到 maxWidth 宽、白底(避免透明底在深色模式下发黑),并由调用方配合大小上限使用。
export async function downscaleToPng(src: Blob | string, maxWidth = 480): Promise<Uint8Array | null> {
  let objectUrl: string | null = null
  try {
    const url = typeof src === 'string' ? src : (objectUrl = URL.createObjectURL(src))
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('图片解码失败'))
      i.src = url
    })
    const w0 = img.naturalWidth || 1
    const h0 = img.naturalHeight || 1
    const scale = Math.min(1, maxWidth / w0)
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    if (!b64) return null
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch {
    return null
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

// 缩略图字节数上限:超过就放弃(缩略图只是锦上添花,不值得让 .xmind 文件膨胀)
export const THUMB_MAX_BYTES = 512 * 1024
