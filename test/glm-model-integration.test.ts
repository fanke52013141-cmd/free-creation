import { afterEach, describe, expect, it, vi } from 'vitest'
import { glmCompatibleFetch, glmRequestBody } from '../src/main/gateway/glm-request'
import { flowInitialConfig } from '../src/shared/agent-flow/model-defaults'
import type { FeatureBinding } from '@free-creation/model-contracts'

afterEach(() => vi.unstubAllGlobals())
const url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
describe('GLM desktop integration', () => {
  it('enables thinking for both exact official models and preserves explicit effort and budgets', () => {
    for (const model of ['glm-5.3', 'glm-5.3-flash']) {
      const body = {
        model,
        max_tokens: 128,
        thinking: { type: 'disabled', clear_thinking: false },
        reasoning_effort: 'high'
      }
      expect(glmRequestBody(url, body)).toEqual({
        ...body,
        thinking: { type: 'enabled', clear_thinking: false }
      })
      expect(body.thinking.type).toBe('disabled')
      expect(glmRequestBody(url, { model }).reasoning_effort).toBe('low')
    }
  })
  it('leaves other providers, models and routes untouched', () => {
    const body = { model: 'glm-5.3' }
    for (const endpoint of [
      'https://relay.invalid/api/paas/v4/chat/completions',
      'https://open.bigmodel.cn.evil.invalid/api/paas/v4/chat/completions',
      'http://open.bigmodel.cn/api/paas/v4/chat/completions',
      'https://open.bigmodel.cn/api/paas/v4/images/generations'
    ]) {
      expect(glmRequestBody(endpoint, body)).toBe(body)
    }
    const other = { model: 'doubao-seed-2-1-turbo-260628' }
    expect(glmRequestBody(url, other)).toBe(other)
  })
  it('preserves the abort signal and headers and never retries a transport failure', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('transport failed'))
    vi.stubGlobal('fetch', transport)
    const signal = new AbortController().signal
    const headers = { Authorization: 'Bearer private-test-key' }
    await expect(
      glmCompatibleFetch(url, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({ model: 'glm-5.3', stream: true })
      })
    ).rejects.toThrow('transport failed')
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0][1]).toMatchObject({ headers, signal })
    expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'low'
    })
  })
  it('uses the local preference only for new Flow config and keeps explicit models and state machines', () => {
    const binding: FeatureBinding = {
      featureKey: 'agent.default',
      modelDefinitionId: 'local-glm-5.3',
      target: { connectionId: 'local-zhipu', modelId: 'glm-5.3', operation: 'text.generate' },
      enabled: true,
      overrides: {},
      updatedAt: '2026-10-14T00:00:00Z'
    }
    const config = '{"schemaVersion":1}'
    for (const type of ['agent', 'ai-review'])
      expect(JSON.parse(flowInitialConfig(type, config, [binding])).modelDefinitionId).toBe(
        binding.modelDefinitionId
      )
    const existing = '{"modelDefinitionId":"previous-model"}'
    expect(flowInitialConfig('agent', existing, [binding])).toBe(existing)
    expect(flowInitialConfig('state-machine', config, [binding])).toBe(config)
    expect(flowInitialConfig('agent', config, [{ ...binding, enabled: false }])).toBe(config)
    expect(flowInitialConfig('agent', config, [])).toBe(config)
  })
})
