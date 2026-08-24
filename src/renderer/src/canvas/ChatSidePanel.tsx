// 对话节点右侧面板：选中对话节点时弹出，包含完整聊天界面 + 参数设置
// 宽度 = 节点宽度（280）× 1.25 ≈ 380px；包含模型/系统提示词/温度/maxToken 设置
// 支持：文档上传（正文注入上下文）+ LangChain ConversationSummaryMemory 式自动压缩
import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '@shared/types'
import type { NodeCardShape } from './NodeCardShape'
import { parseChat, type ChatData, type ChatDocument } from '../nodes/chatData'
import { modelsByModality, useGatewayStore } from '../stores/gateway'
import { useAppStore } from '../stores/app'
import { gatherUpstreamText } from './graph'
import { markUndoPoint } from './history'
import { toast } from '../stores/toast'
import { Icon } from '../components/Icon'
import { getNodeType } from '../nodes/registry'

interface ChatSidePanelProps {
  editor: Editor
  shapeId: TLShapeId
  onClose: () => void
}

/** 自动压缩触发阈值：消息数超过此值时触发摘要压缩 */
const COMPRESS_THRESHOLD = 10
/** 压缩后保留最近消息数 */
const KEEP_RECENT = 4

/** LangChain ConversationSummaryMemory 式摘要 prompt */
const SUMMARIZE_SYSTEM = `你是对话摘要助手。请逐步总结对话内容，将新消息整合进已有摘要，生成一个连贯的新摘要。
要求：
- 保留关键事实、决策和上下文
- 去除冗余，保持简洁
- 中文输出，不超过 300 字`

const SUMMARIZE_PROMPT = (summary: string, lines: string): string =>
  summary
    ? `已有摘要：\n${summary}\n\n新增对话：\n${lines}\n\n请结合已有摘要和新对话，生成更新后的摘要：`
    : `请总结以下对话：\n${lines}\n\n生成摘要：`

function markdownText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(markdownText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return markdownText(node.props.children)
  return ''
}

