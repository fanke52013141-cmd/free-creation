import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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

/**
 * 空态共用居中大图标（无框、不重复标题）；必要提示与业务操作按需通过 children 接入。
 *
 * `data-icon-only` 表示「identity 里除图标外没有任何**看得见**的内容」，是图标几何居中的
 * 唯一判据。不能交给 CSS `:has(> :not(...))` 判断结构：调用方常传入 `<small>` 或
 * `.node-wiring`（默认 display:none、条件出现），结构上算有子项，视觉上仍是纯空态，
 * 结果就是 JSON / P图 这类节点的图标退回 flex 布局、偏离卡片中心 20~30px。
 */
export function NodeIdentity({ children }: { children?: ReactNode }): React.JSX.Element | null {
  const context = useContext(Context)
  const register = context?.registerIdentity
  const hostRef = useRef<HTMLDivElement>(null)
  const [iconOnly, setIconOnly] = useState(false)
  useEffect(() => {
    register?.(1)
    return () => register?.(-1)
  }, [register])
  // 以真实可见性判断：display:none / visibility:hidden / 零尺寸都不算内容。
  // 同时监听尺寸变化——模型提示、连线警告等是条件渲染的，出现后要退回 flex 布局。
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => {
      const icon = host.querySelector(':scope > .node-standard-identity-icon')
      const hasVisibleChild = Array.from(host.children).some((child) => {
        if (child === icon) return false
        const style = getComputedStyle(child)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = child.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      setIconOnly((previous) => (previous === !hasVisibleChild ? previous : !hasVisibleChild))
    }
    measure()
    // jsdom 等无 ResizeObserver 的环境退化为「每次渲染测一次」，不影响运行时正确性。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  })
  if (!context) return null
  return (
    <div
      className="node-standard-identity"
      ref={hostRef}
      data-icon-only={iconOnly ? 'true' : undefined}
    >
      <span className="node-standard-identity-icon">
        <Icon name={context.spec.icon} size={NODE_UI.identity.iconSize} strokeWidth={2} />
      </span>
      {children}
    </div>
  )
}

/** 区块标题：纯文字，无图标、无下划线（v1.5 用户裁决，2026-11-02）。 */
export function NodeSectionTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="node-section-title">
      <span>{children}</span>
    </div>
  )
}

/** 通过 React portal 保留 Body 原有回调/状态，将主按钮呈现在卡片固定底部。 */
export function NodePrimaryButton({
  allowWhileBusy = false,
  children,
  className,
  variant = 'primary',
  onPointerDown,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  allowWhileBusy?: boolean
  variant?: 'primary' | 'secondary'
}): React.JSX.Element | null {
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
  // 卡片内不再呈现任何图标（v1.5）；传入的 Icon 子元素统一忽略，只保留文字。
  const content = flatten(children).filter(
    (child) => !(isValidElement(child) && child.type === Icon)
  )
  const button = (
    <button
      {...props}
      disabled={props.disabled || (context?.busy && !allowWhileBusy)}
      title={
        context?.busy && !allowWhileBusy
          ? '节点正在运行或排队，请稍候'
          : (props.title ??
            (props.disabled ? '当前不可用，请检查输入、模型配置或运行状态' : undefined))
      }
      type="button"
      data-original-action={className}
      data-variant={variant}
      className={`node-standard-primary node-standard-primary--${variant}`}
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
            '--node-standard-identity-height': `${NODE_UI.identity.minHeight}px`,
            '--node-standard-description-height': `${NODE_UI.description.height}px`,
            '--node-standard-padding': `${NODE_UI.content.padding}px`,
            '--node-standard-action-height': `${NODE_UI.actionBar.height}px`,
            '--node-standard-button-height': `${NODE_UI.primaryButton.height}px`,
            '--node-standard-button-radius': `${NODE_UI.primaryButton.radius}px`,
            '--node-standard-bottom-inset': `${NODE_UI.actionBar.bottomInset}px`
          } as React.CSSProperties
        }
        data-has-identity={identities > 0}
        data-has-actions={actions > 0}
      >
        <div className="node-standard-scroll">
          {children}
        </div>
        <NodeActionBar footerRef={setFooter}>{null}</NodeActionBar>
      </div>
    </Context.Provider>
  )
}
