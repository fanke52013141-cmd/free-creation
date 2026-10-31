import { existsSync, readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

vi.mock('../src/main/gateway/factory', () => ({
  GatewayError: class extends Error { constructor(public code: string, message: string) { super(message) } },
  requireProvider: () => ({ id: 'dream', specId: 'dreamina', baseURL: '' }),
  createImageModel: vi.fn()
}))
vi.mock('../src/main/gateway/dreamina-cli', () => ({
  dreaminaMediaPath: vi.fn(),
  generateImageWithDreamina: vi.fn()
}))
vi.mock('../src/main/store/media.repo', () => ({
  readMediaBuffer: vi.fn(),
  saveBufferAsset: vi.fn(async () => ({ id: 'saved', path: 'asset.png', mime: 'image/png' }))
}))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { generateImageWithDreamina } from '../src/main/gateway/dreamina-cli'
import { generateImageEditToAsset } from '../src/main/gateway/image'
import { GatewayError } from '../src/main/gateway/factory'

it('即梦 P 图将原图和标注作为本地参考提交，并清理临时文件', async () => {
  const buffers = [Buffer.from([0xff, 0xd8, 1, 2]), Buffer.from([137, 80, 78, 71, 3])]
  let paths: string[] = []
  vi.mocked(generateImageWithDreamina).mockImplementationOnce(async (input) => {
    paths = input.referencePaths
    expect(paths).toHaveLength(2)
    expect(paths[0]).toMatch(/\.jpg$/)
    expect(paths[1]).toMatch(/\.png$/)
    expect(paths.map((path) => readFileSync(path))).toEqual(buffers)
    return 'data:image/png;base64,iVBORw0KGgo='
  })
  const result = await generateImageEditToAsset({
    projectId: 'p', sourceMediaId: 'source', providerId: 'dream', modelId: '5.0',
    prompt: '把帽子改为蓝色', size: 'auto', config: { resolution: '2k' }
  } as never, buffers)
  expect(result.id).toBe('saved')
  expect(paths.every((path) => !existsSync(path))).toBe(true)
})

it('即梦 CLI 失败时清理临时文件并隐藏本地路径', async () => {
  let paths: string[] = []
  vi.mocked(generateImageWithDreamina).mockImplementationOnce(async (input) => {
    paths = input.referencePaths
    throw new GatewayError('DREAMINA_CLI_FAILED', `failed: ${paths[0]}`)
  })
  await expect(generateImageEditToAsset({
    projectId: 'p', sourceMediaId: 'source', providerId: 'dream', modelId: '5.0',
    prompt: '修改图片', size: 'auto', config: { resolution: '2k' }
  } as never, [Buffer.from([137, 80, 78, 71])])).rejects.toThrow('即梦图片修改失败，请检查参考图片和模型后重试。')
  expect(paths.every((path) => !existsSync(path))).toBe(true)
})
