// 连线载体箭头（tldraw arrow）的指示行为覆盖。
//
// 问题：框选/多选节点时，被一并选中的箭头会沿箭头路径描出一条实线，
// 与 DataEdgeLayer 的虚线业务线叠加成“一虚一实”两条线。
//
// 根因：tldraw 4.5 起内置箭头的选中指示不再走 SVG 指示层
// （ArrowShapeUtil.useLegacyIndicator() 返回 false），而是通过
// getIndicatorPath() 交由 CanvasShapeIndicators 直接描在
// <canvas class="tl-canvas-indicators"> 上——此前针对
// `svg .tl-shape-indicator` 的 CSS 隐藏（app.css）管不到 canvas 绘制。
//
// 本应用里 tldraw arrow 仅作为端口 binding / 持久化载体，业务线由
// DataEdgeLayer 统一绘制（虚线），箭头本体与它的选中指示都不应该可见。
// 因此在 CanvasEditor 用本类替换内置 ArrowShapeUtil（tldraw 按同名 type 替换）：
//  - getIndicatorPath 恒返回 undefined → canvas 指示层对箭头不再描线（根修）；
//  - useLegacyIndicator 返回 true → 退回 SVG 指示层，而 app.css 已将其整体
//    display:none，行为与节点卡片一致（无指示线）。
import { ArrowShapeUtil } from 'tldraw'

export class CarrierArrowUtil extends ArrowShapeUtil {
  static override type = 'arrow' as const

  override useLegacyIndicator(): boolean {
    return true
  }

  override getIndicatorPath():
    | {
        additionalPaths: Path2D[]
        clipPath: Path2D
        path: Path2D
      }
    | Path2D
    | undefined {
    return undefined
  }
}
