// 节点 Body 聚合导出（路线图 R6：bodies.tsx 拆分）
//
// 各节点 Body 已拆分到 bodies/<name>.tsx，本文件统一 re-export，保持
// `specs/index.tsx` 中 `from './bodies'` 的导入路径不变。
// 行为与原超大 bodies.tsx 完全等价。
export { TextBody } from './text'
export { ImageBody } from './image'
export { ImageCropBody, ImageCropSettings } from './image-crop'
export { ImageSplitBody, ImageSplitSettings } from './image-split'
export { ImageGenerateBody } from './image-gen'
export { ImageEditBody, ImageEditSettings } from './image-edit'
export { VideoBody } from './video'
export {
  VideoAudioBody,
  VideoAudioSettings,
  VideoClipBody,
  VideoClipSettings,
  VideoFrameBody,
  VideoFrameSettings
} from './video-transforms'
export { VocalSeparateBody, VocalSeparateSettings } from './vocal-separate'
export { AudioBody } from './audio'
export { TtsBody } from './tts'
export { ChatBody } from './chat'
export { ScriptBody } from './script'
export { ProcessorBody } from './processor'
export { JsonBody } from './json'
export { StructuredBody } from './structured'
export { CodeBody } from './code'
export { StoryboardBody } from './storyboard'
export { AiProcessBody } from './aiProcess'
export { IterateBody } from './iterate'
export { DirectorBody } from './director'
