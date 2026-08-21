// 节点内容组件（LibTV 式卡片内容区）：五类基础节点 + 脚本节点
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../registry'
import { toast } from '../../stores/toast'
import { markUndoPoint } from '../../canvas/history'

// 点击 vs 拖拽判定：拖动卡片时元素随指针移动，pointerup 仍会触发 click，
// 位移超过阈值视为拖拽，不触发预览
function useClickGuard(): {
  onPointerDown: (e: React.PointerEvent) => void
  onClick: (e: React.MouseEvent, open: () => void) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e) => {
      downRef.current = { x: e.clientX, y: e.clientY }
    },
    onClick: (e, open) => {
      const d = downRef.current
      downRef.current = null
      if (!d) return
      if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) return
      e.stopPropagation()
      open()
    }
  }
}

// 卡片内可滚动区域：内容可滚时截断 wheel 冒泡，避免滚动手势被画布抢走（缩放/平移）。
// 必须用原生监听：tldraw 的 wheel 监听在容器上，React 合成事件的 stopPropagation 到不了它
function useWheelScroll(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const canScroll =
        e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
      if (canScroll) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [ref])
}

export function TextBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  const commit = (): void => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
      markUndoPoint(editor, 'text-edit')
    }
  }

  if (editing) {
    return (
      <textarea
        className="node-textarea"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') commit()
        }}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
    )
  }

  return (
    <div
      className="node-text"
      ref={scrollRef}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(shape.props.text)
        setEditing(true)
      }}
    >
      {shape.props.text || <span className="node-hint">双击输入文本内容</span>}
    </div>
  )
}

export function ImageBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  if (!shape.props.mediaPath) {
    return <div className="node-hint center">拖入图片或从菜单上传</div>
  }
  return (
    <div
      className="node-media"
      onPointerDown={guard.onPointerDown}
      onClick={(e) =>
        guard.onClick(e, () =>
          openPreview({
            kind: 'image',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        )
      }
    >
      <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
    </div>
  )
}

export function VideoBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  if (!shape.props.mediaPath) {
    return <div className="node-hint center">拖入视频或从菜单上传</div>
  }
  return (
    <div
      className="node-media"
      onPointerDown={guard.onPointerDown}
      onClick={(e) =>
        guard.onClick(e, () =>
          openPreview({
            kind: 'video',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        )
      }
    >
      <video src={mediaUrl(shape.props.mediaPath)} preload="metadata" muted playsInline />
      <span className="play-badge">▶</span>
    </div>
  )
}

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  if (!shape.props.mediaPath) {
    return <div className="node-hint center">拖入音频或从菜单上传</div>
  }
  return (
    <div className="node-audio">
      <div className="audio-wave">♪ ♫ ♪</div>
      <button
        className="btn-ghost small"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          openPreview({
            kind: 'audio',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        }}
      >
        播放
      </button>
    </div>
  )
}

export function ChatBody(): React.JSX.Element {
  return (
    <div className="node-hint center">
      💬 对话功能将在模型接入后开放
      <br />
      <span className="dim">（M4 模型网关）</span>
    </div>
  )
}

// ── 脚本节点（LibTV 1.2.6 基础版）──
// 数据存 shape.props.text（JSON 字符串），不改 tldraw 形状 schema，旧快照零迁移：
// 解析失败时把原文当作剧本文本，兼容「文本节点内容直接粘贴」的旧数据
interface ScriptShot {
  id: string
  scene: string
  dialogue: string
  duration: string
}

interface ScriptData {
  source: string
  shots: ScriptShot[]
}

const emptyShot = (): ScriptShot => ({
  id: Math.random().toString(36).slice(2, 9),
  scene: '',
  dialogue: '',
  duration: ''
})

function normalizeShot(v: unknown): ScriptShot {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    id: typeof o.id === 'string' ? o.id : Math.random().toString(36).slice(2, 9),
    scene: typeof o.scene === 'string' ? o.scene : '',
    dialogue: typeof o.dialogue === 'string' ? o.dialogue : '',
    duration: typeof o.duration === 'string' ? o.duration : ''
  }
}

function parseScript(text: string): ScriptData {
  if (!text) return { source: '', shots: [] }
  try {
    const v = JSON.parse(text) as { source?: unknown; shots?: unknown }
    if (v && typeof v === 'object' && Array.isArray(v.shots)) {
      return {
        source: typeof v.source === 'string' ? v.source : '',
        shots: v.shots.map(normalizeShot)
      }
    }
  } catch {
    // 非结构化内容视为剧本文本
  }
  return { source: text, shots: [] }
}

