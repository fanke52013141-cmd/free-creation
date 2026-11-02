// 工作台节点可见集迁移（2026-11-02 回归）：
// 旧项目里保存的 visibleNodeTypeIds 是创建时的节点快照，新版本节点不在其中；
// openProject 必须读盘即归一化，否则创建面板永远过滤掉新节点（真机表现：找不到轨道线）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject, createProject } from '../src/main/store/projects.repo'
import { WORKSPACE_NODE_SET_REVISION } from '../src/shared/workspace-profile'

let dataDir = ''
const envBefore = process.env.CANVAS_DATA_DIR

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'canvas-profile-migration-'))
  process.env.CANVAS_DATA_DIR = dataDir
  mkdirSync(join(dataDir, 'projects'), { recursive: true })
})

afterEach(() => {
  if (envBefore === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = envBefore
})

function writeProject(id: string, profile: unknown): void {
  // 先经正式创建入口建文件夹与 SQLite 行，再用旧快照覆盖 project.json，
  // 模拟「升级前保存过的项目」，避免只写文件导致 openProject 找不到项目行。
  try {
    createProject('迁移测试', undefined, id)
  } catch {
    // 已存在（同一用例内重复调用）时忽略。
  }
  const dir = join(dataDir, 'projects', id)
  mkdirSync(join(dir, 'media'), { recursive: true })
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        version: 1,
        meta: { id, name: '迁移测试', createdAt: 1, updatedAt: 1, graphVersion: 0 },
        nodes: [],
        edges: [],
        groups: [],
        ...(profile === undefined ? {} : { workspaceProfile: profile })
      },
      null,
      2
    ),
    'utf8'
  )
}

describe('打开项目时迁移工作台节点可见集', () => {
  it('旧 general 快照缺少新节点：打开后补入 timeline 并写入节点集版本', () => {
    writeProject('p-general', {
      schemaVersion: 1,
      presetId: 'general',
      visibleNodeTypeIds: ['text', 'image']
    })
    const file = openProject('p-general')
    expect(file).not.toBeNull()
    expect(file!.workspaceProfile?.visibleNodeTypeIds).toContain('timeline')
    expect(file!.workspaceProfile?.nodeSetRevision).toBe(WORKSPACE_NODE_SET_REVISION)
  })

  it('custom 预设同样按版本补入：用户手挑的节点集不能把新节点永久挡在门外', () => {
    writeProject('p-custom', {
      schemaVersion: 1,
      presetId: 'custom',
      visibleNodeTypeIds: ['text', 'video']
    })
    const file = openProject('p-custom')
    expect(file!.workspaceProfile?.visibleNodeTypeIds).toContain('timeline')
  })

  it('已经带最新版本号的 custom 配置不被反复改写（尊重用户主动隐藏）', () => {
    writeProject('p-custom-hidden', {
      schemaVersion: 1,
      presetId: 'custom',
      visibleNodeTypeIds: ['text'],
      nodeSetRevision: WORKSPACE_NODE_SET_REVISION
    })
    const file = openProject('p-custom-hidden')
    expect(file!.workspaceProfile?.visibleNodeTypeIds).not.toContain('timeline')
  })

  it('没有 workspaceProfile 的旧项目保持 undefined（= 显示全部可创建节点）', () => {
    writeProject('p-legacy', undefined)
    const file = openProject('p-legacy')
    expect(file!.workspaceProfile).toBeUndefined()
  })

  it('新建项目直接带上最新节点集版本', () => {
    const meta = createProject('迁移测试新建')
    const file = openProject(meta.id)
    expect(file!.workspaceProfile?.nodeSetRevision).toBe(WORKSPACE_NODE_SET_REVISION)
    expect(file!.workspaceProfile?.visibleNodeTypeIds).toContain('timeline')
    // 落盘文件也应包含版本号（不是只在内存里补）。
    const raw = JSON.parse(
      readFileSync(join(dataDir, 'projects', meta.id, 'project.json'), 'utf8')
    ) as { workspaceProfile?: { nodeSetRevision?: number } }
    expect(raw.workspaceProfile?.nodeSetRevision).toBe(WORKSPACE_NODE_SET_REVISION)
  })
})
