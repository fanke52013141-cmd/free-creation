import type { NodeCardShape } from './NodeCardShape'
import { readIterationSnapshot } from './iteration-lanes'

/**
 * 循环分支的只读运行快照正文：以产出节点身份呈现该轮结果（提示词/提交摘要），
 * 不可编辑、不可执行；超高内容内部滚动（滚动条按全局规范隐藏）。
 */
export function IterationSnapshotBody({
  shape
}: {
  shape: NodeCardShape
}): React.JSX.Element | null {
  const snapshot = readIterationSnapshot(shape)
  if (!snapshot) return null
  return (
    <div className="node-text iteration-snapshot-body" data-node-interactive="text-content">
      <span className="iteration-snapshot-badge">
        {snapshot.role === 'ai-process' ? 'AI 处理运行快照' : '生图运行快照'} · 镜头{' '}
        {snapshot.index + 1}
      </span>
      <span className="node-text-body">{shape.props.text}</span>
    </div>
  )
}
