// AI 处理节点执行器测试（路线图 R3 / 契约规范 P3）
//
// 覆盖 parseAiProcess 配置解析与 aiProcess 执行器的运行时分支：
// text / markdown / json 三种输出模式、JSON 解析失败与 Schema 校验失败的报错、
// 无输入 / 无模型跳过、以及「不把普通文本伪装成 JSON」的规范约束。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseAiProcess, aiProcessExecutor } from '@renderer/engine/executors/aiProcess'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'
import type { ProviderConfig } from '@shared/types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

// 构造一个能回放 chatStart 的假网关，返回预置的完整回复。

let chatReply = ''
let currentGateway: Record<string, unknown> = {}

function installFakeGateway(reply: string): void {
  chatReply = reply
  currentGateway = {
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

// W1：可编程的「前 N 次失败」假网关——重试语义需要观察到多次 chatStart。
let chatStartCalls = 0
function installFlakyGateway(failTimes: number, failError: string, reply: string): void {
  chatStartCalls = 0
  currentGateway = {
    chatStart: vi.fn().mockImplementation(async () => {
      chatStartCalls += 1
      return { ok: true, data: { taskId: 'task-1' } }
    }),
    chatCancel: vi.fn().mockResolvedValue({ ok: true, data: true }),
    onEvent: vi.fn((cb) => {
      setTimeout(() => {
        // chatStart 的微任务先于 setTimeout(0) 完成，此时计数已含本次调用
        if (chatStartCalls <= failTimes) {
          cb({ kind: 'chat-error', taskId: 'task-1', error: failError })
        } else {
          cb({ kind: 'chat-delta', taskId: 'task-1', text: reply })
          cb({ kind: 'chat-done', taskId: 'task-1' })
        }
      }, 0)
      return () => {}
    })
  }
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
  result: { value: string | null }
} {
  const props: Partial<NodeCardShape['props']> = {}
  const result = { value: null as string | null }
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
      config: text,
      text: '',
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
    gateway: currentGateway as unknown as GatewayClient,
    updateProps: (patch) => Object.assign(props, patch),
    updateResult: (r) => {
      result.value = r
    }
  }
  return { ctx, props, result }
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
  currentGateway = {}
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
        maxTokens: 2048,
        retry: { maxRetries: 2, backoffMs: 1000 }
      })
    )
    expect(cfg).toEqual({
      modelKey: 'p1::m1',
      system: '你是导演',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 },
      temperature: 0.5,
      maxTokens: 2048,
      retry: { maxRetries: 2, backoffMs: 1000 },
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
    const { ctx, props, result } = makeCtx(config, textInput('原始文本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    const written = JSON.parse(result.value as string)
    expect(written).toEqual({ kind: 'text', text: '转换后的文本' })
    expect(r.artifactOutputPorts).toEqual(['out-text'])
    // 配置/结果分离：执行器只写运行结果（meta），不改动 props.text 配置
    expect(Object.keys(props)).toHaveLength(0)
  })

  it('markdown 模式：输出 markdown 结果', async () => {
    installFakeGateway('# 标题')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'markdown' })
    const { ctx, result } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(result.value as string)).toEqual({ kind: 'markdown', text: '# 标题' })
    expect(r.artifactOutputPorts).toEqual(['out-markdown'])
  })

  it('json 模式：合法 JSON 且通过 Schema 校验 → 输出 json 结果', async () => {
    installFakeGateway('{"shots":[{"id":"s1","scene":"a"}]}')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 }
    })
    const { ctx, result } = makeCtx(config, textInput('剧本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(result.value as string).kind).toBe('json')
    expect(JSON.parse(result.value as string).data.shots).toHaveLength(1)
    expect(r.artifactOutputPorts).toEqual(['out-json'])
  })

  it('json 模式：模型带 ```json 围栏 → 剥离后正常解析（宽容提取）', async () => {
    installFakeGateway('```json\n{"shots":[{"id":"s1","scene":"a"}]}\n```')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 }
    })
    const { ctx, result } = makeCtx(config, textInput('剧本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(result.value as string).data.shots).toHaveLength(1)
  })

  it('json 模式：JSON 前后有说明文字 → 提取首个平衡 JSON 解析', async () => {
    installFakeGateway('好的，以下是分镜：\n{"shots":[{"id":"s1","scene":"a"}]}\n请查收。')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 }
    })
    const { ctx, result } = makeCtx(config, textInput('剧本'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(result.value as string).data.shots).toHaveLength(1)
  })

  it('json 模式但未选 Schema → 默认 json.any 宽容校验（W9）', async () => {
    installFakeGateway('{"a":1}')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'json' })
    const { ctx, result } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(result.value as string).data).toEqual({ a: 1 })
  })

  it('json 模式未选 Schema 且模型返回非 JSON → 仍失败（默认 Schema 不降低失败语义）', async () => {
    installFakeGateway('这不是 JSON')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'json' })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.artifactOutputPorts).toBeUndefined()
    expect(r.reason).toContain('JSON')
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
    expect(r.artifactOutputPorts).toBeUndefined()
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
    expect(r.artifactOutputPorts).toBeUndefined()
    expect(r.reason).toContain('storyboard.shots')
  })

  it('text 模式模型返回为空 → failed，不标成功零输出（R-19）', async () => {
    installFakeGateway('   ')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'text' })
    const { ctx, result } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.artifactOutputPorts).toBeUndefined()
    expect(r.reason).toContain('模型返回为空')
    // 失败不写运行结果，下游不得把空输出当成功消费。
    expect(result.value).toBeNull()
  })

  it('markdown 模式模型返回为空 → failed（R-19）', async () => {
    installFakeGateway('')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'markdown' })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.artifactOutputPorts).toBeUndefined()
    expect(r.reason).toContain('模型返回为空')
  })
})

describe('aiProcess 执行器 · W1 自动重试', () => {
  it('瞬时失败（模型返回为空）后重试成功 → done，chatStart 共调用 3 次', async () => {
    installFlakyGateway(2, '模型返回为空', '{"shots":[{"id":"s1"}]}')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'json',
      jsonSchema: { id: 'json.any', version: 1 },
      retry: { maxRetries: 3, backoffMs: 500 }
    })
    const { ctx, result } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('done')
    expect(JSON.parse(result.value as string).data).toEqual({ shots: [{ id: 's1' }] })
    expect(chatStartCalls).toBe(3)
  }, 15000)

  it('重试次数用尽仍失败 → failed，原因聚合此前尝试', async () => {
    installFlakyGateway(99, '模型返回为空', 'irrelevant')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'text',
      retry: { maxRetries: 1, backoffMs: 500 }
    })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('模型返回为空')
    expect(chatStartCalls).toBe(2)
  }, 15000)

  it('未配置重试（默认 maxRetries=0）→ 行为与历史一致，只调用一次', async () => {
    installFlakyGateway(1, '模型返回为空', 'irrelevant')
    const config = JSON.stringify({ modelKey: 'p1::m1', mode: 'text' })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(chatStartCalls).toBe(1)
  })

  it('不可重试错误（chat-error 报配置类失败）→ 立即失败，不重试', async () => {
    installFlakyGateway(99, '当前供应商返回 401 Key error', 'irrelevant')
    const config = JSON.stringify({
      modelKey: 'p1::m1',
      mode: 'text',
      retry: { maxRetries: 3, backoffMs: 500 }
    })
    const { ctx } = makeCtx(config, textInput('输入'))
    const r = await aiProcessExecutor(ctx)
    expect(r.status).toBe('failed')
    expect(chatStartCalls).toBe(1)
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
