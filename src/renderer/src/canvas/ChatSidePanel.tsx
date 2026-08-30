// 对话节点右侧面板：选中对话节点时弹出，包含完整聊天界面 + 参数设置
// 宽度 = 节点宽度（280）× 1.25 ≈ 380px；包含模型/系统提示词/温度/maxToken 设置
// 支持：文档上传（正文由 chat executor 注入上下文）
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { NodeCardShape } from './NodeCardShape'
import { parseChat, type ChatData, type ChatDocument } from '../nodes/chatData'
import { modelsByModality, useGatewayStore } from '../stores/gateway'
import { useAppStore } from '../stores/app'
import { gatherUpstreamText } from './graph'
import { runNodeManually } from '../engine/executor'
import { toast } from '../stores/toast'
import { Icon } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'
import { getNodeType } from '../nodes/registry'

interface ChatSidePanelProps {
  editor: Editor
  shapeId: TLShapeId
  onClose: () => void
}

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
  const [running, setRunning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data.messages.length, running])

  const update = (next: ChatData): void => {
    editor.updateShape({
      id: shapeId,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // Esc 关闭面板（与其它浮层面板行为统一）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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

  const send = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先在设置中选择对话模型')
    if (!draft.trim()) return
    if (running) return
    const upstream = gatherUpstreamText(editor, shapeId)
    const userContent = upstream ? `${upstream}\n\n---\n\n${draft.trim()}` : draft.trim()

    // 面板只记录待发送消息并调用统一运行器；模型调用、上下文合并、运行状态与失败
    // 路径全部由 chat executor 负责，避免形成未声明的第二条数据流。
    update({ ...data, messages: [...data.messages, { role: 'user', content: userContent }] })
    setDraft('')
    setRunning(true)
    try {
      await runNodeManually(editor, project.id, providers, shapeId)
    } finally {
      setRunning(false)
    }
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
              <AppSelect
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
              </AppSelect>
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
      <div className="csp-messages" ref={scrollRef}>
        {data.messages.map((m, i) => (
          <div key={i} className={`csp-msg ${m.role}`}>
            <div className="csp-bubble">
              {m.role === 'assistant' && m.reasoning && <ReasoningBlock content={m.reasoning} />}
              <MarkdownMessage content={m.content} />
            </div>
          </div>
        ))}
        {running && (
          <div className="csp-msg assistant">
            <div className="csp-bubble streaming">
              <div className="csp-waiting">
                <span className="csp-waiting-dot" />
                正在通过节点运行器执行…
              </div>
            </div>
          </div>
        )}
        {!data.messages.length && !running && <div className="csp-empty">输入消息开始对话…</div>}
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
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          className="csp-send-btn"
          disabled={!draft.trim() || running}
          onClick={() => void send()}
        >
          <Icon name="send" size={15} />
        </button>
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
