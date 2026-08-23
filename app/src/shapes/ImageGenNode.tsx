import { BaseBoxShapeUtil, T, useEditor, type RecordProps, type TLShape } from 'tldraw'
import { useCallback, useEffect } from 'react'
import { useAppData } from '../store'
import { describeSource, getCompatibleSources, getImageUrls, getTextValue, markNodeAndDependentsDirty, replaceDataDependency } from './dependencies'
import { runImageGeneration } from './image'
import { IMAGE_GEN_TYPE, type ImageGenNodeShape } from './types'
import { useCanvasProjectId } from '../components/projectContext'
import { toNodeRunState, waitForGenerationTask } from './video'
import { isActiveRunState, normalizeTextInput } from './runtime'
import { NodePortMarkers } from './NodePortMarkers'

export class ImageGenNodeUtil extends BaseBoxShapeUtil<ImageGenNodeShape> {
  static override type = IMAGE_GEN_TYPE
  static override props: RecordProps<ImageGenNodeShape> = {
    w: T.number, h: T.number, title: T.string, prompt: T.string, promptRef: T.string, referenceRef: T.string,
    modelId: T.string, size: T.string, quality: T.string, resultUrlsJson: T.string, runState: T.string, lastError: T.string,
  }
  override getDefaultProps(): ImageGenNodeShape['props'] {
    return { w: 360, h: 360, title: '图片生成', prompt: '', promptRef: '', referenceRef: '', modelId: '', size: '1024x1024', quality: 'standard', resultUrlsJson: '[]', runState: 'idle', lastError: '' }
  }
  component(shape: ImageGenNodeShape) { return <ImageGenNodeComponent shape={shape} /> }
  getIndicatorPath(shape: ImageGenNodeShape) { const path = new Path2D(); path.roundRect(0, 0, shape.props.w, shape.props.h, 10); return path }
}

