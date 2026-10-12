import { AppSelect } from '../../components/AppSelect'

export interface FlowTargetOption {
  id: string
  label: string
}

export function FlowNodeSelect({
  label,
  value,
  options,
  onChange,
  missingLabel = '已删除的节点'
}: {
  label: string
  value: string
  options: FlowTargetOption[]
  onChange: (value: string) => void
  missingLabel?: string
}): React.JSX.Element {
  const missing = value && !options.some((option) => option.id === value)
  return (
    <label className="settings-field">
      {label}
      <AppSelect
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">未选择</option>
        {missing && (
          <option value={value} disabled>
            {missingLabel}
          </option>
        )}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </AppSelect>
    </label>
  )
}

export function FlowNodeTargets({
  label,
  values,
  options,
  onChange
}: {
  label: string
  values: string[]
  options: FlowTargetOption[]
  onChange: (values: string[]) => void
}): React.JSX.Element {
  const all = [
    ...options,
    ...values
      .filter((id) => !options.some((option) => option.id === id))
      .map((id) => ({ id, label: '失效引用（可取消引用）' }))
  ]
  return (
    <fieldset className="agent-flow-targets">
      <legend>{label}</legend>
      {all.length === 0 && <p className="contract-settings-hint">画布上暂无可选目标。</p>}
      {all.map((option) => (
        <label key={option.id} className="agent-flow-target-option">
          <input
            type="checkbox"
            checked={values.includes(option.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...new Set([...values, option.id])]
                  : values.filter((id) => id !== option.id)
              )
            }
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  )
}

export function FlowTransitions({
  states,
  transitions,
  onChange
}: {
  states: string[]
  transitions: { from: string; event: string; to: string }[]
  onChange: (value: { from: string; event: string; to: string }[]) => void
}): React.JSX.Element {
  const select = (
    label: string,
    value: string,
    changed: (value: string) => void
  ): React.JSX.Element => (
    <label className="settings-field">
      {label}
      <AppSelect aria-label={label} value={value} onChange={(event) => changed(event.target.value)}>
        <option value="">选择阶段</option>
        {value && !states.includes(value) && (
          <option value={value} disabled>
            已移除阶段：{value}
          </option>
        )}
        {states.map((state) => (
          <option key={state} value={state}>
            {state}
          </option>
        ))}
      </AppSelect>
    </label>
  )
  return (
    <fieldset className="agent-flow-transitions">
      <legend>阶段转换</legend>
      {transitions.length === 0 && <p className="contract-settings-hint">尚未声明转换。</p>}
      {transitions.map((transition, index) => {
        const update = (key: 'from' | 'event' | 'to', value: string): void =>
          onChange(transitions.map((item, i) => (i === index ? { ...item, [key]: value } : item)))
        return (
          <div key={index} className="agent-flow-transition-row">
            {select(`起始阶段 ${index + 1}`, transition.from, (value) => update('from', value))}
            <label className="settings-field">
              触发事件 {index + 1}
              <input
                aria-label={`触发事件 ${index + 1}`}
                value={transition.event}
                maxLength={128}
                placeholder="例如 submitted"
                onChange={(event) => update('event', event.target.value)}
              />
            </label>
            {select(`目标阶段 ${index + 1}`, transition.to, (value) => update('to', value))}
            <button
              type="button"
              onClick={() => onChange(transitions.filter((_, i) => i !== index))}
            >
              删除转换 {index + 1}
            </button>
          </div>
        )
      })}
      <button
        type="button"
        disabled={!states.length || transitions.length >= 256}
        onClick={() =>
          onChange([
            ...transitions,
            { from: states[0] ?? '', event: '', to: states[1] ?? states[0] ?? '' }
          ])
        }
      >
        添加转换
      </button>
      <p className="contract-settings-hint">
        阶段和事件使用英文、数字、连字符或下划线；同一阶段的同一事件只能有一个目标。
      </p>
    </fieldset>
  )
}
