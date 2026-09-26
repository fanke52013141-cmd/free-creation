// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from 'tldraw'
import type { LibraryResourceDetail } from '../src/shared/library/types'
import { insertResource } from '../src/renderer/src/library/insertResource'

const state = vi.hoisted(() => ({ contractVersion: 3, refresh: vi.fn() }))
vi.mock('../src/renderer/src/nodes/registry', () => ({
  getNodeType: () => ({ contractVersion: state.contractVersion, defaultSize: { w: 340, h: 260 } })
}))
vi.mock('../src/renderer/src/stores/media', () => ({
  useMediaStore: { getState: () => ({ refresh: state.refresh }) }
}))
const detail: LibraryResourceDetail = {
  id: 'resource',
  title: '角色',
  description: '',
  formPreset: 'custom',
  latestRevisionId: 'v1',
  revisionNumber: 1,
  componentCount: 2,
  tags: [],
  collectionIds: [],
  updatedAt: 1,
  selectedRevisionId: 'v1',
  selectedRevisionNumber: 1,
  selectedTitle: '角色',
  selectedDescription: '',
  revisions: [],
  category: {
    id: 'category',
    version: 1,
    name: '角色档案',
    description: '',
    presentation: 'profile',
    blueprint: {
      protocolVersion: 1,
      layout: 'grid',
      slots: [
        {
          id: 'text',
          label: '描述',
          nodeType: 'text',
          contractVersion: 3,
          required: true,
          multiple: true,
          titleTemplate: '{resource} · {slot} {index}'
        }
      ]
    }
  },
  components: ['a', 'b'].map((id, index) => ({
    id,
    role: '描述',
    valueType: 'text',
    text: `文本${index}`,
    metadata: { librarySlotId: 'text' },
    order: index
  }))
}
function setup(): {
  editor: Editor
  fake: ReturnType<typeof fakeEditor>
  api: {
    materializeLibraryResource: ReturnType<typeof vi.fn>
    discardLibraryMaterialization: ReturnType<typeof vi.fn>
  }
} {
  const fake = fakeEditor()
  const api = {
    materializeLibraryResource: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        usageId: 'usage',
        componentAssets: [],
        assets: [],
        textComponents: detail.components
      }
    }),
    discardLibraryMaterialization: vi.fn().mockResolvedValue({ ok: true, data: true })
  }
  Object.assign(window, { api })
  return { editor: fake as unknown as Editor, fake, api }
}
function fakeEditor(): {
  isDisposed: boolean
  getCurrentPageShapes: () => []
  getShapePageBounds: () => undefined
  zoomToSelection: ReturnType<typeof vi.fn>
  getCurrentPageId: () => string
  getViewportPageBounds: () => { center: { x: number; y: number } }
  markHistoryStoppingPoint: ReturnType<typeof vi.fn>
  run: (fn: () => void) => void
  createShapes: ReturnType<typeof vi.fn>
  groupShapes: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  bailToMark: ReturnType<typeof vi.fn>
} {
  return {
    isDisposed: false,
    getCurrentPageShapes: () => [],
    getShapePageBounds: () => undefined,
    zoomToSelection: vi.fn(),
    getCurrentPageId: () => 'page:test',
    getViewportPageBounds: () => ({ center: { x: 0, y: 0 } }),
    markHistoryStoppingPoint: vi.fn().mockReturnValue('mark'),
    run: (fn) => fn(),
    createShapes: vi.fn(),
    groupShapes: vi.fn(),
    select: vi.fn(),
    bailToMark: vi.fn()
  }
}
beforeEach(() => {
  state.contractVersion = 3
  vi.clearAllMocks()
})
describe('whole resource insertion', () => {
  it('creates all selected nodes in one history segment and records per-slot provenance', async () => {
    const { editor, fake, api } = setup()
    await insertResource(editor, 'project', detail, ['a', 'b'])
    expect(fake.createShapes).toHaveBeenCalledOnce()
    const shapes = fake.createShapes.mock.calls[0][0]
    expect(shapes).toHaveLength(2)
    expect(shapes[0].props).toMatchObject({
      nodeType: 'text',
      text: '文本0',
      title: '角色 · 描述 1'
    })
    expect(shapes[0].meta.librarySource).toMatchObject({
      resourceId: 'resource',
      revisionId: 'v1',
      slotId: 'text',
      componentId: 'a'
    })
    expect(shapes[0].meta.librarySource.instanceId).toBe(shapes[1].meta.librarySource.instanceId)
    expect(fake.groupShapes).toHaveBeenCalledWith(shapes.map((shape: { id: string }) => shape.id))
    expect(api.materializeLibraryResource.mock.calls[0][0].nodeBindings).toHaveLength(2)
    expect(fake.markHistoryStoppingPoint.mock.calls.map((args) => args[0])).toEqual([
      'before-insert-resource',
      'insert-resource'
    ])
    expect(api.discardLibraryMaterialization).not.toHaveBeenCalled()
  })
  it('rolls back shapes and copied media when grouping fails', async () => {
    const { editor, fake, api } = setup()
    fake.groupShapes.mockImplementation(() => {
      throw new Error('group failed')
    })
    await expect(insertResource(editor, 'project', detail, ['a', 'b'])).rejects.toThrow(
      'group failed'
    )
    expect(fake.bailToMark).toHaveBeenCalledWith('mark')
    expect(api.discardLibraryMaterialization).toHaveBeenCalledWith({
      projectId: 'project',
      usageId: 'usage'
    })
  })
  it('rejects unavailable contracts before copying media', async () => {
    const { editor, fake, api } = setup()
    state.contractVersion = 99
    await expect(insertResource(editor, 'project', detail, ['a'])).rejects.toThrow('版本不兼容')
    expect(api.materializeLibraryResource).not.toHaveBeenCalled()
    expect(fake.createShapes).not.toHaveBeenCalled()
  })
  it('compensates a closed target canvas and never creates nodes there', async () => {
    const { editor, fake, api } = setup()
    api.materializeLibraryResource.mockImplementation(async () => {
      fake.isDisposed = true
      return { ok: true, data: { usageId: 'usage', componentAssets: [] } }
    })
    await expect(insertResource(editor, 'project', detail, ['a'])).rejects.toThrow('关闭或切换')
    expect(fake.createShapes).not.toHaveBeenCalled()
    expect(api.discardLibraryMaterialization).toHaveBeenCalledOnce()
  })
})
