// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IMAGE_EDIT_CONFIG,
  parseImageEditConfig,
  validateImageEditConfig
} from '@shared/image-edit'
import {
  imageEditExecutor,
  imageEditResultName,
  annotationInstructionLines
} from '@renderer/engine/executors/imageEdit'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'

afterEach(() => vi.restoreAllMocks())

describe('P图标注文字必须进入提示词（cowart 式「图形定位 + 文字语义」）', () => {
  it('带文字的标注被编号，并同时给出标注类型与颜色角色', () => {
    expect(
      annotationInstructionLines([
        { id: 'a1', type: 'arrow', color: 'red', points: [], text: '把袖口改成深蓝色' },
        { id: 'a2', type: 'rect', color: 'yellow', points: [], text: '这块花纹保留' },
        { id: 'a3', type: 'brush', color: 'blue', points: [] }
      ])
    ).toEqual([
      '标注 1（箭头·需要修改）：把袖口改成深蓝色',
      '标注 2（矩形框选·需要保留或重点注意）：这块花纹保留'
    ])
  })

  it('没有任何带文字的标注时返回空数组，不污染提示词', () => {
    expect(
      annotationInstructionLines([{ id: 'a1', type: 'arrow', color: 'red', points: [] }])
    ).toEqual([])
  })
})

describe('P图产物命名（用户 2026-09-18 拍板）', () => {
  it('第一次为「（改）原图名」，之后依次为「（改1）」「（改2）」', () => {
    expect(imageEditResultName('ChatGPT Image', 0)).toBe('（改）ChatGPT Image')
    expect(imageEditResultName('ChatGPT Image', 1)).toBe('（改1）ChatGPT Image')
    expect(imageEditResultName('ChatGPT Image', 2)).toBe('（改2）ChatGPT Image')
  })

  it('来源没有显示名时回退到「图片」', () => {
    expect(imageEditResultName('   ', 0)).toBe('（改）图片')
  })
})

describe('图片修改配置', () => {
  it('限制坐标、数量与类型，损坏配置回到默认值', () => {
    expect(parseImageEditConfig('not-json')).toEqual(DEFAULT_IMAGE_EDIT_CONFIG)
    const config = parseImageEditConfig(
      JSON.stringify({
        annotations: [
          {
            type: 'rect',
            points: [
              { x: -1, y: 2 },
              { x: 2, y: -2 }
            ]
          }
        ]
      })
    )
    expect(config.annotations[0].points).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 0 }
    ])
    expect(parseImageEditConfig(JSON.stringify({ size: 'not-a-size' })).size).toBe('auto')
  })

  it('没有说明或标注时拒绝执行', () => {
    expect(validateImageEditConfig(DEFAULT_IMAGE_EDIT_CONFIG)).toContain('修改说明')
    expect(
      validateImageEditConfig({
        ...DEFAULT_IMAGE_EDIT_CONFIG,
        annotations: [{ id: 'a', type: 'rect', color: 'red', points: [{ x: 0, y: 0 }] }]
      })
    ).toContain('不完整')
  })

  it('启用遮罩时必须提供轨迹', () => {
    expect(
      validateImageEditConfig({
        ...DEFAULT_IMAGE_EDIT_CONFIG,
        instruction: '局部重绘',
        mask: { enabled: true, strokes: [], brushSize: 0.08, invert: false }
      })
    ).toContain('至少绘制一个遮罩区域')
  })
})

