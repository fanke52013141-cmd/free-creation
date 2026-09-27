import { Icon } from '../components/Icon'

interface GenerationLoadingOverlayProps {
  title: string
  description?: string
  progress?: number
  remainingMs?: number
  waiting?: boolean
}

function formatRemainingTime(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = Math.floor(milliseconds / 60_000)
    const seconds = Math.ceil((milliseconds % 60_000) / 1000)
    return seconds ? `${minutes}分${seconds}秒` : `${minutes}分钟`
  }
  return `${Math.max(0, milliseconds / 1000).toFixed(1)}s`
}

export function GenerationLoadingOverlay({
  title,
  description,
  progress,
  remainingMs,
  waiting = false
}: GenerationLoadingOverlayProps): React.JSX.Element {
  const normalizedProgress = progress === undefined ? undefined : Math.max(0, Math.min(99, Math.floor(progress)))
  const estimateLabel = waiting
    ? '等待开始'
    : remainingMs !== undefined && remainingMs < 0
      ? '已超出预估'
      : remainingMs === undefined ? '' : formatRemainingTime(remainingMs)

  return (
    <div className="generation-loading-card" role="status" aria-live="polite">
      <div className="generation-loading-planet" aria-hidden="true">
        <span className="generation-loading-glow" />
        <span className="generation-loading-orbit generation-loading-orbit-back" />
        <span className="generation-loading-satellite-orbit"><i /></span>
        <span className="generation-loading-planet-core"><i /></span>
        <span className="generation-loading-orbit generation-loading-orbit-front" />
      </div>
      <div className="generation-loading-copy">
        <strong>{waiting ? '等待执行' : title}</strong>
        {description && <small>{description}</small>}
        {normalizedProgress !== undefined && <div
          className="generation-loading-progress"
          role="progressbar"
          aria-label={`${title}预计进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={normalizedProgress}
        >
          <span className="generation-loading-track">
            <span style={{ width: `${normalizedProgress}%` }}>
              <i />
            </span>
          </span>
          <div className="generation-loading-meta">
            <span>生成进度 <b>{normalizedProgress}%</b></span>
            {remainingMs !== undefined && <span className="generation-loading-eta">
              <Icon name="reset" size={13} />
              <span>预估剩余</span>
              <b>{estimateLabel}</b>
            </span>}
          </div>
        </div>}
      </div>
    </div>
  )
}
