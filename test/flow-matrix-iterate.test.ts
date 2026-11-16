// @vitest-environment jsdom
// 节点流测试矩阵 · D 循环 iterate（2026-11-17 全面测试 · 重点族）。
// 全部走真实引擎 runWorkflow/runWorkflowForNodes；循环体用 structured(prompt.bundle) 模板，
// 失败注入靠「模板占位符引用缺失字段」（R-15 显式失败），并发/失败策略/续跑走 iterate 真实配置。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWorkflow, runWorkflowForNodes } from '@renderer/engine/executor'
import { registerAllNodeTypes } from './helpers/registerNodes'
import {
  approveAllConfirms,
  bindSaveCoordinator,
  buildFlowEditor,
  installWindowApi,
  localCapabilitiesOk,
  mediaEnvelopeOk,
  resetEnginePhase,
  runStateOf,
  stubProviders
} from './helpers/flowHarness'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

beforeAll(() => {
  registerAllNodeTypes()
  bindSaveCoordinator()
})
beforeEach(() => {
  resetEnginePhase()
  return approveAllConfirms()
})

const LIST_SCHEMA = { schema: { id: 'list.items', version: 1 } }
const PROMPT_SCHEMA = { schema: { id: 'prompt.bundle', version: 1 } }

function shotsList(items: Array<Record<string, unknown>>): string {
  return JSON.stringify(items.map((item, index) => ({ id: `shot-${index + 1}`, ...item })))
}

interface IterateOutcome {
  iterate: ReturnType<typeof runStateOf>
  body?: ReturnType<typeof runStateOf>
  items?: Array<{
    status?: string
    outputs?: Record<string, Record<string, { value?: { data?: { prompt?: string } } }>>
  }>
}

/** 读取 iterate nodeResult 里的分项结果。 */
function iterateItems(shape: NodeCardShape | undefined): IterateOutcome['items'] {
  const state = runStateOf(shape)
  const result = state.result as { items?: IterateOutcome['items'] } | undefined
  return result?.items
}

function runHistoryLength(shape: NodeCardShape | undefined): number {
  const history = shape?.meta.nodeRunHistory as Array<unknown> | undefined
  return history?.length ?? 0
}

