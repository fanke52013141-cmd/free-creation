// @vitest-environment jsdom
// 节点流测试矩阵 · F 模型组合链 + H 特殊宿主停等/状态机 + J 持久化语义（2026-11-17）。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNodeManually, runWorkflow } from '@renderer/engine/executor'
import { currentTextResult } from '@shared/engine/deterministic-projections'
import { registerAllNodeTypes } from './helpers/registerNodes'
import {
  approveAllConfirms,
  bindSaveCoordinator,
  buildFlowEditor,
  fullModelCatalogApi,
  installWindowApi,
  localCapabilitiesOk,
  makeChatGatewayApi,
  mediaEnvelopeOk,
  resetEnginePhase,
  runStateOf,
  stubProviders
} from './helpers/flowHarness'

beforeAll(() => {
  registerAllNodeTypes()
  bindSaveCoordinator()
})
beforeEach(() => {
  resetEnginePhase()
  return approveAllConfirms()
})

describe('F · 模型节点组合链（桩网关）', () => {
  it('F1 text→ai-process→text：文案加工全链贯通', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ reply: '润色：品牌焕新文案' }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '原始文案' },
          { id: 'ai', nodeType: 'ai-process' },
          { id: 'out', nodeType: 'text', text: '' }
        ],
        [
          { from: 'src', to: 'ai', fromPort: 'out-text', toPort: 'in-text' },
          { from: 'ai', to: 'out', fromPort: 'out-text', toPort: 'in-text' }
        ]
      )
      await runWorkflow(editor, 'p-f1', stubProviders())
      expect(runStateOf(node('ai')).run).toBe('success')
      expect(runStateOf(node('out')).run).toBe('success')
      // 文本节点不再把上游结果写回正文：结果从运行记录按 runId 投影（卡片只读结果区同源）。
      expect(String(node('out')!.props.text)).toBe('')
      expect(currentTextResult(node('out')!)).toContain('品牌焕新')
    } finally {
      restore()
    }
  })

  it('F2 image-gen→image-edit：生成→修图链贯通', async () => {
    const restore = installWindowApi({
      gateway: {
        ...makeChatGatewayApi().gateway,
        imageGenerate: async () => mediaEnvelopeOk('gen-1', 'D:/t/gen-1.png', 'image/png'),
        imageEdit: async () => mediaEnvelopeOk('edit-1', 'D:/t/edit-1.png', 'image/png')
      },
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'gen', nodeType: 'image-gen', text: '一只赛博朋克的猫' },
          {
            id: 'edit',
            nodeType: 'image-edit',
            config: { instruction: '把背景换成夜晚霓虹' }
          }
        ],
        [{ from: 'gen', to: 'edit', fromPort: 'out-image', toPort: 'in-image' }]
      )
      await runWorkflow(editor, 'p-f2', stubProviders())
      expect(runStateOf(node('gen')).run).toBe('success')
      const edit = runStateOf(node('edit'))
      expect(edit.run).toBe('success')
      expect(JSON.stringify(edit.result)).toContain('edit-1')
    } finally {
      restore()
    }
  })

  it('F3 video→video-frame：生成视频后抽帧', async () => {
    const restore = installWindowApi({
      gateway: {
        videoSubmit: async () => ({ ok: true, data: { taskId: 'vid-1' } }),
        videoCancel: async () => ({ ok: true }),
        videoTask: async () => ({
          ok: true,
          data: { status: 'success', mediaId: 'vid-out', mediaPath: 'D:/t/vid-out.mp4' }
        })
      },
      getLocalMediaCapabilities: async () => localCapabilitiesOk(),
      extractVideoFrame: async () => mediaEnvelopeOk('frame-1', 'D:/t/frame-1.png', 'image/png'),
      deleteMedia: async () => undefined,
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'gen', nodeType: 'video', text: '两秒城市延时' },
          {
            id: 'frame',
            nodeType: 'video-frame',
            config: { version: 2, mode: 'time', timeMs: 500, format: 'png' }
          }
        ],
        [{ from: 'gen', to: 'frame', fromPort: 'out-video', toPort: 'in-video' }]
      )
      await runWorkflow(editor, 'p-f3', stubProviders())
      expect(runStateOf(node('gen')).run).toBe('success')
      const frame = runStateOf(node('frame'))
      expect(frame.run).toBe('success')
      expect(JSON.stringify(frame.result)).toContain('frame-1')
    } finally {
      restore()
    }
  }, 20000)

  it('F4 voice-design→speech：音色档案注入配音', async () => {
    const speechCalls: Array<{ voiceId?: string }> = []
    const restore = installWindowApi({
      gateway: {
        ...makeChatGatewayApi().gateway,
        voiceDesign: async () => ({
          ok: true,
          data: {
            asset: { id: 'vd-1', path: 'D:/t/vd.mp3', mime: 'audio/mpeg' },
            voiceId: 'designed-voice-7'
          }
        }),
        speechGenerate: async (input: { voiceId?: string }) => {
          speechCalls.push({ voiceId: input.voiceId })
          return {
            ok: true,
            data: { asset: { id: 'speech-1', path: 'D:/t/speech-1.mp3', mime: 'audio/mpeg' } }
          }
        }
      },
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'vd', nodeType: 'voice-design', text: '温柔女声，语速适中' },
          { id: 'say', nodeType: 'speech', text: '欢迎使用画布工作室' }
        ],
        [{ from: 'vd', to: 'say', fromPort: 'out-json', toPort: 'in-voice' }]
      )
      await runWorkflow(editor, 'p-f4', stubProviders())
      expect(runStateOf(node('vd')).run).toBe('success')
      expect(runStateOf(node('say')).run).toBe('success')
      expect(speechCalls[0]?.voiceId).toBe('designed-voice-7')
    } finally {
      restore()
    }
  })

  it('F5 ai-process json 模式：桩回复 JSON 通过校验', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ reply: '{"title":"夜巷","shots":3}' }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '生成分镜标题' },
          { id: 'ai', nodeType: 'ai-process', config: { mode: 'json' } }
        ],
        [{ from: 'src', to: 'ai', fromPort: 'out-text', toPort: 'in-text' }]
      )
      await runWorkflow(editor, 'p-f5', stubProviders())
      const state = runStateOf(node('ai'))
      expect(state.run).toBe('success')
      expect(JSON.stringify(state.result)).toContain('夜巷')
    } finally {
      restore()
    }
  })

  it('F6 网关错误结构化透传：不挂死、不吞错', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ failStart: '供应商配额不足（429）' }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '内容' },
          { id: 'ai', nodeType: 'ai-process' }
        ],
        [{ from: 'src', to: 'ai', fromPort: 'out-text', toPort: 'in-text' }]
      )
      await runWorkflow(editor, 'p-f6', stubProviders())
      const state = runStateOf(node('ai'))
      expect(state.run).toBe('failed')
      expect(state.reason ?? '').toContain('配额不足')
    } finally {
      restore()
    }
  })

  it('F7 推理模型正文为空时失败，思考内容不进入节点结果', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ reply: '完整答案在思考通道', reasoningOnly: true }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '问题' },
          { id: 'ai', nodeType: 'ai-process' }
        ],
        [{ from: 'src', to: 'ai', fromPort: 'out-text', toPort: 'in-text' }]
      )
      await runWorkflow(editor, 'p-f7', stubProviders())
      const state = runStateOf(node('ai'))
      expect(state.run).toBe('failed')
      expect(state.result).toBeUndefined()
    } finally {
      restore()
    }
  })
})

