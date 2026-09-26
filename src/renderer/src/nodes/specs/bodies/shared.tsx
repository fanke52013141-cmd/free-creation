// 节点 Body 共享工具（路线图 R6：拆分超大 bodies.tsx）
//
// 从原 bodies.tsx 提出的、被多个节点 Body 复用的工具函数/组件。拆分后由各节点
// Body 文件从本模块 import。行为与原 bodies.tsx 完全等价。
// 本文件同时导出工具函数（非组件）与少量 UI 组件（ModelSelect/NoModelHint），
// 是共享模块而非单一组件文件，故豁免 React Fast Refresh 的组件-only 规则。
/* eslint-disable react-refresh/only-export-components */
import { createShapeId, stopEventPropagation, useValue, type Editor, type TLShapeId } from 'tldraw'
import { findNodeContinuationPlacement } from '../../../canvas/node-placement'
import { modelsByModality } from '../../../stores/gateway'
import type { NodeCardShape, NodeCardProps } from '../../../canvas/NodeCardShape'
import { countIncomingConnections, createEdge } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { getNodeType, mediaUrl } from '../../registry'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { toast } from '../../../stores/toast'
import { useConfirmStore } from '../../../stores/confirm'
import { useMediaStore } from '../../../stores/media'
import type { MediaAsset, MediaImportResult, ProviderSpecId } from '@shared/types'
import { PROVIDER_SPECS } from '@shared/types'
import { parseImageSplitConfig } from '@shared/image-split'
import {
  clearMediaResultHistory,
  parseMediaResultCollection,
  removeMediaResult,
  serializeMediaResultCollection,
  type MediaResultItem
} from '../../nodeValues'

// shape.props.text 里的 JSON 解析：失败时返回 fallback（兼容旧纯文本数据，ScriptBody 同款约定）
export function parseJsonProp<T>(text: string, validate: (v: unknown) => T | null, fallback: T): T {
  if (!text) return fallback
  try {
    const v = JSON.parse(text) as unknown
    const r = validate(v)
    if (r !== null) return r
  } catch {
    // 非结构化内容按 fallback 处理
  }
  return fallback
}

/**
 * 缺少必需输入时的结论文案（NODE_UI_SPEC §16.16）：按真实连线数区分「没连线」与
 * 「连了但上游还没出图」，否则用户会去检查错的那一侧。只读已有端口，不新增契约。
 */
export function useSourceWiringNotice(
  editor: Editor,
  shapeId: string,
  portId: string,
  label: string
): string {
  const count = useValue(
    `${shapeId}:${portId} incoming`,
    () => countIncomingConnections(editor, shapeId as TLShapeId, portId),
    [editor, shapeId, portId]
  )
  return count === 0
    ? `${label}（${portId}）未连线，运行会跳过。`
    : `${label}（${portId}）已连线 ${count} 条，但上游还没有产出。`
}

/**
 * 节点 config 的响应式读法：文档才是配置真值。设置面板若把 config 拷进只在挂载时取一次
 * 的 useState，面板开着时画布卡片上的写入（拖裁剪框、改行列、改修改说明）就不会反映到
 * 面板，面板下一次保存会把那次改动整份覆盖掉。手势期间的本地预览由调用方自己叠加。
 */
export function useStoredNodeConfig(editor: Editor, shapeId: string): string {
  return useValue(
    `${shapeId}:config`,
    () => {
      const current = editor.getShape<NodeCardShape>(shapeId as TLShapeId)
      return current ? readNodeConfig(current) : ''
    },
    [editor, shapeId]
  )
}

/**
 * 单资产卡片（图片 / 视频 / 音频 / 文件 / 语音参考素材）拿到 media.pick 结果后的统一收尾。
 *
 * 系统文件框开了多选（`IPC.media.pick` 的 `multiSelections`），选中的文件会全部落进
 * 项目素材库，但一张卡片只承载一个资产。旧代码只取 `.find(kind)` 的第一个，于是用户
 * 多选时看到的现象是「其余文件凭空消失」，个别文件导入失败时也完全静默。这里把两件
 * 事都说出来，并在素材库确实多出卡片没吃下的文件时刷新素材列表，保证提示可兑现。
 */
