import { describe, expect, it } from 'vitest'
import { isActiveRunState, normalizeTextInput, splitText } from './runtime'

describe('shared node runtime', () => {
  it('treats queued, legacy pending and running as non-repeatable states', () => {
    expect(['queued', 'pending', 'running'].every(isActiveRunState)).toBe(true)
    expect(['idle', 'dirty', 'done', 'error', 'canceled'].some(isActiveRunState)).toBe(false)
  })

  it('supports the default storyboard delimiters', () => {
    expect(splitText('镜头1\n镜头2===镜头3---镜头4', 'auto')).toEqual(['镜头1', '镜头2', '镜头3', '镜头4'])
  })

  it('decodes a visible newline delimiter', () => {
    expect(splitText('a\nb\n\n c', '\\n')).toEqual(['a', 'b', 'c'])
  })

  it('normalizes scalar and mapped text input consistently', () => {
    expect(normalizeTextInput('  hello ')).toEqual(['hello'])
    expect(normalizeTextInput([' a ', '', 'b'])).toEqual(['a', 'b'])
  })
})
