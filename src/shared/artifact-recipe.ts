import { z } from 'zod'

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
