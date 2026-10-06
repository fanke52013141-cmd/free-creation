import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createChatImageTool,
  loadImageSkillInstructions
} from '../src/main/gateway/chat-image-skill'
import { generateImageToAsset } from '../src/main/gateway/image'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))
vi.mock('../src/main/gateway/image', () => ({ generateImageToAsset: vi.fn() }))
vi.mock('../src/main/gateway/factory', () => ({
  GatewayError: class extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message)
    }
  },
  requireProvider: () => ({
    id: 'images',
    specId: 'toapis',
    models: [{ id: 'gpt-image-2-vip', modality: 'image', operations: ['image.generate'] }]
  })
}))

describe('受控生图工具和技能说明', () => {
  const events: DiagnosticsEventInput[] = []
  beforeEach(() => {
    vi.clearAllMocks()
    events.length = 0
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    vi.mocked(generateImageToAsset).mockResolvedValue({
      id: 'image-1',
      projectId: 'project-1',
      path: 'projects/project-1/media/image-1.png',
      name: '图片',
      mime: 'image/png',
      type: 'image',
      createdAt: 1
    } as never)
  })
  const target = {
    projectId: 'project-1',
    providerId: 'images',
    modelId: 'gpt-image-2-vip',
    resolution: '4k' as const
  }
  const options = { toolCallId: 'call-1', messages: [] }
  it('从已打包的SKILL.md读取规则，真实附件通过回调返回，不返回伪造URL', async () => {
    expect(loadImageSkillInstructions()).toContain('质量始终为最低档 low')
    const onImage = vi.fn()
    const imageTool = createChatImageTool(
      target,
      { traceId: 'trace-1', spanId: 'parent-1' },
      new AbortController().signal,
      onImage
    )
    const result = await imageTool.execute!({ prompt: '私有创作内容' }, options)
    expect(result).toMatchObject({ generated: true, resolution: '4k', quality: 'low' })
    expect(generateImageToAsset).toHaveBeenCalledOnce()
    expect(onImage.mock.calls[0][0]).toMatchObject({ mediaId: 'image-1' })
    expect(JSON.stringify(events)).not.toContain('私有创作内容')
    expect(events.map((event) => event.event)).toContain('skill.execution.completed')
  })
  it('一次发送最多调用一次；失败也禁止自动重试', async () => {
    vi.mocked(generateImageToAsset).mockRejectedValueOnce(new Error('供应商失败：私有提示词'))
    const imageTool = createChatImageTool(
      target,
      { traceId: 'trace-1' },
      new AbortController().signal,
      vi.fn()
    )
    await expect(imageTool.execute!({ prompt: '私有提示词' }, options)).rejects.toThrow(
      '供应商失败'
    )
    await expect(imageTool.execute!({ prompt: '再次尝试' }, options)).rejects.toThrow('本轮已调用')
    expect(generateImageToAsset).toHaveBeenCalledOnce()
    expect(events.map((event) => event.event)).toContain('skill.execution.failed')
    expect(JSON.stringify(events)).not.toContain('私有提示词')
  })
  it('请求前取消不提交图片 API', async () => {
    const controller = new AbortController()
    controller.abort()
    const imageTool = createChatImageTool(target, undefined, controller.signal, vi.fn())
    await expect(imageTool.execute!({ prompt: '画图' }, options)).rejects.toThrow()
    expect(generateImageToAsset).not.toHaveBeenCalled()
  })
})
