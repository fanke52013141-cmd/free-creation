// MiniMax 复刻登记应答的解码（真跑回执的字段语义）。
//
// 上游在「参考音频被判定敏感」时依然回 HTTP 200 + base_resp 0，只有 input_sensitive
// 这一位能说明音色其实没登记。这类「信封说成功、语义说失败」的分支必须钉死，
// 否则节点会拿着一个不存在的 voice_id 去合成，报错落在离根因很远的地方。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../src/shared/types'
import { DEFAULT_TTS_CONFIG } from '../src/shared/tts'

const h = vi.hoisted(() => ({ queue: [] as Array<{ body: unknown; init?: number }> }))

const provider: ProviderConfig = {
  id: 'p-minimax',
  name: 'MiniMax（海螺）',
  specId: 'minimax',
  baseURL: 'https://api.minimaxi.com',
  apiKey: 'unused-in-this-test',
  models: [],
  createdAt: 0
}

vi.mock('../src/main/gateway/providers.repo', () => ({
  getProvider: (id: string) => (id === provider.id ? provider : undefined)
}))

function reply(body: unknown) {
  h.queue.push({ body })
}

async function clone(): Promise<string> {
  const { cloneMiniMaxVoice } = await import('../src/main/gateway/voice')
  return cloneMiniMaxVoice({
    providerId: provider.id,
    reference: { buf: Buffer.alloc(1024, 1), mime: 'audio/mpeg', fileName: 'ref.mp3' },
    config: { ...DEFAULT_TTS_CONFIG, backend: 'minimax', providerId: provider.id }
  })
}

beforeEach(() => {
  h.queue = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = h.queue.shift()
      if (!next) throw new Error('测试没有准备这一条应答')
      return new Response(JSON.stringify(next.body), {
        status: next.init ?? 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
  )
})

describe('cloneMiniMaxVoice 对回执的判定', () => {
  it('真跑成功回执：base_resp 0 且 input_sensitive false 时返回登记的 voice_id', async () => {
    reply({
      file: { file_id: 443402596741599, purpose: 'voice_clone' },
      base_resp: { status_code: 0 }
    })
    reply({
      input_sensitive: false,
      input_sensitive_type: 0,
      demo_audio: '',
      base_resp: { status_code: 0, status_msg: 'success' }
    })
    const voiceId = await clone()
    expect(voiceId).toMatch(/^canvas-voice-[0-9a-f]{20}$/)
  })

  it('input_sensitive 为真时不能当成成功，音色其实没有登记', async () => {
    reply({ file: { file_id: 1 }, base_resp: { status_code: 0 } })
    reply({
      input_sensitive: true,
      input_sensitive_type: 2,
      demo_audio: '',
      base_resp: { status_code: 0, status_msg: 'success' }
    })
    await expect(clone()).rejects.toThrow(/内容敏感/)
  })

  it('HTTP 200 里的 base_resp 非 0 仍是失败，并把上游话术带回来', async () => {
    reply({ file: { file_id: 1 }, base_resp: { status_code: 0 } })
    reply({ base_resp: { status_code: 2013, status_msg: 'invalid params' } })
    await expect(clone()).rejects.toThrow(/invalid params/)
  })
})
