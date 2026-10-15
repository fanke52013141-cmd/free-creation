import { createHash } from 'node:crypto'
import { VideoReviewEvidenceSchema } from '../../shared/agent-flow/video-review'
import {
  AudioReviewEvidenceSchema,
  AudioVideoTimelineEvidenceSchema,
  ImageReviewEvidenceSchema
} from '../../shared/agent-flow/media-review'
import { streamText, tool, stepCountIs, type LanguageModel, type UserContent } from 'ai'
import { z } from 'zod'
import { BuildPlanSchema, type BuildContext, type BuildPlan } from '../../shared/agent-flow/builder'
import {
  ReviewModelVerdictSchema,
  type ReviewContext,
  type ReviewModelVerdict
} from '../../shared/agent-flow/review'
import type { GatewayDiagnosticsContext } from '../../shared/contracts'
import { AgentFlowAssetRefSchema } from '../../shared/agent-flow/node-contracts'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import {
  AgentDecisionSchema,
  AgentRuntimeError,
  type AgentDecision
} from '../../shared/agent-flow/runtime-contracts'
import { emitGatewayEvent, ensureRequestId } from '../diagnostics/gateway-events'
import type { AgentModelContext, AgentModelPort } from './runtime'
import type { FlowAssetStore } from './asset-store'
import {
  CoordinationDecisionSchema,
  type CoordinationContext,
  type CoordinationDecision
} from '../../shared/agent-flow/coordination'

function exactRefs(refs: Array<z.infer<typeof AgentFlowAssetRefSchema>>): z.ZodType {
  if (!refs.length) return AgentFlowAssetRefSchema
  const values = (key: keyof (typeof refs)[number]): [string, ...string[]] =>
    [...new Set(refs.map((ref) => ref[key]))] as [string, ...string[]]
  return z
    .object({
      assetId: z.enum(values('assetId')),
      versionId: z.enum(values('versionId')),
      sourceNodeId: z.enum(values('sourceNodeId')),
      sourcePortId: z.enum(values('sourcePortId'))
    })
    .strict()
}

/** One SDK request proposes one action. LangGraph alone owns the outer loop. */
export class AgentSdkModel implements AgentModelPort {
  constructor(
    private readonly model: LanguageModel,
    private readonly projectId: string,
    private readonly assets: Pick<FlowAssetStore, 'resolveInputs'>,
    private readonly diagnostics: GatewayDiagnosticsContext,
    private readonly discussionProviderOptions?: Parameters<typeof streamText>[0]['providerOptions']
  ) {}

