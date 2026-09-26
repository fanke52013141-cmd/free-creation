import { useState } from 'react'
import { acceptsValue, type LibraryCategory, type LibraryNodeSlot } from '@shared/library/blueprint'
import { LIBRARY_NODE_ADAPTERS } from '@shared/library/blueprint'
import type {
  CreateLibraryResourceInput,
  LibraryResourceDetail,
  LibraryValueType,
  PublishLibraryRevisionInput
} from '@shared/library/types'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'

interface ComponentDraft {
  key: string
  metadata: Record<string, unknown>
  role: string
  valueType: LibraryValueType
  text: string
  reuseComponentId?: string
  blobPath?: string
  mime?: string
  fileName?: string
  file?: File
  variablesText?: string
  parametersText?: string
  referenceRolesText?: string
}

interface LibraryResourceFormProps {
  categories: LibraryCategory[]
  detail?: LibraryResourceDetail
  onCancel: () => void
  onSave: (input: CreateLibraryResourceInput | PublishLibraryRevisionInput) => Promise<void>
}

const PRESET_LABELS = {
  image: '图片 / 海报',
  prompt: '提示词',
  character: '人物',
  scene: '场景',
  style: '风格',
  custom: '自定义组合'
} as const

const TEXT_TYPES = new Set<LibraryValueType>(['text', 'markdown', 'json', 'recipe'])
const MAX_COMPONENT_BYTES = 128 * 1024 * 1024

function categoryKey(category: LibraryCategory): string {
  return `${category.id}@${category.version}`
}

function valueTypeForSlot(slot: LibraryNodeSlot): LibraryValueType {
  if (slot.nodeType === 'image') return 'image'
  if (slot.nodeType === 'audio') return 'audio'
  if (slot.nodeType === 'video-asset') return 'video'
  if (slot.nodeType === 'file') return 'file'
  if (slot.nodeType === 'json') return 'json'
  return 'text'
}

function basicDraft(
  role: string,
  valueType: LibraryValueType,
  metadata: Record<string, unknown> = {}
): ComponentDraft {
  return {
    key: crypto.randomUUID(),
    metadata,
    role,
    valueType,
    text: '',
    ...(valueType === 'recipe'
      ? { variablesText: '', parametersText: '{}', referenceRolesText: '' }
      : {})
  }
}

function requiredSlotDrafts(category: LibraryCategory): ComponentDraft[] {
  return category.blueprint.slots
    .filter((slot) => slot.required)
    .map((slot) => basicDraft(slot.label, valueTypeForSlot(slot), { librarySlotId: slot.id }))
}

function mapDraftsToCategory(drafts: ComponentDraft[], category: LibraryCategory): ComponentDraft[] {
  const counts = new Map<string, number>()
  return drafts.map((component) => {
    const previousId = typeof component.metadata.librarySlotId === 'string'
      ? component.metadata.librarySlotId
      : undefined
    const previousSlot = category.blueprint.slots.find((slot) => slot.id === previousId)
    const hasCapacity = (slot: LibraryNodeSlot): boolean =>
      slot.multiple || (counts.get(slot.id) ?? 0) === 0
    const slot = previousSlot && acceptsValue(previousSlot, component.valueType) && hasCapacity(previousSlot)
      ? previousSlot
      : category.blueprint.slots.find((candidate) =>
          acceptsValue(candidate, component.valueType) && hasCapacity(candidate)
        )
    if (!slot) {
      const metadata = { ...component.metadata }
      delete metadata.librarySlotId
      return { ...component, metadata }
    }
    counts.set(slot.id, (counts.get(slot.id) ?? 0) + 1)
    return { ...component, metadata: { ...component.metadata, librarySlotId: slot.id } }
  })
}

function initialDrafts(detail: LibraryResourceDetail): ComponentDraft[] {
  return detail.components.map((component) => ({
    key: component.id,
    metadata: component.metadata,
    role: component.role,
    valueType: component.valueType,
    text: component.text ?? '',
    reuseComponentId: component.id,
    blobPath: component.blobPath,
    mime: component.mime,
    fileName: component.fileName,
    ...(component.valueType === 'recipe'
      ? {
          variablesText: Array.isArray(component.metadata.variables)
            ? component.metadata.variables.join(', ')
            : '',
          parametersText: JSON.stringify(component.metadata.modelParameters ?? {}, null, 2),
          referenceRolesText: Array.isArray(component.metadata.referenceRoles)
            ? component.metadata.referenceRoles.join(', ')
            : ''
        }
      : {})
  }))
}

