import { BaseBoxShapeUtil, T, useEditor, type RecordProps, type TLShape } from 'tldraw'
import { useCallback, useEffect } from 'react'
import { useAppData } from '../store'
import { describeSource, getCompatibleSources, getImageUrls, getTextValue, markNodeAndDependentsDirty, replaceDataDependency } from './dependencies'
import { VIDEO_GEN_TYPE, type VideoGenNodeShape } from './types'
import { runVideoGeneration, toNodeRunState, waitForGenerationTask } from './video'
import { cancelVideoTask } from '../services/gateway'
import { useCanvasProjectId } from '../components/projectContext'
import { isActiveRunState, normalizeTextInput } from './runtime'
import { NodePortMarkers } from './NodePortMarkers'

export class VideoGenNodeUtil extends BaseBoxShapeUtil<VideoGenNodeShape> {
  static override type = VIDEO_GEN_TYPE
  static override props: RecordProps<VideoGenNodeShape> = {
    w: T.number, h: T.number, title: T.string, prompt: T.string, promptRef: T.string, referenceRef: T.string,
    modelId: T.string, resolution: T.string, duration: T.number, taskId: T.string, resultUrlsJson: T.string,
    runState: T.string, progress: T.number, lastError: T.string,
  }
  override getDefaultProps(): VideoGenNodeShape['props'] {
    return { w: 360, h: 360, title: '视频生成', prompt: '', promptRef: '', referenceRef: '', modelId: '', resolution: '720p', duration: 4, taskId: '', resultUrlsJson: '[]', runState: 'idle', progress: 0, lastError: '' }
  }
  component(shape: VideoGenNodeShape) { return <VideoGenNodeComponent shape={shape} /> }
  getIndicatorPath(shape: VideoGenNodeShape) { const path = new Path2D(); path.roundRect(0, 0, shape.props.w, shape.props.h, 10); return path }
}

function urls(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}

