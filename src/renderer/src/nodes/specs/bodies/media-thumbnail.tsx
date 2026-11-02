// 媒体首帧缩略图：渲染组件（抽帧逻辑在 media-thumbnail-core.ts，避免 react-refresh 失效）。
import { useVideoThumbnail } from './media-thumbnail-core'

/** 视频封面的 <img>；抽帧还没好时不渲染（外层保留深色占位）。 */
export function VideoThumb({
  path,
  className,
  alt = ''
}: {
  path: string
  className?: string
  alt?: string
}): React.JSX.Element | null {
  const thumb = useVideoThumbnail(path)
  if (!thumb) return null
  return <img className={className} src={thumb} alt={alt} draggable={false} />
}