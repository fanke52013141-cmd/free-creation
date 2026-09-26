import { useMemo, useState } from 'react'
import type {
  CreateLibraryResourceInput,
  LibraryCollection,
  LibraryResourceDetail,
  LibraryValueType,
  PublishLibraryRevisionInput
} from '@shared/library/types'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'

interface ComponentDraft {
  key: string
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
  collections: LibraryCollection[]
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

const basicDraft = (role: string, valueType: LibraryValueType = 'text'): ComponentDraft => ({
  key: crypto.randomUUID(), role, valueType, text: '',
  ...(valueType === 'recipe' ? { variablesText: '', parametersText: '{}', referenceRolesText: '' } : {})
})

function initialDrafts(detail: LibraryResourceDetail | undefined, preset: LibraryResourceDetail['formPreset'] | 'image'): ComponentDraft[] {
  if (detail) return detail.components.map((component) => ({
    key: component.id,
    role: component.role,
    valueType: component.valueType,
    text: component.text ?? '',
    reuseComponentId: component.id,
    blobPath: component.blobPath,
    mime: component.mime,
    fileName: component.fileName,
    ...(component.valueType === 'recipe' ? {
      variablesText: Array.isArray(component.metadata.variables) ? component.metadata.variables.join(', ') : '',
      parametersText: JSON.stringify(component.metadata.modelParameters ?? {}, null, 2),
      referenceRolesText: Array.isArray(component.metadata.referenceRoles) ? component.metadata.referenceRoles.join(', ') : ''
    } : {})
  }))
  switch (preset) {
    case 'prompt': return [basicDraft('prompt')]
    case 'character': return [basicDraft('description'), basicDraft('prompt')]
    case 'scene': return [basicDraft('description'), basicDraft('prompt')]
    case 'style': return [basicDraft('style-notes'), basicDraft('style-prompt')]
    default: return []
  }
}

function valueTypeForFile(file: File): LibraryValueType {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

const TEXT_TYPES = new Set<LibraryValueType>(['text', 'markdown', 'json', 'recipe'])
const MAX_COMPONENT_BYTES = 128 * 1024 * 1024

export function LibraryResourceForm({ collections, detail, onCancel, onSave }: LibraryResourceFormProps): React.JSX.Element {
  const [formPreset, setFormPreset] = useState(detail?.formPreset ?? 'image')
  const [title, setTitle] = useState(detail?.selectedTitle ?? '')
  const [description, setDescription] = useState(detail?.selectedDescription ?? '')
  const [tags, setTags] = useState(detail?.tags.join(', ') ?? '')
  const [collectionIds, setCollectionIds] = useState<Set<string>>(() => new Set(detail?.collectionIds ?? []))
  const [changeNote, setChangeNote] = useState('')
  const [components, setComponents] = useState<ComponentDraft[]>(() => initialDrafts(detail, detail?.formPreset ?? 'image'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const availablePresets = useMemo(() => Object.entries(PRESET_LABELS) as Array<[typeof formPreset, string]>, [])

  const updateComponent = (key: string, patch: Partial<ComponentDraft>): void => {
    setComponents((items) => items.map((item) => item.key === key ? { ...item, ...patch } : item))
  }
  const addTextComponent = (): void => {
    setComponents((items) => [...items, {
      key: crypto.randomUUID(), role: 'description', valueType: 'text', text: ''
    }])
  }
  const addRecipeComponent = (): void => {
    setComponents((items) => [...items, basicDraft('prompt-recipe', 'recipe')])
  }
  const addFiles = (files: FileList | null): void => {
    if (!files?.length) return
    const accepted = Array.from(files).filter((file) => file.size <= MAX_COMPONENT_BYTES)
    if (accepted.length !== files.length) setError('单个资源文件最多 128 MB，超限文件已忽略')
    else setError('')
    const added = accepted.map((file) => ({
      key: crypto.randomUUID(),
      role: file.type.startsWith('image/') ? 'reference-image' : file.type.startsWith('audio/') ? 'voice-sample' : file.type.startsWith('video/') ? 'video-reference' : 'reference-file',
      valueType: valueTypeForFile(file),
      text: '',
      file,
      fileName: file.name,
      mime: file.type || 'application/octet-stream'
    } satisfies ComponentDraft))
    setComponents((items) => [...items, ...added])
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) return setError('请填写资源名称')
    if (components.length === 0) return setError('至少添加一个文本或文件组件')
    setBusy(true)
    setError('')
    try {
      const payloadComponents = await Promise.all(components.map(async (component) => {
        if (TEXT_TYPES.has(component.valueType)) {
          let metadata: Record<string, unknown> | undefined
          if (component.valueType === 'recipe') {
            let modelParameters: unknown
            try { modelParameters = JSON.parse(component.parametersText || '{}') as unknown } catch {
              throw new Error(`「${component.role}」的模型参数必须是有效 JSON`)
            }
            if (!modelParameters || typeof modelParameters !== 'object' || Array.isArray(modelParameters)) {
              throw new Error(`「${component.role}」的模型参数必须是 JSON 对象`)
            }
            metadata = {
              variables: (component.variablesText ?? '').split(',').map((name) => name.trim()).filter(Boolean),
              modelParameters,
              referenceRoles: (component.referenceRolesText ?? '').split(',').map((name) => name.trim()).filter(Boolean)
            }
          }
          return {
            role: component.role,
            valueType: component.valueType,
            text: component.text,
            ...(metadata ? { metadata } : {}),
            ...(component.reuseComponentId ? { reuseComponentId: component.reuseComponentId } : {})
          }
        }
        if (component.file) {
          if (component.file.size > MAX_COMPONENT_BYTES) throw new Error(`「${component.role}」超过 128 MB 限制`)
          return {
            role: component.role,
            valueType: component.valueType,
            data: new Uint8Array(await component.file.arrayBuffer()),
            mime: component.mime,
            fileName: component.file.name
          }
        }
        return {
          role: component.role,
          valueType: component.valueType,
          reuseComponentId: component.reuseComponentId
        }
      }))
      const common = {
        title: title.trim(),
        formPreset,
        description: description.trim(),
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        collectionIds: [...collectionIds],
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

  return (
    <div className="library-form-mask" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <section className="library-form-dialog" role="dialog" aria-modal="true" aria-label={detail ? '编辑资源新版本' : '新建资源'}>
        <header className="library-form-header">
          <div><span className="library-eyebrow">RESOURCE</span><h2>{detail ? '发布资源新版本' : '新建资源'}</h2></div>
          <button className="library-icon-button" aria-label="关闭" disabled={busy} onClick={onCancel}><Icon name="close" size={17} /></button>
        </header>
        <div className="library-form-scroll">
          <div className="library-form-grid">
            <label><span>资源名称</span><input autoFocus maxLength={180} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="例如：复古胶片风格" /></label>
            <label><span>资源类型</span><select value={formPreset} onChange={(event) => setFormPreset(event.currentTarget.value as typeof formPreset)}>
              {availablePresets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
          <label className="library-form-field"><span>说明</span><textarea value={description} maxLength={20000} onChange={(event) => setDescription(event.currentTarget.value)} placeholder="记录用途、来源或使用建议" /></label>
          <label className="library-form-field"><span>标签 <small>用逗号分隔</small></span><input value={tags} maxLength={1000} onChange={(event) => setTags(event.currentTarget.value)} placeholder="例如：电影感, 暖色, 角色设定" /></label>

          <div className="library-form-components-head">
            <div><h3>资源内容</h3><p>图片、提示词和说明可以单独保存，也可以组合在同一资源里。</p></div>
            <div className="library-component-add-actions">
              <button type="button" onClick={addTextComponent}><Icon name="text" size={14} /> 添加文本</button>
              <button type="button" onClick={addRecipeComponent}><Icon name="workflow" size={14} /> 添加提示词配方</button>
              <label><Icon name="upload" size={14} /> 添加文件<input type="file" multiple onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = '' }} /></label>
            </div>
          </div>
          <div className="library-component-list">
            {components.map((component, index) => (
              <article className="library-component-edit" key={component.key}>
                <div className="library-component-edit-head">
                  <span>组件 {index + 1} · {component.valueType}</span>
                  <button type="button" aria-label="移除此组件" onClick={() => setComponents((items) => items.filter((item) => item.key !== component.key))}><Icon name="trash" size={13} /></button>
                </div>
                <label className="library-component-role"><span>用途</span><input value={component.role} maxLength={80} onChange={(event) => updateComponent(component.key, { role: event.currentTarget.value })} /></label>
                {TEXT_TYPES.has(component.valueType) ? (
                  <>
                    <textarea className="library-component-text" value={component.text} onChange={(event) => updateComponent(component.key, { text: event.currentTarget.value })} placeholder={component.valueType === 'recipe' ? '提示词模板，例如：{{subject}}，电影感光线' : '输入提示词、描述或备注'} />
                    {component.valueType === 'recipe' && <div className="library-recipe-fields">
                      <label><span>变量名称 <small>逗号分隔，模板使用 {'{{变量名}}'}</small></span><input value={component.variablesText ?? ''} onChange={(event) => updateComponent(component.key, { variablesText: event.currentTarget.value })} placeholder="subject, mood" /></label>
                      <label><span>关联参考组件用途</span><input value={component.referenceRolesText ?? ''} onChange={(event) => updateComponent(component.key, { referenceRolesText: event.currentTarget.value })} placeholder="reference-image, style-board" /></label>
                      <label><span>模型参数 JSON</span><textarea value={component.parametersText ?? '{}'} onChange={(event) => updateComponent(component.key, { parametersText: event.currentTarget.value })} spellCheck={false} /></label>
                    </div>}
                  </>
                ) : (
                  <div className="library-component-file">
                    {component.blobPath && component.valueType === 'image' && <img src={mediaUrl(component.blobPath)} alt={component.fileName ?? component.role} />}
                    <span>{component.file?.name ?? component.fileName ?? '待选择文件'}</span>
                    <label>替换文件<input type="file" onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file) updateComponent(component.key, {
                        file, fileName: file.name, mime: file.type || 'application/octet-stream',
                        valueType: valueTypeForFile(file), reuseComponentId: undefined, blobPath: undefined
                      })
                      event.currentTarget.value = ''
                    }} /></label>
                  </div>
                )}
              </article>
            ))}
            {components.length === 0 && <div className="library-form-empty">还没有组件。可添加文本或上传图片、音频、视频和文件。</div>}
          </div>

          {collections.length > 0 && (
            <fieldset className="library-form-collections"><legend>收藏集</legend>
              {collections.map((collection) => (
                <label key={collection.id}><input type="checkbox" checked={collectionIds.has(collection.id)} onChange={() => setCollectionIds((current) => {
                  const next = new Set(current)
                  if (next.has(collection.id)) next.delete(collection.id)
                  else next.add(collection.id)
                  return next
                })} />{collection.name}</label>
              ))}
            </fieldset>
          )}
          {detail && <label className="library-form-field"><span>本次修改说明</span><input maxLength={1000} value={changeNote} onChange={(event) => setChangeNote(event.currentTarget.value)} placeholder="例如：补充侧面参考图并调整人物描述" /></label>}
          {error && <div className="library-form-error" role="alert">{error}</div>}
        </div>
        <footer className="library-form-footer">
          <span>{detail ? `基于 v${detail.selectedRevisionNumber} 编辑，发布为新版本` : PRESET_LABELS[formPreset]}</span>
          <button type="button" className="library-form-secondary" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="library-form-primary" disabled={busy} onClick={() => void submit()}>{busy ? '保存中…' : detail ? '发布新版本' : '保存资源'}</button>
        </footer>
      </section>
    </div>
  )
}
