import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  projectsDir: '',
  projects: [] as unknown[][],
  media: [] as unknown[][],
  mediaSelect: [] as Array<{
    id: string
    kind: 'image' | 'video' | 'audio' | 'file'
    mime: string
    path: string
    size_bytes: number
    created_at: number
  }>,
  failTransaction: false,
  recipes: [] as import('../src/shared/artifact-recipe').ArtifactRecipe[],
  importedRecipes: [] as import('../src/shared/artifact-recipe').ArtifactRecipe[]
}))
vi.mock('../src/main/store/artifact-recipes.repo', () => ({
  listArtifactRecipes: () => state.recipes,
  saveArtifactRecipe: (input: import('../src/shared/artifact-recipe').ArtifactRecipe) =>
    state.importedRecipes.push(input)
}))

vi.mock('../src/main/store/db', (): { getProjectsDir: () => string; getDb: () => unknown } => {
  const statement = (
    sql: string
  ): { all: () => unknown[]; run: (...values: unknown[]) => void } => ({
    all: () => (sql.includes('artifact_recipes') ? [] : state.mediaSelect),
    run: (...values: unknown[]) => {
      if (sql.startsWith('INSERT INTO projects')) state.projects.push(values)
      else if (sql.startsWith('INSERT INTO media')) state.media.push(values)
      else if (sql.startsWith('DELETE FROM media')) state.media = []
      else if (sql.startsWith('DELETE FROM projects')) state.projects = []
    }
  })
  return {
    getProjectsDir: () => state.projectsDir,
    getDb: () => ({
      prepare: statement,
      transaction: (fn: () => void) => () => {
        // 事务体抛错即整体回滚：模拟磁盘满/写锁导致的 DB 提交失败（R-34 故障注入）。
        if (state.failTransaction) throw new Error('注入数据库故障')
        fn()
      }
    })
  }
})

import { importProject, exportProject } from '../src/main/store/transfer'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canvas-transfer-'))
  state.projectsDir = join(root, 'projects')
  state.projects = []
  state.media = []
  state.mediaSelect = []
  state.failTransaction = false
  state.recipes = []
  state.importedRecipes = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('importProject · 本地导入集成', () => {
  it('remaps exported recipe media/parameters while preserving original prompt text', () => {
    const zip = new AdmZip(resolve(process.cwd(), 'resources/demo/canvas-studio-demo.canvasbundle'))
    const entry = zip
      .getEntries()
      .find((item) => item.entryName.startsWith('media/') && !item.isDirectory)!
    const file = JSON.parse(zip.getEntry('project.json')!.getData().toString('utf-8'))
    const oldId = entry.entryName.slice(6).split('.')[0]
    const record = {
      projectId: file.meta.id,
      mediaId: oldId,
      runId: 'run:old',
      producerNodeId: 'shape:deleted',
      nodeType: 'image-gen',
      contractVersion: 3,
      fullPrompt: oldId,
      paramsJson: JSON.stringify({ referenceMediaIds: [oldId] }),
      inputMediaIds: [oldId, 'missing-media'],
      createdAt: 1
    }
    zip.addFile('recipes.json', Buffer.from(JSON.stringify([record])))
    const bundle = join(root, 'recipe.canvasbundle')
    zip.writeZip(bundle)
    const imported = importProject(bundle)
    expect(state.importedRecipes).toHaveLength(1)
    const recipe = state.importedRecipes[0]
    expect(recipe.projectId).toBe(imported.id)
    expect(recipe.mediaId).not.toBe(oldId)
    expect(recipe.inputMediaIds).toEqual([recipe.mediaId])
    expect(recipe.missingInputMediaIds).toEqual(['missing-media'])
    expect(JSON.parse(recipe.paramsJson).referenceMediaIds).toEqual([recipe.mediaId])
    expect(recipe.fullPrompt).toBe(oldId)
  })
  it('固定演示包可作为独立新项目导入，且其中媒体引用会完整重映射', () => {
    const result = importProject(
      resolve(process.cwd(), 'resources/demo/canvas-studio-demo.canvasbundle')
    )
    const projectPath = join(state.projectsDir, result.id, 'project.json')
    const imported = JSON.parse(readFileSync(projectPath, 'utf-8'))
    const reference = imported.tldrawSnapshot.store['shape:demo-reference']
    const director = imported.tldrawSnapshot.store['shape:demo-director']

    expect(imported.nodes).toHaveLength(8)
    expect(imported.edges).toHaveLength(7)
    expect(reference.props.mediaId).not.toBe('demo-reference-image')
    expect(reference.props.mediaPath).toMatch(
      new RegExp(`^projects/${result.id}/media/[A-Za-z0-9_-]+\\.png$`)
    )
    expect(JSON.parse(director.props.config).shots[0].referenceMediaIds).toEqual([
      reference.props.mediaId
    ])
    expect(state.projects).toHaveLength(1)
    expect(state.media).toHaveLength(1)
  })

  it('重映射节点、tldraw 快照、运行结果与导演台媒体引用，并在提交后创建项目', () => {
    const sourceId = 'source-project'
    const oldId = 'old-image'
    const oldPath = `projects/${sourceId}/media/${oldId}.png`
    const zipPath = join(root, 'source.canvasbundle')
    const zip = new AdmZip()
    zip.addFile(
      'project.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          meta: { id: sourceId, name: '来源项目', createdAt: 1, updatedAt: 1, graphVersion: 4 },
          nodes: [{ content: { kind: 'media', mediaId: oldId } }],
          edges: [],
          groups: [],
          tldrawSnapshot: {
            store: {
              'shape:node': {
                props: { mediaId: oldId, mediaPath: oldPath },
                meta: {
                  nodeResult: {
                    frame: { mediaId: oldId, mediaPath: oldPath },
                    referenceMediaIds: [oldId]
                  }
                }
              }
            }
          }
        })
      )
    )
    zip.addFile('media/old-image.png', Buffer.from([137, 80, 78, 71]))
    zip.writeZip(zipPath)

    const result = importProject(zipPath)
    const projectPath = join(state.projectsDir, result.id, 'project.json')
    const imported = JSON.parse(readFileSync(projectPath, 'utf-8'))
    const mediaId = imported.nodes[0].content.mediaId
    const mediaPath = imported.tldrawSnapshot.store['shape:node'].props.mediaPath

    expect(result.graphVersion).toBe(0)
    expect(mediaId).not.toBe(oldId)
    expect(imported.tldrawSnapshot.store['shape:node'].props.mediaId).toBe(mediaId)
    expect(imported.tldrawSnapshot.store['shape:node'].meta.nodeResult.frame.mediaId).toBe(mediaId)
    expect(imported.tldrawSnapshot.store['shape:node'].meta.nodeResult.referenceMediaIds).toEqual([
      mediaId
    ])
    expect(mediaPath).toBe(`projects/${result.id}/media/${mediaId}.png`)
    expect(existsSync(join(state.projectsDir, result.id, 'media', `${mediaId}.png`))).toBe(true)
    expect(state.projects).toHaveLength(1)
    expect(state.media).toHaveLength(1)
    expect(existsSync(join(state.projectsDir, `${result.id}.importing`))).toBe(false)
  })

  it('项目版本不支持时不写入数据库或项目目录', () => {
    const zipPath = join(root, 'invalid.canvasbundle')
    const zip = new AdmZip()
    zip.addFile(
      'project.json',
      Buffer.from(
        JSON.stringify({
          version: 99,
          meta: { id: 'bad', name: '坏包', graphVersion: 0 },
          nodes: [],
          edges: [],
          groups: []
        })
      )
    )
    zip.writeZip(zipPath)

    expect(() => importProject(zipPath)).toThrow(/版本不兼容/)
    expect(state.projects).toHaveLength(0)
    expect(state.media).toHaveLength(0)
  })

  it('数据库提交失败时回滚目录：不留正式项目目录、不留 .importing 残留、无幽灵 DB 记录（R-34）', () => {
    const zipPath = join(root, 'source.canvasbundle')
    const zip = new AdmZip()
    zip.addFile(
      'project.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          meta: { id: 'src', name: '来源', createdAt: 1, updatedAt: 1, graphVersion: 0 },
          nodes: [],
          edges: [],
          groups: []
        })
      )
    )
    zip.addFile('media/a.png', Buffer.from([137, 80, 78, 71]))
    zip.writeZip(zipPath)
    state.failTransaction = true

    expect(() => importProject(zipPath)).toThrow('注入数据库故障')
    // projects 目录已整体回滚：无正式项目目录、无 staging 残留（reconcile 无需介入）。
    expect(readdirSync(state.projectsDir)).toHaveLength(0)
    expect(state.projects).toHaveLength(0)
    expect(state.media).toHaveLength(0)
  })
})

