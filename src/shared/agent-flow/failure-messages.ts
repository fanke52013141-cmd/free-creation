const messages: Record<string, string> = {
  AGENT_ROLE_NOT_READY: '当前仅专业 Agent 可运行，请在设置中切换职责。',
  AGENT_MODEL_REQUIRED: '请在节点设置中选择决策模型。',
  AGENT_MODEL_UNAVAILABLE: '所选文本模型不可用，请检查模型设置。',
  AGENT_MODEL_KEY_UNAVAILABLE: '模型密钥不可用，请在模型设置中重新保存。',
  AGENT_MODEL_PROTOCOL: '当前模型连接协议未适配，请选择兼容的文本模型。',
  AGENT_MODEL_TOOL_UNVERIFIED: '模型的工具调用验证未通过，请检查连接或更换模型。',
  AGENT_GOAL_REQUIRED: '请先填写任务目标和交付条件。',
  AGENT_TOOL_REQUIRED: '请在节点设置中启用画布节点工具。',
  AGENT_TOOL_UNSUPPORTED: '所选工具尚未接入，请使用画布节点工具。',
  AGENT_TARGET_UNSUPPORTED: '当前工具只支持数据处理节点，请调整允许处理的节点。',
  AGENT_INPUT_TYPE_UNSUPPORTED: '当前任务只支持文本和 JSON 输入，请调整连线。',
  AGENT_INPUT_NOT_FIXED: '输入引用与固定资产不一致，请重新选择有效的资产版本。',
  AGENT_BUDGET_EXHAUSTED: '已达到任务预算，请核对成果并停止旧任务，再调整目标或步数。',
  AGENT_SESSION_LOST: '上次执行已中断，请核对记录并停止旧任务后重新启动。',
  AGENT_CANCELLED: '任务已停止。',
  AGENT_CANCELLED_OR_TIMED_OUT: '执行已取消或超时，请核对记录后重新启动。',
  SKILL_MISSING: '绑定的 Skill 版本不存在，请重新选择。',
  SKILL_DISABLED: '绑定的 Skill 已停用，请选择可用版本。',
  SKILL_TOOL_MISSING: 'Skill 所需工具未启用，请检查节点设置。',
  SKILL_RESOURCE_DENIED: 'Skill 请求了未声明的资源，任务已阻断，请检查版本和资源说明。',
  FLOW_REVISION_CONFLICT: '画布已发生变更，请停止旧任务后重新启动。',
  FLOW_PROJECT_INACTIVE: '请返回任务所属画布，再核对或继续。',
  ASSET_OUTPUT_UNAVAILABLE: '输入尚无可提交的结果，请检查来源节点并保存。',
  ASSET_SOURCE_OCCUPIED: '输入节点有未确认执行，请先核对原运行记录。'
}
export function flowAgentFailureMessage(code?: string): string {
  return messages[code ?? ''] ?? '任务未确认完成，请检查节点设置、输入和运行记录。'
}
