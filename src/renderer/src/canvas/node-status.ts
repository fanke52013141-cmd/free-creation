/** User-facing execution state labels shared by card chrome and interaction tests. */
export const NODE_EXEC_LABELS: Record<string, string> = {
  idle: '未运行',
  pending: '等待执行',
  queued: '已排队',
  running: '执行中',
  success: '执行成功',
  failed: '执行失败',
  cancelled: '已取消',
  cached: '使用缓存'
}

export function nodeExecLabel(state: string): string {
  return NODE_EXEC_LABELS[state] ?? '状态未知'
}
