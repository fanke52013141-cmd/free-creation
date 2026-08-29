import type { SVGProps } from 'react'

/**
 * 产品界面统一图标。节点和工具栏不使用 Emoji，避免不同系统字体造成尺寸、颜色和基线漂移。
 */
export type IconName =
  | 'text'
  | 'image'
  | 'crop'
  | 'image-gen'
  | 'video'
  | 'frame'
  | 'clip'
  | 'audio'
  | 'chat'
  | 'script'
  | 'processor'
  | 'json'
  | 'code'
  | 'storyboard'
  | 'director'
  | 'upload'
  | 'assets'
  | 'workflow'
  | 'history'
  | 'theme'
  | 'search'
  | 'settings'
  | 'home'
  | 'minimap'
  | 'fit'
  | 'zoom-in'
  | 'zoom-out'
  | 'reset'
  | 'undo'
  | 'redo'
  | 'close'
  | 'copy'
  | 'bring-front'
  | 'send-back'
  | 'play'
  | 'pause'
  | 'send'
  | 'attach'
  | 'document'
  | 'warning'
  | 'help'
  | 'info'
  | 'add'
  | 'grid'
  | 'target'
  | 'spark'
  | 'more'
  | 'trash'
  | 'edit'
  | 'external'
  | 'download'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

const PATHS: Record<IconName, React.ReactNode> = {
  text: (
    <>
      <path d="M5 6h14M5 12h14M5 18h10" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m4.5 17 4.5-4 3 2.5 2.5-2 5.5 4.5" />
    </>
  ),
  crop: (
    <>
      <path d="M7 3v14a4 4 0 0 0 4 4h10" />
      <path d="M3 7h14a4 4 0 0 1 4 4v10" />
      <path d="M17 3v4M3 17h4" />
    </>
  ),
  'image-gen': (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m4.5 17 4.5-4 3 2.5 2.5-2 5.5 4.5" />
      <path d="m18 3 .7 2.3L21 6l-2.3.7L18 9l-.7-2.3L15 6l2.3-.7L18 3Z" />
    </>
  ),
  video: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="m10 8 5 4-5 4V8Z" />
    </>
  ),
  frame: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M8 4v16M16 4v16M3.5 9h17M3.5 15h17" />
    </>
  ),
  clip: (
    <>
      <path d="M6 4v16M18 4v16" />
      <path d="M9 8h6M9 16h6" />
      <path d="m12 7-2 2 2 2M12 13l2 2-2 2" />
    </>
  ),
  audio: (
    <>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
      <path d="m16 12 3-2v4l-3-2Z" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 12.5v-7Z" />
      <path d="M8 8h8M8 11h5" />
    </>
  ),
  script: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 7h8M8 11h5M8 15h8M8 18h4" />
      <path d="m15 13 3 3-3 3" />
    </>
  ),
  processor: (
    <>
      <path d="M4 7h10M10 4l4 3-4 3" />
      <path d="M20 17H10M14 14l-4 3 4 3" />
      <circle cx="6" cy="17" r="2" />
      <circle cx="18" cy="7" r="2" />
    </>
  ),
  json: (
    <>
      <path d="M8 4c-2 0-2 2-2 4v1c0 1-.5 2-2 2 1.5 0 2 1 2 2v1c0 2 0 4 2 4M16 4c2 0 2 2 2 4v1c0 1 .5 2 2 2-1.5 0-2 1-2 2v1c0 2 0 4-2 4" />
      <path d="M10 8h4M10 12h4M10 16h4" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
    </>
  ),
  storyboard: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M8 4v16M8 9h12M8 15h12" />
      <path d="M5.5 6.5h.01M5.5 12h.01M5.5 17.5h.01" />
    </>
  ),
  director: (
    <>
      <rect x="3.5" y="6" width="13" height="12" rx="2" />
      <path d="m16.5 10 4-2v8l-4-2" />
      <circle cx="8" cy="12" r="2" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M8 8l4-4 4 4" />
      <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </>
  ),
  assets: (
    <>
      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="M4.5 7.5 12 12l7.5-4.5M12 12v9" />
    </>
  ),
  workflow: (
    <>
      <rect x="9" y="3.5" width="6" height="5" rx="1.2" />
      <rect x="3.5" y="15.5" width="6" height="5" rx="1.2" />
      <rect x="14.5" y="15.5" width="6" height="5" rx="1.2" />
      <path d="M12 8.5v3M12 11.5H6.5v4M12 11.5h5.5v4" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7" />
      <path d="M4 4v4.7h4.7M12 7v5l3 2" />
    </>
  ),
  theme: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.04.04-2.2 2.2-.04-.04a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V20.4h-3.1v-.11a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.04.04-2.2-2.2.04-.04A1.7 1.7 0 0 0 6.8 15 1.7 1.7 0 0 0 5.24 14H5.1v-3.1h.14A1.7 1.7 0 0 0 6.8 9.87a1.7 1.7 0 0 0-.34-1.87l-.04-.04 2.2-2.2.04.04a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1.03-1.56V4.4h3.1v.18a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.04-.04 2.2 2.2-.04.04A1.7 1.7 0 0 0 19.4 9.9a1.7 1.7 0 0 0 1.5 1h.1V14h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-7 9 7M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9M9 20v-6h6v6" />
    </>
  ),
  minimap: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 8h.01M7 12h.01M7 16h.01M11 8h6M11 12h4M11 16h6" />
    </>
  ),
  fit: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  'zoom-in': (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M10.5 7.5v6M7.5 10.5h6M16 16l4.5 4.5" />
    </>
  ),
  'zoom-out': (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M7.5 10.5h6M16 16l4.5 4.5" />
    </>
  ),
  reset: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  undo: (
    <>
      <path d="m9 7-5 5 5 5M4 12h10a6 6 0 0 1 6 6" />
    </>
  ),
  redo: (
    <>
      <path d="m15 7 5 5-5 5M20 12H10a6 6 0 0 0-6 6" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  'bring-front': (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M12 16V8M8.5 11.5 12 8l3.5 3.5" />
    </>
  ),
  'send-back': (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M12 8v8M8.5 12.5 12 16l3.5-3.5" />
    </>
  ),
  play: (
    <>
      <path d="m9 6 9 6-9 6V6Z" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  send: (
    <>
      <path d="m4 4 17 8-17 8 3-8-3-8Z" />
      <path d="M7 12h14" />
    </>
  ),
  attach: (
    <>
      <path d="m8 12 6.5-6.5a3 3 0 0 1 4.2 4.2L10 18.4a4.5 4.5 0 0 1-6.4-6.4L11 4.6" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5M8 12h8M8 16h6" />
    </>
  ),
  warning: (
    <>
      <path d="m12 3 9 17H3L12 3Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-.9.8-1.7 1.2-1.7 2.7M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  add: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 1.3 5.7L19 10l-5.7 1.3L12 17l-1.3-5.7L5 10l5.7-1.3L12 3ZM19 16l.6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7v13h10V7M10 11v5M14 11v5" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16.5-.7 3.7 3.7-.7L18.7 7.8a2.1 2.1 0 0 0-3-3L4 16.5Z" />
      <path d="m14.5 6.5 3 3" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 19h14" />
    </>
  )
}

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  ...props
}: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {PATHS[name] ?? PATHS.help}
    </svg>
  )
}
