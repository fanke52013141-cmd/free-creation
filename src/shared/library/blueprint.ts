import { z } from 'zod'
import type { LibraryResourceComponent, LibraryValueType } from './types'

/** Content adapters are explicit: adding an adapter requires matching the node contract. */
export const LIBRARY_NODE_ADAPTERS = {
  text: {
    label: '文本',
    contractVersion: 3,
    binding: 'text',
    values: ['text', 'markdown', 'recipe']
  },
  image: { label: '图片', contractVersion: 3, binding: 'media', values: ['image'] },
  audio: { label: '音频', contractVersion: 3, binding: 'media', values: ['audio'] },
  'video-asset': { label: '视频素材', contractVersion: 2, binding: 'media', values: ['video'] },
  file: { label: '文件', contractVersion: 2, binding: 'media', values: ['file'] },
  json: { label: 'JSON', contractVersion: 1, binding: 'text', values: ['json'] }
} as const
export type LibraryNodeType = keyof typeof LIBRARY_NODE_ADAPTERS
const slotSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(80),
    nodeType: z.enum(['text', 'image', 'audio', 'video-asset', 'file', 'json']),
    contractVersion: z.number().int().positive(),
    required: z.boolean(),
    multiple: z.boolean(),
    titleTemplate: z.string().trim().min(1).max(180)
  })
  .strict()
export const categorySchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    presentation: z.enum(['gallery', 'profile', 'list']),
    coverSlotId: z.string().max(64).optional(),
    blueprint: z
      .object({
        protocolVersion: z.literal(1),
        layout: z.enum(['row', 'grid']),
        slots: z.array(slotSchema).min(1).max(32)
      })
      .strict()
  })
  .strict()
  .superRefine((category, ctx) => {
    if (category.id.startsWith('legacy-'))
      ctx.addIssue({ code: 'custom', message: 'legacy- 是旧版兼容保留标识' })
    const ids = new Set<string>()
    category.blueprint.slots.forEach((slot, index) => {
      if (ids.has(slot.id))
        ctx.addIssue({
          code: 'custom',
          path: ['blueprint', 'slots', index, 'id'],
          message: '节点槽位 ID 重复'
        })
      ids.add(slot.id)
      if (slot.contractVersion !== LIBRARY_NODE_ADAPTERS[slot.nodeType].contractVersion) {
        ctx.addIssue({ code: 'custom', message: `「${slot.label}」的节点契约版本不兼容` })
      }
      const unknown = slot.titleTemplate
        .match(/\{[^{}]+\}/g)
        ?.filter((token) => !['{resource}', '{slot}', '{index}'].includes(token))
      if (unknown?.length)
        ctx.addIssue({ code: 'custom', message: '名称模板仅支持 {resource}、{slot}、{index}' })
    })
    if (
      category.coverSlotId &&
      !category.blueprint.slots.some(
        (slot) => slot.id === category.coverSlotId && slot.nodeType === 'image'
      )
    ) {
      ctx.addIssue({ code: 'custom', message: '封面必须绑定图片节点槽位' })
    }
  })
export type LibraryCategory = z.infer<typeof categorySchema>
export type LibraryNodeSlot = LibraryCategory['blueprint']['slots'][number]
export interface SaveLibraryCategoryInput {
  category: LibraryCategory
  baseVersion: number
}

export function parseCategory(value: unknown): LibraryCategory {
  const result = categorySchema.safeParse(value)
  if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join('；'))
  return result.data
}
export function acceptsValue(slot: LibraryNodeSlot, valueType: LibraryValueType): boolean {
  return (LIBRARY_NODE_ADAPTERS[slot.nodeType].values as readonly string[]).includes(valueType)
}
export function componentSlotId(
  component: Pick<LibraryResourceComponent, 'metadata'>
): string | undefined {
  return typeof component.metadata.librarySlotId === 'string'
    ? component.metadata.librarySlotId
    : undefined
}
export function validateCategoryContent(
  category: LibraryCategory,
  components: Array<Pick<LibraryResourceComponent, 'valueType' | 'metadata'>>
): void {
  for (const component of components) {
    const slot = category.blueprint.slots.find((item) => item.id === componentSlotId(component))
    if (!slot) throw new Error('存在未映射的内容，请为每个组件选择节点槽位')
    if (!acceptsValue(slot, component.valueType))
      throw new Error(`「${slot.label}」与组件类型不兼容`)
  }
  for (const slot of category.blueprint.slots) {
    const count = components.filter((component) => componentSlotId(component) === slot.id).length
    if (slot.required && !count) throw new Error(`请填写「${slot.label}」`)
    if (!slot.multiple && count > 1) throw new Error(`「${slot.label}」只允许一个组件`)
  }
}

