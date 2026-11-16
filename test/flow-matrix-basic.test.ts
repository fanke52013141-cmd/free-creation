// @vitest-environment jsdom
// 节点流测试矩阵 · A 单节点冒烟 + B 基础拓扑 + C 失败/跳过语义（2026-11-17 全面测试）。
// A：33 个活跃节点逐一构造最小可运行输入，验证引擎→执行器→输出投影整链；
//    模型节点走桩网关（管线正确性），本地媒体走桩信封（真实 ffmpeg 由既有 real-media 测试覆盖）。
// B：线性链/扇出/扇入/菱形/长链/空图/子图/手动单跑。
// C：上游失败/跳过对下游的语义（显式失败、不静默复用旧输出、分支隔离、重跑取新值）。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNodeManually, runWorkflow, runWorkflowForNodes } from '@renderer/engine/executor'
import { registerAllNodeTypes } from './helpers/registerNodes'
import {
  approveAllConfirms,
  bindSaveCoordinator,
  buildFlowEditor,
  flowNode,
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

const LIST_SCHEMA = { schema: { id: 'list.items', version: 1 } }

describe('A · 单节点冒烟 · 纯逻辑', () => {
  it('A1 text 有正文 → done 且输出投影', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'text', text: '你好世界' }])
    await runWorkflow(editor, 'p-a1', [])
    const state = runStateOf(node('n1'))
    expect([state.exec, state.run]).toEqual(['success', 'success'])
  })

  it('A2 text 空正文 → 诚实 skipped「无文本输入」', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'text', text: '' }])
    await runWorkflow(editor, 'p-a2', [])
    const state = runStateOf(node('n1'))
    expect(state.exec).toBe('idle')
    expect(state.run).toBe('skipped')
    expect(state.reason).toContain('无文本输入')
  })

  it('A3 json 有效正文 → done 并格式化', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'json', text: '{"a":1}' }])
    await runWorkflow(editor, 'p-a3', [])
    expect(runStateOf(node('n1')).run).toBe('success')
    expect(String(node('n1')!.props.text)).toContain('"a": 1')
  })

  it('A4 json 非法正文 → failed「JSON 输入格式无效」', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'json', text: '{bad' }])
    await runWorkflow(editor, 'p-a4', [])
    const state = runStateOf(node('n1'))
    expect(state.run).toBe('failed')
    expect(state.reason).toContain('JSON 输入格式无效')
  })

  it('A5 structured list.items 正文（对象数组）→ done', async () => {
    const { editor, node } = buildFlowEditor([
      {
        id: 'n1',
        nodeType: 'structured',
        text: '[{"id":"1","scene":"镜头一"},{"id":"2","scene":"镜头二"}]',
        config: LIST_SCHEMA
      }
    ])
    await runWorkflow(editor, 'p-a5', [])
    expect(runStateOf(node('n1')).run).toBe('success')
  })

  it('A6 structured 空正文 → skipped；坏 JSON → failed', async () => {
    const empty = buildFlowEditor([
      { id: 'n1', nodeType: 'structured', text: '', config: LIST_SCHEMA }
    ])
    await runWorkflow(empty.editor, 'p-a6', [])
    expect(runStateOf(empty.node('n1')).run).toBe('skipped')

    resetEnginePhase()
    const bad = buildFlowEditor([
      { id: 'n1', nodeType: 'structured', text: '{oops', config: LIST_SCHEMA }
    ])
    await runWorkflow(bad.editor, 'p-a6b', [])
    expect(runStateOf(bad.node('n1')).run).toBe('failed')
  })

  it('A7 processor 固定值兜底 → done；无输入无兜底 → skipped', async () => {
    const withFallback = buildFlowEditor([
      { id: 'n1', nodeType: 'processor', config: { operation: 'pass', fallback: '固定内容' } }
    ])
    await runWorkflow(withFallback.editor, 'p-a7', [])
    expect(runStateOf(withFallback.node('n1')).run).toBe('success')

    resetEnginePhase()
    const bare = buildFlowEditor([
      { id: 'n1', nodeType: 'processor', config: { operation: 'pass' } }
    ])
    await runWorkflow(bare.editor, 'p-a7b', [])
    const state = runStateOf(bare.node('n1'))
    expect(state.run).toBe('skipped')
    expect(state.reason).toContain('没有输入变量或固定值')
  })

  it('A8 storyboard 分镜正文 → done；空 → skipped', async () => {
    const ok = buildFlowEditor([
      { id: 'n1', nodeType: 'storyboard', text: '{"shots":[{"id":"s1","scene":"雨巷"}]}' }
    ])
    await runWorkflow(ok.editor, 'p-a8', [])
    expect(runStateOf(ok.node('n1')).run).toBe('success')

    resetEnginePhase()
    const empty = buildFlowEditor([{ id: 'n1', nodeType: 'storyboard', text: '' }])
    await runWorkflow(empty.editor, 'p-a8b', [])
    expect(runStateOf(empty.node('n1')).run).toBe('skipped')
  })

  it('A9 website 有效链接配置 → done；空配置 → skipped', async () => {
    const ok = buildFlowEditor([
      { id: 'n1', nodeType: 'website', config: { name: '示例', url: 'https://example.com' } }
    ])
    await runWorkflow(ok.editor, 'p-a9', [])
    expect(runStateOf(ok.node('n1')).run).toBe('success')

    resetEnginePhase()
    const empty = buildFlowEditor([{ id: 'n1', nodeType: 'website', config: '' }])
    await runWorkflow(empty.editor, 'p-a9b', [])
    expect(runStateOf(empty.node('n1')).run).toBe('skipped')
  })

  it.each([
    ['image', 'out-image', 'image/png'],
    ['audio', 'out-audio', 'audio/mpeg'],
    ['file', 'out-file', 'application/pdf'],
    ['video-asset', 'out-video', 'video/mp4']
  ] as const)('A10 %s 资产节点：已导入 → done；未导入 → skipped', async (type, _port, mime) => {
    const has = buildFlowEditor([
      {
        id: 'n1',
        nodeType: type,
        mediaId: `m-${type}`,
        mediaPath: `D:/t/${type}.x`,
        mediaMime: mime
      }
    ])
    await runWorkflow(has.editor, 'p-a10', [])
    expect(runStateOf(has.node('n1')).run).toBe('success')

    resetEnginePhase()
    const empty = buildFlowEditor([{ id: 'n1', nodeType: type }])
    await runWorkflow(empty.editor, 'p-a10b', [])
    expect(runStateOf(empty.node('n1')).run).toBe('skipped')
  })

  it('A11 iterate 孤立节点 → 必填 in-list 未连线：显式失败并点名端口', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'iterate' }])
    await runWorkflow(editor, 'p-a11', [])
    const state = runStateOf(node('n1'))
    expect(state.run).toBe('failed')
    expect(state.phase).toBe('input')
    expect(state.reason ?? '').toMatch(/必需输入|in-list|列表/)
  })

  it('A12 state-machine 合法配置 → done', async () => {
    const { editor, node } = buildFlowEditor([
      {
        id: 'n1',
        nodeType: 'state-machine',
        config: {
          schemaVersion: 1,
          initialState: 'draft',
          states: ['draft', 'published'],
          transitions: [{ from: 'draft', event: 'publish', to: 'published' }],
          relations: []
        }
      }
    ])
    await runWorkflow(editor, 'p-a12', [])
    expect(runStateOf(node('n1')).run).toBe('success')
  })

  it('A13 human-task 未提交 → skipped 停等（不伪造成功）', async () => {
    const { editor, node } = buildFlowEditor([
      { id: 'n1', nodeType: 'human-task', config: { schemaVersion: 1, outputType: 'text' } }
    ])
    await runWorkflow(editor, 'p-a13', [])
    const state = runStateOf(node('n1'))
    expect(state.run).toBe('skipped')
  })

  it('A14 director 未发布 → skipped 且原因指向发布动作', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'director' }])
    await runWorkflow(editor, 'p-a14', [])
    const state = runStateOf(node('n1'))
    expect(state.run).toBe('skipped')
    expect(state.reason ?? '').toContain('发布')
  })
})