const SCRIPT_MAX_H = 640

export function ScriptBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseScript(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 离散操作（加/删/移镜头）的分段点名：不在 handler 里立即打点，
  // 等下方布局副作用把自动撑高的 h 变更并入同一步后再打，避免污染撤销粒度
  const pendingMarkRef = useRef<string | null>(null)
  useWheelScroll(scrollRef)

  const update = (next: ScriptData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // 离开输入框时打撤销分段点：连续敲键在 pendingDiff 里自然合并为一步，
  // 分段点保证「本次编辑会话」与后续操作（加镜头等）不粘连
  const markSession = (): void => markUndoPoint(editor, 'script-edit')

  const patchShot = (id: string, patch: Partial<ScriptShot>): void => {
    update({ ...data, shots: data.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  const moveShot = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= data.shots.length) return
    const shots = [...data.shots]
    ;[shots[index], shots[target]] = [shots[target], shots[index]]
    update({ ...data, shots })
    pendingMarkRef.current = 'shot-move'
  }

  // 内容增高时自动撑高卡片（只增不减，上限后内部滚动），手动缩放不被覆盖
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const need = el.scrollHeight + 2
    if (need > shape.props.h && shape.props.h < SCRIPT_MAX_H) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { h: Math.min(SCRIPT_MAX_H, need) }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.shots.length, data.source.length])

  // 在高度副作用之后执行：此刻文本+高度变更都已落入同一段 pendingDiff，再打分段点
  useLayoutEffect(() => {
    const name = pendingMarkRef.current
    if (!name) return
    pendingMarkRef.current = null
    markUndoPoint(editor, name)
  })

  return (
    <div className="script-body" ref={scrollRef}>
      <textarea
        className="script-source"
        value={data.source}
        rows={3}
        spellCheck={false}
        placeholder="输入或粘贴剧本文本…（接入模型后可一键拆解分镜）"
        onChange={(e) => update({ ...data, source: e.target.value })}
        onBlur={markSession}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
      {data.shots.length > 0 && (
        <div className="script-shots">
          {data.shots.map((shot, i) => (
            <div className="shot-row" key={shot.id}>
              <span className="shot-no">{i + 1}</span>
              <div className="shot-fields">
                <textarea
                  className="shot-scene"
                  value={shot.scene}
                  rows={2}
                  spellCheck={false}
                  placeholder="画面描述…"
                  onChange={(e) => patchShot(shot.id, { scene: e.target.value })}
                  onBlur={markSession}
                  onPointerDown={(e) => stopEventPropagation(e)}
                />
                <div className="shot-meta">
                  <input
                    className="shot-dialogue"
                    value={shot.dialogue}
                    spellCheck={false}
                    placeholder="台词 / 音效"
                    onChange={(e) => patchShot(shot.id, { dialogue: e.target.value })}
                    onBlur={markSession}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  />
                  <input
                    className="shot-duration"
                    value={shot.duration}
                    spellCheck={false}
                    placeholder="时长"
                    onChange={(e) => patchShot(shot.id, { duration: e.target.value })}
                    onBlur={markSession}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  />
                </div>
              </div>
              <div className="shot-ops">
                <button
                  className="shot-op"
                  title="上移"
                  disabled={i === 0}
                  onClick={() => moveShot(i, -1)}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ↑
                </button>
                <button
                  className="shot-op"
                  title="下移"
                  disabled={i === data.shots.length - 1}
                  onClick={() => moveShot(i, 1)}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ↓
                </button>
                <button
                  className="shot-op danger"
                  title="删除镜头"
                  onClick={() => {
                    update({ ...data, shots: data.shots.filter((s) => s.id !== shot.id) })
                    pendingMarkRef.current = 'shot-delete'
                  }}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="script-foot">
        <button
          className="btn-ghost small"
          onClick={() => {
            update({ ...data, shots: [...data.shots, emptyShot()] })
            pendingMarkRef.current = 'shot-add'
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          ＋ 添加镜头
        </button>
        <button
          className="btn-ghost small"
          onClick={() => toast('剧本 AI 拆解将在模型接入（M4）后开放')}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          ⚡ 拆解剧本
        </button>
      </div>
    </div>
  )
}
