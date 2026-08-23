import type { NodeRunState } from './types'

export const ACTIVE_RUN_STATES = new Set<NodeRunState>(['queued', 'running'])

export function isActiveRunState(state: string): boolean {
  return state === 'queued' || state === 'running' || state === 'pending'
}

export function splitText(text: string, delimiter: string): string[] {
  const pieces = delimiter === 'auto'
    ? text.split(/\r?\n|===|---/)
    : text.split((delimiter || '\\n').replaceAll('\\n', '\n').replaceAll('\\t', '\t'))
  return pieces.map((item) => item.trim()).filter(Boolean)
}

export function normalizeTextInput(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean)
}
