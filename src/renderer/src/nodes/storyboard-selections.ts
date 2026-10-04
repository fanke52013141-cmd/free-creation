import { computeInputFingerprint } from '@shared/engine/input-fingerprint'
import type { StoryboardShot } from './storyboard-editor'

export interface ShotSelection {
  shotId: string
  inputRevision: string
  selectedAssetId: string
  mediaId: string
}
export function shotInputRevision(shot: StoryboardShot): string {
  return computeInputFingerprint({
    contractVersion: 1,
    config: JSON.stringify(shot),
    text: '',
    sources: []
  })
}
export function readShotSelections(raw: unknown): Record<string, ShotSelection> {
  try {
    const entries = JSON.parse(typeof raw === 'string' ? raw : '{}') as Record<
      string,
      ShotSelection
    >
    return Object.fromEntries(
      Object.entries(entries).filter(
        ([id, entry]) =>
          entry &&
          entry.shotId === id &&
          typeof entry.inputRevision === 'string' &&
          typeof entry.selectedAssetId === 'string' &&
          typeof entry.mediaId === 'string'
      )
    )
  } catch {
    return {}
  }
}
