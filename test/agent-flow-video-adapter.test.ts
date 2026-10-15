// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType } from '@renderer/nodes/registry'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { readFlowAssetSnapshot } from '@renderer/canvas/flow-asset-snapshot'
import { VIDEO_FLOW_PORTS, videoFlowInputsValid } from '@shared/agent-flow/video-adapter'
import {
  projectVideoOutputs,
  projectVideoAssetOutputs
} from '@shared/engine/deterministic-projections'
import { computeInputFingerprint } from '@shared/engine/input-fingerprint'
import { fingerprintNodeInputs } from '@renderer/engine/resultFreshness'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import type { PortDecl } from '@shared/types'

beforeAll(registerAllNodeTypes)
describe('video scheduling contract and fixed preview', () => {
  it('matches ordinary video asset projection even with unrelated execution history', () => {
    const shape = {
      props: {
        nodeType: 'video-asset',
        title: 'source',
        mediaId: 'motion',
        mediaPath: 'projects/p/media/motion.mp4',
        mediaMime: 'video/mp4'
      },
      meta: { nodeRun: JSON.stringify({ status: 'failed' }), nodeResult: '{}' }
    } as unknown as NodeCardShape
    expect(getNodeType('video-asset')!.projectOutputs(shape)).toEqual(
      projectVideoAssetOutputs(shape)
    )
    const value = {
      kind: 'video' as const,
      mediaId: 'motion',
      mediaPath: 'projects/p/media/motion.mp4',
      mime: 'video/mp4',
      contentSha256: 'a'.repeat(64)
    }
    shape.meta.flowAssetRef = JSON.stringify({
      assetId: 'asset',
      versionId: 'version',
      sourceNodeId: 'source',
      sourcePortId: 'out-video'
    })
    shape.meta.pinnedOutput = JSON.stringify({ version: 1, outputs: { 'out-video': value } })
    expect(readFlowAssetSnapshot(shape)).toEqual(value)
    expect(projectNodeOutputs(shape)['out-video']).toEqual(value)
  })
  it('admits exactly one video reference with optional images/text and rejects audio or frame mixing', () => {
    const motion = { targetPortId: 'in-reference-video', kinds: ['video'] }
    expect(videoFlowInputsValid('reference', [motion])).toBe(true)
    expect(
      videoFlowInputsValid('reference', [
        motion,
        { targetPortId: 'in-images', kinds: ['image'] },
        { targetPortId: 'in-text', kinds: ['text'] }
      ])
    ).toBe(true)
    for (const kinds of [[], ['image'], ['video', 'video']])
      expect(videoFlowInputsValid('reference', [{ ...motion, kinds }])).toBe(false)
    expect(videoFlowInputsValid('first-frame', [motion])).toBe(false)
    expect(
      videoFlowInputsValid('reference', [{ targetPortId: 'in-reference-audio', kinds: ['audio'] }])
    ).toBe(false)
  })
  it('admits only image-only reference manifests within the hard bound, preserving text cardinality', () => {
    for (const count of [1, 3, 9, 30])
      expect(
        videoFlowInputsValid('reference', [
          { targetPortId: 'in-images', kinds: Array(count).fill('image') }
        ])
      ).toBe(true)
    for (const kinds of [[], Array(31).fill('image'), ['image', 'video'], ['audio']])
      expect(videoFlowInputsValid('reference', [{ targetPortId: 'in-images', kinds }])).toBe(false)
    expect(videoFlowInputsValid('reference', [])).toBe(false)
    expect(
      videoFlowInputsValid('reference', [
        { targetPortId: 'in-images', kinds: ['image'] },
        { targetPortId: 'in-reference-video', kinds: ['video'] }
      ])
    ).toBe(true)
    expect(
      videoFlowInputsValid('reference', [
        { targetPortId: 'in-images', kinds: ['image'] },
        { targetPortId: 'in-text', kinds: ['text', 'text'] }
      ])
    ).toBe(false)
  })
  it('admits exactly two ordered images for first-last-frame and at most one text', () => {
    const frames = { targetPortId: 'in-images', kinds: ['image', 'image'] }
    expect(videoFlowInputsValid('first-last-frame', [frames])).toBe(true)
    expect(
      videoFlowInputsValid('first-last-frame', [
        frames,
        { targetPortId: 'in-text', kinds: ['markdown'] }
      ])
    ).toBe(true)
    for (const kinds of [[], ['image'], ['image', 'text'], ['image', 'image', 'image']])
      expect(videoFlowInputsValid('first-last-frame', [{ ...frames, kinds }])).toBe(false)
    expect(videoFlowInputsValid('first-frame', [frames])).toBe(false)
    expect(videoFlowInputsValid('reference', [frames])).toBe(true)
    expect(
      videoFlowInputsValid('first-last-frame', [
        frames,
        { targetPortId: 'in-text', kinds: ['text', 'text'] }
      ])
    ).toBe(false)
  })
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
  it('preserves both frame positions in identical main and renderer fingerprints', () => {
    const shape = {
      props: { nodeType: 'video', config: '{"mode":"first-last-frame"}', text: 'prompt' }
    } as NodeCardShape
    const frames = ['first', 'last'].map((id, index) => ({
      source: { nodeId: id, portId: 'out-image' },
      value: {
        kind: 'image' as const,
        mediaId: id,
        mediaPath: `projects/p/media/${id}.png`,
        mime: 'image/png',
        contentSha256: String(index).repeat(64)
      }
    }))
    const fingerprint = (values: typeof frames) =>
      computeInputFingerprint({
        contractVersion: 7,
        config: shape.props.config,
        text: shape.props.text,
        sources: values.map(({ source, value }) => ({
          portId: 'in-images',
          nodeId: source.nodeId,
          sourcePortId: source.portId,
          value
        }))
      })
    expect(fingerprintNodeInputs(shape, new Map([['in-images', frames]]))).toBe(fingerprint(frames))
    expect(fingerprint([...frames].reverse())).not.toBe(fingerprint(frames))
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
