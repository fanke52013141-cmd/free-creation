import type { SVGProps } from 'react'

/**
 * 产品界面统一图标。节点和工具栏不使用 Emoji，避免不同系统字体造成尺寸、颜色和基线漂移。
 */
export type IconName =
  | 'text'
  | 'image'
  | 'crop'
  | 'image-split'
  | 'image-edit'
  | 'website'
  | 'split'
  | 'split-left'
  | 'split-right'
  | 'image-gen'
  | 'video'
  | 'video-asset'
  | 'timeline'
  | 'depth'
  | 'clay'
  | 'frame'
  | 'clip'
  | 'audio'
  | 'video-audio'
  | 'sound-adjust'
  | 'speech'
  | 'voice-clone'
  | 'voice-design'
  | 'vocal-separate'
  | 'mic'
  | 'chat'
  | 'script'
  | 'processor'
  | 'json'
  | 'structured'
  | 'code'
  | 'storyboard'
  | 'director'
  | 'upload'
  | 'assets'
  | 'workflow'
  | 'node-library'
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
  | 'align-left'
  | 'align-right'
  | 'align-horizontal'
  | 'align-vertical'
  | 'distribute-horizontal'
  | 'distribute-vertical'
  | 'group'
  | 'ungroup'
  | 'refresh'
  | 'undo'
  | 'redo'
  | 'close'
  | 'copy'
  | 'bring-front'
  | 'send-back'
  | 'play'
  | 'pause'
  | 'volume'
  | 'volume-off'
  | 'fullscreen'
  | 'fullscreen-exit'
  | 'send'
  | 'attach'
  | 'document'
  | 'warning'
  | 'help'
  | 'info'
  | 'add'
  | 'check'
  | 'grid'
  | 'iterate'
  | 'compare'
  | 'target'
  | 'spark'
  | 'agent'
  | 'ai-process'
  | 'ai-review'
  | 'state-machine'
  | 'more'
  | 'trash'
  | 'edit'
  | 'move'
  | 'arrow'
  | 'rectangle'
  | 'brush'
  | 'mask'
  | 'loader'
  | 'external'
  | 'download'
  | 'fold'
  | 'unfold'
  | 'layers'
  | 'magnet'
  | 'link'
  | 'link-off'
  | 'folder'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

