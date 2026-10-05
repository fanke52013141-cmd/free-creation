import { expect, it } from 'vitest'
import { createNodePortLayout } from '@renderer/canvas/node-port-layout'
import type { PortDecl } from '@shared/types'

it('candidate visibility and provenance connections never move declared anchors', () => {
  const ports = [
    { id: 'video', type: 'video' },
    { id: 'audio', type: 'audio' },
    { id: 'audio-alt', type: 'audio' }
  ] as PortDecl[]
  const idle = createNodePortLayout(ports, new Set(['audio']), 260)
  const connecting = createNodePortLayout(ports, new Set(['audio']), 260, new Set(['video']))
  expect(idle.ports.map((port) => port.id)).toEqual(['audio'])
  expect(connecting.ports.map((port) => port.id)).toEqual(['video', 'audio'])
  expect(connecting.offsets).toEqual(idle.offsets)
  expect(idle.offsets.get('audio')).toBe(130)
  expect(idle.offsets.get('audio-alt')).toBe(idle.offsets.get('audio'))
})

it('single default connector stays at the vertical center despite optional type declarations', () => {
  const ports = [
    { id: 'text', type: 'text' },
    { id: 'json', type: 'json' }
  ] as PortDecl[]
  const idle = createNodePortLayout(ports, new Set(), 260)
  const candidates = createNodePortLayout(ports, new Set(), 260, new Set(['json']))
  expect(idle.offsets.get('text')).toBe(130)
  expect(candidates.offsets).toEqual(idle.offsets)
})
