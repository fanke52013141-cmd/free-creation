import { describe, expect, it } from 'vitest'
import {
  AgentOutputSetSchema,
  agentOutputSetMatchesAssets,
  agentReplyOutputProjection,
  projectAgentOutputs
} from '../src/shared/agent-flow/agent-outputs'
import { jsonExecutor } from '../src/shared/engine/executors/json'
import type { NodeExecutionContext } from '../src/shared/engine/executor-types'

const ref = (index: number) => ({
  assetId: `asset-${index}`,
  versionId: `version-${index}`,
  sourceNodeId: `source-${index}`,
  sourcePortId: index === 2 ? 'out-subtitle' : 'out-audio'
})

describe('Agent multi-result output projection', () => {
  it.each([2, 4, 128])(
    'AST-05 preserves all %i same-kind fixed references in source order',
    (count) => {
      const refs = Array.from({ length: count }, (_, index) => ref(index))
      const values = refs.map((_, index) => ({ kind: 'text' as const, text: 'fixed-' + index }))
      const projected = agentReplyOutputProjection(refs, values)
      expect(Object.keys(projected)).toEqual(['out-json'])
      const output = projected['out-json']
      const set = AgentOutputSetSchema.parse(output?.kind === 'json' && output.data)
      expect(set.outputs).toHaveLength(count)
      expect(set.outputs.map((item) => item.ref)).toEqual(refs)
      expect(new Set(set.outputs.map((item) => item.ref.versionId)).size).toBe(count)
    }
  )
  it.each(['empty', 'mismatched-count', 'over-limit', 'duplicate'])(
    'AST-05 rejects %s output collections without partial public ports',
    (variant) => {
      const refs =
        variant === 'empty'
          ? []
          : variant === 'over-limit'
            ? Array.from({ length: 129 }, (_, index) => ref(index))
            : variant === 'duplicate'
              ? [ref(0), ref(0)]
              : [ref(0), ref(1)]
      const values = refs.map(() => ({ kind: 'text' as const, text: 'fixed' }))
      if (variant === 'mismatched-count') values.pop()
      expect(agentReplyOutputProjection(refs, values)).toEqual({})
    }
  )
  it('preserves every same-kind and multi-port result in one versioned JSON output set', () => {
    const refs = [ref(1), ref(2), ref(3)]
    const values = [
      {
        kind: 'audio' as const,
        mediaId: 'audio-1',
        mediaPath: 'projects/p/media/1.wav',
        mime: 'audio/wav'
      },
      {
        kind: 'audio' as const,
        mediaId: 'audio-2',
        mediaPath: 'projects/p/media/2.wav',
        mime: 'audio/wav'
      },
      { kind: 'text' as const, text: 'subtitle' }
    ]
    const projected = agentReplyOutputProjection(refs, values)
    expect(Object.keys(projected)).toEqual(['out-json'])
    const outputSet = AgentOutputSetSchema.parse(
      projected['out-json']?.kind === 'json' && projected['out-json'].data
    )
    expect(outputSet.outputs).toEqual([
      { ref: refs[0], assetKind: 'audio' },
      { ref: refs[1], assetKind: 'audio' },
      { ref: refs[2], assetKind: 'text' }
    ])
  })

  it('validates an output set against ordered fixed refs and asset values', () => {
    const refs = [ref(1), ref(2)]
    const values = [
      { kind: 'text' as const, text: 'first fixed result' },
      { kind: 'text' as const, text: 'second fixed result' }
    ]
    const output = agentReplyOutputProjection(refs, values)['out-json']
    expect(agentOutputSetMatchesAssets(output, refs, values)).toBe(true)
    expect(agentOutputSetMatchesAssets(output, [refs[1], refs[0]], values)).toBe(false)
    expect(
      agentOutputSetMatchesAssets(output, refs, [
        values[0],
        { kind: 'json', data: { changed: true } }
      ])
    ).toBe(false)
    expect(
      agentOutputSetMatchesAssets(
        { kind: 'json', data: { kind: 'flow.agent-output-set' } },
        refs,
        values
      )
    ).toBe(false)
  })

  it('passes an Agent output set with mixed media refs through the ordinary downstream JSON executor', () => {
    const refs = [
      {
        assetId: 'asset-audio',
        versionId: 'version-audio',
        sourceNodeId: 'agent',
        sourcePortId: 'out-audio'
      },
      {
        assetId: 'asset-image',
        versionId: 'version-image',
        sourceNodeId: 'image-source',
        sourcePortId: 'out-image'
      },
      {
        assetId: 'asset-text',
        versionId: 'version-text',
        sourceNodeId: 'text-source',
        sourcePortId: 'out-text'
      }
    ]
    const projected = agentReplyOutputProjection(refs, [
      {
        kind: 'audio',
        mediaId: 'audio-1',
        mediaPath: 'projects/p/media/1.wav',
        mime: 'audio/wav',
        contentSha256: 'a'.repeat(64)
      },
      {
        kind: 'image',
        mediaId: 'image-1',
        mediaPath: 'projects/p/media/2.png',
        mime: 'image/png',
        contentSha256: 'b'.repeat(64)
      },
      { kind: 'text', text: 'subtitle' }
    ])
    const outputSet = AgentOutputSetSchema.parse(
      projected['out-json']?.kind === 'json' && projected['out-json'].data
    )
    const persistedAgentResult = JSON.stringify({
      schemaVersion: 1,
      taskId: 'task-mixed-assets',
      outputs: projected,
      refs
    })
    const agentOutput = projectAgentOutputs({
      meta: { nodeResult: persistedAgentResult }
    } as NodeExecutionContext['shape'])['out-json']
    expect(agentOutput).toEqual(projected['out-json'])

    let downstreamText = ''
    const packet = {
      type: 'json' as const,
      value: agentOutput!,
      source: { nodeId: 'agent', portId: 'out-json', runId: 'run-mixed-assets' },
      createdAt: 1
    }
    const result = jsonExecutor({
      shape: { props: { text: '{}' } },
      inputs: new Map([['in-json', [packet]]]),
      updateProps: (patch) => {
        downstreamText = patch.text ?? ''
      }
    } as unknown as NodeExecutionContext)

    expect(result.status).toBe('done')
    expect(JSON.parse(downstreamText)).toEqual(outputSet)
    expect(outputSet.outputs).toEqual([
      { ref: refs[0], assetKind: 'audio' },
      { ref: refs[1], assetKind: 'image' },
      { ref: refs[2], assetKind: 'text' }
    ])
  })

  it('keeps one text and one JSON result on their declared ports', () => {
    const projected = agentReplyOutputProjection(
      [ref(1), ref(2)],
      [
        { kind: 'text', text: 'summary' },
        { kind: 'json', data: { version: 1 } }
      ]
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
        [
          { kind: 'text', text: 'one' },
          { kind: 'text', text: 'one' }
        ]
      )
    ).toEqual({})
  })
})
