// 导演台是 manual-publish 节点：工作流不会替用户打开编辑器或擅自导出媒体。
// 最近一次明确发布的帧/视频/摄像机参数可作为可缓存的真实输出复用。
import {
  isDirectorPublishCurrent,
  parseDirectorProject,
  parseDirectorPublishRecord
} from '../../nodes/director-data'
import { readNodeConfig } from '../../canvas/node-persistence'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'

export const directorExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  let raw: unknown = null
  try {
    raw = ctx.shape.meta?.nodeResult ? JSON.parse(String(ctx.shape.meta.nodeResult)) : null
  } catch {
    // 损坏的旧运行记录应回到“未发布”，绝不能把未知数据发送给下游。
  }
  const project = parseDirectorProject(readNodeConfig(ctx.shape))
  return isDirectorPublishCurrent(project, parseDirectorPublishRecord(raw))
    ? { status: 'done' }
    : {
        status: 'skipped',
        reason: '导演台没有与当前工程一致的已发布画面；请打开导演台后重新发布'
      }
}
