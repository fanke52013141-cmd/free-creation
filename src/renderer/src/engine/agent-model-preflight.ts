import { AgentNodeConfigSchema, ReviewNodeConfigSchema } from '@shared/agent-flow/node-contracts'

const supportedProtocols = new Set(['openai', 'openai-compatible', 'openrouter', 'toapis'])

/**
 * Check configured Agent decision models through the read-only local model catalog before
 * starting a workflow or saving a node run. Missing bindings are handled by the existing
 * task-state-aware guard so an already waiting task can still be explicitly continued.
 */
export async function preflightAgentDecisionModels(configs: unknown[]): Promise<string | null> {
  const modelIds: string[] = []
  for (const rawConfig of configs) {
    let value = rawConfig
    if (typeof rawConfig === 'string') {
      try {
        value = JSON.parse(rawConfig)
      } catch {
        return 'Agent 配置无效，请先修复节点设置。'
      }
    }
    const parsed = AgentNodeConfigSchema.safeParse(value)
    if (!parsed.success) return 'Agent 配置无效，请先修复节点设置。'
    const modelId = parsed.data.modelDefinitionId?.trim()
    if (modelId) modelIds.push(modelId)
  }
  if (modelIds.length === 0) return null

  const modelApi = typeof window === 'undefined' ? undefined : window.api?.models
  // Non-Electron unit fixtures may not expose the model catalog. The packaged app and
  // browser mock both provide it; keep those lightweight executor fixtures independent.
  if (!modelApi?.listDefinitions || !modelApi.listConnections) return null

  try {
    const [definitionsReply, connectionsReply] = await Promise.all([
      modelApi.listDefinitions(),
      modelApi.listConnections()
    ])
    if (!definitionsReply.ok || !connectionsReply.ok)
      return '无法核验所选文本模型，请检查模型设置后重试。'

    const connections = connectionsReply.data
    for (const modelId of modelIds) {
      const definition = definitionsReply.data.find((item) => item.id === modelId)
      if (
        !definition?.enabled ||
        !definition.capabilities.some((capability) => capability.operation === 'text.generate')
      )
        return '所选文本模型不可用，请检查模型设置。'
      if (definition.agentToolCallingValidation?.status !== 'verified')
        return '所选文本模型尚未验证 Agent 工具调用能力，请在模型管理中执行验证。'
      const connection = connections.find((item) => item.id === definition.connectionId)
      if (!connection?.enabled || !supportedProtocols.has(connection.protocol))
        return '所选文本模型不可用，请检查模型设置。'
    }
    return null
  } catch {
    return '无法核验所选文本模型，请检查模型设置后重试。'
  }
}

/**
 * Review execution resolves a text model too, but media review additionally requires a
 * previously verified input capability. Reject these combinations before the UI saves or
 * schedules a review run.
 */
export async function preflightReviewDecisionModels(configs: unknown[]): Promise<string | null> {
  const requirements: Array<{ modelId: string; image: boolean; audio: boolean }> = []
  for (const rawConfig of configs) {
    let value = rawConfig
    if (typeof rawConfig === 'string') {
      try {
        value = JSON.parse(rawConfig)
      } catch {
        return '审核配置无效，请先修复节点设置。'
      }
    }
    const parsed = ReviewNodeConfigSchema.safeParse(value)
    if (!parsed.success) return '审核配置无效，请先修复节点设置。'
    const modelId = parsed.data.modelDefinitionId?.trim()
    if (!modelId) return '请在审核节点设置中选择审核模型。'
    const mode = parsed.data.reviewMode ?? 'text-json'
    requirements.push({
      modelId,
      image: ['image', 'sampled-video', 'audio-video'].includes(mode),
      audio: ['audio', 'audio-video'].includes(mode)
    })
  }
  if (requirements.length === 0) return null

  const modelApi = typeof window === 'undefined' ? undefined : window.api?.models
  if (!modelApi?.listDefinitions || !modelApi.listConnections) return null

  try {
    const [definitionsReply, connectionsReply] = await Promise.all([
      modelApi.listDefinitions(),
      modelApi.listConnections()
    ])
    if (!definitionsReply.ok || !connectionsReply.ok)
      return '无法核验审核模型，请检查模型设置后重试。'

    for (const requirement of requirements) {
      const definition = definitionsReply.data.find((item) => item.id === requirement.modelId)
      if (
        !definition?.enabled ||
        !definition.capabilities.some((capability) => capability.operation === 'text.generate')
      )
        return '所选审核模型不可用，请检查模型设置。'
      const connection = connectionsReply.data.find((item) => item.id === definition.connectionId)
      if (!connection?.enabled || !supportedProtocols.has(connection.protocol))
        return '所选审核模型不可用，请检查模型设置。'
      const textCapability = definition.capabilities.find(
        (capability) => capability.operation === 'text.generate'
      )
      const validation = definition.validation['text.generate']?.status === 'verified'
      if (requirement.image && (!textCapability?.acceptedAssetKinds.includes('image') || !validation))
        return '所选审核模型未通过图像输入能力验证，请检查模型设置。'
      if (requirement.audio && (!textCapability?.acceptedAssetKinds.includes('audio') || !validation))
        return '所选审核模型未通过音频输入能力验证，请检查模型设置。'
      if (definition.agentToolCallingValidation?.status !== 'verified')
        return '所选审核模型尚未验证 Agent 工具调用能力，请在模型管理中执行验证。'
    }
    return null
  } catch {
    return '无法核验审核模型，请检查模型设置后重试。'
  }
}
