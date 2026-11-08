import { z } from 'zod'
import { ACTIVE_NODE_TYPE_IDS } from '../../types'
import { identifier } from './common'

/**
 * 节点类型契约目录（N1：查询类型、默认值、字段、端口与依赖）。
 *
 * 数据来源是**生成快照**（src/shared/agent-access/generated/node-contracts.generated.ts）：
 * 由 test/node-contracts-export.test.ts 在 jsdom 下加载真实节点注册表导出，普通测试运行时
 * 作为漂移门禁比对。这样 main/CLI 不需要导入 renderer 的 TSX 规格，也能如实回答
 * "这类节点有哪些端口、初始配置是什么、能不能创建、执行方式是什么"。
 *
 * 诚实边界：带动态端口的节点（`dynamicPorts: true`）导出的是**默认配置下**的端口；
 * 实例的真实端口请用 `node.get` 读取——不要据此猜动态配置后的端口。
 */
const portContract = z
  .object({
    id: z.string().max(80),
    dir: z.enum(['in', 'out']),
    type: z.string().max(40),
    required: z.boolean(),
    cardinality: z.enum(['one', 'many']),
    name: z.string().max(80).optional(),
    description: z.string().max(200).optional(),
    schema: z.string().max(120).optional()
  })
  .strict()

export const NODE_CATALOG_OPERATIONS = {
  'node.type.get': {
    effect: 'read',
    description:
      '读取某类节点的契约：契约版本、端口（输入/输出、类型、必填、基数、Schema）、初始配置、执行方式、输出真值来源与是否需要动态端口二次读取；不需要创建实例',
    input: z.object({ typeId: z.enum(ACTIVE_NODE_TYPE_IDS) }).strict()
  }
} as const

export const NODE_CATALOG_OUTPUTS = {
  'node.type.get': z
    .object({
      typeId: z.enum(ACTIVE_NODE_TYPE_IDS),
      contractVersion: z.number().int().min(1),
      label: z.string().max(120),
      description: z.string().max(2000),
      category: z.string().max(40),
      creatable: z.boolean(),
      defaultSize: z.object({ w: z.number(), h: z.number() }).strict(),
      sizePolicy: z.enum(['standard', 'content', 'free']),
      executionMode: z.enum(['auto', 'manual-publish', 'display-only']),
      outputSource: z.enum(['run', 'document']),
      executionDisabledReason: z.string().max(500).optional(),
      /** GUI 创建该类型节点时写入的初始配置（JSON 字符串）；无则 null。 */
      initialConfig: z.string().max(8000).nullable(),
      /** true 时 ports 只是默认配置下的结果，实例端口请用 node.get 读取。 */
      dynamicPorts: z.boolean(),
      ports: z
        .object({
          in: z.array(portContract).max(32),
          out: z.array(portContract).max(32)
        })
        .strict()
    })
    .strict()
} as const

/** 供其它模块复用的类型别名（避免从生成文件直接取类型）。 */
export type NodeCatalogPort = z.infer<typeof portContract>
export const NODE_CATALOG_TYPE_IDS = ACTIVE_NODE_TYPE_IDS
export const nodeTypeIdSchema = identifier
