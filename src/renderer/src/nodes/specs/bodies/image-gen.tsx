// 生图节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { PROVIDER_SPECS } from '@shared/types'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import {
  createImageContinuation,
  clearSelectedMediaHistory,
  MediaFileActions,
  MediaResultGrid,
  removeMediaResultFromShape,
  MediaSourceBadge,
  selectMediaResult,
  ModelSelect,
  NoModelHint,
  useClickGuard,
  parseJsonProp
} from './shared'

interface ImageGenData {
  prompt: string
  modelKey: string
  size: string
  seed?: number
}

function parseImageGen(text: string): ImageGenData {
  return parseJsonProp(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null && typeof o.prompt === 'string') {
        return {
          prompt: o.prompt,
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          size: typeof o.size === 'string' ? o.size : 'auto',
          seed: typeof o.seed === 'number' ? o.seed : undefined
        }
      }
      return null
    },
    { prompt: '', modelKey: '', size: 'auto', seed: undefined }
  )
}

const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']

export function ImageGenerateBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'image')
  const data = parseImageGen(readNodeConfig(shape))
  const [draft, setDraft] = useState(data.prompt)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: ImageGenData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
    })
  }

  const refImage = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')

  const generate = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    // 先提交本次编辑，再由统一运行器读取节点配置和真实上游端口输入。
    update({ ...data, prompt: draft })
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }

  if (shape.props.mediaPath) {
    const chooseResult = (item: Parameters<typeof selectMediaResult>[1]): void => {
      const selected = selectMediaResult(shape, item)
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: selected.props,
        meta: { ...(shape.meta ?? {}), nodeResult: selected.nodeResult }
      })
      markUndoPoint(editor, 'image-select-result')
    }
    return (
      <div className="node-media-wrap">
        <div
          className="node-media"
          onPointerDown={guard.onPointerDown}
          onClick={(e) =>
            guard.onClick(e, () =>
              openPreview({
                kind: 'image',
                url: mediaUrl(shape.props.mediaPath),
                title: shape.props.title
              })
            )
          }
        >
          <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
        </div>
        <div className="node-media-actions">
          <button
            className="btn-ghost small"
            disabled={busy}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              // 重新生成：清空成片，回到配置面板重新跑一遍
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                props: { mediaId: '', mediaPath: '', mediaMime: '' }
              })
              markUndoPoint(editor, 'image-regenerate')
            }}
          >
            <Icon name="reset" size={13} />
            重新生成
          </button>
          <MediaSourceBadge shape={shape} fallback="AI 生成" />
          <MediaFileActions shape={shape} />
        </div>
        <div className="node-media-next-actions" aria-label="图片后续操作">
          <button
            className="btn-ghost small"
            title="创建裁剪节点并连接当前结果"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createImageContinuation(editor, shape, 'image-crop')
            }}
          >
            <Icon name="crop" size={12} /> 裁剪图片
          </button>
          <button
            className="btn-ghost small"
            title="基于当前结果继续生图"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createImageContinuation(editor, shape, 'image-gen')
            }}
          >
            <Icon name="spark" size={12} /> 继续生图
          </button>
          <button
            className="btn-ghost small"
            title="对当前结果添加标注并修改"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createImageContinuation(editor, shape, 'image-edit')
            }}
          >
            <Icon name="edit" size={12} /> 修改图片
          </button>
          <button
            className="btn-ghost small"
            title="将当前结果作为首帧生成视频"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createImageContinuation(editor, shape, 'video')
            }}
          >
            <Icon name="video" size={12} /> 生成视频
          </button>
        </div>
        <MediaResultGrid
          shape={shape}
          kind="image"
          onSelect={chooseResult}
          onDelete={(item) => {
            const nodeResult = removeMediaResultFromShape(shape, item)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'image-delete-result')
          }}
          onClear={() => {
            const nodeResult = clearSelectedMediaHistory(shape)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'image-clear-result-history')
          }}
          openPreview={(item) =>
            openPreview({ kind: 'image', url: mediaUrl(item.mediaPath), title: shape.props.title })
          }
        />
      </div>
    )
  }

  if (!options.length) return <NoModelHint onOpen={openSettings} />

  return (
    <div className="gen-panel">
      {(() => {
        const sel = options.find((o) => o.key === data.modelKey)
        const spec = sel ? PROVIDER_SPECS.find((s) => s.id === sel.provider.specId) : undefined
        const notes = [
          spec ? spec.desc : '',
          refImage ? '参考图：已连接' : '参考图：可连上游图片',
          typeof data.seed === 'number' ? '种子：固定' : '种子：随机'
        ].filter(Boolean)
        return notes.length > 0 ? (
          <div className="gen-capability-note">
            <Icon name="info" size={13} />
            <span>{notes.join(' · ')}</span>
          </div>
        ) : null
      })()}
      {refImage && (
        <div className="ref-image-bar">
          <img
            src={mediaUrl(refImage.mediaPath)}
            className="ref-image-thumb"
            draggable={false}
            alt="参考图"
          />
          <span className="ref-image-label">
            <Icon name="attach" size={13} />
            参考图已连接
          </span>
        </div>
      )}
      <div className="gen-row">
        <ModelSelect
          value={data.modelKey}
          options={options}
          onChange={(key) => update({ ...data, modelKey: key })}
        />
        <select
          className="gen-select w92"
          value={data.size}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, size: e.target.value })}
        >
          {IMAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s === 'auto' ? '默认尺寸' : s}
            </option>
          ))}
        </select>
        <input
          className="gen-seed"
          type="number"
          placeholder="种子"
          value={data.seed ?? ''}
          min="1"
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) =>
            update({ ...data, seed: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      </div>
      <textarea
        className="gen-prompt"
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder="描述要生成的画面…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => update({ ...data, prompt: draft })}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
      <button
        className="btn-primary small gen-go"
        disabled={busy}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void generate()
        }}
      >
        {busy ? (
          '生成中…'
        ) : (
          <>
            <Icon name="spark" size={14} />
            生成图片
          </>
        )}
      </button>
    </div>
  )
}
