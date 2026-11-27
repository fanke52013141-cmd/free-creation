import { ACTIVE_NODE_TYPE_IDS } from '../types'
import { GENERATED_NODE_CONTRACTS } from './generated/node-contracts.generated'

/**
 * 节点类型契约目录（N1：查询类型、默认值、字段、端口与依赖）。
 *
 * 为什么需要"生成快照"而不是让 main 直接读 renderer 规格：节点定义在 renderer 的
 * TSX 模块里（会间接拉入 React/tldraw 与组件），main/CLI 不能导入它；而外部 Agent
 * 恰恰最需要"不创建实例就能知道某类节点的端口与默认配置"。
 *
 * 做法：由 `test/node-contracts-export.test.ts` 在 jsdom 下加载真实节点注册表，
 * 用与 GUI 相同的 `getNodePorts` 把契约导出为 TypeScript 常量
 * （`generated/node-contracts.generated.ts`）。该测试在普通运行时是**漂移门禁**：
 * 注册表与导出文件不一致就失败，因此快照不可能悄悄过期。
 *
 * 诚实边界：带 `resolvePorts` 的节点（端口随配置变化）导出的是**默认配置下的端口**，
 * 记录里以 `dynamicPorts: true` 标注；实例的真实端口请用 `node.get` 读取。
 */
export const NODE_CONTRACT_SNAPSHOT_VERSION = 1

export interface NodePortContract {
  id: string
  dir: 'in' | 'out'
  type: string
  required: boolean
  cardinality: 'one' | 'many'
  name?: string
  description?: string
  schema?: string
}

export interface NodeConfigGuide {
  summary: string
  example: Record<string, unknown>
}

export interface NodeContractRecord {
  typeId: string
  contractVersion: number
  label: string
  description: string
  category: string
  creatable: boolean
  defaultSize: { w: number; h: number }
  sizePolicy: 'standard' | 'content' | 'free'
  executionMode: 'auto' | 'manual-publish' | 'display-only'
  outputSource: 'run' | 'document'
  executionDisabledReason?: string
  /** GUI 创建该类型节点时写入的初始配置（JSON 字符串）；无则 null。 */
  initialConfig: string | null
  /** true = 端口随配置动态派生，本记录的 ports 是默认配置下的结果。 */
  dynamicPorts: boolean
  ports: { in: NodePortContract[]; out: NodePortContract[] }
  /** 面向外部 Agent 的常用 config 字段说明与可直接复用的示例（不改变运行时默认值）。 */
  configGuide?: NodeConfigGuide
}

/**
 * 常用节点类型的 config 字段速查与示例（与各自执行器解析器同源）。
 * 解决外部 Agent 调 `node.type.get` 看到 `initialConfig: null` 后靠猜字段名的问题。
 */
