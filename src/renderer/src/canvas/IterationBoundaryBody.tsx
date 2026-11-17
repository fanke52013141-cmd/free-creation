import type { NodeCardShape } from './NodeCardShape'

/**
 * 循环体边界标记（视觉接口）：框左侧「输入」/右侧「输出」。
 * 首节点接输入、末节点接输出，呈现完整循环体子图接口；底层执行仍走 loop→循环体路径。
 */
export function IterationBoundaryBody({ shape }: { shape: NodeCardShape }): React.JSX.Element {
  const meta = shape.meta as Record<string, unknown>
  const kind = meta.iterationBoundary === 'output' ? 'output' : 'input'
  return (
    <div className={`iteration-boundary is-${kind}`} data-node-interactive="text-content">
      <span className="iteration-boundary-dot" />
      <span className="iteration-boundary-label">{kind === 'output' ? '输出' : '输入'}</span>
    </div>
  )
}