export function legacyCategory(
  preset: string,
  components: LibraryResourceComponent[]
): LibraryCategory {
  const names: Record<string, string> = {
    image: '图片 / 海报',
    prompt: '提示词',
    character: '人物',
    scene: '场景',
    style: '风格',
    custom: '旧版组合'
  }
  return {
    id: `legacy-${preset}`,
    version: 1,
    name: names[preset] ?? '旧版资源',
    description: '旧版内容按原有类型映射，保存新版本时可选择新分类。',
    presentation: 'gallery',
    blueprint: {
      protocolVersion: 1,
      layout: 'grid',
      slots: components.map((component, index) => {
        const nodeType = (Object.keys(LIBRARY_NODE_ADAPTERS) as LibraryNodeType[]).find((type) =>
          (LIBRARY_NODE_ADAPTERS[type].values as readonly string[]).includes(component.valueType)
        )
        if (!nodeType) throw new Error(`无法映射旧组件「${component.role}」`)
        const occurrence = components.slice(0, index + 1).filter((item) => item.role === component.role).length
        return {
          id: `legacy-${index}`,
          label: `${component.role}-${String(occurrence).padStart(2, '0')}`,
          nodeType,
          contractVersion: LIBRARY_NODE_ADAPTERS[nodeType].contractVersion,
          required: false,
          multiple: false,
          titleTemplate: '{resource}-{slot}'
        }
      })
    }
  }
}

export interface LibraryNodePlan {
  componentId: string
  slotId: string
  nodeType: LibraryNodeType
  contractVersion: number
  title: string
  text?: string
}
export function planResourceNodes(
  category: LibraryCategory,
  components: LibraryResourceComponent[],
  title: string,
  selectedIds: string[],
  variables: Record<string, Record<string, string>> = {}
): LibraryNodePlan[] {
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length)
    throw new Error('请选择有效的资源内容')
  if (selectedIds.some((id) => !components.some((component) => component.id === id)))
    throw new Error('资源内容已变化，请重新选择')
  const mapped = components.map((component, index) =>
    category.id.startsWith('legacy-')
      ? { ...component, metadata: { ...component.metadata, librarySlotId: `legacy-${index}` } }
      : component
  )
  validateCategoryContent(category, mapped)
  return category.blueprint.slots.flatMap((slot) =>
    mapped
      .filter((component) => componentSlotId(component) === slot.id)
      .flatMap((component, index) => {
        if (!selectedIds.includes(component.id)) return []
        let text = component.text
        if (component.valueType === 'recipe') {
          text = (text ?? '').replace(
            /\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/g,
            (_match, key: string) => {
              const value = variables[component.id]?.[key]
              if (!value?.trim()) throw new Error(`请填写「${slot.label}」的变量 ${key}`)
              return value
            }
          )
        }
        if (slot.nodeType === 'json') {
          try {
            JSON.parse(text ?? '')
          } catch {
            throw new Error(`「${slot.label}」不是有效 JSON`)
          }
        }
        return [
          {
            componentId: component.id,
            slotId: slot.id,
            nodeType: slot.nodeType,
            contractVersion: slot.contractVersion,
            title: slot.titleTemplate.replace(
              /\{(resource|slot|index)\}/g,
              (_match, key: string) =>
                key === 'resource' ? title : key === 'slot' ? slot.label : String(index + 1)
            ),
            ...(text !== undefined ? { text } : {})
          }
        ]
      })
  )
}
