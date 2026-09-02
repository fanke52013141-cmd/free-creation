// 视频节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useState } from 'react'
import { stopEventPropagation, useEditor, type TLShapeId } from 'tldraw'
import type { VideoGenParams } from '@shared/types'
import {
  normalizeVideoGenParams,
  videoCapabilitiesFor,
  videoCapabilityIssues,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'
import { getNodeType, mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { createEdge, gatherUpstreamMedia, gatherUpstreamMediaList } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import type { NodeCardShape } from '../../../canvas/NodeCardShape'
import { projectNodeOutputs } from '../../nodeValues'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import {
  MediaFileActions,
  MediaResultGrid,
  removeMediaResultFromShape,
  MediaSourceSummary,
  createVideoContinuation,
  createVocalExtractionTemplate,
  clearSelectedMediaHistory,
  ModelSelect,
  NoModelHint,
  selectMediaResult,
  useClickGuard,
  parseJsonProp
} from './shared'

interface VideoGenData {
  prompt: string
  modelKey: string
  params: VideoGenParams
}

function parseVideoGen(text: string): VideoGenData {
  return parseJsonProp<VideoGenData>(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null && typeof o.prompt === 'string') {
        const params = (typeof o.params === 'object' && o.params !== null ? o.params : {}) as {
          ratio?: unknown
          duration?: unknown
          resolution?: unknown
          generateAudio?: unknown
          seed?: unknown
          watermark?: unknown
        }
        return {
          prompt: o.prompt,
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          params: {
            ratio: typeof params.ratio === 'string' ? params.ratio : undefined,
            duration: typeof params.duration === 'number' ? params.duration : undefined,
            resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
            generateAudio:
              typeof params.generateAudio === 'boolean' ? params.generateAudio : undefined,
            seed: typeof params.seed === 'number' ? params.seed : undefined,
            watermark: typeof params.watermark === 'boolean' ? params.watermark : undefined
          }
        }
      }
      return null
    },
    { prompt: '', modelKey: '', params: {} }
  )
}

interface MentionableImage {
  shapeId: TLShapeId
  title: string
  mediaPath: string
}

/**
 * @ 引用只列出真实 out-image 结果。这里不按节点类型猜测，仍以节点投影的正式端口为准。
 */
function imageMentions(
  editor: ReturnType<typeof useEditor>,
  targetId: TLShapeId
): MentionableImage[] {
  const items: MentionableImage[] = []
  for (const raw of editor.getCurrentPageShapes()) {
    if (raw.type !== 'node-card' || raw.id === targetId) continue
    const shape = raw as NodeCardShape
    const output = projectNodeOutputs(shape)['out-image']
    if (output?.kind !== 'image') continue
    items.push({
      shapeId: shape.id,
      title: shape.props.title || getNodeType(shape.props.nodeType)?.label || '图片',
      mediaPath: output.mediaPath
    })
  }
  return items
}

