/**
 * 浏览器安全的 Capability Registry 入口。
 *
 * 渲染进程只需要读取节点运行时契约，不能通过完整 `@capabilities` barrel
 * 间接引入生成器；后者会连接 MCP/主进程依赖，进而把原生 Node 模块带入
 * 浏览器构建。这里仅加载定义注册副作用和查询 API。
 */
import './definitions'

export { getCapabilityByNodeType } from './registry'
export type { CapabilityPort } from './types'
