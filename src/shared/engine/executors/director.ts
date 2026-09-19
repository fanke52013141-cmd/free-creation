// 3D 预演台是 manual-publish 节点：工作流不会替用户打开编辑器或擅自导出媒体。
// 最近一次明确发布的帧、视频与摄像机参数可作为可缓存的真实输出复用。
import {
  isDirectorPublishCurrent,
  parseDirectorProject,
  parseDirectorPublishRecord
} from '../../director-data'
import { inputPackets } from '../inputs'
import { readNodeConfig } from '../node-config'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

const DIRECTOR_INPUT_PORTS: ReadonlyArray<readonly [string, string]> = [
  ['in-storyboard', '分镜'],
  ['in-reference-images', '场景参考图'],
  ['in-camera-preset', '机位参数']
]

export const directorExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  let raw: unknown = null
  try {
    raw = ctx.shape.meta?.nodeResult ? JSON.parse(String(ctx.shape.meta.nodeResult)) : null
  } catch {
    // 损坏的旧运行记录应回到"未发布"，绝不能把未知数据发送给下游。
  }
  const project = parseDirectorProject(readNodeConfig(ctx.shape))
  const publish = parseDirectorPublishRecord(raw)
  if (isDirectorPublishCurrent(project, publish)) return { status: 'done' }
  // 三个输入端口只在用户点「同步连线输入」时被消费。连了分镜却没发布的用户看到一句
  // 「没有已发布画面」会读成「运行器读不到我的连线」，所以把连线状态说清楚。
  const wired = DIRECTOR_INPUT_PORTS.filter(([port]) => inputPackets(ctx.inputs, port).length > 0)
    .map(([, label]) => label)
    .join('、')
  return {
    status: 'skipped',
    reason:
      `3D 预演台${publish ? '上次发布之后工程又改过，发布内容与当前工程不一致' : '尚未发布过输出'}` +
      (wired
        ? `；已连接 ${wired}，连线不会自动变成镜头，请在预演台点「同步连线输入」后发布`
        : '；请打开预演台并发布')
  }
}