function parseResultUrls(json: string): string[] {
  try { const value: unknown = JSON.parse(json); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}

function ImageGenNodeComponent({ shape }: { shape: ImageGenNodeShape }) {
  const editor = useEditor()
  const projectId = useCanvasProjectId()
  const data = useAppData()
  const props = shape.props
  const configOpen = shape.meta.configOpen === true
  const promptSources = getCompatibleSources(editor, shape.type, 'prompt', shape.id)
  const referenceSources = getCompatibleSources(editor, shape.type, 'references', shape.id)
  const imageModels = data.models.filter((model) => model.type === 'image')
  const resultUrls = parseResultUrls(props.resultUrlsJson)
  const taskId = typeof shape.meta.taskId === 'string' ? shape.meta.taskId : ''
  const progress = typeof shape.meta.progress === 'number' ? shape.meta.progress : 0
  const active = isActiveRunState(props.runState)
  const update = (patch: Partial<ImageGenNodeShape['props']>) => editor.updateShape({ id: shape.id, type: IMAGE_GEN_TYPE, props: patch })
  const setConfigOpen = (open: boolean) => editor.updateShape({ id: shape.id, type: IMAGE_GEN_TYPE, meta: { ...shape.meta, configOpen: open } })
  const connect = (port: 'prompt' | 'references', sourceId: string) => replaceDataDependency(editor, shape, port, sourceId, (value) => update(port === 'prompt' ? { promptRef: value } : { referenceRef: value }))

  const applyTask = useCallback((task: { id: string; status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'; progress: number; resultUrls: string[]; error?: string }) => {
    const current = editor.getShape(shape.id)
    editor.updateShape({ id: shape.id, type: IMAGE_GEN_TYPE, props: { runState: toNodeRunState(task.status), lastError: task.error ?? '', ...(task.status === 'done' ? { resultUrlsJson: JSON.stringify(task.resultUrls) } : {}) }, meta: { ...current?.meta, taskId: task.id, progress: task.progress } })
    if (task.status === 'done') markNodeAndDependentsDirty(editor, shape.id, false)
  }, [editor, shape.id])

  useEffect(() => {
    if (!taskId || !active) return
    void waitForGenerationTask(taskId, applyTask).catch((error) => editor.updateShape({ id: shape.id, type: IMAGE_GEN_TYPE, props: { runState: 'error', lastError: error instanceof Error ? error.message : String(error) } }))
  }, [active, applyTask, editor, shape.id, taskId])

  const run = async () => {
    if (active) return
    const model = data.models.find((item) => item.id === props.modelId)
    if (!model) return update({ runState: 'error', lastError: '请在设置中选择图片模型' })
    const promptSource = props.promptRef ? editor.getShape(props.promptRef as TLShape['id']) : null
    const resolved = promptSource ? getTextValue(promptSource) : props.prompt.trim()
    const prompts = normalizeTextInput(resolved)
    if (!prompts.length || prompts.some((prompt) => !prompt.trim())) return update({ runState: 'error', lastError: '请填写 prompt 或连接有内容的文本输入。' })
    const referenceSource = props.referenceRef ? editor.getShape(props.referenceRef as TLShape['id']) : null
    const referenceUrls = referenceSource ? getImageUrls(referenceSource) : []
    if (referenceSource && !referenceUrls.length) return update({ runState: 'error', lastError: '参考图节点没有可用图片 URL。' })
    update({ runState: 'queued', lastError: '' })
    try {
      const result = await runImageGeneration({ projectId, profileId: model.id, prompts, referenceUrls, size: props.size, quality: props.quality, onUpdate: applyTask })
      if (result.status === 'failed') throw new Error(result.error || '图片任务失败')
    } catch (error) {
      update({ runState: 'error', lastError: error instanceof Error ? error.message : String(error) })
    }
  }

  return <div style={{ pointerEvents: 'all' }} className="w-full h-full flex flex-col node-card node-card-imagegen"><NodePortMarkers type={shape.type} />
    <header onPointerDown={(event) => event.stopPropagation()} className="node-header">
      <span className="node-kicker">✦</span><input value={props.title} onChange={(event) => update({ title: event.target.value })} className="node-title" />
      <button onClick={() => setConfigOpen(!configOpen)} className="node-icon-button">⚙</button>
    </header>
    {configOpen && <div onPointerDown={(event) => event.stopPropagation()} className="node-config">
      <label className="block text-neutral-500">Prompt 输入（真实数据依赖）
        <select value={props.promptRef} onChange={(event) => connect('prompt', event.target.value)} className="mt-1 w-full p-1.5 border rounded"><option value="">— 使用下方手填 prompt —</option>{promptSources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}</select>
      </label>
      {!props.promptRef && <textarea value={props.prompt} onChange={(event) => update({ prompt: event.target.value, runState: 'dirty', lastError: '' })} onKeyDown={(event) => event.stopPropagation()} rows={3} placeholder="描述要生成的画面…" className="w-full p-2 border rounded resize-none" />}
      <label className="block text-neutral-500">参考图（可选）
        <select value={props.referenceRef} onChange={(event) => connect('references', event.target.value)} className="mt-1 w-full p-1.5 border rounded"><option value="">— 无参考图，文生图 —</option>{referenceSources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}</select>
      </label>
      <div className="grid grid-cols-3 gap-2"><label className="text-neutral-500">模型<select value={props.modelId} onChange={(event) => update({ modelId: event.target.value, runState: 'dirty', lastError: '' })} className="mt-1 w-full p-1.5 border rounded"><option value="">选择图片模型</option>{imageModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label className="text-neutral-500">尺寸<select value={props.size} onChange={(event) => update({ size: event.target.value, runState: 'dirty', lastError: '' })} className="mt-1 w-full p-1.5 border rounded"><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option></select></label><label className="text-neutral-500">质量<select value={props.quality} onChange={(event) => update({ quality: event.target.value, runState: 'dirty', lastError: '' })} className="mt-1 w-full p-1.5 border rounded"><option value="standard">标准</option><option value="high">高</option></select></label></div>
    </div>}
    <div onPointerDown={(event) => event.stopPropagation()} className="node-body node-media-body">
      {resultUrls.length ? <div className="grid grid-cols-2 gap-2">{resultUrls.map((url, index) => <img key={`${url}-${index}`} src={url} className="w-full rounded border border-pink-100 object-cover" />)}</div> : <p className="h-full flex items-center justify-center text-xs text-neutral-400">生成结果会作为 Image[] 输出，可继续接到图片/视频节点</p>}
    </div>
    {props.runState === 'error' && <div className="node-error">⚠ {props.lastError}</div>}
    {active && <div className="px-3 pb-2"><div className="node-status-line"><span>{props.runState === 'queued' ? '排队中' : '图片任务执行中'}</span><span>{progress}%</span></div><div className="node-progress"><span style={{ width: `${progress}%` }} /></div></div>}
    <footer onPointerDown={(event) => event.stopPropagation()} className="node-footer"><button onClick={run} disabled={active} className="node-primary">{active ? '生成中…' : props.runState === 'error' ? '重试' : '生成图片'}</button></footer>
  </div>
}
