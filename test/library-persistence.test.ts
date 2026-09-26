import {
  materializeResource,
  discardMaterialization
} from '../src/main/store/library-materialization.repo'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../src/main/store/db-migrations'
import type { LibraryCategory } from '../src/shared/library/blueprint'

const state = vi.hoisted(() => ({ root: '', database: null as unknown, transactionId: 0 }))
vi.mock('../src/main/store/db', () => ({
  getDataDir: () => state.root,
  getDb: () => {
    const db = state.database as DatabaseSync
    return {
      prepare: (sql: string) => db.prepare(sql),
      transaction: (fn: () => unknown) => () => {
        const savepoint = `test_${++state.transactionId}`
        db.exec(`SAVEPOINT ${savepoint}`)
        try {
          const result = fn()
          db.exec(`RELEASE ${savepoint}`)
          return result
        } catch (error) {
          db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
          throw error
        }
      }
    }
  }
}))
import {
  listCategories,
  saveCategory,
  getCategory
} from '../src/main/store/library-categories.repo'
import {
  createResource,
  captureProjectNodes,
  getResourceDetail,
  publishRevision,
  searchResources,
  createFolder,
  listFolders,
  renameFolder,
  exportResourcePackage,
  importResourcePackage
} from '../src/main/store/library.repo'

let db: DatabaseSync
let category: LibraryCategory
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'canvas-library-blueprints-'))
  db = new DatabaseSync(':memory:')
  state.database = db
  migrateDatabase({
    exec: (sql) => db.exec(sql),
    pragma: (statement, options) =>
      options?.simple
        ? Number((db.prepare(`PRAGMA ${statement}`).get() as { user_version: number }).user_version)
        : db.exec(`PRAGMA ${statement}`)
  })
  db.prepare(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', 'Project', 1, 1)"
  ).run()
  category = {
    id: 'custom-style',
    version: 1,
    name: '暖色品牌参考',
    description: '',
    presentation: 'profile',
    coverSlotId: 'reference',
    blueprint: {
      protocolVersion: 1,
      layout: 'grid',
      slots: [
        {
          id: 'reference',
          label: '参考图',
          nodeType: 'image',
          contractVersion: 3,
          required: true,
          multiple: true,
          titleTemplate: '{resource} · {slot} {index}'
        },
        {
          id: 'prompt',
          label: '提示词',
          nodeType: 'text',
          contractVersion: 3,
          required: false,
          multiple: false,
          titleTemplate: '{resource} · {slot}'
        }
      ]
    }
  }
  saveCategory({ category, baseVersion: 0 })
})
afterEach(() => {
  db?.close()
  rmSync(state.root, { recursive: true, force: true })
})
const resourceInput = () => ({
  title: '红眼树蛙',
  formPreset: 'custom' as const,
  category: { id: category.id, version: 1 },
  components: [
    {
      role: '正面',
      valueType: 'image' as const,
      data: new Uint8Array([1, 2, 3]),
      mime: 'image/png',
      fileName: 'frog.png',
      metadata: { librarySlotId: 'reference' }
    },
    {
      role: '描述',
      valueType: 'text' as const,
      text: '暖色胶片',
      metadata: { librarySlotId: 'prompt' }
    }
  ]
})

