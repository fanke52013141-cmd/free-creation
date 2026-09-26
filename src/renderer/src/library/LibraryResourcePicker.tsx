import { useEffect, useState } from 'react'
import type { LibraryResourceDetail, LibraryResourceSummary } from '@shared/library/types'
import type { Editor } from 'tldraw'
import { insertResource } from './insertResource'
import { legacyCategory, planResourceNodes } from '@shared/library/blueprint'
import { Icon } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import { useToastStore } from '../stores/toast'
import './library.css'

export function LibraryResourcePicker({ projectId, editor }: {
  projectId: string
  editor: Editor | null
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [resources, setResources] = useState<LibraryResourceSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LibraryResourceDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedComponents, setSelectedComponents] = useState<string[]>([])
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
    if (!selectedId) return
    let cancelled = false
    void window.api.getLibraryResource({ resourceId: selectedId }).then((result) => {
      if (cancelled) return
      if (result.ok) setDetail(result.data)
      else useToastStore.getState().show(`读取资源失败：${result.error.message}`)
    })
    return () => { cancelled = true }
  }, [selectedId])

  const addComponents = async (componentIds: string[]): Promise<void> => {
    if (!detail || detail.id !== selectedId || !editor || busy) return
    setBusy(true)
    try {
      await insertResource(editor, projectId, detail, componentIds, recipeValues)
      useToastStore.getState().show(`已将 ${componentIds.length} 项内容加入画布，可一次撤销`)
    } catch (cause) { useToastStore.getState().show(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const nodeLabel = (componentId: string): string => {
    if (!detail) return ''
    try {
      const category = detail.category ?? legacyCategory(detail.formPreset, detail.components)
      const plan = planResourceNodes(category, detail.components, detail.selectedTitle, [componentId], recipeValues)
      return plan[0]?.title ?? ''
    } catch { return '填写内容后可加入对应节点' }
  }

  return (
    <div className="library-picker">
      <div className="library-picker-intro"><strong>从资源库添加</strong><p>按分类蓝图整组加入，或选择部分内容。加入时会创建真实节点，不会自动运行。</p></div>
      <label className="library-picker-search"><Icon name="search" size={14} /><input value={query} placeholder="搜索图片、提示词、人物和风格" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <div className="library-picker-list">
        {resources.length === 0 && <div className="library-picker-empty">没有找到资源。可以先在项目首页的资源库里创建或收藏。</div>}
        {resources.map((resource) => (
          <article className={`library-picker-resource${selectedId === resource.id ? ' selected' : ''}`} key={resource.id}>
            <button className="library-picker-resource-head" disabled={busy} onClick={() => { setSelectedId((current) => current === resource.id ? null : resource.id); setSelectedComponents([]) }}>
              {resource.coverPath ? <img src={mediaUrl(resource.coverPath)} alt="" /> : <span className="library-picker-icon"><Icon name="assets" size={15} /></span>}
              <span><strong>{resource.title}</strong><small>{resource.category?.name ?? '旧版资源'} · v{resource.revisionNumber} · {resource.componentCount} 个组件</small></span>
              <Icon name={selectedId === resource.id ? 'close' : 'add'} size={14} />
            </button>
            {selectedId === resource.id && detail?.id === resource.id && (
              <div className="library-picker-components">
                <div className="library-picker-batch"><button disabled={busy || !editor} onClick={() => void addComponents(detail.components.map((item) => item.id))}>整份加入画布（{detail.components.length} 个节点）</button>
                  <button disabled={busy || !editor || !selectedComponents.length} onClick={() => void addComponents(selectedComponents)}>加入所选（{selectedComponents.length}）</button></div>
                <small>按这份资源保存时的节点组合展开并加入画布。</small>
                {detail.components.map((component) => (
                  <div className="library-picker-component" key={component.id}>
                    <label><input type="checkbox" disabled={busy} checked={selectedComponents.includes(component.id)} onChange={(e) => setSelectedComponents((ids) => e.target.checked ? [...ids, component.id] : ids.filter((id) => id !== component.id))} /><strong>{component.role}</strong><span>{component.valueType}</span></label><small>{nodeLabel(component.id)}</small>
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
                    <button disabled={busy || !editor} onClick={() => void addComponents([component.id])}>
                      {busy ? '添加中…' : component.valueType === 'recipe' ? '使用配方，加入画布' : '加入画布'}
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
