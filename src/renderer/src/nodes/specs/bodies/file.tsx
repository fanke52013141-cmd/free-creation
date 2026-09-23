// 文件资产节点 Body（用户 2026-09-18 拍板新增）：
// 与图片 / 音频 / 视频资产节点同构——导入本地文档，只负责保存、展示和向下游输出。
// 纯文本、Office（Word/Excel/PPT）与 PDF 在导入时由主进程抽出正文写入 props.text，供文本类
// 下游直接使用；旧版 .doc/.xls/.ppt 与无文字层的扫描件不解析，节点会如实显示并给出系统程序打开入口。
import { useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { useAppStore } from '../../../stores/app'
import { Icon } from '../../../components/Icon'
import { MediaFileActions, pickImportedAsset } from './shared'
import { BINARY_DOC_EXTS, INLINE_TEXT_EXTS, extensionForMime } from '@shared/mime'

/** 能内联出正文的格式；与主进程 media.repo 的 textContent 判定共用同一份清单。 */
const PARSABLE_EXTS = [...INLINE_TEXT_EXTS, ...BINARY_DOC_EXTS]

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index).toLowerCase() : ''
}

/**
 * 节点上的扩展名以媒体路径为准；路径不带扩展名（浏览器验收页把小文件存成 data URL）时
 * 回落到 mime，否则支持的文档会被说成「该格式不在画布内解析」。
 */
function extensionOfAsset(mediaPath: string, mime: string): string {
  const fromPath = extensionOf(mediaPath)
  // data:application/pdf;base64,... 这类 URL 里 lastIndexOf('.') 会命中错误位置，只认真扩展名。
  if (PARSABLE_EXTS.includes(fromPath) || /^\.[a-z0-9]{1,5}$/.test(fromPath)) return fromPath
  return extensionForMime(mime)
}

export function FileBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const [busy, setBusy] = useState(false)

  const chooseAsset = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    setBusy(true)
    try {
      const res = await window.api.pickMedia(project.id)
      if (!res.ok) {
        toast(`导入失败：${res.error.message}`)
        return
      }
      const asset = pickImportedAsset({
        result: res.data,
        kind: 'file',
        noun: '一个文档',
        mismatch: '请选择一个文档文件（Excel / Word / PDF / Markdown 等）',
        projectId: project.id
      })
      if (!asset) return
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
        <small className="file-supported-formats">
          可抽取文字：PDF、DOCX、XLSX、PPTX、TXT、Markdown
        </small>
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

  const extension = extensionOfAsset(shape.props.mediaPath, shape.props.mediaMime)
  const parsable = PARSABLE_EXTS.includes(extension)
  const inlineText = parsable ? shape.props.text : ''
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
          <span>{parsable ? '未抽出文字：扫描件、纯图文或文件过大' : '该格式不在画布内解析'}</span>
          {parsable && <small>下游 out-text 会是空的，先用系统程序确认文件里有可选中的文字</small>}
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
