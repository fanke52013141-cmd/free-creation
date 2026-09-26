// 节点 Spec 注册（见《技术框架与规范》§5.1）
// 端口声明对齐路线图的节点类型表；any 万能口，其余类型需一致才可连
import type { PortCardinality, PortDecl, PortSchemaRef } from '@shared/types'
import { registerNodeType, unregisterNodeType } from '../registry'
import { readNodeConfig } from '../../canvas/node-persistence'
import {
  parseSpeechConfig,
  VOLC_REFERENCE_AUDIO_MAX_BYTES,
  VOLC_REFERENCE_AUDIO_MAX_COUNT,
  VOLC_REFERENCE_AUDIO_MAX_SECONDS,
  type SpeechBackend
} from '@shared/speech'
import {
  AudioBody,
  AiProcessBody,
  ChatBody,
  CodeBody,
  DirectorBody,
  ImageBody,
  ImageCropBody,
  ImageCropSettings,
  ImageSplitBody,
  ImageSplitSettings,
  ImageEditBody,
  ImageEditSettings,
  ImageGenerateBody,
  FileBody,
  IterateBody,
  JsonBody,
  ProcessorBody,
  ScriptBody,
  StoryboardBody,
  StructuredBody,
  TextBody,
  TtsBody,
  SpeechBody,
  SpeechSettings,
  VoiceDesignBody,
  VideoBody,
  VideoAudioBody,
  VideoAudioSettings,
  VideoClipBody,
  VideoClipSettings,
  VideoFrameBody,
  VideoFrameSettings,
  VideoAiBody,
  VideoAiSettings,
  VocalSeparateBody,
  VocalSeparateSettings
} from './bodies'
import { AiProcessSettings } from './bodies/aiProcess'
import { ChatSettings } from './bodies/chat'
import { aiProcessExecutor } from '../../engine/executors/aiProcess'
import { speechExecutor } from '../../engine/executors/speech'
import { voiceDesignExecutor } from '../../engine/executors/voiceDesign'
import { ttsExecutor } from '../../engine/executors/tts'
import { chatExecutor } from '../../engine/executors/chat'
import {
  codeExecutor,
  codePortConfigErrors,
  codeParamPortId,
  mapVarTypeToPortType,
  outputFieldPortId,
  parseCodeConfigs
} from '../../engine/executors/code'
import { imageGenExecutor } from '../../engine/executors/imageGen'
import { imageExecutor } from '../../engine/executors/image'
import { imageCropExecutor } from '../../engine/executors/imageCrop'
import { imageSplitExecutor } from '../../engine/executors/imageSplit'
import { imageEditExecutor } from '../../engine/executors/imageEdit'
import { iterateExecutor } from '../../engine/executors/iterate'
import { jsonExecutor } from '../../engine/executors/json'
import { structuredExecutor } from '../../engine/executors/structured'
import { processorExecutor } from '../../engine/executors/processor'
import { scriptExecutor } from '../../engine/executors/script'
import { storyboardExecutor } from '../../engine/executors/storyboard'
import { textExecutor } from '../../engine/executors/text'
import { videoExecutor } from '../../engine/executors/video'
import {
  videoAudioExecutor,
  videoClipExecutor,
  videoFrameExecutor
} from '../../engine/executors/videoTransforms'
import { videoDepthExecutor, videoClayExecutor } from '../../engine/executors/videoAi'
import { vocalSeparateExecutor } from '../../engine/executors/vocalSeparate'
import { directorExecutor } from '../../engine/executors/director'
import {
  projectAiProcessOutputs,
  projectAudioOutputs,
  projectChatOutputs,
  projectCodeOutputs,
  projectDirectorOutputs,
  projectFileOutputs,
  projectImageGenOutputs,
  projectImageCropOutputs,
  projectImageSplitOutputs,
  projectImageEditOutputs,
  projectImageOutputs,
  projectIterateOutputs,
  projectJsonOutputs,
  projectProcessorOutputs,
  projectScriptOutputs,
  projectStoryboardOutputs,
  projectStructuredOutputs,
  projectTextOutputs,
  projectTtsOutputs,
  projectSpeechOutputs,
  projectVoiceDesignOutputs,
  projectVideoOutputs,
  projectVideoAssetOutputs,
  projectVideoAudioOutputs,
  projectVideoClipOutputs,
  projectVideoFrameOutputs,
  projectVideoAiOutputs,
  projectVocalSeparateOutputs
} from './outputProjections'
import { parseStructuredDataConfig } from '../structured-data'

interface PortOptions {
  required?: boolean
  cardinality?: PortCardinality
  schema?: PortSchemaRef
}

const input = (
  id: string,
  name: string,
  type: PortDecl['type'],
  description: string,
  options: PortOptions = {}
): PortDecl => ({
  id,
  name,
  dir: 'in',
  type,
  description,
  required: options.required ?? false,
  cardinality: options.cardinality ?? 'one',
  schema: options.schema
})

