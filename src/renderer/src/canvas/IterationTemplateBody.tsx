import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { toggleIterationTemplate } from './iteration-lanes'
import { Icon } from '../components/Icon'

/**
 * 循环体模板卡正文（本体模具）：折叠态紧凑配方占位，不填充运行内容。
 * 点「展开」或双击恢复真实循环体定义节点可见供编辑，点「收起」重新折叠。
 */
export function IterationTemplateBody({ shape }: { shape: NodeCardShape }): React.JSX.Element {
  const editor = useEditor()
  const meta = shape.meta as Record<string, unknown>
  const recipe =
    typeof meta.iterationTemplateRecipe === 'string'
      ? meta.iterationTemplateRecipe
      : 'AI处理 → 生图'
  const expanded = Boolean(meta.iterationTemplateExpanded)
  return (
    <div className="iteration-template-body" data-node-interactive="text-content">
      <div className="iteration-template-head">
        <span className="iteration-template-title">循环体 · 模板</span>
        <span className="iteration-template-badge">本体</span>
        <button
          type="button"
          className="iteration-template-toggle"
          title={expanded ? '收起循环体' : '展开循环体以修改配置'}
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            e.stopPropagation()
            toggleIterationTemplate(editor, shape)
          }}
        >
          <Icon name={expanded ? 'fold' : 'unfold'} size={13} />
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {expanded ? null : (
        <>
          <div className="iteration-template-recipe">{recipe}</div>
          <div className="iteration-template-hint">空占位 · 点展开或双击修改</div>
          <div className="iteration-template-hint">不填充运行内容</div>
        </>
      )}
    </div>
  )
}
