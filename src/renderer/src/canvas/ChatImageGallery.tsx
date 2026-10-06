import { useState } from 'react'
import type { ChatImageAttachment } from '@shared/types'
import { mediaUrl } from '../nodes/registry'
import { Icon } from '../components/Icon'
import { downloadChatImage } from './chat-image-download'

export function ChatImageGallery({
  images,
  projectId,
  onPreview
}: {
  images: ChatImageAttachment[]
  projectId: string
  onPreview: (image: ChatImageAttachment) => void
}): React.JSX.Element {
  const [downloading, setDownloading] = useState('')
  const [failed, setFailed] = useState<string[]>([])
  return (
    <div className="chat-dialog-image-gallery" aria-label="生成的图片">
      {images.map((image) => (
        <figure className="chat-dialog-image" key={image.mediaId}>
          {failed.includes(image.mediaId) ? (
            <p role="alert">图片文件缺失或无法读取</p>
          ) : (
            <button
              type="button"
              className="chat-dialog-image-open"
              aria-label={`预览图片 ${image.name}`}
              onClick={() => onPreview(image)}
            >
              <img
                src={mediaUrl(image.mediaPath)}
                alt={image.name}
                loading="lazy"
                onError={() => setFailed((current) => [...current, image.mediaId])}
              />
            </button>
          )}
          <figcaption>
            <span title={image.name}>{image.name}</span>
            <div>
              <button
                type="button"
                aria-label={`放大图片 ${image.name}`}
                disabled={failed.includes(image.mediaId)}
                onClick={() => onPreview(image)}
              >
                <Icon name="search" size={14} />
                预览
              </button>
              <button
                type="button"
                aria-label={`下载图片 ${image.name}`}
                disabled={Boolean(downloading)}
                onClick={() => {
                  setDownloading(image.mediaId)
                  void downloadChatImage(projectId, image).finally(() => setDownloading(''))
                }}
              >
                <Icon name="download" size={14} />
                {downloading === image.mediaId ? '下载中' : '下载'}
              </button>
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