export const NODE_CONFIG_GUIDES: Readonly<Partial<Record<string, NodeConfigGuide>>> = {
  'image-gen': {
    summary:
      '提示词放 props.text 或连入 in-text；参考图统一按顺序连入 in-images。config 支持 modelKey（可选，留空走默认绑定）、aspectRatio、resolution（1k/1.5k/2k/4k）、count（1-4）、background（transparent）。',
    example: { aspectRatio: '16:9', resolution: '2k', count: 1 }
  },
  video: {
    summary:
      '提示词放 props.text 或连入 in-text；所有参考图/首尾帧统一按顺序连入 in-images（不存在 in-first-frame）。mode 支持 text / first-frame / first-last-frame / reference；params 支持 ratio / duration / resolution / generateAudio / seed / watermark。',
    example: { mode: 'first-frame', params: { ratio: '16:9', duration: 5, generateAudio: false } }
  },
  'image-edit': {
    summary:
      '必须连入 in-image 原图；修改说明放 config.instruction 或连入 in-text。支持 modelKey、size / aspectRatio、resolution（1k/2k/4k）。',
    example: { size: 'auto', instruction: '将天空调整为黄昏暖色调，保持主体人物不变' }
  },
  'image-crop': {
    summary:
      '必须连入 in-image；rect 使用相对原图宽高的 0-1 归一化坐标（x/y/width/height），mode 支持 rect / quad，aspectRatio 支持 free / 1:1 / 16:9 / 9:16 等。',
    example: {
      version: 1,
      mode: 'rect',
      aspectRatio: '16:9',
      rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
    }
  },
  'image-split': {
    summary:
      '必须连入 in-image；键名为 rows 与 columns（注意不是 cols，乘积 <= 64），scalePercent 为每格面积比例（1-100）。',
    example: { version: 1, rows: 2, columns: 2, scalePercent: 100 }
  },
  'video-frame': {
    summary: '必须连入 in-video；mode 支持 first / last / custom（custom 时读取毫秒 timeMs），format 支持 png / jpg。',
    example: { version: 2, mode: 'first', timeMs: 0, format: 'png' }
  },
  'video-clip': {
    summary:
      '必须连入 in-video；startMs / endMs 为毫秒起止点，keepVideo / keepAudio 控制输出轨，quality 支持 fast / balanced / high。',
    example: {
      version: 3,
      startMs: 0,
      endMs: 5000,
      keepVideo: true,
      keepAudio: false,
      includeAudio: true,
      quality: 'balanced'
    }
  },
  'sound-adjust': {
    summary: 'mode 支持 rate（0.25-4 倍速）或 duration（目标毫秒 targetDurationMs），volumePercent 支持 0-300。',
    example: { version: 1, mode: 'rate', rate: 1.0, volumePercent: 100 }
  },
  'silence-trim': {
    summary: 'engine 支持 silence（能量阈值 thresholdDb）或 vad（vadThreshold），时长字段均以毫秒计（minGapMs/marginMs/keepGapMs）。',
    example: { version: 1, engine: 'silence', thresholdDb: -35, minGapMs: 300, marginMs: 80, keepGapMs: 120 }
  },
  processor: {
    summary:
      '固定端口为 in-value / out-value。operation 支持 pass（透传）、pick（按 path 提取 JSON 字段）、template（用 {{value}} 占位符拼接文本，注意不是 {{text}}）。',
    example: { operation: 'template', template: '电影级镜头：{{value}}，暖色晨光' }
  },
  code: {
    summary:
      '动态端口节点。config 必填 source（支持 async function main(args)）；自定义输入用 params: [{ name, type }]（生成端口 in-param-<kebab>）；多输出用 outputMode: "fields" + outputs: [{ name, type }]（生成端口 out-<kebab>）。type 取值为 string/number/boolean/object/array/any/image/video/audio/file/camera（注意不是 text/json）。',
    example: {
      source: 'async function main(args) { return { shot: { prompt: args.prompt } } }',
      params: [{ name: 'prompt', type: 'string' }],
      outputMode: 'fields',
      outputs: [{ name: 'shot', type: 'object' }]
    }
  },
  'ai-process': {
    summary:
      '提示词放 props.text 或连入 in-text；config 支持 system、mode（text/markdown/json）、temperature、maxTokens、modelKey（留空走默认绑定）。',
    example: { system: '你是专业分镜编剧，输出精炼画面描述。', mode: 'text', temperature: 0.7 }
  },
  iterate: {
    summary: '连入 in-list（JSON 数组）；onFailure 支持 skip/fail/retry，runMode 支持 all/resume/failed/changed，concurrency 1-4。',
    example: { onFailure: 'skip', maxRetries: 1, limit: 0, runMode: 'all', concurrency: 1 }
  },
  speech: {
    summary: '输入文本连入 in-text 或写 props.text；config 支持 backend（minimax 等）、voiceId、speed（0.5-2）、modelKey（providerId::modelId）。',
    example: { speed: 1.0 }
  },
  tts: {
    summary: '音色克隆节点：连入参考音频 in-audio；config 支持 providerId / modelId 或由默认绑定解析。',
    example: {}
  }
}

const CONTRACTS = new Map<string, NodeContractRecord>(
  GENERATED_NODE_CONTRACTS.map((record) => [record.typeId, record])
)

export function nodeContract(typeId: string): NodeContractRecord | null {
  const record = CONTRACTS.get(typeId)
  if (!record) return null
  const guide = NODE_CONFIG_GUIDES[typeId]
  return guide ? { ...record, configGuide: guide } : record
}

export function nodeContractDirectory(): {
  apiVersion: number
  derivedFrom: string
  count: number
  nodes: NodeContractRecord[]
} {
  return {
    apiVersion: NODE_CONTRACT_SNAPSHOT_VERSION,
    derivedFrom: 'test/node-contracts-export.test.ts（jsdom 下加载真实节点注册表生成）',
    count: CONTRACTS.size,
    // 按 Active 顺序输出，保证目录稳定可比对。
    nodes: ACTIVE_NODE_TYPE_IDS.map((typeId) => CONTRACTS.get(typeId)).filter(
      (record): record is NodeContractRecord => Boolean(record)
    )
  }
}

/** 门禁：目录必须覆盖全部 Active 节点，且每条记录字段完整。 */
export function validateNodeContractSnapshot(): string[] {
  const errors: string[] = []
  for (const typeId of ACTIVE_NODE_TYPE_IDS) {
    const record = CONTRACTS.get(typeId)
    if (!record) {
      errors.push(`CONTRACT_SNAPSHOT_MISSING:${typeId}`)
      continue
    }
    if (record.typeId !== typeId) errors.push(`CONTRACT_SNAPSHOT_TYPE_MISMATCH:${typeId}`)
    if (!Number.isInteger(record.contractVersion) || record.contractVersion < 1)
      errors.push(`CONTRACT_SNAPSHOT_BAD_VERSION:${typeId}`)
    if (!record.label || !record.description) errors.push(`CONTRACT_SNAPSHOT_NO_DOC:${typeId}`)
    for (const port of [...record.ports.in, ...record.ports.out]) {
      if (!port.id || !port.type) errors.push(`CONTRACT_SNAPSHOT_BAD_PORT:${typeId}`)
      if (port.dir !== 'in' && port.dir !== 'out') errors.push(`CONTRACT_SNAPSHOT_BAD_DIR:${typeId}`)
    }
  }
  for (const typeId of CONTRACTS.keys())
    if (!new Set<string>(ACTIVE_NODE_TYPE_IDS).has(typeId))
      errors.push(`CONTRACT_SNAPSHOT_UNKNOWN_TYPE:${typeId}`)
  return errors
}