describe('library category persistence and transfer', () => {
  it('pins an immutable schema per resource revision and rejects conflicting category updates', () => {
    const original = createResource(resourceInput())
    const updated = saveCategory({
      category: { ...category, version: 2, name: '新版分类', presentation: 'list' },
      baseVersion: 1
    })
    expect(() => saveCategory({ category: updated, baseVersion: 1 })).toThrow('新版本')
    expect(getCategory(category.id, 1).name).toBe('暖色品牌参考')
    expect(getResourceDetail(original.id)?.category?.name).toBe('暖色品牌参考')
    const revision = publishRevision({
      ...resourceInput(),
      category: { id: category.id, version: 2 },
      resourceId: original.id,
      baseRevisionId: original.latestRevisionId
    })
    expect(revision.category?.name).toBe('新版分类')
    expect(getResourceDetail(original.id, original.latestRevisionId)?.category?.version).toBe(1)
    expect(searchResources({ categoryId: category.id }).items).toHaveLength(1)
    expect(listCategories().some((item) => item.name === '新版分类')).toBe(true)
  })
  it('does not publish a resource with incompatible or unmapped content', () => {
    const input = resourceInput()
    input.components[0].metadata.librarySlotId = 'prompt'
    expect(() => createResource(input)).toThrow('不兼容')
    expect(searchResources({}).items).toHaveLength(0)
  })
  it('supports multiple text nodes when a category defines separate content slots', () => {
    const multiTextCategory: LibraryCategory = {
      ...category,
      id: 'custom-character',
      name: '人物设定',
      blueprint: {
        ...category.blueprint,
        slots: [...category.blueprint.slots, {
          id: 'description',
          label: '人物描述',
          nodeType: 'text',
          contractVersion: 3,
          required: false,
          multiple: false,
          titleTemplate: '{resource} · {slot}'
        }]
      }
    }
    saveCategory({ category: multiTextCategory, baseVersion: 0 })
    const input = resourceInput()
    const resource = createResource({
      ...input,
      category: { id: multiTextCategory.id, version: 1 },
      components: [...input.components, {
        role: '人物描述',
        valueType: 'text',
        text: '修长的红眼树蛙格斗角色',
        metadata: { librarySlotId: 'description' }
      }]
    })
    expect(resource.components.filter((component) => component.valueType === 'text')).toHaveLength(2)
    expect(searchResources({ categoryId: multiTextCategory.id }).items).toHaveLength(1)
  })
  it('captures multiple canvas text nodes with explicit category-slot mappings', () => {
    const textCategory: LibraryCategory = {
      id: 'canvas-notes',
      version: 1,
      name: '创作笔记',
      description: '',
      presentation: 'list',
      blueprint: {
        protocolVersion: 1,
        layout: 'row',
        slots: ['summary', 'prompt'].map((id) => ({
          id,
          label: id === 'summary' ? '描述' : '提示词',
          nodeType: 'text' as const,
          contractVersion: 3,
          required: true,
          multiple: false,
          titleTemplate: '{resource} · {slot}'
        }))
      }
    }
    saveCategory({ category: textCategory, baseVersion: 0 })
    const resource = captureProjectNodes({
      projectId: 'project',
      title: '角色资料',
      category: { id: textCategory.id, version: 1 },
      nodes: [
        { nodeId: 'shape:summary', title: '人物描述', nodeType: 'text', text: '一个年轻的探险家', slotId: 'summary' },
        { nodeId: 'shape:prompt', title: '形象提示词', nodeType: 'text', text: '暖色电影光线', slotId: 'prompt' }
      ]
    })
    expect(resource.category?.id).toBe(textCategory.id)
    expect(resource.components.map((component) => component.metadata.librarySlotId)).toEqual(['summary', 'prompt'])
    expect(resource.components.map((component) => component.text)).toEqual(['一个年轻的探险家', '暖色电影光线'])
  })
  it('renames folders while keeping their children and rejects sibling name collisions', () => {
    const parent = createFolder({ name: '角色资产' })
    const child = createFolder({ name: '主角', parentId: parent.id })
    createFolder({ name: '场景资产' })
    expect(() => renameFolder({ folderId: parent.id, name: '场景资产' })).toThrow('重名')
    const renamed = renameFolder({ folderId: parent.id, name: '人物设定' })
    expect(renamed.name).toBe('人物设定')
    expect(listFolders().find((item) => item.id === child.id)).toMatchObject({
      name: '主角',
      parentId: parent.id
    })
  })
  it('copies selected files, records node ids, and compensates a failed canvas insertion', async () => {
    const resource = createResource(resourceInput())
    const ids = resource.components.map((component) => component.id)
    const materialized = await materializeResource({
      projectId: 'project',
      resourceId: resource.id,
      revisionId: resource.latestRevisionId,
      componentIds: ids,
      nodeBindings: ids.map((componentId, index) => ({ componentId, nodeId: `shape:node${index}` }))
    })
    expect(materialized.componentAssets[0].componentId).toBe(ids[0])
    expect(materialized.textComponents[0].text).toBe('暖色胶片')
    const path = join(state.root, materialized.assets[0].path)
    expect(existsSync(path)).toBe(true)
    const usage = db
      .prepare('SELECT materialized_node_ids_json FROM library_usages WHERE id = ?')
      .get(materialized.usageId) as { materialized_node_ids_json: string }
    expect(JSON.parse(usage.materialized_node_ids_json)).toEqual(['shape:node0', 'shape:node1'])
    expect(
      await discardMaterialization({ projectId: 'wrong-project', usageId: materialized.usageId })
    ).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(
      await discardMaterialization({ projectId: 'project', usageId: materialized.usageId })
    ).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(getResourceDetail(resource.id)?.components).toHaveLength(2)
  })
  it('rejects corrupted library media before creating a usage record', async () => {
    const resource = createResource(resourceInput())
    const image = resource.components[0]
    writeFileSync(join(state.root, image.blobPath!), Buffer.from([3, 2, 1]))
    await expect(
      materializeResource({
        projectId: 'project',
        resourceId: resource.id,
        revisionId: resource.latestRevisionId,
        componentIds: [image.id]
      })
    ).rejects.toThrow('哈希')
    expect(db.prepare('SELECT * FROM library_usages').all()).toHaveLength(0)
  })
  it('round-trips category snapshots, content slots and media without name collisions', () => {
    const resource = createResource(resourceInput())
    saveCategory({ category: { ...category, version: 2, name: '分类新版本' }, baseVersion: 1 })
    const path = join(state.root, 'test.canvaslib')
    exportResourcePackage(path, [resource.id])
    expect(readFileSync(path).length).toBeGreaterThan(0)
    expect(importResourcePackage(path)).toBe(1)
    const copy = searchResources({}).items.find((item) => item.id !== resource.id)!
    expect(copy.category?.id).not.toBe(category.id)
    expect(copy.category?.name).toBe(category.name)
    expect(copy.category?.blueprint).toEqual(category.blueprint)
    expect(getCategory(copy.category!.id, 2).name).toBe('分类新版本')
    expect(
      getResourceDetail(copy.id)?.components.map((component) => component.metadata.librarySlotId)
    ).toEqual(['reference', 'prompt'])
  })
  it('exports an unused category when backing up the whole library', () => {
    const path = join(state.root, 'empty-library.canvaslib')
    exportResourcePackage(path)
    expect(importResourcePackage(path)).toBe(0)
    expect(listCategories().filter((item) => item.name === category.name)).toHaveLength(2)
  })
})