const output = (
  id: string,
  name: string,
  type: PortDecl['type'],
  description: string,
  options: PortOptions = {}
): PortDecl => ({
  id,
  name,
  dir: 'out',
  type,
  description,
  required: options.required ?? true,
  cardinality: options.cardinality ?? 'one',
  schema: options.schema
})

const JSON_ANY: PortSchemaRef = { id: 'json.any', version: 1 }
const STORYBOARD_SHOTS: PortSchemaRef = { id: 'storyboard.shots', version: 1 }
const LIST_ITEMS: PortSchemaRef = { id: 'list.items', version: 1 }
const PROMPT_BUNDLE: PortSchemaRef = { id: 'prompt.bundle', version: 1 }
const PREVIS_CAMERA: PortSchemaRef = { id: 'previs.camera', version: 1 }
const PREVIS_PROJECT: PortSchemaRef = { id: 'previs.project', version: 2 }
/** 音色档案：音色设计/复刻 → 语音合成节点 in-voice 的稳定结构。 */
const VOICE_PROFILE: PortSchemaRef = { id: 'voice.profile', version: 1 }
/** 字幕时间轴：火山语音合成 1.0 在开启字幕时产出的结构化结果。 */
const VOICE_SUBTITLE: PortSchemaRef = { id: 'voice.subtitle', version: 1 }

/**
 * 语音合成节点端口声明。返回两套互斥结构，由 config.backend 决定：
 *   minimax → 朗读文本 + MiniMax 音色档案 → 音频
 *   volc    → 朗读文本 + 可选参考音频 → 音频 + 可选字幕（speaker 在节点参数中填写）
 * 静态 ports 是这两套的并集，只用于注册校验与契约快照；运行时以本函数为准。
 */
function speechPorts(backend: SpeechBackend): {
  in: PortDecl[]
  out: PortDecl[]
} {
  const inVoice = input(
    'in-voice',
    '音色档案',
    'json',
    '连接上游 MiniMax 音色设计或语音克隆节点的音色档案；以连线传入的 voice_id 为准。未连接时使用节点内音色 ID，留空时使用系统音色 male-qn-qingse。',
    { schema: VOICE_PROFILE }
  )
  const inAudio = input(
    'in-audio',
    '参考音频',
    'audio',
    `火山引擎语音合成 1.0 的可选参考音频；最多 ${VOLC_REFERENCE_AUDIO_MAX_COUNT} 段，节点上传项追加在连线音频之后；单段不超过 ${VOLC_REFERENCE_AUDIO_MAX_SECONDS} 秒 / ${VOLC_REFERENCE_AUDIO_MAX_BYTES / (1024 * 1024)} MB，支持 wav、mp3、pcm、ogg_opus。speaker ID 可与参考音频同时使用。`,
    { cardinality: 'many' }
  )
  const inText = input(
    'in-text',
    '朗读文本',
    'text',
    backend === 'minimax'
      ? '节点正文与上游文本合并后朗读。MiniMax 支持语气词标签和读音纠正；读音纠正格式为“词/(拼音)(拼音)”，例如“重庆/(chong2)(qing4)”，示例已预填在节点配置中。'
      : '节点正文与一个或多个上游文本合并后进行朗读。',
    {
      cardinality: 'many'
    }
  )
  const outAudio = output(
    'out-audio',
    '语音',
    'audio',
    backend === 'minimax'
      ? 'MiniMax 异步语音合成（t2a_async_v2，默认通道）；支持语气词标签、音色 ID、情绪、语速、音量和音调。'
      : '火山引擎语音合成 1.0；参考音频可选，可使用 speaker ID，并调节语速、音量和音调；可选返回字幕时间轴。'
  )
  const outSubtitle = output(
    'out-subtitle',
    '字幕时间轴',
    'json',
    '火山语音合成 1.0 在开启字幕时返回的分句时间轴；MiniMax 不产生该输出。',
    { required: false, schema: VOICE_SUBTITLE }
  )

  if (backend === 'volc') {
    return { in: [inText, inAudio], out: [outAudio, outSubtitle] }
  }
  return { in: [inText, inVoice], out: [outAudio] }
}