export function pickImportedAsset(options: {
  result: MediaImportResult
  kind: MediaAsset['kind']
  /** 计数提示用的量词 + 名词，如「一张图片」。 */
  noun: string
  /** 选了文件但没有一个属于本卡片能承载的类型时的提示。 */
  mismatch: string
  projectId: string
}): MediaAsset | null {
  const { result, kind, noun, mismatch, projectId } = options
  for (const error of result.errors.slice(0, 3)) {
    toast(`导入失败：${error.path.split(/[\\/]/).pop()}（${error.reason}）`)
  }
  if (result.errors.length > 3) toast(`另有 ${result.errors.length - 3} 个文件导入失败`)
  const matched = result.assets.filter((asset) => asset.kind === kind)
  if (matched.length === 0) {
    // assets 为空 = 用户在系统对话框点了取消，这时报「请选对文件」是错的。
    if (result.assets.length > 0) toast(mismatch)
    return null
  }
  if (result.assets.length > 1) void useMediaStore.getState().refresh(projectId)
  if (matched.length > 1) toast(`一次只用${noun}：另外 ${matched.length - 1} 个已导入项目素材库`)
  return matched[0]
}

// 节点内模型选择下拉（按模态过滤全部供应商的模型）
export function ModelSelect({
  value,
  options,
  onChange
}: {
  value: string
  options: ReturnType<typeof modelsByModality>
  onChange: (key: string) => void
}): React.JSX.Element {
  return (
    <AppSelect
      className="gen-select"
      value={value}
      onPointerDown={(e) => stopEventPropagation(e)}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.some((o) => o.key === value) && <option value="">选择模型…</option>}
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </AppSelect>
  )
}

// 未配置任何对应模态模型时的占位引导
export function NoModelHint({
  onOpen,
  presetIds = []
}: {
  onOpen: () => void
  /** 该节点需要哪个供应商预设；名字直接取自 PROVIDER_SPECS，避免两处各写一套。 */
  presetIds?: ProviderSpecId[]
}): React.JSX.Element {
  const labels = presetIds.map((id) => PROVIDER_SPECS.find((s) => s.id === id)?.label ?? id)
  return (
    <div className="gen-empty">
      <span>尚未配置可用模型</span>
      {labels.length > 0 && (
        <span className="gen-empty-presets">可新增预设：{labels.join('、')}</span>
      )}
      <button
        className="btn-ghost small"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        打开模型设置
      </button>
    </div>
  )
}

/**
 * 计算下游衍生节点的放置坐标：
 * 新节点优先放在来源节点右侧并与其顶边对齐；被占用时从该行开始逐行向下找最近空位。
 */
export function findContinuationPlacement(
  editor: Editor,
  source: NodeCardShape,
  targetW: number,
  targetH: number,
  gapX = 96,
  gapY = 24
): { x: number; y: number } {
  const existingInColumn = editor
    .getCurrentPageShapes()
    .filter((shape): shape is NodeCardShape => shape.type === 'node-card' && shape.id !== source.id)
  return findNodeContinuationPlacement({
    source: { x: source.x, y: source.y, w: source.props.w, h: source.props.h },
    existing: existingInColumn.map((shape) => ({
      x: shape.x,
      y: shape.y,
      w: shape.props.w,
      h: shape.props.h
    })),
    targetW,
    targetH,
    gapX,
    gapY
  })
}

/**
 * 从已有图片输出创建一个真实的下游媒体节点。快捷操作只负责创建节点和
 * 声明端口连线，数据仍由统一 executor 按 portId 收集。
 */
