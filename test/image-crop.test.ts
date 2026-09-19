// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IMAGE_CROP_CONFIG,
  parseImageCropConfig,
  validateImageCropConfig
} from '@shared/image-crop'
import { imageCropExecutor, imageCropResultName } from '@renderer/engine/executors/imageCrop'
import { parseMediaResultCollection } from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import type { GatewayClient } from '@shared/engine/gateway-client'

afterEach(() => vi.restoreAllMocks())

describe('图片裁剪配置', () => {
  it('把损坏或越界配置收敛为安全的归一化数据', () => {
    expect(parseImageCropConfig('not-json')).toEqual(DEFAULT_IMAGE_CROP_CONFIG)
    const config = parseImageCropConfig(
      JSON.stringify({ mode: 'rect', rect: { x: -1, y: 0.9, width: 2, height: 2 } })
    )
    expect(config.rect).toEqual({ x: 0, y: 0.9, width: 1, height: 0.1 })
    expect(config.aspectRatio).toBe('free')
  })

  it('只接受声明过的固定裁剪比例', () => {
    expect(parseImageCropConfig(JSON.stringify({ aspectRatio: '16:9' })).aspectRatio).toBe('16:9')
    expect(parseImageCropConfig(JSON.stringify({ aspectRatio: '999:1' })).aspectRatio).toBe('free')
  })

  it('拒绝交叉或退化的四角区域', () => {
    const crossed = parseImageCropConfig(
      JSON.stringify({
        mode: 'quad',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.1 }
        ]
      })
    )
    expect(validateImageCropConfig(crossed)).toMatch(/非交叉/)
    expect(validateImageCropConfig(DEFAULT_IMAGE_CROP_CONFIG)).toBeNull()
  })
})

describe('imageCropExecutor', () => {
  let currentGateway: Record<string, unknown> = {}

  function context(sourceName?: string): {
    ctx: NodeExecutionContext
    props: Record<string, unknown>
    result: { value: string | null }
    artifacts: unknown[]
  } {
    const props: Record<string, unknown> = {}
    const result = { value: null as string | null }
    const artifacts: unknown[] = []
    const shape = {
      id: 'shape:crop',
      type: 'node-card',
      x: 0,
      y: 0,
      rotation: 0,
      index: 'a1',
      isLocked: false,
      props: {
        w: 340,
        h: 260,
        nodeType: 'image-crop',
        title: '裁剪',
        config: JSON.stringify(DEFAULT_IMAGE_CROP_CONFIG),
        text: '',
        mediaId: '',
        mediaPath: '',
        mediaMime: '',
        exec: 'idle'
      },
      meta: {}
    } as unknown as NodeCardShape
    return {
      props,
      result,
      ctx: {
        node: {
          id: 'shape:crop',
          type: 'image-crop',
          contractVersion: 1,
          title: '裁剪',
          x: 0,
          y: 0,
          w: 340,
          h: 260,
          ports: [],
          params: {},
          content: { kind: 'empty' },
          exec: { status: 'idle' },
          meta: { source: 'derive', createdAt: 0 }
        },
        shape,
        inputs: new Map([
          [
            'in-image',
            [
              {
                type: 'image',
                value: {
                  kind: 'image',
                  mediaId: 'source',
                  mediaPath: 'projects/p/media/source.jpg',
                  mime: 'image/jpeg',
                  ...(sourceName ? { name: sourceName } : {})
                },
                schema: undefined,
                source: { nodeId: 'source-node', portId: 'out-image', runId: 'run-source' },
                createdAt: 0
              }
            ]
          ]
        ]),
        projectId: 'project-a',
        runId: 'run-crop',
        providers: [],
        signal: { cancelled: false },
        gateway: currentGateway as unknown as GatewayClient,
        updateProps: (next) => Object.assign(props, next),
        updateResult: (value) => {
          result.value = value
        },
        emitArtifact: (artifact) => artifacts.push(artifact)
      },
      artifacts
    }
  }

  it('只使用 in-image 的真实资产并记录新结果', async () => {
    const cropImage = vi.fn(async () => ({
      ok: true as const,
      data: {
        id: 'crop-1',
        path: 'projects/project-a/media/crop-1.png',
        mime: 'image/png',
        name: '裁剪图片'
      }
    }))
    currentGateway = { cropImage }
    const item = context()
    await expect(imageCropExecutor(item.ctx)).resolves.toEqual({ status: 'done' })
    expect(cropImage).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-a', sourceMediaId: 'source' })
    )
    expect(item.props).toEqual({})
    expect(item.artifacts).toContainEqual(
      expect.objectContaining({ kind: 'image', mediaId: 'crop-1', mime: 'image/png' })
    )
    expect(parseMediaResultCollection(item.result.value ?? '')?.results[0]).toMatchObject({
      mediaId: 'crop-1',
      runId: 'run-crop'
    })
  })

  it('没有真实连线输入时明确跳过', async () => {
    const item = context()
    item.ctx.inputs = new Map()
    await expect(imageCropExecutor(item.ctx)).resolves.toEqual({
      status: 'skipped',
      reason: '请连接一张图片到“原图”输入'
    })
  })

  it('产物标题与来源摘要写原图名，不写 mediaId 和内部枚举', async () => {
    currentGateway = {
      cropImage: vi.fn(async () => ({
        ok: true as const,
        data: {
          id: 'crop-1',
          path: 'projects/project-a/media/crop-1.png',
          mime: 'image/png',
          name: '裁剪图片'
        }
      }))
    }
    const item = context('海报原图')
    await imageCropExecutor(item.ctx)
    expect(item.artifacts[0]).toMatchObject({ title: '（裁）海报原图' })
    const collection = parseMediaResultCollection(item.result.value ?? '')
    expect(collection?.prompt).toBe('裁剪 海报原图 · 矩形')
  })

  it('来源没有标题时回退到资产类型词', async () => {
    currentGateway = {
      cropImage: vi.fn(async () => ({
        ok: true as const,
        data: { id: 'crop-1', path: 'p.png', mime: 'image/png', name: '裁剪图片' }
      }))
    }
    const item = context('   ')
    await imageCropExecutor(item.ctx)
    expect(item.artifacts[0]).toMatchObject({ title: '（裁）图片' })
    expect(parseMediaResultCollection(item.result.value ?? '')?.prompt).toBe('裁剪 图片 · 矩形')
  })

  it('同一节点多次裁剪按已有结果数编号，与 P 图命名规则同构', () => {
    expect(imageCropResultName('海报原图', 0)).toBe('（裁）海报原图')
    expect(imageCropResultName('海报原图', 1)).toBe('（裁1）海报原图')
    expect(imageCropResultName('', 0)).toBe('（裁）图片')
  })
})
