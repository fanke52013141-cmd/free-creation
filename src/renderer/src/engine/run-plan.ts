// T07（F07）：运行计划。在发起执行前，把「将执行哪些节点、其中多少个会调用
// 生成模型」推导为可呈现的摘要。纯函数：输入派生图与目标集合，不做任何 IO。
//
// 边界（与审查报告 F07 一致）：
// - 只回答范围与规模，不预测结果正确性；
// - generateCount 只统计「直接调用生成模型」的节点（image-gen/image-edit/video/
//   speech/voice-design），本地 ffmpeg/裁剪等不计入；iterate 的循环体由循环节点
//   统一驱动，不重复计数。
import type { CanvasNode } from '@shared/types'

export interface RunPlanEntry {
  id: string
  title: string
  nodeType: string
  generates: boolean
}

export interface RunPlan {
  /** 将按拓扑顺序执行的节点（不含循环体成员）。 */
  willRun: RunPlanEntry[]
  /** 其中直接调用生成模型的节点——可能产生供应商请求/费用。 */
  willGenerate: RunPlanEntry[]
}

/** 直接调用生成模型的节点类型。与执行器的付费请求路径对应。 */
const GENERATE_NODE_TYPES: ReadonlySet<string> = new Set([
  'image-gen',
  'image-edit',
  'video',
  'speech',
  'voice-design'
])

function toEntry(node: CanvasNode): RunPlanEntry {
  return {
    id: node.id,
    title: node.title || node.type,
    nodeType: node.type,
    generates: GENERATE_NODE_TYPES.has(node.type)
  }
}

/**
 * 推导一次运行的计划。targets 为空表示全图运行；非空表示仅运行目标及其上游
 * 依赖闭包（调用方需已求好闭包并传入对应节点/边）。
 */
export function deriveRunPlan(nodes: CanvasNode[], targets?: ReadonlySet<string>): RunPlan {
  const willRun = nodes
    .filter((node) => !targets || targets.has(node.id))
    .map(toEntry)
  const willGenerate = willRun.filter((entry) => entry.generates)
  return { willRun, willGenerate }
}

/** 运行摘要的中文呈现（确认弹窗/悬停说明共用同一文案，避免两套口径）。 */
export function formatRunPlan(plan: RunPlan): string {
  const total = plan.willRun.length
  const genCount = plan.willGenerate.length
  const genText =
    genCount > 0
      ? `其中 ${genCount} 个节点会调用生成模型（可能产生费用）`
      : '不涉及需要调用生成模型的节点'
  return `本次将执行 ${total} 个节点；${genText}。`
}
