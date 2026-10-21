// 即梦可用模型白名单 —— 全应用唯一真值源。
//
// 这份清单不是"文档抄来的支持列表"，而是经过实测后**收敛**出来的可用集合：
//   - `seedance2.0fast` / `seedance2.0`：提交后 queue_length 数十万，数小时不前进，
//     用户看到的就是"一直卡"，产品上已禁用；
//   - 图片 3.x / 4.x：产品只保留 5.0 与 5.0Pro 两档，其余不再提供入口。
//
// 三处必须同时引用它，否则会出现"能选但不能跑"或"能跑但选不到"：
//   1. `PROVIDER_SPECS.suggestions`（新建实例的预置模型）
//   2. `imageCapabilitiesFor` / `videoCapabilitiesFor`（能力表）
//   3. 网关执行前校验 + 设置面板保存时过滤（兜底老项目与手工添加）
//
// 刻意不 import 任何模块，避免与 shared/types 形成循环依赖。

export const DREAMINA_IMAGE_MODELS = ['5.0', '5.0Pro'] as const

export const DREAMINA_VIDEO_MODELS = [
  'seedance2.5',
  'seedance2.0_vip',
  'seedance2.0fast_vip',
  'seedance2.0mini'
] as const

/** 已知被禁用的历史型号：只用于给出可操作的错误文案，不作为支持依据。 */
export const DREAMINA_DISABLED_MODELS = [
  '3.0',
  '3.1',
  '4.0',
  '4.1',
  '4.5',
  '4.6',
  '4.7',
  'seedance1.0fast',
  'seedance1.5pro',
  'seedance2.0',
  'seedance2.0fast'
] as const

const IMAGE_SET = new Set<string>(DREAMINA_IMAGE_MODELS.map((id) => id.toLowerCase()))
const VIDEO_SET = new Set<string>(DREAMINA_VIDEO_MODELS.map((id) => id.toLowerCase()))

function normalize(modelId: string): string {
  return (modelId || '').trim().toLowerCase()
}

export function isDreaminaImageModel(modelId: string): boolean {
  return IMAGE_SET.has(normalize(modelId))
}

export function isDreaminaVideoModel(modelId: string): boolean {
  return VIDEO_SET.has(normalize(modelId))
}

/** 任意一类可用即放行；调用方需要区分图片/视频时用上面两个更具体的判定。 */
export function isDreaminaModelSupported(modelId: string): boolean {
  return isDreaminaImageModel(modelId) || isDreaminaVideoModel(modelId)
}

export function dreaminaUnsupportedModelMessage(modelId: string): string {
  const allowed = [...DREAMINA_IMAGE_MODELS, ...DREAMINA_VIDEO_MODELS].join(' / ')
  return `即梦模型「${modelId || '未指定'}」已禁用：实测该型号无法正常出片（排队数小时或直接失败）。可用模型：${allowed}`
}
