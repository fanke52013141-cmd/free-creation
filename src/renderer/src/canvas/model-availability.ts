import type { ProviderSummary } from '@shared/types'
import type { ModelOperation } from '@free-creation/model-contracts'
import { resolveFeatureOption } from '@shared/engine/models'
import { rendererGateway } from '../engine/rendererGateway'

const pending = new Map<string, Promise<boolean>>()
export function providerAvailabilityKey(providers: ProviderSummary[]): string {
  return JSON.stringify(
    providers.map(({ id, baseURL, specId, hasApiKey, models }) => ({
      id,
      baseURL,
      specId,
      hasApiKey,
      models
    }))
  )
}
/** Dedupe only concurrent checks; settled entries are removed so binding changes can be rechecked. */
export function checkModelAvailability(
  providers: ProviderSummary[],
  feature: string,
  operation: ModelOperation,
  selected?: string
): Promise<boolean> {
  const key = JSON.stringify([providerAvailabilityKey(providers), feature, operation, selected])
  const existing = pending.get(key)
  if (existing) return existing
  const promise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10000)
    void resolveFeatureOption(rendererGateway, providers, feature, operation, selected)
      .then(
        (option) => resolve(Boolean(option)),
        () => resolve(false)
      )
      .finally(() => clearTimeout(timeout))
  }).finally(() => {
    if (pending.get(key) === promise) pending.delete(key)
  })
  pending.set(key, promise)
  return promise
}
