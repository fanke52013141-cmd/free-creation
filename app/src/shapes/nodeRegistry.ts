// ===== 节点注册表（集中管理所有节点的元数据）=====
// 符合《开发规范-铁律v1.0》§4.1 节点全景清单 + §6.2 借鉴扣子的 WorkflowNodeRegistry 范式
// 左侧节点面板、tooltip、拖拽创建都读取这份注册表，加新节点 = 加一条记录。

import { CHAT_TYPE, TEXT_TYPE } from './types'

export type NodeCategory = 'generate' | 'asset' | 'process' | 'tool'

export interface NodeMeta {
  /** tldraw shape type；未实现的节点用占位 type */
  type: string
  /** 显示名 */
  name: string
  /** 图标（emoji 或字符）*/
  icon: string
  /** 简短描述（tooltip 第一行）*/
  desc: string
  /** 输入端口（tooltip 详情）*/
  inputs: string
  /** 输出端口（tooltip 详情）*/
  outputs: string
  /** 分类 */
  category: NodeCategory
  /** 节点默认宽高（拖拽创建时用）*/
  w: number
  h: number
  /** 是否已实现（false = 灰色占位，不可拖拽）*/
  implemented: boolean
  /** 主题色（边框/底色）*/
  color: string
}

export const CATEGORY_LABEL: Record<NodeCategory, string> = {
  generate: '生成类',
  asset: '资产类',
  process: '处理类',
  tool: '工具/呈现',
}

/** 所有节点元数据（顺序 = 左侧面板的显示顺序）*/
export const NODE_REGISTRY: NodeMeta[] = [
  // ===== 生成类（已实现 1 个）=====
  {
    type: CHAT_TYPE,
    name: '聊天节点',
    icon: '💬',
    desc: '与模型多轮对话，对话历史沉淀在节点内',
    inputs: 'context: Text?（可选上下文）',
    outputs: 'ChatHistory（可转 Text）',
    category: 'generate',
    w: 380,
    h: 520,
    implemented: true,
    color: '#3b82f6',
  },
  {
    type: 'one-shot',
    name: '单次处理',
    icon: '⚡',
    desc: '无状态 one-shot LLM 调用，换 prompt 模板做分镜/提取/润色/翻译',
    inputs: 'input: Text / Doc / ChatHistory',
    outputs: 'Structured（可转 Text）',
    category: 'generate',
    w: 360,
    h: 320,
    implemented: false,
    color: '#8b5cf6',
  },
  {
    type: 'image-gen',
    name: '图片生成',
    icon: '🎨',
    desc: 'prompt + 参考图 → 中转站 Image 2 生成图片（异步任务）',
    inputs: 'prompt: Prompt | Prompt[], refs: Image?',
    outputs: 'Image | Image[]',
    category: 'generate',
    w: 360,
    h: 420,
    implemented: false,
    color: '#ec4899',
  },
  {
    type: 'video-gen',
    name: '视频生成',
    icon: '🎬',
    desc: 'prompt + 参考图 → MiniMax H3 / Seedance 2.0 生成视频（长任务队列）',
    inputs: 'prompt: Prompt | Prompt[], refs: Image?',
    outputs: 'Video | Video[]',
    category: 'generate',
    w: 360,
    h: 420,
    implemented: false,
    color: '#f59e0b',
  },
  {
    type: 'annotate-edit',
    name: '标注修图',
    icon: '✏️',
    desc: '画标注框指哪打哪，基于标注 AI 修图',
    inputs: 'image: Image, annotation: 标注数据',
    outputs: 'Image',
    category: 'generate',
    w: 420,
    h: 480,
    implemented: false,
    color: '#ef4444',
  },

  // ===== 资产类（已实现 1 个）=====
  {
    type: TEXT_TYPE,
    name: '文本资产',
    icon: '📝',
    desc: '纯文本/Markdown 载体，可被聊天节点引用为上下文',
    inputs: '—',
    outputs: 'Text',
    category: 'asset',
    w: 340,
    h: 240,
    implemented: true,
    color: '#f59e0b',
  },
  {
    type: 'image-asset',
    name: '图片资产',
    icon: '🖼️',
    desc: '图片载体，上传入库后可被生成节点引用',
    inputs: '—',
    outputs: 'Image',
    category: 'asset',
    w: 280,
    h: 280,
    implemented: false,
    color: '#06b6d4',
  },
  {
    type: 'video-asset',
    name: '视频资产',
    icon: '🎞️',
    desc: '视频载体，上传入库后可被处理节点引用',
    inputs: '—',
    outputs: 'Video',
    category: 'asset',
    w: 320,
    h: 280,
    implemented: false,
    color: '#10b981',
  },
  {
    type: 'audio-asset',
    name: '音频资产',
    icon: '🎵',
    desc: '音频载体',
    inputs: '—',
    outputs: 'Audio',
    category: 'asset',
    w: 280,
    h: 160,
    implemented: false,
    color: '#84cc16',
  },
  {
    type: 'doc-asset',
    name: '文档资产',
    icon: '📄',
    desc: 'Word/PDF 文档，可被单次处理节点读取（如剧本）',
    inputs: '—',
    outputs: 'Doc',
    category: 'asset',
    w: 300,
    h: 260,
    implemented: false,
    color: '#6366f1',
  },

  // ===== 处理类（全部未实现）=====
  {
    type: 'image-process',
    name: '图像处理',
    icon: '🔍',
    desc: '切分/裁剪/缩放/转格式/抠背景/转线稿（op 机制）',
    inputs: 'image: Image | Image[]',
    outputs: '取决于 op',
    category: 'process',
    w: 320,
    h: 280,
    implemented: false,
    color: '#0ea5e9',
  },
  {
    type: 'video-process',
    name: '视频处理',
    icon: '✂️',
    desc: '裁片段/截帧/提取音轨/变速/转深度/转白膜（op）',
    inputs: 'video: Video | Video[]',
    outputs: '取决于 op',
    category: 'process',
    w: 320,
    h: 280,
    implemented: false,
    color: '#14b8a6',
  },
  {
    type: 'audio-process',
    name: '音频处理',
    icon: '🎚️',
    desc: '截取片段（op）',
    inputs: 'audio: Audio | Audio[]',
    outputs: 'Audio | Audio[]',
    category: 'process',
    w: 300,
    h: 200,
    implemented: false,
    color: '#a3e635',
  },

  // ===== 工具/呈现（全部未实现）=====
  {
    type: 'split',
    name: 'Split 拆分',
    icon: '🔀',
    desc: '按分隔符把 Text 拆成 Text[]，支撑批量分镜',
    inputs: 'text: Text',
    outputs: 'Text[]',
    category: 'tool',
    w: 280,
    h: 200,
    implemented: false,
    color: '#f97316',
  },
  {
    type: 'merge',
    name: 'Merge 合并',
    icon: '➕',
    desc: '把 Text[]/Image[]/Video[] 合并回单值',
    inputs: 'items: Text[] | Image[] | Video[]',
    outputs: 'Text | Image | Video',
    category: 'tool',
    w: 280,
    h: 200,
    implemented: false,
    color: '#d946ef',
  },
  {
    type: 'text-preview',
    name: '文本预览',
    icon: '👁️',
    desc: '呈现绑定：订阅某来源实时镜像显示（只读）',
    inputs: 'text: Text',
    outputs: '（呈现，无输出）',
    category: 'tool',
    w: 340,
    h: 240,
    implemented: false,
    color: '#64748b',
  },
]

/** 拖拽时用的 dataTransfer MIME type */
export const NODE_DRAG_MIME = 'application/x-infinite-canvas-node'
