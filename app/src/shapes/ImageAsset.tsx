import { BaseBoxShapeUtil, T, useEditor, type RecordProps } from 'tldraw'
import type { ImageAssetShape } from './types'
import { IMAGE_ASSET_TYPE } from './types'
import { markNodeAndDependentsDirty } from './dependencies'
import { useCanvasProjectId } from '../components/projectContext'
import { importProjectImage, uploadProjectAsset } from '../services/gateway'
import { useState } from 'react'

export class ImageAssetUtil extends BaseBoxShapeUtil<ImageAssetShape> {
  static override type = IMAGE_ASSET_TYPE
  static override props: RecordProps<ImageAssetShape> = { w: T.number, h: T.number, title: T.string, sourceUrl: T.string, lastError: T.string }
  override getDefaultProps(): ImageAssetShape['props'] {
    return { w: 360, h: 360, title: '图片资产', sourceUrl: '', lastError: '' }
  }
  component(shape: ImageAssetShape) { return <ImageAssetComponent shape={shape} /> }
  getIndicatorPath(shape: ImageAssetShape) { const path = new Path2D(); path.roundRect(0, 0, shape.props.w, shape.props.h, 10); return path }
}

function ImageAssetComponent({ shape }: { shape: ImageAssetShape }) {
  const editor = useEditor()
  const projectId = useCanvasProjectId()
  const update = (patch: Partial<ImageAssetShape['props']>) => editor.updateShape({ id: shape.id, type: IMAGE_ASSET_TYPE, props: patch })
  const [urlDraft, setUrlDraft] = useState(shape.props.sourceUrl.startsWith('/assets/') ? '' : shape.props.sourceUrl)
  const hasSource = Boolean(shape.props.sourceUrl.trim())
  const uploadImage = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return update({ lastError: '仅支持图片文件。' })
    update({ lastError: '' })
    try {
      const asset = await uploadProjectAsset(projectId, file)
      update({ title: file.name, sourceUrl: asset.url, lastError: '' })
      markNodeAndDependentsDirty(editor, shape.id, false)
    } catch (error) {
      update({ lastError: error instanceof Error ? error.message : String(error) })
    }
  }
  const importUrl = async () => {
    if (!urlDraft.trim()) return
    update({ lastError: '' })
    try {
      const asset = await importProjectImage(projectId, urlDraft.trim())
      update({ sourceUrl: asset.url, lastError: '' })
      setUrlDraft('')
      markNodeAndDependentsDirty(editor, shape.id, false)
    } catch (error) {
      update({ lastError: error instanceof Error ? error.message : String(error) })
    }
  }
  return <div style={{ pointerEvents: 'all' }} className="w-full h-full flex flex-col node-card node-card-image">
    <header onPointerDown={(event) => event.stopPropagation()} className="node-header">
      <span className="node-kicker">◫</span><input value={shape.props.title} onChange={(event) => update({ title: event.target.value })} className="node-title" />
    </header>
    <div onPointerDown={(event) => event.stopPropagation()} className="node-config">
      <div className="flex gap-1.5"><input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} placeholder={shape.props.sourceUrl ? '图片已保存，可粘贴新地址替换' : '粘贴公开图片 URL'} className="min-w-0 flex-1 p-1.5 text-xs border rounded outline-none focus:border-cyan-500" /><button onClick={() => void importUrl()} disabled={!urlDraft.trim()} className="rounded bg-cyan-600 px-2 text-[11px] text-white disabled:bg-neutral-300">入库</button></div>
      <label className="mt-1.5 inline-flex items-center text-[11px] text-cyan-700 cursor-pointer hover:text-cyan-900">上传并保存到项目<input type="file" accept="image/*" onChange={(event) => void uploadImage(event.target.files?.[0])} className="sr-only" /></label>
    </div>
    <div onPointerDown={(event) => event.stopPropagation()} className="node-body node-media-body flex items-center justify-center">
      {hasSource ? <img src={shape.props.sourceUrl} onError={() => { if (!shape.props.lastError) update({ lastError: '图片地址无法加载或被跨域策略拦截' }) }} className="max-w-full max-h-full object-contain" /> : <p className="text-xs text-neutral-400">粘贴 URL 后作为 Image 输出</p>}
    </div>
    {shape.props.lastError && <div className="node-error">⚠ {shape.props.lastError}</div>}
  </div>
}