function VideoGenNodeComponent({ shape }: { shape: VideoGenNodeShape }) {
  const editor = useEditor()
  const projectId = useCanvasProjectId()
  const data = useAppData()
  const props = shape.props
  const configOpen = shape.meta.configOpen === true
  const videoModels = data.models.filter((model) => model.type === 'video')
  const promptSources = getCompatibleSources(editor, shape.type, 'prompt', shape.id)
  const referenceSources = getCompatibleSources(editor, shape.type, 'references', shape.id)
  const results = urls(props.resultUrlsJson)
  const active = isActiveRunState(props.runState)
  const update = (patch: Partial<VideoGenNodeShape['props']>) => editor.updateShape({ id: shape.id, type: VIDEO_GEN_TYPE, props: patch })
  const connect = (port: 'prompt' | 'references', sourceId: string) => replaceDataDependency(editor, shape, port, sourceId, (value) => update(port === 'prompt' ? { promptRef: value } : { referenceRef: value }))
  const setConfigOpen = (open: boolean) => editor.updateShape({ id: shape.id, type: VIDEO_GEN_TYPE, meta: { ...shape.meta, configOpen: open } })
  const applyTask = useCallback((task: { id: string; status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'; progress: number; resultUrls: string[]; error?: string }) => {
    editor.updateShape({ id: shape.id, type: VIDEO_GEN_TYPE, props: { taskId: task.id, progress: task.progress, runState: toNodeRunState(task.status), lastError: task.error ?? '', ...(task.status === 'done' ? { resultUrlsJson: JSON.stringify(task.resultUrls) } : {}) } })
    if (task.status === 'done') markNodeAndDependentsDirty(editor, shape.id, false)
  }, [editor, shape.id])

  useEffect(() => {
    if (!props.taskId || !active) return
    void waitForGenerationTask(props.taskId, applyTask).catch((error) => editor.updateShape({ id: shape.id, type: VIDEO_GEN_TYPE, props: { runState: 'error', lastError: error instanceof Error ? error.message : String(error) } }))
  }, [active, applyTask, editor, props.taskId, shape.id])

  const run = async () => {
    if (active) return
    const model = data.models.find((item) => item.id === props.modelId)
    if (!model) return update({ runState: 'error', lastError: '请先同步并选择一个视频模型。' })
    const source = props.promptRef ? editor.getShape(props.promptRef as TLShape['id']) : null
    const resolved = source ? getTextValue(source) : props.prompt.trim()
    const prompts = normalizeTextInput(resolved)
    if (!prompts.length || prompts.some((item) => !item.trim())) return update({ runState: 'error', lastError: '请填写 prompt 或连接有内容的文本输入。' })
    const ref = props.referenceRef ? editor.getShape(props.referenceRef as TLShape['id']) : null
    const referenceUrls = ref ? getImageUrls(ref) : []
    if (ref && !referenceUrls.length) return update({ runState: 'error', lastError: '参考图节点没有可用图片。' })
    update({ runState: 'queued', progress: 0, lastError: '' })
    try {
      const result = await runVideoGeneration({ projectId, profileId: model.id, prompts, referenceUrls, resolution: props.resolution, duration: props.duration, onUpdate: applyTask })
      if (result.status === 'failed') throw new Error(result.error || '视频任务未完成')
    } catch (error) {
      update({ runState: 'error', lastError: error instanceof Error ? error.message : String(error) })
    }
  }

  const cancel = async () => {
    if (!props.taskId || !active) return
    try {
      const task = await cancelVideoTask(props.taskId)
      update({ runState: toNodeRunState(task.status), progress: task.progress, lastError: task.error ?? '' })
    } catch (error) {
      update({ lastError: error instanceof Error ? error.message : String(error) })
    }
  }

  return <div style={{ pointerEvents: 'all' }} className="w-full h-full flex flex-col node-card node-card-video overflow-hidden"><NodePortMarkers type={shape.type} />
    <header onPointerDown={(event) => event.stopPropagation()} className="node-header">
      <span className="node-kicker">▷</span><input value={props.title} onChange={(event) => update({ title: event.target.value })} className="node-title" />
      <button onClick={() => setConfigOpen(!configOpen)} className="node-icon-button" title="节点设置">⚙</button>
    </header>
    {configOpen && <div onPointerDown={(event) => event.stopPropagation()} className="node-config">
      <label>Prompt 输入（真实数据依赖）<select value={props.promptRef} onChange={(event) => connect('prompt', event.target.value)}><option value="">— 使用下方手填 prompt —</option>{promptSources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}</select></label>
      {!props.promptRef && <textarea value={props.prompt} onChange={(event) => update({ prompt: event.target.value, runState: 'dirty', lastError: '' })} onKeyDown={(event) => event.stopPropagation()} rows={2} placeholder="描述镜头、动作和风格…" />}
      <label>首帧 / 参考图（可选）<select value={props.referenceRef} onChange={(event) => connect('references', event.target.value)}><option value="">— 无参考图 —</option>{referenceSources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}</select></label>
      <div className="grid grid-cols-3 gap-2"><label>模型<select value={props.modelId} onChange={(event) => update({ modelId: event.target.value, runState: 'dirty', lastError: '' })}><option value="">选择视频模型</option>{videoModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>清晰度<select value={props.resolution} onChange={(event) => update({ resolution: event.target.value, runState: 'dirty', lastError: '' })}><option>480p</option><option>720p</option><option>1080p</option></select></label><label>时长<select value={props.duration} onChange={(event) => update({ duration: Number(event.target.value), runState: 'dirty', lastError: '' })}><option value={4}>4 秒</option><option value={5}>5 秒</option><option value={8}>8 秒</option></select></label></div>
    </div>}
    <div onPointerDown={(event) => event.stopPropagation()} className="node-body node-media-body">
      {results.length ? <div className="grid grid-cols-1 gap-2">{results.map((url, index) => <video key={`${url}-${index}`} src={url} controls preload="metadata" className="w-full rounded-md border border-amber-100 bg-black" />)}</div> : <p className="node-empty">连接文本 / 图片后生成视频。视频任务在后端排队，刷新后仍可查询。</p>}
      {active && <div className="mt-3"><div className="node-status-line"><span>{props.runState === 'queued' ? '排队中' : '视频任务执行中'}</span><span>{props.progress}%</span></div><div className="node-progress"><span style={{ width: `${props.progress}%` }} /></div></div>}
    </div>
    {props.runState === 'error' && <div className="node-error">⚠ {props.lastError}</div>}
    <footer onPointerDown={(event) => event.stopPropagation()} className="node-footer"><button onClick={run} disabled={active} className="node-primary node-primary-video">{active ? '生成中…' : props.runState === 'error' ? '重试' : '生成视频'}</button>{active && <button onClick={() => void cancel()} className="node-secondary">停止任务</button>}</footer>
  </div>
}
