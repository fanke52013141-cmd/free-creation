import { describe, expect, it, vi } from 'vitest'
import { chatImageParameters, parseChatImageSkill } from '../src/shared/chat-image-skill'
import { parseChat, prepareChatRegeneration, serializeChat } from '../src/shared/engine/chat-data'
import { remapMediaReferences } from '../src/shared/media-reference-remap'
import { chatExecutor } from '../src/shared/engine/executors/chat'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'
import type { ProviderSummary } from '../src/shared/types'
import type { GatewayEvent } from '../src/shared/contracts'

const provider: ProviderSummary = {
  id: 'images',
  name: '图片',
  specId: 'toapis',
  baseURL: 'https://example.invalid',
  hasApiKey: true,
  createdAt: 0,
  models: [{ id: 'gpt-image-2-vip', modality: 'image', operations: ['image.generate'] }]
}
const image = {
  id: 'image-1',
  path: 'projects/project-1/media/image-1.png',
  name: '生成图片',
  mime: 'image/png'
}

function fixture(settings: Record<string, unknown> = {}) {
  const patches: { text?: string } = {}
  const gateway = {
    imageGenerate: vi.fn(async () => ({ ok: true, data: image })),
    chatStart: vi.fn()
  }
  const data = {
    messages: [{ role: 'user', content: '画一张山水画', intent: 'image' }],
    imageSkill: {
      enabled: true,
      modelKey: 'images::gpt-image-2-vip',
      resolution: '1k',
      ...settings
    }
  }
  const ctx = {
    shape: { props: { text: JSON.stringify(data) } },
    inputs: new Map(),
    providers: [provider],
    projectId: 'project-1',
    signal: { cancelled: false },
    gateway,
    trace: vi.fn(),
    updateProps: (patch: { text?: string }) => Object.assign(patches, patch)
  } as unknown as NodeExecutionContext
  return { ctx, gateway, patches }
}

describe('对话生图技能', () => {
  it('默认1K，4K仍保持同一最低质量策略，不接受其他档位', () => {
    expect(parseChatImageSkill(undefined)).toEqual({
      enabled: true,
      modelKey: '',
      resolution: '1k'
    })
    expect(chatImageParameters('toapis', 'gpt-image-2-vip', '4k')).toEqual({
      size: '1:1',
      resolution: '4k'
    })
    expect(parseChatImageSkill({ resolution: '8k' }).resolution).toBe('1k')
    expect(() => chatImageParameters('openai', 'gpt-image-1', '4k')).toThrow('不支持 4K')
    expect(() => chatImageParameters('toapis', 'gpt-image-2', '1k')).toThrow('最低质量')
  })
  it('显式生图无需文本模型，调用一次并保存真实图片附件', async () => {
    const { ctx, gateway, patches } = fixture()
    expect(await chatExecutor(ctx)).toEqual({ status: 'done' })
    expect(gateway.chatStart).not.toHaveBeenCalled()
    expect(gateway.imageGenerate).toHaveBeenCalledOnce()
    expect(gateway.imageGenerate.mock.calls[0][0]).toMatchObject({
      projectId: 'project-1',
      resolution: '1k',
      prompt: '画一张山水画'
    })
    expect(parseChat(patches.text!).messages.at(-1)?.images?.[0].mediaId).toBe('image-1')
  })
  it('4K只影响分辨率；失败不自动重发', async () => {
    const { ctx, gateway } = fixture({ resolution: '4k' })
    gateway.imageGenerate.mockResolvedValueOnce({
      ok: false,
      error: { message: '供应商暂不可用' }
    } as never)
    expect(await chatExecutor(ctx)).toEqual({ status: 'failed', reason: '供应商暂不可用' })
    expect(gateway.imageGenerate).toHaveBeenCalledOnce()
    expect(gateway.imageGenerate.mock.calls[0][0]).toMatchObject({ resolution: '4k' })
  })
  it('禁用技能与运行前取消不产生收费调用', async () => {
    const disabled = fixture({ enabled: false })
    expect((await chatExecutor(disabled.ctx)).status).toBe('skipped')
    expect(disabled.gateway.imageGenerate).not.toHaveBeenCalled()
    const cancelled = fixture()
    cancelled.ctx.signal = { cancelled: true }
    expect((await chatExecutor(cancelled.ctx)).status).toBe('skipped')
    expect(cancelled.gateway.imageGenerate).not.toHaveBeenCalled()
  })
  it('图片成功后发生本地取消仍保留已完成附件', async () => {
    const { ctx, patches, gateway } = fixture()
    gateway.imageGenerate.mockImplementationOnce(async () => {
      ctx.signal = { cancelled: true }
      return { ok: true, data: image }
    })
    expect((await chatExecutor(ctx)).status).toBe('skipped')
    expect(parseChat(patches.text!).messages.at(-1)?.images).toHaveLength(1)
  })
  it('保存恢复、重生成及项目导入精确重映射图片引用', async () => {
    const { ctx, patches } = fixture()
    await chatExecutor(ctx)
    const data = parseChat(patches.text!)
    expect(prepareChatRegeneration(data, 1)?.messages.at(-1)?.intent).toBe('image')
    const imported = remapMediaReferences(serializeChat(data), {
      ids: new Map([['image-1', 'new-image']]),
      paths: new Map([[image.path, 'projects/new-project/media/new-image.png']])
    })
    expect(parseChat(imported).messages.at(-1)?.images?.[0]).toMatchObject({
      mediaId: 'new-image',
      mediaPath: 'projects/new-project/media/new-image.png'
    })
    expect(
      parseChat(
        JSON.stringify({
          messages: [
            null,
            {
              role: 'assistant',
              content: '',
              images: [
                { mediaId: 'bad', mediaPath: 'https://evil.invalid/a.png', mime: 'image/png' }
              ]
            }
          ]
        })
      ).messages[0].images
    ).toEqual([])
  })
  it('自动工具附件到达后即保存，后续流失败不会抹掉图片', async () => {
    const { ctx, patches } = fixture()
    ctx.shape.props.text = JSON.stringify({
      modelKey: 'text::model',
      messages: [{ role: 'user', content: '画一张山水画' }]
    })
    ctx.providers = [
      ...ctx.providers,
      { ...provider, id: 'text', models: [{ id: 'model', modality: 'text' }] }
    ]
    let listener: (event: GatewayEvent) => void = () => undefined
    Object.assign(ctx.gateway, {
      onEvent: (next: typeof listener) => {
        listener = next
        return () => undefined
      },
      chatStart: async () => {
        setTimeout(() => {
          listener({
            kind: 'chat-image',
            taskId: 'task-1',
            image: { mediaId: image.id, mediaPath: image.path, name: image.name, mime: image.mime }
          })
          listener({ kind: 'chat-error', taskId: 'task-1', error: '回复流中断' })
        }, 0)
        return { ok: true, data: { taskId: 'task-1' } }
      }
    })
    await expect(chatExecutor(ctx)).rejects.toThrow('回复流中断')
    expect(parseChat(patches.text!).messages.at(-1)?.images?.[0].mediaId).toBe(image.id)
  })
})