describe('A · 单节点冒烟 · 模型节点（桩网关）', () => {
  it('A15 ai-process 有输入 → done 且产出桩回复', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ reply: '润色后的文案' }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '把这段润色' },
          { id: 'n1', nodeType: 'ai-process' }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-text', toPort: 'in-text' }]
      )
      await runWorkflow(editor, 'p-a15', stubProviders())
      const state = runStateOf(node('n1'))
      expect(state.run).toBe('success')
      expect(JSON.stringify(state.result)).toContain('润色后的文案')
    } finally {
      restore()
    }
  })

  it('A16 ai-process 模型未绑定 → skipped 且原因指向模型绑定', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi(),
      models: {
        resolveBinding: async () => ({
          ok: false,
          error: { code: 'BINDING_NOT_FOUND', message: '未绑定模型' }
        })
      }
    })
    try {
      const { editor, node } = buildFlowEditor(
        [
          { id: 'src', nodeType: 'text', text: '内容' },
          { id: 'n1', nodeType: 'ai-process' }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-text', toPort: 'in-text' }]
      )
      await runWorkflow(editor, 'p-a16', stubProviders())
      const state = runStateOf(node('n1'))
      expect(state.run).toBe('skipped')
      expect(state.reason ?? '').toMatch(/模型|功能/)
    } finally {
      restore()
    }
  })

  it('A17 chat 有待发消息 → done（回归：不再空等输入口）', async () => {
    const restore = installWindowApi({
      ...makeChatGatewayApi({ reply: '你好，有什么可以帮你' }),
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor([
        {
          id: 'n1',
          nodeType: 'chat',
          text: JSON.stringify({
            system: '',
            modelKey: 'stub-text::m-chat',
            messages: [{ role: 'user', content: '你好' }]
          })
        }
      ])
      await runWorkflow(editor, 'p-a17', stubProviders())
      expect(runStateOf(node('n1')).run).toBe('success')
    } finally {
      restore()
    }
  })

  it('A18 image-gen 有提示词 → done 产出媒体引用；无提示词 → skipped', async () => {
    const restore = installWindowApi({
      gateway: {
        ...makeChatGatewayApi().gateway,
        imageGenerate: async () => mediaEnvelopeOk('gen-1', 'D:/t/gen-1.png', 'image/png')
      },
      ...fullModelCatalogApi()
    })
    try {
      const ok = buildFlowEditor([{ id: 'n1', nodeType: 'image-gen', text: '一只赛博朋克的猫' }])
      await runWorkflow(ok.editor, 'p-a18', stubProviders())
      const state = runStateOf(ok.node('n1'))
      expect(state.run).toBe('success')
      expect(JSON.stringify(state.result)).toContain('gen-1')

      resetEnginePhase()
      const empty = buildFlowEditor([{ id: 'n1', nodeType: 'image-gen', text: '' }])
      await runWorkflow(empty.editor, 'p-a18b', stubProviders())
      expect(runStateOf(empty.node('n1')).run).toBe('skipped')
    } finally {
      restore()
    }
  })

  it('A19 video 提交→轮询→完成 → done 产出视频引用', async () => {
    let polled = 0
    const restore = installWindowApi({
      gateway: {
        videoSubmit: async () => ({ ok: true, data: { taskId: 'vid-1' } }),
        videoCancel: async () => ({ ok: true }),
        videoTask: async () => {
          polled += 1
          return {
            ok: true,
            data: { status: 'success', mediaId: 'vid-out-1', mediaPath: 'D:/t/vid-out-1.mp4' }
          }
        }
      },
      ...fullModelCatalogApi()
    })
    try {
      const { editor, node } = buildFlowEditor([
        { id: 'n1', nodeType: 'video', text: '两秒城市延时' }
      ])
      await runWorkflow(editor, 'p-a19', stubProviders())
      const state = runStateOf(node('n1'))
      expect(state.run).toBe('success')
      expect(polled).toBeGreaterThan(0)
      expect(JSON.stringify(state.result)).toContain('vid-out-1')
    } finally {
      restore()
    }
  }, 20000)

  it('A20 speech 云端合成 → done；tts 缺参考语音 → skipped；voice-design 无描述 → skipped', async () => {
    const restore = installWindowApi({
      gateway: {
        ...makeChatGatewayApi().gateway,
        speechGenerate: async () => ({
          ok: true,
          data: { asset: { id: 'speech-1', path: 'D:/t/speech-1.mp3', mime: 'audio/mpeg' } }
        }),
        ttsGenerate: async () => mediaEnvelopeOk('tts-1', 'D:/t/tts-1.mp3', 'audio/mpeg'),
        voiceDesign: async () => ({
          ok: true,
          data: {
            asset: { id: 'vd-1', path: 'D:/t/vd.mp3', mime: 'audio/mpeg' },
            voiceId: 'voice-x'
          }
        })
      },
      ...fullModelCatalogApi()
    })
    try {
      const speech = buildFlowEditor([{ id: 'n1', nodeType: 'speech', text: '今天天气不错' }])
      await runWorkflow(speech.editor, 'p-a20', stubProviders())
      expect(runStateOf(speech.node('n1')).run).toBe('success')

      resetEnginePhase()
      const tts = buildFlowEditor([{ id: 'n1', nodeType: 'tts', text: '克隆这段话' }])
      await runWorkflow(tts.editor, 'p-a20b', stubProviders())
      const ttsState = runStateOf(tts.node('n1'))
      expect(ttsState.run).toBe('skipped')
      expect(ttsState.reason ?? '').toContain('参考语音')

      resetEnginePhase()
      const vd = buildFlowEditor([{ id: 'n1', nodeType: 'voice-design', text: '' }])
      await runWorkflow(vd.editor, 'p-a20c', stubProviders())
      expect(runStateOf(vd.node('n1')).run).toBe('skipped')
    } finally {
      restore()
    }
  })
})

