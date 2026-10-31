import { TEXT_MERGE_SEPARATOR } from '@shared/engine/helpers'
// AI 对话节点的沉浸式工作区。模型调用仍只通过 registered executor 进行。
import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Editor, TLShapeId } from 'tldraw'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { NodeCardShape } from './NodeCardShape'
import { GenerationLoadingOverlay } from './GenerationLoadingOverlay'
import {
  activeChatConversation,
  chatConversations,
  createChatConversation,
  editChatMessage,
  parseChat,
  prepareChatRegeneration,
  serializeChat,
  selectChatConversation,
  updateActiveChatConversation,
  type ChatData,
  type ChatDocument
} from '../nodes/chatData'
import { modelsByModality, useGatewayStore } from '../stores/gateway'
import { useAppStore } from '../stores/app'
import { ChatSkillAgentSettings } from '../nodes/specs/bodies/SkillAgentSettings'
import { gatherUpstreamText } from './graph'
import { runNodeManually } from '../engine/executor'
import { toast } from '../stores/toast'
import { Icon } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'
import { isReasoningModelId } from '@shared/model-reasoning'
import { parseChatImageSkill } from '@shared/chat-image-skill'
import type { ChatImageAttachment } from '@shared/types'
import { ChatImageGallery } from './ChatImageGallery'
import { downloadChatImage } from './chat-image-download'
import { mediaUrl } from '../nodes/registry'
import { readNodeRunRecord } from '../engine/runRecord'
import userAvatar from '../assets/chat-user-avatar.jpg'
import aiAvatar from '../assets/chat-ai-avatar.jpg'
import './chat-dialog.css'

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

function copyText(content: string): void {
  void navigator.clipboard
    .writeText(content)
    .then(() => toast('已复制到剪贴板'))
    .catch(() => toast('复制失败，请检查系统剪贴板权限'))
}

