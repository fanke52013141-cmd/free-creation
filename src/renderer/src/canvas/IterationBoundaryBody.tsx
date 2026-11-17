import type { NodeCardShape } from './NodeCardShape'

/**
 * 循环体边界圆点（视觉接口）：贴在容器框左/右边垂直中心的输入/输出端口圆点，无文案。
 * 首节点接输入、末节点接输出；底层执行仍走 loop→循环体路径。
 */
export function IterationBoundaryBody({ shape }: { shape: NodeCardShape }): React.JSX.Element {
  const meta = shape.meta as Record<string, unknown>
  const kind = meta.iterationBoundary === 'output' ? 'output' : 'input'
  return (
    <div
      className={`iteration-boundary-dot-only is-${kind}`}
      data-node-interactive="text-content"
    />
  )
}
