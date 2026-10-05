import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../components/Icon'
import type { NodeTypeSpec } from '../nodes/registry'
import { NODE_UI } from './node-ui-tokens'
import './node-presentation.css'

interface PresentationContext {
  spec: NodeTypeSpec
  busy: boolean
  footer: HTMLDivElement | null
  registerAction: (delta: number) => void
  registerIdentity: (delta: number) => void
  openDescription: () => void
}
const Context = createContext<PresentationContext | null>(null)

export function NodeDescription(): React.JSX.Element | null {
  const context = useContext(Context)
  if (!context) return null
  return (
    <button
      type="button"
      className="node-standard-description"
      title={context.spec.description}
      aria-label={`查看${context.spec.label}完整说明`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        context.openDescription()
      }}
    >
      {context.spec.description}
    </button>
  )
}

/** 空态共用图标和名称；必要提示与业务操作按需通过 children 接入。 */
export function NodeIdentity({ children }: { children?: ReactNode }): React.JSX.Element | null {
  const context = useContext(Context)
  const register = context?.registerIdentity
  useEffect(() => {
    register?.(1)
    return () => register?.(-1)
  }, [register])
  if (!context) return null
  return (
    <div className="node-standard-identity">
      <span className="node-standard-identity-icon">
        <Icon name={context.spec.icon} size={NODE_UI.identity.iconSize} strokeWidth={2} />
      </span>
      <strong title={context.spec.label}>{context.spec.label}</strong>
      {children}
    </div>
  )
}

/** 通过 React portal 保留 Body 原有回调/状态，将主按钮呈现在卡片固定底部。 */
export function NodePrimaryButton({
  children,
  className,
  onPointerDown,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element | null {
  const context = useContext(Context)
  const register = context?.registerAction
  useEffect(() => {
    register?.(1)
    return () => register?.(-1)
  }, [register])
  if (context && !context.footer) return null
  const flatten = (nodes: ReactNode): ReactNode[] =>
    Children.toArray(nodes).flatMap((child) =>
      isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
        ? flatten(child.props.children)
        : [child]
    )
  const elements = flatten(children)
  const icons = elements.filter((child) => isValidElement(child) && child.type === Icon)
  const content = elements.filter((child) => !icons.includes(child))
  const button = (
    <button
      {...props}
      disabled={props.disabled || context?.busy}
      title={
        context?.busy
          ? '节点正在运行或排队，请稍候'
          : (props.title ??
            (props.disabled ? '当前不可用，请检查输入、模型配置或运行状态' : undefined))
      }
      type="button"
      data-original-action={className}
      className="node-standard-primary"
      onPointerDown={(event) => {
        event.stopPropagation()
        onPointerDown?.(event)
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
    >
      <span className="node-standard-primary-icon">
        {icons.length ? icons[0] : <Icon name="arrow" size={16} />}
      </span>
      <span className="node-standard-primary-label">{content}</span>
    </button>
  )
  return context?.footer ? createPortal(button, context.footer) : button
}

/** 业务按状态声明零个、一个或多个动作；外壳不补造操作。 */
export function NodeFooterActions({ children }: { children: ReactNode }): React.JSX.Element | null {
  const context = useContext(Context)
  const register = context?.registerAction
  useEffect(() => {
    register?.(1)
    return () => register?.(-1)
  }, [register])
  if (!context) return <>{children}</>
  return context.footer
    ? createPortal(
        <fieldset
          className="node-standard-footer-group"
          disabled={context.busy}
          aria-label="节点操作"
        >
          {children}
        </fieldset>,
        context.footer
      )
    : null
}

export function NodeActionBar({
  footerRef,
  children
}: {
  footerRef: (element: HTMLDivElement | null) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div ref={footerRef} className="node-standard-action-bar" aria-label="节点主操作">
      {children}
    </div>
  )
}

export function NodeCardShell({
  spec,
  busy,
  children,
  openDescription
}: {
  spec: NodeTypeSpec
  busy: boolean
  children: ReactNode
  openDescription: () => void
}): React.JSX.Element {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const [actions, setActions] = useState(0)
  const [identities, setIdentities] = useState(0)
  const registerAction = useMemo(
    () =>
      (delta: number): void =>
        setActions((count) => count + delta),
    []
  )
  const registerIdentity = useMemo(
    () =>
      (delta: number): void =>
        setIdentities((count) => count + delta),
    []
  )
  const context = useMemo(
    () => ({ spec, busy, footer, registerAction, registerIdentity, openDescription }),
    [spec, busy, footer, registerAction, registerIdentity, openDescription]
  )
  return (
    <Context.Provider value={context}>
      <div
        className="node-standard-shell"
        style={
          {
            '--node-standard-icon-box': `${NODE_UI.identity.boxSize}px`,
            '--node-standard-icon-radius': `${NODE_UI.identity.radius}px`,
            '--node-standard-identity-height': `${NODE_UI.identity.minHeight}px`,
            '--node-standard-description-height': `${NODE_UI.description.height}px`,
            '--node-standard-padding': `${NODE_UI.content.padding}px`,
            '--node-standard-action-height': `${NODE_UI.actionBar.height}px`,
            '--node-standard-button-width': `${NODE_UI.primaryButton.width}px`,
            '--node-standard-button-height': `${NODE_UI.primaryButton.height}px`,
            '--node-standard-button-radius': `${NODE_UI.primaryButton.radius}px`,
            '--node-standard-bottom-inset': `${NODE_UI.actionBar.bottomInset}px`
          } as React.CSSProperties
        }
        data-has-identity={identities > 0}
        data-has-actions={actions > 0}
      >
        <div className="node-standard-scroll">{children}</div>
        <NodeActionBar footerRef={setFooter}>{null}</NodeActionBar>
      </div>
    </Context.Provider>
  )
}
