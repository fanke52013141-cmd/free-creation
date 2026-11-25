// @vitest-environment jsdom
// 节点流端到端组合测试（2026-11-20）。
//
// 与既有测试的分工：
// - composite-runtime.test.ts：纯函数（端口映射/输出收集/预算守卫）；
// - composite-executor.test.ts：composite 执行器边界（宿主注入桩）；
// - flow-matrix-basic.test.ts：主画布图引擎（串行/扇出/扇入/菱形）。
// 本文件补上真正的零覆盖缺口：runCompositeIsolated 隔离编排器全链——
// 即用户核心关切「节点串行/并行组合 → 封装为节点流 → 作为独立单元以
// 稳定输入/输出被外部调用」。使用真实 tldraw 隔离编辑器 + window.api 台账桩，
// 与真实桌面执行路径（GUI/headless 共用同一编排器）同口径。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runCompositeIsolated } from '@renderer/composite/run-composite'
import { compositeContentHash } from '@shared/composite/manifest'
import type { CompositeManifest } from '@shared/composite/manifest'
import type { NodeValue, NodeValuePacket, ContractInputMap } from '@shared/engine/inputs'
import {
  approveAllConfirms,
  bindSaveCoordinator,
  installWindowApi,
  resetEnginePhase,
  stubProviders
} from './helpers/flowHarness'
import { registerAllNodeTypes } from './helpers/registerNodes'

beforeAll(() => {
  registerAllNodeTypes()
  bindSaveCoordinator()
})
beforeEach(() => {
  resetEnginePhase()
  return approveAllConfirms()
})

// ---------------------------------------------------------------- 脚手架

type LedgerCall = { op: string; payload: Record<string, unknown> }

/** 台账桩：记录全部调用（runStart/runStep/runFinish…），支持登记已发布版本。 */
function installLedger(): {
  calls: LedgerCall[]
  publish: (manifest: CompositeManifest, contentHash: string) => void
  restore: () => void
} {
  const calls: LedgerCall[] = []
  const versions = new Map<string, { manifest: CompositeManifest; contentHash: string }>()
  const record =
    (op: string): ((payload: Record<string, unknown>) => Promise<{ ok: true; data: true }>) =>
    async (payload) => {
      calls.push({ op, payload })
      return { ok: true, data: true }
    }
  const api = {
    composite: {
      runStart: record('runStart'),
      runStep: record('runStep'),
      runStepOutput: record('runStepOutput'),
      runWait: record('runWait'),
      runFinish: record('runFinish'),
      versionGet: async (payload: { capabilityId: string; version: string }) => {
        calls.push({ op: 'versionGet', payload })
        const hit = versions.get(`${payload.capabilityId}@${payload.version}`)
        return hit
          ? { ok: true, data: hit }
          : { ok: false, error: { code: 'COMPOSITE_VERSION_NOT_FOUND', message: '版本不存在' } }
      }
    }
  }
  return {
    calls,
    publish: (manifest, contentHash) =>
      versions.set(`${manifest.capabilityId}@${manifest.version}`, { manifest, contentHash }),
    restore: installWindowApi(api)
  }
}

function textValue(text: string): NodeValue {
  return { kind: 'text', text }
}
function jsonValue(data: unknown): NodeValue {
  return { kind: 'json', data }
}

function packet(value: NodeValue): NodeValuePacket {
  return {
    type: value.kind === 'markdown' ? 'text' : value.kind,
    value,
    source: { nodeId: 'external', portId: 'external-in', runId: 'e2e-test' },
    createdAt: 0
  }
}

/** 外部调用约定：按公开输入端口喂值（portId 不带 in- 前缀，调用方传裸 ID）。 */
function inputMap(entries: Array<[string, NodeValue[]]>): ContractInputMap {
  return new Map(entries.map(([id, values]) => [`in-${id}`, values.map(packet)]))
}

function textNode(id: string, text = ''): CompositeManifest['graph']['nodes'][number] {
  return {
    id,
    nodeType: 'text',
    contractVersion: 3,
    title: `文本-${id}`,
    dx: 0,
    dy: 0,
    w: 340,
    h: 260,
    text
  }
}
function jsonNode(id: string): CompositeManifest['graph']['nodes'][number] {
  return {
    id,
    nodeType: 'json',
    contractVersion: 1,
    title: `JSON-${id}`,
    dx: 0,
    dy: 0,
    w: 340,
    h: 260
  }
}

