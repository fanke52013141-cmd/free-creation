import { z } from 'zod'
import { remapMediaReferences } from './media-reference-remap'

/** Private project data, never a diagnostic payload. */
export const artifactRecipeSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    mediaId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    producerNodeId: z.string().max(128),
    nodeType: z.string().max(128),
    contractVersion: z.number().int().nonnegative(),
    fullPrompt: z.string().max(1_000_000),
    paramsJson: z.string().max(1_000_000),
    modelKey: z.string().max(256).optional(),
    providerId: z.string().max(128).optional(),
    inputMediaIds: z.array(z.string().max(128)).max(10000),
    missingInputMediaIds: z.array(z.string().max(128)).max(10000).optional(),
    createdAt: z.number().int().nonnegative()
  })
  .strict()
export type ArtifactRecipe = z.infer<typeof artifactRecipeSchema>

/** Copy private provenance while distinguishing omitted upstream files from local references. */
export function copyArtifactRecipe(
  recipe: ArtifactRecipe,
  projectId: string,
  mediaId: string,
  ids: Map<string, string>,
  paths: Map<string, string> = new Map()
): ArtifactRecipe {
  return {
    ...recipe,
    projectId,
    mediaId,
    producerNodeId: ids.get(recipe.producerNodeId) ?? recipe.producerNodeId,
    paramsJson: JSON.stringify(
      remapMediaReferences(JSON.parse(recipeParams(recipe.paramsJson)), { ids, paths })
    ),
    inputMediaIds: recipe.inputMediaIds.flatMap((id) => (ids.has(id) ? [ids.get(id)!] : [])),
    missingInputMediaIds: [
      ...new Set([
        ...(recipe.missingInputMediaIds ?? []),
        ...recipe.inputMediaIds.filter((id) => !ids.has(id))
      ])
    ]
  }
}

export function recipeParams(config: string): string {
  try {
    return JSON.stringify(JSON.parse(config), (key, value) =>
      /^(apikey|apitoken|token|accesstoken|refreshtoken|secret|secretkey|password|authorization|credential|credentials|diagnostics|base64|buffer)$/i.test(
        key.replace(/[-_]/g, '')
      ) || ArrayBuffer.isView(value)
        ? undefined
        : value
    )
  } catch {
    return '{}'
  }
}
