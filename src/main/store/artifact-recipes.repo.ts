import type { ArtifactRecipe } from '../../shared/artifact-recipe'
import { artifactRecipeSchema } from '../../shared/artifact-recipe'
import { recipeParams } from '../../shared/artifact-recipe'
import { getDb } from './db'

export type ArtifactRecipeSaveOutcome = 'saved' | 'skipped'

/**
 * 保存生成来源。返回 'saved'（已落库）或 'skipped'（无需/无法落库，不视为失败）：
 * - 媒体库无此资产（引用形态产物：发布快照 mediaRef、headless 直写文件、外部素材）——
 *   本次运行并未生成它，没有「生成来源」可记，跳过而不是让整个运行失败
 *   （2026-11-17 回归：composite 公开媒体产物 emitArtifact 把引用产物也送进来，
 *   旧逻辑 throw 会导致媒体资产节点流整体 failed）。
 * - 媒体存在但路径不属于本项目：仍然拒绝——这是完整性守卫，防来源串项目。
 */
export function saveArtifactRecipe(recipe: ArtifactRecipe): ArtifactRecipeSaveOutcome {
  const validated = artifactRecipeSchema.parse(recipe)
  validated.paramsJson = recipeParams(validated.paramsJson)
  const database = getDb()
  const media = database.prepare('SELECT path FROM media WHERE id = ?').get(recipe.mediaId) as
    { path: string } | undefined
  if (!media) return 'skipped'
  if (!media.path.startsWith(`projects/${recipe.projectId}/media/`))
    throw new Error('媒体不属于此项目')
  database
    .prepare(
      'INSERT OR IGNORE INTO artifact_recipes (media_id, project_id, recipe_json) VALUES (?, ?, ?)'
    )
    .run(recipe.mediaId, recipe.projectId, JSON.stringify(validated))
  return 'saved'
}
export function listArtifactRecipes(projectId: string): ArtifactRecipe[] {
  return (
    getDb()
      .prepare('SELECT recipe_json FROM artifact_recipes WHERE project_id = ?')
      .all(projectId) as { recipe_json: string }[]
  ).map((row) => artifactRecipeSchema.parse(JSON.parse(row.recipe_json)))
}
export function getArtifactRecipe(projectId: string, mediaId: string): ArtifactRecipe | null {
  const row = getDb()
    .prepare('SELECT recipe_json FROM artifact_recipes WHERE project_id = ? AND media_id = ?')
    .get(projectId, mediaId) as { recipe_json: string } | undefined
  return row ? artifactRecipeSchema.parse(JSON.parse(row.recipe_json)) : null
}
