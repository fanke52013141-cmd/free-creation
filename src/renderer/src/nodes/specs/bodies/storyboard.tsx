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
import { useConfirmStore } from '../../../stores/confirm'
import { markUndoPoint } from '../../../canvas/history'
import { countIncomingConnections, gatherUpstreamJson } from '../../../canvas/graph'
import { Icon } from '../../../components/Icon'
import {
  createStoryboardShot,
  moveStoryboardShot,
  removeStoryboardShot,
  updateStoryboardField,
  type StoryboardData,
  type StoryboardShot
} from '../../storyboard-editor'

const EMPTY_BOARD: StoryboardData = { shots: [] }

function displayStoryboardValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value || '—'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function newShotId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 11)
}

export function StoryboardBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement>(null)
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
  const [editingCell, setEditingCell] = useState<{ shotId: string; field: string } | null>(null)
  const [cellDraft, setCellDraft] = useState('')
  const fields = useMemo(
    () => Array.from(new Set(data.shots.flatMap((shot) => Object.keys(shot)))),
    [data.shots]
  )

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

  const startCellEdit = (shot: StoryboardShot, field: string): void => {
    if (field === 'id') return
    setEditingCell({ shotId: shot.id, field })
    const value = shot[field]
    setCellDraft(
      value === undefined ? '' : typeof value === 'string' ? value : displayStoryboardValue(value)
    )
  }

  const saveCellEdit = (shot: StoryboardShot): void => {
    if (!editingCell || editingCell.shotId !== shot.id) return
    const current = shot[editingCell.field]
    let nextValue: unknown = cellDraft
    if (current !== undefined && typeof current !== 'string') {
      try {
        nextValue = JSON.parse(cellDraft)
      } catch {
        toast('该字段原本是 JSON 值，请输入合法 JSON')
        return
      }
    }
    update(updateStoryboardField(data, shot.id, editingCell.field, nextValue))
    setEditingCell(null)
    markUndoPoint(editor, 'storyboard-field-edit')
  }

  const addShot = (): void => {
    const shot = createStoryboardShot(newShotId())
    update({ ...data, shots: [...data.shots, shot] })
    startCellEdit(shot, 'scene')
    markUndoPoint(editor, 'storyboard-shot-add')
  }

  const moveShot = (index: number, direction: -1 | 1): void => {
    const next = moveStoryboardShot(data, index, direction)
    if (next === data) return
    update(next)
    markUndoPoint(editor, 'storyboard-shot-move')
  }

  const removeShot = async (shotId: string): Promise<void> => {
    // 删除镜头不可逆：与项目菜单同款危险确认弹窗，取消即中止。
    if (
      !(await useConfirmStore.getState().confirm({
        title: '删除镜头',
        message: '该镜头将从分镜板移除，不可恢复。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    update(removeStoryboardShot(data, shotId))
    if (editingCell?.shotId === shotId) setEditingCell(null)
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
        <span>输出：out-json 分镜数据 · out-text 文字摘要</span>
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
      <div className="storyboard-table-scroll">
        <table className="storyboard-table">
          <thead>
            <tr>
              <th className="storyboard-row-number">#</th>
              {fields.map((field) => (
                <th key={field} title={field}>
                  {field}
                </th>
              ))}
              <th className="storyboard-row-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.shots.map((shot, i) => (
              <tr key={shot.id} data-shot-id={shot.id}>
                <td className="storyboard-row-number">{i + 1}</td>
                {fields.map((field) => {
                  const editing = editingCell?.shotId === shot.id && editingCell.field === field
                  const value = shot[field]
                  return (
                    <td
                      key={field}
                      data-field={field}
                      className={field === 'id' ? 'storyboard-id-cell' : undefined}
                    >
                      {editing ? (
                        <div
                          className="storyboard-cell-editor"
                          onPointerDown={stopEventPropagation}
                        >
                          <textarea
                            autoFocus
                            aria-label={`编辑 ${field}`}
                            value={cellDraft}
                            onChange={(event) => setCellDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                                saveCellEdit(shot)
                              }
                              if (event.key === 'Escape') setEditingCell(null)
                            }}
                          />
                          <div className="storyboard-edit-actions">
                            <button type="button" onClick={() => saveCellEdit(shot)}>
                              保存
                            </button>
                            <button type="button" onClick={() => setEditingCell(null)}>
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="storyboard-cell-value"
                          title={field === 'id' ? '内部稳定 ID，不可编辑' : '双击编辑该字段'}
                          onPointerDown={stopEventPropagation}
                          onDoubleClick={(event) => {
                            stopEventPropagation(event)
                            startCellEdit(shot, field)
                          }}
                        >
                          {displayStoryboardValue(value)}
                        </button>
                      )}
                    </td>
                  )
                })}
                <td className="storyboard-row-actions" onPointerDown={stopEventPropagation}>
                  <div className="storyboard-row-action-buttons">
                    <button
                      type="button"
                      title="上移"
                      aria-label={`上移镜头 ${i + 1}`}
                      disabled={i === 0}
                      onClick={() => moveShot(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="下移"
                      aria-label={`下移镜头 ${i + 1}`}
                      disabled={i === data.shots.length - 1}
                      onClick={() => moveShot(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`删除镜头 ${i + 1}`}
                      onClick={() => void removeShot(shot.id)}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