export function createImageContinuation(
  editor: Editor,
  source: NodeCardShape,
  targetType: 'image-gen' | 'image-crop' | 'image-split' | 'image-edit' | 'video'
): void {
  const spec = getNodeType(targetType)
  if (!spec) return
  // 目标图片输入端口必须从 spec 声明解析，不能写死端口 ID：image-crop /
  // image-split / image-edit 用单值 in-image，而 image-gen 与 video 的图片
  // 输入已迁移为多值端口 in-images。写死 'in-image' 会让 createEdge 因端口
  // 不存在而失败并静默删除刚创建的节点，表现为快捷按钮“点了没反应”。
  const targetPortId = spec.ports.in.find((port) => port.type === 'image')?.id
  if (!targetPortId) return
  const id = createShapeId()
  const title =
    targetType === 'image-gen'
      ? '继续生图'
      : targetType === 'image-crop'
        ? '图片裁剪'
        : targetType === 'image-split'
          ? '图片拆分'
          : targetType === 'image-edit'
            ? 'P图'
            : '视频生成'
  const placement = findContinuationPlacement(
    editor,
    source,
    spec.defaultSize.w,
    spec.defaultSize.h
  )
  editor.createShape({
    id,
    type: 'node-card',
    x: placement.x,
    y: placement.y,
    props: {
      nodeType: targetType,
      title,
      w: spec.defaultSize.w,
      h: spec.defaultSize.h,
      ...(targetType === 'video'
        ? { config: JSON.stringify({ modelKey: '', mode: 'reference', params: {} }) }
        : {})
    } satisfies Partial<NodeCardProps>
  })
  if (
    !createEdge(
      editor,
      { shapeId: source.id, portId: 'out-image' },
      { shapeId: id, portId: targetPortId }
    )
  ) {
    editor.deleteShape(id)
    return
  }
  editor.select(id)
}

/** 图片结果的统一下游入口。它只创建节点和声明端口边，不复制任何媒体。 */
export function ImageContinuationActions({
  editor,
  shape,
  extra
}: {
  editor: Editor
  shape: NodeCardShape
  extra?: React.ReactNode
}): React.JSX.Element {
  const actions: Array<{
    type: 'image-crop' | 'image-split' | 'image-gen' | 'image-edit' | 'video'
    label: string
    title: string
  }> = [
    { type: 'image-crop', label: '裁剪', title: '创建裁剪节点并连接当前图片' },
    { type: 'image-split', label: '拆分', title: '创建图片拆分节点并连接当前图片' },
    { type: 'image-gen', label: '生图', title: '创建生图节点并连接当前图片' },
    { type: 'image-edit', label: 'P图', title: '对当前图片添加标注并 P 图' },
    { type: 'video', label: '视频生成', title: '创建视频节点并将当前图片作为多参素材' }
  ]
  return (
    <div className="node-media-next-actions" aria-label="图片后续操作">
      {actions.map((action) => (
        <button
          className="btn-ghost small"
          key={action.type}
          title={action.title}
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            createImageContinuation(editor, shape, action.type)
          }}
        >
          {action.label}
        </button>
      ))}
      {extra}
    </div>
  )
}

/** 从视频输出创建独立处理节点；快捷入口只建真实边，不在视频节点内隐藏产物。 */
export function createVideoContinuation(
  editor: Editor,
  source: NodeCardShape,
  targetType: 'video-frame' | 'video-clip',
  options?: { title?: string; config?: string }
): TLShapeId | null {
  const spec = getNodeType(targetType)
  if (!spec) return null
  const titles: Record<typeof targetType, string> = {
    'video-frame': '抽帧',
    'video-clip': '视频截取'
  }
  const id = createShapeId()
  const placement = findContinuationPlacement(
    editor,
    source,
    spec.defaultSize.w,
    spec.defaultSize.h
  )
  editor.createShape({
    id,
    type: 'node-card',
    x: placement.x,
    y: placement.y,
    props: {
      nodeType: targetType,
      title: options?.title ?? titles[targetType],
      ...(options?.config ? { config: options.config } : {}),
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    } satisfies Partial<NodeCardProps>
  })
  if (
    !createEdge(
      editor,
      { shapeId: source.id, portId: 'out-video' },
      { shapeId: id, portId: 'in-video' }
    )
  ) {
    editor.deleteShape(id)
    return null
  }
  editor.select(id)
  return id
}