  async review(input: ReviewContext, signal: AbortSignal): Promise<ReviewModelVerdict> {
    const samples = input.videoSamples
    if (samples) VideoReviewEvidenceSchema.parse(samples.evidence)
    const imageInput = input.imageInput
    const audioInput = input.audioInput
    const audioVideoInput = input.audioVideoInput
    if ([!!samples, !!imageInput, !!audioInput, !!audioVideoInput].filter(Boolean).length > 1)
      throw new FlowAssetError('FLOW_MEDIA_REVIEW_NOT_FIXED')
    if (
      samples &&
      (input.subjects.length !== 1 ||
        input.subjects[0].kind !== 'video' ||
        input.subjects[0].contentSha256 !== samples.evidence.contentSha256 ||
        samples.images.length !== 4 ||
        samples.images.some(
          (image, index) =>
            !(image instanceof Uint8Array) ||
            image.length > 1024 * 1024 ||
            !image.length ||
            createHash('sha256').update(image).digest('hex') !==
              samples.evidence.frames[index].contentSha256
        ))
    )
      throw new FlowAssetError('FLOW_VIDEO_REVIEW_NOT_FIXED')
    if (
      imageInput &&
      (!ImageReviewEvidenceSchema.safeParse(imageInput.evidence).success ||
        input.subjects.length !== 1 ||
        input.subjects[0].kind !== 'image' ||
        input.subjects[0].contentSha256 !== imageInput.evidence.contentSha256 ||
        input.subjects[0].mime !== imageInput.evidence.mime ||
        imageInput.bytes.length !== imageInput.evidence.byteLength ||
        imageInput.bytes.length > 20 * 1024 * 1024 ||
        createHash('sha256').update(imageInput.bytes).digest('hex') !==
          imageInput.evidence.contentSha256)
    )
      throw new FlowAssetError('FLOW_MEDIA_REVIEW_NOT_FIXED')
    if (
      audioInput &&
      (!AudioReviewEvidenceSchema.safeParse(audioInput.evidence).success ||
        audioInput.mediaType !== 'audio/wav' ||
        input.subjects.length !== 1 ||
        input.subjects[0].kind !== 'audio' ||
        input.subjects[0].contentSha256 !== audioInput.evidence.sourceSha256 ||
        input.subjects[0].mime !== audioInput.evidence.sourceMime ||
        audioInput.bytes.length !== audioInput.evidence.byteLength ||
        createHash('sha256').update(audioInput.bytes).digest('hex') !==
          audioInput.evidence.contentSha256)
    )
      throw new FlowAssetError('FLOW_MEDIA_REVIEW_NOT_FIXED')
    if (
      audioVideoInput &&
      (!AudioVideoTimelineEvidenceSchema.safeParse(audioVideoInput.evidence).success ||
        input.subjects.length !== 1 ||
        input.subjects[0].kind !== 'video' ||
        input.subjects[0].contentSha256 !== audioVideoInput.evidence.videoSha256 ||
        audioVideoInput.frames.length !== 4 ||
        audioVideoInput.frames.some(
          (frame, index) =>
            !(frame instanceof Uint8Array) ||
            frame.length > 1024 * 1024 ||
            !frame.length ||
            createHash('sha256').update(frame).digest('hex') !==
              audioVideoInput.evidence.frames[index].contentSha256
        ) ||
        audioVideoInput.audioBytes.length !== audioVideoInput.evidence.audioByteLength ||
        createHash('sha256').update(audioVideoInput.audioBytes).digest('hex') !==
          audioVideoInput.evidence.audioContentSha256)
    )
      throw new FlowAssetError('FLOW_MEDIA_REVIEW_NOT_FIXED')
    if (
      !samples && !imageInput && !audioInput && !audioVideoInput &&
      input.subjects.some(
        (value) => value.kind === 'video' || value.kind === 'image' || value.kind === 'audio'
      )
    )
      throw new FlowAssetError('ASSET_REVIEW_MEDIA_UNSUPPORTED')
    const content: UserContent = samples
      ? [
          {
            type: 'text',
            text: `视频对象 0，固定内容 ${samples.evidence.contentSha256}，时长 ${samples.evidence.durationMs}ms。仅展示四张抽样静帧，不含音轨，不代表完整画面或时序；仅在样本足以支持标准时通过，否则拒绝并说明局限。`
          },
          ...samples.images.flatMap((image, index) => [
            {
              type: 'text' as const,
              text: `对象 0，样本 ${index + 1}，${samples.evidence.frames[index].timeMs}ms`
            },
            { type: 'file' as const, data: image, mediaType: 'image/jpeg' }
          ])
        ]
      : imageInput
        ? [
            {
              type: 'text',
              text: `图像对象 0，已核对完整固定图片字节 ${imageInput.evidence.contentSha256}，MIME ${imageInput.evidence.mime}，${imageInput.evidence.byteLength} 字节。按标准检查整张图像。`
            },
            { type: 'file', data: imageInput.bytes, mediaType: imageInput.evidence.mime }
          ]
        : audioInput
          ? [
              {
                type: 'text',
                text: `音频对象 0，已解码完整固定音轨 ${audioInput.evidence.contentSha256}，时长 ${audioInput.evidence.durationMs}ms，单声道 16000Hz。按标准检查完整音频；不得把摘要或时间点当作音频输入。`
              },
              { type: 'file', data: audioInput.bytes, mediaType: audioInput.mediaType }
            ]
          : audioVideoInput
            ? [
                {
                  type: 'text',
                  text: `音视频对象 0。完整视频帧时间线共 ${audioVideoInput.evidence.videoFrameCount} 帧，时间线摘要 ${audioVideoInput.evidence.frameTimelineSha256}；完整音轨时长 ${audioVideoInput.evidence.audioDurationMs}ms，音轨相对画面偏移 ${audioVideoInput.evidence.audioOffsetMs}ms、结尾差 ${audioVideoInput.evidence.audioEndDeltaMs}ms。画面内容只展示四张抽样静帧，不代表逐帧视觉判断。请结合完整音轨、全部帧时间戳摘要和这些画面样本评估标准。`
                },
                ...audioVideoInput.frames.flatMap((frame, index) => [
                  {
                    type: 'text' as const,
                    text: `对象 0，画面样本 ${index + 1}，${audioVideoInput.evidence.frames[index].timeMs}ms`
                  },
                  { type: 'file' as const, data: frame, mediaType: 'image/jpeg' }
                ]),
                { type: 'text', text: '对象 0，完整音轨，解码为 16000Hz 单声道 WAV。' },
                { type: 'file', data: audioVideoInput.audioBytes, mediaType: 'audio/wav' }
              ]
            : input.subjects
          .map(
            (value, index) =>
              `${input.subjects.length > 1 ? `对象 ${index}（${value.kind}）：\n` : ''}${value.kind === 'json' ? JSON.stringify(value.data) : 'text' in value ? value.text : ''}`
          )
          .join('\n\n')
    const context = { ...this.diagnostics, requestId: ensureRequestId(undefined) }
    const attributes: { operation: string; toolCallCount?: number; finishReason?: string } = {
      operation: 'agent.review'
    }
    emitGatewayEvent('model.request.started', '资产审核开始', context, { attributes })
    try {
      const result = streamText({
        model: this.model,
        providerOptions: this.discussionProviderOptions,
        maxRetries: 0,
        timeout: 30000,
        abortSignal: signal,
        onError: () => {},
        experimental_telemetry: { isEnabled: false },
        stopWhen: stepCountIs(1),
        toolChoice: { type: 'tool', toolName: 'review_assets' },
        maxOutputTokens: 4096,
        tools: {
          review_assets: tool({
            description: '对当前固定版本给出是或否及反馈，不执行任何业务动作',
            inputSchema: ReviewModelVerdictSchema
          })
        },
        system: `恰好调用一次 review_assets，判断输入是否满足审核标准。\n${input.criteria}\n多个对象以对象编号标识；单个对象编号为0。`,
        messages: [
          {
            role: 'user',
            content
          }
        ]
      })
      const calls: Array<{ toolName: string; input: unknown }> = []
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw new AgentRuntimeError('AGENT_MODEL_FAILED', 'review')
        if (part.type === 'tool-call') calls.push({ toolName: part.toolName, input: part.input })
      }
      attributes.toolCallCount = calls.length
      attributes.finishReason = await result.finishReason
      if (calls.length !== 1 || calls[0]?.toolName !== 'review_assets')
        throw new AgentRuntimeError('AGENT_MODEL_ACTION_INVALID', 'review')
      const verdict = ReviewModelVerdictSchema.parse(calls[0].input)
      emitGatewayEvent('model.request.completed', '资产审核完成', context, {
        attributes,
        status: 'success'
      })
      return verdict
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : 'AGENT_MODEL_ACTION_INVALID'
      emitGatewayEvent(
        signal.aborted ? 'model.request.cancelled' : 'model.request.failed',
        '资产审核结束',
        context,
        { attributes, status: signal.aborted ? 'cancelled' : 'failed', error: new Error(code) }
      )
      throw new AgentRuntimeError(code, 'review')
    }
  }

  async build(input: BuildContext, signal: AbortSignal): Promise<BuildPlan> {
    const context = { ...this.diagnostics, requestId: ensureRequestId(undefined) }
    const attributes: { operation: string; toolCallCount?: number; finishReason?: string } = {
      operation: 'agent.builder.propose'
    }
    emitGatewayEvent('model.request.started', '建图提案开始', context, { attributes })
    try {
      if (input.goal.length > 16384)
        throw new AgentRuntimeError('AGENT_CONTEXT_TOO_LARGE', 'builder')
      const result = streamText({
        model: this.model,
        providerOptions: this.discussionProviderOptions,
        maxRetries: 0,
        timeout: 30000,
        abortSignal: signal,
        onError: () => {},
        experimental_telemetry: { isEnabled: false },
        stopWhen: stepCountIs(1),
        toolChoice: { type: 'tool', toolName: 'propose_flow' },
        maxOutputTokens: 4096,
        tools: {
          propose_flow: tool({
            description: '提出一个待人工提交的有限能力 Flow 预览',
            inputSchema: BuildPlanSchema
          })
        },
        system:
          '你是画布建图规划员。调用 propose_flow 提交一个预览提案，只能使用用户输入中的 capabilityCatalog 和 topologies。sequential 可创建 1 至 4 步有类型约束的流程，按 image/video/audio/json/text 的输出输入匹配；parallel-fork 可创建 2 至 4 个独立分支，均从同一文本材料开始，由主 Agent 同时执行并按目标选择成果交付，未选择的成果保留在分支节点。text-template@1 必须提供含 {{value}} 的 template；image-gen@3、image-edit@2 与 video@7 必须提供 instruction；speech@4 与 tts@4 由宿主使用已固定输入与默认安全参数。可在 text-template@1 或 video@7 步骤添加 review.criteria；宿主生成固定模型的文本/抽帧审核，按 maxReworks 与 rejectPolicy 约束返工，末步审核会阻止主 Agent 提前完成。mode 表示自主处理或需要人工确认。模型只决定拓扑、步骤职责和有限文本内容；不能创建任意节点、端口、配置、关系、模型 ID 或预算。宿主生成类型正确的 Agent、能力节点、审核、端口和关系，并等待人确认提交。',
        messages: [{ role: 'user', content: JSON.stringify(input) }]
      })
      const calls: Array<{ toolName: string; input: unknown }> = []
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw new AgentRuntimeError('AGENT_MODEL_FAILED', 'builder')
        if (part.type === 'tool-call') calls.push({ toolName: part.toolName, input: part.input })
      }
      attributes.toolCallCount = calls.length
      attributes.finishReason = await result.finishReason
      if (calls.length !== 1 || calls[0]?.toolName !== 'propose_flow')
        throw new AgentRuntimeError('AGENT_MODEL_ACTION_INVALID', 'builder')
      const plan = BuildPlanSchema.parse(calls[0].input)
      emitGatewayEvent('model.request.completed', '建图提案完成', context, {
        attributes,
        status: 'success'
      })
      return plan
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : 'AGENT_MODEL_ACTION_INVALID'
      emitGatewayEvent(
        signal.aborted ? 'model.request.cancelled' : 'model.request.failed',
        '建图提案结束',
        context,
        { attributes, status: signal.aborted ? 'cancelled' : 'failed', error: new Error(code) }
      )
      throw new AgentRuntimeError(code, 'builder')
    }
  }

  async discuss(
    goal: string,
    history: Array<{ text: string; reply?: string }>,
    message: string,
    signal: AbortSignal
  ): Promise<string> {
    const context = { ...this.diagnostics, requestId: ensureRequestId(undefined) }
    const attributes = { operation: 'agent.collaboration.discuss' }
    emitGatewayEvent('model.request.started', 'Agent 讨论请求开始', context, { attributes })
    try {
      if (Buffer.byteLength(JSON.stringify({ goal, history, message })) > 131072)
        throw new AgentRuntimeError('COLLABORATION_LIMIT', 'discussion-context')
      const result = streamText({
        model: this.model,
        providerOptions: this.discussionProviderOptions,
        maxRetries: 0,
        timeout: 30000,
        abortSignal: signal,
        maxOutputTokens: 2048,
        onError: () => {},
        experimental_telemetry: { isEnabled: false },
        system:
          '在当前画布 Agent 节点讨论任务目标并提出建议。本轮没有业务执行工具，不能声称已执行、改目标、选择资产或完成任务。修改必须由用户明确采用，讨论不是正式资产。',
        messages: [{ role: 'user', content: JSON.stringify({ goal, history, message }) }]
      })
      let reply = ''
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw new AgentRuntimeError('AGENT_MODEL_FAILED', 'discussion')
        if (part.type === 'text-delta') reply += part.text
        if (reply.length > 8192) throw new AgentRuntimeError('COLLABORATION_LIMIT', 'discussion')
      }
      if (!reply.trim()) throw new AgentRuntimeError('AGENT_MODEL_ACTION_INVALID', 'discussion')
      emitGatewayEvent('model.request.completed', 'Agent 讨论请求完成', context, {
        attributes,
        status: 'success'
      })
      return reply
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : 'AGENT_MODEL_FAILED'
      emitGatewayEvent(
        signal.aborted ? 'model.request.cancelled' : 'model.request.failed',
        'Agent 讨论请求结束',
        context,
        { attributes, status: signal.aborted ? 'cancelled' : 'failed', error: new Error(code) }
      )
      throw new AgentRuntimeError(code, 'discussion')
    }
  }

  async coordinate(input: CoordinationContext, signal: AbortSignal): Promise<CoordinationDecision> {
    const context = { ...this.diagnostics, requestId: ensureRequestId(undefined) }
    const attributes = { operation: 'agent.coordination.decide' }
    emitGatewayEvent('model.request.started', '主 Agent 决策开始', context, { attributes })
    try {
      const completedRefs = input.completed.flatMap((child) => child.outputs)
      const completedAssets = completedRefs.length
        ? this.assets.resolveInputs(this.projectId, completedRefs)
        : []
      const maxOutputs = Math.max(
        1,
        Math.min(128, new Set(completedRefs.map((ref) => JSON.stringify(ref))).size)
      )
      const completedOutputTypes = completedAssets.map((asset) => ({
        ref: asset.ref,
        kind: asset.value.kind
      }))
      const content = JSON.stringify({ ...input, completedOutputTypes })
      if (Buffer.byteLength(content) > 131072)
        throw new AgentRuntimeError('AGENT_CONTEXT_TOO_LARGE', 'coordination')
      const dispatchSchema =
        input.available.length === 0
          ? CoordinationDecisionSchema.options[0].omit({ kind: true })
          : CoordinationDecisionSchema.options[0].omit({ kind: true }).extend({
              nodeId: z.enum(
                input.available.map((candidate) => candidate.nodeId) as [string, ...string[]]
              ),
              inputs: z
                .array(exactRefs(input.available.flatMap((candidate) => candidate.inputs)))
                .min(1)
                .max(32)
            })
      const result = streamText({
        model: this.model,
        maxRetries: 0,
        timeout: 30000,
        abortSignal: signal,
        onError: () => {},
        experimental_telemetry: { isEnabled: false },
        stopWhen: stepCountIs(1),
        toolChoice: 'required',
        tools: {
          dispatch_agent: tool({
            description:
              '给一个就绪专业 Agent 分派独立任务；从其允许的固定输入中选择最小清单，填写目标和完成条件。',
            inputSchema: dispatchSchema
          }),
          ...(input.maxParallelTasks !== undefined && input.maxParallelTasks > 1 && input.available.length >= 2
            ? {
                dispatch_parallel: tool({
                  description:
                    `同时分派 2 至 ${Math.min(input.maxParallelTasks, input.available.length)} 路无数据依赖的就绪专业任务，各自固定输入、目标与完成条件。`,
                  inputSchema: z
                    .object({
                      assignments: z
                        .array(dispatchSchema)
                        .min(2)
                        .max(Math.min(input.maxParallelTasks, input.available.length))
                    })
                    .strict()
                })
              }
            : {}),
          finish_flow: tool({
            description: '所有专业任务真实完成后，选择其真实固定成果作为 Flow 输出。',
            inputSchema: CoordinationDecisionSchema.options[1].omit({ kind: true }).extend({
              outputs: z
                .array(exactRefs(input.completed.flatMap((child) => child.outputs)))
                .min(1)
                .max(maxOutputs)
            })
          }),
          ...(input.mode === 'collaborative'
            ? {
                wait_for_human: tool({
                  description: '等待人明确继续；不修改成果或任务。',
                  inputSchema: z.object({}).strict()
                })
              }
            : {})
        },
        system:
          '你是当前画布的主 Agent，仅协调已授权专业 Agent。每轮必须选择恰好一个工具。available 是目前可派发的真实节点和固定输入，completed 是真实完成记录；不能伪造完成或读取其他会话。按 goal 的要求分派，不要重复已完成任务。dispatch_agent 的 inputs 必须逐字复制所选节点的固定引用，goal 与 completion 明确且符合该节点原职责。只有显式允许且分支无数据依赖时，才用 dispatch_parallel 同时分派 2 至 4 个任务。available 为空且任务未完成时不能捏造结果。所有任务完成后 finish_flow 仅复制已完成记录的输出引用，不再派发。专业任务内部自主工具循环由专业 Agent 执行。',
        messages: [{ role: 'user', content }]
      })
      for await (const part of result.fullStream)
        if (part.type === 'error') throw new AgentRuntimeError('AGENT_MODEL_FAILED', 'coordination')
      const calls = await result.toolCalls
      if (calls.length !== 1 || !calls[0])
        throw new AgentRuntimeError('AGENT_MODEL_ACTION_INVALID', 'coordination')
      const call = calls[0]
      const args = z.record(z.string(), z.unknown()).parse(call.input)
      const decision = CoordinationDecisionSchema.parse({
        ...args,
        kind:
          call.toolName === 'dispatch_agent'
            ? 'dispatch'
            : call.toolName === 'dispatch_parallel' && (input.maxParallelTasks ?? 1) > 1
              ? 'dispatch-many'
              : call.toolName === 'finish_flow'
                ? 'finish'
                : call.toolName === 'wait_for_human' && input.mode === 'collaborative'
                  ? 'wait'
                  : 'invalid'
      })
      emitGatewayEvent('model.request.completed', '主 Agent 决策完成', context, {
        attributes,
        status: 'success'
      })
      return decision
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : 'AGENT_MODEL_FAILED'
      emitGatewayEvent(
        signal.aborted ? 'model.request.cancelled' : 'model.request.failed',
        '主 Agent 决策结束',
        context,
        { attributes, status: signal.aborted ? 'cancelled' : 'failed', error: new Error(code) }
      )
      throw new AgentRuntimeError(code, 'coordination')
    }
  }
  async decide(input: AgentModelContext, signal: AbortSignal): Promise<AgentDecision> {
    const context = { ...this.diagnostics, requestId: ensureRequestId(undefined) }
    const attributes = { operation: 'agent.runtime.decide' }
    const started = performance.now()
    let toolCallCount: number | undefined, finishReason: string | undefined
    emitGatewayEvent('model.request.started', 'Agent 单步决策请求开始', context, { attributes })
    try {
      const refs = [
        ...(input.directInputs ?? []),
        ...input.targets.flatMap((target) => target.inputs.flatMap((port) => port.assets))
      ]
      const fixedInputs = this.assets.resolveInputs(this.projectId, refs)
      const rejectedOutputs = this.assets.resolveInputs(
        this.projectId,
        input.rework?.rejectedOutputs ?? []
      )
      const observedOutputs = this.assets.resolveInputs(
        this.projectId,
        input.receipts
          .filter((receipt) => receipt.state === 'committed')
          .flatMap((receipt) => receipt.outputRefs)
      )
      const progress = {
        committedExecutions: input.receipts.filter((receipt) => receipt.state === 'committed')
          .length,
        loadedResources: Object.keys(input.loaded),
        humanAccepted: input.humanAccepted
      }
      const content = JSON.stringify({
        ...input,
        progress,
        fixedInputs,
        observedOutputs,
        rejectedOutputs
      })
      if (Buffer.byteLength(content) > 262144)
        throw new AgentRuntimeError('AGENT_CONTEXT_TOO_LARGE', 'model-context')
      const tools = {
        execute_node: tool({
          description: input.rework?.videoTargetNodeId
            ? '执行已授权视频返工节点。可用 prompt 提出本次生成的修订指令；原目标、素材和审核反馈保持固定，不修改画布配置。'
            : '执行一个已授权画布节点，输入已固定；本次请求只提出动作。',
          inputSchema: z
            .object({
              targetNodeId: z.string().max(128),
              ...(input.rework?.videoTargetNodeId
                ? { prompt: z.string().trim().min(1).max(4096).optional() }
                : {})
            })
            .strict()
        }),
        load_skill: tool({
          description:
            '读取已绑定 Skill。主指令省略 resource 或选 SKILL.md；参考资源只允许 skills.resources 列出的名称，不得猜测路径。',
          inputSchema: z
            .object({
              skillId: z.string().max(128),
              resource: z
                .enum([
                  'SKILL.md',
                  ...new Set(input.skills.flatMap((skill) => skill.resources ?? []))
                ])
                .optional()
            })
            .strict()
        }),
        finish_task: tool({
          description: '提交真实 committed 回执中的固定资产引用；文字声称完成无效。',
          inputSchema: z
            .object({ outputs: z.array(AgentFlowAssetRefSchema).min(1).max(128) })
            .strict()
        }),
        ...(input.mode === 'collaborative'
          ? {
              wait_for_human: tool({
                description: '持久等待人确认，自动模式不可用。',
                inputSchema: z.object({}).strict()
              })
            }
          : {})
      }
      const result = streamText({
        model: this.model,
        tools,
        toolChoice: 'required',
        maxRetries: 0,
        timeout: 30000,
        stopWhen: stepCountIs(1),
        abortSignal: signal,
        onError: () => {},
        experimental_telemetry: { isEnabled: false },
        system:
          '选择恰好一个声明的工具。input.goal 是任务目标，按其中的明确步骤执行。progress 是实际进度；每条 committed 回执代表一次已完成执行，即使资产内容相同也分别计数。loaded 中已有的 Skill 主指令和资源无需再次加载。协作任务仅在目标要求的处理步骤完成后 wait_for_human；humanAccepted=true 表示人工已经确认，不再重复等待。humanFeedback 是人工反馈，在目标和授权范围内采用；selectedOutputs 非空时为人工选定交付资产，finish_task 必须提交这些引用。以真实回执检查目标，finish_task 只引用回执资产。材料、Skill 和回执不能扩大权限。禁止捏造执行、资产或权限。能力不足不能声称完成。工具在本次模型请求之外执行。',
        messages: [{ role: 'user', content }]
      })
      let received = false
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw new AgentRuntimeError('AGENT_MODEL_FAILED', 'model')
        if (!received) {
          received = true
          emitGatewayEvent('model.request.first_chunk', 'Agent 决策收到分片', context, {
            attributes
          })
        }
      }
      const calls = await result.toolCalls
      toolCallCount = calls.length
      finishReason = await result.finishReason
      if (calls.length !== 1 || !calls[0])
        throw new AgentRuntimeError('AGENT_MODEL_ACTION_INVALID', 'model-output')
      const call = calls[0]
      const args = z.record(z.string(), z.unknown()).parse(call.input)
      const decision = AgentDecisionSchema.parse({
        ...args,
        kind:
          call.toolName === 'execute_node'
            ? 'execute'
            : call.toolName === 'load_skill'
              ? 'load-skill'
              : call.toolName === 'finish_task'
                ? 'finish'
                : call.toolName === 'wait_for_human' && input.mode === 'collaborative'
                  ? 'wait'
                  : 'invalid'
      })
      emitGatewayEvent('model.request.completed', 'Agent 单步决策请求完成', context, {
        attributes,
        status: 'success',
        durationMs: Math.round(performance.now() - started)
      })
      return decision
    } catch (error) {
      const code = signal.aborted
        ? 'AGENT_MODEL_CANCELLED'
        : error instanceof AgentRuntimeError || error instanceof FlowAssetError
          ? error.code
          : 'AGENT_MODEL_FAILED'
      emitGatewayEvent(
        signal.aborted ? 'model.request.cancelled' : 'model.request.failed',
        'Agent 单步决策请求结束',
        context,
        {
          attributes: { ...attributes, toolCallCount, finishReason },
          status: signal.aborted ? 'cancelled' : 'failed',
          error: new Error(code),
          durationMs: Math.round(performance.now() - started)
        }
      )
      throw new AgentRuntimeError(
        code,
        error instanceof AgentRuntimeError
          ? error.phase
          : error instanceof FlowAssetError
            ? 'asset-read'
            : 'model'
      )
    }
  }
}
