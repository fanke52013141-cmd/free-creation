// ===== 聊天节点（铁律§4.5：系统提示词/模型/温度/最大输出长度；对话沉淀）=====

import {
  BaseBoxShapeUtil,
  T,
  useEditor,
  type RecordProps,
  type TLShape,
} from 'tldraw'
import { useState, useRef, useEffect } from 'react'
import type { ChatNodeShape, ChatMessage } from './types'
import { CHAT_TYPE, parseMessages, stringifyMessages } from './types'
import { callChatCompletion } from './llm'
import { useAppData } from '../store'

export class ChatNodeUtil extends BaseBoxShapeUtil<ChatNodeShape> {
  static override type = CHAT_TYPE

  static override props: RecordProps<ChatNodeShape> = {
    w: T.number,
    h: T.number,
    title: T.string,
    systemPrompt: T.string,
    modelId: T.string,
    temperature: T.number,
    maxTokens: T.number,
    messagesJson: T.string,
    contextRef: T.string,
    runState: T.string,
    lastError: T.string,
  }

  override getDefaultProps(): ChatNodeShape['props'] {
    return {
      w: 380,
      h: 520,
      title: '聊天节点',
      systemPrompt: '',
      modelId: '',
      temperature: 0.7,
      maxTokens: 2048,
      messagesJson: '[]',
      contextRef: '',
      runState: 'idle',
      lastError: '',
    }
  }

  component(shape: ChatNodeShape) {
    return <ChatNodeComponent shape={shape} />
  }

  getIndicatorPath(shape: ChatNodeShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}

function ChatNodeComponent({ shape }: { shape: ChatNodeShape }) {
  const editor = useEditor()
  const data = useAppData()
  const props = shape.props
  const messages: ChatMessage[] = parseMessages(props.messagesJson)
  const [showConfig, setShowConfig] = useState(false)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const [cfg, setCfg] = useState({
    systemPrompt: props.systemPrompt,
    modelId: props.modelId,
    temperature: props.temperature,
    maxTokens: props.maxTokens,
    contextRef: props.contextRef,
  })

  const chatModels = data.models.filter((m) => m.type === 'chat')
  const allShapes = editor.getCurrentPageShapes() as TLShape[]
  const textAssets = allShapes
    .filter((s) => s.type === 'text-asset')
    .map((s) => ({ id: s.id, text: (s.props as { text: string }).text }))

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [props.messagesJson])

  const update = (patch: Partial<ChatNodeShape['props']>) =>
    editor.updateShape({ id: shape.id, type: 'chat-node', props: patch })

  const send = async () => {
    const content = input.trim()
    if (!content || props.runState === 'running') return

    const model = data.models.find((m) => m.id === props.modelId)
    if (!model) {
      update({ runState: 'error', lastError: '请先在配置中选择一个对话模型' })
      setShowConfig(true)
      return
    }

    const msgs: ChatMessage[] = []
    if (props.systemPrompt.trim())
      msgs.push({ role: 'system', content: props.systemPrompt.trim() })

    // 铁律§3.2 数据依赖：引用上游文本资产作为上下文
    if (props.contextRef) {
      const refShape = editor.getShape(props.contextRef as TLShape['id'])
      const refText = (refShape?.props as { text?: string })?.text
      if (refText?.trim()) {
        msgs.push({
          role: 'system',
          content: `以下是参考文本，请结合它回答：\n\n${refText}`,
          fromRef: true,
        })
      }
    }
    msgs.push(...messages)
    msgs.push({ role: 'user', content })

    const userMsg: ChatMessage = { role: 'user', content }
    update({
      messagesJson: stringifyMessages([...messages, userMsg]),
      runState: 'running',
      lastError: '',
    })
    setInput('')

    try {
      const reply = await callChatCompletion({
        model,
        messages: msgs,
        temperature: props.temperature,
        maxTokens: props.maxTokens,
      })
      update({
        messagesJson: stringifyMessages([
          ...messages,
          userMsg,
          { role: 'assistant', content: reply },
        ]),
        runState: 'done',
      })
    } catch (e: unknown) {
      update({ runState: 'error', lastError: e instanceof Error ? e.message : String(e) })
    }
  }

  const saveConfig = () => {
    update({
      systemPrompt: cfg.systemPrompt,
      modelId: cfg.modelId,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      contextRef: cfg.contextRef,
    })
    setShowConfig(false)
  }

  const clearChat = () => {
    if (messages.length && confirm('清空当前对话？此操作不可撤销。')) {
      update({ messagesJson: '[]', runState: 'idle', lastError: '' })
    }
  }

