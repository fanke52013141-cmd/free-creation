/**
 * Flow Agent 运行控制的**共享宿主端口**（F8）。
 *
 * 为什么需要它：内部 Agent 运行由 `registerFlowAgentsIpc` 启动时创建的那一个
 * `FlowAgentDesktopHost` 实例独占——它持有模型端口、命令交付通道与在途运行表。
 * 外部入口如果另建一个实例，就会出现"两个权威"：两边各自认为自己拥有该任务，
 * 账本与运行事实互相覆盖。因此这里只做**发布/获取同一个实例的窄接口**，
 * 外部操作一律经由它调用，绝不 new 第二个宿主。
 *
 * 安全边界：
 * - 端口只暴露 run/pause/stop 与"模型工具调用预检"，不暴露命令派发、租约、账本写口；
 * - 端口在应用启动、flowAgents IPC 注册完成后发布；未发布时外部调用返回
 *   FLOW_AGENTS_UNAVAILABLE（如实拒绝，不降级成本地替身）；
 * - 谁可以调用由 agent-access 的传输与授权决定（本地受控套接字 + 授权门禁），
 *   端口自身不承担鉴权，也不扩大 GUI 内部发送者校验的语义。
 */
export interface FlowAgentAccessPort {
  /** 与 GUI 面板完全同一运行入口；raw 由调用方按 FlowAgentRunSchema 构造。 */
  run(raw: unknown): Promise<unknown>
  pause(query: { projectId: string; nodeId: string }): unknown
  stop(query: { projectId: string; nodeId: string }): unknown
  /**
   * 与 IPC 入口同一模型能力预检：技能范围内所有 Agent/审核模型必须已通过工具调用验证。
   * 预检失败发生在任何模型请求之前（付费路径的第一道闸门）。
   */
  assertAgentScopeToolCalling(projectId: string, nodeId: string): Promise<void>
}

let published: FlowAgentAccessPort | null = null

/** 由 main 在 flowAgents IPC 注册完成后调用一次（应用生命周期内只有一个实例）。 */
export function publishFlowAgentAccessPort(port: FlowAgentAccessPort): void {
  published = port
}

/** 读取共享宿主端口；未发布（例如非桌面启动阶段）时返回 null。 */
export function flowAgentAccessPort(): FlowAgentAccessPort | null {
  return published
}

/** 仅测试使用：清空发布状态，避免用例之间串台。 */
export function resetFlowAgentAccessPortForTest(): void {
  published = null
}
