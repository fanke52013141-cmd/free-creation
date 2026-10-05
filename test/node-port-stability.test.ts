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
  expect(idle.offsets.get('audio-alt')).toBe(idle.offsets.get('audio'))
})
