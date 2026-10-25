import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSkillBundleUpload, parseSkillUpload, skillAgentConfig } from '../src/shared/skill-agent'
import { runSkillAgent } from '../src/shared/engine/skill-agent'
import { parseChat, serializeChat, createChatConversation } from '../src/shared/engine/chat-data'
import { parseAiProcess, aiProcessExecutor } from '../src/shared/engine/executors/aiProcess'
import { chatExecutor } from '../src/shared/engine/executors/chat'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'
import { waitForChat } from '../src/shared/engine/helpers'

vi.mock('../src/shared/engine/helpers', async (original) => ({
  ...(await original<typeof import('../src/shared/engine/helpers')>()),
  waitForChat: vi.fn()
}))
const skill = parseSkillUpload('整理.md', '整理输入材料并核对结果。')
const agent = {
  skills: [{ ...skill, resources: { 'guide.md': '参考内容 PRIVATE-RESOURCE' } }],
  maxSteps: 4
}
const input = {
  providerId: 'p',
  modelId: 'm',
  messages: [{ role: 'user' as const, content: 'PRIVATE-INPUT' }]
}
function context(): NodeExecutionContext {
  return {
    projectId: 'p',
    node: { id: 'n' },
    signal: { cancelled: false },
    inputs: new Map(),
    shape: { props: { nodeType: 'ai-process', config: '{}', text: '{}' } },
    providers: [
      {
        id: 'p',
        name: 'provider',
        models: [{ id: 'm', name: 'model', modality: 'text', providerId: 'p' }]
      }
    ],
    gateway: {},
    updateProps: vi.fn(),
    updateResult: vi.fn(),
    trace: vi.fn()
  } as unknown as NodeExecutionContext
}
beforeEach(() => vi.resetAllMocks())

describe('skill bundle upload (P2 扩展)', () => {
  const SKILL = ['---', 'name: 目录技能', 'description: 带参考资源的技能', '---', '正文指令'].join('\n')
  const valid = [
    { path: 'SKILL.md', content: SKILL },
    { path: 'style-guide.md', content: '# 风格' },
    { path: 'glossary.md', content: '术语表' }
  ]

  it('解析根部 SKILL.md 与扁平 .md 资源，版本对内容寻址', () => {
    const first = parseSkillBundleUpload(valid)
    expect(first.name).toBe('目录技能')
    expect(first.instructions).toBe('正文指令')
    expect(Object.keys(first.resources).sort()).toEqual(['glossary.md', 'style-guide.md'])
    expect(first.version).toMatch(/^bundle-/)
    // 任何文件变化都产生新版本（版本完整性）。
    const changed = parseSkillBundleUpload([
      ...valid.slice(0, 2),
      { path: 'glossary.md', content: '术语表 v2' }
    ])
    expect(changed.version).not.toBe(first.version)
    expect(parseSkillBundleUpload(valid).version).toBe(first.version)
  })

  it('拒绝路径穿越、绝对路径、嵌套资源、缺 SKILL.md 与超预算', () => {
    expect(() =>
      parseSkillBundleUpload([{ path: 'SKILL.md', content: SKILL }, { path: '../evil.md', content: 'x' }])
    ).toThrow(/穿越目录/)
    expect(() =>
      parseSkillBundleUpload([{ path: 'SKILL.md', content: SKILL }, { path: 'C:/evil.md', content: 'x' }])
    ).toThrow(/绝对路径/)
    expect(() =>
      parseSkillBundleUpload([{ path: 'SKILL.md', content: SKILL }, { path: 'sub/note.md', content: 'x' }])
    ).toThrow(/根部/)
    expect(() => parseSkillBundleUpload([{ path: 'readme.md', content: 'x' }])).toThrow(/SKILL\.md/)
    expect(() =>
      parseSkillBundleUpload([
        { path: 'SKILL.md', content: SKILL },
        { path: 'a.md', content: 'x'.repeat(70_000) },
        { path: 'b.md', content: 'y'.repeat(70_000) }
      ])
    ).toThrow(/128 KiB/)
    expect(() =>
      parseSkillBundleUpload(
        Array.from({ length: 19 }, (_, index) => ({
          path: index === 0 ? 'SKILL.md' : `r${index}.md`,
          content: 'x'
        }))
      )
    ).toThrow(/16 个/)
    expect(() =>
      parseSkillBundleUpload([{ path: 'SKILL.md', content: SKILL }, { path: 'data.json', content: '{}' }])
    ).toThrow(/\.md 文件名/)
  })
})

