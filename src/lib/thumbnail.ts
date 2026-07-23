// 图片降采样:限宽重绘为小尺寸图片,用于 XMind 缩略图与节点内嵌图片。
// 画布/照片原尺寸可能有几 MB,直接嵌入 zip / 上传边车会让文件体积大幅膨胀,
// 统一缩到 maxWidth 宽、白底(避免透明底在深色模式下发黑、JPEG 无透明通道)。

export interface DownscaledImage {
  dataUrl: string
  width: number
  height: number
}

export async function downscaleToDataUrl(
  src: Blob | string,
  maxWidth = 480,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.8
): Promise<DownscaledImage | null> {
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
    const dataUrl = canvas.toDataURL(mime, quality)
    if (!dataUrl.includes(',')) return null
    return { dataUrl, width: w, height: h }
  } catch {
    return null
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

// XMind 缩略图专用:PNG 字节
export async function downscaleToPng(src: Blob | string, maxWidth = 480): Promise<Uint8Array | null> {
  const out = await downscaleToDataUrl(src, maxWidth, 'image/png')
  const b64 = out?.dataUrl.split(',')[1]
  if (!b64) return null
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// 缩略图字节数上限:超过就放弃(缩略图只是锦上添花,不值得让 .xmind 文件膨胀)
export const THUMB_MAX_BYTES = 512 * 1024

// 节点内嵌图片:JPEG 压缩(0.8/限宽 400px),显著控制 .xmind 体积
export const NODE_IMAGE_MAX_WIDTH = 400
export const downscaleForNode = (src: Blob | string) =>
  downscaleToDataUrl(src, NODE_IMAGE_MAX_WIDTH, 'image/jpeg', 0.8)
