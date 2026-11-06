import { NodeIdentity, NodePrimaryButton } from '../../../canvas/NodePresentation'
// 视频节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useState } from 'react'
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import type { VideoGenerationMode, VideoGenParams } from '@shared/types'
import {
  isSeedanceGatewayProxy,
  normalizeVideoGenParams,
  videoCapabilitiesFor,
  videoCapabilityIssues,
  resolveVideoMode,
  videoRatioIsDerivedByFrames
} from '@shared/video-capabilities'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { gatherUpstreamMediaList, gatherUpstreamMediaSources } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { ImageMentionPrompt } from './ImageMentionPrompt'
import { canonicalizeMediaMentions, type PromptMediaReference } from './media-mentions'
import {
  MediaResultGrid,
  removeMediaResultFromShape,
  clearSelectedMediaHistory,
  ModelSelect,
  NoModelHint,
  pickImportedAsset,
  selectMediaResult,
  useClickGuard,
  parseJsonProp
} from './shared'
import { VideoOperationsWorkbench } from './video-transforms'

interface VideoGenData {
  modelKey: string
  mode?: VideoGenerationMode
  params: VideoGenParams
}

const MODE_LABELS: Record<VideoGenerationMode, string> = {
  text: '文生视频',
  'first-frame': '首帧生视频',
  'first-last-frame': '首尾帧生视频',
  reference: '多参模式'
}