export function VideoBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'video')
  const data = parseVideoGen(readNodeConfig(shape))
  const [draft, setDraft] = useState(data.prompt)
  const [submitting, setSubmitting] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const refImage = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')
  const lastFrame = gatherUpstreamMedia(editor, shape.id, 'in-last-image', 'image')
  const referenceImages = gatherUpstreamMediaList(editor, shape.id, 'in-reference-images', 'image')
  const motionReferences = gatherUpstreamMediaList(editor, shape.id, 'in-reference-video', 'video')
  const audioReferences = gatherUpstreamMediaList(editor, shape.id, 'in-reference-audio', 'audio')
  const availableMentions = imageMentions(editor, shape.id)
  const opt = options.find((o) => o.key === data.modelKey)
  const capabilities = opt
    ? videoCapabilitiesFor(opt.provider.specId, opt.model.id)
    : videoCapabilitiesFor('seedance')
  const seedanceGatewayProxy = Boolean(
    opt?.provider.specId === 'seedance' && opt.provider.baseURL.includes('/gateway/ark/')
  )
  const framesDetermineRatio = Boolean(
    opt &&
    videoRatioIsDerivedByFrames(opt.provider.specId, opt.model.id, Boolean(refImage || lastFrame))
  )
  const params = normalizeVideoGenParams(capabilities, data.params, { framesDetermineRatio })
  const capabilityIssues = videoCapabilityIssues(capabilities, {
    params,
    hasFirstFrame: Boolean(refImage),
    hasLastFrame: Boolean(lastFrame),
    referenceImageCount: referenceImages.length + Number(Boolean(refImage)),
    referenceVideoCount: motionReferences.length,
    referenceAudioCount: audioReferences.length
  })

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: VideoGenData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
    })
  }

  const updateModel = (modelKey: string): void => {
    const next = options.find((option) => option.key === modelKey)
    const nextCapabilities = next
      ? videoCapabilitiesFor(next.provider.specId, next.model.id)
      : videoCapabilitiesFor('seedance')
    update({
      ...data,
      modelKey,
      params: normalizeVideoGenParams(nextCapabilities, data.params)
    })
  }

  const submit = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    if (capabilityIssues.length > 0) return toast(capabilityIssues[0])
    // 配置先落盘，再由统一运行器读取真实端口输入、校验契约并调用视频执行器。
    update({
      ...data,
      prompt: draft,
      params: normalizeVideoGenParams(capabilities, data.params, { framesDetermineRatio })
    })
    setSubmitting(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setSubmitting(false)
    }
  }

  /** 重新生成：清空成片后立即用相同参数重新提交，无需手动返回配置面板。 */
  const regenerate = async (): Promise<void> => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { mediaId: '', mediaPath: '', mediaMime: '' }
    })
    markUndoPoint(editor, 'video-regenerate')
    await submit()
  }

  const addImageMention = (item: MentionableImage): void => {
    if (referenceImages.some((image) => image.mediaPath === item.mediaPath)) {
      setMentionOpen(false)
      toast('该图片已作为参考图连接，无需重复引用')
      return
    }
    const linked = createEdge(
      editor,
      { shapeId: item.shapeId, portId: 'out-image' },
      { shapeId: shape.id, portId: 'in-reference-images' }
    )
    // 已连接同一素材时无需重复建边，仍允许用户在提示词中补充“图片 N”。
    const ordinal =
      referenceImages.length + Number(Boolean(refImage)) + Number(Boolean(lastFrame)) + 1
    const nextPrompt = `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}图片 ${ordinal}`
    setDraft(nextPrompt)
    update({ ...data, prompt: nextPrompt })
    setMentionOpen(false)
    if (linked) toast(`已将“${item.title}”作为图片 ${ordinal} 连入参考图端口`)
    else toast('该图片可能已经引用；已保留提示词标记')
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
      markUndoPoint(editor, 'video-select-result')
    }
    return (
      <div className="node-media-wrap">
        <div
          className="node-media"
          onPointerDown={guard.onPointerDown}
          onClick={(e) =>
            guard.onClick(e, () =>
              openPreview({
                kind: 'video',
                url: mediaUrl(shape.props.mediaPath),
                title: shape.props.title
              })
            )
          }
        >
          <video src={mediaUrl(shape.props.mediaPath)} preload="metadata" muted playsInline />
          <span className="play-badge">▶</span>
        </div>
        <div className="node-media-actions">
          <button
            className="btn-ghost small"
            disabled={submitting}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void regenerate()
            }}
          >
            <Icon name="reset" size={13} />
            {submitting ? '重新生成中…' : '重新生成'}
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              // 编辑配置：清空成片，回到配置面板
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                props: { mediaId: '', mediaPath: '', mediaMime: '' }
              })
              markUndoPoint(editor, 'video-edit-config')
            }}
          >
            <Icon name="edit" size={13} />
            编辑
          </button>
          <MediaFileActions shape={shape} />
        </div>
        <MediaSourceSummary shape={shape} fallback="AI 生成" />
        <div className="node-media-next-actions" aria-label="视频后续操作">
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createVideoContinuation(editor, shape, 'video-frame')
            }}
          >
            <Icon name="frame" size={12} /> 取帧
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createVideoContinuation(editor, shape, 'video-clip')
            }}
          >
            <Icon name="clip" size={12} /> 截取
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createVideoContinuation(editor, shape, 'video-audio')
            }}
          >
            <Icon name="audio" size={12} /> 提音
          </button>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              createVocalExtractionTemplate(editor, shape)
            }}
            title="一键创建 视频提音 → 人声分离 并预连线"
          >
            <Icon name="audio" size={12} /> 一键提取人声
          </button>
        </div>
        <MediaResultGrid
          shape={shape}
          kind="video"
          onSelect={chooseResult}
          onDelete={(item) => {
            const nodeResult = removeMediaResultFromShape(shape, item)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'video-delete-result')
          }}
          onClear={() => {
            const nodeResult = clearSelectedMediaHistory(shape)
            if (!nodeResult) return
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              meta: { ...(shape.meta ?? {}), nodeResult }
            })
            markUndoPoint(editor, 'video-clear-result-history')
          }}
          openPreview={(item) =>
            openPreview({ kind: 'video', url: mediaUrl(item.mediaPath), title: shape.props.title })
          }
        />
      </div>
    )
  }

  if (!options.length) return <NoModelHint onOpen={openSettings} />

  return (
    <div className="gen-panel">
      <div className="gen-capability-note">
        <Icon name="info" size={13} />
        <span>
          {refImage ? '首帧已连接' : '可连接首帧'} · {lastFrame ? '尾帧已连接' : '可连接尾帧'} ·{' '}
          {referenceImages.length ? `参考图 ${referenceImages.length} 张` : '可 @ 引用参考图'}
        </span>
      </div>
      {capabilityIssues.length > 0 && (
        <div className="gen-capability-note capability-error" role="alert">
          <Icon name="info" size={13} />
          <span>{capabilityIssues.join('；')}；请更换模型、调整参数或断开该输入后再运行。</span>
        </div>
      )}
      {refImage && (
        <div className="ref-image-bar">
          <img
            src={mediaUrl(refImage.mediaPath)}
            className="ref-image-thumb"
            draggable={false}
            alt="已连接首帧图"
          />
          <span className="ref-image-label">
            <Icon name="attach" size={13} />
            首帧图已连接
          </span>
        </div>
      )}
      {motionReferences.length > 0 && (
        <div className="ref-image-bar">
          <Icon name="director" size={15} />
          <span className="ref-image-label">
            已连接 {motionReferences.length} 段运动参考；模型是否接受以实际运行结果为准。
          </span>
        </div>
      )}
      {referenceImages.length > 0 && (
        <div className="ref-image-bar">
          <img
            src={mediaUrl(referenceImages[0].mediaPath)}
            className="ref-image-thumb"
            draggable={false}
            alt="已连接参考图"
          />
          <span className="ref-image-label">
            <Icon name="attach" size={13} />
            已连接 {referenceImages.length} 张参考图（提示词可写“图片 1”等）。
          </span>
        </div>
      )}
      {audioReferences.length > 0 && (
        <div className="ref-image-bar">
          <Icon name="audio" size={15} />
          <span className="ref-image-label">
            已连接 {audioReferences.length} 段参考音频；模型是否采用以实际结果为准。
          </span>
        </div>
      )}
      <ModelSelect value={data.modelKey} options={options} onChange={updateModel} />
      <textarea
        className="gen-prompt"
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder="描述视频内容、镜头与氛围…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => update({ ...data, prompt: draft, params })}
        onKeyDown={(e) => {
          if (e.key === '@' && availableMentions.length > 0) setMentionOpen(true)
          if (e.key === 'Escape') setMentionOpen(false)
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <div className="video-reference-mention">
        <button
          type="button"
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            setMentionOpen((open) => !open)
          }}
          disabled={availableMentions.length === 0}
          title={
            availableMentions.length
              ? '从画布结果中引用图片（也可在提示词里输入 @）'
              : '画布中还没有可引用的图片结果'
          }
        >
          <Icon name="attach" size={13} /> @ 引用图片
        </button>
        <span>
          {availableMentions.length ? '引用会建立真实参考图连线' : '先生成或上传一张图片'}
        </span>
        {mentionOpen && (
          <div className="video-mention-menu" role="listbox" aria-label="选择参考图">
            {availableMentions.map((item) => (
              <button
                type="button"
                key={item.shapeId}
                role="option"
                onPointerDown={stopEventPropagation}
                onClick={(event) => {
                  stopEventPropagation(event)
                  addImageMention(item)
                }}
              >
                <img src={mediaUrl(item.mediaPath)} alt="" draggable={false} />
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="gen-row">
        {framesDetermineRatio ? (
          <span className="gen-capability-note">画幅由首/尾帧决定</span>
        ) : (
          <AppSelect
            className="gen-select"
            value={params.ratio ?? capabilities.ratios[0]}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => update({ ...data, params: { ...params, ratio: e.target.value } })}
          >
            {capabilities.ratios.map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio === 'adaptive' ? '自适应' : ratio}
              </option>
            ))}
          </AppSelect>
        )}
        <AppSelect
          className="gen-select w70"
          value={String(params.duration ?? 5)}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) =>
            update({ ...data, params: { ...params, duration: Number(e.target.value) } })
          }
        >
          {capabilities.durations.map((d) => (
            <option key={d} value={d}>
              {d}s
            </option>
          ))}
        </AppSelect>
        <AppSelect
          className="gen-select w86"
          value={params.resolution ?? capabilities.resolutions.at(-1)}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => update({ ...data, params: { ...params, resolution: e.target.value } })}
        >
          {capabilities.resolutions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </AppSelect>
      </div>
      {opt?.provider.specId === 'seedance' && !seedanceGatewayProxy && (
        <div className="gen-row video-advanced-row">
          <label className="video-checkbox">
            <input
              type="checkbox"
              checked={params.generateAudio ?? true}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                update({ ...data, params: { ...params, generateAudio: e.target.checked } })
              }
            />
            生成同步音频
          </label>
          <input
            className="gen-seed"
            type="number"
            min="-1"
            placeholder="种子（可选）"
            value={params.seed ?? ''}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              update({
                ...data,
                params: {
                  ...params,
                  seed: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value)
                }
              })
            }
          />
        </div>
      )}
      {seedanceGatewayProxy && (
        <small className="gen-capability-note">
          当前兼容网关仅提交已验证的画幅、时长与清晰度参数；不展示未经验证的音频/种子开关。
        </small>
      )}
      <button
        className="btn-primary small gen-go"
        disabled={submitting || capabilityIssues.length > 0}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void submit()
        }}
      >
        {submitting ? (
          '提交中…'
        ) : (
          <>
            <Icon name="video" size={14} />
            生成视频
          </>
        )}
      </button>
    </div>
  )
}
