// 节点 Body 共享工具（路线图 R6：拆分超大 bodies.tsx）
//
// 从原 bodies.tsx 提出的、被多个节点 Body 复用的工具函数/组件。拆分后由各节点
// Body 文件从本模块 import。行为与原 bodies.tsx 完全等价。
// 本文件同时导出工具函数（非组件）与少量 UI 组件（ModelSelect/NoModelHint），
// 是共享模块而非单一组件文件，故豁免 React Fast Refresh 的组件-only 规则。
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { createShapeId, stopEventPropagation, type Editor } from 'tldraw'
import { modelsByModality } from '../../../stores/gateway'
import type { NodeCardShape, NodeCardProps } from '../../../canvas/NodeCardShape'
import { createEdge } from '../../../canvas/graph'
import { getNodeType, mediaUrl } from '../../registry'
import { Icon } from '../../../components/Icon'
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
    <select
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
    </select>
  )
}

// 未配置任何对应模态模型时的占位引导
export function NoModelHint({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <div className="gen-empty">
      <span>尚未配置可用模型</span>
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
  const id = createShapeId()
  const title =
    targetType === 'image-gen'
      ? '继续生图'
      : targetType === 'image-crop'
        ? '图片裁剪'
        : targetType === 'image-split'
          ? '图片拆分'
        : targetType === 'image-edit'
          ? '图片修改'
          : '图片生成视频'
  editor.createShape({
    id,
    type: 'node-card',
    x: source.x + source.props.w + 80,
    y: source.y,
    props: {
      nodeType: targetType,
      title,
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    } satisfies Partial<NodeCardProps>
  })
  const targetPort = 'in-image'
  if (
    !createEdge(
      editor,
      { shapeId: source.id, portId: 'out-image' },
      { shapeId: id, portId: targetPort }
    )
  ) {
    editor.deleteShape(id)
    return
  }
  editor.select(id)
}

/**
 * 从音频输出创建独立处理节点（当前仅支持人声分离）。
 * 快捷入口只建真实边，不在源节点内隐藏产物。
 */
export function createAudioContinuation(
  editor: Editor,
  source: NodeCardShape,
  targetType: 'vocal-separate'
): void {
  const spec = getNodeType(targetType)
  if (!spec) return
  const id = createShapeId()
  const titles: Record<typeof targetType, string> = {
    'vocal-separate': '人声分离'
  }
  editor.createShape({
    id,
    type: 'node-card',
    x: source.x + source.props.w + 80,
    y: source.y,
    props: {
      nodeType: targetType,
      title: titles[targetType],
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    } satisfies Partial<NodeCardProps>
  })
  if (
    !createEdge(
      editor,
      { shapeId: source.id, portId: 'out-audio' },
      { shapeId: id, portId: 'in-audio' }
    )
  ) {
    editor.deleteShape(id)
    return
  }
  editor.select(id)
}

/**
 * 一键提取人声模板：从视频节点创建 视频提音 → 人声分离 两个节点并预连线。
 * 底层是两个真实节点 + 两条真实边，不生成隐藏逻辑或超级节点。
 */
export function createVocalExtractionTemplate(
  editor: Editor,
  source: NodeCardShape
): void {
  const audioSpec = getNodeType('video-audio')
  const vocalSpec = getNodeType('vocal-separate')
  if (!audioSpec || !vocalSpec) return

  const audioId = createShapeId()
  const vocalId = createShapeId()
  const gap = 80

  editor.run(() => {
    editor.createShape({
      id: audioId,
      type: 'node-card',
      x: source.x + source.props.w + gap,
      y: source.y - vocalSpec.defaultSize.h / 4,
      props: {
        nodeType: 'video-audio',
        title: '提取音频',
        w: audioSpec.defaultSize.w,
        h: audioSpec.defaultSize.h
      } satisfies Partial<NodeCardProps>
    })
    editor.createShape({
      id: vocalId,
      type: 'node-card',
      x: source.x + source.props.w + gap + audioSpec.defaultSize.w + gap,
      y: source.y + vocalSpec.defaultSize.h / 4,
      props: {
        nodeType: 'vocal-separate',
        title: '人声分离',
        w: vocalSpec.defaultSize.w,
        h: vocalSpec.defaultSize.h
      } satisfies Partial<NodeCardProps>
    })
  })
  // 预连线：视频.out-video → 提音.in-video，提音.out-audio → 人声分离.in-audio
  createEdge(
    editor,
    { shapeId: source.id, portId: 'out-video' },
    { shapeId: audioId, portId: 'in-video' }
  )
  createEdge(
    editor,
    { shapeId: audioId, portId: 'out-audio' },
    { shapeId: vocalId, portId: 'in-audio' }
  )
  editor.select(vocalId)
}

/** 图片结果的统一下游入口。它只创建节点和声明端口边，不复制任何媒体。 */
export function ImageContinuationActions({
  editor,
  shape
}: {
  editor: Editor
  shape: NodeCardShape
}): React.JSX.Element {
  const actions: Array<{
    type: 'image-crop' | 'image-split' | 'image-gen' | 'image-edit' | 'video'
    icon: 'crop' | 'grid' | 'spark' | 'edit' | 'video'
    label: string
    title: string
  }> = [
    { type: 'image-crop', icon: 'crop', label: '裁剪图片', title: '创建裁剪节点并连接当前图片' },
    { type: 'image-split', icon: 'grid', label: '宫格拆分', title: '创建图片拆分节点并连接当前图片' },
    { type: 'image-gen', icon: 'spark', label: '继续生图', title: '创建生图节点并连接当前图片' },
    { type: 'image-edit', icon: 'edit', label: '修改图片', title: '对当前图片添加标注并修改' },
    { type: 'video', icon: 'video', label: '生成视频', title: '创建视频节点并将当前图片作为首帧' }
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
          <Icon name={action.icon} size={12} /> {action.label}
        </button>
      ))}
    </div>
  )
}