export function registerBaseNodeTypes(): void {
  registerNodeType({
    type: 'text',
    contractVersion: 3,
    label: '文本',
    icon: 'text',
    color: '#38bdf8',
    defaultSize: { w: 340, h: 260 },
    description: '可编辑的原始文本。上游文本在运行时并入正文，再经 out-text 输出。',
    category: 'input',
    ports: {
      in: [
        input('in-text', '文本', 'text', '一个或多个上游文本，执行时与节点内文本合并。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-text', '文本', 'text', '节点最终保存的纯文本内容。')]
    },
    projectOutputs: projectTextOutputs,
    outputSource: 'document',
    executor: textExecutor,
    Body: TextBody
  })
  registerNodeType({
    type: 'image',
    contractVersion: 3,
    label: '图片',
    icon: 'image',
    color: '#22c55e',
    defaultSize: { w: 340, h: 260 },
    description: '图片资产节点，只负责保存和输出一张已导入的图片，不承担生成逻辑。',
    category: 'input',
    ports: {
      in: [],
      out: [output('out-image', '图片', 'image', '已导入并落盘的图片资产引用。')]
    },
    projectOutputs: projectImageOutputs,
    outputSource: 'document',
    executor: imageExecutor,
    Body: ImageBody
  })
  registerNodeType({
    type: 'image-crop',
    contractVersion: 2,
    label: '裁剪',
    icon: 'crop',
    color: '#16a34a',
    defaultSize: { w: 340, h: 260 },
    description: '对上游图片做矩形或透视裁剪；每次运行产出新图片，原图不变。',
    category: 'image',
    ports: {
      in: [
        input('in-image', '原图', 'image', '必须连接的一张源图片；裁剪参数按其原始比例解释。', {
          required: true
        })
      ],
      out: [output('out-image', '裁剪图', 'image', '本地裁剪完成并落盘的新图片资产。')]
    },
    projectOutputs: projectImageCropOutputs,
    executor: imageCropExecutor,
    SettingsPanel: ImageCropSettings,
    Body: ImageCropBody
  })
  registerNodeType({
    type: 'image-split',
    contractVersion: 3,
    label: '拆分',
    icon: 'grid',
    color: '#4ade80',
    // 结果网格在卡片内限高滚动（见 .media-result-grid），不通过放大默认卡片容纳内容。
    defaultSize: { w: 340, h: 260 },
    description: '把一张上游图片按行列拆成多张；输出当前图与图片集合。',
    category: 'image',
    ports: {
      in: [
        input('in-image', '原图', 'image', '必须连接的一张源图片；按行列从左到右、从上到下拆分。', {
          required: true
        })
      ],
      out: [
        output('out-image', '当前图片', 'image', '从图片集合中选中的一格，可直接连接图片类下游。'),
        output(
          'out-images',
          '图片集合',
          'json',
          '所有格子对应的真实图片资产引用列表，可连接循环节点批处理。',
          {
            schema: LIST_ITEMS
          }
        )
      ]
    },
    projectOutputs: projectImageSplitOutputs,
    executor: imageSplitExecutor,
    SettingsPanel: ImageSplitSettings,
    Body: ImageSplitBody
  })
  registerNodeType({
    type: 'image-gen',
    contractVersion: 3,
    label: '生图',
    icon: 'image-gen',
    color: '#15803d',
    defaultSize: { w: 340, h: 260 },
    description: '根据提示词和有序参考图片生成图片；所有参考图统一连入一个多值图片端口。',
    category: 'input',
    ports: {
      in: [
        input(
          'in-images',
          '参考图',
          'image',
          '唯一的图片输入；可连接 1～4 张图片，按真实连线顺序作为图片 1～4 提交给模型。',
          { cardinality: 'many' }
        ),
        input(
          'in-prompt',
          '提示词包',
          'json',
          '可选的 prompt.bundle@1；读取其中的 prompt 与 style。',
          {
            schema: PROMPT_BUNDLE
          }
        ),
        input('in-text', '提示词', 'text', '生成图片使用的提示文本，可由多个文本上游合并。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-image', '图片', 'image', '模型生成并落盘后的图片资产引用。')]
    },
    projectOutputs: projectImageGenOutputs,
    executor: imageGenExecutor,
    Body: ImageGenerateBody
  })
  registerNodeType({
    type: 'image-edit',
    contractVersion: 2,
    label: 'P图',
    icon: 'edit',
    color: '#84cc16',
    defaultSize: { w: 340, h: 260 },
    description: '以一张上游图片为原图，结合标注与文字说明生成新的图片；原图保持不变。',
    category: 'image',
    ports: {
      in: [
        input('in-image', '原图', 'image', '必须连接的一张待修改图片。', { required: true }),
        input('in-text', '修改说明', 'text', '可选的文本修改说明，可由多个文本上游合并。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-image', '修改图', 'image', '模型修改并落盘后的新图片资产。')]
    },
    projectOutputs: projectImageEditOutputs,
    executor: imageEditExecutor,
    SettingsPanel: ImageEditSettings,
    Body: ImageEditBody
  })
  registerNodeType({
    type: 'video',
    contractVersion: 7,
    label: '视频生成',
    icon: 'video',
    color: '#f43f5e',
    defaultSize: { w: 340, h: 260 },
    description: '由文本与参考素材生成视频；所有参考必须经端口连入。',
    category: 'input',
    ports: {
      in: [
        input(
          'in-images',
          '图片',
          'image',
          '可选的多张图片。按连线顺序读取：第 1 张作为主图/首帧，其余作为有序参考图；全部都连接到同一个绿色端口。',
          { cardinality: 'many' }
        ),
        input(
          'in-reference-video',
          '运动参考',
          'video',
          '可选的真实参考视频。预演台白模视频可在此传入，模型是否接受由供应商实际响应决定。',
          { cardinality: 'many' }
        ),
        input(
          'in-reference-audio',
          '参考音频',
          'audio',
          '可选的参考音频；仅在当前模型支持时按真实输入提交，不能替代生成音频设置。',
          { cardinality: 'many' }
        ),
        input(
          'in-prompt',
          '提示词包',
          'json',
          '可选的 prompt.bundle@1；读取其中的 prompt 与 style。',
          {
            schema: PROMPT_BUNDLE
          }
        ),
        input('in-text', '提示词', 'text', '描述视频内容和运动方式的提示文本。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-video', '视频', 'video', '生成并落盘后的视频资产引用。')]
    },
    projectOutputs: projectVideoOutputs,
    executor: videoExecutor,
    Body: VideoBody
  })
  registerNodeType({
    type: 'video-asset',
    contractVersion: 2,
    label: '视频素材',
    icon: 'video-asset',
    color: '#e11d48',
    defaultSize: { w: 340, h: 260 },
    description: '视频资产节点：导入本地视频，只负责预览、替换和向下游输出。',
    category: 'input',
    ports: { in: [], out: [output('out-video', '视频', 'video', '不可变的视频资产引用。')] },
    projectOutputs: projectVideoAssetOutputs,
    outputSource: 'document',
    executor: (ctx) =>
      ctx.shape.props.mediaPath
        ? { status: 'done' }
        : { status: 'skipped', reason: '未导入视频资产' },
    Body: VideoBody
  })
  registerNodeType({
    type: 'video-frame',
    contractVersion: 4,
    label: '抽帧',
    icon: 'frame',
    color: '#be123c',
    defaultSize: { w: 340, h: 260 },
    description: '提取上游视频首帧/尾帧/指定时刻画面为新图片。',
    category: 'video',
    ports: {
      in: [input('in-video', '源视频', 'video', '必须连接的一段源视频。', { required: true })],
      out: [output('out-image', '视频帧', 'image', '指定时间点解码得到的新图片资产。')]
    },
    projectOutputs: projectVideoFrameOutputs,
    executor: videoFrameExecutor,
    SettingsPanel: VideoFrameSettings,
    Body: VideoFrameBody
  })
  registerNodeType({
    type: 'video-clip',
    contractVersion: 5,
    label: '视频截取',
    icon: 'clip',
    color: '#f43f5e',
    defaultSize: { w: 340, h: 260 },
    description: '按起止毫秒截取视频，可选择画面或音频；提取音频时可在同次操作中提取人声。',
    category: 'video',
    ports: {
      in: [input('in-video', '源视频', 'video', '必须连接的一段源视频。', { required: true })],
      out: [
        output('out-video', '视频片段', 'video', '精确重编码后的 MP4 视频片段。', {
          required: false
        }),
        output('out-audio', '音频片段', 'audio', '同一时间范围提取并转码的新音频资产。', {
          required: false
        })
      ]
    },
    projectOutputs: projectVideoClipOutputs,
    executor: videoClipExecutor,
    SettingsPanel: VideoClipSettings,
    Body: VideoClipBody
  })
  registerNodeType({
    type: 'video-depth',
    contractVersion: 1,
    label: '深度视频',
    icon: 'video',
    color: '#7c3aed',
    defaultSize: { w: 340, h: 260 },
    description: '使用本地 CUDA 推理将视频转换为灰度深度视频；源音频可选保留。',
    category: 'video',
    ports: {
      in: [input('in-video', '源视频', 'video', '需要转换的输入视频。', { required: true })],
      out: [output('out-video', '深度视频', 'video', '逐帧深度估计生成的灰度视频资产。')]
    },
    projectOutputs: projectVideoAiOutputs,
    executor: videoDepthExecutor,
    SettingsPanel: VideoAiSettings,
    Body: VideoAiBody
  })
  registerNodeType({
    type: 'video-clay',
    contractVersion: 1,
    label: '白模视频',
    icon: 'video',
    color: '#64748b',
    defaultSize: { w: 340, h: 260 },
    description: '使用视频深度估计生成白色浮雕光照视频，可调整浮雕强度与光源。',
    category: 'video',
    ports: {
      in: [input('in-video', '源视频', 'video', '需要转换的输入视频。', { required: true })],
      out: [output('out-video', '白模视频', 'video', '由估计深度和可调材质光照合成的视频资产。')]
    },
    projectOutputs: projectVideoAiOutputs,
    executor: videoClayExecutor,
    SettingsPanel: VideoAiSettings,
    Body: VideoAiBody
  })
  registerNodeType({
    type: 'video-audio',
    contractVersion: 4,
    label: '截音频',
    icon: 'audio',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description:
      '已退役：功能并入「视频截取」。历史画布中的本节点仍可正常执行与连线，但不能再新建。',
    category: 'video',
    creatable: false,
    ports: {
      in: [input('in-video', '源视频', 'video', '必须连接的一段源视频。', { required: true })],
      out: [output('out-audio', '音频片段', 'audio', '从指定范围提取并转码的新音频资产。')]
    },
    projectOutputs: projectVideoAudioOutputs,
    executor: videoAudioExecutor,
    SettingsPanel: VideoAudioSettings,
    Body: VideoAudioBody
  })
  registerNodeType({
    type: 'vocal-separate',
    contractVersion: 4,
    label: '人声分离',
    icon: 'audio',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description: '已退役：新视频操作直接提取人声；历史画布中的节点仍可运行。',
    category: 'audio',
    creatable: false,
    ports: {
      in: [
        input('in-audio', '源音频', 'audio', '必须连接的一段完整音频资产。', { required: true })
      ],
      out: [
        output(
          'out-audio',
          '人声',
          'audio',
          '分离产出的人声音轨；高质量模式的伴奏会作为关联独立音频节点显示在画布中。'
        )
      ]
    },
    projectOutputs: projectVocalSeparateOutputs,
    executor: vocalSeparateExecutor,
    SettingsPanel: VocalSeparateSettings,
    Body: VocalSeparateBody
  })
  registerNodeType({
    type: 'audio',
    contractVersion: 3,
    label: '音频',
    icon: 'audio',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description: '音频资产节点：导入本地音频，只负责保存、预览和输出资产。',
    category: 'input',
    ports: {
      in: [],
      out: [output('out-audio', '音频', 'audio', '已导入并落盘的音频资产引用。')]
    },
    projectOutputs: projectAudioOutputs,
    outputSource: 'document',
    executor: (ctx) =>
      ctx.shape.props.mediaPath
        ? { status: 'done' }
        : { status: 'skipped', reason: '未导入音频资产' },
    Body: AudioBody
  })
  registerNodeType({
    type: 'file',
    contractVersion: 2,
    label: '文件',
    icon: 'document',
    color: '#06b6d4',
    defaultSize: { w: 340, h: 260 },
    description: '文件资产节点：导入 Excel / Word / PDF 等文档并输出。',
    category: 'input',
    ports: {
      in: [],
      out: [
        output('out-file', '文件', 'file', '已导入并落盘的原始文件资产引用。'),
        output('out-text', '文本', 'text', '抽取出的文档正文（文本/CSV/Word/Excel/PPT/PDF）。', {
          required: false
        })
      ]
    },
    projectOutputs: projectFileOutputs,
    outputSource: 'document',
    executor: (ctx) =>
      ctx.shape.props.mediaPath
        ? { status: 'done' }
        : { status: 'skipped', reason: '未导入文件资产' },
    Body: FileBody
  })
  registerNodeType({
    type: 'speech',
    contractVersion: 4,
    label: '语音合成',
    icon: 'mic',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description: '按所选供应商和语音参数，把文本合成为音频。供应商相关输入输出规则见“输入输出”。',
    category: 'audio',
    ports: {
      in: speechPorts('volc').in,
      out: speechPorts('volc').out
    },
    resolvePorts: (shape) => speechPorts(parseSpeechConfig(readNodeConfig(shape)).backend),
    projectOutputs: projectSpeechOutputs,
    executor: speechExecutor,
    SettingsPanel: SpeechSettings,
    Body: SpeechBody
  })
  registerNodeType({
    type: 'tts',
    contractVersion: 3,
    label: '语音克隆',
    icon: 'audio',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description: 'MiniMax 音色克隆，输出试听音频与可复用的音色档案',
    category: 'audio',
    ports: {
      in: [
        input('in-audio', '参考语音', 'audio', '可选的上游参考音频；也可在节点内上传。'),
        input('in-text', '文本', 'text', '需要朗读的文本（与节点内文本合并）。', {
          cardinality: 'many'
        })
      ],
      out: [
        output('out-audio', '音频', 'audio', '语音复刻合成并落盘后的音频资产引用。'),
        output(
          'out-json',
          '音色档案',
          'json',
          'MiniMax 复刻登记出的 voice_id；本地 IndexTTS 链路没有服务端音色，此时不产出。',
          { required: false, schema: VOICE_PROFILE }
        )
      ]
    },
    projectOutputs: projectTtsOutputs,
    executor: ttsExecutor,
    Body: TtsBody
  })
  registerNodeType({
    type: 'voice-design',
    contractVersion: 1,
    label: '音色设计',
    icon: 'audio',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description: '用文字描述设计音色，产出试听音频与可复用的音色 ID。',
    category: 'audio',
    ports: {
      in: [
        input('in-text', '音色描述', 'text', '音色特征描述；与节点内描述合并后提交。', {
          cardinality: 'many'
        })
      ],
      out: [
        output('out-audio', '试听音频', 'audio', '服务端返回的 hex 试听音频解码落盘后的资产。'),
        output(
          'out-json',
          '音色档案',
          'json',
          '设计出的 voice_id 与来源，可直接连接语音合成节点的音色档案输入。',
          { schema: VOICE_PROFILE }
        )
      ]
    },
    projectOutputs: projectVoiceDesignOutputs,
    executor: voiceDesignExecutor,
    Body: VoiceDesignBody
  })
  registerNodeType({
    type: 'chat',
    contractVersion: 1,
    label: 'AI 对话',
    icon: 'chat',
    color: '#a855f7',
    defaultSize: { w: 340, h: 260 },
    description: '与文本模型对话。上游文本会成为本轮输入，最后一条助手回复作为文本输出。',
    category: 'audio',
    ports: {
      in: [
        input('in-text', '文本', 'text', '作为本轮用户消息或上下文注入的上游文本。', {
          cardinality: 'many'
        })
      ],
      out: [output('out-markdown', '回复', 'markdown', '模型最后一条回复，保留 Markdown 语义。')]
    },
    projectOutputs: projectChatOutputs,
    executor: chatExecutor,
    SettingsPanel: ChatSettings,
    Body: ChatBody
  })
}

