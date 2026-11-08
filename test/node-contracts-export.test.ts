// 节点类型契约快照：导出与漂移门禁（N1）。
// @vitest-environment jsdom
//
// 背景：外部 Agent 需要"不创建实例就能知道某类节点的端口与默认配置"，但节点定义在
// renderer 的 TSX 模块里（间接拉入 React/tldraw），main/CLI 不能导入。因此这里在
// jsdom 下加载**真实节点注册表**，用与 GUI 相同的 `getNodePorts` 导出契约常量。
//
// 两种模式：
// - 默认（普通测试运行）：把导出文件与"现场重新计算的结果"逐字段比较——注册表改了
//   却忘记重生成快照，这里立刻失败（漂移门禁）；
// - 生成：设置 CANVAS_NODE_CONTRACTS_WRITE=1 后再跑，写回
//   src/shared/agent-access/generated/node-contracts.generated.ts。
import { beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { allNodeTypes, getNodePorts } from '@renderer/nodes/registry'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { ACTIVE_NODE_TYPE_IDS } from '@shared/types'
import type { NodeContractRecord, NodePortContract } from '@shared/agent-access/node-contracts'
import { GENERATED_NODE_CONTRACTS } from '@shared/agent-access/generated/node-contracts.generated'

const OUTPUT_PATH = join(
  process.cwd(),
  'src/shared/agent-access/generated/node-contracts.generated.ts'
)

function toPorts(ports: { in: unknown[]; out: unknown[] }): {
  in: NodePortContract[]
  out: NodePortContract[]
} {
  const map = (dir: 'in' | 'out', list: unknown[]): NodePortContract[] =>
    list.map((raw) => {
      const port = raw as {
        id: string
        type: string
        required: boolean
        cardinality: 'one' | 'many'
        name?: string
        description?: string
        schema?: { id: string; version: number }
      }
      return {
        id: port.id,
        dir,
        type: port.type,
        required: port.required === true,
        cardinality: port.cardinality,
        ...(port.name ? { name: port.name } : {}),
        ...(port.description ? { description: port.description } : {}),
        // 端口 Schema 引用在节点契约里是 {id, version}；导出成 `id@version` 便于外部直接比对。
        ...(port.schema ? { schema: `${port.schema.id}@${port.schema.version}` } : {})
      }
    })
  return { in: map('in', ports.in), out: map('out', ports.out) }
}

/** 用默认配置合成契约实例形状（只读取依赖 props.config/text/mediaId 的解析器）。 */
function shapeFor(spec: ReturnType<typeof allNodeTypes>[number]): NodeCardShape {
  return {
    id: `shape:contract-${spec.type}`,
    type: 'node-card',
    props: {
      nodeType: spec.type,
      title: spec.label,
      config: spec.initialConfig ?? '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    }
  } as unknown as NodeCardShape
}

function buildRecords(): NodeContractRecord[] {
  const byType = new Map(allNodeTypes().map((spec) => [spec.type, spec]))
  return ACTIVE_NODE_TYPE_IDS.map((typeId) => {
    const spec = byType.get(typeId)
    if (!spec) throw new Error(`NODE_TYPE_NOT_REGISTERED:${typeId}`)
    return {
      typeId,
      contractVersion: spec.contractVersion,
      label: spec.label,
      description: spec.description,
      category: spec.category,
      creatable: spec.creatable !== false,
      defaultSize: { w: spec.defaultSize.w, h: spec.defaultSize.h },
      sizePolicy: spec.sizePolicy ?? 'standard',
      executionMode: spec.executionMode ?? 'auto',
      outputSource: spec.outputSource ?? 'run',
      ...(spec.executionDisabledReason
        ? { executionDisabledReason: spec.executionDisabledReason }
        : {}),
      initialConfig: spec.initialConfig ?? null,
      dynamicPorts: Boolean(spec.resolvePorts),
      ports: toPorts(getNodePorts(spec, shapeFor(spec)))
    }
  })
}

function renderSource(records: NodeContractRecord[]): string {
  return [
    '// 本文件由 test/node-contracts-export.test.ts 生成，请勿手改。',
    '// 重新生成：$env:CANVAS_NODE_CONTRACTS_WRITE=1; node scripts/run-vitest.cjs run test/node-contracts-export.test.ts',
    "import type { NodeContractRecord } from '../node-contracts'",
    '',
    'export const GENERATED_NODE_CONTRACTS: NodeContractRecord[] = ' +
      JSON.stringify(records, null, 2),
    ''
  ].join('\n')
}

describe('节点契约快照', () => {
  beforeAll(() => {
    registerAllNodeTypes()
  })

  it('导出的快照与真实节点注册表一致（不一致时重生成）', () => {
    const records = buildRecords()
    if (process.env.CANVAS_NODE_CONTRACTS_WRITE === '1') {
      writeFileSync(OUTPUT_PATH, renderSource(records), 'utf8')
      return
    }
    // 漂移门禁：逐节点比较。用序列化比较而不是深比较，失败信息能直接看到差异位置。
    expect(JSON.parse(JSON.stringify(GENERATED_NODE_CONTRACTS))).toEqual(
      JSON.parse(JSON.stringify(records))
    )
  })

  it('快照覆盖全部 Active 节点且字段完整', () => {
    const records = buildRecords()
    expect(records.map((record) => record.typeId)).toEqual([...ACTIVE_NODE_TYPE_IDS])
    for (const record of records) {
      expect(record.contractVersion).toBeGreaterThanOrEqual(1)
      expect(record.label.length).toBeGreaterThan(0)
      expect(record.description.length).toBeGreaterThan(0)
      for (const port of [...record.ports.in, ...record.ports.out]) {
        expect(port.id.length).toBeGreaterThan(0)
        expect(['one', 'many']).toContain(port.cardinality)
        expect(['in', 'out']).toContain(port.dir)
      }
    }
  })
})
