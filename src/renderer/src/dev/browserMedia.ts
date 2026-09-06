import type { MediaAsset, MediaImportResult } from '@shared/types'
import {
  buildImageSplitTiles,
  parseImageSplitConfig,
  type ImageSplitConfig
} from '@shared/image-split'
import {
  parseImageCropConfig,
  validateImageCropConfig,
  type ImageCropConfig
} from '@shared/image-crop'

/** Session-local media for browser UI testing; Electron keeps its disk-backed adapter. */
export function createBrowserMedia(): {
  list: (projectId: string) => MediaAsset[]
  pick: (projectId: string) => Promise<MediaImportResult>
  addFiles: (projectId: string, files: File[]) => Promise<MediaImportResult>
  addBuffer: (
    projectId: string,
    input: { name: string; mime: string; data: Uint8Array }
  ) => Promise<MediaAsset>
  splitImage: (
    projectId: string,
    sourceMediaId: string,
    config: ImageSplitConfig
  ) => Promise<MediaAsset[]>
  cropImage: (
    projectId: string,
    sourceMediaId: string,
    config: ImageCropConfig
  ) => Promise<MediaAsset>
  createGeneratedImage: (projectId: string, prompt: string, size?: string) => Promise<MediaAsset>
  remove: (id: string) => boolean
} {
  const storageKey = 'canvas-studio.browser-demo.media.v1'
  const readSession = (): Record<string, MediaAsset[]> => {
    try {
      const raw = window.sessionStorage.getItem(storageKey)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(parsed).flatMap(([projectId, assets]) =>
          Array.isArray(assets) ? [[projectId, assets as MediaAsset[]]] : []
        )
      )
    } catch {
      return {}
    }
  }
  const projects = new Map<string, MediaAsset[]>(Object.entries(readSession()))
  const persist = (): void => {
    try {
      // 仅当前 tab 的演示媒体；不落磁盘、不保存 API Key，也不参与 Electron 项目存储。
      window.sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(projects)))
    } catch {
      // 大文件可能超过 sessionStorage 容量；保留当前页面里的 blob URL，不能让导入失败。
    }
  }
  const list = (projectId: string): MediaAsset[] => projects.get(projectId) ?? []

  const filePath = async (file: File): Promise<string> => {
    // 小型验收素材序列化为 data URL，刷新后仍可显示、裁剪和拆分。大文件只在当前页保留，
    // 避免浏览器演示页占满 sessionStorage；真实生产媒体始终由 Electron 主进程持久化。
    if (file.size > 2 * 1024 * 1024) return URL.createObjectURL(file)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('无法读取媒体'))
      reader.onerror = () => reject(reader.error ?? new Error('无法读取媒体'))
      reader.readAsDataURL(file)
    })
  }

  async function addFiles(projectId: string, files: File[]): Promise<MediaImportResult> {
    const result: MediaImportResult = { assets: [], errors: [] }
    for (const file of files) {
      try {
        const kind = file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('video/')
            ? 'video'
            : file.type.startsWith('audio/')
              ? 'audio'
              : 'file'
        const textContent =
          /\.(txt|md|json)$/i.test(file.name) && file.size <= 1024 * 1024
            ? await file.text()
            : undefined
        const asset: MediaAsset = {
          id: crypto.randomUUID(),
          kind,
          mime: file.type || 'application/octet-stream',
          path: await filePath(file),
          sizeBytes: file.size,
          createdAt: Date.now(),
          name: file.name.replace(/\.[^.]+$/, ''),
          textContent
        }
        projects.set(projectId, [...list(projectId), asset])
        persist()
        result.assets.push(asset)
      } catch (error) {
        result.errors.push({ path: file.name, reason: String(error) })
      }
    }
    return result
  }

  async function addBuffer(
    projectId: string,
    input: { name: string; mime: string; data: Uint8Array }
  ): Promise<MediaAsset> {
    const bytes = new Uint8Array(input.data)
    const file = new File([bytes.buffer], input.name || '导入文件', {
      type: input.mime || 'application/octet-stream'
    })
    const result = await addFiles(projectId, [file])
    const asset = result.assets[0]
    if (!asset) throw new Error(result.errors[0]?.reason ?? '浏览器媒体导入失败')
    return asset
  }

  const imageSource = (projectId: string, sourceMediaId: string): MediaAsset => {
    const source = list(projectId).find((asset) => asset.id === sourceMediaId)
    if (!source || source.kind !== 'image') {
      throw new Error('输入图片不存在，或不属于当前浏览器项目')
    }
    return source
  }

  const loadImage = async (
    source: MediaAsset
  ): Promise<{ image: HTMLImageElement; release: () => void }> => {
    // blob: URL 已由 addFiles 注册并被卡片预览使用；直接交给 Image 解码比 fetch(blob:)
    // 更稳定（部分受控浏览器上下文会拒绝 fetch 自己创建的 blob URL）。
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('浏览器无法解码输入图片'))
      element.src = source.path
    })
    return { image, release: () => undefined }
  }

  const saveCanvas = async (
    projectId: string,
    canvas: HTMLCanvasElement,
    name: string
  ): Promise<MediaAsset> => {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('浏览器无法编码图片'))),
        'image/png'
      )
    )
    const result = await addFiles(projectId, [
      new File([blob], `${name}.png`, { type: 'image/png' })
    ])
    const asset = result.assets[0]
    if (!asset) throw new Error(result.errors[0]?.reason ?? '浏览器图片保存失败')
    return asset
  }

  async function splitImage(
    projectId: string,
    sourceMediaId: string,
    rawConfig: ImageSplitConfig
  ): Promise<MediaAsset[]> {
    const source = imageSource(projectId, sourceMediaId)
    const { image, release } = await loadImage(source)
    try {
      const config = parseImageSplitConfig(JSON.stringify(rawConfig))
      const tiles = buildImageSplitTiles(config)
      const output: MediaAsset[] = []
      for (const tile of tiles) {
        const sx = Math.floor(tile.rect.x * image.naturalWidth)
        const sy = Math.floor(tile.rect.y * image.naturalHeight)
        const sw = Math.max(1, Math.floor(tile.rect.width * image.naturalWidth))
        const sh = Math.max(1, Math.floor(tile.rect.height * image.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = sw
        canvas.height = sh
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法创建图片拆分画布')
        context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
        output.push(await saveCanvas(projectId, canvas, `拆分图-R${tile.row}C${tile.column}`))
      }
      return output
    } finally {
      release()
    }
  }

  async function cropImage(
    projectId: string,
    sourceMediaId: string,
    rawConfig: ImageCropConfig
  ): Promise<MediaAsset> {
    const config = parseImageCropConfig(JSON.stringify(rawConfig))
    const invalid = validateImageCropConfig(config)
    if (invalid) throw new Error(invalid)
    if (config.mode !== 'rect') {
      throw new Error('浏览器验收页暂不提供透视裁剪；请切换为矩形裁剪，桌面端支持透视裁剪')
    }
    const { image, release } = await loadImage(imageSource(projectId, sourceMediaId))
    try {
      const sourceX = Math.floor(image.naturalWidth * config.rect.x)
      const sourceY = Math.floor(image.naturalHeight * config.rect.y)
      const sourceW = Math.max(1, Math.floor(image.naturalWidth * config.rect.width))
      const sourceH = Math.max(1, Math.floor(image.naturalHeight * config.rect.height))
      const canvas = document.createElement('canvas')
      canvas.width = sourceW
      canvas.height = sourceH
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法创建图片裁剪画布')
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH)
      return saveCanvas(projectId, canvas, '裁剪图片')
    } finally {
      release()
    }
  }

  async function createGeneratedImage(
    projectId: string,
    prompt: string,
    rawSize?: string
  ): Promise<MediaAsset> {
    // 让验收环境也能呈现统一运行器的“生成中”状态，而不是同步完成后瞬间跳成结果。
    // 真实服务不会走这条浏览器演示实现。
    await new Promise<void>((resolve) => window.setTimeout(resolve, 650))
    const sizeMatch = (rawSize ?? '').match(/(\d+)\s*[x×]\s*(\d+)/i)
    const rawWidth = Number(sizeMatch?.[1])
    const rawHeight = Number(sizeMatch?.[2])
    const width = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.min(1536, rawWidth) : 1024
    const height = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.min(1536, rawHeight) : 1024
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建演示生图画布')
    const hue = Array.from(prompt).reduce((total, char) => (total + char.charCodeAt(0)) % 360, 202)
    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, `hsl(${hue} 72% 32%)`)
    gradient.addColorStop(0.52, `hsl(${(hue + 42) % 360} 66% 18%)`)
    gradient.addColorStop(1, '#101622')
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
    context.fillStyle = 'rgba(255,255,255,.15)'
    context.beginPath()
    context.arc(width * 0.72, height * 0.3, Math.min(width, height) * 0.2, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#f7fbff'
    context.font = `600 ${Math.max(24, Math.round(Math.min(width, height) / 20))}px sans-serif`
    context.fillText('浏览器演示生图', width * 0.1, height * 0.18)
    context.fillStyle = 'rgba(247,251,255,.78)'
    context.font = `400 ${Math.max(18, Math.round(Math.min(width, height) / 32))}px sans-serif`
    const label = prompt.trim().slice(0, 42) || '未命名提示词'
    context.fillText(label, width * 0.1, height * 0.27, width * 0.8)
    return saveCanvas(projectId, canvas, '浏览器演示生图')
  }

  function pick(projectId: string): Promise<MediaImportResult> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.hidden = true
      const finish = (result: MediaImportResult): void => {
        input.remove()
        resolve(result)
      }
      input.addEventListener('cancel', () => finish({ assets: [], errors: [] }), { once: true })
      input.addEventListener(
        'change',
        () => {
          void addFiles(projectId, Array.from(input.files ?? [])).then(finish)
        },
        { once: true }
      )
      document.body.append(input)
      input.click()
    })
  }

  function remove(id: string): boolean {
    for (const [projectId, assets] of projects) {
      const asset = assets.find((item) => item.id === id)
      if (!asset) continue
      if (asset.path.startsWith('blob:')) URL.revokeObjectURL(asset.path)
      projects.set(
        projectId,
        assets.filter((item) => item.id !== id)
      )
      persist()
      return true
    }
    return false
  }
  return { list, pick, addFiles, addBuffer, splitImage, cropImage, createGeneratedImage, remove }
}
