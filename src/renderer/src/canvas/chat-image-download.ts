import type { ChatImageAttachment } from '@shared/types'
import { toast } from '../stores/toast'

export async function downloadChatImage(
  projectId: string,
  image: ChatImageAttachment
): Promise<void> {
  try {
    const result = await window.api.batchExportMedia(projectId, [image.mediaId])
    if (!result.ok) return toast(`下载失败：${result.error.message}`)
    if (!result.data.targetDir) return
    toast(
      result.data.exported === 1 && result.data.failed === 0
        ? '图片已下载到所选目录'
        : '图片文件缺失或下载失败'
    )
  } catch {
    toast('图片下载失败，请检查目标目录')
  }
}
