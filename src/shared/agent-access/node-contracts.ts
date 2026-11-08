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
}

const CONTRACTS = new Map<string, NodeContractRecord>(
  GENERATED_NODE_CONTRACTS.map((record) => [record.typeId, record])
)

export function nodeContract(typeId: string): NodeContractRecord | null {
  return CONTRACTS.get(typeId) ?? null
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
