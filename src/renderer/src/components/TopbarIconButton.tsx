import type { ComponentProps } from 'react'
import { Tooltip } from './Tooltip'

export function TopbarIconButton({
  'aria-label': label,
  className = '',
  children,
  ...props
}: ComponentProps<'button'> & { 'aria-label': string }): React.JSX.Element {
  const button = (
    <button type="button" {...props} aria-label={label} className={`${className} topbar-icon-button`}>
      {children}
    </button>
  )
  return (
    <Tooltip label={label} placement="bottom" allowButton>
      {props.disabled ? <span className="topbar-disabled-icon">{button}</span> : button}
    </Tooltip>
  )
}