describe('H · 特殊宿主停等与状态机', () => {
  it('H1 human-task 停等→人工提交→续跑完成', async () => {
    const task = buildFlowEditor([
      { id: 'n1', nodeType: 'human-task', config: { schemaVersion: 1, outputType: 'text' } }
    ])
    await runWorkflow(task.editor, 'p-h1a', [])
    const waiting = runStateOf(task.node('n1'))
    expect(waiting.run).toBe('skipped')
    // 人工提交（UI 只写 pending，执行器是唯一推进权威）。
    task.node('n1')!.meta.humanTaskPending = JSON.stringify({
      submissionId: 'submit-1',
      expectedRevision: 1,
      value: { kind: 'text', text: '人工交付的定稿文案' }
    })

    resetEnginePhase()
    const result = await runNodeManually(task.editor, 'p-h1b', [], 'n1')
    expect(result.status).toBe('done')
    expect(String(task.node('n1')!.meta.nodeResult)).toContain('人工交付的定稿文案')
  })

  it('H2 state-machine 事件推进：draft→published，flow.state 输出', async () => {
    const config = {
      schemaVersion: 1,
      initialState: 'draft',
      states: ['draft', 'published'],
      transitions: [{ from: 'draft', event: 'publish', to: 'published' }],
      relations: []
    }
    const machine = buildFlowEditor([{ id: 'n1', nodeType: 'state-machine', config }])
    await runWorkflow(machine.editor, 'p-h2a', [])
    expect(runStateOf(machine.node('n1')).run).toBe('success')

    machine.node('n1')!.meta.stateMachinePending = JSON.stringify({
      eventId: 'evt-1',
      event: 'publish',
      expectedRevision: 1
    })
    resetEnginePhase()
    await runWorkflow(machine.editor, 'p-h2b', [])
    const done = runStateOf(machine.node('n1'))
    expect(done.run).toBe('success')
    const instance = JSON.parse(String(machine.node('n1')!.meta.stateMachine))
    expect(instance.state).toBe('published')
    expect(instance.revision).toBe(2)
  })

  it('H2b state-machine 重复提交同一事件被拒（lastEventId 去重）', async () => {
    const config = {
      schemaVersion: 1,
      initialState: 'draft',
      states: ['draft', 'published'],
      transitions: [{ from: 'draft', event: 'publish', to: 'published' }],
      relations: []
    }
    const machine = buildFlowEditor([{ id: 'n1', nodeType: 'state-machine', config }])
    machine.node('n1')!.meta.stateMachinePending = JSON.stringify({
      eventId: 'evt-dup',
      event: 'publish',
      expectedRevision: 1
    })
    await runWorkflow(machine.editor, 'p-h2b1', [])
    expect(JSON.parse(String(machine.node('n1')!.meta.stateMachine)).state).toBe('published')

    resetEnginePhase()
    // 已应用过的提交：按契约应显式失败，不重复迁移。
    machine.node('n1')!.meta.stateMachinePending = JSON.stringify({
      eventId: 'evt-dup',
      event: 'publish',
      expectedRevision: 2
    })
    await runWorkflow(machine.editor, 'p-h2b2', [])
    const state = runStateOf(machine.node('n1'))
    expect(['failed', 'skipped']).toContain(state.run)
    expect(JSON.parse(String(machine.node('n1')!.meta.stateMachine)).revision).toBe(2)
  })
})

