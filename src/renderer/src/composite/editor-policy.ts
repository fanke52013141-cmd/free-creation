import type { CompositeManifest } from '@shared/composite/manifest'

export interface CompositeEditorPolicy {
  onBranchFailure: 'fail-fast' | 'continue'
  maxConcurrency: number
}

export function compositeEditorPolicyFromManifest(
  manifest: CompositeManifest | null | undefined
): CompositeEditorPolicy {
  return {
    onBranchFailure: manifest?.executionPolicy?.onBranchFailure ?? 'fail-fast',
    maxConcurrency: manifest?.executionPolicy?.maxConcurrency ?? 1
  }
}

/** 策略值与弹窗可见性无关；保存成功后调用方把返回 manifest 同步为下一次编辑基准。 */
export function applyCompositeEditorPolicy(
  manifest: CompositeManifest,
  policy: CompositeEditorPolicy
): CompositeManifest {
  return {
    ...manifest,
    executionPolicy: {
      ...manifest.executionPolicy,
      onBranchFailure: policy.onBranchFailure,
      maxConcurrency: policy.maxConcurrency
    }
  }
}
