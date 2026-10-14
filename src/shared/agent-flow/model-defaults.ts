import type { FeatureBinding } from '@free-creation/model-contracts'

/** Apply a local preference only when creating a node, never to an existing task snapshot. */
export function flowInitialConfig(
  type: string,
  config: string,
  bindings: FeatureBinding[]
): string {
  if (type !== 'agent' && type !== 'ai-review') return config
  const binding = bindings.find(
    (value) =>
      value.featureKey === 'agent.default' &&
      value.enabled &&
      value.target.operation === 'text.generate'
  )
  if (!binding) return config
  try {
    const value = JSON.parse(config)
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.modelDefinitionId)
      return config
    return JSON.stringify({ ...value, modelDefinitionId: binding.modelDefinitionId })
  } catch {
    return config
  }
}