function MarkdownPre({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : null
  const language = child?.props.className?.match(/language-([\w-]+)/)?.[1] ?? '代码'
  const content = markdownText(children).replace(/\n$/, '')

  return (
    <div className="csp-code-block">
      <div className="csp-code-head">
        <span>{language}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(content).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          <Icon name="copy" size={12} /> {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <MarkdownPre>{children}</MarkdownPre>,
  a: ({ children, href, ...props }) => (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="csp-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function ReasoningBlock({
  content,
  live = false
}: {
  content: string
  live?: boolean
}): React.JSX.Element {
  return (
    <details className="csp-reasoning" open={live}>
      <summary>
        <Icon name="spark" size={13} /> {live ? '正在思考' : '思考过程'}
      </summary>
      <MarkdownMessage content={content} />
    </details>
  )
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
  const shapeText = shape?.props.text ?? ''
  const data: ChatData = useMemo(
    () =>
      shapeText
        ? parseChat(shapeText)
        : {
            system: '',
            modelKey: '',
            messages: [],
            temperature: 0.7,
            maxTokens: 4096,
            documents: [],
            summary: '',
            autoCompress: true
          },
    [shapeText]
  )

  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [stream, setStream] = useState<{ taskId: string; text: string; reasoning: string } | null>(
    null
  )
  const [compressing, setCompressing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dataRef = useRef(data)
  const streamRef = useRef(stream)

  useLayoutEffect(() => {
    dataRef.current = data
  }, [data])
  useLayoutEffect(() => {
    streamRef.current = stream
  }, [stream])

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  // 流式期间自动滚到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data.messages.length, stream?.text, stream?.reasoning])

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
    if (s.text || s.reasoning) {
      const updated: ChatData = {
        ...cur,
        messages: [
          ...cur.messages,
          {
            role: 'assistant',
            content: s.text || '（模型未返回最终回答）',
            ...(s.reasoning.trim() ? { reasoning: s.reasoning.trim() } : {})
          }
        ]
      }
      update(updated)
      markUndoPoint(editor, 'chat-gen')
      // 流式回复完成后，检查是否需要自动压缩（LangChain ConversationSummaryMemory 模式）
      void maybeCompress(updated)
    }
    setStream(null)
  }

  // LangChain ConversationSummaryMemory：当消息数超过阈值时压缩旧消息为摘要
  const maybeCompress = async (cur: ChatData): Promise<void> => {
    if (!cur.autoCompress) return
    if (cur.messages.length < COMPRESS_THRESHOLD) return
    const opt = options.find((o) => o.key === cur.modelKey)
    if (!opt) return

    setCompressing(true)
    try {
      // 保留最近 KEEP_RECENT 条消息，压缩其余
      const toCompress = cur.messages.slice(0, cur.messages.length - KEEP_RECENT)
      const lines = toCompress
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
        .join('\n')

      const prompt = SUMMARIZE_PROMPT(cur.summary ?? '', lines)
      const res = await window.api.gateway.chatStart({
        providerId: opt.provider.id,
        modelId: opt.model.id,
        system: SUMMARIZE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 512
      })
      if (!res.ok) return

      // 收集摘要结果：注册临时事件监听器收集流式分片
      const summaryResult = await new Promise<string>((resolve) => {
        let acc = ''
        const targetTaskId = res.data.taskId
        const unsub = window.api.gateway.onEvent((e) => {
          if (e.taskId !== targetTaskId) return
          if (e.kind === 'chat-delta') {
            acc += e.text
          } else if (e.kind === 'chat-done') {
            unsub()
            resolve(acc)
          } else if (e.kind === 'chat-error') {
            unsub()
            resolve('')
          }
        })
        // 30 秒超时兜底
        setTimeout(() => {
          unsub()
          resolve(acc)
        }, 30000)
      })

      if (summaryResult.trim()) {
        // 更新数据：摘要 + 只保留最近消息
        const latest = dataRef.current
        update({
          ...latest,
          summary: summaryResult.trim(),
          messages: latest.messages.slice(latest.messages.length - KEEP_RECENT)
        })
        markUndoPoint(editor, 'chat-compress')
        toast('对话已自动压缩历史记录')
      }
    } catch {
      // 压缩失败不影响正常对话
    } finally {
      setCompressing(false)
    }
  }

  // 网关事件：本节点聊天流
  useEffect(() => {
    const off = window.api.gateway.onEvent((e) => {
      if (!streamRef.current || e.taskId !== streamRef.current.taskId) return
      if (e.kind === 'chat-delta') {
        setStream((s) => (s ? { ...s, text: s.text + e.text } : s))
      } else if (e.kind === 'chat-reasoning') {
        setStream((s) => (s ? { ...s, reasoning: s.reasoning + e.text } : s))
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

  // 文档上传：读取文本文件内容存入 ChatData.documents
  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 重置以便重复上传同名文件
    if (files.length === 0) return

    const docs: ChatDocument[] = []
    for (const file of files) {
      // 限制文本类文件：txt/md/json/csv/log/xml/html/js/ts/py
      const isText = /\.(txt|md|json|csv|log|xml|html?|js|ts|py|ya?ml)$/i.test(file.name)
      if (!isText) {
        toast(`${file.name}：仅支持文本类文件`)
        continue
      }
      if (file.size > 512 * 1024) {
        toast(`${file.name}：文件过大（限制 512KB）`)
        continue
      }
      try {
        const content = await file.text()
        docs.push({ name: file.name, content })
      } catch {
        toast(`${file.name}：读取失败`)
      }
    }
    if (docs.length > 0) {
      update({ ...data, documents: [...(data.documents ?? []), ...docs] })
      toast(`已添加 ${docs.length} 个文档到上下文`)
    }
  }

  const removeDoc = (idx: number): void => {
    const docs = data.documents ?? []
    update({ ...data, documents: docs.filter((_, i) => i !== idx) })
  }

  /** 构建合并后的 system 上下文（系统提示词 + 文档 + 历史摘要） */
  const buildEffectiveSystem = (cur: ChatData): string => {
    let s = cur.system
    if (cur.documents && cur.documents.length > 0) {
      const docContext = cur.documents
        .map((d) => `【文档：${d.name}】\n${d.content}`)
        .join('\n\n---\n\n')
      s = `${s}\n\n以下是用户提供的参考文档：\n\n${docContext}`
    }
    if (cur.summary) {
      s = `${s}\n\n[对话历史摘要]\n${cur.summary}`
    }
    return s
  }

  const send = async (): Promise<void> => {
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先在设置中选择对话模型')
    if (!draft.trim()) return
    if (stream) return
    const upstream = gatherUpstreamText(editor, shapeId)
    const userContent = upstream ? `${upstream}\n\n---\n\n${draft.trim()}` : draft.trim()
    const effectiveSystem = buildEffectiveSystem(data)
    const messages: ChatMessage[] = [...data.messages, { role: 'user', content: userContent }]

    update({ ...data, messages })
    setDraft('')
    setStream({ taskId: '', text: '', reasoning: '' })
    const res = await window.api.gateway.chatStart({
      providerId: opt.provider.id,
      modelId: opt.model.id,
      system: effectiveSystem,
      messages,
      temperature: data.temperature,
      maxTokens: data.maxTokens
    })
    if (!res.ok) {
      toast(`发送失败：${res.error.message}`)
      setStream(null)
      return
    }
    setStream({ taskId: res.data.taskId, text: '', reasoning: '' })
  }

  const stop = async (): Promise<void> => {
    if (!stream?.taskId) return
    await window.api.gateway.chatCancel(stream.taskId)
    finishStream()
  }

  const selectedModel = options.find((o) => o.key === data.modelKey)
  const docCount = data.documents?.length ?? 0
  const contract = getNodeType('chat')

  // ── 设置面板 ──
  if (showSettings) {
    return (
      <div className="chat-side-panel">
        <div className="csp-header">
          <span className="csp-title">
            <Icon name="settings" size={15} /> 对话设置
          </span>
          <button className="csp-close" title="返回对话" onClick={() => setShowSettings(false)}>
            <Icon name="undo" size={15} />
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
                    {o.provider.name} / {o.model.name || o.model.id}
                  </option>
                ))}
              </select>
            ) : (
              <button className="btn-ghost small" onClick={() => openSettings()}>
                配置对话模型
              </button>
            )}
          </div>

          {contract && (
            <div className="csp-field">
              <label className="csp-label">输入输出契约 · v{contract.contractVersion}</label>
              <div className="csp-contract-list">
                {[...contract.ports.in, ...contract.ports.out].map((port) => (
                  <div className="csp-contract-row" key={port.id}>
                    <strong>
                      {port.dir === 'in' ? '输入' : '输出'} · {port.name}
                    </strong>
                    <code>
                      {port.id} · {port.type} · {port.cardinality === 'many' ? '多值' : '单值'}
                    </code>
                    <span>{port.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

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

          {/* 自动压缩开关 */}
          <div className="csp-field csp-toggle-field">
            <label className="csp-label">
              自动压缩对话
              <span className="csp-toggle-hint">
                消息超过 {COMPRESS_THRESHOLD} 条时自动摘要压缩历史
              </span>
            </label>
            <button
              className={`csp-toggle ${(data.autoCompress ?? true) ? 'on' : ''}`}
              onClick={() => update({ ...data, autoCompress: !(data.autoCompress ?? true) })}
            >
              <span className="csp-toggle-knob" />
            </button>
          </div>

          {/* 文档管理 */}
          <div className="csp-field">
            <label className="csp-label">
              上下文文档（{docCount}）
              <span className="csp-toggle-hint">文本内容自动注入对话上下文</span>
            </label>
            <div className="csp-doc-list">
              {(data.documents ?? []).map((d, i) => (
                <div key={i} className="csp-doc-item">
                  <span className="csp-doc-icon">
                    <Icon name="document" size={15} />
                  </span>
                  <span className="csp-doc-name" title={d.content.slice(0, 100)}>
                    {d.name}
                  </span>
                  <button className="csp-doc-remove" title="移除" onClick={() => removeDoc(i)}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              <button className="csp-doc-add" onClick={() => fileInputRef.current?.click()}>
                + 添加文档
              </button>
            </div>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.json,.csv,.log,.xml,.html,.htm,.js,.ts,.py,.yaml,.yml"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => void handleDocUpload(e)}
        />
      </div>
    )
  }

  // ── 聊天面板 ──
  return (
    <div className="chat-side-panel">
      <div className="csp-header">
        <span className="csp-title">
          <Icon name="chat" size={15} />
          {selectedModel ? selectedModel.model.name || selectedModel.model.id : '未选择模型'}
        </span>
        <div className="csp-header-actions">
          {docCount > 0 && (
            <span className="csp-doc-badge" title={`${docCount} 个文档`}>
              <Icon name="document" size={13} />
              {docCount}
            </span>
          )}
          {data.summary && (
            <span className="csp-doc-badge" title="已有压缩摘要">
              <Icon name="history" size={13} />
            </span>
          )}
          <button className="csp-icon-btn" title="参数设置" onClick={() => setShowSettings(true)}>
            <Icon name="settings" size={15} />
          </button>
          <button className="csp-icon-btn" title="关闭面板" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
      {data.summary && (
        <div className="csp-summary-banner" title={data.summary}>
          <Icon name="history" size={13} /> 已压缩历史 · {data.messages.length} 条近期消息
        </div>
      )}
      {compressing && <div className="csp-compressing">正在自动压缩对话历史…</div>}
      <div className="csp-messages" ref={scrollRef}>
        {data.messages.map((m, i) => (
          <div key={i} className={`csp-msg ${m.role}`}>
            <div className="csp-bubble">
              {m.role === 'assistant' && m.reasoning && <ReasoningBlock content={m.reasoning} />}
              <MarkdownMessage content={m.content} />
            </div>
          </div>
        ))}
        {stream && (
          <div className="csp-msg assistant">
            <div className="csp-bubble streaming">
              {stream.reasoning && <ReasoningBlock content={stream.reasoning} live />}
              {stream.text ? (
                <MarkdownMessage content={stream.text} />
              ) : !stream.reasoning ? (
                <div className="csp-waiting">
                  <span className="csp-waiting-dot" />
                  模型已收到请求，正在等待首个输出…
                </div>
              ) : null}
            </div>
          </div>
        )}
        {!data.messages.length && !stream && <div className="csp-empty">输入消息开始对话…</div>}
      </div>
      <div className="csp-input-row">
        <button
          className="csp-attach-btn"
          title="上传文档到上下文"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="attach" size={16} />
        </button>
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
            <Icon name="close" size={15} />
          </button>
        ) : (
          <button className="csp-send-btn" disabled={!draft.trim()} onClick={() => void send()}>
            <Icon name="send" size={15} />
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.json,.csv,.log,.xml,.html,.htm,.js,.ts,.py,.yaml,.yml"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => void handleDocUpload(e)}
      />
    </div>
  )
}