function acceptForValueType(valueType: LibraryValueType): string | undefined {
  if (valueType === 'image') return 'image/*'
  if (valueType === 'audio') return 'audio/*'
  if (valueType === 'video') return 'video/*'
  if (valueType === 'file') return undefined
  return undefined
}

function valueTypeForFile(file: File): LibraryValueType {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

function recipeMetadata(component: ComponentDraft): Record<string, unknown> {
  let modelParameters: unknown
  try {
    modelParameters = JSON.parse(component.parametersText || '{}') as unknown
  } catch {
    throw new Error(`「${component.role}」的模型参数必须是有效 JSON`)
  }
  if (!modelParameters || typeof modelParameters !== 'object' || Array.isArray(modelParameters)) {
    throw new Error(`「${component.role}」的模型参数必须是 JSON 对象`)
  }
  return {
    ...component.metadata,
    variables: (component.variablesText ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    modelParameters,
    referenceRoles: (component.referenceRolesText ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  }
}

export function LibraryResourceForm({
  categories,
  detail,
  onCancel,
  onSave
}: LibraryResourceFormProps): React.JSX.Element {
  const availableCategories = detail?.category
    ? [...categories.filter((item) => item.id !== detail.category!.id), detail.category]
    : categories
  const [selectedCategoryKey, setSelectedCategoryKey] = useState(
    detail?.category ? categoryKey(detail.category) : ''
  )
  const selectedCategory = availableCategories.find((item) => categoryKey(item) === selectedCategoryKey)
  const formPreset = detail?.formPreset ?? 'custom'
  const [title, setTitle] = useState(detail?.selectedTitle ?? '')
  const [description, setDescription] = useState(detail?.selectedDescription ?? '')
  const [changeNote, setChangeNote] = useState('')
  const [components, setComponents] = useState<ComponentDraft[]>(() => detail ? initialDrafts(detail) : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const updateComponent = (key: string, patch: Partial<ComponentDraft>): void => {
    setComponents((items) => items.map((item) => item.key === key ? { ...item, ...patch } : item))
  }

  const addSlotComponent = (slot: LibraryNodeSlot): void => {
    const valueType = valueTypeForSlot(slot)
    setComponents((items) => [
      ...items,
      basicDraft(slot.label, valueType, { librarySlotId: slot.id })
    ])
  }

  const addUnmappedTextComponent = (): void => {
    setComponents((items) => [...items, basicDraft('说明', 'text')])
  }

  const addUnmappedFiles = (files: FileList | null): void => {
    if (!files?.length) return
    const accepted = Array.from(files).filter((file) => file.size <= MAX_COMPONENT_BYTES)
    if (accepted.length !== files.length) setError('单个文件不能超过 128 MB')
    else setError('')
    setComponents((items) => [
      ...items,
      ...accepted.map((file) => ({
        key: crypto.randomUUID(),
        metadata: {},
        role: file.type.startsWith('image/') ? '参考图片' : file.type.startsWith('audio/') ? '声音' : file.type.startsWith('video/') ? '视频' : '文件',
        valueType: valueTypeForFile(file),
        text: '',
        file,
        fileName: file.name,
        mime: file.type || 'application/octet-stream'
      } satisfies ComponentDraft))
    ])
  }

  const removeComponent = (key: string): void => {
    setComponents((items) => items.filter((item) => item.key !== key))
  }

  const replaceFile = (component: ComponentDraft, file?: File): void => {
    if (!file) return
    if (file.size > MAX_COMPONENT_BYTES) {
      setError('单个文件不能超过 128 MB')
      return
    }
    const actualType = valueTypeForFile(file)
    const mappedSlotId = typeof component.metadata.librarySlotId === 'string'
      ? component.metadata.librarySlotId
      : undefined
    const mappedSlot = selectedCategory?.blueprint.slots.find((slot) => slot.id === mappedSlotId)
    if (mappedSlot && mappedSlot.nodeType !== 'file' && actualType !== component.valueType) {
      setError(`「${component.role}」需要选择${component.valueType === 'image' ? '图片' : component.valueType === 'audio' ? '音频' : component.valueType === 'video' ? '视频' : '文件'}类型`)
      return
    }
    setError('')
    updateComponent(component.key, {
      file,
      fileName: file.name,
      mime: file.type || 'application/octet-stream',
      ...(mappedSlot ? {} : { valueType: actualType }),
      reuseComponentId: undefined,
      blobPath: undefined
    })
  }

  const changeTextValueType = (component: ComponentDraft, valueType: LibraryValueType): void => {
    updateComponent(component.key, {
      valueType,
      ...(valueType === 'recipe'
        ? {
            variablesText: component.variablesText ?? '',
            parametersText: component.parametersText ?? '{}',
            referenceRolesText: component.referenceRolesText ?? ''
          }
        : {})
    })
  }

  const handleCategoryChange = (nextKey: string): void => {
    const nextCategory = availableCategories.find((item) => categoryKey(item) === nextKey)
    setSelectedCategoryKey(nextKey)
    setComponents((current) => {
      if (nextCategory) return detail ? mapDraftsToCategory(current, nextCategory) : requiredSlotDrafts(nextCategory)
      if (!detail) return []
      return current.map((item) => {
        const metadata = { ...item.metadata }
        delete metadata.librarySlotId
        return { ...item, metadata }
      })
    })
    setError('')
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) return setError('请填写资源名称')
    if (!detail && !selectedCategory) return setError('请选择资源分类，分类蓝图会决定这份资源包含哪些节点')
    if (components.length === 0) return setError('至少填写一个内容槽位')
    for (const component of components) {
      if (TEXT_TYPES.has(component.valueType) && !component.text.trim()) {
        return setError(`请填写「${component.role}」内容，或移除这个可选槽位`)
      }
      if (!TEXT_TYPES.has(component.valueType) && !component.file && !component.reuseComponentId) {
        return setError(`请为「${component.role}」选择文件，或移除这个可选槽位`)
      }
      if (component.valueType === 'json') {
        try { JSON.parse(component.text) } catch { return setError(`「${component.role}」不是有效 JSON`) }
      }
    }
    if (selectedCategory) {
      for (const slot of selectedCategory.blueprint.slots) {
        const count = components.filter((item) =>
          item.metadata.librarySlotId === slot.id && acceptsValue(slot, item.valueType)
        ).length
        if (slot.required && count === 0) return setError(`请至少添加一个「${slot.label}」`)
        if (!slot.multiple && count > 1) return setError(`「${slot.label}」只允许一个组件`)
      }
    }

    setBusy(true)
    setError('')
    try {
      const payloadComponents = await Promise.all(components.map(async (component) => {
        if (TEXT_TYPES.has(component.valueType)) {
          const metadata = component.valueType === 'recipe' ? recipeMetadata(component) : component.metadata
          return {
            role: component.role,
            valueType: component.valueType,
            text: component.text,
            metadata,
            ...(component.reuseComponentId ? { reuseComponentId: component.reuseComponentId } : {})
          }
        }
        if (component.file) {
          return {
            role: component.role,
            valueType: component.valueType,
            data: new Uint8Array(await component.file.arrayBuffer()),
            mime: component.mime,
            fileName: component.file.name,
            metadata: component.metadata
          }
        }
        return {
          role: component.role,
          valueType: component.valueType,
          metadata: component.metadata,
          reuseComponentId: component.reuseComponentId
        }
      }))
      const common = {
        title: title.trim(),
        formPreset: selectedCategory ? 'custom' as const : formPreset,
        category: selectedCategory ? { id: selectedCategory.id, version: selectedCategory.version } : undefined,
        description: description.trim(),
        tags: detail?.tags ?? [],
        collectionIds: detail?.collectionIds ?? [],
        components: payloadComponents,
        changeNote: changeNote.trim()
      }
      await onSave(detail
        ? { ...common, resourceId: detail.id, baseRevisionId: detail.latestRevisionId, sourceRevisionId: detail.selectedRevisionId }
        : common)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const renderComponent = (component: ComponentDraft, index: number, slot?: LibraryNodeSlot): React.JSX.Element => (
    <article className="library-component-edit" key={component.key}>
      <div className="library-component-edit-head">
        <span>内容 {index + 1} · {component.valueType}</span>
        <button type="button" aria-label={`移除${component.role}`} onClick={() => removeComponent(component.key)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      <label className="library-component-role">
        <span>名称</span>
        <input value={component.role} maxLength={80} onChange={(event) => updateComponent(component.key, { role: event.currentTarget.value })} />
      </label>
      {TEXT_TYPES.has(component.valueType) ? (
        <>
          {slot?.nodeType === 'text' && (
            <label className="library-component-format">
              <span>内容形式</span>
              <select value={component.valueType} onChange={(event) => changeTextValueType(component, event.currentTarget.value as LibraryValueType)}>
                {LIBRARY_NODE_ADAPTERS.text.values.map((value) => (
                  <option key={value} value={value}>{value === 'text' ? '纯文本' : value === 'markdown' ? 'Markdown' : '提示词配方'}</option>
                ))}
              </select>
            </label>
          )}
          <textarea className="library-component-text" value={component.text} onChange={(event) => updateComponent(component.key, { text: event.currentTarget.value })} placeholder={component.valueType === 'recipe' ? '提示词模板，例如：{{subject}}，电影感光线' : component.valueType === 'json' ? '输入有效 JSON' : '输入内容'} />
          {component.valueType === 'recipe' && <div className="library-recipe-fields">
            <label><span>变量名称 <small>逗号分隔，模板使用 {'{{变量名}}'}</small></span><input value={component.variablesText ?? ''} onChange={(event) => updateComponent(component.key, { variablesText: event.currentTarget.value })} placeholder="subject, mood" /></label>
            <label><span>关联参考组件用途</span><input value={component.referenceRolesText ?? ''} onChange={(event) => updateComponent(component.key, { referenceRolesText: event.currentTarget.value })} placeholder="reference-image, style-board" /></label>
            <label><span>模型参数 JSON</span><textarea value={component.parametersText ?? '{}'} onChange={(event) => updateComponent(component.key, { parametersText: event.currentTarget.value })} spellCheck={false} /></label>
          </div>}
        </>
      ) : (
        <div className="library-component-file">
          {component.blobPath && component.valueType === 'image' && <img src={mediaUrl(component.blobPath)} alt={component.fileName ?? component.role} />}
          <span>{component.file?.name ?? component.fileName ?? '尚未选择文件'}</span>
          <label>选择文件<input type="file" accept={acceptForValueType(component.valueType)} onChange={(event) => { replaceFile(component, event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label>
        </div>
      )}
    </article>
  )

  return (
    <div className="library-form-mask" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <section className="library-form-dialog" role="dialog" aria-modal="true" aria-label={detail ? '编辑资源新版本' : '新建资源'}>
        <header className="library-form-header">
          <div><span className="library-eyebrow">RESOURCE</span><h2>{detail ? '发布资源新版本' : '新建资源'}</h2></div>
          <button className="library-icon-button" aria-label="关闭" disabled={busy} onClick={onCancel}><Icon name="close" size={17} /></button>
        </header>
        <div className="library-form-scroll">
          <label className="library-form-field"><span>资源分类</span>
            <select value={selectedCategoryKey} onChange={(event) => handleCategoryChange(event.currentTarget.value)}>
              <option value="">{detail ? '未分类资源' : '选择分类，自动加载对应节点'}</option>
              {availableCategories.map((category) => <option key={categoryKey(category)} value={categoryKey(category)}>{category.name}</option>)}
            </select>
            {detail && selectedCategory && <small>本次保存会记录当前资源内容；之后可在详情中查看和对比每次迭代。</small>}
            {!detail && availableCategories.length === 0 && <small>请先在资源库顶部创建分类。</small>}
          </label>
          <label className="library-form-field"><span>资源名称</span><input autoFocus maxLength={180} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="例如：主角设定" /></label>
          <label className="library-form-field"><span>说明</span><textarea value={description} maxLength={20000} onChange={(event) => setDescription(event.currentTarget.value)} placeholder="记录用途、来源或使用建议" /></label>

          <div className="library-form-components-head">
            <div><h3>资源内容</h3><p>{selectedCategory ? '每个内容槽位都映射到分类定义的画布节点，可按需添加多项。' : '旧资源兼容编辑：可添加文本、图片、音频、视频或文件。'}</p></div>
            {!selectedCategory && <div className="library-component-add-actions">
              <button type="button" onClick={addUnmappedTextComponent}><Icon name="text" size={14} /> 添加文本</button>
              <label><Icon name="upload" size={14} /> 添加文件<input type="file" multiple onChange={(event) => { addUnmappedFiles(event.currentTarget.files); event.currentTarget.value = '' }} /></label>
            </div>}
          </div>

          {selectedCategory ? (
            <div className="library-category-content-slots">
              {selectedCategory.blueprint.slots.map((slot) => {
                const slotComponents = components.filter((item) =>
                  item.metadata.librarySlotId === slot.id && acceptsValue(slot, item.valueType)
                )
                const canAdd = slot.multiple || slotComponents.length === 0
                return (
                  <section className="library-category-content-slot" key={slot.id}>
                    <header><div><strong>{slot.label}</strong><span>{LIBRARY_NODE_ADAPTERS[slot.nodeType].label}{slot.required ? ' · 必填' : ' · 可选'}{slot.multiple ? ' · 可多项' : ''}</span></div>
                      {canAdd && <button type="button" onClick={() => addSlotComponent(slot)}><Icon name="add" size={13} />添加</button>}
                    </header>
                    {slotComponents.map((component, index) => renderComponent(component, index, slot))}
                    {slotComponents.length === 0 && <p className="library-slot-empty">此槽位暂未添加内容</p>}
                  </section>
                )
              })}
              {components.some((item) => !selectedCategory.blueprint.slots.some((slot) =>
                slot.id === item.metadata.librarySlotId && acceptsValue(slot, item.valueType)
              )) && <section className="library-category-content-slot library-category-unmapped">
                <header><div><strong>待映射内容</strong><span>将每项内容关联到当前分类中的兼容节点槽位</span></div></header>
                {components.filter((item) => !selectedCategory.blueprint.slots.some((slot) =>
                  slot.id === item.metadata.librarySlotId && acceptsValue(slot, item.valueType)
                )).map((component, index) => <div key={component.key}>
                  {renderComponent(component, index)}
                  <label className="library-component-format"><span>关联分类槽位</span>
                    <select value={typeof component.metadata.librarySlotId === 'string' ? component.metadata.librarySlotId : ''} onChange={(event) => {
                      const slotId = event.currentTarget.value
                      const metadata = { ...component.metadata }
                      delete metadata.librarySlotId
                      if (slotId) metadata.librarySlotId = slotId
                      updateComponent(component.key, { metadata })
                    }}>
                      <option value="">选择兼容槽位…</option>
                      {selectedCategory.blueprint.slots.filter((slot) => acceptsValue(slot, component.valueType)).map((slot) => {
                        const occupied = !slot.multiple && components.some((item) => item.key !== component.key && item.metadata.librarySlotId === slot.id)
                        return <option key={slot.id} value={slot.id} disabled={occupied}>{slot.label}{occupied ? '（单项已占用）' : ''}</option>
                      })}
                    </select>
                  </label>
                </div>)}
              </section>}
            </div>
          ) : (
            <div className="library-component-list">
              {components.map((component, index) => renderComponent(component, index))}
              {components.length === 0 && <div className="library-form-empty">旧资源暂无组件。</div>}
            </div>
          )}

          {detail && <label className="library-form-field"><span>本次修改说明</span><input maxLength={1000} value={changeNote} onChange={(event) => setChangeNote(event.currentTarget.value)} placeholder="例如：补充侧面参考图并调整人物描述" /></label>}
          {error && <div className="library-form-error" role="alert">{error}</div>}
        </div>
        <footer className="library-form-footer">
          <span>{detail ? `基于 v${detail.selectedRevisionNumber} 编辑，发布为新版本` : selectedCategory?.name ?? PRESET_LABELS[formPreset]}</span>
          <button type="button" className="library-form-secondary" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="library-form-primary" disabled={busy || (!detail && !selectedCategory)} onClick={() => void submit()}>{busy ? '保存中…' : detail ? '发布新版本' : '保存资源'}</button>
        </footer>
      </section>
    </div>
  )
}
