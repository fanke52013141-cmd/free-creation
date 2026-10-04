import { legacyCategory, planResourceNodes, type LibraryNodePlan } from '@shared/library/blueprint'
import type { LibraryResourceDetail } from '@shared/library/types'

export function missingRecipeVariables(
  detail: LibraryResourceDetail,
  ids: string[],
  values: Record<string, Record<string, string>>
): Array<{ componentId: string; name: string }> {
  return detail.components
    .filter((component) => ids.includes(component.id) && component.valueType === 'recipe')
    .flatMap((component) => {
      const declared = Array.isArray(component.metadata.variables)
        ? component.metadata.variables.filter((v): v is string => typeof v === 'string')
        : []
      const detected = [
        ...(component.text ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g)
      ].map((match) => match[1])
      return [...new Set([...declared, ...detected])]
        .filter((name) => !values[component.id]?.[name]?.trim())
        .map((name) => ({ componentId: component.id, name }))
    })
}
export function resourceReusePreview(
  detail: LibraryResourceDetail,
  ids: string[],
  values: Record<string, Record<string, string>>
): { nodes: LibraryNodePlan[]; fileCount: number; revision: number } {
  const missing = missingRecipeVariables(detail, ids, values)
  if (missing.length) throw new Error(`请填写变量：${missing.map((item) => item.name).join('、')}`)
  const category = detail.category ?? legacyCategory(detail.formPreset, detail.components)
  const nodes = planResourceNodes(category, detail.components, detail.selectedTitle, ids, values)
  return {
    nodes,
    fileCount: detail.components.filter((c) => ids.includes(c.id) && c.blobPath).length,
    revision: detail.selectedRevisionNumber
  }
}
