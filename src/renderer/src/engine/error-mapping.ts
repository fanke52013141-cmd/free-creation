// T08（F10）：面向创作者的运行错误映射。把 run.status/error.phase/原始异常翻译为
// 「中文阶段 + 一句话原因 + 推荐动作」，原始技术细节保留在诊断折叠区。
// 纯函数：RunsPanel 与单元测试共用同一映射，避免两套口径。
import type { NodeRunPhase, NodeRunStatus } from './runRecord'

export interface CreatorFacingRunError {
  /** 中文阶段名（如「执行阶段」）。 */
  stage: string
  /** 一句话原因（保留原始 reason 中可读的部分）。 */
  reason: string
  /** 推荐动作提示（不含会触发计费的承诺）。 */
  action: string
}

const STATUS_TEXT: Partial<Record<NodeRunStatus, string>> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已停止',
}

const PHASE_TEXT: Partial<Record<NodeRunPhase, string>> = {
  input: '输入收集阶段',
  execution: '执行阶段',
  output: '结果写入阶段'
}

/** 判断错误是否属于「提交前失败」——重试不会产生新的供应商任务。 */
const PRE_SUBMIT_HINTS = ['没有输入', '缺少', '请连接', '请填写', '尚未绑定', '未绑定', '不能为空', '参数']

/**
 * 把一次运行的失败信息映射为面向创作者的三段式指引。
 * 非失败状态返回 null（成功/运行中不需要错误指引）。
 */
export function mapRunError(
  status: NodeRunStatus,
  error: { phase: NodeRunPhase; reason: string } | undefined
): CreatorFacingRunError | null {
  if (status !== 'failed') return null
  const phase = error?.phase ?? 'execution'
  const rawReason = (error?.reason ?? '原因未知').trim()
  const stage = PHASE_TEXT[phase] ?? '执行阶段'
  // 输入收集阶段的失败重试是安全的（不会产生供应商请求）。
  if (phase === 'input' || PRE_SUBMIT_HINTS.some((hint) => rawReason.includes(hint))) {
    return {
      stage,
      reason: rawReason,
      action: '补齐缺失的输入或配置后，点击「重试节点」即可。重试不会产生新的生成请求。'
    }
  }
  return {
    stage,
    reason: rawReason,
    action: '可点击「重试节点」再次尝试；若反复失败，请检查模型供应商配置或网络连接。'
  }
}

/** 运行状态的中文呈现（运行中心第一层使用，技术状态词折叠到诊断详情）。 */
export function statusText(status: NodeRunStatus): string {
  return STATUS_TEXT[status] ?? status
}