function MarkdownPre({ children }: { children?: ReactNode }): React.JSX.Element {
  const child = isValidElement<{ className?: string }>(children) ? children : null
  const language = child?.props.className?.match(/language-([\w-]+)/)?.[1] ?? '代码'
  const content = markdownText(children).replace(/\n$/, '')
  return (
    <div className="chat-dialog-code-block">
      <div>
        <span>{language}</span>
        <button type="button" onClick={() => copyText(content)}>
          <Icon name="copy" size={12} /> 复制
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
    <div className="chat-dialog-markdown">
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
  const wasLive = useRef(live)
  const [expanded, setExpanded] = useState(live)

  useLayoutEffect(() => {
    if (wasLive.current !== live) {
      setExpanded(Boolean(live))
      wasLive.current = live
    }
  }, [live])

  return (
    <section
      className={`chat-dialog-reasoning${live ? ' is-live' : ''}${expanded ? ' is-expanded' : ''}`}
      aria-label={live ? '思考中' : '思考过程'}
    >
      <button
        type="button"
        className="chat-dialog-reasoning-header"
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}思考过程`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="chat-dialog-reasoning-state">
          <span className="chat-dialog-reasoning-dot" aria-hidden="true" />
          <Icon name="spark" size={14} />
          <strong>{live ? '思考中' : '思考过程'}</strong>
          {live && <span className="chat-dialog-reasoning-live-label">实时</span>}
        </span>
        <span className="chat-dialog-reasoning-toggle" aria-hidden="true">
          <span className="chat-dialog-reasoning-expand">点击展开</span>
          <span className="chat-dialog-reasoning-collapse">点击收起</span>
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <div className="chat-dialog-reasoning-content" aria-hidden={!expanded}>
        {content.trim() ? (
          <MarkdownMessage content={content} />
        ) : (
          <p className="chat-dialog-reasoning-placeholder">等待模型返回思考内容…</p>
        )}
      </div>
    </section>
  )
}

function emptyChatData(): ChatData {
  return {
    system: '',
    modelKey: '',
    messages: [],
    temperature: 0.7,
    maxTokens: 4096,
    reasoningEffort: 'high',
    documents: [],
    summary: '',
    autoCompress: true
  }
}

export function ChatSidePanel({ editor, shapeId, onClose }: ChatSidePanelProps): React.JSX.Element {
  const project = useAppStore((state) => state.currentProject)
  const providers = useGatewayStore((state) => state.providers)
  const loaded = useGatewayStore((state) => state.loaded)
  const loadProviders = useGatewayStore((state) => state.load)
  const openSettings = useGatewayStore((state) => state.openSettings)
  const options = modelsByModality(providers, 'text')
  const imageOptions = modelsByModality(providers, 'image').filter(
    (option) => !option.model.operations || option.model.operations.includes('image.generate')
  )
  const [, force] = useState(0)
  const [draft, setDraft] = useState('')
  const [sendMode, setSendMode] = useState<'chat' | 'image'>('chat')
  const [draftImages, setDraftImages] = useState<ChatImageAttachment[]>([])
  const [importingAttachments, setImportingAttachments] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [previewImage, setPreviewImage] = useState<ChatImageAttachment | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const imageFocusRef = useRef<HTMLElement | null>(null)
  const [settingsPreference, setSettingsPreference] = useState<'automatic' | 'open' | 'closed'>(
    'automatic'
  )
  const [localRunning, setRunning] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [pendingEdit, setPendingEdit] = useState<{ index: number; content: string } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const systemComposingRef = useRef(false)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(
    () => editor.store.listen(() => force((value) => value + 1), { scope: 'document' }),
    [editor]
  )
  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const shape = editor.getShape(shapeId) as NodeCardShape | undefined
  const running = localRunning || readNodeRunRecord(shape?.meta?.nodeRun)?.status === 'running'
  const data = shape?.props.text ? parseChat(shape.props.text) : emptyChatData()
  const imageSkill = parseChatImageSkill(data.imageSkill)
  const activeConversation = activeChatConversation(data)
  const conversations = chatConversations(data)
  const messages = activeConversation.messages
  const selectedModel = options.find((option) => option.key === data.modelKey)
  const showSettings =
    settingsPreference === 'open' ||
    (settingsPreference === 'automatic' &&
      loaded &&
      !selectedModel &&
      !messages.some((message) => message.images?.length))
  const dialogStateRef = useRef({ pendingEdit, showSettings, onClose, previewImage })
  const selectedModelSupportsReasoning = Boolean(
    selectedModel && isReasoningModelId(selectedModel.model.id)
  )

  useEffect(() => {
    dialogStateRef.current = { pendingEdit, showSettings, onClose, previewImage }
  }, [pendingEdit, showSettings, onClose, previewImage])

  useEffect(() => {
    if (!previewImage) return
    previewRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => imageFocusRef.current?.focus()
  }, [previewImage])

  const openImagePreview = (image: ChatImageAttachment): void => {
    imageFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPreviewError(false)
    setPreviewImage(image)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, messages.at(-1)?.content, messages.at(-1)?.reasoning, running])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  // A proper modal owns focus while shown and returns it to the canvas control on close.
  // State is read through a ref so opening settings/confirmation does not tear down and
  // recreate the modal lifecycle (which would incorrectly return focus to the canvas).
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.setTimeout(() => inputRef.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = dialogStateRef.current
      if (event.key === 'Escape') {
        event.preventDefault()
        if (current.previewImage) setPreviewImage(null)
        else if (current.pendingEdit) setPendingEdit(null)
        else if (current.showSettings) setSettingsPreference('closed')
        else current.onClose()
        return
      }
      if (event.key !== 'Tab') return
      const scope = current.previewImage
        ? previewRef.current
        : current.pendingEdit
          ? confirmRef.current
          : dialogRef.current
      const targets = scope?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      )
      if (!targets?.length) return
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(frame)
      window.removeEventListener('keydown', onKeyDown)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [shapeId])

  useEffect(() => {
    if (!pendingEdit) return
    const frame = window.requestAnimationFrame(() =>
      confirmRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    )
    return () => window.cancelAnimationFrame(frame)
  }, [pendingEdit])

  const update = (next: ChatData): void => {
    editor.updateShape({ id: shapeId, type: 'node-card', props: { text: serializeChat(next) } })
  }

  const handleDocUpload = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (importingAttachments || running) return
    setImportingAttachments(true)
    const docs: ChatDocument[] = []
    const images: ChatImageAttachment[] = []
    try {
      for (const file of files) {
        if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
          if (!project) {
            toast('项目未就绪')
            continue
          }
          if (draftImages.length + images.length >= 4) {
            toast('每次最多添加 4 张图片')
            continue
          }
          if (file.size > 10 * 1024 * 1024) {
            toast(`${file.name}：图片不能超过 10MB`)
            continue
          }
          try {
            const result = await window.api.importMediaBuffer({
              projectId: project.id,
              name: file.name,
              mime: file.type,
              data: new Uint8Array(await file.arrayBuffer())
            })
            if (!result.ok) {
              toast(`${file.name}：图片导入失败`)
              continue
            }
            images.push({
              mediaId: result.data.id,
              mediaPath: result.data.path,
              name: file.name,
              mime: result.data.mime
            })
          } catch {
            toast(`${file.name}：图片导入失败`)
          }
          continue
        }
        if (/\.(pdf|docx|xlsx|pptx)$/i.test(file.name)) {
          if (!project) {
            toast('项目未就绪')
            continue
          }
          if (file.size > 50 * 1024 * 1024) {
            toast(`${file.name}：文档不能超过 50MB`)
            continue
          }
          const path = window.api.getDroppedFilePath(file)
          if (!path) {
            toast(`${file.name}：请在桌面版中添加此文档`)
            continue
          }
          try {
            const result = await window.api.importMedia({ projectId: project.id, paths: [path] })
            const text = result.ok ? result.data.assets[0]?.textContent : undefined
            if (!text?.trim()) {
              toast(`${file.name}：无法提取文字，请确认文件有可读取的文本`)
              continue
            }
            docs.push({ name: file.name, content: text })
          } catch {
            toast(`${file.name}：文档读取失败`)
          }
          continue
        }
        if (!/\.(txt|md|json|csv|log|xml|html?|js|ts|py|ya?ml)$/i.test(file.name)) {
          toast(`${file.name}：暂不支持此附件格式`)
          continue
        }
        if (file.size > 512 * 1024) {
          toast(`${file.name}：文件过大（上限 512KB）`)
          continue
        }
        try {
          docs.push({ name: file.name, content: await file.text() })
        } catch {
          toast(`${file.name}：读取失败`)
        }
      }
      const latestShape = editor.getShape(shapeId) as NodeCardShape | undefined
      const latestProject = useAppStore.getState().currentProject
      const latestData = latestShape?.props.text ? parseChat(latestShape.props.text) : null
      if (
        !latestData ||
        latestProject?.id !== project?.id ||
        activeChatConversation(latestData).id !== activeConversation.id
      ) {
        if (docs.length || images.length) toast('对话已切换，请重新添加附件')
        return
      }
      if (docs.length) {
        update({ ...latestData, documents: [...(latestData.documents ?? []), ...docs] })
        toast(`已添加 ${docs.length} 个附件`)
      }
      if (images.length) {
        setDraftImages((current) => [...current, ...images])
        toast(`已添加 ${images.length} 张图片附件`)
      }
    } finally {
      setImportingAttachments(false)
    }
  }

  const send = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    if (importingAttachments) return toast('请等待附件导入完成')
    if (sendMode === 'chat' && !selectedModel) return toast('请先在设置中选择对话模型')
    if (sendMode === 'image' && (!imageSkill.enabled || !imageOptions.length))
      return toast('请启用生图技能并配置图片模型')
    if (sendMode === 'image' && draftImages.length)
      return toast('图片附件可在对话模式中分析，生图模式暂不支持图片附件')
    if (!draft.trim() || running) return
    const upstream = gatherUpstreamText(editor, shapeId)
    const content = upstream ? `${upstream}${TEXT_MERGE_SEPARATOR}${draft.trim()}` : draft.trim()
    const titled =
      messages.length === 0 && activeConversation.title.startsWith('新会话')
        ? {
            ...data,
            conversations: data.conversations?.map((conversation) =>
              conversation.id === activeConversation.id
                ? { ...conversation, title: content.slice(0, 22) || conversation.title }
                : conversation
            )
          }
        : data
    update(
      updateActiveChatConversation(titled, [
        ...messages,
        {
          role: 'user',
          content,
          ...(draftImages.length ? { images: draftImages } : {}),
          ...(sendMode === 'image' ? { intent: 'image' as const } : {})
        }
      ])
    )
    setDraft('')
    setDraftImages([])
    setRunning(true)
    try {
      await runNodeManually(editor, project.id, providers, shapeId)
    } finally {
      setRunning(false)
    }
  }

  const saveEdit = (): void => {
    if (editingIndex === null || !editingText.trim()) return
    const editedRole = messages[editingIndex]?.role
    const suffix = messages.length - editingIndex - 1
    // 用户消息后面还有回复：先确认截断，确认后用编辑后的上下文重新生成。
    if (editedRole === 'user' && suffix > 0) {
      setPendingEdit({ index: editingIndex, content: editingText })
      return
    }
    const next = editChatMessage(data, editingIndex, editingText)
    if (!next) return
    update(next)
    setEditingIndex(null)
    // 编辑用户消息即重新生成：把编辑后的这条及之前的对话发给模型。
    if (editedRole === 'user') void runModel(next)
  }

  const confirmEdit = async (): Promise<void> => {
    if (!pendingEdit) return
    const editedRole = messages[pendingEdit.index]?.role
    const next = editChatMessage(data, pendingEdit.index, pendingEdit.content)
    if (next) update(next)
    setEditingIndex(null)
    setPendingEdit(null)
    if (editedRole === 'user') {
      toast('已更新对话，正在用新上下文重新生成…')
      if (next) await runModel(next)
    } else {
      toast('已保存修改')
    }
  }

  const runModel = async (context: ChatData = data): Promise<void> => {
    if (!project) return toast('项目未就绪')
    if (!selectedModel && activeChatConversation(context).messages.at(-1)?.intent !== 'image')
      return toast('请先在设置中选择对话模型')
    setRunning(true)
    try {
      await runNodeManually(editor, project.id, providers, shapeId)
    } finally {
      setRunning(false)
    }
  }

  const regenerate = async (index: number): Promise<void> => {
    if (!project) return toast('项目未就绪')
    if (running) return
    const next = prepareChatRegeneration(data, index)
    if (!next) return toast('未找到可用于重新生成的上一条用户消息')
    if (!selectedModel && activeChatConversation(next).messages.at(-1)?.intent !== 'image')
      return toast('请先在设置中选择对话模型')
    update(next)
    setRunning(true)
    try {
      await runNodeManually(editor, project.id, providers, shapeId)
    } finally {
      setRunning(false)
    }
  }

  // 从某条用户消息重新生成：删除它之后的全部回复，用这条及之前的上下文重新提问。
  const regenerateFromUser = async (index: number): Promise<void> => {
    if (running) return
    const next = updateActiveChatConversation(data, messages.slice(0, index + 1), '')
    update(next)
    await runModel(next)
  }

  // 消息操作统一位于正文结束后；AI 回复只提供复制和重新生成。
  const renderMessageActions = (index: number, role: 'user' | 'assistant'): React.JSX.Element => (
    <>
      <button
        type="button"
        className="chat-dialog-icon-btn"
        aria-label="复制"
        title="复制"
        onClick={() => copyText(messages[index].content)}
      >
        <Icon name="copy" size={13} />
      </button>
      {role === 'user' && (
        <button
          type="button"
          className="chat-dialog-icon-btn"
          aria-label="编辑"
          title="编辑"
          onClick={() => {
            setEditingIndex(index)
            setEditingText(messages[index].content)
          }}
        >
          <Icon name="edit" size={13} />
        </button>
      )}
      <button
        type="button"
        className="chat-dialog-icon-btn"
        aria-label="重新生成"
        title="重新生成"
        disabled={running}
        onClick={() => void (role === 'assistant' ? regenerate(index) : regenerateFromUser(index))}
      >
        <Icon name="refresh" size={13} />
      </button>
    </>
  )

  const settings = showSettings ? (
    <section className="chat-dialog-settings" aria-label="对话设置">
      <label>
        文本模型
        {options.length ? (
          <AppSelect
            aria-label="文本模型"
            value={data.modelKey}
            onChange={(event) => update({ ...data, modelKey: event.target.value })}
          >
            <option value="">选择模型</option>
            {options.map((option) => (
              <option
                key={option.key}
                value={option.key}
                data-trigger-label={option.model.name || option.model.id}
              >
                {option.provider.name} / {option.model.name || option.model.id}
              </option>
            ))}
          </AppSelect>
        ) : (
          <button type="button" onClick={() => openSettings()}>
            配置对话模型
            <Icon name="settings" size={13} />
          </button>
        )}
      </label>
      {shape && <ChatSkillAgentSettings shape={shape} editor={editor} disabled={running} />}
      <fieldset className="chat-dialog-image-settings" disabled={running}>
        <legend>生图技能</legend>
        <label className="chat-dialog-toggle">
          <input
            type="checkbox"
            checked={imageSkill.enabled}
            onChange={(event) =>
              update({ ...data, imageSkill: { ...imageSkill, enabled: event.target.checked } })
            }
          />
          允许对话生成图片
        </label>
        {imageSkill.enabled && (
          <>
            <label>
              图片模型
              <AppSelect
                aria-label="生图模型"
                value={imageSkill.modelKey}
                onChange={(event) =>
                  update({ ...data, imageSkill: { ...imageSkill, modelKey: event.target.value } })
                }
              >
                <option value="">使用生图功能默认模型</option>
                {imageOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </AppSelect>
            </label>
            <span className="chat-dialog-image-quality">
              质量：支持时使用最低档；即梦使用模型默认质量，5.0 请选 2K 或 4K
            </span>
          </>
        )}
      </fieldset>
      <label>
        系统提示词
        <textarea
          defaultValue={data.system}
          rows={4}
          placeholder="人设、输出格式或创作要求…"
          onCompositionStart={() => {
            systemComposingRef.current = true
          }}
          onCompositionEnd={(event) => {
            systemComposingRef.current = false
            update({ ...data, system: event.currentTarget.value })
          }}
          onChange={(event) => {
            if (!systemComposingRef.current) update({ ...data, system: event.currentTarget.value })
          }}
          onBlur={(event) => update({ ...data, system: event.currentTarget.value })}
        />
      </label>
      {selectedModelSupportsReasoning && (
        <label className="chat-dialog-toggle">
          <input
            type="checkbox"
            checked={data.reasoningEffort !== 'off'}
            onChange={(event) =>
              update({ ...data, reasoningEffort: event.target.checked ? 'high' : 'off' })
            }
          />
          显示模型返回的思考过程
        </label>
      )}
      <label>
        温度 <output>{data.temperature.toFixed(2)}</output>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={data.temperature}
          onChange={(event) => update({ ...data, temperature: Number(event.target.value) })}
        />
      </label>
      <label>
        最大输出 <output>{data.maxTokens}</output>
        <input
          type="range"
          min={256}
          max={32768}
          step={256}
          value={data.maxTokens}
          onChange={(event) => update({ ...data, maxTokens: Number(event.target.value) })}
        />
      </label>
      <div className="chat-dialog-documents">
        <span>附件 {data.documents?.length ?? 0}</span>
        {(data.documents ?? []).map((document, index) => (
          <div key={`${document.name}-${index}`}>
            <span title={document.content.slice(0, 160)}>{document.name}</span>
            <button
              type="button"
              aria-label={`移除 ${document.name}`}
              onClick={() =>
                update({
                  ...data,
                  documents: data.documents?.filter((_, current) => current !== index) ?? []
                })
              }
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          <Icon name="attach" size={14} /> 添加附件
        </button>
      </div>
    </section>
  ) : null

  return createPortal(
    <div
      className="chat-dialog-overlay"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div
        className={`chat-dialog${fullscreen ? ' is-fullscreen' : ''}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-dialog-title"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="chat-dialog-header">
          <div className="chat-dialog-session-picker">
            <AppSelect
              aria-label="历史对话"
              disabled={running || importingAttachments}
              value={activeConversation.id}
              onChange={(event) => {
                setDraftImages([])
                update(selectChatConversation(data, event.target.value))
              }}
            >
              {conversations.map((conversation) => (
                <option value={conversation.id} key={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </AppSelect>
            <button
              type="button"
              className="chat-dialog-new"
              aria-label="新建对话"
              disabled={running || importingAttachments}
              onClick={() => {
                setDraftImages([])
                update(createChatConversation(data))
              }}
            >
              <Icon name="add" size={16} />
            </button>
          </div>
          <div className="chat-dialog-heading">
            <span id="chat-dialog-title">
              {selectedModel ? selectedModel.model.name || selectedModel.model.id : 'AI 对话'}
            </span>
          </div>
          <div className="chat-dialog-actions">
            <button
              type="button"
              aria-label={fullscreen ? '退出全屏' : '全屏显示'}
              aria-pressed={fullscreen}
              onClick={() => setFullscreen((current) => !current)}
            >
              <Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={16} />
            </button>
            <button
              type="button"
              aria-label="对话设置"
              disabled={running || importingAttachments}
              aria-pressed={showSettings}
              onClick={() => setSettingsPreference(showSettings ? 'closed' : 'open')}
            >
              <Icon name="settings" size={16} />
            </button>
            <button
              type="button"
              aria-label="关闭对话"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onClose()
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
        {settings}
        {!showSettings && (
          <>
            {activeConversation.summary && (
              <div className="chat-dialog-summary">
                <Icon name="history" size={13} /> 已压缩较早历史；改写任意消息将重建上下文。
              </div>
            )}
            <main
              className="chat-dialog-messages"
              ref={scrollRef}
              aria-live="polite"
              aria-atomic="false"
            >
              {messages.map((message, index) => {
                const isStreaming =
                  running && message.role === 'assistant' && index === messages.length - 1
                return (
                  <article
                    className={`chat-dialog-message ${message.role}${isStreaming && message.content ? ' is-streaming' : ''}`}
                    key={`${index}-${message.content.slice(0, 24)}`}
                  >
                    <div className="chat-dialog-message-meta">
                      <img
                        className="chat-dialog-avatar"
                        src={message.role === 'user' ? userAvatar : aiAvatar}
                        alt=""
                        aria-hidden="true"
                      />
                      <span>{message.role === 'user' ? '你' : 'AI'}</span>
                    </div>
                    <div className="chat-dialog-bubble">
                      {editingIndex === index ? (
                        <>
                          <textarea
                            aria-label="修改消息"
                            value={editingText}
                            rows={4}
                            onChange={(event) => setEditingText(event.target.value)}
                          />
                          <div className="chat-dialog-edit-actions">
                            <button type="button" onClick={() => setEditingIndex(null)}>
                              取消
                            </button>
                            <button type="button" onClick={saveEdit} disabled={!editingText.trim()}>
                              保存
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          {message.role === 'assistant' &&
                            (message.reasoning ||
                              (running && index === messages.length - 1 && !message.content)) && (
                              <ReasoningBlock
                                content={message.reasoning ?? ''}
                                live={running && index === messages.length - 1 && !message.content}
                              />
                            )}
                          <MarkdownMessage content={message.content} />
                          {Boolean(message.images?.length) && project && (
                            <ChatImageGallery
                              images={message.images!}
                              projectId={project.id}
                              onPreview={openImagePreview}
                            />
                          )}
                          {isStreaming && (
                            <GenerationLoadingOverlay
                              title={
                                messages.at(-2)?.intent === 'image' ? '图片生成中' : 'AI 回复中'
                              }
                            />
                          )}
                        </>
                      )}
                    </div>
                    {/* 所有消息操作位于正文下方。 */}
                    {message.role !== 'system' && editingIndex !== index && !isStreaming && (
                      <div className="chat-dialog-message-actions">
                        {renderMessageActions(index, message.role)}
                      </div>
                    )}
                  </article>
                )
              })}
              {running && messages.at(-1)?.role !== 'assistant' && (
                <article className="chat-dialog-message assistant" aria-label="正在生成">
                  <div className="chat-dialog-message-meta">
                    <img className="chat-dialog-avatar" src={aiAvatar} alt="" aria-hidden="true" />
                    <span>AI</span>
                  </div>
                  <div className="chat-dialog-thinking">
                    <GenerationLoadingOverlay
                      title={messages.at(-1)?.intent === 'image' ? '图片生成中' : 'AI 回复中'}
                    />
                  </div>
                </article>
              )}
              {!messages.length && !running && (
                <div className="chat-dialog-empty">从一个问题开始，历史会保存在当前会话。</div>
              )}
            </main>
            <footer className="chat-dialog-composer">
              {Boolean(data.documents?.length || draftImages.length) && (
                <div className="chat-dialog-attachments" aria-label="已添加的附件">
                  {draftImages.map((image) => (
                    <span className="chat-dialog-attachment" key={image.mediaId}>
                      <Icon name="image" size={14} />
                      <span title={image.name}>{image.name}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${image.name}`}
                        onClick={() =>
                          setDraftImages((current) =>
                            current.filter((item) => item.mediaId !== image.mediaId)
                          )
                        }
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </span>
                  ))}
                  {data.documents?.map((document, index) => (
                    <span className="chat-dialog-attachment" key={`${document.name}-${index}`}>
                      <Icon name="document" size={14} />
                      <span title={document.name}>{document.name}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${document.name}`}
                        onClick={() =>
                          update({
                            ...data,
                            documents:
                              data.documents?.filter((_, current) => current !== index) ?? []
                          })
                        }
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-dialog-skill-controls">
                <span className="chat-dialog-control-label">模式</span>
                <AppSelect
                  aria-label="发送方式"
                  value={sendMode}
                  disabled={running}
                  onChange={(event) =>
                    setSendMode(event.target.value === 'image' ? 'image' : 'chat')
                  }
                >
                  <option value="chat">对话</option>
                  <option value="image" disabled={!imageSkill.enabled}>
                    生图
                  </option>
                </AppSelect>
                <span className="chat-dialog-control-divider" aria-hidden="true" />
                <span className="chat-dialog-control-label">
                  {sendMode === 'chat' ? '文本模型' : '图片模型'}
                </span>
                {sendMode === 'chat' ? (
                  <AppSelect
                    aria-label="发送栏文本模型"
                    className="chat-dialog-model-select"
                    value={data.modelKey}
                    disabled={running}
                    onChange={(event) => update({ ...data, modelKey: event.target.value })}
                  >
                    <option value="">选择文本模型</option>
                    {options.map((option) => (
                      <option
                        key={option.key}
                        value={option.key}
                        data-trigger-label={option.model.name || option.model.id}
                      >
                        {option.label}
                      </option>
                    ))}
                  </AppSelect>
                ) : (
                  <AppSelect
                    aria-label="发送栏图片模型"
                    className="chat-dialog-model-select"
                    value={imageSkill.modelKey}
                    disabled={running}
                    onChange={(event) =>
                      update({
                        ...data,
                        imageSkill: { ...imageSkill, modelKey: event.target.value }
                      })
                    }
                  >
                    <option value="">默认图片模型</option>
                    {imageOptions.map((option) => (
                      <option
                        key={option.key}
                        value={option.key}
                        data-trigger-label={option.model.name || option.model.id}
                      >
                        {option.label}
                      </option>
                    ))}
                  </AppSelect>
                )}
                {imageSkill.enabled && sendMode === 'image' && (
                  <>
                    <span className="chat-dialog-control-divider" aria-hidden="true" />
                    <span className="chat-dialog-control-label">分辨率</span>
                    <AppSelect
                      aria-label="生图分辨率"
                      value={imageSkill.resolution}
                      disabled={running}
                      onChange={(event) =>
                        update({
                          ...data,
                          imageSkill: {
                            ...imageSkill,
                            resolution:
                              event.target.value === '4k' || event.target.value === '2k'
                                ? event.target.value
                                : '1k'
                          }
                        })
                      }
                    >
                      <option value="1k">1K</option>
                      <option value="2k">2K</option>
                      <option value="4k">4K</option>
                    </AppSelect>
                  </>
                )}
              </div>
              <button
                type="button"
                aria-label="添加附件"
                title="添加图片、文本或文档附件"
                disabled={running || importingAttachments}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="attach" size={17} />
              </button>
              <textarea
                ref={inputRef}
                aria-label="输入消息"
                value={draft}
                rows={1}
                placeholder={
                  project
                    ? sendMode === 'image'
                      ? '描述想生成的图片，Enter 生图'
                      : '输入消息，Enter 发送，Shift + Enter 换行'
                    : '项目未就绪'
                }
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
              <button
                type="button"
                className="chat-dialog-send"
                aria-label="发送消息"
                disabled={!draft.trim() || running || importingAttachments}
                onClick={() => void send()}
              >
                <Icon name="send" size={17} />
              </button>
            </footer>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.json,.csv,.log,.xml,.html,.htm,.js,.ts,.py,.yaml,.yml,.png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx"
          multiple
          hidden
          onChange={(event) => void handleDocUpload(event)}
        />
        {pendingEdit && (
          <div
            ref={confirmRef}
            className="chat-dialog-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="确认截断后续对话"
          >
            <div>
              <Icon name="warning" size={19} />
              <strong>
                保存这条修改会删除之后 {messages.length - pendingEdit.index - 1} 条对话
              </strong>
              <p>保存后会用「这条修改及之前的对话」重新生成回复。此操作不能撤销。</p>
            </div>
            <div>
              <button type="button" onClick={() => setPendingEdit(null)}>
                返回修改
              </button>
              <button type="button" onClick={() => void confirmEdit()}>
                确认保存并重新生成
              </button>
            </div>
          </div>
        )}
        {previewImage && (
          <div
            className="chat-dialog-image-preview"
            ref={previewRef}
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            onClick={(event) => {
              if (event.target === event.currentTarget) setPreviewImage(null)
            }}
          >
            <header>
              <span title={previewImage.name}>{previewImage.name}</span>
              {project && (
                <button
                  type="button"
                  onClick={() => void downloadChatImage(project.id, previewImage)}
                >
                  <Icon name="download" size={16} />
                  下载
                </button>
              )}
              <button type="button" aria-label="关闭图片预览" onClick={() => setPreviewImage(null)}>
                <Icon name="close" size={18} />
              </button>
            </header>
            {previewError ? (
              <p role="alert">图片无法读取，请检查项目文件</p>
            ) : (
              <img
                src={mediaUrl(previewImage.mediaPath)}
                alt={previewImage.name}
                onError={() => setPreviewError(true)}
              />
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
