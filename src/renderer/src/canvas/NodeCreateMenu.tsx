// LibTV 式节点创建菜单：双击空白画布弹出（指南 1.2.1）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { allNodeTypes, getNodeType, NODE_CATEGORIES } from '../nodes/registry'
import type { NodeCategoryId } from '../nodes/registry'
import type { ConnectionFrom } from '../stores/connection'
import { Icon } from '../components/Icon'
import { compatibleNodeCreateChoices, type NodeCreateChoice } from './node-create-options'

interface NodeCreateMenuProps {
  x: number
  y: number
  onPick: (choice: NodeCreateChoice) => void
  onTemplate: () => void
  onUpload: () => void
  onGallery: () => void
  onClose: () => void
  /** 从输出端口拉线到空白时，只展示能接收该端口的节点。 */
  source?: ConnectionFrom | null
}

function estimatedTextWidth(label: string): number {
  return Array.from(label).reduce((width, char) => {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      return width + 14
    }
    return width + (char === ' ' ? 4 : 8)
  }, 0)
}

function menuWidth(labels: string[], minWidth: number, chromeWidth: number): number {
  const widest = Math.max(0, ...labels.map(estimatedTextWidth))
  return Math.max(minWidth, Math.min(240, Math.ceil(widest + chromeWidth)))
}

export function NodeCreateMenu({
  x,
  y,
  onPick,
  onTemplate,
  onUpload,
  onGallery,
  onClose,
  source = null
}: NodeCreateMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [menuHeight, setMenuHeight] = useState(0)
  const [hoverCategory, setHoverCategory] = useState<NodeCategoryId | 'all' | null>(null)
  const hoverTimer = useRef<number | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useLayoutEffect(() => {
    const update = (): void => {
      const height = ref.current?.getBoundingClientRect().height ?? 0
      setMenuHeight(height)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Position against the compact primary menu; the submenu is absolutely positioned
  // and intentionally does not affect the primary menu's viewport clamping.
  const menuH = menuHeight || 420
  const top = Math.max(12, Math.min(y, window.innerHeight - menuH - 12))
  const allChoices: NodeCreateChoice[] = source
    ? compatibleNodeCreateChoices(source)
    : allNodeTypes().map((spec) => ({ type: spec.type }))

  const availableCategories = NODE_CATEGORIES.filter((cat) =>
    allChoices.some((c) => getNodeType(c.type)?.category === cat.id)
  )
  const showTabs = availableCategories.length > 1
  const categoryOptions: Array<{ id: NodeCategoryId | 'all'; label: string }> = [
    { id: 'all', label: '全部' },
    ...availableCategories.map((cat) => ({ id: cat.id, label: cat.label }))
  ]
  const submenuChoices =
    hoverCategory === null || hoverCategory === 'all'
      ? allChoices
      : allChoices.filter((c) => getNodeType(c.type)?.category === hoverCategory)
  const primaryLabels = showTabs
    ? [
        ...categoryOptions.map((category) => category.label),
        ...(source ? [] : ['剧本 → 分镜', '上传本地文件', '从图库选择'])
      ]
    : allChoices.flatMap((choice) => {
        const spec = getNodeType(choice.type)
        return spec ? [spec.label] : []
      })
  const primaryWidth = menuWidth(primaryLabels, 128, showTabs ? 42 : 52)
  const submenuWidth = source
    ? 276
    : menuWidth(
        submenuChoices.flatMap((choice) => {
          const spec = getNodeType(choice.type)
          return spec ? [spec.label] : []
        }),
        128,
        52
      )
  const left = Math.max(12, Math.min(x, window.innerWidth - primaryWidth - 24))
  const showCategoryMenu = (category: NodeCategoryId | 'all'): void => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    setHoverCategory(category)
  }
  const hideCategoryMenu = (): void => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHoverCategory(null), 160)
  }
  const keepCategoryMenu = (): void => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
  }
  const renderChoices = (): React.JSX.Element => (
    <div className={`node-menu-list${hoverCategory === 'all' ? ' scrollbar-hidden' : ''}`}>
      {submenuChoices.map((choice) => {
        const spec = getNodeType(choice.type)
        if (!spec) return null
        return (
          <button
            key={`${spec.type}:${choice.targetPortId ?? 'default'}`}
            className="node-menu-item"
            onClick={() => onPick(choice)}
          >
            <span className="item-icon" style={{ color: spec.color }}>
              <Icon name={spec.icon} size={18} />
            </span>
            <span className="node-menu-label">
              {spec.label}
              {choice.targetPort && (
                <small>
                  {choice.targetPort.name} · {choice.targetPort.type}
                  {choice.targetPort.schema
                    ? ` · ${choice.targetPort.schema.id}@${choice.targetPort.schema.version}`
                    : ''}
                  {choice.targetPort.cardinality === 'many' ? ' · 可接多条' : ' · 单条输入'}
                </small>
              )}
            </span>
          </button>
        )
      })}
      {submenuChoices.length === 0 && (
        <div className="node-menu-empty">没有与当前筛选匹配的节点</div>
      )}
    </div>
  )

  return (
    <div className="node-menu" ref={ref} style={{ left, top }}>
      <div className="node-menu-main" style={{ width: primaryWidth }}>
        <div className="node-menu-title">
          {source ? `可连接 ${source.portType} 输出` : '新建节点'}
        </div>
        {showTabs && (
          <div className="node-menu-category-list" onMouseLeave={hideCategoryMenu}>
            {categoryOptions.map((category) => (
              <button
                key={category.id}
                className={
                  'node-menu-category-item' + (hoverCategory === category.id ? ' active' : '')
                }
                onMouseEnter={() => showCategoryMenu(category.id)}
                onFocus={() => showCategoryMenu(category.id)}
                onBlur={hideCategoryMenu}
                onClick={() => showCategoryMenu(category.id)}
              >
                <span>{category.label}</span>
                <span className="node-menu-expand-arrow" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {!showTabs && renderChoices()}
        {!source && (
          <>
            <div className="node-menu-divider" />
            <div className="node-menu-title">工作流模板</div>
            <button className="node-menu-action" onClick={onTemplate}>
              剧本 → 分镜
            </button>
            <div className="node-menu-divider" />
            <div className="node-menu-title">添加资源</div>
            <button className="node-menu-action" onClick={onUpload}>
              上传本地文件
            </button>
            <button className="node-menu-action" onClick={onGallery}>
              从图库选择
            </button>
          </>
        )}
      </div>
      {showTabs && hoverCategory !== null && (
        <div
          className="node-menu-submenu"
          style={{ width: submenuWidth }}
          onMouseEnter={keepCategoryMenu}
          onMouseLeave={hideCategoryMenu}
          onFocus={keepCategoryMenu}
          onBlur={hideCategoryMenu}
        >
          <div className="node-menu-submenu-title">
            {categoryOptions.find((category) => category.id === hoverCategory)?.label ?? '全部'}
          </div>
          {renderChoices()}
        </div>
      )}
    </div>
  )
}
