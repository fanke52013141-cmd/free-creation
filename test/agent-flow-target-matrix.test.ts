import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../src/shared/types'
import {
  codeFlowInputsValid,
  cropFlowConfigValid,
  flowTargetContract,
  flowTargetPorts,
  localImageFlowInputsValid,
  splitFlowConfigValid
} from '../src/shared/agent-flow/video-adapter'

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
  { type: 'tts', contractVersion: 4, inputs: ['in-audio'], output: 'out-json' },
  // P2-B：本地媒体与本地代码目标（code 限单参数单输出形态）。
  { type: 'image-crop', contractVersion: 2, inputs: ['in-image'], output: 'out-image' },
  { type: 'image-split', contractVersion: 3, inputs: ['in-image'], output: 'out-image' },
  {
    type: 'code',
    contractVersion: 3,
    inputs: ['in-param-input'],
    output: 'out-output',
    config: {
      source: 'async function main(args) { return args.input }',
      inputName: 'input',
      inputType: 'string',
      outputName: 'output',
      outputType: 'string',
      outputMode: 'single',
      params: [{ name: 'input', type: 'string' }]
    }
  }
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
      const contract = flowTargetContract(
        node(entry.type, entry.contractVersion, 'config' in entry ? entry.config : {})
      )
      expect(contract, `${entry.type}@${entry.contractVersion} 应受支持`).not.toBeNull()
      expect(contract?.inputs).toEqual(entry.inputs)
      expect(contract?.output).toBe(entry.output)
      const ports = flowTargetPorts(
        node(entry.type, entry.contractVersion, 'config' in entry ? entry.config : {})
      )
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

  it('P2-B：code 目标只接受单参数单输出形态，输入值类型与参数匹配', () => {
    const single = {
      source: 'async function main(args) { return args.input }',
      inputName: 'input',
      inputType: 'string',
      outputName: 'output',
      outputType: 'string',
      outputMode: 'single',
      params: [{ name: 'input', type: 'string' }]
    }
    expect(flowTargetContract(node('code', 3, single))?.inputs).toEqual(['in-param-input'])
    const fields = { ...single, outputMode: 'fields', outputs: [{ name: 'a', type: 'string' }] }
    expect(flowTargetContract(node('code', 3, fields))).toBeNull()
    const multiParams = { ...single, params: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }] }
    expect(flowTargetContract(node('code', 3, multiParams))).toBeNull()
    const image = { kind: 'image', mediaId: 'm1', mediaPath: 'p', mime: 'image/png', contentSha256: 'a'.repeat(64) }
    expect(
      codeFlowInputsValid(single, [
        { targetPortId: 'in-param-input', values: [{ kind: 'text', text: 'hello' }] }
      ])
    ).toBe(true)
    expect(
      codeFlowInputsValid(single, [
        { targetPortId: 'in-param-input', values: [image as never] }
      ])
    ).toBe(false)
    expect(localImageFlowInputsValid([{ targetPortId: 'in-image', values: [image as never] }])).toBe(true)
    expect(
      localImageFlowInputsValid([
        { targetPortId: 'in-image', values: [{ kind: 'text', text: 'x' } as never] }
      ])
    ).toBe(false)
    expect(
      cropFlowConfigValid({ version: 1, mode: 'rect', aspectRatio: 'free', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } })
    ).toBe(true)
    // parse 归一化把未知枚举/越界值收敛为安全默认（与主进程 IPC 完全一致），
    // 因此“无效配置”不存在——准入闸门拒绝的是非对象/坏 JSON。
    expect(
      cropFlowConfigValid({ mode: 'rect', rect: { x: 0.1, y: 0.1, width: 0, height: 0.5 } })
    ).toBe(true)
    // parseImageCropConfig 对坏字符串也容错为默认（真实准入在 JSON.parse 处已拒）；
    // 校验器拒绝的是非对象输入。
    expect(cropFlowConfigValid(42)).toBe(false)
    expect(cropFlowConfigValid(null)).toBe(false)
    expect(splitFlowConfigValid({ rows: 2, columns: 2, scalePercent: 100 })).toBe(true)
    expect(splitFlowConfigValid({ rows: 'bad', columns: null })).toBe(true)
    expect(splitFlowConfigValid(undefined)).toBe(false)
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
