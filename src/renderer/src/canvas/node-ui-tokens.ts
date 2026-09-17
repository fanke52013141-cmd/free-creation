// 节点 UI 契约 Token（呈现规范 v1.0 §22）：
// CSS、NodeCardView、Registry、NodeCardShape 与测试引用的唯一尺寸真值来源。
// 节点内禁止散落硬编码高度/宽度；Shell 契约全局统一，节点只能声明业务 Body。
export const NODE_UI = {
  width: 340,
  height: {
    /** H0 默认档：所有可创建节点的初始尺寸 */
    default: 260,
    /** H1 扩展档：增加引用区、结果工具栏或较多配置 */
    expanded: 320,
    /** H2 富内容档：引用 + 结果 + 操作同时存在 */
    rich: 380,
    /** H3 自动上限：多媒体集合等密集内容；超过后内容内部滚动 */
    autoMax: 440,
    /** 用户手动拖拽放大的推荐上限（不强制裁切） */
    manualMax: 720,
    /** 历史兼容保护值：仅用于旧项目异常尺寸迁移判断，不属于 UI 规范 */
    legacyGuard: 1200
  },
  header: { height: 28 },
  radius: 12,
  accent: { height: 4 },
  reference: {
    /** 引用区最多展示行数，超出折叠为 +N */
    maxRows: 2,
    /** 图片引用缩略图尺寸（呈现规范 §11） */
    imageWidth: 48,
    imageHeight: 36
  },
  actionBar: {
    height: 40,
    maxVisibleActions: 3
  }
} as const

/** 内容所需高度 → 就近固定档位（呈现规范 v1.0 §3.4）。
 *  只允许 260 → 320 → 380 → 440 跳档，禁止内容驱动的连续高度。
 *  超过 autoMax 的内容由调用方（node-body）内部滚动承载。 */
export function resolveNodeHeight(required: number): number {
  if (required <= NODE_UI.height.default) return NODE_UI.height.default
  if (required <= NODE_UI.height.expanded) return NODE_UI.height.expanded
  if (required <= NODE_UI.height.rich) return NODE_UI.height.rich
  return NODE_UI.height.autoMax
}
