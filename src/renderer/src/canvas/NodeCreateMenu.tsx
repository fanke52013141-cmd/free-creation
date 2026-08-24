// LibTV 式节点创建菜单：双击空白画布弹出（指南 1.2.1）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { allNodeTypes } from '../nodes/registry'
import type { NodeTypeId } from '@shared/types'
import { Icon } from '../components/Icon'

interface NodeCreateMenuProps {
  x: number
  y: number
  onPick: (type: NodeTypeId) => void
  onUpload: () => void
  onGallery: () => void
  onClose: () => void
}

export function NodeCreateMenu({
  x,
  y,
  onPick,
  onUpload,
  onGallery,
  onClose
}: NodeCreateMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [menuHeight, setMenuHeight] = useState(0)

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

  return (
    <div className="node-menu" ref={ref} style={{ left, top }}>
      <div className="node-menu-title">新建节点</div>
      {allNodeTypes().map((t) => (
        <button key={t.type} className="node-menu-item" onClick={() => onPick(t.type)}>
          <span className="item-icon" style={{ color: t.color }}>
            <Icon name={t.icon} size={18} />
          </span>
          <span>{t.label}</span>
        </button>
      ))}
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
    </div>
  )
}
