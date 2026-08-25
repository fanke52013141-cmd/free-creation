// AI 处理节点执行器测试（路线图 R3 / 契约规范 P3）
//
// 覆盖 parseAiProcess 配置解析与 aiProcess 执行器的运行时分支：
// text / markdown / json 三种输出模式、JSON 解析失败与 Schema 校验失败的报错、
// 无输入 / 无模型跳过、以及「不把普通文本伪装成 JSON」的规范约束。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseAiProcess, aiProcessExecutor } from '@renderer/engine/executors/aiProcess'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { ProviderConfig } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

// 构造一个能回放 chatStart 的假网关，返回预置的完整回复。

let chatReply = ''

function installFakeGateway(reply: string): void {
  chatReply = reply
  globalThis.window = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    api: {
      gateway: {
        chatStart: vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'task-1' } }),
        chatCancel: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onEvent: vi.fn((cb) => {
          // 用 setTimeout(0) 在 chatStart.then 设置 taskId 之后再派发事件，
          // 否则 waitForChat 的 `if (!taskId) return` 会丢弃这些事件导致永远不 resolve。
          setTimeout(() => {
            cb({ kind: 'chat-delta', taskId: 'task-1', text: chatReply })
            cb({ kind: 'chat-done', taskId: 'task-1' })
          }, 0)
          return () => {}
        })
      }
    }
  } as unknown as Window & typeof globalThis
}

const provider: ProviderConfig = {
  id: 'p1',
  name: '测试供应商',
  specId: 'openai-compatible',
  baseURL: 'https://example.com',
  apiKey: 'k',
  models: [{ id: 'm1', name: '模型1', modality: 'text', providerId: 'p1' }]
} as ProviderConfig

function makeCtx(
  text: string,
  inputs?: NodeExecutionContext['inputs']
): {
  ctx: NodeExecutionContext
  props: Partial<NodeCardShape['props']>
} {
  const props: Partial<NodeCardShape['props']> = {}
  const shape = {
    id: 'shape:1',
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: 'ai-process',
      title: 'n',
      text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  } as unknown as NodeCardShape
  const ctx: NodeExecutionContext = {
    node: {
      id: 'shape:1',
      type: 'ai-process',
      contractVersion: 1,
      title: 'n',
      x: 0,
      y: 0,
      w: 340,
      h: 260,
      ports: [],
      params: {},
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 0 }
    },
    shape,
    inputs: inputs ?? new Map(),
    projectId: 'p1',
    providers: [provider],
    signal: { cancelled: false },
    updateProps: (patch) => Object.assign(props, patch),
    updateResult: () => {}
  }
  return { ctx, props }
}

function textInput(text: string): NodeExecutionContext['inputs'] {
  return new Map([
    [
      'in-text',
      [
        {
          type: 'text',
          value: { kind: 'text', text },
          source: { nodeId: 'u', portId: 'out-text', runId: 'r1' },
          createdAt: 0
        }
      ]
    ]
  ])
}

beforeEach(() => {
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseAiProcess · 配置解析', () => {
  it('解析完整配置', () => {
    const cfg = parseAiProcess(
      JSON.stringify({
        modelKey: 'p1::m1',
        system: '你是导演',
        mode: 'json',
        jsonSchema: { id: 'storyboard.shots', version: 1 },
        temperature: 0.5,
        maxTokens: 2048
      })
    )
    expect(cfg).toEqual({
      modelKey: 'p1::m1',
      system: '你是导演',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 },
      temperature: 0.5,
      maxTokens: 2048,
      result: undefined
    })
  })

  it('缺字段时安全降级（mode 默认 text）', () => {
    const cfg = parseAiProcess('')
    expect(cfg.mode).toBe('text')
    expect(cfg.modelKey).toBe('')
    expect(cfg.temperature).toBe(0.7)
    expect(cfg.maxTokens).toBe(4096)
    expect(cfg.jsonSchema).toBeUndefined()
  })

  it('异常 mode 回退为 text', () => {
    const cfg = parseAiProcess('{"mode":"yaml"}')
    expect(cfg.mode).toBe('text')
  })
})

describe('aiProcess 执行器 · 输出模式分支', () => {
  it('text 模式：模型回复原样作为 out-text 结果', async () => {
    installFakeGateway('转换后的文本')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'text',
      temperature: 0.7,
      maxTokens: 4096
    })
    const { ctx, props } = makeCtx(config, textInput('原始文本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    const written = JSON.parse(props.text as string)
    expect(written.result).toEqual({ kind: 'text', text: '转换后的文本' })
  })

  it('markdown 模式：输出 markdown 结果', async () => {
    installFakeGateway('# 标题')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'markdown' })
    const { ctx, props } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(props.text as string).result).toEqual({ kind: 'markdown', text: '# 标题' })
  })

  it('json 模式：合法 JSON 且通过 Schema 校验 → 输出 json 结果', async () => {
    installFakeGateway('{"shots":[{"id":"s1","scene":"a"}]}')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 }
    })
    const { ctx, props } = makeCtx(config, textInput('剧本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(props.text as string).result.kind).toBe('json')
    expect(JSON.parse(props.text as string).result.data.shots).toHaveLength(1)
  })

  it('json 模式但未选 Schema → 失败（不伪装 JSON）', async () => {
    installFakeGateway('{"a":1}')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'json' })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('Schema')
  })

  it('json 模式但模型返回的不是合法 JSON → 失败', async () => {
    installFakeGateway('这不是 JSON')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'json.any', version: 1 }
    })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('JSON')
  })

  it('json 模式但结果不符合 Schema → 失败', async () => {
    installFakeGateway('{"shots":"不是数组"}')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 }
    })
    const { ctx } = makeCtx(config, textInput('剧本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('storyboard.shots')
  })
})

describe('aiProcess 执行器 · 跳过条件', () => {
  it('没有输入文本或 JSON → 跳过', async () => {
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'text' })
    const { ctx } = makeCtx(config)
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('输入')
  })

  it('未选择可用模型 → 跳过', async () => {
    const config = JSON.stringify({ modelKey: '', mode: 'text' })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('skipped')
    expect(r.reason).toContain('模型')
  })
})
