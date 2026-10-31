import * as Select from '@radix-ui/react-select'
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react'
import { Icon } from './Icon'

const EMPTY_OPTION_ID = '__app_select_empty_option__'

let activeAppSelect: { owner: symbol; close: () => void } | null = null

interface NativeOption {
  id: string
  value: string
  label: ReactNode
  /** 关闭态触发器显示的短标签；缺省回落到完整 label（2026-10-31 对话模型选择器需求）。 */
  triggerLabel: string | null
  disabled: boolean
}

export interface AppSelectChangeEvent {
  target: { value: string }
  currentTarget: { value: string }
}

export interface AppSelectProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'defaultValue' | 'name' | 'onChange' | 'value'
> {
  /** Kept compatible with existing call sites that render native option children. */
  children: ReactNode
  value?: string
  defaultValue?: string
  name?: string
  required?: boolean
  onChange?: (event: AppSelectChangeEvent) => void
}

function collectOptions(children: ReactNode): NativeOption[] {
  const options: NativeOption[] = []
  const textValue = (node: ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textValue).join('')
    if (isValidElement(node)) return textValue((node.props as { children?: ReactNode }).children)
    return ''
  }

  const visit = (nodes: ReactNode): void => {
    Children.forEach(nodes, (node) => {
      if (!isValidElement(node)) return
      if (node.type === Fragment) {
        visit((node as ReactElement<{ children?: ReactNode }>).props.children)
        return
      }
      if (node.type !== 'option') return

      const props = node.props as {
        value?: string | number
        disabled?: boolean
        children?: ReactNode
        'data-trigger-label'?: string | number
      }
      const value =
        props.value === undefined ? textValue(props.children).trim() : String(props.value)
      const index = options.length
      const triggerLabel = props['data-trigger-label']
      options.push({
        id: value === '' ? `${EMPTY_OPTION_ID}-${index}` : `app-select-option-${index}`,
        value,
        label: props.children ?? value,
        triggerLabel:
          triggerLabel === undefined || triggerLabel === '' ? null : String(triggerLabel),
        disabled: Boolean(props.disabled)
      })
    })
  }

  visit(children)
  return options
}

/**
 * Shared single-select control. It retains the project's existing <option> call-site API while
 * rendering an accessible Radix listbox in a body portal with collision-aware placement.
 */
export function AppSelect({
  className = '',
  children,
  value,
  defaultValue,
  name,
  required,
  disabled,
  onChange,
  ...triggerProps
}: AppSelectProps): React.JSX.Element {
  const options = useMemo(() => collectOptions(children), [children])
  const initialValue = defaultValue ?? options[0]?.value ?? ''
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue)
  const [open, setOpen] = useState(false)
  const owner = useRef(Symbol('app-select'))
  const selectedValue = value === undefined ? uncontrolledValue : value
  const selectedOption = options.find((option) => option.value === selectedValue)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      activeAppSelect?.close()
      activeAppSelect = { owner: owner.current, close: () => setOpen(false) }
    } else if (activeAppSelect?.owner === owner.current) {
      activeAppSelect = null
    }
    setOpen(nextOpen)
  }

  useEffect(
    () => () => {
      if (activeAppSelect?.owner === owner.current) activeAppSelect = null
    },
    []
  )

  const notifyChange = (optionId: string): void => {
    const option = options.find((candidate) => candidate.id === optionId)
    if (!option || option.disabled) return

    if (value === undefined) setUncontrolledValue(option.value)
    onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } })
  }

  return (
    <Select.Root
      open={open}
      onOpenChange={handleOpenChange}
      value={selectedOption?.id ?? ''}
      onValueChange={notifyChange}
      required={required}
      disabled={disabled}
    >
      <Select.Trigger
        {...triggerProps}
        className={`app-select app-select-trigger ${className}`.trim()}
        aria-haspopup="listbox"
      >
        {/* 有 triggerLabel 的选项：关闭态显示短标签（如仅模型名），下拉里仍展示完整 label */}
        <Select.Value placeholder={selectedValue}>
          {selectedOption?.triggerLabel ? (
            <span className="app-select-value">{selectedOption.triggerLabel}</span>
          ) : undefined}
        </Select.Value>
        <Select.Icon className="app-select-chevron" aria-hidden="true">
          <span />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="app-select-content"
          position="popper"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          sticky="partial"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <Select.Viewport className="app-select-viewport">
            {options.map((option) => (
              <Select.Item
                key={option.id}
                className="app-select-item"
                value={option.id}
                disabled={option.disabled}
                title={typeof option.label === 'string' ? option.label : undefined}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="app-select-item-check">
                  <Icon name="check" size={14} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
      {name && <input type="hidden" name={name} value={selectedValue} disabled={disabled} />}
    </Select.Root>
  )
}
