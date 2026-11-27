import type { Editor } from 'tldraw'
import { atom, type Atom } from 'tldraw'
import { nodePageIndex } from './node-page-index'

export type CanvasPerfTier = 0 | 1 | 2 | 3

export interface CanvasPerfPolicy {
  tier: CanvasPerfTier
  /** 仅 Tier 1+ 启用离屏节点 DOM 休眠。 */
  virtualizeOffscreenNodes: boolean
  /** 离屏预渲染边距（页面坐标 px）。 */
  viewportMarginPx: number
  /** 离屏常驻 LRU 上限。 */
  offscreenLruLimit: number
  /** 媒体节点缩略图独立阈值（>15 进入，<10 退出）。 */
  useMediaThumbnails: boolean
  /** Tier 1+ 静默空闲未连接端口呼吸动画。 */
  suppressIdlePortPulse: boolean
  /** Tier 2+ 仅选中/悬停/运行边显示流光动画。 */
  activeOnlyEdgeFlow: boolean
  /** Tier 2+ 跳过 .data-edge-hit 隐藏 DOM（命中始终走纯数学）。 */
  skipEdgeHitDom: boolean
  /** Tier 2+ 亮色主题关闭卡片 backdrop-filter。 */
  disableLightCardBlur: boolean
  /** Tier 3 强制裁剪离屏连线。 */
  cullOffscreenEdges: boolean
  /** 远景概览 LOD（默认关闭，保护用户体验）。 */
  enableOverviewLod: boolean
}

export interface PerfTierInputs {
  nodeCount: number
  edgeCount: number
  mediaNodeCount: number
}

export interface PerfTierState {
  tier: CanvasPerfTier
  useMediaThumbnails: boolean
}

/**
 * 纯函数滞回状态机：根据当前档位与最新节点/连线/媒体数计算下一档位。
 * 滞回区间防止在临界值（60 / 150 / 300）附近增删节点时抖动。
 */
export function computeNextPerfTierState(
  prev: PerfTierState,
  inputs: PerfTierInputs
): PerfTierState {
  const { nodeCount, edgeCount, mediaNodeCount } = inputs
  let tier: CanvasPerfTier = prev.tier

  // 升档（可跨档直达）
  if (nodeCount > 300 || edgeCount > 400) {
    tier = 3
  } else if (nodeCount > 150 || edgeCount > 200) {
    if (tier < 2) tier = 2
  } else if (nodeCount > 60) {
    if (tier < 1) tier = 1
  }

  // 降档（带滞回缓冲区）
  if (tier === 3 && nodeCount < 260 && edgeCount < 340) {
    tier = nodeCount > 150 || edgeCount > 200 ? 2 : nodeCount > 60 ? 1 : 0
  }
  if (tier === 2 && nodeCount < 120 && edgeCount < 160) {
    tier = nodeCount > 60 ? 1 : 0
  }
  if (tier === 1 && nodeCount < 45) {
    tier = 0
  }

  const useMediaThumbnails = prev.useMediaThumbnails
    ? mediaNodeCount >= 10
    : mediaNodeCount > 15

  return { tier, useMediaThumbnails }
}

export function policyForPerfState(state: PerfTierState): CanvasPerfPolicy {
  const { tier, useMediaThumbnails } = state
  return {
    tier,
    virtualizeOffscreenNodes: tier >= 1,
    viewportMarginPx: tier >= 3 ? 500 : 800,
    offscreenLruLimit: tier >= 3 ? 16 : 40,
    useMediaThumbnails,
    suppressIdlePortPulse: tier >= 1,
    activeOnlyEdgeFlow: tier >= 2,
    skipEdgeHitDom: tier >= 2,
    disableLightCardBlur: tier >= 2,
    cullOffscreenEdges: tier >= 3,
    enableOverviewLod: false
  }
}

const DEFAULT_STATE: PerfTierState = { tier: 0, useMediaThumbnails: false }
const DEFAULT_POLICY: CanvasPerfPolicy = policyForPerfState(DEFAULT_STATE)

interface PerfTierEntry {
  policyAtom: Atom<CanvasPerfPolicy>
  dispose: () => void
}

const registry = new WeakMap<Editor, PerfTierEntry>()

export function canvasPerfPolicy(editor: Editor): CanvasPerfPolicy {
  let entry = registry.get(editor)
  if (!entry) {
    const readInputs = (): PerfTierInputs => {
      const idx = nodePageIndex(editor)
      return {
        nodeCount: idx.counts.nodes,
        edgeCount: idx.counts.edges,
        mediaNodeCount: idx.counts.mediaNodes
      }
    }
    let state = computeNextPerfTierState(DEFAULT_STATE, readInputs())
    const policyAtom = atom<CanvasPerfPolicy>('canvasPerfPolicy', policyForPerfState(state))

    let dispose = (): void => {}
    if (typeof editor.store?.listen === 'function') {
      const off = editor.store.listen(
        (change) => {
          const { added, removed } = change.changes
          if (Object.keys(added).length === 0 && Object.keys(removed).length === 0) return
          const next = computeNextPerfTierState(state, readInputs())
          if (next.tier !== state.tier || next.useMediaThumbnails !== state.useMediaThumbnails) {
            state = next
            policyAtom.set(policyForPerfState(next))
          }
        },
        { scope: 'document' }
      )
      dispose = off
    }
    entry = { policyAtom, dispose }
    registry.set(editor, entry)
  }
  return entry.policyAtom.get()
}

export function disposeCanvasPerfPolicy(editor: Editor): void {
  const entry = registry.get(editor)
  if (!entry) return
  entry.dispose()
  registry.delete(editor)
}

export { DEFAULT_POLICY }