function parseVideoGen(text: string): VideoGenData {
  return parseJsonProp<VideoGenData>(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null) {
        const params = (typeof o.params === 'object' && o.params !== null ? o.params : {}) as {
          ratio?: unknown
          duration?: unknown
          resolution?: unknown
          generateAudio?: unknown
          seed?: unknown
          watermark?: unknown
        }
        return {
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          mode:
            o.mode === 'text' ||
            o.mode === 'first-frame' ||
            o.mode === 'first-last-frame' ||
            o.mode === 'reference'
              ? o.mode
              : undefined,
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
    { modelKey: '', params: {} }
  )
}

export function VideoBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const isAssetNode = shape.props.nodeType === 'video-asset'
  const [videoOperationsMode, setVideoOperationsMode] = useState<'clip' | 'frame'>('clip')
  const [videoOperationsOpen, setVideoOperationsOpen] = useState(false)
  const chooseAsset = async (): Promise<void> => {
    if (!project) return
    try {
      const res = await window.api.pickMedia(project.id)
      if (!res.ok) return toast(`导入失败：${res.error.message}`)
      const asset = pickImportedAsset({
        result: res.data,
        kind: 'video',
        noun: '一个视频',
        mismatch: '请选择一个视频文件',
        projectId: project.id
      })
      if (!asset) return
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: {
          title: asset.name || '视频',
          mediaId: asset.id,
          mediaPath: asset.path,
          mediaMime: asset.mime
        }
      })
      markUndoPoint(editor, 'video-asset-import')
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const options = modelsByModality(providers, 'video')
  const data = parseVideoGen(readNodeConfig(shape))
  const [draft, setDraft] = useState(shape.props.text)
  const [submitting, setSubmitting] = useState(false)
  // 视频的所有图片只占一个绿色端口；模式决定连接顺序的协议角色。
  const images = useValue('video prompt references',
    () => gatherUpstreamMediaSources(editor, shape.id, 'in-images', 'image'), [editor, shape.id])

  const motionReferences = useValue('video prompt motion references',
    () => gatherUpstreamMediaSources(editor, shape.id, 'in-reference-video', 'video'), [editor, shape.id])
  const audioReferences = gatherUpstreamMediaList(editor, shape.id, 'in-reference-audio', 'audio')
  // 图片引用按多值输入端口的连接顺序传入，提示词使用相同顺序。
  const opt = options.find((o) => o.key === data.modelKey)
  // 兼容网关代理属于供应商接入事实，统一收在能力层；UI 只读取结构化能力。
  const gatewayProxy = Boolean(
    opt && isSeedanceGatewayProxy(opt.provider.specId, opt.provider.baseURL)
  )
  const capabilities = opt
    ? videoCapabilitiesFor(opt.provider.specId, opt.model.id, { gatewayProxy })
    : null
  const modeResolution = capabilities
    ? resolveVideoMode(capabilities, {
        mode: data.mode,
        imageCount: images.length,
        referenceVideoCount: motionReferences.length,
        referenceAudioCount: audioReferences.length
      })
    : null
  const mode = modeResolution?.mode
  const mentionImageCount = mode === 'reference'
    ? Math.min(images.length, capabilities?.maxReferenceImages ?? 0)
    : mode === 'first-frame' || mode === 'first-last-frame' ? images.length : 0
  const references: PromptMediaReference[] = [
    ...images.slice(0, mentionImageCount)
      .map(({ source, value }, index) => ({ ...value, title: source.props.title, token: `@图${index + 1}` })),
    ...(mode === 'reference' ? motionReferences.slice(0, capabilities?.maxReferenceVideos ?? 0) : [])
      .map(({ source, value }, index) => ({ ...value, title: source.props.title, token: `@视频${index + 1}` }))
  ]
  const firstFrame = mode === 'first-frame' || mode === 'first-last-frame' ? images[0] : undefined
  const lastFrame = mode === 'first-last-frame' ? images[1] : undefined
  const framesDetermineRatio = Boolean(
    opt &&
    videoRatioIsDerivedByFrames(opt.provider.specId, opt.model.id, Boolean(firstFrame || lastFrame))
  )
  const params = capabilities
    ? normalizeVideoGenParams(capabilities, data.params, { framesDetermineRatio })
    : data.params
  const capabilityIssues = !opt
    ? ['请选择视频模型']
    : !mode || !capabilities
      ? ['当前模型不支持已连接的参考素材组合']
      : videoCapabilityIssues(capabilities, {
          prompt: draft,
          params,
          mode,
          hasFirstFrame: Boolean(firstFrame),
          hasLastFrame: Boolean(lastFrame),
          imageCount: images.length,
          referenceImageCount: mode === 'reference' ? images.length : 0,
          referenceVideoCount: motionReferences.length,
          referenceAudioCount: audioReferences.length
        })

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  // 连接素材或切换模型后，修复不再有效的已保存模式。共享解析器也用于 executor，
  // 因而不会出现 UI 显示一种模式、提交时采用另一种模式的分歧。
  useEffect(() => {
    if (!mode || data.mode === mode) return
    if (capabilities) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { config: JSON.stringify({ ...data, mode, params }) }
      })
    }
  }, [capabilities, data, editor, images.length, mode, params, shape.id])

  const update = (next: VideoGenData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
    })
  }

  const updateText = (text: string): void => {
    if (text !== shape.props.text)
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text } })
  }

  const updateModel = (modelKey: string): void => {
    const next = options.find((option) => option.key === modelKey)
    const nextCapabilities = next
      ? videoCapabilitiesFor(next.provider.specId, next.model.id, {
          gatewayProxy: isSeedanceGatewayProxy(next.provider.specId, next.provider.baseURL)
        })
      : null
    const nextMode = nextCapabilities
      ? resolveVideoMode(nextCapabilities, {
          mode: data.mode,
          imageCount: images.length,
          referenceVideoCount: motionReferences.length,
          referenceAudioCount: audioReferences.length
        }).mode
      : undefined
    const nextFrames = nextMode === 'first-frame' || nextMode === 'first-last-frame'
    update({
      ...data,
      modelKey,
      mode: nextMode,
      params: nextCapabilities
        ? normalizeVideoGenParams(nextCapabilities, data.params, {
            framesDetermineRatio: Boolean(
              nextFrames &&
              images.length > 0 &&
              next &&
              videoRatioIsDerivedByFrames(next.provider.specId, next.model.id, true)
            )
          })
        : data.params
    })
  }

  const submit = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    if (!mode || !capabilities) return toast('请选择支持当前素材的模型')
    if (capabilityIssues.length > 0) return toast(capabilityIssues[0])
    // 配置先落盘，再由统一运行器读取真实端口输入、校验契约并调用视频执行器。
    update({
      ...data,
      mode,
      params: normalizeVideoGenParams(capabilities, data.params, { framesDetermineRatio })
    })
    updateText(canonicalizeMediaMentions(draft, references))
    setSubmitting(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setSubmitting(false)
    }
  }


  if (isAssetNode && !shape.props.mediaPath) {
    // 视频资产空态：所有 Hook 已在上方无条件调用，这里早退是安全的。
    return (
      <NodeIdentity>
        <NodePrimaryButton
          className="btn-ghost video-import-button"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void chooseAsset()
          }}
        >
          导入视频
        </NodePrimaryButton>
      </NodeIdentity>
    )
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
      <div className="node-media-wrap video-thumbnail-wrap">
        <div
          className="node-media"
          data-node-interactive="media-preview"
          onPointerDown={guard.onPointerDown}
          onDoubleClick={(e) =>
            guard.onDoubleClick(e, () =>
              openPreview({
                kind: 'video',
                url: mediaUrl(shape.props.mediaPath),
                title: shape.props.title
              })
            )
          }
        >
          <video src={mediaUrl(shape.props.mediaPath)} preload="metadata" muted playsInline />
          <span className="play-badge">
            <Icon name="play" size={24} />
          </span>
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
        {/* 操作条与图片节点共用同一套公共样式（NODE_UI_STANDARD §19：按钮 32px、按可用宽度分配）：
            不再使用节点私有的浮层底、描边与背景模糊。 */}
        <div
          className="node-media-next-actions media-action-toolbar"
          role="group"
          aria-label="视频操作"
        >
          <div className="media-action-primary">
            <button
              className="btn-ghost small media-action-button"
              title="替换视频"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void chooseAsset()
              }}
            >
              替换
            </button>
            <button
              className="btn-ghost small media-action-button"
              title="打开视频截取"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                setVideoOperationsMode('clip')
                setVideoOperationsOpen(true)
              }}
            >
              视频截取
            </button>
            <button
              className="btn-ghost small media-action-button"
              title="打开抽帧"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                setVideoOperationsMode('frame')
                setVideoOperationsOpen(true)
              }}
            >
              抽帧
            </button>
          </div>
          <span className="media-action-divider" aria-hidden="true" />
          {/* 定位/复制节点的图标入口沿用媒体文件操作的按钮材质，与图片节点同列。 */}
          <span className="node-media-file-actions" role="group" aria-label="节点辅助操作">
            <button
              type="button"
              className="icon-btn media-file-action-btn"
              title="在画布中定位居中"
              aria-label="在画布中定位居中"
              onPointerDown={stopEventPropagation}
              onClick={(event) => {
                stopEventPropagation(event)
                const bounds = editor.getShapePageBounds(shape.id)
                if (!bounds) return
                editor.centerOnPoint(
                  { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
                  { animation: { duration: 250 } }
                )
              }}
            >
              <Icon name="target" size={16} />
            </button>
            <button
              type="button"
              className="icon-btn media-file-action-btn"
              title="复制节点"
              aria-label="复制节点"
              onPointerDown={stopEventPropagation}
              onClick={(event) => {
                stopEventPropagation(event)
                markUndoPoint(editor, 'duplicate-video-node')
                editor.duplicateShapes([shape.id])
              }}
            >
              <Icon name="copy" size={16} />
            </button>
          </span>
        </div>
        {videoOperationsOpen && (
          <VideoOperationsWorkbench
            source={shape}
            editor={editor}
            initialMode={videoOperationsMode}
            onClose={() => setVideoOperationsOpen(false)}
          />
        )}
      </div>
    )
  }

  if (!options.length)
    return <NoModelHint />

  return (
    <div className="gen-panel video-gen-panel">
      {opt?.provider.specId === 'dreamina' && audioReferences.length > 0 && (
        <p className="gen-capability-note">即梦参考音频须为 2–30 秒，提交前会检查时长。</p>
      )}
      {capabilities?.parameterTransport === 'gateway-compatibility' && (
        <div className="gen-capability-note">
          <Icon name="info" size={13} />
          <span>
            当前模型经兼容网关提交；画幅、时长与清晰度会按网关兼容格式传递，以任务回执为准。
          </span>
        </div>
      )}
      <section className="video-gen-section video-gen-source" aria-label="生成配置">
        <div className="video-gen-section-heading">
          <span>生成配置</span>
        </div>
        <div className="video-model-mode-row">
          <label>
            <span>模型</span>
            <ModelSelect value={data.modelKey} options={options} onChange={updateModel} />
          </label>
          <label>
            <span>生成模式</span>
            <AppSelect
              className="gen-select"
              value={mode ?? ''}
              disabled={!capabilities || !mode}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => {
                if (!capabilities) return
                const nextMode = event.target.value as VideoGenerationMode
                const nextFrames = nextMode === 'first-frame' || nextMode === 'first-last-frame'
                update({
                  ...data,
                  mode: nextMode,
                  params: normalizeVideoGenParams(capabilities, data.params, {
                    framesDetermineRatio: Boolean(
                      nextFrames &&
                      images.length > 0 &&
                      opt &&
                      videoRatioIsDerivedByFrames(opt.provider.specId, opt.model.id, true)
                    )
                  })
                })
              }}
            >
              {!mode && <option value="" />}
              {(modeResolution?.availableModes ?? []).map((candidate) => (
                <option key={candidate} value={candidate}>
                  {MODE_LABELS[candidate]}
                </option>
              ))}
            </AppSelect>
          </label>
        </div>
      </section>
      <section className="video-gen-section video-prompt-section" aria-label="视频描述">
        <div className="video-gen-section-heading">
          <span>视频描述</span>
          {capabilities?.maxPromptChars && (
            <span className="video-prompt-meta">
              {draft.length} / {capabilities.maxPromptChars} 字
            </span>
          )}
        </div>
        <ImageMentionPrompt
          className="gen-prompt video-gen-prompt"
          references={references}
          value={draft}
          rows={5}
          spellCheck={false}
          maxLength={capabilities?.maxPromptChars}
          placeholder="描述视频内容、镜头与氛围…"
          onValueChange={setDraft}
          onCommit={(text) => {
            setDraft(text)
            update({ ...data, params })
            updateText(text)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </section>
      {capabilities && (
        <section className="video-gen-section video-output-settings" aria-label="视频输出参数">
          <div className="video-gen-section-heading">
            <span>输出参数</span>
          </div>
          <div className="video-param-grid">
            {framesDetermineRatio ? (
              <span className="gen-capability-note">画幅由首/尾帧决定</span>
            ) : (
              <label>
                <span>画幅</span>
                <AppSelect
                  className="gen-select"
                  aria-label="视频画幅"
                  value={params.ratio ?? capabilities.defaultRatio}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    update({ ...data, params: { ...params, ratio: e.target.value } })
                  }
                >
                  {capabilities.ratios.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio === 'adaptive' ? '自适应' : ratio}
                    </option>
                  ))}
                </AppSelect>
              </label>
            )}
            <label>
              <span>
                时长 {Math.min(...capabilities.durations)}–{Math.max(...capabilities.durations)}s
              </span>
              <AppSelect
                className="gen-select"
                title="时长按秒计费，超出模型支持范围的取值会自动回到最短档"
                aria-label="视频时长"
                value={String(params.duration ?? capabilities.defaultDuration)}
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
            </label>
            <label>
              <span>分辨率</span>
              <AppSelect
                className="gen-select"
                title="分辨率按档位计费，默认已选该模型最低档；要成片质量再手动调高"
                aria-label="视频分辨率"
                value={params.resolution ?? capabilities.defaultResolution}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) =>
                  update({ ...data, params: { ...params, resolution: e.target.value } })
                }
              >
                {capabilities.resolutions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </AppSelect>
            </label>
          </div>
          {capabilities.supportsGeneratedAudio && (
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
            </div>
          )}
          {gatewayProxy && (
            <small className="gen-capability-note">
              当前兼容网关仅提交已验证的画幅、时长与清晰度参数；不展示未经验证的音频/种子开关。
            </small>
          )}
        </section>
      )}
      <NodePrimaryButton
        className="btn-primary small gen-go video-gen-submit"
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
      </NodePrimaryButton>
    </div>
  )
}
