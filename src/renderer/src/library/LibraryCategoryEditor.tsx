import { useState } from 'react'
import {
  LIBRARY_NODE_ADAPTERS,
  parseCategory,
  type LibraryCategory,
  type LibraryNodeSlot,
  type LibraryNodeType
} from '@shared/library/blueprint'

const newSlot = (nodeType: LibraryNodeType = 'image'): LibraryNodeSlot => ({
  id: `slot-${crypto.randomUUID()}`,
  label: LIBRARY_NODE_ADAPTERS[nodeType].label,
  nodeType,
  contractVersion: LIBRARY_NODE_ADAPTERS[nodeType].contractVersion,
  required: false,
  multiple: true,
  titleTemplate: '{resource} · {slot} {index}'
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
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="library-form-scroll">
          <div className="library-form-grid">
            <label>
              <span>分类名称</span>
              <input
                autoFocus
                maxLength={100}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="例如：品牌角色卡"
              />
            </label>
            <label>
              <span>展示样式</span>
              <select
                value={draft.presentation}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    presentation: e.target.value as LibraryCategory['presentation']
                  })
                }
              >
                <option value="gallery">图片卡片</option>
                <option value="profile">档案卡片</option>
                <option value="list">内容列表</option>
              </select>
            </label>
          </div>
          <label className="library-form-field">
            <span>分类说明</span>
            <textarea
              value={draft.description}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <div className="library-form-grid">
            <label>
              <span>封面内容</span>
              <select
                value={draft.coverSlotId ?? ''}
                onChange={(e) => setDraft({ ...draft, coverSlotId: e.target.value || undefined })}
              >
                <option value="">第一张图片</option>
                {draft.blueprint.slots
                  .filter((slot) => slot.nodeType === 'image')
                  .map((slot) => (
                    <option key={slot.id} value={slot.id}>
                      {slot.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>加入画布后的排列</span>
              <select
                value={draft.blueprint.layout}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    blueprint: { ...draft.blueprint, layout: e.target.value as 'row' | 'grid' }
                  })
                }
              >
                <option value="grid">网格排列</option>
                <option value="row">横向排列</option>
              </select>
            </label>
          </div>
          <div className="library-form-components-head">
            <div>
              <h3>包含的节点</h3>
              <p>每项内容有明确的节点类型；开启“允许多项”后，每份内容分别创建节点。</p>
            </div>
            <button
              disabled={draft.blueprint.slots.length >= 32}
              onClick={() =>
                setDraft({
                  ...draft,
                  blueprint: { ...draft.blueprint, slots: [...draft.blueprint.slots, newSlot()] }
                })
              }
            >
              添加节点槽位
            </button>
          </div>
          {draft.blueprint.slots.map((slot, index) => (
            <article className="library-component-edit" key={slot.id}>
              <div className="library-component-edit-head">
                <strong>节点 {index + 1}</strong>
                <button
                  onClick={() =>
                    setDraft({
                      ...draft,
                      coverSlotId: draft.coverSlotId === slot.id ? undefined : draft.coverSlotId,
                      blueprint: {
                        ...draft.blueprint,
                        slots: draft.blueprint.slots.filter((item) => item.id !== slot.id)
                      }
                    })
                  }
                >
                  移除
                </button>
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
                  <select
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
                  </select>
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
                <button
                  disabled={!index}
                  onClick={() =>
                    setDraft((current) => {
                      const slots = [...current.blueprint.slots]
                      ;[slots[index - 1], slots[index]] = [slots[index], slots[index - 1]]
                      return { ...current, blueprint: { ...current.blueprint, slots } }
                    })
                  }
                >
                  上移
                </button>
              </div>
              <label className="library-form-field">
                <span>节点名称模板</span>
                <input
                  value={slot.titleTemplate}
                  maxLength={180}
                  onChange={(e) => updateSlot(slot.id, { titleTemplate: e.target.value })}
                />
              </label>
              <small>{'{resource} = 资源名称，{slot} = 内容名称，{index} = 序号'}</small>
            </article>
          ))}
          <div className={`library-blueprint-preview presentation-${draft.presentation}`}>
            <strong>{draft.name || '分类名称'} · 展开预览</strong>
            <div className={`library-blueprint-nodes layout-${draft.blueprint.layout}`}>
              {draft.blueprint.slots.map((slot) => (
                <span key={slot.id}>
                  {LIBRARY_NODE_ADAPTERS[slot.nodeType].label}
                  <b>
                    {slot.titleTemplate
                      .replaceAll('{resource}', '示例资源')
                      .replaceAll('{slot}', slot.label)
                      .replaceAll('{index}', '1')}
                  </b>
                  <small>
                    {slot.required ? '必填' : '可选'}
                    {slot.multiple ? ' · 可多项' : ' · 单项'}
                  </small>
                </span>
              ))}
            </div>
          </div>
          {initial && <p>保存分类配置后，新建资源会使用更新后的节点组合；已有资源内容保持不变。</p>}
          {error && (
            <p className="library-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="library-form-footer">
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="library-form-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存分类'}
          </button>
        </footer>
      </section>
    </div>
  )
}
