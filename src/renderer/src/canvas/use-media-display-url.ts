import { useEditor, useValue } from 'tldraw'
import { mediaThumbUrl, mediaUrl } from '../nodes/registry'
import { canvasPerfPolicy } from './canvas-performance-tier'

/**
 * 大画布图片自适应显示地址（WP-10）：
 * - 小画布（mediaNodeCount <= 15）：始终返回原始无损 mediaUrl()，0 体验削减；
 * - 多图画布（>15 进入 / <10 退出）：使用 2x Retina 缩略图（680px 卡片 / 128px 引用条），显存降低 80%+；
 * - 缩放 > 1.5x 时自动切换回无损原图，放大审图清晰度不打折。
 * 注意：大图预览弹窗（openPreview）与执行器始终直接使用 mediaUrl() 原图。
 */
export function useMediaDisplayUrl(
  relPath: string | null | undefined,
  width: 128 | 680 | 1024 = 680
): string {
  const editor = useEditor()
  const useThumb = useValue(
    'media display thumb mode',
    () => canvasPerfPolicy(editor).useMediaThumbnails && editor.getCamera().z <= 1.5,
    [editor]
  )
  if (!relPath) return ''
  return useThumb ? mediaThumbUrl(relPath, width) : mediaUrl(relPath)
}
