import type { ConnectedNodeInput } from './graph'

/** Visual identity only: the source sequence never replaces a node ID or an input value. */
export function referenceIdentity(input: ConnectedNodeInput, sequence: number | undefined): string {
  const index = sequence === undefined ? '—' : String(sequence).padStart(2, '0')
  const codes = { text: 'T', markdown: 'T', image: 'I', video: 'V', audio: 'A', file: 'F', json: 'J', camera: 'C' } as const
  const kind = input.value?.kind
  const code = input.sourcePortSchema?.id === 'voice.profile' ? 'V' : kind ? codes[kind] : '?'
  return `${index}${code}`
}
