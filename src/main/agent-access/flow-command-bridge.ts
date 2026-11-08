/**
 * Flow 命令账本的**共享权威端口**（F8 收官）。
 *
 * 为什么需要它：命令账本 `FlowCommandLedger` 只在 `registerFlowCommandsIpc` 里创建一次，
 * 渲染器的 `flow-commands:check/commit` 会校验 `owner_session` 必须是这个实例的会话；
 * grant 下发通道（`webContents.send(IPC.flowCommands.grant)`）也只在该闭包里。外部入口
 * 另建实例会出现"两个权威"：命令行永远无法被渲染器准入，或必须伪造内部会话。
 *
 * 因此这里只**发布/获取同一个实例的窄接口**：
 * - 只暴露 isActive / prepareExternal / send / abandonExternal；
 * - 不暴露账本本体、任意 prepare、check/commit 或 SQL 写口；
 * - 外部命令一律以 `principal='external'` 入库（main 侧 prepareExternal 决定，外部不可指定）；
 * - 未发布（非桌面启动阶段）时外部调用如实返回 FLOW_COMMANDS_UNAVAILABLE。
 *
 * 鉴权由 agent-access 的传输与授权决定；端口自身不承担鉴权，也不扩大 GUI 内部发送者校验。
 */
import type {
  CommandLookup,
  FlowCommandGrant,
  FlowCommandPrepareResult,
  FlowCommandReceipt,
  NodeExecuteCommand
} from '../../shared/agent-flow/commands'

export interface FlowCommandAccessPort {
  /** 目标项目是否就是当前活动画布（与内部命令桥的 attach 绑定一致）。 */
  isActive(projectId: string): boolean
  /** 用既有账本会话记录一条 `principal='external'` 的命令（内部调用默认行为不变）。 */
  prepareExternal(raw: NodeExecuteCommand): FlowCommandPrepareResult
  /** 只下发既有 grant：arm 超时 + webContents.send，等待/结算仍走既有账本。 */
  send(grant: FlowCommandGrant): void
  /** 外部主体放弃一条未开始的外部命令（仅 pending/unknown + admitted=0）。 */
  abandonExternal(input: CommandLookup): FlowCommandReceipt
}

let published: FlowCommandAccessPort | null = null

/** 由 registerFlowCommandsIpc 在账本与交付通道就绪后调用一次。 */
export function publishFlowCommandAccessPort(port: FlowCommandAccessPort): void {
  published = port
}

/** 读取共享命令端口；未发布（例如非桌面启动阶段）时返回 null。 */
export function flowCommandAccessPort(): FlowCommandAccessPort | null {
  return published
}

/** 仅测试使用：清空发布状态，避免用例之间串台。 */
export function resetFlowCommandAccessPortForTest(): void {
  published = null
}
