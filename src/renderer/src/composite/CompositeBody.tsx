import type { NodeBodyProps } from '../nodes/registry'
import { readCompositeInstanceManifest } from '@shared/composite/outputs'

export function CompositeBody({ shape }: NodeBodyProps): React.JSX.Element {
  const manifest = readCompositeInstanceManifest(shape)
  if (!manifest) {
    return (
      <div className="composite-body">
        <p className="composite-body-empty">节点流版本缺失，请从节点流面板重新插入</p>
      </div>
    )
  }
  return (
    <div className="composite-body">
      <div className="composite-body-head">
        <span className="composite-body-name">{manifest.name}</span>
        <span className="composite-body-version">v{manifest.version}</span>
      </div>
      {manifest.description ? <p className="composite-body-desc">{manifest.description}</p> : null}
      <p className="composite-body-meta">
        {manifest.inputs.length} 个输入 · {manifest.outputs.length} 个输出 ·{' '}
        {manifest.graph.nodes.length} 个内部节点
      </p>
    </div>
  )
}