describe('imageEditExecutor', () => {
  it('只消费 in-image 与 in-text 并记录图片结果', async () => {
    const update: Record<string, unknown> = {}
    const artifacts: unknown[] = []
    const imageEdit = vi.fn(async () => ({
      ok: true as const,
      data: { id: 'edited-1', path: '/edited.png', mime: 'image/png', name: '修改图片' }
    }))
    globalThis.window = { api: { gateway: { imageEdit } } } as unknown as Window & typeof globalThis
    const shape = {
      id: 'shape:edit',
      type: 'node-card',
      props: {
        config: JSON.stringify({
          modelKey: 'p1::img-1',
          instruction: '移除背景',
          annotations: [
            {
              id: 'a',
              type: 'arrow',
              color: 'red',
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 }
              ]
            }
          ]
        }),
        mediaPath: '',
        mediaId: '',
        mediaMime: ''
      },
      meta: {}
    } as unknown as NodeCardShape
    const ctx = {
      shape,
      node: { id: 'shape:edit', type: 'image-edit', contractVersion: 1 },
      projectId: 'project-a',
      providers: [
        {
          id: 'p1',
          name: 'p',
          specId: 'openai',
          baseURL: '',
          models: [{ id: 'img-1', modality: 'image' }],
          createdAt: 0,
          hasApiKey: true
        }
      ],
      inputs: new Map([
        [
          'in-image',
          [
            {
              type: 'image',
              value: {
                kind: 'image',
                mediaId: 'source',
                mediaPath: '/source.png',
                mime: 'image/png'
              },
              source: { nodeId: 'source', portId: 'out-image', runId: 'r' },
              createdAt: 0
            }
          ]
        ],
        [
          'in-text',
          [
            {
              type: 'text',
              value: { kind: 'text', text: '保留主体' },
              source: { nodeId: 'text', portId: 'out-text', runId: 'r' },
              createdAt: 0
            }
          ]
        ]
      ]),
      signal: { cancelled: false },
      gateway: { imageEdit },
      updateProps: (patch: Record<string, unknown>) => Object.assign(update, patch),
      updateResult: () => undefined,
      emitArtifact: (artifact: unknown) => artifacts.push(artifact)
    } as unknown as NodeExecutionContext
    await expect(imageEditExecutor(ctx)).resolves.toEqual({ status: 'done' })
    expect(imageEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMediaId: 'source',
        prompt: expect.stringContaining('保留主体')
      })
    )
    expect(update).toEqual({})
    expect(artifacts).toContainEqual(
      expect.objectContaining({
        kind: 'image',
        mediaId: 'edited-1',
        mime: 'image/png',
        // 无来源显示名时回退到「图片」，前缀仍是「（改）」。
        title: '（改）图片'
      })
    )
  })

  it('供应商失败时不改写已有输出或结果集合', async () => {
    const updateProps = vi.fn()
    const updateResult = vi.fn()
    const imageEdit = vi.fn(async () => ({
      ok: false as const,
      error: { message: '供应商不支持当前图片修改请求' }
    }))
    globalThis.window = { api: { gateway: { imageEdit } } } as unknown as Window & typeof globalThis
    const ctx = {
      shape: {
        id: 'shape:edit',
        type: 'node-card',
        props: {
          config: JSON.stringify({ modelKey: 'p1::img-1', instruction: '修改背景' }),
          mediaId: 'previous-result',
          mediaPath: '/previous.png',
          mediaMime: 'image/png'
        },
        meta: { nodeResult: '{"kind":"media-source","results":[]}' }
      } as unknown as NodeCardShape,
      node: { id: 'shape:edit', type: 'image-edit', contractVersion: 1 },
      projectId: 'project-a',
      providers: [
        {
          id: 'p1',
          name: 'p',
          specId: 'openai',
          baseURL: '',
          models: [{ id: 'img-1', modality: 'image' }],
          createdAt: 0,
          hasApiKey: true
        }
      ],
      inputs: new Map([
        [
          'in-image',
          [
            {
              type: 'image',
              value: {
                kind: 'image',
                mediaId: 'source',
                mediaPath: '/source.png',
                mime: 'image/png'
              },
              source: { nodeId: 'source', portId: 'out-image', runId: 'r' },
              createdAt: 0
            }
          ]
        ]
      ]),
      signal: { cancelled: false },
      gateway: { imageEdit },
      updateProps,
      updateResult
    } as unknown as NodeExecutionContext

    await expect(imageEditExecutor(ctx)).resolves.toEqual({
      status: 'failed',
      reason: '供应商不支持当前图片修改请求'
    })
    expect(updateProps).not.toHaveBeenCalled()
    expect(updateResult).not.toHaveBeenCalled()
  })
})
