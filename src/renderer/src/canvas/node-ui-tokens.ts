// 节点 UI 契约 Token（呈现规范 v1.0 §22）：
// CSS、NodeCardView、Registry、NodeCardShape 与测试引用的唯一尺寸真值来源。
// 节点内禁止散落硬编码高度/宽度；Shell 契约全局统一，节点只能声明业务 Body。
// 2026-11-02 用户裁决：分镜板默认尺寸与其他节点一致（340×260），宽高随内容自适应增长，无上限。
export const STORYBOARD_UI = {
  width: 340,
  height: 260,
  columnWidth: 220,
  tableChromeWidth: 224
} as const

export const NODE_UI = {
  width: 340,
  height: {
    min: 260,
    /** H0 默认档：所有可创建节点的初始尺寸 */
    default: 260,
    /** H1 扩展档：增加引用区、结果工具栏或较多配置 */
    expanded: 320,
    /** H2 富内容档：引用 + 结果 + 操作同时存在 */
    rich: 380,
    /** H3 自动上限：多媒体集合等密集内容；超过后内容内部滚动 */
    autoMax: 440,
    /** 视频生成节点上限：引用缩略图 + 三段配置 + 主操作，引用多图时不得裁掉输出参数 */
    autoMaxVideoGen: 560,
    /** v1.2：手动与自动高度共用上限 */
    manualMax: 440,
    /** 历史兼容保护值：仅用于旧项目异常尺寸迁移判断，不属于 UI 规范 */
    legacyGuard: 1200
  },
  header: { height: 28 },
  radius: 12,
  identity: {
    /** 空态居中大图标尺寸（2026-11-02 裁决：无框、不重复节点名称；
     *  同日裁决：放大两倍后按 96px 的 75% 回调至 72px，并正居中于节点卡片中心） */
    iconSize: 72,
    minHeight: 178
  },
  description: { height: 36, maxLines: 2 },
  content: { padding: 12 },
  primaryButton: { height: 32, radius: 8 },
  accent: { height: 4 },
  reference: {
    /** 引用区最多展示行数，超出折叠为 +N */
    maxRows: 1,
    height: 36,
    gap: 6,
    bottomGap: 8,
    textMinWidth: 80,
    textMaxWidth: 200,
    moreMinWidth: 36,
    /** 图片引用缩略图尺寸（呈现规范 §11） */
    imageWidth: 48,
    imageHeight: 36
  },
  actionBar: {
    height: 48,
    /** 主操作按钮与节点卡片底边的统一留白 */
    bottomInset: 8,
    maxVisibleActions: 3
  },
  textEditor: {
    /** 文本节点编辑态 textarea 的名义高度：flex 填满正文剩余空间，
     *  填充高度不反算为内容需求（呈现规范 §19），自动高度按此名义值测算 */
    naturalHeight: 160
  }
} as const

/** 内容所需高度 → 就近固定档位（呈现规范 v1.0 §3.4）。
 *  只允许 260 → 320 → 380 → 440（→ 视频生成节点 560）跳档，禁止内容驱动的连续高度。
 *  超过档位的内容由调用方（node-body）内部滚动承载。 */
export function resolveNodeHeight(
  required: number,
  cap: number = NODE_UI.height.autoMax
): number {
  if (required <= NODE_UI.height.default) return NODE_UI.height.default
  if (required <= NODE_UI.height.expanded) return NODE_UI.height.expanded
  if (required <= NODE_UI.height.rich) return NODE_UI.height.rich
  if (required <= NODE_UI.height.autoMax) return NODE_UI.height.autoMax
  if (cap > NODE_UI.height.autoMax && required <= cap) return cap
  return NODE_UI.height.autoMax
}
