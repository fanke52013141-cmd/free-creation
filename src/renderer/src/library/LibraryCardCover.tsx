import { Icon, type IconName } from '../components/Icon'
import './library.css'

export function LibraryCardCover({
  icon,
  compact = false
}: {
  icon: IconName
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={compact ? 'asset-thumb library-card-cover-compact' : 'library-resource-cover'}>
      <span className="library-default-cover" data-icon-kind={icon} aria-hidden="true">
        <Icon name={icon} size={compact ? 24 : 32} />
      </span>
    </div>
  )
}
