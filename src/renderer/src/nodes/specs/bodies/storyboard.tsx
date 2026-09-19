// 分镜板节点 Body（路线图 R6：bodies.tsx 拆分）
//
// 解析只走共享出口 readStoryboardText / parseStoryboardData：卡片与执行器必须同一口径，
// 且镜头上的额外字段（剧本的 sound、批量生图的 camera）必须原样保留，否则一次逐镜编辑
// 就会把这些字段静默写丢。
import { useEffect, useMemo, useRef, useState } from 'react'
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import { parseStoryboardData, readStoryboardText } from '@shared/engine/helpers'
import type { NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { countIncomingConnections, gatherUpstreamJson } from '../../../canvas/graph'
import { Icon } from '../../../components/Icon'
import { useWheelScroll } from './shared'
import {
  createStoryboardShot,
  moveStoryboardShot,
  removeStoryboardShot,
  updateStoryboardShot,
  type StoryboardData,
  type StoryboardShot
} from '../../storyboard-editor'

const EMPTY_BOARD: StoryboardData = { shots: [] }

function newShotId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 11)
}

export function StoryboardBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)
  const board = useMemo(() => readStoryboardText(shape.props.text), [shape.props.text])
  const data = board.kind === 'ok' ? board.data : EMPTY_BOARD
  const shotCount = data.shots.length
  // 执行器按 in-json → in-text → 本卡片正文 的优先级取数并写回正文，所以连线状态必须
  // 印在卡片上：否则「连着上游又在卡片上手改过镜头」的用户不知道运行会覆盖自己的编辑。
  const jsonCount = useValue(
    'storyboard in-json inputs',
    () => countIncomingConnections(editor, shape.id, 'in-json'),
    [editor, shape.id]
  )
  const textCount = useValue(
    'storyboard in-text inputs',
    () => countIncomingConnections(editor, shape.id, 'in-text'),
    [editor, shape.id]
  )
  const wired = jsonCount + textCount > 0
  // 「卡片为空」和「卡片里有字但不是分镜」是两件事：前者要连线或新建镜头，后者要修 JSON。
  // 合并成一句提示就是在骗用户，所以四个状态各自给一句话。
  const wiring: { text: string; warn: boolean } = !wired
    ? shotCount
      ? { text: `上游未连线，运行使用本卡片的 ${shotCount} 个镜头`, warn: false }
      : board.kind !== 'empty'
        ? {
            text: '上游未连线，且本卡片正文不是分镜数据（需要 shots 数组），运行会失败',
            warn: true
          }
        : { text: '分镜数据（in-json）未连线，且本卡片为空，运行会跳过', warn: true }
    : shotCount
      ? {
          text: `已连线 in-json ${jsonCount} · in-text ${textCount}，运行会用它覆盖本卡片的 ${shotCount} 个镜头`,
          warn: false
        }
      : {
          text: `已连线 in-json ${jsonCount} · in-text ${textCount}，运行后写入本卡片`,
          warn: false
        }
  // 上游自动导入只应发生一次；用户手动清空或编辑后不再被覆盖（A9）
  const importedRef = useRef(false)
  const [editingInput, setEditingInput] = useState(false)
  const [draftInput, setDraftInput] = useState(shape.props.text)
  const [editingShotId, setEditingShotId] = useState<string | null>(null)
  const [shotDraft, setShotDraft] = useState<
    Pick<StoryboardShot, 'scene' | 'dialogue' | 'duration'>
  >({
    scene: '',
    dialogue: '',
    duration: ''
  })

  const update = (next: StoryboardData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const openJsonEditor = (): void => {
    setDraftInput(shotCount ? JSON.stringify(data, null, 2) : shape.props.text)
    setEditingInput(true)
  }

  // 从上游接收分镜数据。监听画布变更，保证“先创建节点、后连接连线”也能同步。
  useEffect(() => {
    const importUpstream = (): void => {
      if (importedRef.current) return
      if (shotCount > 0) {
        importedRef.current = true
        return
      }
      const parsed = parseStoryboardData(gatherUpstreamJson(editor, shape.id))
      if (!parsed || parsed.shots.length === 0) return
      update(parsed)
      importedRef.current = true
      markUndoPoint(editor, 'storyboard-import')
    }
    importUpstream()
    return editor.store.listen(importUpstream, { scope: 'document' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, shape.id, shotCount])

  const commitInput = (): void => {
    const next = readStoryboardText(draftInput)
    if (next.kind !== 'ok') {
      toast(next.kind === 'not-json' ? '分镜 JSON 格式有误' : '分镜 JSON 需要包含 shots 数组')
      return
    }
    setEditingInput(false)
    update(next.data)
    markUndoPoint(editor, 'storyboard-json-edit')
  }

  const startShotEdit = (shot: StoryboardShot): void => {
    setEditingShotId(shot.id)
    setShotDraft({ scene: shot.scene, dialogue: shot.dialogue, duration: shot.duration })
  }

  const saveShotEdit = (): void => {
    if (!editingShotId) return
    update(updateStoryboardShot(data, editingShotId, shotDraft))
    setEditingShotId(null)
    markUndoPoint(editor, 'storyboard-shot-edit')
  }

  const addShot = (): void => {
    const shot = createStoryboardShot(newShotId())
    update({ ...data, shots: [...data.shots, shot] })
    startShotEdit(shot)
    markUndoPoint(editor, 'storyboard-shot-add')
  }

  const moveShot = (index: number, direction: -1 | 1): void => {
    const next = moveStoryboardShot(data, index, direction)
    if (next === data) return
    update(next)
    markUndoPoint(editor, 'storyboard-shot-move')
  }

  const removeShot = (shotId: string): void => {
    update(removeStoryboardShot(data, shotId))
    if (editingShotId === shotId) setEditingShotId(null)
    markUndoPoint(editor, 'storyboard-shot-remove')
  }

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

  if (shotCount === 0) {
    return (
      <div
        className="node-hint center"
        onPointerDown={(e) => stopEventPropagation(e)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          openJsonEditor()
        }}
      >
        {wiring.text}
        <br />
        可逐镜填写，也可直接粘贴分镜 JSON
        <div className="storyboard-empty-actions">
          <button
            type="button"
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              addShot()
            }}
          >
            <Icon name="add" size={14} />
            新增镜头
          </button>
          <button
            type="button"
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              openJsonEditor()
            }}
          >
            <Icon name="edit" size={14} />
            编辑 JSON
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="storyboard-body" ref={scrollRef}>
      <div className="storyboard-toolbar">
        <span>编辑结果通过右侧「分镜数据」端口输出给下游节点。</span>
        <div className="storyboard-toolbar-actions">
          <button type="button" onPointerDown={stopEventPropagation} onClick={addShot}>
            <Icon name="add" size={12} /> 新增镜头
          </button>
          <button
            type="button"
            title="编辑原始分镜 JSON"
            onPointerDown={stopEventPropagation}
            onClick={openJsonEditor}
          >
            编辑 JSON
          </button>
        </div>
      </div>
      <span className={`node-wiring ${wiring.warn ? 'warn' : 'ok'}`}>{wiring.text}</span>
      {/* 分镜卡片 */}
      {data.shots.map((shot, i) => (
        <div
          key={shot.id}
          className={`storyboard-card ${editingShotId === shot.id ? 'editing' : ''}`}
          onDoubleClick={(event) => {
            stopEventPropagation(event)
            startShotEdit(shot)
          }}
        >
          <div className="storyboard-num">#{i + 1}</div>
          {editingShotId === shot.id ? (
            <div className="storyboard-edit" onPointerDown={stopEventPropagation}>
              <label>
                画面
                <textarea
                  autoFocus
                  value={shotDraft.scene}
                  placeholder="描述镜头画面、构图与动作"
                  onChange={(event) => setShotDraft({ ...shotDraft, scene: event.target.value })}
                />
              </label>
              <label>
                台词
                <input
                  value={shotDraft.dialogue}
                  placeholder="可选"
                  onChange={(event) => setShotDraft({ ...shotDraft, dialogue: event.target.value })}
                />
              </label>
              <label>
                时长
                <input
                  value={shotDraft.duration}
                  placeholder="例如 3s"
                  onChange={(event) => setShotDraft({ ...shotDraft, duration: event.target.value })}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveShotEdit()
                    if (event.key === 'Escape') setEditingShotId(null)
                  }}
                />
              </label>
              <div className="storyboard-edit-actions">
                <button type="button" onClick={saveShotEdit}>
                  保存
                </button>
                <button type="button" onClick={() => setEditingShotId(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="storyboard-info">
              <div className="storyboard-scene">{shot.scene || '（无画面描述）'}</div>
              {shot.dialogue && (
                <div className="storyboard-dialogue">
                  <Icon name="chat" size={12} />
                  {shot.dialogue}
                </div>
              )}
              {shot.duration && <div className="storyboard-duration">⏱ {shot.duration}</div>}
              <div className="storyboard-card-actions" onPointerDown={stopEventPropagation}>
                <button type="button" onClick={() => startShotEdit(shot)}>
                  编辑
                </button>
                <button type="button" disabled={i === 0} onClick={() => moveShot(i, -1)}>
                  上移
                </button>
                <button
                  type="button"
                  disabled={i === data.shots.length - 1}
                  onClick={() => moveShot(i, 1)}
                >
                  下移
                </button>
                <button type="button" className="danger" onClick={() => removeShot(shot.id)}>
                  删除
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
