// 分镜板节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { gatherUpstreamJson } from '../../../canvas/graph'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { ModelSelect, useWheelScroll } from './shared'

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
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const imgOptions = modelsByModality(providers, 'image')
  const data = parseStoryboard(shape.props.text)
  const [generatingShots, setGeneratingShots] = useState<Set<string>>(new Set())
  // 上游自动导入只应发生一次；用户手动清空或编辑后不再被覆盖（A9）
  const importedRef = useRef(false)
  const [editingInput, setEditingInput] = useState(false)
  const [draftInput, setDraftInput] = useState(shape.props.text)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

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

  // 从编辑器读取最新分镜状态（绕过渲染期闭包的过期 data，修复顺序生成互相覆盖）
  const readCurrent = (): StoryboardData =>
    parseStoryboard((editor.getShape(shape.id) as typeof shape | undefined)?.props.text ?? '')

  // 逐镜生图
  const generateShotImage = async (shotId: string): Promise<boolean> => {
    const current = readCurrent()
    const shot = current.shots.find((s) => s.id === shotId)
    if (!shot?.scene) {
      toast('该镜头没有画面描述')
      return false
    }
    if (!current.imageModelKey) {
      toast('请先选择图片模型')
      return false
    }
    const opt = imgOptions.find((o) => o.key === current.imageModelKey)
    if (!opt) {
      toast('图片模型不可用')
      return false
    }
    if (!project) {
      toast('项目未就绪')
      return false
    }
    setGeneratingShots((prev) => new Set(prev).add(shotId))
    const res = await window.api.gateway.imageGenerate({
      projectId: project.id,
      providerId: opt.provider.id,
      modelId: opt.model.id,
      prompt: shot.scene
    })
    setGeneratingShots((prev) => {
      const next = new Set(prev)
      next.delete(shotId)
      return next
    })
    if (!res.ok) {
      toast(`生成失败：${res.error.message}`)
      return false
    }
    // 关键：基于最新 shape 状态合并，顺序生成时不丢前序镜头的图
    const latest = readCurrent()
    const nextShots = latest.shots.map((s) =>
      s.id === shotId ? { ...s, imageMediaId: res.data.id, imageMediaPath: res.data.path } : s
    )
    update({ ...latest, shots: nextShots })
    markUndoPoint(editor, 'storyboard-shotgen')
    return true
  }

  // 全部生图（顺序执行）
  const generateAll = async (): Promise<void> => {
    const pending = data.shots.filter((s) => !s.imageMediaPath && s.scene)
    if (pending.length === 0) return toast('没有待生成的镜头')
    let okCount = 0
    for (const shot of pending) {
      if (await generateShotImage(shot.id)) okCount += 1
    }
    if (okCount === 0) return
    toast(
      okCount === pending.length
        ? `${okCount} 个镜头已生成`
        : `已生成 ${okCount}/${pending.length} 个镜头`
    )
  }

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

  const hasModel = imgOptions.length > 0
  const pendingCount = data.shots.filter((s) => !s.imageMediaPath && s.scene).length

  return (
    <div className="storyboard-body" ref={scrollRef}>
      {/* 图片模型选择栏 */}
      <div className="storyboard-toolbar">
        {hasModel ? (
          <>
            <ModelSelect
              value={data.imageModelKey ?? ''}
              options={imgOptions}
              onChange={(key) => update({ ...data, imageModelKey: key })}
            />
            {pendingCount > 0 && data.imageModelKey && (
              <button
                className="btn-ghost small"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  void generateAll()
                }}
              >
                全部生图 ({pendingCount})
              </button>
            )}
          </>
        ) : (
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              openSettings()
            }}
          >
            配置图片模型
          </button>
        )}
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
          ) : generatingShots.has(shot.id) ? (
            <div className="storyboard-thumb-empty generating">⏳</div>
          ) : (
            <button
              className="storyboard-thumb-gen"
              disabled={!shot.scene || !data.imageModelKey}
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void generateShotImage(shot.id)
              }}
            >
              {shot.scene ? (
                <>
                  <Icon name="image" size={13} />
                  生图
                </>
              ) : (
                <Icon name="image" size={13} />
              )}
            </button>
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
