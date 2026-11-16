import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database }))
vi.mock('../src/main/store/db', () => ({ getDb: () => fixture.db }))

import { saveArtifactRecipe } from '../src/main/store/artifact-recipes.repo'
import type { ArtifactRecipe } from '../src/shared/artifact-recipe'

// 回归基线（2026-11-17 节点流全面测试 L3）：composite 公开媒体产物经 emitArtifact
// 保存生成来源时，引用形态产物（发布快照 mediaRef / headless 直写素材）在 media 表
// 无行，旧逻辑 throw 会把「生成来源保存失败」升级为整个节点运行 failed，媒体资产
// 节点流全挂（composite-desktop-acceptance 第 17 项）。修复后：无 media 行 → skipped
// 不落库不拒跑；media 行存在但路径不属于本项目 → 仍拒绝（完整性守卫）。

function recipe(patch: Partial<ArtifactRecipe> = {}): ArtifactRecipe {
  return {
    projectId: 'p1',
    mediaId: 'm-gen',
    runId: 'run-1',
    producerNodeId: 'shape:node',
    nodeType: 'image-gen',
    contractVersion: 2,
    fullPrompt: '一只赛博朋克的猫',
    paramsJson: '{"count":1}',
    inputMediaIds: [],
    createdAt: Date.now(),
    ...patch
  }
}

beforeEach(() => {
  const db = new Database(':memory:')
  db.exec(
    `CREATE TABLE media (
       id TEXT PRIMARY KEY, path TEXT NOT NULL, mime TEXT NOT NULL,
       kind TEXT NOT NULL, size_bytes INTEGER NOT NULL
     );
     CREATE TABLE artifact_recipes (
       media_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, recipe_json TEXT NOT NULL
     );`
  )
  fixture.db = db
})

describe('saveArtifactRecipe · 引用形态产物跳过语义（节点流回归）', () => {
  it('media 表无此资产 → skipped，不落库、不抛错', () => {
    const outcome = saveArtifactRecipe(recipe({ mediaId: 'm-ref-not-in-db' }))
    expect(outcome).toBe('skipped')
    const row = fixture.db
      .prepare('SELECT recipe_json FROM artifact_recipes WHERE media_id = ?')
      .get('m-ref-not-in-db')
    expect(row).toBeUndefined()
  })

  it('media 属于本项目 → saved 正常落库', () => {
    fixture.db
      .prepare('INSERT INTO media (id, path, mime, kind, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .run('m-gen', 'projects/p1/media/gen.png', 'image/png', 'image', 1)
    expect(saveArtifactRecipe(recipe())).toBe('saved')
    const row = fixture.db
      .prepare('SELECT recipe_json FROM artifact_recipes WHERE media_id = ?')
      .get('m-gen')
    expect(row).toBeTruthy()
  })

  it('media 属于其他项目 → 仍拒绝（完整性守卫不放宽）', () => {
    fixture.db
      .prepare('INSERT INTO media (id, path, mime, kind, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .run('m-other', 'projects/p2/media/other.png', 'image/png', 'image', 1)
    expect(() => saveArtifactRecipe(recipe({ mediaId: 'm-other' }))).toThrow('媒体不属于此项目')
  })
})
