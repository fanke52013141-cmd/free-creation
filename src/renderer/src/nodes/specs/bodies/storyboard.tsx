// 分镜板节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { gatherUpstreamJson } from '../../../canvas/graph'
import { Icon } from '../../../components/Icon'
import { useWheelScroll } from './shared'

interface StoryboardShot {
  id: string
  scene: string
  dialogue: string
  duration: string
  imageMediaId?: string
  imageMediaPath?: string
}

interface StoryboardData {
  shots: StoryboardShot[]
  imageModelKey?: string
}

function parseStoryboard(text: string): StoryboardData {
  if (!text) return { shots: [] }
  try {
    const v = JSON.parse(text) as { shots?: unknown; imageModelKey?: unknown }
    if (v && typeof v === 'object' && Array.isArray(v.shots)) {
      return {
        shots: v.shots.map(
          (s) =>
            ({
              id:
                typeof (s as Record<string, unknown>).id === 'string'
                  ? (s as { id: string }).id
                  : Math.random().toString(36).slice(2, 9),
              scene:
                typeof (s as Record<string, unknown>).scene === 'string'
                  ? (s as { scene: string }).scene
                  : '',
              dialogue:
                typeof (s as Record<string, unknown>).dialogue === 'string'
                  ? (s as { dialogue: string }).dialogue
                  : '',
              duration:
                typeof (s as Record<string, unknown>).duration === 'string'
                  ? (s as { duration: string }).duration
                  : '',
              imageMediaId:
                typeof (s as Record<string, unknown>).imageMediaId === 'string'
                  ? (s as { imageMediaId: string }).imageMediaId
                  : undefined,
              imageMediaPath:
                typeof (s as Record<string, unknown>).imageMediaPath === 'string'
                  ? (s as { imageMediaPath: string }).imageMediaPath
                  : undefined
            }) as StoryboardShot
        ),
        imageModelKey: typeof v.imageModelKey === 'string' ? v.imageModelKey : undefined
      }
    }
  } catch {
    // 非结构化内容
  }
  return { shots: [] }
}

const STORYBOARD_MAX_H = 640

export function StoryboardBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)
  const data = parseStoryboard(shape.props.text)
  // 上游自动导入只应发生一次；用户手动清空或编辑后不再被覆盖（A9）
  const importedRef = useRef(false)
  const [editingInput, setEditingInput] = useState(false)
  const [draftInput, setDraftInput] = useState(shape.props.text)

  const update = (next: StoryboardData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // 从上游接收分镜数据。监听画布变更，保证“先创建节点、后连接连线”也能同步。
  useEffect(() => {
    const importUpstream = (): void => {
      if (importedRef.current) return
      if (data.shots.length > 0) {
        importedRef.current = true
        return
      }
      const upstream = gatherUpstreamJson(editor, shape.id)
      const parsed = Array.isArray(upstream)
        ? { shots: upstream }
        : (upstream as { shots?: unknown } | null)
      if (parsed && Array.isArray(parsed.shots) && parsed.shots.length > 0) {
        update({
          shots: parsed.shots.map(
            (s) =>
              ({
                id: Math.random().toString(36).slice(2, 9),
                scene: (s as Record<string, string>).scene ?? '',
                dialogue: (s as Record<string, string>).dialogue ?? '',
                duration: (s as Record<string, string>).duration ?? ''
              }) as StoryboardShot
          )
        })
        importedRef.current = true
        markUndoPoint(editor, 'storyboard-import')
      }
    }
    importUpstream()
    return editor.store.listen(importUpstream, { scope: 'document' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, shape.id, data.shots.length])

  // 自动撑高
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const need = el.scrollHeight + 80
    if (need > shape.props.h && shape.props.h < STORYBOARD_MAX_H) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { h: Math.min(STORYBOARD_MAX_H, need) }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.shots.length])

  const commitInput = (): void => {
    let raw: unknown
    try {
      raw = JSON.parse(draftInput)
    } catch {
      toast('分镜 JSON 格式有误')
      return
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { shots?: unknown }).shots)) {
      toast('分镜 JSON 需要包含 shots 数组')
      return
    }
    const next = parseStoryboard(draftInput)
    setEditingInput(false)
    update(next)
    markUndoPoint(editor, 'storyboard-json-edit')
  }

  if (data.shots.length === 0) {
    if (editingInput) {
      return (
        <textarea
          className="node-textarea code-edit"
          autoFocus
          value={draftInput}
          placeholder='{"shots":[{"scene":"画面描述","dialogue":"","duration":"3s"}]}'
          onChange={(e) => setDraftInput(e.target.value)}
          onBlur={commitInput}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditingInput(false)
              setDraftInput(shape.props.text)
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commitInput()
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
          spellCheck={false}
        />
      )
    }
    return (
      <div
        className="node-hint center"
        onPointerDown={(e) => stopEventPropagation(e)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          setDraftInput(shape.props.text)
          setEditingInput(true)
        }}
      >
        将脚本节点连入此节点，
        <br />
        或双击输入分镜 JSON
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraftInput(shape.props.text)
            setEditingInput(true)
          }}
        >
          <Icon name="edit" size={14} />
          输入 JSON
        </button>
      </div>
    )
  }

  return (
    <div className="storyboard-body" ref={scrollRef}>
      <div className="storyboard-toolbar">
        <span>批量生图请在工作流面板套用「分镜→批量生图」模板。</span>
      </div>
      {/* 分镜卡片 */}
      {data.shots.map((shot, i) => (
        <div key={shot.id} className="storyboard-card">
          <div className="storyboard-num">#{i + 1}</div>
          {shot.imageMediaPath ? (
            <div
              className="storyboard-thumb"
              onClick={(e) => {
                e.stopPropagation()
                openPreview({
                  kind: 'image',
                  url: mediaUrl(shot.imageMediaPath!),
                  title: `镜头 ${i + 1}`
                })
              }}
            >
              <img src={mediaUrl(shot.imageMediaPath!)} alt={shot.scene} draggable={false} />
            </div>
          ) : (
            <div className="storyboard-thumb-empty" title="请通过分镜批量生图工作流生成媒体">
              <Icon name="image" size={13} />
            </div>
          )}
          <div className="storyboard-info">
            <div className="storyboard-scene">{shot.scene || '（无画面描述）'}</div>
            {shot.dialogue && (
              <div className="storyboard-dialogue">
                <Icon name="chat" size={12} />
                {shot.dialogue}
              </div>
            )}
            {shot.duration && <div className="storyboard-duration">⏱ {shot.duration}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