const PATHS: Record<IconName, React.ReactNode> = {
  text: (
    <>
      <path d="M4 5h16M12 5v14" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </>
  ),
  // 宫格是拆分的识别轮廓；避免小尺寸下再叠山景，和单张图片明确区分。
  'image-split': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" strokeWidth="1.4" />
    </>
  ),
  // P图：相框 + 斜向画笔，区别于“生图”的图+星，也区别于动作铅笔 edit。
  'image-edit': (
    <>
      <rect x="3" y="4" width="13" height="13" rx="2" />
      <path d="m14.5 19.5 6-6-2-2-6 6-1 3 3-1Z" />
    </>
  ),
  // 2026-11-03 用户裁决：分割=左右方括号都实心（中间虚线是切点）；左分割=右括号虚线（删右侧）；
  // 右分割=左括号虚线（删左侧）。
  split: (
    <>
      <path d="M9 4H4v16h5" />
      <path d="M15 4h5v16h-5" />
      <path d="M12 4v16" strokeDasharray="2 2.6" />
    </>
  ),
  'split-left': (
    <>
      <path d="M9 4H4v16h5" />
      <path d="M15 4h5v16h-5" strokeDasharray="2 2.6" />
    </>
  ),
  'split-right': (
    <>
      <path d="M9 4H4v16h5" strokeDasharray="2 2.6" />
      <path d="M15 4h5v16h-5" />
    </>
  ),
  'image-gen': (
    <>
      <rect x="2.5" y="8" width="14" height="12" rx="2" />
      <circle cx="6.5" cy="11.5" r="1.2" />
      <path d="m4.5 18 3-3 2.5 2 2.5-2.5 4 3.5" />
      <path d="M20 2l.7 1.6 1.6.7-1.6.7L20 6.6 19.3 5l-1.6-.7 1.6-.7L20 2Z" strokeWidth="1.4" />
    </>
  ),
  // 网址节点：链接卡片（对象），不再用外链箭头（动作）。
  website: (
    <>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" />
      <line x1="2.5" y1="8" x2="21.5" y2="8" />
      <path d="M5.5 5.75h4" strokeWidth="1.5" />
      <circle cx="12" cy="14" r="4.2" />
      <ellipse cx="12" cy="14" rx="1.8" ry="4.2" />
      <line x1="7.8" y1="14" x2="16.2" y2="14" />
    </>
  ),
  // 2026-11-03 用户裁决：去掉下方箭头，视频框按高度撑满（18×17）+ 居中播放三角。
  video: (
    <>
      <rect x="2.5" y="8" width="14" height="12" rx="2" />
      <path d="m8 11 4.5 3L8 17z" />
      <path d="M20 2l.7 1.6 1.6.7-1.6.7L20 6.6 19.3 5l-1.6-.7 1.6-.7L20 2Z" strokeWidth="1.4" />
    </>
  ),
  // 2026-11-03 用户裁决：轨道线用铁轨表达——两条钢轨 + 枕木，不再画时间尺/播放头。
  timeline: (
    <>
      <path d="M7 3v18M17 3v18" />
      <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />
    </>
  ),
  'video-asset': (
    <>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" />
      <line x1="6.8" y1="3.5" x2="6.8" y2="20.5" />
      <circle cx="4.65" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4.65" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4.65" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
      <line x1="17.2" y1="3.5" x2="17.2" y2="20.5" />
      <circle cx="19.35" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="19.35" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="19.35" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
      <path d="M10.5 9.5l4 2.5-4 2.5z" />
    </>
  ),
  frame: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="1.5" />
      <path d="M12 3v18m-2-18h4" />
    </>
  ),
  // 视频截取：片段块 + 左右 [ ] 修剪把手，表达入点/出点，不再复用播放卡片。
  clip: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="1.5" />
      <path d="M7 3v18M17 3v18" strokeDasharray="2 2" />
      <path d="m10 10 4 2-4 2Z" strokeWidth="1.5" />
    </>
  ),
  // 深度视频：两帧沿 Z 轴错位叠放 + 向下的深度箭头，表达逐帧深度。
  depth: (
    <>
      <rect x="4" y="4" width="15" height="11" rx="2" />
      <rect x="7" y="7" width="15" height="11" rx="2" />
      <path d="M7.5 7.5 17 17" strokeDasharray="2 2" />
      <path d="M14.5 17H17v-2.5" />
    </>
  ),
  // 白模视频：立体方块 + 右面的播放三角，同时表达“3D 白模”和“视频”。
  clay: (
    <>
      <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z" />
      <path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" />
      <path d="m15 12.8 3.2 1.9-3.2 1.9v-3.8Z" />
    </>
  ),
  audio: (
    <>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </>
  ),
  'video-audio': (
    <>
      <path d="M3 9v6M6 7v10M9 9v6" />
      <path d="M11.5 4v16" />
      <path d="M14 9v6M17 7v10M20 9v6" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
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
  // 数据处理：0 → 1。
  processor: (
    <>
      <rect x="2" y="7" width="5" height="10" rx="2.5" />
      <path d="M9 12h5m-2-2 2 2-2 2M18 9l2-2v10M18 17h4" />
    </>
  ),
  json: (
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
      <path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1" />
    </>
  ),
  // 结构数据：大括号内是带缩进的字段树（父行 + 两条子行），和 json 的平铺字段区分。
  structured: (
    <>
      <path d="M6 3H3v18h3M18 3h3v18h-3" />
      <rect x="8" y="8" width="3" height="8" rx="1.5" />
      <path d="m14 10 2-2v8M14 16h4" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
    </>
  ),
  storyboard: (
    <>
      <rect x="3" y="9" width="18" height="11" rx="1.5" />
      <path d="M3 9V6l16-4 1 4L3 10M7 5l3 3M13 3.5l3 3" />
    </>
  ),
  // 3D 预演台：摄影机 + 透视地面网格 = 机位与空间，不再和深度视频共用菱形叠层。
  director: (
    <>
      <rect x="3.5" y="7" width="10" height="8" rx="2" />
      <path d="m13.5 9.5 5-2v7l-5-2" />
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
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h6a3 3 0 0 1 3 3v4m-3-3 3 3 3-3" />
    </>
  ),
  'node-library': (
    <>
      <rect x="3" y="8" width="14" height="13" rx="2" />
      <path d="M7 8V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2M7 12h6M7 16h4" />
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
    // 2026-10-31 用户裁决：原齿轮在小尺寸下发糊难看，改用「调节旋钮」造型（Lucide settings-2）
    <>
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
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
  // 2026-11-03 用户裁决：缩放按钮不用放大镜（太小太丑），改成干净的 − / +，16px 下清晰可辨。
  'zoom-in': <path d="M12 5v14M5 12h14" strokeWidth={2} />,
  'zoom-out': <path d="M5 12h14" strokeWidth={2} />,
  reset: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4h-4" />
    </>
  ),
  'align-left': (
    <>
      <path d="M4 6v12M8 7h10M8 12h7M8 17h9" />
    </>
  ),
  'align-right': (
    <>
      <path d="M20 6v12M16 7H6M16 12H9M16 17H7" />
    </>
  ),
  'align-horizontal': (
    <>
      <path d="M12 4v16M5 7h14M8 12h8M6 17h12" />
    </>
  ),
  'align-vertical': (
    <>
      <path d="M4 12h16M7 5v14M12 8v8M17 6v12" />
    </>
  ),
  'distribute-horizontal': (
    <>
      <rect x="3" y="7" width="4" height="10" rx="1" />
      <rect x="10" y="7" width="4" height="10" rx="1" />
      <rect x="17" y="7" width="4" height="10" rx="1" />
    </>
  ),
  'distribute-vertical': (
    <>
      <rect x="7" y="3" width="10" height="4" rx="1" />
      <rect x="7" y="10" width="10" height="4" rx="1" />
      <rect x="7" y="17" width="10" height="4" rx="1" />
    </>
  ),
  group: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="7" y="7" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </>
  ),
  ungroup: (
    <>
      <path d="M7 3H3v4M17 3h4v4M3 17v4h4M21 17v4h-4" strokeDasharray="2 2" />
      <rect x="6" y="6" width="5" height="5" rx="1" />
      <rect x="13" y="13" width="5" height="5" rx="1" />
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
  volume: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6a8 8 0 0 1 0 12" />
    </>
  ),
  'volume-off': (
    <>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="m17 9 5 6m0-6-5 6" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />
    </>
  ),
  'fullscreen-exit': (
    <>
      <path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" />
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
  check: (
    <>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
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
  compare: (
    <>
      <rect x="3" y="5" width="8" height="14" rx="1.5" />
      <rect x="13" y="5" width="8" height="14" rx="1.5" />
      <path d="M11 9h2M11 15h2" />
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
  move: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="m8.5 6.5 3.5-3.5 3.5 3.5M8.5 17.5 12 21l3.5-3.5M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 18 18 6" />
      <path d="M10 6h8v8" />
    </>
  ),
  rectangle: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <path d="M7 8h.01M17 16h.01" />
    </>
  ),
  brush: (
    <>
      <path d="m14.5 4.5 5 5-8.8 8.8-5.9 1.4 1.4-5.9 8.3-8.3Z" />
      <path d="m5.2 19.8 2.6-2.6M12.4 6.6l5 5" />
    </>
  ),
  mask: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 4v16M16 4v16M4 8h16M4 16h16" strokeDasharray="2 2" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  loader: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 5v5h-5" />
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
  ),
  fold: (
    <>
      <rect x="7.5" y="3.5" width="13" height="9" rx="2" />
      <rect x="3.5" y="10.5" width="13" height="9" rx="2" />
    </>
  ),
  unfold: (
    <>
      <rect x="2.5" y="5.5" width="8.5" height="13" rx="2" />
      <rect x="13" y="5.5" width="8.5" height="13" rx="2" />
    </>
  ),
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />,
  layers: (
    <>
      <path d="m12 2 10 5-10 5L2 7Z" />
      <path d="m2 12 10 5 10-5" />
      <path d="m2 17 10 5 10-5" />
    </>
  ),
  // 吸附（磁铁）：两条竖臂 + 两端磁极横线，13px 下也能读成「吸」。
  magnet: (
    <>
      <path d="M6 3v9a6 6 0 0 0 12 0V3" />
      <path d="M6 8.5h4" />
      <path d="M14 8.5h4" />
    </>
  ),
  // 吸附开：链接（链环相连）
  link: (
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  // 吸附关：断开链接（链环错开 + 斜杠）
  'link-off': (
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </>
  ),
  // ── 节点身份图标（2026-11-02 重绘，设计源：design/2026-11-node-identity/icons/icon-drafts.tsx）──
  // 声音调整：三根推子 + 三个错高的旋钮，表达音量/时长/速度各自可调
  'sound-adjust': (
    <>
      <path d="M6 5v14M12 5v14M18 5v14" />
      <rect x="3.5" y="6.8" width="5" height="2.4" rx="1.2" />
      <rect x="9.5" y="13.8" width="5" height="2.4" rx="1.2" />
      <rect x="15.5" y="9.8" width="5" height="2.4" rx="1.2" />
    </>
  ),
  // 语音合成：麦克风 + 两条发射弧；与录音控件 mic 的区别写进 UI_ICON_SYSTEM 语义字典
  // 语音合成：左侧文本行 → 变换箭头 → 右侧声波，表达“文字变成声音”。
  speech: (
    <>
      <path d="M3 11v4M6 8v10M9 6v14M12 8v10M15 11v4" />
      <path d="M20 2l.7 1.6 1.6.7-1.6.7L20 6.6 19.3 5l-1.6-.7 1.6-.7L20 2Z" strokeWidth="1.4" />
    </>
  ),
  // 语音克隆：两个并排人形轮廓 = 双胞胎，右侧三条声波柱 = 复刻后的声音
  'voice-clone': (
    <>
      <circle cx="6.8" cy="7.4" r="2.5" />
      <path d="M2.6 18.2c0-2.4 1.9-4.3 4.2-4.3s4.2 1.9 4.2 4.3" />
      <circle cx="12.6" cy="7.4" r="2.5" />
      <path d="M8.4 18.2c0-2.4 1.9-4.3 4.2-4.3s4.2 1.9 4.2 4.3" />
      <path d="M17.8 10.2v3.6M19.8 8.2v7.6M21.8 10.8v2.4" />
    </>
  ),
  // 音色设计：左下声纹扇形 + 右上四角星 = 从文字描述设计音色
  // 音色设计：声波 + 两条音色推子 + 小四角星，表达“把声音调成想要的样子”。
  'voice-design': (
    <>
      <path d="M3 9v6M6 7v10M9 9v6M12 7v10" />
      <path d="m15 19.5 6-6-2-2-6 6-1 3 3-1Z" />
      <path d="M20 2l.7 1.6 1.6.7-1.6.7L20 6.6 19.3 5l-1.6-.7 1.6-.7L20 2Z" strokeWidth="1.4" />
    </>
  ),
  // 人声分离（退役）：左侧短声波柱向右分叉为两支
  'vocal-separate': (
    <>
      <line x1="3" y1="11" x2="3" y2="13" />
      <line x1="5.5" y1="9" x2="5.5" y2="15" />
      <line x1="8" y1="6.5" x2="8" y2="17.5" />
      <line x1="10.5" y1="8" x2="10.5" y2="16" />
      <line x1="13.2" y1="3" x2="13.2" y2="21" strokeDasharray="2 2" strokeWidth="1.5" />
      <line x1="16.5" y1="9.5" x2="16.5" y2="14.5" strokeWidth="2" />
      <line x1="19" y1="5.5" x2="19" y2="18.5" strokeWidth="2.2" />
      <line x1="21.5" y1="8.5" x2="21.5" y2="15.5" strokeWidth="2" />
    </>
  ),
  // Agent：机器人头 + 天线 + 实心眼点 = 会执行任务的代理
  agent: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="4" />
      <path d="M12 7V5.4" />
      <circle cx="12" cy="4.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="12.5" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12.5" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  // AI 处理：魔杖 + 大小两颗四角星 = 对输入做一次模型处理
  'ai-process': (
    <>
      <path d="M4 20 13 10.5" />
      <path d="M17.4 4.4 18.14 6.06 19.8 6.8 18.14 7.54 17.4 9.2 16.66 7.54 15 6.8 16.66 6.06Z" />
      <path d="M19.2 11.9 19.66 12.94 20.7 13.4 19.66 13.86 19.2 14.9 18.74 13.86 17.7 13.4 18.74 12.94Z" />
    </>
  ),
  // AI 审核：盾牌 + 对勾 = 审过并背书，区别于动作语义的裸 check
  'ai-review': (
    <>
      <path d="M12 3 4 6v6.4c0 4.1 3.4 7.6 8 8.6c4.6-1 8-4.5 8-8.6V6L12 3Z" />
      <path d="M8.4 11.6 10.8 14 15.6 9.2" />
    </>
  ),
  // 状态机：两个状态圆 + 带箭头的迁移曲线 = 状态与迁移，不是矩形流程图
  'state-machine': (
    <>
      <circle cx="5" cy="12" r="3" />
      <circle cx="19" cy="6" r="3" />
      <circle cx="19" cy="18" r="3" />
      <path d="M8 11 15 7M8 13l7 4M12.5 6.7l2.5.3-.6 2.4M12.5 17.3l2.5-.3-.6-2.4" />
    </>
  ),
  // 循环：三条递减横线 + 回绕箭头
  iterate: (
    <>
      <path d="M12 4A8 8 0 0 1 18.8 8" />
      <polygon points="19.5,9.2 16.9,8.2 18.9,6.4" fill="currentColor" stroke="none" />
      <path d="M20 12A8 8 0 0 1 15.2 19.4" />
      <polygon points="13.9,20.2 16.2,17.7 16.6,20.1" fill="currentColor" stroke="none" />
      <path d="M8.8 19.8A8 8 0 0 1 4.4 6.2" />
      <polygon points="3.5,5.1 5.9,6.7 4.4,8.2" fill="currentColor" stroke="none" />
    </>
  ),}

/**
 * 供测试和节点规范校验使用的运行时图标清单。
 * `PATHS` 保持唯一真源，`Record<IconName, ...>` 会在编译期阻止遗漏条目。
 */
export const ICON_NAMES = Object.freeze(Object.keys(PATHS) as IconName[])

export function Icon({
  name,
  size = 18,
  strokeWidth,
  ...props
}: IconProps): React.JSX.Element {
  // 默认 1.8；I6 重绘后 voice-design 也使用统一描边，不再单独降到 1.65。
  const resolvedStroke = strokeWidth ?? 1.8
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={resolvedStroke}
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
