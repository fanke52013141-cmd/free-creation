import { describe, expect, it } from 'vitest'
import { buildMiniMaxH3RequestBody } from '../src/main/gateway/video'
import type { VideoSubmitInput } from '../src/shared/contracts'

const input = (patch: Partial<VideoSubmitInput> = {}): VideoSubmitInput => ({
  projectId: 'project-a',
  nodeId: 'node-a',
  providerId: 'provider-a',
  modelId: 'MiniMax-H3',
  prompt: '角色转身，镜头推进',
  ...patch
})

const resolveMedia = async (id: string): Promise<string> => `data:test/${id}`

describe('MiniMax H3 gateway wire payload', () => {
  it('保留首尾帧角色，并让帧图决定画幅', async () => {
    await expect(
      buildMiniMaxH3RequestBody(
        input({
          mode: 'first-last-frame',
          firstFrameMediaId: 'first',
          lastFrameMediaId: 'last',
          params: { ratio: '9:16', duration: 5, resolution: '768P', watermark: false }
        }),
        resolveMedia
      )
    ).resolves.toEqual({
      model: 'MiniMax-H3',
      content: [
        { type: 'text', text: '角色转身，镜头推进' },
        { type: 'image_url', image_url: { url: 'data:test/first' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'data:test/last' }, role: 'last_frame' }
      ],
      duration: 5,
      resolution: '768P',
      aigc_watermark: false
    })
  })

  it('保留多参素材顺序，并在非帧模式发送明确画幅', async () => {
    await expect(
      buildMiniMaxH3RequestBody(
        input({
          mode: 'reference',
          referenceImageMediaIds: ['image-1', 'image-2'],
          referenceVideoMediaIds: ['motion-1'],
          referenceAudioMediaIds: ['audio-1'],
          params: { ratio: '16:9', duration: 8, resolution: '2K' }
        }),
        resolveMedia
      )
    ).resolves.toMatchObject({
      ratio: '16:9',
      duration: 8,
      resolution: '2K',
      content: [
        { type: 'text', text: '角色转身，镜头推进' },
        { type: 'image_url', image_url: { url: 'data:test/image-1' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'data:test/image-2' }, role: 'reference_image' },
        { type: 'video_url', video_url: { url: 'data:test/motion-1' }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: 'data:test/audio-1' }, role: 'reference_audio' }
      ]
    })
  })
})
