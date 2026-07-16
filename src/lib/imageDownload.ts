function extensionFor(mimeType: string, source: string): string {
  if (mimeType.includes('jpeg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  if (mimeType.includes('png')) return 'png'
  const match = source.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)
  return match?.[1]?.toLowerCase() || 'png'
}

/** Save either a persisted data URL or a remote image without exposing the
 * internal generator prompt. Remote images are first copied to a local blob
 * so cross-origin URLs do not simply navigate the WebView away from the app. */
export async function downloadImageSource(source: string, basename = `talk-image-${Date.now()}`): Promise<void> {
  let href = source
  let mimeType = source.startsWith('data:') ? source.slice(5, source.indexOf(';')) : ''
  let objectUrl: string | undefined
  if (!source.startsWith('data:')) {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    if (!blob.size || !blob.type.startsWith('image/')) throw new Error('下载内容不是有效图片')
    mimeType = blob.type
    objectUrl = URL.createObjectURL(blob)
    href = objectUrl
  }
  try {
    const link = document.createElement('a')
    link.href = href
    link.download = `${basename}.${extensionFor(mimeType, source)}`
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  }
}