describe('J · 持久化与结果新鲜度', () => {
  it('J1 运行终态字段完整落在 shape meta（保存/重载的载体）', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ reply: '已持久化的模型产出' }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '持久化内容' },
          { id: 'sink', nodeType: 'ai-process' }
        ],
        [{ from: 'src', to: 'sink', fromPort: 'out-text', toPort: 'in-text' }]
      )
      await runWorkflow(editor, 'p-j1', stubProviders())
      const sink = node('sink')!
      const run = sink.meta.nodeRun as Record<string, unknown>
      expect(run.status).toBe('success')
      expect(run.finishedAt).toBeGreaterThan(0)
      expect(run.durationMs).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(sink.meta.nodeRunHistory)).toBe(true)
      expect(typeof sink.meta.nodeResult).toBe('string')
    } finally {
      restore()
    }
  })

  it('J2 重跑追加历史而非覆盖：nodeRunHistory 保留全部运行', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'text', text: '第一版' }])
    await runWorkflow(editor, 'p-j2', [])
    node('n1')!.props.text = '第二版'
    resetEnginePhase()
    await runWorkflow(editor, 'p-j2', [])
    const history = node('n1')!.meta.nodeRunHistory as Array<unknown>
    expect(history.length).toBe(2)
  })

  it('J3 iterate 结果带循环体指纹（resume 校验基准）', async () => {
    const { editor, node } = buildFlowEditor(
      [
        {
          id: 'list',
          nodeType: 'structured',
          text: '[{"id":"1","scene":"镜头"}]',
          config: { schema: { id: 'list.items', version: 1 } }
        },
        { id: 'loop', nodeType: 'iterate', config: { concurrency: 1 } },
        {
          id: 'body',
          nodeType: 'structured',
          text: '{"prompt":"{{input[0].scene}}"}',
          config: { schema: { id: 'prompt.bundle', version: 1 } }
        }
      ],
      [
        { from: 'list', to: 'loop', fromPort: 'out-json', toPort: 'in-list' },
        { from: 'loop', to: 'body', fromPort: 'out-item', toPort: 'in-context' }
      ]
    )
    await runWorkflow(editor, 'p-j3', [])
    const result = runStateOf(node('loop')).result as { bodyFingerprint?: string } | undefined
    expect(typeof result?.bodyFingerprint).toBe('string')
  })
})