/** 从视频输出创建独立处理节点；快捷入口只建真实边，不在视频节点内隐藏产物。 */
export function createVideoContinuation(
  editor: Editor,
  source: NodeCardShape,
  targetType: 'video-frame' | 'video-clip' | 'video-audio'
): void {
  const spec = getNodeType(targetType)
  if (!spec) return
  const titles: Record<typeof targetType, string> = {
    'video-frame': '视频取帧',
    'video-clip': '视频截取',
    'video-audio': '提取音频'
  }
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'node-card',
    x: source.x + source.props.w + 80,
    y: source.y,
    props: {
      nodeType: targetType,
      title: titles[targetType],
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
    return
  }
  editor.select(id)
}

/**
 * 导演台的预演视频不是“下载提示”，而是可以直接注入视频节点的真实运动参考。
 * 此快捷入口只创建 video.in-reference-video 边，不复制视频、不读取隐藏状态。
 */
export function createPrevisVideoReference(editor: Editor, source: NodeCardShape): void {
  const spec = getNodeType('video')
  if (!spec) return
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'node-card',
    x: source.x + source.props.w + 80,
    y: source.y,
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

/** 所有媒体结果卡统一展示来源摘要；完整提示词仍只在悬浮 title 中提供。 */
export function MediaSourceBadge({
  shape,
  fallback = '本地资产'
}: {
  shape: NodeCardShape
  fallback?: string
}): React.JSX.Element {
  const source = mediaSourceMeta(shape)
  const label = source?.modelKey || fallback
  const time = source?.at ? ` · ${new Date(source.at).toLocaleTimeString()}` : ''
  return (
    <span className="node-media-source" title={source?.prompt || shape.props.mediaPath}>
      <Icon name={source ? 'info' : 'image'} size={11} />
      {label}
      {time}
    </span>
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
      <button
        className="icon-btn"
        title="用系统默认程序打开"
        aria-label="用系统默认程序打开"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void window.api.openMedia(shape.props.mediaId)
        }}
      >
        <Icon name="external" size={11} />
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
  onDelete
}: {
  shape: NodeCardShape
  kind: 'image' | 'video' | 'audio'
  onSelect: (item: MediaResultItem) => void
  openPreview: (item: MediaResultItem) => void
  onClear?: () => void
  onDelete?: (item: MediaResultItem) => void
}): React.JSX.Element | null {
  const [compareIds, setCompareIds] = useState<string[]>([])
  const collection = parseMediaResultCollection(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  if (!collection || collection.results.length < 2) return null
  const selected = collection.selectedMediaId || shape.props.mediaId
  const compareItems = compareIds
    .map((id) => collection.results.find((item) => item.mediaId === id))
    .filter((item): item is MediaResultItem => Boolean(item))
  const toggleCompare = (item: MediaResultItem): void => {
    setCompareIds((current) => {
      if (current.includes(item.mediaId)) return current.filter((id) => id !== item.mediaId)
      return current.length >= 2 ? [current[1]!, item.mediaId] : [...current, item.mediaId]
    })
  }
  return (
    <div className="media-result-collection" aria-label="生成结果集合">
      <div className="media-result-collection-head">
        <span className="media-result-summary">
          <strong>{collection.results.length}</strong> 个候选
          <em>{selected ? '当前输出已确定' : '尚未选择输出'}</em>
        </span>
        <span className="media-result-collection-tools">
          <small>{compareItems.length === 2 ? '正在对比 2 项结果' : '点击候选设为当前输出'}</small>
          {onClear && collection.results.length > 1 ? (
            <button
              type="button"
              className="icon-btn"
              title="清空历史结果，仅保留当前输出"
              aria-label="清空历史结果，仅保留当前输出"
              onPointerDown={(event) => stopEventPropagation(event)}
              onClick={(event) => {
                event.stopPropagation()
                onClear()
              }}
            >
              <Icon name="trash" size={11} />
            </button>
          ) : null}
        </span>
      </div>
      {compareItems.length === 2 && (
        <div className="media-result-compare" aria-label="结果对比">
          {compareItems.map((item) => (
            <div className="media-result-compare-item" key={item.mediaId}>
              {kind === 'image' ? (
                <img src={mediaUrl(item.mediaPath)} alt="对比结果" draggable={false} />
              ) : kind === 'video' ? (
                <video src={mediaUrl(item.mediaPath)} preload="metadata" muted playsInline />
              ) : (
                <span className="media-result-audio-tile">
                  <Icon name="audio" size={20} />
                </span>
              )}
              <small>{item.mediaId === selected ? '当前输出' : '历史结果'}</small>
            </div>
          ))}
        </div>
      )}
      <div className="media-result-grid">
        {collection.results.map((item) => {
          const active = item.mediaId === selected
          return (
            <div
              role="button"
              tabIndex={0}
              key={item.mediaId}
              className={`media-result-tile ${active ? 'selected' : ''} ${compareIds.includes(item.mediaId) ? 'compare' : ''}`}
              title={active ? '当前输出；点击预览' : '设为当前输出'}
              onPointerDown={(event) => stopEventPropagation(event)}
              onClick={(event) => {
                event.stopPropagation()
                if (active) openPreview(item)
                else onSelect(item)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (active) openPreview(item)
                else onSelect(item)
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
              <span className="media-result-tile-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title={compareIds.includes(item.mediaId) ? '取消对比' : '加入对比'}
                  aria-label={compareIds.includes(item.mediaId) ? '取消对比' : '加入对比'}
                  onPointerDown={(event) => stopEventPropagation(event)}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleCompare(item)
                  }}
                >
                  <Icon name="compare" size={11} />
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
                      onDelete(item)
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

// 点击 vs 拖拽判定：拖动卡片时元素随指针移动，pointerup 仍会触发 click，
// 位移超过阈值视为拖拽，不触发预览
export function useClickGuard(): {
  onPointerDown: (e: React.PointerEvent) => void
  onClick: (e: React.MouseEvent, open: () => void) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e) => {
      downRef.current = { x: e.clientX, y: e.clientY }
    },
    onClick: (e, open) => {
      const d = downRef.current
      downRef.current = null
      if (!d) return
      if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) return
      e.stopPropagation()
      open()
    }
  }
}

// 卡片内可滚动区域：内容可滚时截断 wheel 冒泡，避免滚动手势被画布抢走（缩放/平移）。
// 必须用原生监听：tldraw 的 wheel 监听在容器上，React 合成事件的 stopPropagation 到不了它
export function useWheelScroll(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const canScroll =
        e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
      if (canScroll) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [ref])
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
