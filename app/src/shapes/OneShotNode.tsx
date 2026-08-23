import { BaseBoxShapeUtil, T, useEditor, type RecordProps, type TLShape } from 'tldraw'
import { useAppData } from '../store'
import { callChatCompletion } from './llm'
import { describeSource, getCompatibleSources, getTextValue, markNodeAndDependentsDirty, replaceDataDependency } from './dependencies'
import { ONE_SHOT_TYPE, type OneShotNodeShape } from './types'
import { normalizeTextInput } from './runtime'

export class OneShotNodeUtil extends BaseBoxShapeUtil<OneShotNodeShape> {
  static override type = ONE_SHOT_TYPE

  static override props: RecordProps<OneShotNodeShape> = {
    w: T.number,
    h: T.number,
    title: T.string,
    promptTemplate: T.string,
    modelId: T.string,
    temperature: T.number,
    maxTokens: T.number,
    inputRef: T.string,
    outputText: T.string,
    runState: T.string,
    lastError: T.string,
  }

  override getDefaultProps(): OneShotNodeShape['props'] {
    return {
      w: 360,
      h: 360,
      title: '单次处理',
      promptTemplate: '请根据以下内容生成分镜脚本。每个分镜以 === 分隔：\n\n{{input}}',
      modelId: '',
      temperature: 0.7,
      maxTokens: 2048,
      inputRef: '',
      outputText: '',
      runState: 'idle',
      lastError: '',
    }
  }

  component(shape: OneShotNodeShape) {
    return <OneShotNodeComponent shape={shape} />
  }

  getIndicatorPath(shape: OneShotNodeShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}

function OneShotNodeComponent({ shape }: { shape: OneShotNodeShape }) {
  const editor = useEditor()
  const data = useAppData()
  const props = shape.props
  const configOpen = shape.meta.configOpen === true
  const sources = getCompatibleSources(editor, shape.type, 'input', shape.id)
  const models = data.models.filter((model) => model.type === 'chat')
  const update = (patch: Partial<OneShotNodeShape['props']>) =>
    editor.updateShape({ id: shape.id, type: ONE_SHOT_TYPE, props: patch })
  const setConfigOpen = (open: boolean) =>
    editor.updateShape({ id: shape.id, type: ONE_SHOT_TYPE, meta: { ...shape.meta, configOpen: open } })

  const changeSource = (sourceId: string) => {
    replaceDataDependency(editor, shape, 'input', sourceId, (inputRef) => update({ inputRef }))
  }

  const run = async () => {
    if (props.runState === 'running') return
    const model = data.models.find((item) => item.id === props.modelId)
    if (!model) return update({ runState: 'error', lastError: '请在设置中选择对话模型' })
    const source = props.inputRef ? editor.getShape(props.inputRef as TLShape['id']) : null
    const manualInput = typeof shape.meta.manualInput === 'string' ? shape.meta.manualInput.trim() : ''
    const input = source ? getTextValue(source) : manualInput
    const inputItems = normalizeTextInput(input)
    if (!inputItems.length) return update({ runState: 'error', lastError: '请连接有内容的输入，或填写手动输入。' })
    update({ runState: 'running', lastError: '' })
    try {
      const outputs: string[] = []
      for (const item of inputItems) {
        outputs.push(await callChatCompletion({
          model,
          messages: [{ role: 'user', content: props.promptTemplate.replaceAll('{{input}}', item) }],
          temperature: props.temperature,
          maxTokens: props.maxTokens,
        }))
      }
      editor.updateShape({ id: shape.id, type: ONE_SHOT_TYPE, props: { outputText: outputs.join('\n\n===\n\n'), runState: 'done', lastError: '' }, meta: { ...shape.meta, outputItems: outputs.length > 1 ? outputs : undefined } })
      markNodeAndDependentsDirty(editor, shape.id, false)
    } catch (error) {
      update({ runState: 'error', lastError: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <div style={{ pointerEvents: 'all' }} className="w-full h-full flex flex-col node-card node-card-oneshot">
      <header onPointerDown={(event) => event.stopPropagation()} className="node-header">
        <span className="node-kicker">↗</span>
        <input value={props.title} onChange={(event) => update({ title: event.target.value })} onPointerDown={(event) => event.stopPropagation()} className="node-title" />
        <button onClick={() => setConfigOpen(!configOpen)} className="node-icon-button">⚙</button>
      </header>
      {configOpen && (
        <div onPointerDown={(event) => event.stopPropagation()} className="node-config">
          <label className="block text-neutral-500">输入（真实数据依赖）
            <select value={props.inputRef} onChange={(event) => changeSource(event.target.value)} className="mt-1 w-full p-1.5 border rounded">
              <option value="">— 选择来源 —</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}
            </select>
          </label>
          {!props.inputRef && <label className="block text-neutral-500">手动输入
            <textarea value={typeof shape.meta.manualInput === 'string' ? shape.meta.manualInput : ''} onChange={(event) => editor.updateShape({ id: shape.id, type: ONE_SHOT_TYPE, meta: { ...shape.meta, manualInput: event.target.value }, props: { runState: 'dirty', lastError: '' } })} rows={3} className="mt-1 w-full p-2 border rounded resize-none" />
          </label>}
          <label className="block text-neutral-500">模型
            <select value={props.modelId} onChange={(event) => update({ modelId: event.target.value, runState: 'dirty', lastError: '' })} className="mt-1 w-full p-1.5 border rounded">
              <option value="">— 选择对话模型 —</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}（{model.modelId}）</option>)}
            </select>
          </label>
          <label className="block text-neutral-500">Prompt 模板（使用 {'{{input}}'} 注入上游数据）
            <textarea value={props.promptTemplate} onChange={(event) => update({ promptTemplate: event.target.value, runState: 'dirty', lastError: '' })} onKeyDown={(event) => event.stopPropagation()} rows={4} className="mt-1 w-full p-2 border rounded resize-none" />
          </label>
        </div>
      )}
      <div onPointerDown={(event) => event.stopPropagation()} className="node-body">
        <p className="text-[11px] text-neutral-400 mb-1">输出 {Array.isArray(shape.meta.outputItems) ? 'Text[]' : 'Text'}</p>
        <pre className="text-xs text-neutral-700 whitespace-pre-wrap font-sans">{props.outputText || '运行后在此沉淀结果'}</pre>
      </div>
      {props.runState === 'error' && <div className="node-error">⚠ {props.lastError}</div>}
      <footer onPointerDown={(event) => event.stopPropagation()} className="node-footer">
        <button onClick={run} disabled={props.runState === 'running'} className="node-primary">{props.runState === 'running' ? '执行中…' : '执行一次'}</button>
      </footer>
    </div>
  )
}
