import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { recipeGateway } from '../src/renderer/src/engine/recipeGateway'
import type { GatewayClient } from '../src/shared/engine/gateway-client'
import {
  artifactRecipeSchema,
  recipeParams,
  type ArtifactRecipe
} from '../src/shared/artifact-recipe'
const state = vi.hoisted(() => ({ database: null as unknown }))
vi.mock('../src/main/store/db', () => ({ getDb: () => state.database }))
import {
  getArtifactRecipe,
  listArtifactRecipes,
  saveArtifactRecipe
} from '../src/main/store/artifact-recipes.repo'
let database: DatabaseSync
beforeEach(() => {
  database = new DatabaseSync(':memory:')
  state.database = database
  migrateDatabase({
    exec: (sql) => database.exec(sql),
    pragma: (sql, options) =>
      options?.simple
        ? (database.prepare(`PRAGMA ${sql}`).get() as { user_version: number }).user_version
        : database.exec(`PRAGMA ${sql}`)
  })
})
afterEach(() => database.close())
function recipe(id: string): ArtifactRecipe {
  database
    .prepare(
      'INSERT INTO media (id, kind, mime, path, size_bytes, created_at, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, 'image', 'image/png', `projects/p/media/${id}.png`, 1, 1, 'result')
  return {
    projectId: 'p',
    mediaId: id,
    runId: `run:${id}`,
    producerNodeId: 'shape:producer',
    nodeType: 'image-gen',
    contractVersion: 3,
    fullPrompt: '完整正文',
    paramsJson: '{"count":2}',
    inputMediaIds: ['upstream'],
    createdAt: 1
  }
}
describe('T10 独立生成来源', () => {
  it('captures the actual merged gateway request without modifying it or leaking credentials', async () => {
    const capture = vi.fn()
    const response = { ok: true, data: { id: 'm' } }
    const submit = vi.fn().mockResolvedValue(response)
    const gateway = recipeGateway({ imageGenerate: submit } as unknown as GatewayClient, capture)
    const input = {
      projectId: 'p',
      providerId: 'provider',
      modelId: 'model',
      prompt: '上游正文\n用户正文',
      apiKey: 'secret'
    }
    expect(await gateway.imageGenerate(input)).toBe(response)
    expect(submit).toHaveBeenCalledWith(input)
    expect(capture.mock.calls[0][0]).toMatchObject({ prompt: input.prompt })
    expect(capture.mock.calls[0][0].paramsJson).not.toContain('secret')
  })
  it('超过12次生成后旧素材来源仍可查询，且不依赖生产节点存在', () => {
    for (let i = 0; i < 14; i++) saveArtifactRecipe(recipe(`m${i}`))
    expect(getArtifactRecipe('p', 'm0')).toMatchObject({
      fullPrompt: '完整正文',
      producerNodeId: 'shape:producer'
    })
    expect(listArtifactRecipes('p')).toHaveLength(14)
  })
  it('同一媒体来源不可被后续候选覆盖', () => {
    const original = recipe('m')
    saveArtifactRecipe(original)
    saveArtifactRecipe({ ...original, fullPrompt: 'new' })
    expect(getArtifactRecipe('p', 'm')?.fullPrompt).toBe('完整正文')
  })
  it('历史无来源显示空，跨项目媒体写入被拒绝', () => {
    expect(getArtifactRecipe('p', 'old')).toBeNull()
    expect(() => saveArtifactRecipe({ ...recipe('m'), projectId: 'other' })).toThrow('不属于')
  })
  it('参数递归剔除凭据；原始正文只保留在私人来源记录中', () => {
    const record = recipe('m')
    record.paramsJson = '{"apiKey":"secret","nested":{"token":"bad","count":2}}'
    saveArtifactRecipe(record)
    expect(getArtifactRecipe('p', 'm')?.paramsJson).toBe('{"nested":{"count":2}}')
    expect(recipeParams('broken')).toBe('{}')
    expect(artifactRecipeSchema.safeParse({ ...record, createdAt: -1 }).success).toBe(false)
  })
})
