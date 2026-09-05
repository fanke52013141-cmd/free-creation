import type { MediaAsset, MediaImportResult } from '@shared/types'
import {
  buildImageSplitTiles,
  parseImageSplitConfig,
  type ImageSplitConfig
} from '@shared/image-split'

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
  remove: (id: string) => boolean
} {
  const projects = new Map<string, MediaAsset[]>()
  const list = (projectId: string): MediaAsset[] => projects.get(projectId) ?? []

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
          path: URL.createObjectURL(file),
          sizeBytes: file.size,
          createdAt: Date.now(),
          name: file.name.replace(/\.[^.]+$/, ''),
          textContent
        }
        projects.set(projectId, [...list(projectId), asset])
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

  async function splitImage(
    projectId: string,
    sourceMediaId: string,
    rawConfig: ImageSplitConfig
  ): Promise<MediaAsset[]> {
    const source = list(projectId).find((asset) => asset.id === sourceMediaId)
    if (!source || source.kind !== 'image')
      throw new Error('输入图片不存在，或不属于当前浏览器项目')
    const blob = await fetch(source.path).then((response) => response.blob())
    const objectUrl = URL.createObjectURL(blob)
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('浏览器无法解码输入图片'))
      element.src = objectUrl
    })
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
        const tileBlob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error('浏览器无法编码拆分图片'))),
            'image/png'
          )
        )
        const result = await addFiles(projectId, [
          new File([tileBlob], `拆分图-R${tile.row}C${tile.column}.png`, { type: 'image/png' })
        ])
        const asset = result.assets[0]
        if (!asset) throw new Error(result.errors[0]?.reason ?? '拆分图片保存失败')
        output.push(asset)
      }
      return output
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
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
      URL.revokeObjectURL(asset.path)
      projects.set(
        projectId,
        assets.filter((item) => item.id !== id)
      )
      return true
    }
    return false
  }
  return { list, pick, addFiles, addBuffer, splitImage, remove }
}
