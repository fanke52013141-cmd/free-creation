// 统一数字步进器（2026-11-02 用户裁决）：
// 原生 input[type=number] 的上下小三角在不同系统/缩放下又小又难点，十个节点各写一份样式也不一致。
// 这里统一成「左侧数字输入 + 右侧上下两个大点击区」的公共控件，供所有节点复用。
import { stopEventPropagation } from 'tldraw'

export interface NumberStepperProps {
  /** 保留字符串形态，兼容节点里尚未完成数值收敛的草稿状态。 */
  value: string
  min: number
  max: number
  step: number
  ariaLabel: string
  disabled?: boolean
  onChange: (next: string) => void
}

export function NumberStepper({
  value,
  min,
  max,
  step,
  ariaLabel,
  disabled = false,
  onChange
}: NumberStepperProps): React.JSX.Element {
  const parsed = Number(value)
  const current = Number.isFinite(parsed) ? parsed : min
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  const format = (next: number): string => String(Number(next.toFixed(4)))
  const bump = (direction: 1 | -1): void => {
    onChange(format(clamp(Number((current + direction * step).toFixed(4)))))
  }
  return (
    <span className="number-stepper">
      <input
        className="number-stepper-input"
        type="number"
        inputMode="decimal"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={(event) => stopEventPropagation(event)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span className="number-stepper-buttons">
        <button
          type="button"
          className="number-stepper-button"
          aria-label={`${ariaLabel}增加`}
          disabled={disabled || current >= max}
          onPointerDown={(event) => stopEventPropagation(event)}
          onClick={(event) => {
            event.stopPropagation()
            bump(1)
          }}
        >
          <span className="number-stepper-tri" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="number-stepper-button"
          aria-label={`${ariaLabel}减少`}
          disabled={disabled || current <= min}
          onPointerDown={(event) => stopEventPropagation(event)}
          onClick={(event) => {
            event.stopPropagation()
            bump(-1)
          }}
        >
          <span className="number-stepper-tri" aria-hidden="true" />
        </button>
      </span>
    </span>
  )
}
