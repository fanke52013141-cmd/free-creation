import { useEffect, useState } from 'react'
import type { LibraryResourceDetail, LibraryResourceSummary } from '@shared/library/types'
import type { MediaAsset } from '@shared/types'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import { useToastStore } from '../stores/toast'
import './library.css'

export function LibraryResourcePicker({
  projectId,
  onAddMedia,
  onAddText
}: {
  projectId: string
  onAddMedia: (asset: MediaAsset) => void
  onAddText: (text: string, title: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [resources, setResources] = useState<LibraryResourceSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LibraryResourceDetail | null>(null)
  const [busyComponentId, setBusyComponentId] = useState<string | null>(null)
  const [recipeValues, setRecipeValues] = useState<Record<string, Record<string, string>>>({})

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api.searchLibrary({ query, limit: 32 }).then((result) => {
        if (cancelled) return
        if (result.ok) setResources(result.data.items)
        else useToastStore.getState().show(`资源搜索失败：${result.error.message}`)
      })
    }, 160)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    let cancelled = false
    void window.api.getLibraryResource({ resourceId: selectedId }).then((result) => {
      if (cancelled) return
      if (result.ok) setDetail(result.data)
      else useToastStore.getState().show(`读取资源失败：${result.error.message}`)
    })
    return () => { cancelled = true }
  }, [selectedId])

  const addComponent = async (componentId: string): Promise<void> => {
    if (!detail) return
    const component = detail.components.find((item) => item.id === componentId)
    if (!component) return
    if (component.valueType === 'recipe') {
      const required = [...new Set([...(component.text ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g)].map((match) => match[1]))]
      const values = recipeValues[component.id] ?? {}
      const missing = required.filter((name) => !values[name]?.trim())
      if (missing.length) {
        useToastStore.getState().show(`请先填写配方变量：${missing.join('、')}`)
        return
      }
    }
    setBusyComponentId(componentId)
    const result = await window.api.materializeLibraryResource({
      projectId,
      resourceId: detail.id,
      revisionId: detail.latestRevisionId,
      componentIds: [componentId]
    })
    setBusyComponentId(null)
    if (!result.ok) return useToastStore.getState().show(`加入画布失败：${result.error.message}`)
    for (const asset of result.data.assets) onAddMedia(asset)
    for (const textComponent of result.data.textComponents) {
      let text = textComponent.text ?? ''
      if (textComponent.valueType === 'recipe') {
        const values = recipeValues[textComponent.id] ?? {}
        text = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g, (_match, name: string) => values[name] || `{{${name}}}`)
      }
      onAddText(text, `${detail.selectedTitle} · ${textComponent.role}`)
    }
    if (component) useToastStore.getState().show(`已加入「${component.role}」`)
  }

  return (
    <div className="library-picker">
      <div className="library-picker-intro"><strong>从资源库添加</strong><p>选择一个组件，素材会复制到当前项目并创建对应节点。</p></div>
      <label className="library-picker-search"><Icon name="search" size={14} /><input value={query} placeholder="搜索图片、提示词、人物和风格" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <div className="library-picker-list">
        {resources.length === 0 && <div className="library-picker-empty">没有找到资源。可以先在项目首页的资源库里创建或收藏。</div>}
        {resources.map((resource) => (
          <article className={`library-picker-resource${selectedId === resource.id ? ' selected' : ''}`} key={resource.id}>
            <button className="library-picker-resource-head" onClick={() => setSelectedId((current) => current === resource.id ? null : resource.id)}>
              {resource.coverPath ? <img src={mediaUrl(resource.coverPath)} alt="" /> : <span className="library-picker-icon"><Icon name="assets" size={15} /></span>}
              <span><strong>{resource.title}</strong><small>{resource.formPreset} · v{resource.revisionNumber} · {resource.componentCount} 个组件</small></span>
              <Icon name={selectedId === resource.id ? 'close' : 'add'} size={14} />
            </button>
            {selectedId === resource.id && detail?.id === resource.id && (
              <div className="library-picker-components">
                {detail.components.map((component) => (
                  <div className="library-picker-component" key={component.id}>
                    <div><strong>{component.role}</strong><span>{component.valueType}</span></div>
                    {component.valueType === 'recipe' && component.text !== undefined ? (() => {
                      const detected = [...component.text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g)].map((match) => match[1])
                      const declared = Array.isArray(component.metadata.variables) ? component.metadata.variables.filter((value): value is string => typeof value === 'string') : []
                      const variables = [...new Set([...declared, ...detected])]
                      const values = recipeValues[component.id] ?? {}
                      const preview = component.text!.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g, (_match, name: string) => values[name] || `{{${name}}}`)
                      return <>
                        {variables.map((name) => <label className="library-picker-variable" key={name}><span>{name}</span><input value={values[name] ?? ''} placeholder={`填写 ${name}`} onChange={(event) => setRecipeValues((current) => ({ ...current, [component.id]: { ...current[component.id], [name]: event.currentTarget.value } }))} /></label>)}
                        <p className="library-picker-recipe-preview">{preview.slice(0, 240) || '（空提示词）'}</p>
                      </>
                    })() : component.text !== undefined && <p>{component.text.slice(0, 160) || '（空文本）'}</p>}
                    {component.valueType === 'image' && component.blobPath && <img className="library-picker-preview" src={mediaUrl(component.blobPath)} alt={component.role} />}
                    <button disabled={busyComponentId === component.id} onClick={() => void addComponent(component.id)}>
                      {busyComponentId === component.id ? '添加中…' : component.valueType === 'recipe' ? '使用配方，加入画布' : '加入画布'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
