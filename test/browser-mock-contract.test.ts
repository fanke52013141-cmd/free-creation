// @vitest-environment jsdom
// F16/T01：浏览器演示接口契约。此前 browserMock 以整体强转掩盖缺口，
// 调用缺失成员（如 models.resolveBinding）直接 undefined 崩溃；本套测试
// 固化「缺什么补什么」后的行为：可用的走演示 fixture，不可用的返回可读信封。
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installBrowserMock } from '@renderer/dev/browserMock'

beforeAll(() => {
  installBrowserMock()
})

afterEach(() => {
  window.sessionStorage.removeItem('canvas-studio.browser-demo.modelScenario')
})

describe('browserMock · models 命名空间（F16 核心）', () => {
  it('resolveBinding 在 ok 场景返回演示绑定（此前是 undefined 崩溃）', async () => {
    const res = await window.api.models.resolveBinding({
      featureKey: 'image.generate',
      operation: 'image.generate'
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.featureKey).toBe('image.generate')
      expect(res.data.modelId).toBe('gpt-image-2')
      expect(res.data.operation).toBe('image.generate')
      expect(typeof res.data.modelKey).toBe('string')
    }
  })

  it('noBinding 场景返回可读错误信封而非 undefined 崩溃', async () => {
    window.sessionStorage.setItem('canvas-studio.browser-demo.modelScenario', 'noBinding')
    const res = await window.api.models.resolveBinding({
      featureKey: 'image.generate',
      operation: 'image.generate'
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('DEMO_MODEL_UNBOUND')
      expect(res.error.message).toContain('演示模式')
    }
  })

  it('未演示覆盖的功能返回未绑定错误，不悬挂也不崩溃', async () => {
    const res = await window.api.models.resolveBinding({
      featureKey: 'voice.design',
      operation: 'voice.design'
    })
    expect(res.ok).toBe(false)
  })

  it('listConnections / listDefinitions / listBindings 返回合法 fixture', async () => {
    const conns = await window.api.models.listConnections()
    expect(conns.ok).toBe(true)
    if (conns.ok) {
      expect(conns.data.length).toBeGreaterThan(0)
      // 契约 Timestamp 是 ISO 字符串
      expect(typeof conns.data[0].createdAt).toBe('string')
    }
    const defs = await window.api.models.listDefinitions()
    expect(defs.ok).toBe(true)
    if (defs.ok) {
      expect(defs.data.some((d) => d.modelId === 'gpt-image-2')).toBe(true)
    }
    const binds = await window.api.models.listBindings()
    expect(binds.ok).toBe(true)
    if (binds.ok) {
      expect(binds.data.some((b) => b.featureKey === 'image.generate')).toBe(true)
    }
  })

  it('变更类操作返回 DEMO_NOT_IMPLEMENTED 信封（可被正常错误分支处理）', async () => {
    const res = await window.api.models.saveConnection({
      id: 'x',
      name: 'x',
      protocol: 'openai-compatible',
      baseUrl: 'https://x.example.com/v1',
      auth: { type: 'none' }
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('DEMO_NOT_IMPLEMENTED')
  })
})

describe('browserMock · 补齐的桩成员', () => {
  it('资源库目录查询返回空态；变更返回 DEMO_NOT_IMPLEMENTED', async () => {
    const folders = await window.api.listLibraryFolders()
    expect(folders.ok).toBe(true)
    if (folders.ok) expect(folders.data).toEqual([])

    const created = await window.api.createLibraryFolder({ name: '演示目录' })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error.code).toBe('DEMO_NOT_IMPLEMENTED')
  })

  it('画布结构导入导出返回 DEMO_NOT_IMPLEMENTED 而非 undefined 崩溃', async () => {
    const exported = await window.api.exportCanvasStructure({ projectId: 'demo' })
    expect(exported.ok).toBe(false)
    const imported = await window.api.importCanvasStructure({ projectId: 'demo' })
    expect(imported.ok).toBe(false)
  })

  it('gateway 补齐的三个入口：两个供应商列表可用，导入导出为可读错误', async () => {
    const list = await window.api.gateway.listExecutableProviders()
    expect(list.ok).toBe(true)
    const exp = await window.api.gateway.exportProviders({ password: '' })
    expect(exp.ok).toBe(false)
    const imp = await window.api.gateway.importProviders({ password: '' })
    expect(imp.ok).toBe(false)
  })
})

describe('browserMock · 调色板偏好（F16 抓出的错误方法名回归）', () => {
  it('getPalettePreferences 存在且可用（旧 mock 误写为 loadPalettePreferences 被强转掩盖）', async () => {
    const res = await window.api.workspace.getPalettePreferences()
    expect(res.ok).toBe(true)
  })
})
