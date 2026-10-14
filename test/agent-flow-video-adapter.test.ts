// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType } from '@renderer/nodes/registry'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { readFlowAssetSnapshot } from '@renderer/canvas/flow-asset-snapshot'
import { VIDEO_FLOW_PORTS, videoFlowInputsValid } from '@shared/agent-flow/video-adapter'
import { projectVideoOutputs } from '@shared/engine/deterministic-projections'
import { computeInputFingerprint } from '@shared/engine/input-fingerprint'
import { fingerprintNodeInputs } from '@renderer/engine/resultFreshness'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import type { PortDecl } from '@shared/types'

beforeAll(registerAllNodeTypes)
describe('video scheduling contract and fixed preview', () => {
  it('uses the same formal ports as the public v7 video node', () => {
    const spec = getNodeType('video')!
    const identity = (ports: PortDecl[]) =>
      ports
        .map(({ id, dir, type, required, cardinality, schema, exclusiveGroup }) => ({
          id,
          dir,
          type,
          required,
          cardinality,
          schema,
          exclusiveGroup
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    expect(spec.contractVersion).toBe(7)
    expect(identity([...spec.ports.in, ...spec.ports.out])).toEqual(identity(VIDEO_FLOW_PORTS))
  })
  it('previews and consumes the pinned video version despite mutable props or result selection', () => {
    const value = {
      kind: 'video',
      mediaId: 'fixed-media',
      mediaPath: 'projects/project/media/fixed.mp4',
      mime: 'video/mp4'
    }
    const shape = {
      props: {
        nodeType: 'video-asset',
        mediaId: 'different',
        mediaPath: 'different',
        mediaMime: 'video/webm'
      },
      meta: {
        flowAssetRef: JSON.stringify({
          assetId: 'asset',
          versionId: 'version',
          sourceNodeId: 'shape:video',
          sourcePortId: 'out-video'
        }),
        pinnedOutput: JSON.stringify({ version: 1, outputs: { 'out-video': value } })
      }
    } as unknown as NodeCardShape
    expect(readFlowAssetSnapshot(shape)).toEqual(value)
    expect(projectNodeOutputs(shape)).toEqual({ 'out-video': value })
  })
  it('pins image preview and public output including the fixed content digest', () => {
    const value = {
      kind: 'image',
      mediaId: 'frame',
      mediaPath: 'projects/p/media/f.png',
      mime: 'image/png',
      contentSha256: 'a'.repeat(64)
    }
    const shape = {
      props: { nodeType: 'image', mediaPath: 'replacement.png' },
      meta: {
        flowAssetRef: JSON.stringify({
          assetId: 'a',
          versionId: 'v',
          sourceNodeId: 'shape:frame',
          sourcePortId: 'out-image'
        }),
        pinnedOutput: JSON.stringify({ version: 1, outputs: { 'out-image': value } })
      }
    } as unknown as NodeCardShape
    expect(readFlowAssetSnapshot(shape)).toEqual(value)
    expect(projectNodeOutputs(shape)).toEqual({ 'out-image': value })
    expect(
      videoFlowInputsValid('first-frame', [
        { targetPortId: 'in-images', kinds: ['image'] },
        { targetPortId: 'in-text', kinds: ['text'] }
      ])
    ).toBe(true)
    expect(videoFlowInputsValid('text', [{ targetPortId: 'in-images', kinds: ['image'] }])).toBe(
      false
    )
    expect(videoFlowInputsValid('first-frame', [])).toBe(false)
  })
  it('main commit and public executor fingerprint the same fixed media inputs', () => {
    const shape = {
      props: { nodeType: 'video', config: '{"mode":"first-frame"}', text: 'prompt' }
    } as NodeCardShape
    const value = {
      kind: 'image' as const,
      mediaId: 'frame',
      mediaPath: 'projects/p/media/frame.png',
      mime: 'image/png',
      contentSha256: 'a'.repeat(64)
    }
    const inputs = new Map([
      ['in-images', [{ source: { nodeId: 'source', portId: 'out-image' }, value }]]
    ])
    const main = (v: typeof value) =>
      computeInputFingerprint({
        contractVersion: 7,
        config: shape.props.config,
        text: shape.props.text,
        sources: [{ portId: 'in-images', nodeId: 'source', sourcePortId: 'out-image', value: v }]
      })
    expect(fingerprintNodeInputs(shape, inputs)).toBe(main(value))
    expect(main({ ...value, mediaPath: 'renamed.png' })).toBe(main(value))
    expect(main({ ...value, contentSha256: 'b'.repeat(64) })).not.toBe(main(value))
  })
  it('public and main video projections agree on the latest successful result', () => {
    const shape = {
      props: { nodeType: 'video', title: '视频' },
      meta: {
        nodeResult: JSON.stringify({
          kind: 'media-source',
          version: 1,
          selectedMediaId: 'old',
          results: [
            { mediaId: 'old', mediaPath: 'old.mp4', mime: 'video/mp4', createdAt: 0 },
            { mediaId: 'new', mediaPath: 'new.mp4', mime: 'video/mp4', createdAt: 1 }
          ]
        })
      }
    } as unknown as NodeCardShape
    expect(getNodeType('video')!.projectOutputs(shape)).toEqual(projectVideoOutputs(shape))
    expect(projectVideoOutputs(shape)['out-video']).toMatchObject({ mediaId: 'new' })
  })
})
