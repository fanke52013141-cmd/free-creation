import { Icon, type IconName } from '../components/Icon'
import { mediaUrl } from '../nodes/registry'
import './library.css'

export function LibraryCardCover({
  icon,
  path,
  compact = false
}: {
  icon: IconName
  path?: string
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={compact ? 'asset-thumb library-card-cover-compact' : 'library-resource-cover'}>
      {icon === 'video' && path ? (
        <>
          <video src={`${mediaUrl(path)}#t=0.001`} preload="metadata" muted playsInline aria-hidden="true" />
          <span className="asset-play-badge" aria-hidden="true"><Icon name="play" size={13} /></span>
        </>
      ) : icon === 'image' && path ? (
        <img src={mediaUrl(path)} alt="" loading="lazy" />
      ) : (
        <span className="library-default-cover" data-icon-kind={icon} aria-hidden="true">
          <Icon name={icon} size={compact ? 48 : 64} />
        </span>
      )}
    </div>
  )
}
