// T04（F01）：项目保存状态常驻徽标。数据来自 SaveCoordinator 状态机，
// 五态：已保存 / 未保存修改 / 保存中 / 保存失败（持续显示）/ 已暂停保存。
// 失败态 tooltip 提供最近失败原因；成功不弹 toast（低干扰原则）。
import { useSaveCoordinator, type SavePhase } from '@renderer/stores/save-coordinator'

const PHASE_META: Record<SavePhase, { label: string; color: string; title: string }> = {
  saved: { label: '已保存到本机', color: '#34d399', title: '所有修改均已写入本机项目文件。' },
  dirty: { label: '尚有未保存修改', color: '#fbbf24', title: '修改将在片刻后自动保存；也可从菜单手动保存。' },
  saving: { label: '正在保存…', color: '#42b9f5', title: '正在把修改写入本机项目文件。' },
  failed: { label: '保存失败', color: '#ff6b6b', title: '最近一次保存未成功。修改仍在本页，请检查磁盘空间后重试。' },
  paused: { label: '已暂停保存', color: '#9aa4b2', title: '因外部修改加载失败，自动保存已暂停以保护数据。' }
}

export function SaveStatusBadge(): React.JSX.Element {
  const phase = useSaveCoordinator((s) => s.phase)
  const lastError = useSaveCoordinator((s) => s.lastError)
  const lastSavedAt = useSaveCoordinator((s) => s.lastSavedAt)
  const meta = PHASE_META[phase]
  const detail =
    phase === 'failed' && lastError
      ? `${meta.title} 失败原因：${lastError}`
      : phase === 'saved' && lastSavedAt
        ? `${meta.title} 最近保存：${new Date(lastSavedAt).toLocaleTimeString('zh-CN')}`
        : meta.title
  return (
    <span
      className="save-status-badge"
      role="status"
      aria-live="polite"
      title={detail}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: meta.color,
          flex: '0 0 auto'
        }}
      />
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.label}</span>
    </span>
  )
}
