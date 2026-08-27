// 节点悬浮工具栏的工具定义与自定义配置（借鉴 infinite-atelier canvas-image-toolbar-tools.ts）。
// 工具只声明元数据，执行动作由 NodeHoverToolbar 注入，保持定义集中、逻辑外置。

export const TOOLBAR_CONFIG_STORAGE_KEY = 'canvas-node-toolbar-tools-v1'

export type NodeToolbarToolId =
  'view' | 'copyPrompt' | 'crop' | 'split' | 'upscale' | 'replace' | 'reveal'

export interface ToolbarToolMeta {
  id: NodeToolbarToolId
  label: string
  title: string
  icon: string
  /** 默认显示；关闭后仍可在设置弹窗中重新开启 */
  defaultVisible: boolean
}

export const TOOLBAR_TOOLS: ToolbarToolMeta[] = [
  { id: 'view', label: '查看', title: '查看大图', icon: 'image', defaultVisible: true },
  { id: 'copyPrompt', label: '提示词', title: '复制提示词', icon: 'copy', defaultVisible: true },
  {
    id: 'crop',
    label: '裁剪',
    title: '裁剪图片，结果生成新图片节点',
    icon: 'crop',
    defaultVisible: true
  },
  {
    id: 'split',
    label: '拆分',
    title: '按行列拆分为多张图片节点',
    icon: 'grid',
    defaultVisible: true
  },
  {
    id: 'upscale',
    label: '放大',
    title: '放大图片（最长边 4096），结果生成新图片节点',
    icon: 'zoom-in',
    defaultVisible: true
  },
  {
    id: 'replace',
    label: '替换',
    title: '上传本地图片替换当前节点媒体',
    icon: 'upload',
    defaultVisible: false
  },
  {
    id: 'reveal',
    label: '定位',
    title: '在资源管理器中定位文件',
    icon: 'target',
    defaultVisible: false
  }
]

export const DEFAULT_TOOL_IDS: NodeToolbarToolId[] = TOOLBAR_TOOLS.filter(
  (tool) => tool.defaultVisible
).map((tool) => tool.id)

export interface ToolbarConfig {
  ids: NodeToolbarToolId[]
  showLabels: boolean
}

export function readToolbarConfig(): ToolbarConfig {
  try {
    const stored = window.localStorage.getItem(TOOLBAR_CONFIG_STORAGE_KEY)
    if (!stored) return { ids: DEFAULT_TOOL_IDS, showLabels: false }
    const parsed = JSON.parse(stored) as Partial<ToolbarConfig>
    const valid = new Set(TOOLBAR_TOOLS.map((tool) => tool.id))
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is NodeToolbarToolId => valid.has(id as NodeToolbarToolId))
      : [...DEFAULT_TOOL_IDS]
    return {
      ids: ids.length > 0 ? ids : [...DEFAULT_TOOL_IDS],
      showLabels: parsed.showLabels === true
    }
  } catch {
    return { ids: DEFAULT_TOOL_IDS, showLabels: false }
  }
}

export function writeToolbarConfig(config: ToolbarConfig): void {
  window.localStorage.setItem(TOOLBAR_CONFIG_STORAGE_KEY, JSON.stringify(config))
}