  return (
    <div className="w-full h-full flex flex-col bg-white rounded-lg border border-neutral-200 shadow-sm overflow-hidden">
      {/* 头部 */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="flex items-center gap-1.5 px-3 py-2 border-b border-neutral-100 bg-gradient-to-r from-blue-50 to-purple-50"
      >
        <span className="text-sm">💬</span>
        <input
          value={props.title}
          onChange={(e) => update({ title: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 text-sm font-medium text-neutral-700 bg-transparent outline-none"
        />
        <button onClick={clearChat} title="清空对话" className="text-xs text-neutral-400 hover:text-red-500 px-1">
          🗑
        </button>
        <button
          onClick={() => {
            setCfg({
              systemPrompt: props.systemPrompt,
              modelId: props.modelId,
              temperature: props.temperature,
              maxTokens: props.maxTokens,
              contextRef: props.contextRef,
            })
            setShowConfig((v) => !v)
          }}
          className="text-xs text-neutral-400 hover:text-neutral-700 px-1"
          title="节点设置"
        >
          ⚙
        </button>
      </div>

      {/* 配置面板 */}
      {showConfig && (
        <div className="p-3 border-b border-neutral-100 bg-neutral-50 space-y-2.5 text-xs overflow-y-auto max-h-72">
          <div>
            <label className="block text-neutral-500 mb-1">系统提示词</label>
            <textarea
              value={cfg.systemPrompt}
              onChange={(e) => setCfg({ ...cfg, systemPrompt: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              rows={2}
              placeholder="你是一个专业的广告文案专家…"
              className="w-full p-2 border border-neutral-300 rounded resize-none outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="block text-neutral-500 mb-1">模型</label>
            <select
              value={cfg.modelId}
              onChange={(e) => setCfg({ ...cfg, modelId: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-full p-1.5 border border-neutral-300 rounded outline-none focus:border-blue-400"
            >
              <option value="">— 选择模型 —</option>
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}（{m.modelId}）
                </option>
              ))}
            </select>
            {chatModels.length === 0 && (
              <p className="text-orange-500 mt-1">还没有对话模型，请先在 Model 配置中添加</p>
            )}
          </div>
          <div>
            <label className="block text-neutral-500 mb-1">引用文本资产（上下文）</label>
            <select
              value={cfg.contextRef}
              onChange={(e) => setCfg({ ...cfg, contextRef: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-full p-1.5 border border-neutral-300 rounded outline-none focus:border-blue-400"
            >
              <option value="">— 无引用 —</option>
              {textAssets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.text.slice(0, 20) || '(空文本)'}…
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-neutral-500 mb-1">温度 {cfg.temperature}</label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={cfg.temperature}
                onChange={(e) => setCfg({ ...cfg, temperature: Number(e.target.value) })}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-full"
              />
            </div>
            <div className="w-20">
              <label className="block text-neutral-500 mb-1">最大长度</label>
              <input
                type="number"
                value={cfg.maxTokens}
                onChange={(e) => setCfg({ ...cfg, maxTokens: Number(e.target.value) })}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="w-full p-1 border border-neutral-300 rounded outline-none focus:border-blue-400"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setShowConfig(false)} className="px-2 py-1 text-neutral-500 hover:bg-neutral-200 rounded">
              取消
            </button>
            <button onClick={saveConfig} className="px-2 py-1 text-white bg-blue-600 hover:bg-blue-700 rounded">
              保存
            </button>
          </div>
        </div>
      )}

      {/* 消息区 */}
      <div ref={scrollRef} onPointerDown={(e) => e.stopPropagation()} className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {messages.length === 0 && !showConfig && (
          <p className="text-center text-neutral-300 text-xs py-8">开始对话，内容会沉淀在此节点</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] px-2.5 py-1.5 rounded-lg text-xs leading-relaxed whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-sm'
                  : m.fromRef
                  ? 'bg-purple-50 text-purple-700 border border-purple-200 rounded-bl-sm'
                  : 'bg-neutral-100 text-neutral-700 rounded-bl-sm'
              }`}
            >
              {m.fromRef && <span className="block text-[10px] opacity-60 mb-0.5">📎 引用上下文</span>}
              {m.content}
            </div>
          </div>
        ))}
        {props.runState === 'running' && (
          <div className="flex justify-start">
            <div className="bg-neutral-100 text-neutral-400 px-2.5 py-1.5 rounded-lg text-xs">思考中…</div>
          </div>
        )}
      </div>

      {/* 错误提示 */}
      {props.runState === 'error' && props.lastError && (
        <div onPointerDown={(e) => e.stopPropagation()} className="px-3 py-1.5 bg-red-50 text-red-600 text-[11px] border-t border-red-100">
          ⚠ {props.lastError}
        </div>
      )}

      {/* 输入区 */}
      <div onPointerDown={(e) => e.stopPropagation()} className="border-t border-neutral-100 p-2 flex gap-1.5 bg-white">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={props.modelId ? '发送消息…' : '请先在 ⚙ 中选择模型…'}
          rows={1}
          className="flex-1 resize-none p-2 text-xs border border-neutral-200 rounded outline-none focus:border-blue-400 max-h-20"
        />
        <button
          onClick={send}
          disabled={props.runState === 'running' || !input.trim()}
          className="px-3 self-end py-2 text-xs text-white bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-300 rounded"
        >
          发送
        </button>
      </div>
    </div>
  )
}