// 脚本节点（LibTV 1.2.6 基础版）：剧本文本 + 手工分镜表；
// AI 拆解 / 批量生图在 M4 模型接入后开放
export function registerScriptNodeType(): void {
  registerNodeType({
    type: 'script',
    contractVersion: 1,
    label: '脚本',
    icon: 'script',
    color: '#e2e8f0',
    defaultSize: { w: 340, h: 260 },
    description: '旧版复合脚本节点，仅兼容保留；新流程用「文本 → 处理 → JSON」。',
    category: 'logic',
    creatable: false,
    ports: {
      in: [
        input('in-text', '剧本文本', 'text', '待拆解为分镜结构的剧本文本。', {
          cardinality: 'many'
        })
      ],
      out: [
        output('out-json', '分镜数据', 'json', '按字段定义生成的分镜列表。', {
          schema: STORYBOARD_SHOTS
        }),
        output('out-text', '分镜文本', 'text', '旧版兼容使用的分镜文字摘要。', {
          required: false
        })
      ]
    },
    projectOutputs: projectScriptOutputs,
    executor: scriptExecutor,
    Body: ScriptBody
  })
}

// M5 新增节点注册
export function registerExtendedNodeTypes(): void {
  // 分组改用 tldraw 原生 group 状态；视频合成退出画布职责。
  unregisterNodeType('group')
  unregisterNodeType('compose')

  registerNodeType({
    type: 'processor',
    contractVersion: 1,
    label: '数据处理',
    icon: 'processor',
    color: '#06b6d4',
    defaultSize: { w: 340, h: 260 },
    description: '单值透传并保持原类型；也可从 JSON 取字段或转成文本模板。',
    category: 'logic',
    ports: {
      in: [
        input('in-value', '输入变量', 'any', '一个文本、JSON 或媒体资产值；此端口不接收多条连线。')
      ],
      out: [
        output(
          'out-value',
          '输出变量',
          'any',
          '透传时保留原值类型；取字段保留其文本或 JSON 类型；模板模式输出文本。'
        )
      ]
    },
    projectOutputs: projectProcessorOutputs,
    executor: processorExecutor,
    Body: ProcessorBody
  })
  registerNodeType({
    type: 'json',
    contractVersion: 1,
    label: 'JSON',
    icon: 'json',
    color: '#c084fc',
    defaultSize: { w: 340, h: 260 },
    description: '解析并格式化通用 JSON，支持手工编辑；多条 JSON 连线会汇总成数组。',
    category: 'logic',
    ports: {
      in: [
        input(
          'in-json',
          '数据',
          'json',
          '优先输入：一条保留原值；多条按连线顺序汇总为 JSON 数组。',
          {
            cardinality: 'many',
            schema: JSON_ANY
          }
        ),
        input(
          'in-text',
          '文本',
          'text',
          '仅在没有 JSON 数据输入时解析；两类同时连接时使用 JSON 数据。'
        )
      ],
      out: [output('out-json', '数据', 'json', '校验并格式化后的结构化值。', { schema: JSON_ANY })]
    },
    projectOutputs: projectJsonOutputs,
    executor: jsonExecutor,
    Body: JsonBody
  })
  registerNodeType({
    type: 'structured',
    contractVersion: 1,
    label: '结构数据',
    icon: 'structured',
    color: '#818cf8',
    defaultSize: { w: 340, h: 260 },
    description: '按 Schema 校验 JSON 正文，运行时可插入连线值占位符。',
    category: 'logic',
    ports: {
      in: [
        input(
          'in-context',
          '结构上下文',
          'json',
          '一个或多个已连接的结构化输入，可在正文中用 {{input[0].field}} 显式引用。',
          {
            cardinality: 'many',
            schema: JSON_ANY
          }
        ),
        input('in-text', '文本上下文', 'text', '可在正文中用 {{text}} 显式引用的上游文本。', {
          cardinality: 'many'
        })
      ],
      out: [
        output('out-json', '结构数据', 'json', '经所选 Schema 校验后的结构化数据。', {
          schema: JSON_ANY
        })
      ]
    },
    resolvePorts: (shape) => {
      const schema = parseStructuredDataConfig(readNodeConfig(shape)).schema
      return {
        in: [
          input(
            'in-context',
            '结构上下文',
            'json',
            '一个或多个已连接的结构化输入，可在正文中用 {{input[0].field}} 显式引用。',
            {
              cardinality: 'many',
              schema: JSON_ANY
            }
          ),
          input('in-text', '文本上下文', 'text', '可在正文中用 {{text}} 显式引用的上游文本。', {
            cardinality: 'many'
          })
        ],
        out: [
          output('out-json', '结构数据', 'json', '经所选 Schema 校验后的结构化数据。', { schema })
        ]
      }
    },
    projectOutputs: projectStructuredOutputs,
    executor: structuredExecutor,
    Body: StructuredBody
  })
  registerNodeType({
    type: 'code',
    contractVersion: 3,
    label: '代码',
    icon: 'code',
    color: '#e2e8f0',
    defaultSize: { w: 340, h: 260 },
    description: '本地运行 JavaScript，支持具名输入和多字段输出。',
    category: 'logic',
    ports: {
      in: [
        input('in-text', '文本输入', 'text', '代码运行时 input.text 读取的合并文本。', {
          cardinality: 'many'
        }),
        input('in-json', '数据输入', 'json', '代码运行时 input.json 读取的结构化值列表。', {
          cardinality: 'many',
          schema: JSON_ANY
        })
      ],
      out: [
        output(
          'out-output',
          '输出变量',
          'any',
          '代码 return 的默认输出变量；实际端口由节点配置解析。'
        )
      ]
    },
    resolvePorts: (shape) => {
      const cfg = parseCodeConfigs(readNodeConfig(shape))
      const configErrors = codePortConfigErrors(readNodeConfig(shape))
      // 配置有冲突时不暴露半真半假的动态端口；执行器会提供相同的硬错误。
      const paramPorts: PortDecl[] = (configErrors.length ? [] : cfg.params).map((p) => {
        const type = mapVarTypeToPortType(p.type)
        return {
          id: codeParamPortId(p),
          name: p.name,
          dir: 'in',
          type,
          description: `自定义参数：${p.name}（${p.type}）`,
          required: false,
          cardinality: p.cardinality ?? 'one',
          ...(type === 'json' ? { schema: JSON_ANY } : {}),
          ...(type === 'camera' ? { schema: PREVIS_CAMERA } : {})
        }
      })
      const outputFields = configErrors.length
        ? []
        : cfg.outputMode === 'fields'
          ? cfg.outputs
          : [{ name: cfg.outputName, type: cfg.outputType }]
      return {
        in: [
          input('in-text', '文本输入', 'text', '代码运行时 input.text 读取的合并文本。', {
            cardinality: 'many'
          }),
          input('in-json', '数据输入', 'json', '代码运行时 input.json 读取的结构化值列表。', {
            cardinality: 'many',
            schema: JSON_ANY
          }),
          ...paramPorts
        ],
        out: outputFields.map((field) => {
          const type = mapVarTypeToPortType(field.type)
          return output(
            outputFieldPortId(field),
            field.name,
            type,
            `代码 return 对象字段 ${field.name}（${field.type}）。`,
            {
              ...(type === 'json' ? { schema: JSON_ANY } : {}),
              ...(type === 'camera' ? { schema: PREVIS_CAMERA } : {})
            }
          )
        })
      }
    },
    projectOutputs: projectCodeOutputs,
    executor: codeExecutor,
    Body: CodeBody
  })
  registerNodeType({
    type: 'storyboard',
    contractVersion: 1,
    label: '分镜板',
    icon: 'storyboard',
    color: '#3b82f6',
    defaultSize: { w: 340, h: 260 },
    description: '按镜头 JSON 字段生成可编辑表格，并输出完整分镜数据与文字摘要。',
    category: 'logic',
    ports: {
      in: [
        input('in-json', '分镜数据', 'json', '符合分镜 Schema 的镜头列表。', {
          schema: STORYBOARD_SHOTS
        }),
        input('in-text', '分镜文本', 'text', '可解析为分镜 JSON 的兼容文本输入。')
      ],
      out: [
        output('out-json', '分镜数据', 'json', '编辑后的完整分镜结构。', {
          schema: STORYBOARD_SHOTS
        }),
        output('out-text', '合成文本', 'text', '由画面、台词和时长生成的可读摘要。', {
          required: false
        })
      ]
    },
    projectOutputs: projectStoryboardOutputs,
    executor: storyboardExecutor,
    Body: StoryboardBody
  })
  registerNodeType({
    type: 'ai-process',
    contractVersion: 1,
    label: 'AI 处理',
    icon: 'spark',
    color: '#e879f9',
    defaultSize: { w: 340, h: 260 },
    description: '把上游文本/JSON 交给文本模型，产出文本、Markdown 或 JSON。',
    category: 'logic',
    ports: {
      in: [
        input('in-text', '文本', 'text', '一个或多个上游文本，作为本次转换的输入。', {
          cardinality: 'many'
        }),
        input('in-json', 'JSON 上下文', 'json', '可选的结构化上下文，注入本次转换。', {
          schema: JSON_ANY
        })
      ],
      out: [
        output('out-text', '文本', 'text', '模型返回的纯文本结果。', { required: false }),
        output('out-markdown', 'Markdown', 'markdown', '模型返回的 Markdown 结果。', {
          required: false
        }),
        output('out-json', 'JSON', 'json', '模型返回并校验后的结构化值（按所选 Schema）。', {
          required: false,
          schema: JSON_ANY
        })
      ]
    },
    projectOutputs: projectAiProcessOutputs,
    executor: aiProcessExecutor,
    SettingsPanel: AiProcessSettings,
    Body: AiProcessBody
  })
  registerNodeType({
    type: 'iterate',
    contractVersion: 2,
    label: '循环',
    icon: 'grid',
    color: '#9333ea',
    defaultSize: { w: 340, h: 260 },
    description: '按顺序逐项运行循环体，并汇总结果。',
    category: 'logic',
    ports: {
      in: [
        input('in-list', '列表', 'json', '列表项按顺序逐个运行连接的循环体。', {
          schema: LIST_ITEMS,
          // 契约矩阵把 in-list 记为必填：没有列表时循环体一项都不会跑，
          // 与其让按钮可点、跑完给一句「没有可循环的列表输入」，不如直接标出缺什么。
          required: true
        })
      ],
      out: [
        output(
          'out-item',
          '当前项',
          'iteration',
          '循环体专用的临时作用域。普通列表项进入 JSON 输入；带 kind 与资产引用字段的媒体项可进入同类型媒体输入。',
          { required: false }
        ),
        output(
          'out-items',
          '结果列表',
          'json',
          '每项处理结果的结构化列表（含来源、状态、各节点产物）。',
          {
            schema: LIST_ITEMS
          }
        )
      ]
    },
    projectOutputs: projectIterateOutputs,
    executor: iterateExecutor,
    Body: IterateBody
  })
  registerNodeType({
    type: 'director',
    contractVersion: 3,
    label: '3D 预演台',
    icon: 'director',
    color: '#f59e0b',
    defaultSize: { w: 340, h: 260 },
    description: '3D 白模预演台；发布后帧、视频与机位才成为下游输入。',
    category: 'logic',
    executionMode: 'manual-publish',
    ports: {
      in: [
        input(
          'in-storyboard',
          '分镜',
          'json',
          '可选的分镜列表；连线后需在 3D 预演台点「同步连线输入」才会成为镜头。',
          {
            schema: STORYBOARD_SHOTS
          }
        ),
        input(
          'in-reference-images',
          '场景参考图',
          'image',
          '1～3 张参考图建议用于建立白模空间；真实连线输入，不读取其他节点内部状态。',
          {
            cardinality: 'many'
          }
        ),
        input(
          'in-camera-preset',
          '机位参数',
          'camera',
          '可选的初始机位参数，仅接受 3D 预演台发布的机位通道。',
          {
            schema: PREVIS_CAMERA
          }
        )
      ],
      out: [
        output('out-frame', '预演帧', 'image', '用户发布的当前镜头静帧。', { required: false }),
        output('out-preview-video', '预演视频', 'video', '用户导出的 WebM 预演视频。', {
          required: false
        }),
        output(
          'out-camera',
          '机位参数',
          'camera',
          '已发布镜头的焦距、画幅、时长和机位参数；使用专用机位通道，不与工程摘要混为同类输出。',
          { required: false, schema: PREVIS_CAMERA }
        ),
        output(
          'out-project',
          '工程摘要',
          'json',
          '导演工程中可交换的镜头和机位摘要，不包含媒体二进制。',
          {
            required: false,
            schema: PREVIS_PROJECT
          }
        )
      ]
    },
    projectOutputs: projectDirectorOutputs,
    executor: directorExecutor,
    Body: DirectorBody
  })
}
