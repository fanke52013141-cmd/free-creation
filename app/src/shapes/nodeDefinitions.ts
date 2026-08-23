import type { TLShape } from 'tldraw'
import { CHAT_TYPE, IMAGE_ASSET_TYPE, IMAGE_GEN_TYPE, MERGE_TYPE, ONE_SHOT_TYPE, SPLIT_TYPE, TEXT_TYPE, VIDEO_GEN_TYPE } from './types'

export type ValueKind =
  | 'Text' | 'Text[]' | 'Prompt' | 'Prompt[]' | 'ChatHistory' | 'Structured'
  | 'Image' | 'Image[]' | 'Video' | 'Video[]' | 'Audio' | 'Audio[]' | 'Doc'
export type { NodeRunState } from './types'
export type NodeCategory = 'generate' | 'asset' | 'process' | 'tool'

export interface PortDefinition { name: string; kinds: ValueKind[]; optional?: boolean }
export interface NodeDefinition {
  type: string; name: string; icon: string; desc: string; category: NodeCategory
  inputs: PortDefinition[]; outputs: PortDefinition[]
  defaultSize: { w: 360; h: 360 }; implemented: boolean; color: string
  resolveOutputKind?: (shape: TLShape) => ValueKind | null
}

const SIZE = { w: 360, h: 360 } as const
const output = (name: string, ...kinds: ValueKind[]): PortDefinition => ({ name, kinds })

