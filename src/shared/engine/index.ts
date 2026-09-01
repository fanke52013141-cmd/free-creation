// 共享执行引擎：renderer 和 main/headless 共用的节点执行基础设施（P3）
//
// 本模块只包含纯函数、类型定义和执行器，不依赖 React / tldraw / window.api。
// renderer 运行器注入 IPC GatewayClient；headless 运行器注入直调 GatewayClient。
export type { GatewayClient } from './gateway-client'
export type {
  NodeShape,
  CancelSignal,
  SubflowRequest,
  SubflowOutput,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor
} from './executor-types'
export type {
  NodeValue,
  RawNodeOutputs,
  MediaResultItem,
  MediaResultCollection
} from './values'
export {
  parseMediaResultCollection,
  serializeMediaResultCollection,
  appendMediaResult,
  parseStoredNodeValue,
  parseNodeRecord,
  parseStoredAiResult,
  parseStoredIterateResult,
  storyboardSummary,
  MEDIA_RESULT_LIMIT
} from './values'
export type {
  NodeValuePacket,
  ContractOutputs,
  ContractInputMap,
  ContractInputInjection
} from './inputs'
export {
  inputPackets,
  inputText,
  inputJson,
  inputMedia,
  inputValue
} from './inputs'
export type { ModelOption } from './models'
export { modelsByModality, findProvider, findTextModel } from './models'
export {
  parseJsonObj,
  normalizeShot,
  extractShots,
  mergedPrompt,
  promptBundleText,
  waitForChat,
  waitForVideo,
  parseVideoGen,
  findTextModelShared
} from './helpers'
export type {
  ShotShape,
  VariableValueType,
  ChatInput,
  VideoMedia,
  VideoGenData
} from './helpers'
export { readNodeConfig, usesNodeConfig, CONFIG_NODE_TYPES } from './node-config'
export type { ChatData, ChatDocument } from './chat-data'
export { parseChat } from './chat-data'
export { EXECUTOR_REGISTRY, getExecutor } from './executors'