const RUN_REQUEST_BASE = { headless: true as const }

function runFlow(
  manifest: CompositeManifest,
  inputs: ContractInputMap,
  ledger?: ReturnType<typeof installLedger>
): Promise<import('@shared/engine/composite-run-contract').CompositeRunOutcome> {
  return runCompositeIsolated({} as never, 'e2e-project', stubProviders(), {
    manifest,
    inputs,
    ...RUN_REQUEST_BASE
  }).then((outcome) => {
    void ledger
    return outcome
  })
}

function finishCall(calls: LedgerCall[]): Record<string, unknown> | undefined {
  return calls.find((call) => call.op === 'runFinish')?.payload
}

// ---------------------------------------------------------------- manifests

/** M1 单节点流：一个文本节点原样透传（最小可封装单元）。 */
function echoManifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'e2e-echo',
    version: '1.0',
    name: '回声流',
    inputs: [
      {
        id: 'msg',
        label: '输入文本',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'echo',
        label: '输出文本',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ],
    graph: { nodes: [textNode('n1')], edges: [] }
  }
}

/** M2 串行流：文本透传 → JSON 解析（两段依赖链，输出类型 text→json 变换）。 */
function serialManifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'e2e-serial',
    version: '1.0',
    name: '串行流',
    inputs: [
      {
        id: 'payload',
        label: 'JSON 文本',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'parsed',
        label: '解析结果',
        type: 'json',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n2', portId: 'out-json' }
      }
    ],
    graph: {
      nodes: [textNode('n1'), jsonNode('n2')],
      edges: [
        { from: { nodeId: 'n1', portId: 'out-text' }, to: { nodeId: 'n2', portId: 'in-text' } }
      ]
    }
  }
}

/** M3 并行流：一份输入广播到两条并行分支，分支结果各自公开，再扇入汇聚。 */
function parallelManifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'e2e-parallel',
    version: '1.0',
    name: '并行流',
    inputs: [
      {
        id: 'msg',
        label: '广播文本',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [
          { nodeId: 'b1', portId: 'in-text' },
          { nodeId: 'b2', portId: 'in-text' }
        ]
      }
    ],
    outputs: [
      {
        id: 'left',
        label: '左分支',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'b1', portId: 'out-text' }
      },
      {
        id: 'right',
        label: '右分支',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'b2', portId: 'out-text' }
      },
      {
        id: 'merged',
        label: '汇聚结果',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'fanin', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [textNode('b1'), textNode('b2'), textNode('fanin')],
      edges: [
        { from: { nodeId: 'b1', portId: 'out-text' }, to: { nodeId: 'fanin', portId: 'in-text' } },
        { from: { nodeId: 'b2', portId: 'out-text' }, to: { nodeId: 'fanin', portId: 'in-text' } }
      ]
    }
  }
}

/**
 * M4 外层流：内部嵌一个 echo 子流（子流即节点）。
 * mode='ref'：config 存固定版本引用（需发布仓库解析）；mode='inline'：config 直接内嵌 manifest。
 * childOutputPort：子流的公开输出端口 ID（echo 流为 out-echo）。
 */
function nestedOuterManifest(
  child: {
    capabilityId: string
    version: string
    contentHash?: string
    manifest?: CompositeManifest
  },
  options: { capabilityId?: string; childOutputPort?: string } = {}
): CompositeManifest {
  const config = child.manifest
    ? { manifest: child.manifest }
    : {
        ref: {
          capabilityId: child.capabilityId,
          version: child.version,
          ...(child.contentHash ? { contentHash: child.contentHash } : {})
        }
      }
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: options.capabilityId ?? 'e2e-outer',
    version: '1.0',
    name: '外层流',
    inputs: [
      {
        id: 'msg',
        label: '外层输入',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'c1', portId: 'in-msg' }]
      }
    ],
    outputs: [
      {
        id: 'final',
        label: '外层输出',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'c1', portId: options.childOutputPort ?? 'out-echo' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'c1',
          nodeType: 'composite',
          contractVersion: 1,
          title: '子流-echo',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          config: JSON.stringify(config)
        }
      ],
      edges: []
    }
  }
}

