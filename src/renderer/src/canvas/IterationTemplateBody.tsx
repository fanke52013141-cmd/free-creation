import type { NodeCardShape } from './NodeCardShape'

/**
 * 循环体模板卡正文（本体模具）：紧凑配方占位，不填充运行内容。
 * 双击展开真实循环体定义节点进行配置；运行内容承载在分支实例上。
 */
export function IterationTemplateBody({
  shape
}: {
  shape: NodeCardShape
}): React.JSX.Element {
  const meta = shape.meta as Record<string, unknown>
  const recipe = typeof meta.iterationTemplateRecipe === 'string' ? meta.iterationTemplateRecipe : 'AI处理 → 生图'
  return (
    <div className="iteration-template-body" data-node-interactive="text-content">
      <div className="iteration-template-head">
        <span className="iteration-template-title">循环体 · 模板</span>
        <span className="iteration-template-badge">本体</span>
      </div>
      <div className="iteration-template-recipe">{recipe}</div>
      <div className="iteration-template-hint">空占位 · 双击配置</div>
      <div className="iteration-template-hint">不填充运行内容</div>
    </div>
  )
}