/** 标准三镜列表 → 循环 → prompt 模板体。sceneMissing 的镜会触发 R-15 失败。 */
function buildIterateFlow(options: {
  items: Array<Record<string, unknown>>
  iterateConfig?: Record<string, unknown>
  withSink?: boolean
}) {
  return buildFlowEditor(
    [
      { id: 'list', nodeType: 'structured', text: shotsList(options.items), config: LIST_SCHEMA },
      {
        id: 'loop',
        nodeType: 'iterate',
        config: { onFailure: 'skip', runMode: 'all', concurrency: 1, ...options.iterateConfig }
      },
      {
        id: 'body',
        nodeType: 'structured',
        text: '{"prompt":"{{input[0].scene}}","style":"电影感"}',
        config: PROMPT_SCHEMA
      },
      ...(options.withSink ? [{ id: 'sink', nodeType: 'json', text: '' }] : [])
    ],
    [
      { from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' },
      { from: 'loop', to: 'body', fromPort: 'out-item', toPort: 'in-context' },
      ...(options.withSink
        ? [{ from: 'loop', to: 'sink', fromPort: 'out-items', toPort: 'in-json' }]
        : [])
    ]
  )
}

describe('D · 循环 iterate 流', () => {
  it('D1 三项循环体逐项执行并汇总（并发 1）', async () => {
    const { editor, node } = buildIterateFlow({
      items: [{ scene: '霓虹雨巷' }, { scene: '潮湿巷口' }, { scene: '天台对峙' }]
    })
    await runWorkflow(editor, 'p-d1', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('success')
    const items = iterateItems(node('loop')) ?? []
    expect(items).toHaveLength(3)
    const prompts = items.map((item) => item.outputs?.['body']?.['out-json']?.data?.prompt)
    expect(prompts).toEqual(['霓虹雨巷', '潮湿巷口', '天台对峙'])
  })

  it('D2 循环体多节点链（模板→透传）完整执行', async () => {
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'list',
          nodeType: 'structured',
          text: shotsList([{ scene: '镜头A' }, { scene: '镜头B' }]),
          config: LIST_SCHEMA
        },
        { id: 'loop', nodeType: 'iterate', config: { concurrency: 1 } },
        {
          id: 'tpl',
          nodeType: 'structured',
          text: '{"prompt":"{{input[0].scene}}"}',
          config: PROMPT_SCHEMA
        },
        { id: 'pass', nodeType: 'processor', config: { operation: 'pass', fallback: '' } }
      ],
      [
        { from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' },
        { from: 'loop', to: 'tpl', fromPort: 'out-item', toPort: 'in-context' },
        { from: 'tpl', to: 'pass', fromPort: 'out-json', toPort: 'in-value' }
      ]
    )
    await runWorkflow(editor, 'p-d2', [])
    expect(runStateOf(node('loop')).run).toBe('success')
    const items = iterateItems(node('loop')) ?? []
    expect(items).toHaveLength(2)
    for (const item of items) {
      const value = item.outputs?.['pass']?.['out-value'] as
        { data?: { prompt?: string } } | undefined
      expect(value?.data?.prompt).toMatch(/镜头[AB]/)
    }
  })

  it('D3 对称扇出：每项两路分支都执行且互不串号', async () => {
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'list',
          nodeType: 'structured',
          text: shotsList([{ scene: '左路右路同项' }]),
          config: LIST_SCHEMA
        },
        { id: 'loop', nodeType: 'iterate', config: { concurrency: 1 } },
        {
          id: 'left',
          nodeType: 'structured',
          text: '{"prompt":"L-{{input[0].scene}}"}',
          config: PROMPT_SCHEMA
        },
        {
          id: 'right',
          nodeType: 'structured',
          text: '{"prompt":"R-{{input[0].scene}}"}',
          config: PROMPT_SCHEMA
        }
      ],
      [
        { from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' },
        { from: 'loop', to: 'left', fromPort: 'out-item', toPort: 'in-context' },
        { from: 'loop', to: 'right', fromPort: 'out-item', toPort: 'in-context' }
      ]
    )
    await runWorkflow(editor, 'p-d3', [])
    expect(runStateOf(node('loop')).run).toBe('success')
    const items = iterateItems(node('loop')) ?? []
    expect(items).toHaveLength(1)
    const outputs = items[0]?.outputs ?? {}
    expect((outputs['left']?.['out-json'] as { data?: { prompt?: string } })?.data?.prompt).toBe(
      'L-左路右路同项'
    )
    expect((outputs['right']?.['out-json'] as { data?: { prompt?: string } })?.data?.prompt).toBe(
      'R-左路右路同项'
    )
  })

  it('D4 并发 2：五项全部完成且输出按项隔离（影子编辑器）', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ scene: `第${i + 1}镜` }))
    const { editor, node } = buildIterateFlow({
      items,
      iterateConfig: { concurrency: 2 }
    })
    await runWorkflow(editor, 'p-d4', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('success')
    const results = iterateItems(node('loop')) ?? []
    expect(results).toHaveLength(5)
    const prompts = results.map((item) => item.outputs?.['body']?.['out-json']?.data?.prompt)
    expect(prompts).toEqual(['第1镜', '第2镜', '第3镜', '第4镜', '第5镜'])
  })

  it('D5 onFailure=skip：中间项失败不拖死其余项，整体仍成功', async () => {
    const { editor, node } = buildIterateFlow({
      items: [{ scene: '第一镜' }, {}, { scene: '第三镜' }],
      iterateConfig: { onFailure: 'skip' }
    })
    await runWorkflow(editor, 'p-d5', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('success')
    const items = iterateItems(node('loop')) ?? []
    expect(items).toHaveLength(3)
    expect(items[1]?.status).toMatch(/failed|error/)
    expect(items[0]?.outputs?.['body']).toBeTruthy()
    expect(items[2]?.outputs?.['body']).toBeTruthy()
  })

  it('D6 onFailure=fail：首败即停，后续项不再执行', async () => {
    const { editor, node } = buildIterateFlow({
      items: [{}, { scene: '第二镜' }, { scene: '第三镜' }],
      iterateConfig: { onFailure: 'fail' }
    })
    await runWorkflow(editor, 'p-d6', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('failed')
    expect(runHistoryLength(node('body'))).toBe(1)
  })

  it('D7 resume：续跑只补失败项，不重跑已完成项', async () => {
    const first = buildIterateFlow({
      items: [{ scene: '第一镜' }, {}, { scene: '第三镜' }],
      iterateConfig: { onFailure: 'skip', runMode: 'all' }
    })
    await runWorkflow(first.editor, 'p-d7a', [])
    expect(runStateOf(first.node('loop')).run).toBe('success')
    const bodyRunsAfterFirst = runHistoryLength(first.node('body'))
    expect(bodyRunsAfterFirst).toBe(3)

    resetEnginePhase()
    first.node('loop')!.props.config = JSON.stringify({
      onFailure: 'skip',
      runMode: 'resume',
      concurrency: 1
    })
    await runWorkflow(first.editor, 'p-d7b', [])
    const bodyRunsAfterResume = runHistoryLength(first.node('body'))
    // 只重跑失败的第 2 项：历史 +1（resume 去重按 runId，同项同 runId 只留一条）。
    expect(bodyRunsAfterResume).toBeGreaterThanOrEqual(bodyRunsAfterFirst)
    expect(bodyRunsAfterResume - bodyRunsAfterFirst).toBeLessThanOrEqual(1)
    const items = iterateItems(first.node('loop')) ?? []
    expect(items).toHaveLength(3)
  })

  it('D8 空列表 → 0 项成功完成（非数组输入才 skipped/契约失败）', async () => {
    const { editor, node } = buildIterateFlow({ items: [] })
    await runWorkflow(editor, 'p-d8', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('success')
    expect(iterateItems(node('loop')) ?? []).toHaveLength(0)
  })

  it('D9 未配置循环体（out-item 无下游）→ skipped「未配置循环体」', async () => {
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'list',
          nodeType: 'structured',
          text: shotsList([{ scene: '唯一镜' }]),
          config: LIST_SCHEMA
        },
        { id: 'loop', nodeType: 'iterate' }
      ],
      [{ from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' }]
    )
    await runWorkflow(editor, 'p-d9', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('skipped')
    expect(loop.reason ?? '').toContain('循环体')
  })

  it('D10 out-items 消费者只执行一次并拿到完整列表', async () => {
    const { editor, node } = buildIterateFlow({
      items: [{ scene: '甲' }, { scene: '乙' }, { scene: '丙' }],
      withSink: true
    })
    await runWorkflow(editor, 'p-d10', [])
    expect(runStateOf(node('loop')).run).toBe('success')
    const sink = runStateOf(node('sink'))
    expect(sink.run).toBe('success')
    expect(runHistoryLength(node('sink'))).toBe(1)
    const sinkText = String(node('sink')!.props.text)
    expect(sinkText).toContain('甲')
    expect(sinkText).toContain('丙')
  })

  it('D11 循环体内含 skipped 分支节点不算失败，该项仍完成', async () => {
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'list',
          nodeType: 'structured',
          text: shotsList([{ scene: '带可选项' }]),
          config: LIST_SCHEMA
        },
        { id: 'loop', nodeType: 'iterate', config: { concurrency: 1 } },
        {
          id: 'tpl',
          nodeType: 'structured',
          text: '{"prompt":"{{input[0].scene}}"}',
          config: PROMPT_SCHEMA
        },
        // 空模板 structured 连入循环体：诚实 skipped（请先输入结构化 JSON），不拖死该项。
        { id: 'optional', nodeType: 'structured', text: '', config: PROMPT_SCHEMA }
      ],
      [
        { from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' },
        { from: 'loop', to: 'tpl', fromPort: 'out-item', toPort: 'in-context' },
        { from: 'loop', to: 'optional', fromPort: 'out-item', toPort: 'in-context' }
      ]
    )
    await runWorkflow(editor, 'p-d11', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('success')
    const items = iterateItems(node('loop')) ?? []
    expect(items).toHaveLength(1)
    expect(items[0]?.outputs?.['tpl']).toBeTruthy()
  })

  it('D12 二十项批量 + 并发 2：全部完成', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ scene: `批第${i + 1}条` }))
    const { editor, node } = buildIterateFlow({
      items,
      iterateConfig: { concurrency: 2 }
    })
    await runWorkflow(editor, 'p-d12', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('success')
    const results = iterateItems(node('loop')) ?? []
    expect(results).toHaveLength(20)
    const prompts = results.map((item) => item.outputs?.['body']?.['out-json']?.data?.prompt)
    expect(prompts.filter(Boolean)).toHaveLength(20)
  }, 30000)

  it('D13 typed 列表项注入图片端口：循环驱动 image-crop', async () => {
    const restore = installWindowApi({
      getLocalMediaCapabilities: async () => localCapabilitiesOk(),
      cropImage: async () => mediaEnvelopeOk('crop-loop-1', 'D:/t/crop-loop-1.png', 'image/png'),
      deleteMedia: async () => undefined
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          {
            id: 'list',
            nodeType: 'structured',
            text: JSON.stringify([
              {
                id: 'img-1',
                kind: 'image',
                mediaId: 'm-img-1',
                mediaPath: 'D:/t/img-1.png',
                mime: 'image/png'
              }
            ]),
            config: LIST_SCHEMA
          },
          { id: 'loop', nodeType: 'iterate', config: { concurrency: 1 } },
          {
            id: 'crop',
            nodeType: 'image-crop',
            config: { mode: 'rect', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }
          }
        ],
        [
          { from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' },
          { from: 'loop', to: 'crop', fromPort: 'out-item', toPort: 'in-image' }
        ]
      )
      await runWorkflow(editor, 'p-d13', [])
      const loop = runStateOf(node('loop'))
      expect(loop.run).toBe('success')
      const items = iterateItems(node('loop')) ?? []
      expect(items).toHaveLength(1)
      expect(JSON.stringify(items[0]?.outputs?.['crop'] ?? {})).toContain('crop-loop-1')
    } finally {
      restore()
    }
  })

  it('D14 框选循环范围运行（runWorkflowForNodes）：循环体入域不重复执行', async () => {
    const { editor, node } = buildIterateFlow({
      items: [{ scene: '框选镜' }, { scene: '框选镜B' }]
    })
    const outcome = await runWorkflowForNodes(editor, 'p-d14', [], ['loop'])
    expect(outcome).toBe('completed')
    expect(runStateOf(node('loop')).run).toBe('success')
    // 循环体模板卡在画布上不作为主图节点重复执行：其 nodeRunHistory 只含分项运行。
    const bodyHistory = node('body')!.meta.nodeRunHistory as Array<{ runId?: string }> | undefined
    for (const record of bodyHistory ?? []) {
      expect(String(record.runId)).toContain(':item:')
    }
  })

  it('D15 失败策略 fail 下 out-items 汇总缺口（部分完成不伪造成成功）', async () => {
    const { editor, node } = buildIterateFlow({
      items: [{ scene: '成功镜' }, {}],
      iterateConfig: { onFailure: 'fail' }
    })
    await runWorkflow(editor, 'p-d15', [])
    const loop = runStateOf(node('loop'))
    expect(loop.run).toBe('failed')
    const items = iterateItems(node('loop')) ?? []
    const statuses = items.map((item) => item?.status)
    // 第 1 项已完成、第 2 项失败：终态 failed，不把部分结果包装成成功。
    expect(statuses[0]).not.toMatch(/failed|error/)
    expect(String(statuses[1])).toMatch(/failed|error|undefined/)
  })
})
