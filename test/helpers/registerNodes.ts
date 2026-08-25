// 测试用节点注册辅助（路线图 R2）
//
// 在测试环境注册项目全部节点类型，供契约收集、快照、投影与执行器测试复用。
// 使用 jsdom 环境：specs/index.tsx 会间接拉入 bodies.tsx（React/tldraw），
// jsdom 提供 DOM 全局，使这些模块能在 Node 测试进程加载（仅加载，不渲染）。
//
// 注意：每个测试文件在顶层调用一次 registerAllNodeTypes() 即可；注册表是模块级
// 单例，重复注册同一类型会覆盖，不会报错。
import {
  registerBaseNodeTypes,
  registerExtendedNodeTypes,
  registerScriptNodeType
} from '@renderer/nodes/specs'

let initialized = false

export function registerAllNodeTypes(): void {
  if (initialized) return
  registerBaseNodeTypes()
  registerScriptNodeType()
  registerExtendedNodeTypes()
  initialized = true
}
