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
  const [activeCategory, setActiveCategory] = useState<NodeCategoryId | 'all'>('all')

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

  const menuW = 224
  const menuH = menuHeight || 520
  const left = Math.max(12, Math.min(x, window.innerWidth - menuW - 12))
  const top = Math.max(12, Math.min(y, window.innerHeight - menuH - 12))
  const allChoices: NodeCreateChoice[] = source
    ? compatibleNodeCreateChoices(source)
    : allNodeTypes().map((spec) => ({ type: spec.type }))

  const availableCategories = NODE_CATEGORIES.filter((cat) =>
    allChoices.some((c) => getNodeType(c.type)?.category === cat.id)
  )
  const showTabs = availableCategories.length > 1
  const choices =
    activeCategory === 'all'
      ? allChoices
      : allChoices.filter((c) => getNodeType(c.type)?.category === activeCategory)

  return (
    <div className="node-menu" ref={ref} style={{ left, top }}>
      <div className="node-menu-title">
        {source ? `可连接 ${source.portType} 输出` : '新建节点'}
      </div>
      {showTabs && (
        <div className="node-menu-tabs">
          <button
            className={`node-menu-tab${activeCategory === 'all' ? ' active' : ''}`}
            onClick={() => setActiveCategory('all')}
          >
            全部
          </button>
          {availableCategories.map((cat) => (
            <button
              key={cat.id}
              className={`node-menu-tab${activeCategory === cat.id ? ' active' : ''}`}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      )}
      <div className="node-menu-list">
        {choices.map((choice) => {
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
                  </small>
                )}
              </span>
            </button>
          )
        })}
        {choices.length === 0 && <div className="node-menu-empty">没有与当前筛选匹配的节点</div>}
      </div>
      {!source && (
        <>
          <div className="node-menu-divider" />
          <div className="node-menu-title">工作流模板</div>
          <button className="node-menu-item" onClick={onTemplate}>
            <span className="item-icon">
              <Icon name="spark" size={18} />
            </span>
            <span>剧本 → 分镜</span>
          </button>
          <div className="node-menu-divider" />
          <div className="node-menu-title">添加资源</div>
          <button className="node-menu-item" onClick={onUpload}>
            <span className="item-icon">
              <Icon name="upload" size={18} />
            </span>
            <span>上传本地文件</span>
          </button>
          <button className="node-menu-item" onClick={onGallery}>
            <span className="item-icon">
              <Icon name="assets" size={18} />
            </span>
            <span>从图库选择</span>
          </button>
        </>
      )}
    </div>
  )
}