describe('exportProject · 缺失媒体计数（R-33）', () => {
  it('缺失媒体不打断导出，并按数量返回 missingMediaCount', () => {
    const projectId = 'export-project'
    mkdirSync(join(state.projectsDir, projectId, 'media'), { recursive: true })
    writeFileSync(join(state.projectsDir, projectId, 'media', 'exists.png'), Buffer.from([1]))
    writeFileSync(
      join(state.projectsDir, projectId, 'project.json'),
      JSON.stringify({
        version: 1,
        meta: { id: projectId, name: '导出', createdAt: 1, updatedAt: 1, graphVersion: 0 },
        nodes: [],
        edges: [],
        groups: []
      })
    )
    state.mediaSelect = [
      {
        id: 'exists',
        kind: 'image',
        mime: 'image/png',
        path: `projects/${projectId}/media/exists.png`,
        size_bytes: 1,
        created_at: 1
      },
      {
        id: 'gone',
        kind: 'image',
        mime: 'image/png',
        path: `projects/${projectId}/media/gone.png`,
        size_bytes: 1,
        created_at: 1
      }
    ]

    const dest = join(root, 'out.canvasbundle')
    const result = exportProject(projectId, dest)
    expect(result.path).toBe(dest)
    expect(result.missingMediaCount).toBe(1)
    expect(existsSync(dest)).toBe(true)
  })

  it('媒体齐全时 missingMediaCount 为 0', () => {
    const projectId = 'export-complete'
    mkdirSync(join(state.projectsDir, projectId, 'media'), { recursive: true })
    writeFileSync(join(state.projectsDir, projectId, 'media', 'full.png'), Buffer.from([1]))
    writeFileSync(
      join(state.projectsDir, projectId, 'project.json'),
      JSON.stringify({
        version: 1,
        meta: { id: projectId, name: '导出', createdAt: 1, updatedAt: 1, graphVersion: 0 },
        nodes: [],
        edges: [],
        groups: []
      })
    )
    state.mediaSelect = [
      {
        id: 'full',
        kind: 'image',
        mime: 'image/png',
        path: `projects/${projectId}/media/full.png`,
        size_bytes: 1,
        created_at: 1
      }
    ]

    expect(exportProject(projectId, join(root, 'ok.canvasbundle')).missingMediaCount).toBe(0)
  })
})