/**
 * 导演台的预演视频不是“下载提示”，而是可以直接注入视频节点的真实运动参考。
 * 此快捷入口只创建 video.in-reference-video 边，不复制视频、不读取隐藏状态。
 */
export function createPrevisVideoReference(editor: Editor, source: NodeCardShape): void {
  const spec = getNodeType('video')
  if (!spec) return
  const id = createShapeId()
  const placement = findContinuationPlacement(
    editor,
    source,
    spec.defaultSize.w,
    spec.defaultSize.h
  )
  editor.createShape({
    id,
    type: 'node-card',
    x: placement.x,
    y: placement.y,
    props: {
      nodeType: 'video',
      title: '参考视频生成',
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    } satisfies Partial<NodeCardProps>
  })
  if (
    !createEdge(
      editor,
      { shapeId: source.id, portId: 'out-preview-video' },
      { shapeId: id, portId: 'in-reference-video' }
    )
  ) {
    editor.deleteShape(id)
    return
  }
  editor.select(id)
}

type MediaSourceMeta = {
  kind?: string
  modelKey?: string
  prompt?: string
  at?: number
  genParams?: {
    ratio?: string
    duration?: number
    resolution?: string
    generateAudio?: boolean
    seed?: number
  }
  sourceSummary?: {
    firstFrame?: boolean
    lastFrame?: boolean
    referenceImages?: number
    referenceVideo?: number
    referenceAudio?: number
  }
}

function mediaSourceMeta(shape: NodeCardShape): MediaSourceMeta | null {
  const raw = shape.meta?.nodeResult
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw) as MediaSourceMeta
    return value && typeof value === 'object' && value.kind === 'media-source' ? value : null
  } catch {
    return null
  }
}

/**
 * 本地引擎写进结果的内部 ID 不直接进 UI：结果卡展示动作名（本地裁剪），而不是
 * `local:canvas-crop`。新增本地执行器时必须在这里补一行；
 * test/node-ui-decisions.test.ts 会扫描执行器源码，强制每个 local: ID 都有标签。
 */
export const LOCAL_ENGINE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  'local:canvas-crop': '本地裁剪',
  'local:image-grid-split': '本地拆图',
  'local:ffmpeg-frame': '本地抽帧',
  'local:ffmpeg-clip': '本地截视频',
  'local:ffmpeg-audio': '本地提取音频',
  'local:vocal-extraction': '本地提取人声',
  'local:video-depth-anything-small': '本地视频深度估计'
}

/** 来源标签的唯一出口：内部 ID 一律换成人话，未登记的 local ID 也不外泄。 */
export function mediaSourceLabel(modelKey: string | undefined, fallback: string): string {
  if (!modelKey) return fallback
  if (modelKey.startsWith('local:')) return LOCAL_ENGINE_SOURCE_LABELS[modelKey] ?? fallback
  return modelKey.replace('::', ' · ')
}

/** 所有媒体结果卡统一展示来源摘要；完整提示词仍只在悬浮 title 中提供。 */
export function MediaSourceBadge({
  shape,
  fallback = '本地资产'
}: {
  shape: NodeCardShape
  fallback?: string
}): React.JSX.Element {
  const source = mediaSourceMeta(shape)
  // 浏览器验收环境生成的是确定性的本地演示图，而不是远端模型返回结果。
  // 明确标识它，避免把“mock-relay”误认为一个异常的生成状态或真实模型名。
  const isBrowserDemo = source?.modelKey === 'mock-relay::gpt-image-2'
  const label = isBrowserDemo
    ? '浏览器演示生成 · 已完成'
    : mediaSourceLabel(source?.modelKey, fallback)
  const time = source?.at ? ` · ${new Date(source.at).toLocaleTimeString()}` : ''
  return (
    <span className="node-media-source" title={source?.prompt || shape.props.mediaPath}>
      <Icon name={source ? 'info' : 'image'} size={11} />
      {label}
      {time}
    </span>
  )
}

