import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/shared/types'
import { flowTargetContract, flowTargetPorts } from '../src/shared/agent-flow/video-adapter'

/** REL-03 的 Agent 支持目标矩阵：执行器实际接入的节点类型与契约版本。 */
const SUPPORTED = [
  { type: 'processor', contractVersion: 1, inputs: ['in-value'], output: 'out-value' },
  {
    type: 'video',
    contractVersion: 7,
    inputs: ['in-text', 'in-prompt', 'in-images', 'in-reference-video', 'in-reference-audio'],
    output: 'out-video'
  },
  {
    type: 'image-gen',
    contractVersion: 3,
    inputs: ['in-images', 'in-prompt', 'in-text'],
    output: 'out-image'
  },
  { type: 'image-edit', contractVersion: 2, inputs: ['in-image', 'in-text'], output: 'out-image' },
  {
    type: 'speech',
    contractVersion: 4,
    inputs: ['in-text', 'in-voice', 'in-audio'],
    output: 'out-audio'
  },
  { type: 'tts', contractVersion: 4, inputs: ['in-audio'], output: 'out-json' }
] as const

const UNSUPPORTED_TYPES = [
  'text',
  'image',
  'video-clip',
  'sound-adjust',
  'video-audio',
  'audio',
  'speech-to-text',
  'chat',
  'json',
  'code',
  'storyboard',
  'ai-process',
  'agent',
  'state-machine',
  'ai-review'
]

function node(type: string, contractVersion: number, config: Record<string, unknown> = {}): CanvasNode {
  return {
    id: `shape:${type}`,
    type: type as CanvasNode['type'],
    contractVersion,
    title: type,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: { config: JSON.stringify(config) },
    content: { kind: 'text', text: '' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  }
}

describe('REL-03 Agent 支持目标矩阵', () => {
  it('支持的目标与端口和冻结矩阵完全一致', () => {
    for (const entry of SUPPORTED) {
      const contract = flowTargetContract(node(entry.type, entry.contractVersion))
      expect(contract, `${entry.type}@${entry.contractVersion} 应受支持`).not.toBeNull()
      expect(contract?.inputs).toEqual(entry.inputs)
      expect(contract?.output).toBe(entry.output)
      const ports = flowTargetPorts(node(entry.type, entry.contractVersion))
      const requiredInputs =
        entry.type === 'speech' ? entry.inputs.filter((portId) => portId !== 'in-audio') : entry.inputs
      for (const portId of requiredInputs) {
        expect(ports.some((port) => port.id === portId && port.dir === 'in'), `${entry.type} 缺少端口 ${portId}`).toBe(true)
      }
      expect(ports.some((port) => port.id === entry.output && port.dir === 'out')).toBe(true)
    }
  })

  it('旧契约版本不会被当作当前支持目标', () => {
    for (const entry of SUPPORTED) {
      const previous = flowTargetContract(node(entry.type, entry.contractVersion - 1))
      expect(previous, `${entry.type}@${entry.contractVersion - 1} 不应受支持`).toBeNull()
      const next = flowTargetContract(node(entry.type, entry.contractVersion + 1))
      expect(next, `${entry.type}@${entry.contractVersion + 1} 不应受支持`).toBeNull()
    }
  })

  it('旧手动媒体/数据处理节点不会被 Agent 伪装成支持目标', () => {
    for (const type of UNSUPPORTED_TYPES) {
      expect(flowTargetContract(node(type, 1)), `${type} 不应受支持`).toBeNull()
    }
  })

  it('speech 目标的输入端口随保存的后端收敛', () => {
    const minimax = flowTargetPorts(node('speech', 4, { backend: 'minimax' })).map((port) => port.id)
    expect(minimax).toContain('in-voice')
    expect(minimax).not.toContain('in-audio')

    const volc = flowTargetPorts(node('speech', 4, { backend: 'volc' })).map((port) => port.id)
    expect(volc).toContain('in-audio')
    expect(volc).not.toContain('in-voice')
  })
})
