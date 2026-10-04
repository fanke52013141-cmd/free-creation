import type { ArtifactRecipe } from '../../shared/artifact-recipe'
import { artifactRecipeSchema } from '../../shared/artifact-recipe'
import { recipeParams } from '../../shared/artifact-recipe'
import { getDb } from './db'

export function saveArtifactRecipe(recipe: ArtifactRecipe): void {
  const validated = artifactRecipeSchema.parse(recipe)
  validated.paramsJson = recipeParams(validated.paramsJson)
  const database = getDb()
  const media = database.prepare('SELECT path FROM media WHERE id = ?').get(recipe.mediaId) as
    { path: string } | undefined
  if (!media?.path.startsWith(`projects/${recipe.projectId}/media/`))
    throw new Error('媒体不属于此项目')
  database
    .prepare(
      'INSERT OR IGNORE INTO artifact_recipes (media_id, project_id, recipe_json) VALUES (?, ?, ?)'
    )
    .run(recipe.mediaId, recipe.projectId, JSON.stringify(validated))
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