/**
 * Sprint 2 来源摘要：比 MediaSourceBadge 更丰富，展示生成参数和输入来源。
 * 仅当 nodeResult 中存在 genParams 或 sourceSummary 时渲染完整摘要，否则回退到普通 badge。
 */
export function MediaSourceSummary({
  shape,
  fallback = '本地资产'
}: {
  shape: NodeCardShape
  fallback?: string
}): React.JSX.Element {
  const source = mediaSourceMeta(shape)
  const hasRichData = Boolean(source?.genParams || source?.sourceSummary)

  // 无增强数据时回退到普通 badge
  if (!hasRichData) {
    return <MediaSourceBadge shape={shape} fallback={fallback} />
  }

  const paramBadges: string[] = []
  if (source?.genParams) {
    const gp = source.genParams
    if (gp.ratio) paramBadges.push(gp.ratio === 'adaptive' ? '自适应' : gp.ratio)
    if (gp.duration) paramBadges.push(`${gp.duration}s`)
    if (gp.resolution) paramBadges.push(gp.resolution)
  }

  const sourceParts: string[] = []
  if (source?.sourceSummary) {
    const ss = source.sourceSummary
    if (ss.firstFrame) sourceParts.push('首帧图')
    if (ss.lastFrame) sourceParts.push('尾帧图')
    if (ss.referenceImages) sourceParts.push(`参考图 ${ss.referenceImages} 张`)
    if (ss.referenceVideo) sourceParts.push(`参考视频 ${ss.referenceVideo} 段`)
    if (ss.referenceAudio) sourceParts.push(`参考音频 ${ss.referenceAudio} 段`)
  }

  const time = source?.at ? new Date(source.at).toLocaleTimeString() : ''
  const promptLine = source?.prompt
    ? source.prompt.length > 50
      ? source.prompt.slice(0, 50) + '…'
      : source.prompt
    : ''

  return (
    <div className="media-source-summary" title={source?.prompt || shape.props.mediaPath}>
      <div className="media-source-summary-head">
        <Icon name="info" size={11} />
        <span className="media-source-summary-model">
          {mediaSourceLabel(source?.modelKey, fallback)}
        </span>
        {paramBadges.length > 0 && (
          <span className="media-source-summary-params">{paramBadges.join(' · ')}</span>
        )}
        {time && <span className="media-source-summary-time">{time}</span>}
      </div>
      {sourceParts.length > 0 && (
        <div className="media-source-summary-sources">
          <Icon name="attach" size={10} />
          {sourceParts.join(' · ')}
        </div>
      )}
      {promptLine && <div className="media-source-summary-prompt">{promptLine}</div>}
    </div>
  )
}

/** 媒体结果统一的本地文件操作，不改变节点输出，只操作已落盘资产。 */
export function MediaFileActions({ shape }: { shape: NodeCardShape }): React.JSX.Element | null {
  if (!shape.props.mediaId) return null
  return (
    <span className="node-media-file-actions" aria-label="媒体文件操作">
      <button
        className="icon-btn"
        title="在资源管理器中定位"
        aria-label="在资源管理器中定位"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void window.api.revealMedia(shape.props.mediaId)
        }}
      >
        <Icon name="target" size={11} />
      </button>
      <button
        className="icon-btn"
        title="复制文件路径"
        aria-label="复制文件路径"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void window.api.copyMediaPath(shape.props.mediaId)
        }}
      >
        <Icon name="copy" size={11} />
      </button>
    </span>
  )
}

