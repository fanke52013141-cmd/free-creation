import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceProfile } from '@shared/workspace-profile'
import {
  defaultWorkspaceProfile,
  GENERAL_WORKSPACE_NODE_TYPES
} from '@shared/workspace-profile'
import { NODE_CATEGORY_IDS, type PaletteCategoryId } from '@shared/palette-preferences'
import { allNodeTypes } from '../nodes/registry'
import { registerBaseNodeTypes, registerExtendedNodeTypes, registerScriptNodeType } from '../nodes/specs'
import {
  PALETTE_CATEGORY_META,
  nodesForPaletteCategory,
  paletteCategoryForNode
} from '../canvas/palette-categories'
import { Icon } from './Icon'
import './project-create-dialog.css'

registerBaseNodeTypes()
registerScriptNodeType()
registerExtendedNodeTypes()

const PRESETS: Array<{ id: WorkspaceProfile['presetId']; label: string }> = [
  { id: 'general', label: '通用创作' },
  { id: 'image', label: '图像创作' },
  { id: 'video', label: '视频创作' },
  { id: 'audio', label: '音频创作' },
  { id: 'all', label: '全部节点' }
]

function presetNodeIds(preset: WorkspaceProfile['presetId']): string[] {
  const types = allNodeTypes()
  if (preset === 'all') return types.map((node) => node.type)
  if (preset === 'general') return [...GENERAL_WORKSPACE_NODE_TYPES]
  const selected = new Set<PaletteCategoryId>(['input'])
  if (preset === 'image') selected.add('image')
  if (preset === 'video') selected.add('video')
  if (preset === 'audio') selected.add('audio')
  return types
    .filter((node) => {
      const category = paletteCategoryForNode(node.type)
      return category !== null && selected.has(category)
    })
    .map((node) => node.type)
}

export interface ProjectCreateDialogProps {
  title: string
  initialName?: string
  initialProfile?: WorkspaceProfile
  nameRequired?: boolean
  submitLabel: string
  onCancel: () => void
  onSubmit: (name: string, profile: WorkspaceProfile) => Promise<void>
}

export function ProjectCreateDialog({
  title,
  initialName = '',
  initialProfile,
  nameRequired = true,
  submitLabel,
  onCancel,
  onSubmit
}: ProjectCreateDialogProps): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const [preset, setPreset] = useState<WorkspaceProfile['presetId']>(
    initialProfile?.presetId ?? (nameRequired ? 'general' : 'all')
  )
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(
      initialProfile?.visibleNodeTypeIds ??
        (nameRequired ? defaultWorkspaceProfile().visibleNodeTypeIds : allNodeTypes().map((node) => node.type))
    )
  )
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nodeTypes = useMemo(() => allNodeTypes(), [])
  const filteredTypes = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase()
    return needle
      ? nodeTypes.filter((node) => `${node.label} ${node.type}`.toLocaleLowerCase().includes(needle))
      : nodeTypes
  }, [keyword, nodeTypes])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const choosePreset = (next: WorkspaceProfile['presetId']): void => {
    setPreset(next)
    setSelected(new Set(presetNodeIds(next)))
  }
  const toggleNode = (id: string): void => {
    setPreset('custom')
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleCategory = (category: PaletteCategoryId): void => {
    const ids = nodesForPaletteCategory(filteredTypes, category).map((node) => node.type)
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
    setPreset('custom')
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) allSelected ? next.delete(id) : next.add(id)
      return next
    })
  }
  const submit = async (): Promise<void> => {
    if (nameRequired && !name.trim()) {
      setError('请填写项目名称')
      return
    }
    if (selected.size === 0) {
      setError('至少选择一个节点，之后仍可在工作台设置中调整')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSubmit(name.trim(), {
        schemaVersion: 1,
        presetId: preset,
        visibleNodeTypeIds: [
          ...nodeTypes.filter((node) => selected.has(node.type)).map((node) => node.type),
          ...Array.from(selected).filter((id) => !nodeTypes.some((node) => node.type === id))
        ]
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="project-create-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section className="project-create-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="project-create-header">
          <div>
            <span className="project-create-eyebrow">WORKSPACE</span>
            <h2>{title}</h2>
          </div>
          <button className="project-create-close" aria-label="关闭" disabled={busy} onClick={onCancel}>
            <Icon name="close" size={18} />
          </button>
        </header>

        {nameRequired && (
          <label className="project-create-name">
            <span>项目名称</span>
            <input
              autoFocus
              maxLength={120}
              value={name}
              placeholder="给这个项目起个名字"
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void submit()
              }}
            />
          </label>
        )}

        <div className="project-create-section-heading">
          <div>
            <h3>工作台节点</h3>
            <p>选择后会控制可添加的节点，不会自动把节点放到画布上。</p>
          </div>
          <span className="project-create-count">已选 {selected.size}</span>
        </div>

        <div className="project-create-presets" role="group" aria-label="工作台预设">
          {PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={preset === item.id ? 'is-selected' : ''}
              onClick={() => choosePreset(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="project-create-search">
          <Icon name="search" size={15} />
          <input
            value={keyword}
            placeholder="搜索节点名称"
            onChange={(event) => setKeyword(event.currentTarget.value)}
          />
          {keyword && <button type="button" aria-label="清空搜索" onClick={() => setKeyword('')}>×</button>}
        </label>

        <div className="project-create-categories">
          {NODE_CATEGORY_IDS.map((category) => {
            const nodes = nodesForPaletteCategory(filteredTypes, category)
            if (!nodes.length) return null
            const meta = PALETTE_CATEGORY_META[category]
            const checked = nodes.filter((node) => selected.has(node.type)).length
            return (
              <section className="project-create-category" key={category}>
                <header>
                  <span className="project-create-category-icon"><Icon name={meta.icon} size={16} /></span>
                  <strong>{meta.label}</strong>
                  <span className="project-create-category-count">{checked}/{nodes.length}</span>
                  <button type="button" onClick={() => toggleCategory(category)}>
                    {checked === nodes.length ? '全不选' : '全选'}
                  </button>
                </header>
                <div className="project-create-node-grid">
                  {nodes.map((node) => (
                    <label className="project-create-node" key={node.type}>
                      <input
                        type="checkbox"
                        checked={selected.has(node.type)}
                        onChange={() => toggleNode(node.type)}
                      />
                      <span className="project-create-node-icon" style={{ color: node.color }}>
                        <Icon name={node.icon} size={16} />
                      </span>
                      <span>{node.label}</span>
                    </label>
                  ))}
                </div>
              </section>
            )
          })}
          {filteredTypes.length === 0 && <div className="project-create-no-results">没有匹配的节点</div>}
        </div>

        <footer className="project-create-footer">
          <span className="project-create-error" role="alert">{error}</span>
          <button type="button" className="project-create-cancel" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="project-create-submit" disabled={busy} onClick={() => void submit()}>
            {busy ? '保存中…' : submitLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