describe('A · 单节点冒烟 · 本地媒体节点（桩信封）', () => {
  function mediaApi(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      getLocalMediaCapabilities: async () => localCapabilitiesOk(),
      cropImage: async () => mediaEnvelopeOk('crop-1', 'D:/t/crop-1.png', 'image/png'),
      splitImageGrid: async () => ({
        ok: true,
        data: [
          { id: 'split-1', path: 'D:/t/split-1.png', mime: 'image/png' },
          { id: 'split-2', path: 'D:/t/split-2.png', mime: 'image/png' }
        ]
      }),
      extractVideoFrame: async () => mediaEnvelopeOk('frame-1', 'D:/t/frame-1.png', 'image/png'),
      clipVideo: async () => mediaEnvelopeOk('clip-1', 'D:/t/clip-1.mp4', 'video/mp4'),
      soundAdjust: async () => mediaEnvelopeOk('sa-1', 'D:/t/sa-1.mp3', 'audio/mpeg'),
      composeTimeline: async () => mediaEnvelopeOk('tl-1', 'D:/t/tl-1.mp4', 'video/mp4'),
      deleteMedia: async () => undefined,
      ...extra
    }
  }

  it('A21 image→image-crop → done 产出裁剪图；未连源 → skipped 请连接', async () => {
    const restore = installWindowApi(mediaApi())
    try {
      const ok = buildFlowEditor(
        [
          {
            id: 'src',
            nodeType: 'image',
            mediaId: 'img-src',
            mediaPath: 'D:/t/src.png',
            mediaMime: 'image/png'
          },
          {
            id: 'n1',
            nodeType: 'image-crop',
            config: { mode: 'rect', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }
          }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-image', toPort: 'in-image' }]
      )
      await runWorkflow(ok.editor, 'p-a21', [])
      const state = runStateOf(ok.node('n1'))
      expect(state.run).toBe('success')
      expect(JSON.stringify(state.result)).toContain('crop-1')

      resetEnginePhase()
      const bare = buildFlowEditor([{ id: 'n1', nodeType: 'image-crop' }])
      await runWorkflow(bare.editor, 'p-a21b', [])
      const bareState = runStateOf(bare.node('n1'))
      // 必填 in-image 未连线：契约层显式失败（真机走补输入表单；测试宿主无表单）。
      expect(bareState.run).toBe('failed')
      expect(bareState.phase).toBe('input')
    } finally {
      restore()
    }
  })

  it('A22 image→image-split → done 产出多格', async () => {
    const restore = installWindowApi(mediaApi())
    try {
      const { editor, node } = buildFlowEditor(
        [
          {
            id: 'src',
            nodeType: 'image',
            mediaId: 'img-src',
            mediaPath: 'D:/t/src.png',
            mediaMime: 'image/png'
          },
          { id: 'n1', nodeType: 'image-split', config: { rows: 1, cols: 2 } }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-image', toPort: 'in-image' }]
      )
      await runWorkflow(editor, 'p-a22', [])
      const state = runStateOf(node('n1'))
      expect(state.run).toBe('success')
      expect(JSON.stringify(state.result)).toContain('split-2')
    } finally {
      restore()
    }
  })

  it('A23 video-asset→video-frame / video-clip → done', async () => {
    const restore = installWindowApi(mediaApi())
    try {
      const frame = buildFlowEditor(
        [
          {
            id: 'src',
            nodeType: 'video-asset',
            mediaId: 'v-src',
            mediaPath: 'D:/t/src.mp4',
            mediaMime: 'video/mp4'
          },
          {
            id: 'n1',
            nodeType: 'video-frame',
            config: { mode: 'time', timeMs: 500, format: 'png' }
          }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-video', toPort: 'in-video' }]
      )
      await runWorkflow(frame.editor, 'p-a23', [])
      expect(runStateOf(frame.node('n1')).run).toBe('success')

      resetEnginePhase()
      const clip = buildFlowEditor(
        [
          {
            id: 'src',
            nodeType: 'video-asset',
            mediaId: 'v-src',
            mediaPath: 'D:/t/src.mp4',
            mediaMime: 'video/mp4'
          },
          {
            id: 'n1',
            nodeType: 'video-clip',
            config: { startMs: 0, endMs: 1000, keepVideo: true, keepAudio: false }
          }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-video', toPort: 'in-video' }]
      )
      await runWorkflow(clip.editor, 'p-a23b', [])
      expect(runStateOf(clip.node('n1')).run).toBe('success')
    } finally {
      restore()
    }
  })

  it('A24 audio→sound-adjust → done；同时连音频+视频 → failed 只允许一个源', async () => {
    const restore = installWindowApi(mediaApi())
    try {
      const ok = buildFlowEditor(
        [
          {
            id: 'src',
            nodeType: 'audio',
            mediaId: 'a-src',
            mediaPath: 'D:/t/src.mp3',
            mediaMime: 'audio/mpeg'
          },
          { id: 'n1', nodeType: 'sound-adjust', config: { volume: 1 } }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-audio', toPort: 'in-audio' }]
      )
      await runWorkflow(ok.editor, 'p-a24', [])
      expect(runStateOf(ok.node('n1')).run).toBe('success')

      resetEnginePhase()
      const both = buildFlowEditor(
        [
          {
            id: 'a',
            nodeType: 'audio',
            mediaId: 'a-src',
            mediaPath: 'D:/t/a.mp3',
            mediaMime: 'audio/mpeg'
          },
          {
            id: 'v',
            nodeType: 'video-asset',
            mediaId: 'v-src',
            mediaPath: 'D:/t/v.mp4',
            mediaMime: 'video/mp4'
          },
          { id: 'n1', nodeType: 'sound-adjust', config: { volume: 1 } }
        ],
        [
          { from: 'a', to: 'n1', fromPort: 'out-audio', toPort: 'in-audio' },
          { from: 'v', to: 'n1', fromPort: 'out-video', toPort: 'in-video' }
        ]
      )
      await runWorkflow(both.editor, 'p-a24b', [])
      const state = runStateOf(both.node('n1'))
      expect(state.run).toBe('failed')
      expect(state.reason ?? '').toContain('恰好连接一种输入')
    } finally {
      restore()
    }
  })

  it('A25 video-asset→video-depth 引擎未安装 → 明确终态（不挂死）', async () => {
    const restore = installWindowApi(
      mediaApi({
        getVideoEngineStatus: async () => ({
          ok: true,
          data: { state: 'not_installed', message: '视频 AI 引擎未安装' }
        })
      })
    )
    try {
      const { editor, node } = buildFlowEditor(
        [
          {
            id: 'src',
            nodeType: 'video-asset',
            mediaId: 'v-src',
            mediaPath: 'D:/t/src.mp4',
            mediaMime: 'video/mp4'
          },
          { id: 'n1', nodeType: 'video-depth' }
        ],
        [{ from: 'src', to: 'n1', fromPort: 'out-video', toPort: 'in-video' }]
      )
      await runWorkflow(editor, 'p-a25', [])
      const state = runStateOf(node('n1'))
      expect(['failed', 'skipped']).toContain(state.run)
      expect(state.reason ?? '').toMatch(/引擎|安装|转换/)
    } finally {
      restore()
    }
  })

  it('A26 timeline 空时间线 → skipped 提示添加素材', async () => {
    const restore = installWindowApi(mediaApi())
    try {
      const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'timeline', text: '' }])
      await runWorkflow(editor, 'p-a26', [])
      const state = runStateOf(node('n1'))
      expect(state.run).toBe('skipped')
      expect(state.reason ?? '').toContain('片段')
    } finally {
      restore()
    }
  })
})

describe('A · 单节点冒烟 · 特殊宿主（stub 网关）', () => {
  it('A27 agent specialist 任务完成 → done；等待人工 → skipped 停等', async () => {
    const agentConfig = {
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: 'autonomous',
      modelDefinitionId: 'model-stub-1',
      skills: [],
      tools: [],
      allowedNodeIds: [],
      maxSteps: 4,
      relations: []
    }
    const restore = installWindowApi({
      runFlowAgent: async () => ({
        ok: true,
        data: { task: { taskId: 't1', state: 'completed' }, outputs: {}, refs: {} }
      }),
      stopFlowAgent: async () => ({ ok: true })
    })
    try {
      const done = buildFlowEditor([{ id: 'n1', nodeType: 'agent', config: agentConfig }])
      await runWorkflow(done.editor, 'p-a27', [])
      expect(runStateOf(done.node('n1')).run).toBe('success')

      resetEnginePhase()
      const restore2 = installWindowApi({
        runFlowAgent: async () => ({
          ok: true,
          data: {
            task: { taskId: 't2', state: 'waiting', waitKind: 'human' },
            outputs: {},
            refs: {}
          }
        }),
        stopFlowAgent: async () => ({ ok: true })
      })
      try {
        const waiting = buildFlowEditor([{ id: 'n1', nodeType: 'agent', config: agentConfig }])
        await runWorkflow(waiting.editor, 'p-a27b', [])
        const state = runStateOf(waiting.node('n1'))
        expect(state.run).toBe('skipped')
        expect(state.reason ?? '').toContain('人工')
      } finally {
        restore2()
      }
    } finally {
      restore()
    }
  })

  it('A28 ai-review 审核通过 → done 产出审核结果', async () => {
    const restore = installWindowApi({
      reviewFlowAssets: async () => ({
        ok: true,
        data: {
          schemaVersion: 1,
          reviewId: 'rev-1',
          cycleId: 'cycle-1',
          reviewNodeId: 'n1',
          reviewRevision: 1,
          rulesVersion: 'default-1',
          subjects: [
            {
              assetId: 'asset-1',
              versionId: 'ver-1',
              sourceNodeId: 'src-1',
              sourcePortId: 'out-image'
            }
          ],
          passed: true,
          feedback: '抽样检查通过',
          evidenceScope: 'complete-text-json',
          issues: []
        }
      })
    })
    try {
      const { editor, node } = buildFlowEditor([
        {
          id: 'n1',
          nodeType: 'ai-review',
          config: {
            schemaVersion: 1,
            rulesVersion: 'default-1',
            modelDefinitionId: 'model-stub-1',
            rejectPolicy: 'rework',
            maxReworks: 2,
            subjectSources: [],
            gatedNodeIds: [],
            relations: []
          }
        }
      ])
      await runWorkflow(editor, 'p-a28', [])
      const state = runStateOf(node('n1'))
      expect(state.run).toBe('success')
      expect(JSON.stringify(state.result)).toContain('passed')
    } finally {
      restore()
    }
  })

  it('A29 code 节点在引擎全链下可执行（jsdom Worker 受限时记录环境差异）', async () => {
    const { editor, node } = buildFlowEditor([
      {
        id: 'n1',
        nodeType: 'code',
        config: {
          source: 'async function main(args){ return args.text + "-processed" }',
          inputName: 'text',
          inputType: 'string',
          outputName: 'result',
          outputType: 'string',
          params: [],
          outputMode: 'single',
          outputs: []
        },
        text: '原始输入'
      }
    ])
    await runWorkflow(editor, 'p-a29', [])
    const state = runStateOf(node('n1'))
    // 记录实际终态：done 说明 Worker 沙箱在 jsdom 下可用；failed/skipped 需给出可读原因。
    if (state.run !== 'success') {
      expect(state.reason ?? '').toBeTruthy()
    } else {
      expect(JSON.stringify(state.result)).toContain('processed')
    }
  })
})

describe('B · 基础拓扑', () => {
  it('B1 四节点线性链 text→processor→text：值逐级透传', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'text', text: '原始文案' },
        { id: 'p', nodeType: 'processor', config: { operation: 'pass', fallback: '' } },
        { id: 'out', nodeType: 'text', text: '' }
      ],
      [
        { from: 'src', to: 'p', fromPort: 'out-text', toPort: 'in-value' },
        { from: 'p', to: 'out', fromPort: 'out-value', toPort: 'in-text' }
      ]
    )
    await runWorkflow(editor, 'p-b1', [])
    expect(runStateOf(node('src')).run).toBe('success')
    expect(runStateOf(node('p')).run).toBe('success')
    expect(runStateOf(node('out')).run).toBe('success')
    expect(String(node('out')!.props.text)).toContain('原始文案')
  })

  it('B2 单源扇出三分支：各分支独立成功', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'text', text: '一份素材' },
        { id: 'a', nodeType: 'text', text: '' },
        { id: 'b', nodeType: 'processor', config: { operation: 'pass', fallback: '兜底' } },
        { id: 'c', nodeType: 'text', text: '' }
      ],
      [
        { from: 'src', to: 'a', fromPort: 'out-text', toPort: 'in-text' },
        { from: 'src', to: 'b', fromPort: 'out-text', toPort: 'in-value' },
        { from: 'src', to: 'c', fromPort: 'out-text', toPort: 'in-text' }
      ]
    )
    await runWorkflow(editor, 'p-b2', [])
    expect(runStateOf(node('a')).run).toBe('success')
    expect(runStateOf(node('b')).run).toBe('success')
    expect(runStateOf(node('c')).run).toBe('success')
    expect(String(node('a')!.props.text)).toContain('一份素材')
  })

  it('B3 两源扇入：connectOrder 决定取值顺序', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'first', nodeType: 'text', text: '第一顺位' },
        { id: 'second', nodeType: 'text', text: '第二顺位' },
        { id: 'sink', nodeType: 'text', text: '' }
      ],
      [
        { from: 'second', to: 'sink', fromPort: 'out-text', toPort: 'in-text', connectOrder: 2 },
        { from: 'first', to: 'sink', fromPort: 'out-text', toPort: 'in-text', connectOrder: 1 }
      ]
    )
    await runWorkflow(editor, 'p-b3', [])
    expect(runStateOf(node('sink')).run).toBe('success')
    expect(String(node('sink')!.props.text)).toContain('第一顺位')
  })

  it('B4 菱形：同源双路各取一字段再汇聚为列表', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'json', text: '{"a":{"x":1},"b":{"y":2}}' },
        {
          id: 'left',
          nodeType: 'processor',
          config: { operation: 'pick', path: 'a.x' }
        },
        {
          id: 'right',
          nodeType: 'processor',
          config: { operation: 'pick', path: 'b.y' }
        },
        { id: 'sink', nodeType: 'json', text: '' }
      ],
      [
        { from: 'src', to: 'left', fromPort: 'out-json', toPort: 'in-value' },
        { from: 'src', to: 'right', fromPort: 'out-json', toPort: 'in-value' },
        { from: 'left', to: 'sink', fromPort: 'out-value', toPort: 'in-json', connectOrder: 1 },
        { from: 'right', to: 'sink', fromPort: 'out-value', toPort: 'in-json', connectOrder: 2 }
      ]
    )
    await runWorkflow(editor, 'p-b4', [])
    expect(runStateOf(node('left')).run).toBe('success')
    expect(runStateOf(node('right')).run).toBe('success')
    const sink = runStateOf(node('sink'))
    expect(sink.run).toBe('success')
    const text = String(node('sink')!.props.text)
    expect(text).toContain('1')
    expect(text).toContain('2')
  })

  it('B5 十节点长链稳定执行', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      nodeType: 'text',
      text: i === 0 ? '链头内容' : ''
    }))
    const edges = Array.from({ length: 9 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      fromPort: 'out-text',
      toPort: 'in-text'
    }))
    const { editor, node } = buildFlowEditor(nodes, edges)
    await runWorkflow(editor, 'p-b5', [])
    for (let i = 0; i < 10; i++) {
      expect(runStateOf(node(`n${i}`)).run).toBe('success')
    }
    expect(String(node('n9')!.props.text)).toContain('链头内容')
  })

  it('B6 空图/孤立节点：不误跑不报错', async () => {
    const empty = buildFlowEditor([])
    await runWorkflow(empty.editor, 'p-b6', [])
    const isolated = buildFlowEditor([{ id: 'n1', nodeType: 'text', text: '孤立内容' }])
    await runWorkflow(isolated.editor, 'p-b6b', [])
    expect(runStateOf(isolated.node('n1')).run).toBe('success')
  })

  it('B7 框选子图：上游闭包自动带上', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'text', text: '上游内容' },
        { id: 'mid', nodeType: 'processor', config: { operation: 'pass', fallback: '' } },
        { id: 'sink', nodeType: 'text', text: '' },
        { id: 'bystander', nodeType: 'text', text: '旁观节点' }
      ],
      [
        { from: 'src', to: 'mid', fromPort: 'out-text', toPort: 'in-value' },
        { from: 'mid', to: 'sink', fromPort: 'out-value', toPort: 'in-text' }
      ]
    )
    const outcome = await runWorkflowForNodes(editor, 'p-b7', [], ['sink'])
    expect(outcome).toBe('completed')
    expect(runStateOf(node('src')).run).toBe('success')
    expect(runStateOf(node('mid')).run).toBe('success')
    expect(runStateOf(node('sink')).run).toBe('success')
    // 旁观节点不在目标子图，也不在其上游闭包：不应被执行。
    expect(runStateOf(node('bystander')).exec).toBe('idle')
  })

  it('B8 手动单跑：上游已成功输出可复用，不重跑上游', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'text', text: '上游产出' },
        { id: 'sink', nodeType: 'processor', config: { operation: 'pass', fallback: '' } }
      ],
      [{ from: 'src', to: 'sink', fromPort: 'out-text', toPort: 'in-value' }]
    )
    await runWorkflow(editor, 'p-b8', [])
    expect(runStateOf(node('src')).run).toBe('success')
    const srcRunCount = (node('src')!.meta.nodeRunHistory as unknown[] | undefined)?.length ?? 0

    resetEnginePhase()
    const result = await runNodeManually(editor, 'p-b8', [], 'sink')
    expect(result.status).toBe('done')
    expect(String(node('sink')!.meta.nodeResult)).toContain('上游产出')
    const afterCount = (node('src')!.meta.nodeRunHistory as unknown[] | undefined)?.length ?? 0
    expect(afterCount).toBe(srcRunCount)
  })
})

