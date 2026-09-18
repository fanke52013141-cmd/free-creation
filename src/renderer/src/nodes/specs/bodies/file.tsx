// 文件资产节点 Body（用户 2026-09-18 拍板新增）：
// 与图片 / 音频 / 视频资产节点同构——导入本地文档，只负责保存、展示和向下游输出。
// Excel / Word / PDF 等二进制文档不在这里解析，只把原始文件作为 file 资产暴露；
// 可解析为文本的 txt / md / json / csv 会把内容写入 props.text，供文本类下游直接使用。
import { useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { MediaFileActions } from './shared'

/** 可直接内联为文本的扩展名；与主进程 TEXT_EXTS 保持一致的语义。 */
const TEXT_EXTS = ['.txt', '.md', '.markdown', '.json', '.csv']

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index).toLowerCase() : ''
}

export function FileBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const [busy, setBusy] = useState(false)

  const chooseAsset = async (): Promise<void> => {
    if (!project) return
    setBusy(true)
    try {
      const res = await window.api.pickMedia(project.id)
      if (!res.ok) {
        toast(`导入失败：${res.error.message}`)
        return
      }
      if (res.data.assets.length === 0 && res.data.errors.length === 0) return
      const asset = res.data.assets.find((item) => item.kind === 'file')
      if (!asset) {
        toast('请选择一个文档文件（Excel / Word / PDF / Markdown 等）')
        return
      }
      // 可解析文本的文档把内容写进 props.text：文本类下游无需再猜文件内容。
      const text = typeof asset.textContent === 'string' ? asset.textContent : ''
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: {
          title: asset.name || '文件',
          mediaId: asset.id,
          mediaPath: asset.path,
          mediaMime: asset.mime,
          text
        }
      })
      markUndoPoint(editor, 'file-asset-import')
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty file-asset-empty">
        <Icon name="document" size={40} />
        <span>文件资产</span>
        <button
          className="btn-ghost file-import-button"
          disabled={busy}
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void chooseAsset()
          }}
        >
          {busy ? '导入中…' : '导入文件'}
        </button>
      </div>
    )
  }

  const extension = extensionOf(shape.props.mediaPath)
  const inlineText = TEXT_EXTS.includes(extension) ? shape.props.text : ''
  const lineCount = inlineText ? inlineText.split('\n').length : 0

  return (
    <div className="file-asset">
      <div className="file-asset-head">
        <span className="file-asset-icon">
          <Icon name="document" size={18} />
        </span>
        <span className="file-asset-meta">
          <span className="file-asset-name" title={shape.props.title}>
            {shape.props.title}
          </span>
          <span className="file-asset-sub">
            {extension ? extension.replace('.', '').toUpperCase() : '文件'}
            {shape.props.mediaMime ? ` · ${shape.props.mediaMime}` : ''}
            {lineCount ? ` · ${lineCount} 行` : ''}
          </span>
        </span>
        <MediaFileActions shape={shape} />
      </div>
      {inlineText ? (
        <pre className="file-asset-preview" title="文件内容预览">
          {inlineText.length > 4000 ? `${inlineText.slice(0, 4000)}\n…` : inlineText}
        </pre>
      ) : (
        <div className="file-asset-binary">
          <Icon name="document" size={26} />
          <span>该格式不在画布内解析</span>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void window.api.openMedia(shape.props.mediaId)
            }}
          >
            用系统程序打开
          </button>
        </div>
      )}
      <div className="node-media-next-actions" aria-label="文件后续操作">
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void chooseAsset()
          }}
        >
          替换
        </button>
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void window.api.revealMedia(shape.props.mediaId)
          }}
        >
          定位
        </button>
      </div>
    </div>
  )
}
