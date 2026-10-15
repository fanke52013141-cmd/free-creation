import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { AgentSdkModel } from '../src/main/agent-flow/runtime-model'
import { BuildPlanSchema, FLOW_BUILDER_CAPABILITY_CATALOG } from '../src/shared/agent-flow/builder'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'
import { readFileSync } from 'node:fs'
afterEach(() => setGatewayEventSink(null))
function fixture(name: string, args: unknown, empty = false) {
  const requests: Record<string, unknown>[] = [],
    events: DiagnosticsEventInput[] = []
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  const model = createOpenAICompatible({
    name: 'fixture',
    baseURL: 'http://localhost/v1',
    fetch: async (_, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const chunk = (delta: unknown, finish_reason: string | null) =>
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }]
        })
      return new Response(
        `data: ${chunk(empty ? { role: 'assistant', content: '' } : { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null)}\n\ndata: ${chunk({}, 'tool_calls')}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
  }).chatModel('fixture')
  const assets = { resolveInputs: vi.fn(() => []) }
  const port = new AgentSdkModel(
    model,
    'p',
    assets,
    { projectId: 'p', nodeId: 'node', taskId: 'task', traceId: 'trace', spanId: 'span' },
    { fixture: { thinking: { type: 'disabled' } } }
  )
  return { port, requests, events, assets }
}
it('single-result builder uses a named proposal tool and logs no goal or material', async () => {
  const plan = {
    title: '流程',
    steps: [{ title: '步骤', goal: '加工并交付', mode: 'autonomous', template: '{{value}}' }]
  }
  const f = fixture('propose_flow', plan)
  expect(
    await f.port.build(
      {
        goal: 'private-sdk-goal',
        capabilityCatalog: FLOW_BUILDER_CAPABILITY_CATALOG,
        topologies: ['sequential', 'parallel-fork']
      },
      new AbortController().signal
    )
  ).toEqual(BuildPlanSchema.parse(plan))
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].tool_choice).toEqual({
    type: 'function',
    function: { name: 'propose_flow' }
  })
  expect(f.assets.resolveInputs).not.toHaveBeenCalled()
  expect(f.events.map((e) => e.event)).toEqual(['model.request.started', 'model.request.completed'])
  expect(JSON.stringify(f.events)).not.toContain('private-sdk-goal')
})
it('review accepts a negative verdict as a valid result, sends complete text/JSON and excludes bodies from diagnostics', async () => {
  const verdict = {
    passed: false,
    feedback: 'private-sdk-feedback',
    issues: [{ subjectIndex: 0, feedback: '补标题' }]
  }
  const f = fixture('review_assets', verdict)
  expect(
    await f.port.review(
      {
        criteria: 'private-sdk-criteria',
        subjects: [
          { kind: 'text', text: 'private-sdk-material' },
          { kind: 'json', data: { full: 'private-sdk-json' } }
        ]
      },
      new AbortController().signal
    )
  ).toEqual(verdict)
  const request = JSON.stringify(f.requests)
  for (const word of ['private-sdk-material', 'private-sdk-json', 'private-sdk-criteria'])
    expect(request).toContain(word)
  expect(f.events.map((e) => e.event)).toEqual(['model.request.started', 'model.request.completed'])
  expect(JSON.stringify(f.events)).not.toContain('private-sdk')
})
it('empty tool terminal and forged schema cannot become a build or an approval', async () => {
  const f = fixture('review_assets', {}, true)
  await expect(
    f.port.review(
      { criteria: '标准', subjects: [{ kind: 'text', text: '材料' }] },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'AGENT_MODEL_ACTION_INVALID' })
  expect(f.events.map((e) => e.event)).toEqual(['model.request.started', 'model.request.failed'])
  expect(f.events.at(-1)?.attributes).toMatchObject({ toolCallCount: 0 })
  const forged = fixture('review_assets', { passed: 'yes', feedback: 'bad', issues: [] })
  await expect(
    forged.port.review(
      { criteria: '标准', subjects: [{ kind: 'text', text: '材料' }] },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'AGENT_MODEL_ACTION_INVALID' })
})

it('sends exactly four ordered image parts with sample labels and keeps image bytes out of diagnostics', async () => {
  const bytes = Uint8Array.from([255, 216, 255, 0, 255, 217]),
    digest = createHash('sha256').update(bytes).digest('hex')
  const input = {
    criteria: 'private-sdk-video-rule',
    subjects: [
      {
        kind: 'video' as const,
        mediaId: 'video',
        mediaPath: 'projects/p/media/video.mp4',
        mime: 'video/mp4',
        contentSha256: 'a'.repeat(64)
      }
    ],
    videoSamples: {
      images: [bytes, bytes, bytes, bytes],
      evidence: {
        method: 'four-frames-v1' as const,
        durationMs: 1000,
        contentSha256: 'a'.repeat(64),
        frames: [0, 250, 500, 750].map((timeMs) => ({ timeMs, contentSha256: digest }))
      }
    }
  }
  const f = fixture('review_assets', {
    passed: true,
    feedback: 'private-sdk-video-feedback',
    issues: []
  })
  await f.port.review(input, new AbortController().signal)
  const body = JSON.stringify(f.requests)
  expect(body.match(/data:image\/jpeg;base64,/g)).toHaveLength(4)
  expect(body).toContain('750ms')
  const diagnostics = JSON.stringify(f.events)
  expect(diagnostics).not.toContain(Buffer.from(bytes).toString('base64'))
  expect(diagnostics).not.toContain('private-sdk')
  expect(f.events.map((event) => event.event)).toEqual([
    'model.request.started',
    'model.request.completed'
  ])
  const rejected = fixture('review_assets', { passed: true, feedback: 'wrong', issues: [] })
  await expect(
    rejected.port.review(
      {
        ...input,
        videoSamples: { ...input.videoSamples, images: [Uint8Array.from([1]), bytes, bytes, bytes] }
      },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'FLOW_VIDEO_REVIEW_NOT_FIXED' })
  expect(rejected.requests).toHaveLength(0)
})

it('sends complete image, audio and audiovisual media bytes as provider file parts', async () => {
  const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYawAAAAASUVORK5CYII=',
      'base64'
    ),
    audioBytes = readFileSync('test/fixtures/agent-audio.wav'),
    jpeg = Uint8Array.from([255, 216, 255, 0, 255, 217]),
    sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

  const image = fixture('review_assets', { passed: true, feedback: 'private-image-feedback', issues: [] })
  await image.port.review(
    {
      criteria: 'private-image-criteria',
      subjects: [
        {
          kind: 'image',
          mediaId: 'image',
          mediaPath: 'projects/p/media/image.png',
          mime: 'image/png',
          contentSha256: sha(imageBytes)
        }
      ],
      imageInput: {
        bytes: imageBytes,
        evidence: {
          method: 'full-image-v1',
          contentSha256: sha(imageBytes),
          mime: 'image/png',
          byteLength: imageBytes.length
        }
      }
    },
    new AbortController().signal
  )
  expect(JSON.stringify(image.requests)).toContain(imageBytes.toString('base64'))
  expect(JSON.stringify(image.events)).not.toContain(imageBytes.toString('base64'))

  const audio = fixture('review_assets', { passed: true, feedback: 'private-audio-feedback', issues: [] })
  await audio.port.review(
    {
      criteria: 'private-audio-criteria',
      subjects: [
        {
          kind: 'audio',
          mediaId: 'audio',
          mediaPath: 'projects/p/media/audio.wav',
          mime: 'audio/wav',
          contentSha256: 'a'.repeat(64)
        }
      ],
      audioInput: {
        bytes: audioBytes,
        mediaType: 'audio/wav',
        evidence: {
          method: 'full-audio-v1',
          sourceSha256: 'a'.repeat(64),
          contentSha256: sha(audioBytes),
          sourceMime: 'audio/wav',
          durationMs: 1000,
          sampleRate: 16000,
          channels: 1,
          byteLength: audioBytes.length
        }
      }
    },
    new AbortController().signal
  )
  expect(JSON.stringify(audio.requests)).toContain(audioBytes.toString('base64'))
  expect(JSON.stringify(audio.events)).not.toContain(audioBytes.toString('base64'))

  const audiovisual = fixture('review_assets', {
    passed: true,
    feedback: 'private-av-feedback',
    issues: []
  })
  const avVideoSha = 'b'.repeat(64)
  await audiovisual.port.review(
    {
      criteria: 'private-av-criteria',
      subjects: [
        {
          kind: 'video',
          mediaId: 'video',
          mediaPath: 'projects/p/media/video.mp4',
          mime: 'video/mp4',
          contentSha256: avVideoSha
        }
      ],
      audioVideoInput: {
        frames: [jpeg, jpeg, jpeg, jpeg],
        audioBytes,
        evidence: {
          method: 'audio-video-timeline-v1',
          videoSha256: avVideoSha,
          videoDurationMs: 1000,
          videoFrameCount: 8,
          frameTimelineSha256: 'c'.repeat(64),
          videoStartMs: 0,
          audioStartMs: 0,
          audioDurationMs: 1000,
          audioEndMs: 1000,
          audioOffsetMs: 0,
          audioEndDeltaMs: 0,
          audioContentSha256: sha(audioBytes),
          audioByteLength: audioBytes.length,
          frames: [0, 250, 500, 750].map((timeMs) => ({ timeMs, contentSha256: sha(jpeg) }))
        }
      }
    },
    new AbortController().signal
  )
  const avRequest = JSON.stringify(audiovisual.requests)
  expect(avRequest.match(/data:image\/jpeg;base64,/g)).toHaveLength(4)
  expect(avRequest).toContain(audioBytes.toString('base64'))
  expect(avRequest).toContain('完整视频帧时间线共 8 帧')
  const avDiagnostics = JSON.stringify(audiovisual.events)
  expect(avDiagnostics).not.toContain(audioBytes.toString('base64'))
  expect(avDiagnostics).not.toContain('private-av')
})

it('exposes a bounded parallel tool only when the coordinator explicitly enables two tasks', async () => {
  const ref = {
    assetId: 'asset',
    versionId: 'version',
    sourceNodeId: 'source',
    sourcePortId: 'out-text'
  }
  const available = ['first', 'second', 'third', 'fourth'].map((nodeId) => ({
    nodeId,
    goal: 'private-sdk-goal',
    inputs: [ref]
  }))
  const assignments = available.map((item) => ({ ...item, completion: 'private-sdk-completion' }))
  const f = fixture('dispatch_parallel', { assignments })
  const ctx = { goal: 'private-sdk-root', mode: 'autonomous' as const, available, completed: [] }
  expect(
    await f.port.coordinate({ ...ctx, maxParallelTasks: 4 }, new AbortController().signal)
  ).toEqual({ kind: 'dispatch-many', assignments })
  const tools = f.requests[0].tools as {
    function: {
      name: string
      parameters: { properties: { assignments: { minItems: number; maxItems: number } } }
    }
  }[]
  const batch = tools.find((tool) => tool.function.name === 'dispatch_parallel')!
  expect(batch.function.parameters.properties.assignments.minItems).toBe(2)
  expect(batch.function.parameters.properties.assignments.maxItems).toBe(4)
  expect(JSON.stringify(f.events)).not.toContain('private-sdk')
  const sequential = fixture('dispatch_agent', assignments[0])
  await sequential.port.coordinate(ctx, new AbortController().signal)
  expect(JSON.stringify(sequential.requests[0].tools)).not.toContain('dispatch_parallel')
})

it('allows a coordinator to select several same-kind completed assets', async () => {
  const refs = [1, 2, 3].map((index) => ({
    assetId: `asset-${index}`,
    versionId: `version-${index}`,
    sourceNodeId: `source-${index}`,
    sourcePortId: 'out-text'
  }))
  const f = fixture('finish_flow', { outputs: refs })
  f.assets.resolveInputs.mockReturnValue(
    refs.map((ref, index) => ({
      ref,
      value: { kind: 'text' as const, text: `completed-${index}` }
    }))
  )
  const result = await f.port.coordinate(
    {
      goal: 'select three valid outputs',
      mode: 'autonomous',
      available: [],
      completed: [{ nodeId: 'cohort', taskId: 'cohort-task', outputs: refs }]
    },
    new AbortController().signal
  )
  expect(result).toEqual({ kind: 'finish', outputs: refs })
  const finish = (f.requests[0].tools as Array<{
    function: { name: string; parameters: { properties: { outputs: { maxItems: number } } } }
  }>).find((tool) => tool.function.name === 'finish_flow')!
  expect(finish.function.parameters.properties.outputs.maxItems).toBe(3)
})
