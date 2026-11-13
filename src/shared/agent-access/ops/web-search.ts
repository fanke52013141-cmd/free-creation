import { z } from 'zod'

/**
 * C2 受控联网搜索外部 op（CLI/MCP 自动派生）。
 *
 * 安全契约与 provider-network 同口径：
 * - **默认不执行**：必须显式 `confirmNetwork: true`，否则拒绝（NETWORK_CONFIRM_REQUIRED），
 *   绝不因调用方漏传而发请求；搜索按次消耗供应方额度（可能计费），额外要求 `confirmCost: true`；
 * - 外部**不提供密钥、地址或鉴权头**：密钥由 main 从设备密钥库按 well-known 连接 id 读取；
 * - 端点为官方文档核实的真实供应方地址（main/gateway/doubao-search.ts），禁止替换任何临时代理；
 * - 本 op 直接返回搜索结果（不做资产结算）；agent 内部 web.search@1 工具的固定资产候选
 *   路径不变，两条路径共用同一客户端与脱敏事件。
 */
export const WEB_SEARCH_OPERATIONS = {
  'webSearch.run': {
    effect: 'execute',
    description:
      '受控联网搜索（豆包 web_search，官方真实端点）：必须同时显式 confirmNetwork=true 与 confirmCost=true 才执行，否则拒绝且不发任何请求；密钥由 main 从设备密钥库读取（well-known 连接 doubao-search），外部不提供密钥或地址；返回标题/链接/摘要等结构化结果，不含请求报文或密钥',
    input: z
      .object({
        query: z.string().min(1).max(500),
        count: z.number().int().min(1).max(20).optional(),
        confirmNetwork: z.boolean().optional(),
        confirmCost: z.boolean().optional()
      })
      .strict()
  }
} as const

export const WEB_SEARCH_OUTPUTS = {
  'webSearch.run': z
    .object({
      query: z.string().max(500),
      resultCount: z.number().int().nonnegative(),
      items: z
        .array(
          z
            .object({
              title: z.string().max(1000),
              url: z.string().max(2000),
              summary: z.string().max(4000),
              siteName: z.string().max(200),
              publishTime: z.string().max(60),
              authInfoLevel: z.number().int().min(0).max(4)
            })
            .strict()
        )
        .max(20)
    })
    .strict()
} as const