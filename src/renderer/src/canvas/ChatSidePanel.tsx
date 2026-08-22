// 对话节点右侧面板：选中对话节点时弹出，包含完整聊天界面 + 参数设置
// 宽度 = 节点宽度（280）× 1.25 ≈ 380px；包含模型/系统提示词/温度/maxToken 设置
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { ChatMessage } from '@shared/types'
import type { NodeCardShape } from './NodeCardShape'
import { parseChat, type ChatData } from '../nodes/specs/bodies'
import { modelsByModality, useGatewayStore } from '../stores/gateway'
import { useAppStore } from '../stores/app'
import { gatherUpstreamText } from './graph'
import { markUndoPoint } from './history'
import { toast } from '../stores/toast'

interface ChatSidePanelProps {
  editor: Editor
  shapeId: TLShapeId
  onClose: () => void
}

export function ChatSidePanel({ editor, shapeId, onClose }: ChatSidePanelProps): React.JSX.Element {
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'text')

  // 订阅画布变更以同步 shape 数据（面板在 tldraw 外部渲染，需手动订阅）
  const [, force] = useState(0)
  useEffect(() => {
    return editor.store.listen(() => force((n) => n + 1), { scope: 'document' })
  }, [editor])

  // 获取最新 shape 数据
  const shape = editor.getShape(shapeId) as NodeCardShape | undefined
  const data: ChatData = shape ? parseChat(shape.props.text) : {
    system: '', modelKey: '', messages: [], temperature: 0.7, maxTokens: 4096
  }

  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [stream, setStream] = useState<{ taskId: string; text: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef(data)
  const streamRef = useRef(stream)

  useLayoutEffect(() => { dataRef.current = data }, [data])
  useLayoutEffect(() => { streamRef.current = stream }, [stream])

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  // 流式期间自动滚到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data.messages.length, stream?.text])

  const update = (next: ChatData): void => {
    editor.updateShape({
      id: shapeId,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const finishStream = (): void => {
    const s = streamRef.current
    if (!s) return
    const cur = dataRef.current
    if (s.text) {
      update({
        ...cur,
        messages: [...cur.messages, { role: 'assistant', content: s.text }]
      })
      markUndoPoint(editor, 'chat-gen')
    }
    setStream(null)
  }

  // 网关事件：本节点聊天流
  useEffect(() => {
    const off = window.api.gateway.onEvent((e) => {
      if (!streamRef.current || e.taskId !== streamRef.current.taskId) return
      if (e.kind === 'chat-delta') {
        setStream((s) => (s ? { ...s, text: s.text + e.text } : s))
      } else if (e.kind === 'chat-done') {
        finishStream()
      } else if (e.kind === 'chat-error') {
        toast(`对话失败：${e.error}`)
        setStream(null)
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async (): Promise<void> => {
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先在设置中选择对话模型')
    if (!draft.trim()) return
    if (stream) return
    const upstream = gatherUpstreamText(editor, shapeId)
    const userContent = upstream ? `${upstream}\n\n---\n\n${draft.trim()}` : draft.trim()
    const messages: ChatMessage[] = [...data.messages, { role: 'user', content: userContent }]
    update({ ...data, messages })
    setDraft('')
    setStream({ taskId: '', text: '' })
    const res = await window.api.gateway.chatStart({
      providerId: opt.provider.id,
      modelId: opt.model.id,
      system: data.system,
      messages,
      temperature: data.temperature,
      maxTokens: data.maxTokens
    })
    if (!res.ok) {
      toast(`发送失败：${res.error.message}`)
      setStream(null)
      return
    }
    setStream({ taskId: res.data.taskId, text: '' })
  }

  const stop = async (): Promise<void> => {
    if (!stream?.taskId) return
    await window.api.gateway.chatCancel(stream.taskId)
    finishStream()
  }

  const selectedModel = options.find((o) => o.key === data.modelKey)

  // ── 设置面板 ──
  if (showSettings) {
    return (
      <div className="chat-side-panel">
        <div className="csp-header">
          <span className="csp-title">⚙ 对话设置</span>
          <button className="csp-close" title="返回对话" onClick={() => setShowSettings(false)}>
            ←
          </button>
        </div>
        <div className="csp-settings-body">
          {/* 模型选择 */}
          <div className="csp-field">
            <label className="csp-label">模型</label>
            {options.length ? (
              <select
                className="csp-select"
                value={data.modelKey}
                onChange={(e) => update({ ...data, modelKey: e.target.value })}
              >
                <option value="">— 选择模型 —</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.provider.name} / {o.model.name}
                  </option>
                ))}
              </select>
            ) : (
              <button className="btn-ghost small" onClick={() => openSettings()}>
                配置对话模型
              </button>
            )}
          </div>

          {/* 系统提示词 */}
          <div className="csp-field">
            <label className="csp-label">系统提示词</label>
            <textarea
              className="csp-textarea"
              value={data.system}
              rows={4}
              spellCheck={false}
              placeholder="系统提示词（人设 / 输出要求）…"
              onChange={(e) => update({ ...data, system: e.target.value })}
            />
          </div>

          {/* 温度 */}
          <div className="csp-field">
            <label className="csp-label">
              温度（Temperature）
              <span className="csp-value-badge">{data.temperature.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={data.temperature}
              onChange={(e) => update({ ...data, temperature: parseFloat(e.target.value) })}
              className="csp-slider"
            />
            <div className="csp-slider-hints">
              <span>精确</span>
              <span>创意</span>
            </div>
          </div>

          {/* Max Token */}
          <div className="csp-field">
            <label className="csp-label">
              Max Token
              <span className="csp-value-badge">{data.maxTokens}</span>
            </label>
            <input
              type="range"
              min={256}
              max={32768}
              step={256}
              value={data.maxTokens}
              onChange={(e) => update({ ...data, maxTokens: parseInt(e.target.value, 10) })}
              className="csp-slider"
            />
            <div className="csp-slider-hints">
              <span>256</span>
              <span>32K</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── 聊天面板 ──
  return (
    <div className="chat-side-panel">
      <div className="csp-header">
        <span className="csp-title">
          💬 {selectedModel?.model?.name ?? '未选择模型'}
        </span>
        <div className="csp-header-actions">
          <button className="csp-icon-btn" title="参数设置" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
          <button className="csp-icon-btn" title="关闭面板" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="csp-messages" ref={scrollRef}>
        {data.messages.map((m, i) => (
          <div key={i} className={`csp-msg ${m.role}`}>
            <div className="csp-bubble">{m.content}</div>
          </div>
        ))}
        {stream && (
          <div className="csp-msg assistant">
            <div className="csp-bubble streaming">
              {stream.text || <span className="csp-cursor">▍</span>}
            </div>
          </div>
        )}
        {!data.messages.length && !stream && (
          <div className="csp-empty">输入消息开始对话…</div>
        )}
      </div>
      <div className="csp-input-row">
        <textarea
          className="csp-input"
          value={draft}
          rows={1}
          spellCheck={false}
          placeholder={project ? '说点什么…（Enter 发送）' : '项目未就绪'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {stream ? (
          <button className="csp-send-btn stop" onClick={() => void stop()}>
            ■
          </button>
        ) : (
          <button
            className="csp-send-btn"
            disabled={!draft.trim()}
            onClick={() => void send()}
          >
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
