import type { LibraryValueType } from '@shared/library/types'

/** 统一的资源组件类型显示名，避免在界面里直接出现 text / image 这类内部值。 */
export const LIBRARY_VALUE_TYPE_LABELS: Record<LibraryValueType, string> = {
  text: '文本',
  markdown: 'Markdown',
  json: '结构',
  recipe: '提示词配方',
  image: '图片',
  audio: '音频',
  video: '视频',
  file: '文件'
}

export function libraryValueTypeLabel(valueType: LibraryValueType): string {
  return LIBRARY_VALUE_TYPE_LABELS[valueType] ?? valueType
}

/** 版本号显示统一为 1.0 / 2.0 这种形式（用户裁决：不要 v1）。 */
export function libraryVersionLabel(revisionNumber: number): string {
  return `${revisionNumber}.0`
}