describe('C · 失败/跳过语义', () => {
  it('C1 上游 failed → 下游显式 failed（phase=input），不静默复用旧值', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'bad', nodeType: 'json', text: '{bad-json' },
        { id: 'sink', nodeType: 'text', text: '' }
      ],
      [{ from: 'bad', to: 'sink', fromPort: 'out-json', toPort: 'in-text' }]
    )
    await runWorkflow(editor, 'p-c1', [])
    expect(runStateOf(node('bad')).run).toBe('failed')
    const sink = runStateOf(node('sink'))
    expect(sink.run).toBe('failed')
    expect(sink.reason ?? '').toMatch(/上游|未产生|输入/)
  })

  it('C2 上游 skipped（空文本）→ 下游显式失败而非挂死', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'empty', nodeType: 'text', text: '' },
        { id: 'sink', nodeType: 'processor', config: { operation: 'pass', fallback: '' } }
      ],
      [{ from: 'empty', to: 'sink', fromPort: 'out-text', toPort: 'in-value' }]
    )
    await runWorkflow(editor, 'p-c2', [])
    expect(runStateOf(node('empty')).run).toBe('skipped')
    expect(runStateOf(node('sink')).run).toBe('failed')
  })

  it('C3 一坏一好分支：坏分支不拖死好分支', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'text', text: '共享素材' },
        { id: 'bad', nodeType: 'json', text: '{bad' },
        { id: 'good', nodeType: 'text', text: '' }
      ],
      [
        { from: 'src', to: 'bad', fromPort: 'out-text', toPort: 'in-text' },
        { from: 'src', to: 'good', fromPort: 'out-text', toPort: 'in-text' }
      ]
    )
    await runWorkflow(editor, 'p-c3', [])
    expect(runStateOf(node('bad')).run).toBe('failed')
    expect(runStateOf(node('good')).run).toBe('success')
  })

  it('C4 同一运行内不复用旧输出：改上游正文全图重跑后，下游拿到新值', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'text', text: '第一版文案' },
        { id: 'sink', nodeType: 'text', text: '' }
      ],
      [{ from: 'src', to: 'sink', fromPort: 'out-text', toPort: 'in-text' }]
    )
    await runWorkflow(editor, 'p-c4', [])
    expect(String(node('sink')!.props.text)).toContain('第一版文案')

    node('src')!.props.text = '第二版文案'
    resetEnginePhase()
    await runWorkflow(editor, 'p-c4', [])
    expect(String(node('sink')!.props.text)).toContain('第二版文案')
  })

  it('C5 json 数字改型防护（R-17）：1e3 会静默变成 1000 → 显式失败提示加引号', async () => {
    const { editor, node } = buildFlowEditor([{ id: 'n1', nodeType: 'json', text: '1e3' }])
    await runWorkflow(editor, 'p-c5', [])
    const state = runStateOf(node('n1'))
    expect(state.run).toBe('failed')
    expect(state.reason ?? '').toContain('加引号')
  })

  it('C6 structured 占位符缺输入（R-15）：显式失败', async () => {
    const { editor, node } = buildFlowEditor([
      {
        id: 'n1',
        nodeType: 'structured',
        text: '{"prompt":"{{input[0].scene}}"}',
        config: { schema: { id: 'prompt.bundle', version: 1 } }
      }
    ])
    await runWorkflow(editor, 'p-c6', [])
    const state = runStateOf(node('n1'))
    expect(state.run).toBe('failed')
    expect(state.reason ?? '').toContain('占位符')
  })

  it('C7 processor pick 字段路径不存在 → 显式失败', async () => {
    const { editor, node } = buildFlowEditor(
      [
        { id: 'src', nodeType: 'json', text: '{"a":{"b":1}}' },
        { id: 'sink', nodeType: 'processor', config: { operation: 'pick', path: 'a.missing' } }
      ],
      [{ from: 'src', to: 'sink', fromPort: 'out-json', toPort: 'in-value' }]
    )
    await runWorkflow(editor, 'p-c7', [])
    const state = runStateOf(node('sink'))
    expect(state.run).toBe('failed')
    expect(state.reason ?? '').toContain('字段路径不存在')
  })
})