export const NODE_DEFINITIONS: readonly NodeDefinition[] = [
  { type: CHAT_TYPE, name: '聊天节点', icon: '💬', desc: '多轮对话并沉淀完整历史', category: 'generate', inputs: [{ name: 'context', kinds: ['Text'], optional: true }], outputs: [output('history', 'ChatHistory')], defaultSize: SIZE, implemented: true, color: '#3b82f6' },
  { type: ONE_SHOT_TYPE, name: '单次处理', icon: '⚡', desc: '用 Prompt 模板执行一次文本处理，数组输入自动扇出', category: 'generate', inputs: [{ name: 'input', kinds: ['Text', 'Text[]', 'ChatHistory', 'Structured'] }], outputs: [output('result', 'Text', 'Text[]')], defaultSize: SIZE, implemented: true, color: '#8b5cf6', resolveOutputKind: (shape) => Array.isArray(shape.meta.outputItems) ? 'Text[]' : 'Text' },
  { type: IMAGE_GEN_TYPE, name: '图片生成', icon: '🎨', desc: 'Prompt 与参考图生成稳定的本地图片资产', category: 'generate', inputs: [{ name: 'prompt', kinds: ['Text', 'Text[]', 'Prompt', 'Prompt[]', 'ChatHistory', 'Structured'] }, { name: 'references', kinds: ['Image', 'Image[]'], optional: true }], outputs: [output('images', 'Image[]')], defaultSize: SIZE, implemented: true, color: '#ec4899' },
  { type: VIDEO_GEN_TYPE, name: '视频生成', icon: '🎬', desc: 'Prompt 与首帧图片提交可恢复的本地视频任务', category: 'generate', inputs: [{ name: 'prompt', kinds: ['Text', 'Text[]', 'Prompt', 'Prompt[]', 'ChatHistory', 'Structured'] }, { name: 'references', kinds: ['Image', 'Image[]'], optional: true }], outputs: [output('videos', 'Video[]')], defaultSize: SIZE, implemented: true, color: '#f59e0b' },
  { type: 'annotate-edit', name: '标注修图', icon: '✏️', desc: '通过标注数据编辑图片', category: 'generate', inputs: [{ name: 'image', kinds: ['Image'] }, { name: 'annotation', kinds: ['Structured'] }], outputs: [output('image', 'Image')], defaultSize: SIZE, implemented: false, color: '#ef4444' },
  { type: TEXT_TYPE, name: '文本资产', icon: '📝', desc: '可复用的纯文本或 Markdown 内容', category: 'asset', inputs: [], outputs: [output('text', 'Text')], defaultSize: SIZE, implemented: true, color: '#f59e0b' },
  { type: IMAGE_ASSET_TYPE, name: '图片资产', icon: '🖼️', desc: '入库并发布稳定图片引用', category: 'asset', inputs: [], outputs: [output('image', 'Image')], defaultSize: SIZE, implemented: true, color: '#06b6d4' },
  { type: 'video-asset', name: '视频资产', icon: '🎞️', desc: '入库并发布稳定视频引用', category: 'asset', inputs: [], outputs: [output('video', 'Video')], defaultSize: SIZE, implemented: false, color: '#10b981' },
  { type: 'audio-asset', name: '音频资产', icon: '🎵', desc: '入库并发布稳定音频引用', category: 'asset', inputs: [], outputs: [output('audio', 'Audio')], defaultSize: SIZE, implemented: false, color: '#84cc16' },
  { type: 'doc-asset', name: '文档资产', icon: '📄', desc: 'Word/PDF 等文档输入', category: 'asset', inputs: [], outputs: [output('doc', 'Doc')], defaultSize: SIZE, implemented: false, color: '#6366f1' },
  { type: 'image-process', name: '图像处理', icon: '◫', desc: '通过 op 裁剪、缩放或转换图片', category: 'process', inputs: [{ name: 'image', kinds: ['Image', 'Image[]'] }], outputs: [output('result', 'Image', 'Image[]')], defaultSize: SIZE, implemented: false, color: '#0ea5e9' },
  { type: 'video-process', name: '视频处理', icon: '✂', desc: '通过 op 裁剪、截帧或转换视频', category: 'process', inputs: [{ name: 'video', kinds: ['Video', 'Video[]'] }], outputs: [output('result', 'Video', 'Image', 'Audio')], defaultSize: SIZE, implemented: false, color: '#14b8a6' },
  { type: 'audio-process', name: '音频处理', icon: '⌁', desc: '通过 op 截取或转换音频', category: 'process', inputs: [{ name: 'audio', kinds: ['Audio', 'Audio[]'] }], outputs: [output('result', 'Audio', 'Audio[]')], defaultSize: SIZE, implemented: false, color: '#84cc16' },
  { type: SPLIT_TYPE, name: 'Split 拆分', icon: '⇶', desc: '按规则把单条文本拆为 Text[]', category: 'tool', inputs: [{ name: 'text', kinds: ['Text', 'ChatHistory', 'Structured'] }], outputs: [output('items', 'Text[]')], defaultSize: SIZE, implemented: true, color: '#f97316' },
  { type: MERGE_TYPE, name: 'Merge 合并', icon: '⊕', desc: '把 Text[] 合并为 Text', category: 'tool', inputs: [{ name: 'items', kinds: ['Text[]'] }], outputs: [output('text', 'Text')], defaultSize: SIZE, implemented: true, color: '#d946ef' },
  { type: 'text-preview', name: '文本预览', icon: '◎', desc: '只读呈现绑定，不传递数据', category: 'tool', inputs: [{ name: 'text', kinds: ['Text'] }], outputs: [], defaultSize: SIZE, implemented: false, color: '#64748b' },
] as const

export const NODE_DEFINITION_BY_TYPE = new Map(NODE_DEFINITIONS.map((definition) => [definition.type, definition]))
export const CATEGORY_LABEL: Record<NodeCategory, string> = { generate: '生成', asset: '资产', process: '处理', tool: '工具' }
export const getNodeDefinition = (type: string) => NODE_DEFINITION_BY_TYPE.get(type)
export const isNodeShape = (shape: TLShape) => NODE_DEFINITION_BY_TYPE.has(shape.type)
export function getShapeOutputKinds(shape: TLShape): ValueKind[] {
  const definition = getNodeDefinition(shape.type)
  if (!definition) return []
  const resolved = definition.resolveOutputKind?.(shape)
  return resolved ? [resolved] : definition.outputs.flatMap((port) => port.kinds)
}
