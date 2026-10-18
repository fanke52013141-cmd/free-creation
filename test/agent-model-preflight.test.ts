import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  preflightAgentDecisionModels,
  preflightReviewDecisionModels
} from '../src/renderer/src/engine/agent-model-preflight'

const agentConfig = {
  schemaVersion: 1,
  role: 'specialist',
  interactionMode: 'autonomous',
  modelDefinitionId: 'model-1',
  skills: [],
  tools: [],
  allowedNodeIds: [],
  maxSteps: 4,
  relations: []
}

const reviewConfig = {
  schemaVersion: 1,
  rulesVersion: 'rules-1',
  modelDefinitionId: 'model-1',
  reviewMode: 'text-json',
  rejectPolicy: 'stop',
  maxReworks: 0,
  subjectSources: [],
  gatedNodeIds: [],
  relations: []
}

const definition = (agentToolCallingStatus?: string) => ({
  id: 'model-1',
  connectionId: 'connection-1',
  modelId: 'fixture-model',
  name: 'fixture',
  capabilities: [
    {
      operation: 'text.generate',
      asynchronous: false,
      streaming: true,
      acceptedAssetKinds: [],
      producedAssetKinds: [],
      controls: {}
    }
  ],
  validation: {},
  ...(agentToolCallingStatus ? { agentToolCallingValidation: { status: agentToolCallingStatus } } : {}),
  enabled: true,
  metadata: {}
})

const connection = {
  id: 'connection-1',
  name: 'fixture',
  protocol: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:5200/v1',
  auth: { type: 'none' },
  headers: {},
  enabled: true,
  metadata: {}
}

function exposeCatalog(agentStatus?: string): void {
  vi.stubGlobal('window', {
    api: {
      models: {
        listDefinitions: vi.fn(async () => ({ ok: true, data: [definition(agentStatus)] })),
        listConnections: vi.fn(async () => ({ ok: true, data: [connection] }))
      }
    }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Agent model admission preflight', () => {
  it('rejects a text-only model before Agent task admission', async () => {
    exposeCatalog()
    await expect(preflightAgentDecisionModels([agentConfig])).resolves.toContain(
      '尚未验证 Agent 工具调用能力'
    )
  })

  it('allows a model only after persistent Agent tool-call verification', async () => {
    exposeCatalog('verified')
    await expect(preflightAgentDecisionModels([agentConfig])).resolves.toBeNull()
  })

  it('applies the same tool-call gate to direct AI review execution', async () => {
    exposeCatalog('failed')
    await expect(preflightReviewDecisionModels([reviewConfig])).resolves.toContain(
      '尚未验证 Agent 工具调用能力'
    )
    exposeCatalog('verified')
    await expect(preflightReviewDecisionModels([reviewConfig])).resolves.toBeNull()
  })
})
