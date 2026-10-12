import type { PortDecl } from '../types'

/** Same authoritative declaration used by the desktop registry and command authorization. */
export const PROCESSOR_CONTRACT_VERSION = 1
export const PROCESSOR_PORTS: { in: PortDecl[]; out: PortDecl[] } = {
  in: [
    {
      id: 'in-value',
      name: '输入变量',
      dir: 'in',
      type: 'any',
      description: '一个文本、JSON 或媒体资产值；此端口不接收多条连线。',
      required: false,
      cardinality: 'one',
      schema: undefined
    }
  ],
  out: [
    {
      id: 'out-value',
      name: '输出变量',
      dir: 'out',
      type: 'any',
      description: '透传时保留原值类型；取字段保留其文本或 JSON 类型；模板模式输出文本。',
      required: true,
      cardinality: 'one',
      schema: undefined
    }
  ]
}
