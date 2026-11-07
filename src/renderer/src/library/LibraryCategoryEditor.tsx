import { useState } from 'react'
// 先加载库级基础样式，再加载本编辑器的局部视觉层，保证同权重规则以局部样式收口。
import './library.css'
import './library-forms.css'
import {
  LIBRARY_NODE_ADAPTERS,
  parseCategory,
  type LibraryCategory,
  type LibraryNodeSlot,
  type LibraryNodeType
} from '@shared/library/blueprint'
import { Icon } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'

const newSlot = (nodeType: LibraryNodeType = 'image'): LibraryNodeSlot => ({
  id: `slot-${crypto.randomUUID()}`,
  label: LIBRARY_NODE_ADAPTERS[nodeType].label,
  nodeType,
  contractVersion: LIBRARY_NODE_ADAPTERS[nodeType].contractVersion,
  required: false,
  multiple: true,
  titleTemplate: '{slot} {index}'
})

export function LibraryCategoryEditor({
  initial,
  onClose,
  onSaved
}: {
  initial?: LibraryCategory
  onClose: () => void
  onSaved: (category: LibraryCategory) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<LibraryCategory>(() =>
    initial
      ? { ...initial, version: initial.version + 1 }
      : {
          id: crypto.randomUUID(),
          version: 1,
          name: '',
          description: '',
          presentation: 'gallery',
          blueprint: { protocolVersion: 1, layout: 'grid', slots: [newSlot()] }
        }
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const updateSlot = (id: string, patch: Partial<LibraryNodeSlot>): void =>
    setDraft((current) => ({
      ...current,
      blueprint: {
        ...current.blueprint,
        slots: current.blueprint.slots.map((slot) =>
          slot.id === id ? { ...slot, ...patch } : slot
        )
      }
    }))
  const addSlot = (): void =>
    setDraft((current) => ({
      ...current,
      blueprint: { ...current.blueprint, slots: [...current.blueprint.slots, newSlot()] }
    }))
  const moveSlotUp = (index: number): void => {
    if (!index) return
    setDraft((current) => {
      const slots = [...current.blueprint.slots]
      ;[slots[index - 1], slots[index]] = [slots[index], slots[index - 1]]
      return { ...current, blueprint: { ...current.blueprint, slots } }
    })
  }
  const removeSlot = (id: string): void =>
    setDraft((current) => ({
      ...current,
      coverSlotId: current.coverSlotId === id ? undefined : current.coverSlotId,
      blueprint: {
        ...current.blueprint,
        slots: current.blueprint.slots.filter((item) => item.id !== id)
      }
    }))
  const save = async (): Promise<void> => {
    setError('')
    try {
      const category = parseCategory(draft)
      setBusy(true)
      const result = await window.api.saveLibraryCategory({
        category,
        baseVersion: initial?.version ?? 0
      })
      if (!result.ok) throw new Error(result.error.message)
      onSaved(result.data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="library-form-mask">
      <section
        className="library-form-dialog library-category-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="资源分类编辑器"
      >
        <header className="library-form-header">
          <h2>{initial ? '编辑分类' : '新建资源分类'}</h2>
          <button
            type="button"
            className="library-icon-button"
            disabled={busy}
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="library-form-scroll">
          <section className="library-form-group">
            <header className="library-form-group-head">
              <span className="library-form-group-index" aria-hidden="true">
                1
              </span>
              <div className="library-form-group-title">
                <h3>基本信息</h3>
              </div>
            </header>
            <div className="library-form-group-body">
              <label className="library-form-field">
                <span>分类名称</span>
                <input
                  autoFocus
                  maxLength={100}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如：品牌角色卡"
                />
              </label>
              <label className="library-form-field">
                <span>分类说明</span>
                <textarea
                  value={draft.description}
                  maxLength={2000}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="library-form-group">
            <header className="library-form-group-head">
              <span className="library-form-group-index" aria-hidden="true">
                2
              </span>
              <div className="library-form-group-title">
                <h3>包含的节点</h3>
                <p>每项内容有明确的节点类型；开启“允许多项”后，每份内容分别创建节点。</p>
              </div>
              <button
                type="button"
                className="library-form-group-action"
                disabled={draft.blueprint.slots.length >= 32}
                onClick={addSlot}
              >
                <Icon name="add" size={13} />
                添加节点槽位
              </button>
            </header>
            <div className="library-form-group-body">
              {draft.blueprint.slots.map((slot, index) => (
                <article className="library-component-edit library-category-slot" key={slot.id}>
                  <div className="library-component-edit-head">
                    <strong>节点 {index + 1}</strong>
                    <div className="library-category-slot-tools">
                      <button
                        type="button"
                        className="library-icon-button library-slot-icon"
                        title="上移"
                        aria-label={`上移节点 ${index + 1}`}
                        disabled={!index}
                        onClick={() => moveSlotUp(index)}
                      >
                        <Icon name="bring-front" size={14} />
                      </button>
                      <button
                        type="button"
                        className="library-icon-button library-slot-icon library-slot-remove"
                        title="移除"
                        aria-label={`移除节点 ${index + 1}`}
                        onClick={() => removeSlot(slot.id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="library-form-grid">
                    <label>
                      <span>内容名称</span>
                      <input
                        value={slot.label}
                        maxLength={80}
                        onChange={(e) => updateSlot(slot.id, { label: e.target.value })}
                        placeholder="例如：正面形象"
                      />
                    </label>
                    <label>
                      <span>映射到节点</span>
                      <AppSelect
                        aria-label="映射到节点"
                        value={slot.nodeType}
                        onChange={(e) => {
                          const type = e.target.value as LibraryNodeType
                          setDraft((current) => ({
                            ...current,
                            coverSlotId:
                              current.coverSlotId === slot.id && type !== 'image'
                                ? undefined
                                : current.coverSlotId,
                            blueprint: {
                              ...current.blueprint,
                              slots: current.blueprint.slots.map((item) =>
                                item.id === slot.id
                                  ? {
                                      ...item,
                                      nodeType: type,
                                      contractVersion: LIBRARY_NODE_ADAPTERS[type].contractVersion
                                    }
                                  : item
                              )
                            }
                          }))
                        }}
                      >
                        {Object.entries(LIBRARY_NODE_ADAPTERS).map(([type, adapter]) => (
                          <option key={type} value={type}>
                            {adapter.label}
                          </option>
                        ))}
                      </AppSelect>
                    </label>
                  </div>
                  <div className="library-slot-options">
                    <label>
                      <input
                        type="checkbox"
                        checked={slot.required}
                        onChange={(e) => updateSlot(slot.id, { required: e.target.checked })}
                      />
                      必填
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={slot.multiple}
                        onChange={(e) => updateSlot(slot.id, { multiple: e.target.checked })}
                      />
                      允许多项
                    </label>
                  </div>
                </article>
              ))}
            </div>
          </section>

          {error && (
            <div className="library-form-error" role="alert">
              <Icon name="warning" size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>
        <footer className="library-form-footer">
          <button
            type="button"
            className="library-form-secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="library-form-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存分类'}
          </button>
        </footer>
      </section>
    </div>
  )
}
