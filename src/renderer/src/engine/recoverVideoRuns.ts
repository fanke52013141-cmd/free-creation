// 视频生成在退出项目/返回首页后会继续在主进程轮询（main.gateway.video 的 pollLoop），
// 但 renderer 的等待循环随画布卸载而丢失。重新进入项目时，这里按节点持久化的
// config.taskId 重新接上原任务：成功则把结果写回节点，失败/取消则如实落状态，
// 避免把仍在后台生成的任务误标成「应用关闭…已取消」。
import type { Editor, TLShapeId } from 'tldraw'
import { readNodeRunRecord, appendNodeRunHistory, type NodeRunRecord } from './runRecord'
import { parseVideoGen } from '@shared/engine/helpers'
import { readNodeConfig } from '@shared/engine/node-config'
import {
  appendMediaResult,
  serializeMediaResultCollection
} from '@shared/engine/values'
import { toast } from '../stores/toast'

const POLL_MS = 3_000
const MAX_WAIT_MS = 31 * 60 * 1000
const INTERRUPTED_REASON = '应用关闭或重启中断了上次运行，请重新运行'

function isRunningStatus(status: string): boolean {
  return status === 'running' || status === 'pending' || status === 'queued'
}

export function recoverRunningNodes(editor: Editor, projectId: string): () => void {
  let stopped = false
  const timers = new Set<number>()

  const commitRun = (
    shapeId: TLShapeId,
    run: NodeRunRecord,
    status: 'success' | 'failed' | 'cancelled',
    extra: { reason?: string; collection?: string; artifact?: { mediaId: string } } = {}
  ): void => {
    if (stopped) return
    const shape = editor.getShape(shapeId)
    if (!shape || shape.type !== 'node-card') return
    const finishedAt = Date.now()
    const finalRun: NodeRunRecord = {
      ...run,
      status,
      finishedAt,
      durationMs: Math.max(0, finishedAt - run.startedAt),
      ...(extra.reason ? { error: { phase: 'execution' as const, reason: extra.reason } } : {}),
      ...(status === 'success' ? { outputPorts: ['out-video'] } : {})
    }
    const meta = (shape.meta ?? {}) as Record<string, unknown>
    editor.updateShape({
      id: shapeId,
      type: 'node-card',
      props: { exec: status === 'success' ? 'success' : status },
      meta: {
        ...meta,
        ...(extra.collection ? { nodeResult: extra.collection } : {}),
        nodeRun: JSON.parse(JSON.stringify(finalRun)),
        nodeRunHistory: JSON.parse(JSON.stringify(appendNodeRunHistory(meta.nodeRunHistory, finalRun)))
      }
    })
  }

  const applySuccess = (
    shapeId: TLShapeId,
    run: NodeRunRecord,
    task: { mediaId: string; mediaPath: string; name?: string }
  ): void => {
    const shape = editor.getShape(shapeId)
    if (!shape || shape.type !== 'node-card') return
    const data = parseVideoGen(readNodeConfig(shape))
    const previous = typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
    const collection = serializeMediaResultCollection(
      appendMediaResult(
        previous,
        { mediaId: task.mediaId, mediaPath: task.mediaPath, mime: 'video/mp4' },
        {
          nodeId: shapeId,
          modelKey: data.modelKey,
          prompt: shape.props.text.slice(0, 80),
          runId: run.runId,
          genParams: data.params
        }
      )
    )
    commitRun(shapeId, run, 'success', { collection })
    toast(`「${shape.props.title || '视频生成'}」后台生成已完成`)
  }

  const recoverOne = (shapeId: TLShapeId, taskId: string, run: NodeRunRecord): void => {
    const startedAt = Date.now()
    let polling = false
    let failures = 0
    const finishFailure = (reason: string, status: 'failed' | 'cancelled' = 'failed'): void => {
      commitRun(shapeId, run, status, { reason })
      if (status === 'failed') toast(`「${shapeId}」后台视频任务失败：${reason}`)
    }
    const timer = window.setInterval(() => {
      if (stopped) return
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        window.clearInterval(timer)
        timers.delete(timer)
        finishFailure('视频任务等待超时（31 分钟）')
        return
      }
      if (polling) return
      polling = true
      void window.api.gateway
        .videoTask(taskId)
        .then((result) => {
          if (stopped) return
          if (!result.ok || !result.data) {
            failures += 1
            if (failures >= 3) finishFailure('视频任务状态连续查询失败')
            return
          }
          failures = 0
          const info = result.data
          if (info.status === 'success' && info.mediaPath) {
            window.clearInterval(timer)
            timers.delete(timer)
            applySuccess(shapeId, run, {
              mediaId: info.mediaId ?? '',
              mediaPath: info.mediaPath,
              name: info.nodeId
            })
          } else if (info.status === 'failed' || info.status === 'cancelled' || info.status === 'unknown') {
            window.clearInterval(timer)
            timers.delete(timer)
            finishFailure(
              info.error ?? (info.status === 'cancelled' ? '视频任务已取消' : '视频任务结果未知'),
              info.status === 'cancelled' ? 'cancelled' : 'failed'
            )
          }
        })
        .catch(() => {
          failures += 1
          if (failures >= 3) finishFailure('视频任务状态连续查询失败')
        })
        .finally(() => {
          polling = false
        })
    }, POLL_MS)
    timers.add(timer)
  }

  // 重新进入项目时仍处于 running/pending 的节点：有持久化 taskId 就接回原任务，
  // 没有（例如旧版本记录或非视频节点）才按旧逻辑标记中断。
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    const run = readNodeRunRecord(shape.meta?.nodeRun)
    const exec = shape.props.exec
    if (!isRunningStatus(exec) && run?.status !== 'running') continue
    const data = parseVideoGen(readNodeConfig(shape))
    if (data.taskId) {
      const startedRun: NodeRunRecord =
        run ??
        ({
          runId: `recovered-${String(shape.id).slice(-8)}`,
          status: 'running',
          startedAt: Date.now(),
          inputs: {}
        } satisfies NodeRunRecord)
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { exec: 'running' },
        meta: { ...(shape.meta ?? {}), nodeRun: JSON.parse(JSON.stringify(startedRun)) }
      })
      recoverOne(shape.id, data.taskId, startedRun)
    } else {
      commitRun(shape.id, run ?? {
        runId: `interrupted-${String(shape.id).slice(-8)}`,
        status: 'running',
        startedAt: Date.now(),
        inputs: {}
      }, 'cancelled', { reason: INTERRUPTED_REASON })
    }
  }

  void projectId

  return () => {
    stopped = true
    for (const timer of timers) window.clearInterval(timer)
    timers.clear()
  }
}