// ---------------------------------------------------------------- P1 单节点流

describe('P1 · 单节点流（最小封装单元）', () => {
  it('文本透传流：外部输入 → 公开输出端到端可达', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      echoManifest(),
      inputMap([['msg', [textValue('你好节点流')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.echo).toEqual({ kind: 'text', text: '你好节点流' })
    expect(outcome.stepCount).toBe(1)
    expect(finishCall(ledger.calls)?.status).toBe('completed')
    expect(finishCall(ledger.calls)?.outputPorts).toEqual([{ portId: 'out-echo', kind: 'text' }])
  })

  it('不带 in- 前缀的端口约定：外部按裸 ID 喂值', async () => {
    const ledger = installLedger()
    const manifest = echoManifest()
    const outcome = await runCompositeIsolated({} as never, 'e2e-project', stubProviders(), {
      manifest,
      inputs: inputMap([['msg', [textValue('裸端口 ID')]]]),
      ...RUN_REQUEST_BASE
    })
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.echo).toMatchObject({ text: '裸端口 ID' })
  })
})

// ---------------------------------------------------------------- P2 串行流

describe('P2 · 串行组合（多节点依赖链）', () => {
  it('text→json 两段链：上游输出经内部边进入下游，类型按端口变换', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      serialManifest(),
      inputMap([['payload', [textValue('{"name":"节点流","n":2}')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.parsed).toEqual({ kind: 'json', data: { name: '节点流', n: 2 } })
    expect(outcome.stepCount).toBe(2)
    const steps = ledger.calls.filter(
      (call) => call.op === 'runStep' && call.payload.status === 'completed'
    )
    expect(steps.map((call) => call.payload.stepKey)).toEqual(['n1', 'n2'])
  })

  it('空输入 → 显式 INPUT_REQUIRED，不静默跑内部图', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(serialManifest(), inputMap([]), ledger)
    ledger.restore()
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('INPUT_REQUIRED')
    expect(outcome.failure?.phase).toBe('input')
    expect(outcome.reason).toContain('缺少必需输入')
    expect(finishCall(ledger.calls)?.errorCode).toBe('INPUT_REQUIRED')
    // 输入阶段失败：不应有任何内部步骤进入 running。
    expect(ledger.calls.filter((call) => call.op === 'runStep')).toHaveLength(0)
  })

  it('内部节点失败 → NODE_FAILED 定位到具体节点，错误可沿封装边界透传', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      serialManifest(),
      inputMap([['payload', [textValue('这不是合法 JSON')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('NODE_FAILED')
    expect(outcome.failure?.nodeId).toBe('n2')
    expect(outcome.reason).toContain('JSON 输入格式无效')
    expect(finishCall(ledger.calls)?.failureNodeId).toBe('n2')
    expect(finishCall(ledger.calls)?.failurePhase).toBe('step')
  })
})

// ---------------------------------------------------------------- P3 并行流

describe('P3 · 并行组合（广播 + 分支隔离 + 扇入）', () => {
  it('一份输入广播两条分支：分支输出各自公开且互不串扰', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      parallelManifest(),
      inputMap([['msg', [textValue('并行输入')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.left).toEqual({ kind: 'text', text: '并行输入' })
    expect(outcome.outputs?.right).toEqual({ kind: 'text', text: '并行输入' })
  })

  it('两分支扇入汇聚节点：两路输出都进入合并文本', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      parallelManifest(),
      inputMap([['msg', [textValue('并行输入')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('done')
    const merged = String((outcome.outputs?.merged as { kind: string; text?: string })?.text ?? '')
    expect(merged).toContain('并行输入')
    expect(merged).toContain('$$$')
    // 广播 + 分支 + 扇入 = 3 个内部步骤全部完成
    expect(outcome.stepCount).toBe(3)
  })

  it('显式扇入顺序覆盖节点流边的声明顺序', async () => {
    const manifest = parallelManifest()
    const [first, second] = manifest.graph.edges
    first.order = 2
    second.order = 1
    manifest.graph.nodes.find((node) => node.id === first.from.nodeId)!.text = '左分支'
    manifest.graph.nodes.find((node) => node.id === second.from.nodeId)!.text = '右分支'
    const ledger = installLedger()
    try {
      const outcome = await runFlow(manifest, inputMap([['msg', [textValue('共享')]]]), ledger)
      expect(outcome.status).toBe('done')
      const output = outcome.outputs?.merged
      expect(output?.kind).toBe('text')
      if (output?.kind !== 'text') throw new Error('缺少合并输出')
      expect(output.text.indexOf('右分支')).toBeLessThan(output.text.indexOf('左分支'))
    } finally {
      ledger.restore()
    }
  })

  it('分支文本各自合并外部输入与自身正文（虚拟上游语义）', async () => {
    const manifest = parallelManifest()
    // 给分支节点写上自己的正文：汇聚结果应是「外部输入 + 自身正文」的合并。
    manifest.graph.nodes = manifest.graph.nodes.map((node) =>
      node.id === 'b1' ? { ...node, text: '左分支正文' } : node
    )
    const ledger = installLedger()
    const outcome = await runFlow(manifest, inputMap([['msg', [textValue('外部')]]]), ledger)
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect((outcome.outputs?.left as { text?: string })?.text).toContain('外部')
    expect((outcome.outputs?.left as { text?: string })?.text).toContain('左分支正文')
  })
})

// ---------------------------------------------------------------- P4 嵌套子流

describe('P4 · 子流即节点（封装后可被其他流调用）', () => {
  it('引用形态：外层流内嵌 echo-flow@1.0，输入输出端到端贯通', async () => {
    const ledger = installLedger()
    const inner = echoManifest()
    const hash = await compositeContentHash(inner)
    ledger.publish(inner, hash)
    const outcome = await runFlow(
      nestedOuterManifest({ capabilityId: 'e2e-echo', version: '1.0', contentHash: hash }),
      inputMap([['msg', [textValue('穿过两层')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.final).toEqual({ kind: 'text', text: '穿过两层' })
    // 子流解析发生过一次（外层构建期）
    expect(ledger.calls.some((call) => call.op === 'versionGet')).toBe(true)
  })

  it('内嵌形态：config 直接携带 manifest，不经发布仓库即可运行', async () => {
    const ledger = installLedger()
    const outer = nestedOuterManifest({
      capabilityId: 'unused',
      version: '1.0',
      contentHash: '0'.repeat(64)
    })
    const withInline = {
      ...outer,
      graph: {
        ...outer.graph,
        nodes: outer.graph.nodes.map((node) =>
          node.id === 'c1'
            ? { ...node, config: JSON.stringify({ manifest: echoManifest() }) }
            : node
        )
      }
    }
    const outcome = await runFlow(
      withInline,
      inputMap([['msg', [textValue('内嵌 manifest')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.final).toMatchObject({ text: '内嵌 manifest' })
  })

  it('引用无法解析 → COMPOSITE_REF_NOT_RESOLVED 显式失败', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      nestedOuterManifest({
        capabilityId: 'missing-flow',
        version: '1.0',
        contentHash: '0'.repeat(64)
      }),
      inputMap([['msg', [textValue('任意')]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('COMPOSITE_REF_NOT_RESOLVED')
    expect(outcome.reason).toContain('missing-flow@1.0')
  })

  it('三层嵌套：A→B→C 逐层贯通，输出仍按公开端口稳定投影', async () => {
    const ledger = installLedger()
    const inner = echoManifest()
    const hashInner = await compositeContentHash(inner)
    ledger.publish(inner, hashInner)
    // 中层：收 msg → 子流 echo → 公开输出端口 out-mid
    const mid: CompositeManifest = {
      ...nestedOuterManifest(
        { capabilityId: 'e2e-echo', version: '1.0', contentHash: hashInner },
        { capabilityId: 'e2e-mid', childOutputPort: 'out-echo' }
      ),
      outputs: [
        {
          id: 'mid',
          label: '中层输出',
          type: 'text',
          required: true,
          cardinality: 'one',
          source: { nodeId: 'c1', portId: 'out-echo' }
        }
      ]
    }
    const hashMid = await compositeContentHash(mid)
    ledger.publish(mid, hashMid)
    // 外层引用中层：输出端口是中层的公开端口 out-mid
    const outer = nestedOuterManifest(
      { capabilityId: 'e2e-mid', version: '1.0', contentHash: hashMid },
      { capabilityId: 'e2e-top', childOutputPort: 'out-mid' }
    )
    const outcome = await runFlow(outer, inputMap([['msg', [textValue('三层穿透')]]]), ledger)
    ledger.restore()
    expect(outcome.status).toBe('done')
    expect(outcome.outputs?.final).toEqual({ kind: 'text', text: '三层穿透' })
  })

  it('两个子流互相引用成环 → 运行期 RECURSIVE_COMPOSITE 守卫拒绝', async () => {
    const ledger = installLedger()
    // A、B 均以发布引用形态互相引用（ref 不带 contentHash，规避哈希循环定义）；
    // 环在运行期由预算守卫发现并拒绝，而不是无限递归。
    const flowA = nestedOuterManifest(
      { capabilityId: 'e2e-cycle-b', version: '1.0' },
      { capabilityId: 'e2e-cycle-a' }
    )
    const flowB = nestedOuterManifest(
      { capabilityId: 'e2e-cycle-a', version: '1.0' },
      { capabilityId: 'e2e-cycle-b' }
    )
    ledger.publish(flowA, await compositeContentHash(flowA))
    ledger.publish(flowB, await compositeContentHash(flowB))
    const outcome = await runFlow(flowA, inputMap([['msg', [textValue('成环')]]]), ledger)
    ledger.restore()
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('递归')
  })
})

// ---------------------------------------------------------------- P5 稳定性

describe('P5 · 输入输出稳定性（封装单元的函数语义）', () => {
  it('同一流 + 相同输入重复运行三次：输出逐字节一致', async () => {
    const manifest = serialManifest()
    const inputs = inputMap([['payload', [textValue('{"stable":true,"round":1}')]]])
    const snapshots: string[] = []
    for (let index = 0; index < 3; index++) {
      const ledger = installLedger()
      const outcome = await runFlow(manifest, inputs, ledger)
      ledger.restore()
      expect(outcome.status).toBe('done')
      snapshots.push(JSON.stringify(outcome.outputs))
    }
    expect(new Set(snapshots).size).toBe(1)
    expect(JSON.parse(snapshots[0]!)).toEqual({
      parsed: { kind: 'json', data: { stable: true, round: 1 } }
    })
  })

  it('不同输入 → 不同输出（无上一轮结果残留）', async () => {
    const manifest = serialManifest()
    const ledgerA = installLedger()
    const a = await runFlow(manifest, inputMap([['payload', [textValue('{"round":1}')]]]), ledgerA)
    ledgerA.restore()
    const ledgerB = installLedger()
    const b = await runFlow(manifest, inputMap([['payload', [textValue('{"round":2}')]]]), ledgerB)
    ledgerB.restore()
    expect(a.outputs?.parsed).toEqual({ kind: 'json', data: { round: 1 } })
    expect(b.outputs?.parsed).toEqual({ kind: 'json', data: { round: 2 } })
  })

  it('并行流重复运行同样稳定（广播 + 扇入全链确定性）', async () => {
    const manifest = parallelManifest()
    const inputs = inputMap([['msg', [textValue('稳定输入')]]])
    const snapshots: string[] = []
    for (let index = 0; index < 3; index++) {
      const ledger = installLedger()
      const outcome = await runFlow(manifest, inputs, ledger)
      ledger.restore()
      expect(outcome.status).toBe('done')
      snapshots.push(JSON.stringify(outcome.outputs))
    }
    expect(new Set(snapshots).size).toBe(1)
  })

  it('输入类型不符 → INPUT_TYPE_UNSUPPORTED（规范边界先于执行拒绝）', async () => {
    const ledger = installLedger()
    const outcome = await runFlow(
      serialManifest(),
      inputMap([['payload', [jsonValue({ a: 1 })]]]),
      ledger
    )
    ledger.restore()
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('INPUT_TYPE_UNSUPPORTED')
    expect(outcome.failure?.phase).toBe('input')
  })
})
