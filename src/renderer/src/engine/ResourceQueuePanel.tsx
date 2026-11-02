import { setResourceLimit, useResourceQueue } from './resource-queue'
import { Icon } from '../components/Icon'
import { NumberStepper } from '../components/NumberStepper'

export function ResourceQueuePanel({ projectId }: { projectId: string }): React.JSX.Element {
  const tasks = useResourceQueue((state) => state.tasks)
  const limits = useResourceQueue((state) => state.limits)
  const visible = tasks.filter((task) => task.projectId === projectId)
  const running = visible.filter((task) => task.status === 'running').length
  const queued = visible.filter((task) => task.status === 'queued').length
  const statusLabel = `${running} 个任务运行中，${queued} 个任务排队中`
  return (
    <details className="resource-queue-control" style={{ position: 'relative', marginLeft: 8 }}>
      <summary className="resource-queue-summary" title={statusLabel} aria-label={statusLabel}>
        <span className="resource-queue-count">
          <Icon name="play" size={14} />
          <span>{running}</span>
        </span>
        <span className="resource-queue-count">
          <Icon name="history" size={14} />
          <span>{queued}</span>
        </span>
      </summary>
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 28,
          width: 320,
          padding: 16,
          background: '#1a1f26',
          border: '1px solid #3a4654',
          borderRadius: 12,
          zIndex: 1000
        }}
      >
        {Object.entries({
          provider: '模型任务总额度',
          gpu: '本地 GPU',
          media: '媒体处理',
          local: '其他本地任务'
        }).map(([resource, label]) => (
          <label
            key={resource}
            style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}
          >
            {label}
            <span style={{ display: 'block', width: 96 }}>
              <NumberStepper
                ariaLabel={label}
                min={1}
                max={64}
                step={1}
                value={String(limits[resource] ?? 1)}
                onChange={(next) => {
                  const value = Number(next)
                  if (Number.isFinite(value)) setResourceLimit(resource, value)
                }}
              />
            </span>
          </label>
        ))}
        <p style={{ fontSize: 12 }}>额度适用于当前窗口。调整不会中断运行中的任务。</p>
        {visible.length === 0 && <p>暂无任务</p>}
        {visible.map((task) => (
          <div key={task.id} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <span style={{ flex: 1 }}>
              {task.label} · {task.status === 'queued' ? '等待额度' : '运行中'}
            </span>
            <button onClick={task.cancel}>取消</button>
          </div>
        ))}
      </div>
    </details>
  )
}
