import { describe, expect, it } from 'vitest'
import {
  AgentOutputSetSchema,
  agentReplyOutputProjection
} from '../src/shared/agent-flow/agent-outputs'

const ref = (index: number) => ({
  assetId: `asset-${index}`,
  versionId: `version-${index}`,
  sourceNodeId: `source-${index}`,
  sourcePortId: index === 2 ? 'out-subtitle' : 'out-audio'
})

describe('Agent multi-result output projection', () => {
  it('preserves every same-kind and multi-port result in one versioned JSON output set', () => {
    const refs = [ref(1), ref(2), ref(3)]
    const values = [
      { kind: 'audio' as const, mediaId: 'audio-1', mediaPath: 'projects/p/media/1.wav', mime: 'audio/wav' },
      { kind: 'audio' as const, mediaId: 'audio-2', mediaPath: 'projects/p/media/2.wav', mime: 'audio/wav' },
      { kind: 'text' as const, text: 'subtitle' }
    ]
    const projected = agentReplyOutputProjection(refs, values)
    expect(Object.keys(projected)).toEqual(['out-json'])
    const outputSet = AgentOutputSetSchema.parse(projected['out-json']?.kind === 'json' && projected['out-json'].data)
    expect(outputSet.outputs).toEqual([
      { ref: refs[0], assetKind: 'audio' },
      { ref: refs[1], assetKind: 'audio' },
      { ref: refs[2], assetKind: 'text' }
    ])
  })

  it('keeps one text and one JSON result on their declared ports', () => {
    const projected = agentReplyOutputProjection(
      [ref(1), ref(2)],
      [{ kind: 'text', text: 'summary' }, { kind: 'json', data: { version: 1 } }]
    )
    expect(projected).toEqual({
      'out-text': { kind: 'text', text: 'summary' },
      'out-json': { kind: 'json', data: { version: 1 } }
    })
  })

  it('rejects duplicate references instead of publishing them twice', () => {
    expect(
      agentReplyOutputProjection(
        [ref(1), ref(1)],
        [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'one' }]
      )
    ).toEqual({})
  })
})
