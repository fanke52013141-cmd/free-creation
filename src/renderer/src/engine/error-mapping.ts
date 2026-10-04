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
  cancelled: '已停止'
}

const PHASE_TEXT: Partial<Record<NodeRunPhase, string>> = {
  input: '输入收集阶段',
  execution: '执行阶段',
  output: '结果写入阶段'
}

/** 判断错误是否属于「提交前失败」——重试不会产生新的供应商任务。 */
const PRE_SUBMIT_HINTS = ['没有输入', '请连接', '请填写', '尚未绑定', '未绑定', '不能为空']

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
  const guidance = (action: string): CreatorFacingRunError => ({ stage, reason: rawReason, action })
  if (/来源保存失败|落盘|磁盘|空间不足|ENOSPC|保存失败|下载失败|download/i.test(rawReason))
    return guidance(
      '先检查本地磁盘、文件权限和素材面板；若素材或供应商任务已经存在，优先恢复保存或下载。不要直接重新生成，以免重复计费。'
    )
  if (/401|403|unauthorized|forbidden|api.?key|鉴权|认证|凭据/i.test(rawReason))
    return guidance('打开供应商设置检查密钥、服务地址与模型权限；配置成功后再重试节点。')
  if (/429|rate.?limit|限流|请求过多/i.test(rawReason))
    return guidance('等待供应商限流恢复并降低批量并发；先检查已有任务状态，再重试节点。')
  if (/timeout|timed out|超时|fetch failed|network|网络|连接中断/i.test(rawReason))
    return guidance(
      '先检查供应商任务记录与网络；任务可能已提交，确认其状态后再重试节点，避免重复生成和计费。'
    )
  if (phase === 'output' || /schema|不符合|结构校验/i.test(rawReason))
    return guidance(
      '查看输出端口的结构要求与本次诊断；已有媒体先保留，不要因结构校验失败直接重复生成。修正格式或模型配置后再运行。'
    )
  // 输入收集阶段的失败重试是安全的（不会产生供应商请求）。
  if (phase === 'input' || PRE_SUBMIT_HINTS.some((hint) => rawReason.includes(hint))) {
    return {
      stage,
      reason: rawReason,
      action:
        '本次在执行前停止。补齐输入或配置后可点击「重试节点」；下一次运行若调用模型，仍可能产生请求和费用。'
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