export function MediaResultGrid({
  shape,
  kind,
  onSelect,
  openPreview,
  onClear,
  onDelete,
  className,
  gridColumns,
  itemLabel
}: {
  shape: NodeCardShape
  kind: 'image' | 'video' | 'audio'
  onSelect: (item: MediaResultItem) => void
  openPreview: (item: MediaResultItem) => void
  onClear?: () => void
  onDelete?: (item: MediaResultItem) => void
  className?: string
  /** 仅拆图使用：用真实列数呈现结果，不把 3×3 拆分误画成 4 列候选集合。 */
  gridColumns?: number
  /** 结果的业务位置标签，例如拆图的「R2 · C3」。 */
  itemLabel?: (index: number) => string | undefined
}): React.JSX.Element | null {
  // 滚轮由画布统一路由；结果网格不再自行截获事件。
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  if (!collection || collection.results.length < 2) return null
  const selected = collection.selectedMediaId || shape.props.mediaId
  // 破坏性操作先经确认弹窗（与项目菜单同一 useConfirmStore），取消即中止。
  const confirmDanger = async (
    title: string,
    message: string,
    confirmText: string
  ): Promise<boolean> =>
    await useConfirmStore.getState().confirm({ title, message, confirmText, danger: true })
  return (
    <div
      className={`media-result-collection${className ? ` ${className}` : ''}`}
      aria-label="生成结果集合"
    >
      <div className="media-result-collection-head">
        <span className="media-result-summary">
          <strong>{collection.results.length}</strong> 格
          <em>{selected ? '当前输出已确定' : '尚未选择输出'}</em>
        </span>
        <span className="media-result-collection-tools">
          {onClear && collection.results.length > 1 ? (
            <button
              type="button"
              className="icon-btn"
              title="清空历史结果，仅保留当前输出"
              aria-label="清空历史结果，仅保留当前输出"
              onPointerDown={(event) => stopEventPropagation(event)}
              onClick={(event) => {
                event.stopPropagation()
                void (async () => {
                  if (
                    !(await confirmDanger(
                      '清空历史结果',
                      '仅保留当前输出，其余历史结果将从该节点移除。',
                      '清空'
                    ))
                  )
                    return
                  onClear()
                })()
              }}
            >
              <Icon name="trash" size={11} />
            </button>
          ) : null}
        </span>
      </div>
      <div
        className="media-result-grid"
        style={
          gridColumns
            ? { ['--media-grid-columns' as string]: String(Math.max(1, gridColumns)) }
            : undefined
        }
      >
        {collection.results.map((item, index) => {
          const active = item.mediaId === selected
          const label = itemLabel?.(index)
          return (
            <div
              key={item.mediaId}
              className={`media-result-tile ${active ? 'selected' : ''}`}
              data-node-interactive="media-preview"
              title={`${label ? `${label}；` : ''}${active ? '当前输出；' : ''}双击预览`}
              onClick={(event) => {
                // 单击由卡片承接为“选中节点”；双击才打开预览，避免媒体区吞掉选中操作。
                if (event.detail >= 2) event.stopPropagation()
              }}
              onDoubleClick={(event) => {
                event.stopPropagation()
                openPreview(item)
              }}
            >
              {kind === 'image' ? (
                <img src={mediaUrl(item.mediaPath)} alt="生成结果" draggable={false} />
              ) : kind === 'video' ? (
                <video src={mediaUrl(item.mediaPath)} preload="metadata" muted playsInline />
              ) : (
                <span className="media-result-audio-tile">
                  <Icon name="audio" size={20} />
                  <small>{item.mime || '音频'}</small>
                </span>
              )}
              {active ? <span className="media-result-selected">当前</span> : null}
              {label ? <span className="media-result-tile-label">{label}</span> : null}
              <span className="media-result-tile-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="打开预览"
                  aria-label="预览"
                  onPointerDown={(event) => stopEventPropagation(event)}
                  onClick={(event) => {
                    event.stopPropagation()
                    openPreview(item)
                  }}
                >
                  <Icon name="search" size={11} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={active ? '打开预览' : '设为当前输出'}
                  aria-label={active ? '打开预览' : '设为当前输出'}
                  onPointerDown={(event) => stopEventPropagation(event)}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (active) openPreview(item)
                    else onSelect(item)
                  }}
                >
                  <Icon name="check" size={11} />
                </button>
                {!active && onDelete ? (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="删除历史结果"
                    aria-label="删除历史结果"
                    onPointerDown={(event) => stopEventPropagation(event)}
                    onClick={(event) => {
                      event.stopPropagation()
                      void (async () => {
                        if (
                          !(await confirmDanger(
                            '删除历史结果',
                            '该历史结果将从节点移除，不可恢复。',
                            '删除'
                          ))
                        )
                          return
                        onDelete(item)
                      })()
                    }}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                ) : null}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function clearSelectedMediaHistory(shape: NodeCardShape): string | null {
  const raw = typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  const next = clearMediaResultHistory(raw)
  return next ? serializeMediaResultCollection(next) : null
}

export function removeMediaResultFromShape(
  shape: NodeCardShape,
  item: MediaResultItem
): string | null {
  const raw = typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  const next = removeMediaResult(raw, item.mediaId)
  return next ? serializeMediaResultCollection(next) : null
}

export function selectMediaResult(
  shape: NodeCardShape,
  item: MediaResultItem
): {
  props: Pick<NodeCardProps, 'mediaId' | 'mediaPath' | 'mediaMime' | 'title'>
  nodeResult: string
} {
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  return {
    props: {
      mediaId: item.mediaId,
      mediaPath: item.mediaPath,
      mediaMime: item.mime,
      title: shape.props.title
    },
    nodeResult: serializeMediaResultCollection({
      kind: 'media-source',
      version: 1,
      ...(collection?.nodeId ? { nodeId: collection.nodeId } : {}),
      ...(collection?.modelKey ? { modelKey: collection.modelKey } : {}),
      ...(collection?.prompt ? { prompt: collection.prompt } : {}),
      at: item.createdAt,
      selectedMediaId: item.mediaId,
      results: collection?.results ?? [item]
    })
  }
}

// 媒体单击必须仍能选中节点，原生 dblclick 才打开预览。不要在单击的 detail 上
// 推断双击：tldraw 在首次选中时会重建 HTML 节点，使 detail / ref 不稳定。
// 浏览器只会在无拖拽时派发 dblclick，因此无需单独吞掉 pointerdown。
export function useClickGuard(): {
  onPointerDown: (e: React.PointerEvent) => void
  onDoubleClick: (e: React.MouseEvent, open: () => void) => void
} {
  return {
    onPointerDown: () => undefined,
    onDoubleClick: (e, open) => {
      e.stopPropagation()
      open()
    }
  }
}

/**
 * 把 JSON.parse 的报错换算成行号：新引擎自带行列，旧引擎按 position 推算。
 * JSON / 结构数据节点共用同一份读法，避免同一类错误在两个节点里说法不一致。
 */
export function jsonErrorLocation(raw: string, message: string): string {
  const located = /\(line (\d+) column (\d+)\)/.exec(message)
  if (located) return `第 ${located[1]} 行第 ${located[2]} 列格式有误`
  const at = /at position (\d+)/.exec(message)
  if (!at) return '无法解析 JSON'
  const index = Math.min(Number(at[1]), raw.length)
  return `第 ${raw.slice(0, index).split('\n').length} 行格式有误`
}

// 变量值类型（被处理/代码/脚本节点共享）：决定变量映射的类型约束。
export type VariableValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'

// 变量类型下拉选项（处理/代码/脚本节点共用）。
export const VARIABLE_TYPES: { value: VariableValueType; label: string }[] = [
  { value: 'any', label: '任意' },
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' }
]

/**
 * 把拆分节点每格真实结果展开为独立的 image 资产节点，按原始行列排布，并把每格节点
 * 关联回拆分节点的生产关系。该关系不是数据边，避免把所有格子误当作拆分节点的
 * “当前输出”并干扰工作流执行。
 * 幂等：若本次媒体集合已被展开过（splitAutoExpandedFor 签名一致），直接返回已展开节点
 * 的 ID 而不重复创建；否则创建后把签名写回拆分节点 meta。
 */
export function expandSplitResults(
  editor: Editor,
  source: NodeCardShape
): { ids: TLShapeId[]; created: boolean } {
  const raw = typeof source.meta?.nodeResult === 'string' ? source.meta.nodeResult : ''
  const collection = parseMediaResultCollection(raw)
  if (!collection || collection.results.length < 2) return { ids: [], created: false }
  const spec = getNodeType('image')
  if (!spec) return { ids: [], created: false }
  const splitConfig = parseImageSplitConfig(readNodeConfig(source))
  const columns = splitConfig.columns
  const gap = 28
  const startX = source.x + source.props.w + 96
  const positionFor = (index: number): { x: number; y: number } => ({
    x: startX + (index % columns) * (spec.defaultSize.w + gap),
    y: source.y + Math.floor(index / columns) * (spec.defaultSize.h + gap)
  })

  // 幂等签名：以本套媒体集合的稳定标识为准（含媒体顺序与时间戳，重算/换图后签名变化才重建）。
  const signature = collection.results.map((item) => `${item.mediaId}@${item.createdAt}`).join('|')
  const previous = (source.meta?.splitAutoExpandedFor as string | undefined) ?? ''
  if (previous === signature) {
    // 已经展开过同一套结果，且对应节点仍在画布上，则不再重复创建。
    const existing = collection.results
      .map((_item, index) => `${source.id}:split:${index}`)
      .map((key) => editor.getShape(key as TLShapeId))
      .filter((shape): shape is NodeCardShape => Boolean(shape))
    if (existing.length === collection.results.length) {
      // 旧版本把所有格子竖直堆叠，选中后再打组会形成一根很长的“条”，缩放时视觉上像
      // 变形。仅迁移系统生成的旧布局一次；新版布局不再覆盖用户自行调整过的位置。
      if (source.meta?.splitAutoLayoutVersion !== 2) {
        editor.run(() => {
          existing.forEach((shape, index) => {
            editor.updateShape({ id: shape.id, type: 'node-card', ...positionFor(index) })
          })
        })
        editor.updateShape({
          id: source.id,
          type: 'node-card',
          meta: {
            ...(source.meta ?? {}),
            splitAutoExpandedFor: signature,
            splitAutoLayoutVersion: 2
          }
        })
      }
      return { ids: existing.map((s) => s.id), created: false }
    }
  }

  const ids: TLShapeId[] = []
  editor.run(() => {
    collection.results.forEach((item, index) => {
      const id = `${source.id}:split:${index}` as TLShapeId
      if (editor.getShape(id)) {
        ids.push(id)
        return
      }
      const position = positionFor(index)
      editor.createShape({
        id,
        type: 'node-card',
        x: position.x,
        y: position.y,
        props: {
          nodeType: 'image',
          title: `${source.props.title || '图片拆分'} · 第 ${index + 1} 格`,
          mediaId: item.mediaId,
          mediaPath: item.mediaPath,
          mediaMime: item.mime,
          w: spec.defaultSize.w,
          h: spec.defaultSize.h
        } satisfies Partial<NodeCardProps>
      })
      editor.updateShape({
        id,
        type: 'node-card',
        meta: {
          artifactProducerId: source.id,
          artifactProducerPortId: 'out-images',
          artifactRunId: item.runId,
          artifactCreatedAt: item.createdAt
        }
      })
      ids.push(id)
    })
  })
  // 记录已展开的签名，保证后续自动/手动展开幂等
  editor.updateShape({
    id: source.id,
    type: 'node-card',
    meta: { ...(source.meta ?? {}), splitAutoExpandedFor: signature, splitAutoLayoutVersion: 2 }
  })
  markUndoPoint(editor, 'image-split-expand-nodes')
  return { ids, created: true }
}
