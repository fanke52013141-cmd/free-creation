import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceProfile } from '@shared/workspace-profile'
import { NODE_CATEGORY_IDS, type PaletteCategoryId } from '@shared/palette-preferences'
import { allNodeTypes } from '../nodes/registry'
import {
  registerBaseNodeTypes,
  registerExtendedNodeTypes,
  registerScriptNodeType
} from '../nodes/specs'
import { PALETTE_CATEGORY_META, nodesForPaletteCategory } from '../canvas/palette-categories'
import { Icon } from './Icon'
import './project-create-dialog.css'

registerBaseNodeTypes()
registerScriptNodeType()
registerExtendedNodeTypes()

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
  const dialogId = useId()
  const nameInputId = `${dialogId}-name`
  const searchInputId = `${dialogId}-search`
  const [name, setName] = useState(initialName)
  const [preset, setPreset] = useState<WorkspaceProfile['presetId']>(
    initialProfile?.presetId ?? 'all'
  )
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialProfile?.visibleNodeTypeIds ?? allNodeTypes().map((node) => node.type))
  )
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nodeTypes = useMemo(() => allNodeTypes(), [])
  const filteredTypes = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase()
    return needle
      ? nodeTypes.filter((node) =>
          `${node.label} ${node.type}`.toLocaleLowerCase().includes(needle)
        )
      : nodeTypes
  }, [keyword, nodeTypes])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

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
      setError('至少选择一个节点')
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
          <div className="project-create-heading">
            <span className="project-create-brand-icon" aria-hidden="true">
              <Icon name="workflow" size={18} />
            </span>
            <div>
              <h2>{title}</h2>
            </div>
          </div>
          <button
            type="button"
            className="project-create-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onCancel}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className={`project-create-body ${nameRequired ? '' : 'is-name-hidden'}`}>
          <div className="project-create-top-config">
            {nameRequired && (
              <label className="project-create-name" htmlFor={nameInputId}>
                <span>项目名称</span>
                <input
                  id={nameInputId}
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
            <label className="project-create-search" htmlFor={searchInputId}>
              <span>快速定位节点</span>
              <span className="project-create-search-field">
                <Icon name="search" size={16} />
                <input
                  id={searchInputId}
                  value={keyword}
                  placeholder="搜索节点名称"
                  onChange={(event) => setKeyword(event.currentTarget.value)}
                />
                {keyword && (
                  <button type="button" aria-label="清空搜索" onClick={() => setKeyword('')}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </span>
            </label>
          </div>

          <div className="project-create-categories" aria-label="按分类选择节点">
            {NODE_CATEGORY_IDS.map((category) => {
              const nodes = nodesForPaletteCategory(filteredTypes, category)
              if (!nodes.length) return null
              const meta = PALETTE_CATEGORY_META[category]
              const checked = nodes.filter((node) => selected.has(node.type)).length
              return (
                <section
                  className="project-create-category"
                  data-category={category}
                  key={category}
                >
                  <header>
                    <span className="project-create-category-icon" aria-hidden="true">
                      <Icon name={meta.icon} size={16} />
                    </span>
                    <strong>{meta.label}</strong>
                    <span
                      className="project-create-category-count"
                      aria-label={`${checked} 项已选，共 ${nodes.length} 项`}
                    >
                      {checked}/{nodes.length}
                    </span>
                    <button
                      type="button"
                      aria-label={`${checked === nodes.length ? '取消选择' : '选择'}${meta.label}全部节点`}
                      onClick={() => toggleCategory(category)}
                    >
                      {checked === nodes.length ? '全不选' : '全选'}
                    </button>
                  </header>
                  <div className="project-create-node-grid">
                    {nodes.map((node) => (
                      <label
                        className={`project-create-node ${selected.has(node.type) ? 'is-selected' : ''}`}
                        key={node.type}
                        style={{ '--node-color': node.color } as React.CSSProperties}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(node.type)}
                          aria-label={node.label}
                          onChange={() => toggleNode(node.type)}
                        />
                        <span className="project-create-node-icon" aria-hidden="true">
                          <Icon name={node.icon} size={17} />
                        </span>
                        <span className="project-create-node-label">{node.label}</span>
                        <span className="project-create-node-check" aria-hidden="true">
                          <Icon name="check" size={13} />
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              )
            })}
            {filteredTypes.length === 0 && (
              <div className="project-create-no-results">
                <span className="project-create-no-results-icon" aria-hidden="true">
                  <Icon name="search" size={19} />
                </span>
                <strong>没有找到匹配的节点</strong>
                <span>试试其他关键词，或清空搜索条件</span>
              </div>
            )}
          </div>
        </div>

        <footer className="project-create-footer">
          <span className="project-create-error" role="alert">
            {error}
          </span>
          <button
            type="button"
            className="project-create-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="project-create-submit"
            disabled={busy}
            onClick={() => void submit()}
          >
            {!busy && <Icon name="add" size={15} />}
            {busy ? '保存中…' : submitLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