describe('skill upload and persistence', () => {
  it('imports Markdown metadata and stable versions; content changes create another default version', () => {
    expect(
      parseSkillUpload(
        'SKILL.md',
        '---\nname: 分镜\ndescription: 整理镜头\nversion: v2\n---\n输出分镜'
      )
    ).toMatchObject({ name: '分镜', version: 'v2', instructions: '输出分镜' })
    expect(parseSkillUpload('a.md', 'a').version).not.toBe(parseSkillUpload('a.md', 'b').version)
  })
  it('accepts JSON resources and rejects oversized, executable or malformed manifests', () => {
    expect(
      parseSkillUpload('a.json', JSON.stringify(agent.skills[0])).resources['guide.md']
    ).toContain('参考内容')
    expect(() => parseSkillUpload('a.md', 'x'.repeat(131073))).toThrow('128 KiB')
    expect(() => parseSkillUpload('a.json', JSON.stringify({ ...skill, scripts: {} }))).toThrow()
    expect(() => parseSkillUpload('a.md', '---\ntools: shell\n---\nrun')).toThrow('工具依赖')
    expect(() => parseSkillUpload('a.md', '---\nname: a')).toThrow('未闭合')
    expect(() => parseSkillUpload('a.md', '  ')).toThrow()
  })
  it('keeps selected versions across conversation creation, serialization and processing config', () => {
    const chat = parseChat(serializeChat(createChatConversation(parseChat('{}'))))
    expect(chat.messages).toEqual([])
    expect(parseAiProcess(JSON.stringify({ agent })).agent).toEqual(agent)
    expect(skillAgentConfig(undefined)).toEqual({ skills: [], maxSteps: 6 })
  })
  it('fails closed on invalid settings, duplicated skills and unavailable tools', () => {
    expect(() =>
      skillAgentConfig({
        maxSteps: 6,
        skills: Array.from({ length: 4 }, (_, index) => ({
          ...skill,
          id: `large-${index}`,
          instructions: '汉'.repeat(25000)
        }))
      })
    ).toThrow('配置无效')
    expect(() => skillAgentConfig({ ...agent, maxSteps: 0 })).toThrow()
    expect(() => skillAgentConfig({ ...agent, skills: [skill, skill] })).toThrow()
    expect(() =>
      skillAgentConfig({
        ...agent,
        skills: [{ ...skill, requiredTools: [{ id: 'shell', version: '1' }] }]
      })
    ).toThrow('不支持的工具')
  })
})

describe('autonomous skill loop', () => {
  it('reads only bound resources, validates output, and never logs content', async () => {
    const ctx = context()
    vi.mocked(waitForChat)
      .mockResolvedValueOnce(
        JSON.stringify({ action: 'read_resource', skillId: skill.id, name: 'guide.md' })
      )
      .mockResolvedValueOnce(JSON.stringify({ action: 'complete', output: 'PRIVATE-OUTPUT' }))
    expect(await runSkillAgent(ctx, agent, input)).toBe('PRIVATE-OUTPUT')
    expect(vi.mocked(waitForChat).mock.calls[1][1].messages.at(-1)?.content).toContain(
      'PRIVATE-RESOURCE'
    )
    expect(JSON.stringify(vi.mocked(ctx.trace!).mock.calls)).not.toMatch(/PRIVATE/)
  })
  it('automatically repairs invalid output using validator feedback', async () => {
    vi.mocked(waitForChat)
      .mockResolvedValueOnce('{"action":"complete","output":"bad"}')
      .mockResolvedValueOnce('{"action":"complete","output":"good"}')
    expect(
      await runSkillAgent(context(), agent, input, (output) => {
        if (output !== 'good') throw new Error('需要 good')
      })
    ).toBe('good')
    expect(vi.mocked(waitForChat).mock.calls[1][1].messages.at(-1)?.content).toContain('需要 good')
  })
  it('bounds unknown tools and unavailable resource reads without publishing results', async () => {
    const ctx = context()
    vi.mocked(waitForChat).mockResolvedValue('{"action":"shell","command":"do not execute"}')
    await expect(runSkillAgent(ctx, { ...agent, maxSteps: 2 }, input)).rejects.toThrow(
      '2 步执行上限'
    )
    expect(waitForChat).toHaveBeenCalledTimes(2)
    expect(ctx.updateResult).not.toHaveBeenCalled()
  })
  it('rejects inherited resource names without leaking object prototypes into context', async () => {
    vi.mocked(waitForChat)
      .mockResolvedValueOnce(
        JSON.stringify({ action: 'read_resource', skillId: skill.id, name: 'toString' })
      )
      .mockResolvedValueOnce('{"action":"complete","output":"done"}')
    expect(await runSkillAgent(context(), agent, input)).toBe('done')
    expect(vi.mocked(waitForChat).mock.calls[1][1].messages.at(-1)?.content).toContain('资源不存在')
  })
  it('cancels before requesting or accepting output and propagates provider failures', async () => {
    const ctx = context()
    ctx.signal = { cancelled: true }
    await expect(runSkillAgent(ctx, agent, input)).rejects.toThrow('已取消')
    expect(waitForChat).not.toHaveBeenCalled()
    ctx.signal = { cancelled: false }
    vi.mocked(waitForChat).mockImplementationOnce(async () => {
      ctx.signal = { cancelled: true }
      return '{"action":"complete","output":"late"}'
    })
    await expect(runSkillAgent(ctx, agent, input)).rejects.toThrow('已取消')
    ctx.signal = { cancelled: false }
    vi.mocked(waitForChat).mockRejectedValueOnce(new Error('network error'))
    await expect(runSkillAgent(ctx, agent, input)).rejects.toThrow('network error')
  })
  it('AI processing repairs JSON before publishing only the validated formal output', async () => {
    const ctx = context()
    ctx.shape.props.config = JSON.stringify({ agent, modelKey: 'p::m', mode: 'json' })
    ctx.inputs = new Map([
      [
        'in-text',
        [
          {
            type: 'text',
            value: { kind: 'text', text: 'input' },
            source: { nodeId: 'u', portId: 'out-text', runId: 'r' },
            createdAt: 0
          }
        ]
      ]
    ])
    vi.mocked(waitForChat)
      .mockResolvedValueOnce('{"action":"complete","output":"   "}')
      .mockResolvedValueOnce('{"action":"complete","output":"bad JSON"}')
      .mockResolvedValueOnce(JSON.stringify({ action: 'complete', output: '{"ok":true}' }))
    expect(await aiProcessExecutor(ctx)).toMatchObject({
      status: 'done',
      artifactOutputPorts: ['out-json']
    })
    expect(ctx.updateResult).toHaveBeenCalledWith('{"kind":"json","data":{"ok":true}}')
    expect(ctx.updateResult).toHaveBeenCalledTimes(1)
  })
  it('chat stores the final answer in the active conversation, never protocol messages', async () => {
    const ctx = context()
    ctx.shape.props.text = serializeChat({
      ...parseChat('{}'),
      modelKey: 'p::m',
      messages: [{ role: 'user', content: 'input' }]
    })
    ctx.shape.props.config = JSON.stringify({ agent })
    vi.mocked(waitForChat).mockResolvedValueOnce('{"action":"complete","output":"final answer"}')
    expect(await chatExecutor(ctx)).toEqual({ status: 'done' })
    const saved = parseChat(vi.mocked(ctx.updateProps).mock.calls.at(-1)![0].text!)
    expect(saved.messages.at(-1)).toEqual({ role: 'assistant', content: 'final answer' })
    expect(JSON.parse(ctx.shape.props.config).agent).toEqual(agent)
  })
  it('preserves the image tool loop when content skills are selected', async () => {
    const ctx = context()
    ctx.providers[0].specId = 'toapis'
    ctx.providers[0].models.push({
      id: 'gpt-image-2-vip',
      name: 'image',
      modality: 'image',
      providerId: 'p'
    })
    ctx.shape.props.config = JSON.stringify({ agent })
    ctx.shape.props.text = serializeChat({
      ...parseChat('{}'),
      modelKey: 'p::m',
      imageSkill: { enabled: true, modelKey: 'p::gpt-image-2-vip', resolution: '1k' },
      messages: [{ role: 'user', content: 'draw' }]
    })
    vi.mocked(waitForChat).mockResolvedValueOnce('image reply')
    expect(await chatExecutor(ctx)).toEqual({ status: 'done' })
    expect(vi.mocked(waitForChat).mock.calls[0][1]).toMatchObject({
      toolStepLimit: 4,
      imageSkill: { modelId: 'gpt-image-2-vip' }
    })
    expect(vi.mocked(waitForChat).mock.calls[0][1].system).toContain(skill.instructions)
    expect(vi.mocked(waitForChat).mock.calls[0][1].system).toContain('PRIVATE-RESOURCE')
  })
  it('preserves explicit image generation and applies selected skill instructions', async () => {
    const ctx = context()
    ctx.providers[0].specId = 'toapis'
    ctx.providers[0].models.push({
      id: 'gpt-image-2-vip',
      name: 'image',
      modality: 'image',
      providerId: 'p'
    })
    ctx.shape.props.config = JSON.stringify({ agent })
    ctx.shape.props.text = serializeChat({
      ...parseChat('{}'),
      imageSkill: { enabled: true, modelKey: 'p::gpt-image-2-vip', resolution: '1k' },
      messages: [{ role: 'user', content: 'draw', intent: 'image' }]
    })
    ctx.gateway.imageGenerate = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'image', path: 'projects/p/media/image.png', mime: 'image/png' }
    })
    expect(await chatExecutor(ctx)).toEqual({ status: 'done' })
    expect(ctx.gateway.imageGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining(skill.instructions) })
    )
    expect(waitForChat).not.toHaveBeenCalled()
  })
})
