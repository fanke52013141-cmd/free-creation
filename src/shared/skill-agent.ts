import { z } from 'zod'
import { SkillPackageSchema, type SkillPackage } from './agent-flow/runtime-contracts'

export const SkillAgentConfigSchema = z
  .object({
    skills: z.array(SkillPackageSchema).max(8).default([]),
    maxSteps: z.number().int().min(1).max(12).default(6)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.skills.map((skill) => skill.id)).size !== value.skills.length ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144
    )
      context.addIssue({ code: 'custom', message: '技能重复或总大小超过限制' })
  })
export type SkillAgentConfig = z.infer<typeof SkillAgentConfigSchema>
export const SKILL_AGENT_TOOLS = [{ id: 'skill.read-resource', version: '1' }]
/** 出厂内置技能 id 清单（内容技能 + 流程示范包）；列表 UI 用「内置」徽标区分用户上传。 */
export const BUILTIN_SKILL_IDS: ReadonlySet<string> = new Set([
  'content-analysis',
  'content-organize',
  'material-analysis',
  'json-organize',
  'result-check'
])
export const BUILTIN_CONTENT_SKILLS: SkillPackage[] = [
  {
    schemaVersion: 1,
    id: 'content-analysis',
    version: '1',
    name: '内容分析',
    description: '提取输入事实、结构和不确定项。',
    instructions:
      '根据输入提取事实、关键问题与不确定项，检查是否遗漏；不得编造未提供的事实。直接输出符合任务要求的结果。',
    requiredTools: [],
    resources: {}
  },
  {
    schemaVersion: 1,
    id: 'content-organize',
    version: '1',
    name: '内容整理',
    description: '按指定格式整理文本、Markdown 或 JSON。',
    instructions:
      '先确定任务要求的字段、类型和格式，再整理输入。核对必填项和来源，最终只提交所要求的正文；不添加确认问题。',
    requiredTools: [],
    resources: {}
  }
]

/** Missing settings preserve legacy nodes. Invalid explicit settings must fail at execution. */
export function skillAgentConfig(raw: unknown): SkillAgentConfig {
  const parsed = SkillAgentConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new Error('Agent 技能配置无效，请重新选择技能')
  for (const skill of parsed.data.skills) {
    if (
      skill.requiredTools.some(
        (required) =>
          !SKILL_AGENT_TOOLS.some(
            (tool) => tool.id === required.id && tool.version === required.version
          )
      )
    )
      throw new Error(`技能“${skill.name}”需要当前节点不支持的工具`)
  }
  return parsed.data
}

export function skillAgentInstructions(config: SkillAgentConfig, includeResources = false): string {
  return config.skills
    .map((skill) =>
      [
        `技能 ${skill.id}@${skill.version}（${skill.name}）\n${skill.instructions}`,
        includeResources
          ? Object.entries(skill.resources)
              .map(([name, text]) => `参考资源 ${name}：\n${text}`)
              .join('\n\n')
          : `可读取资源：${Object.keys(skill.resources).join('、') || '无'}`
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n')
}

function fingerprint(text: string): string {
  let value = 2166136261
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return (value >>> 0).toString(16)
}

/** Markdown frontmatter is single-line name/description/version only; tools use a JSON manifest. */
function parseSkillMarkdown(content: string): {
  instructions: string
  fields: Record<string, string>
} {
  let instructions = content.replace(/^\uFEFF/, '').trim()
  const fields: Record<string, string> = {}
  if (instructions.startsWith('---\n') || instructions.startsWith('---\r\n')) {
    const match = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (!match) throw new Error('SKILL.md 的元数据未闭合')
    for (const line of match[1].split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      const field = line.match(/^([\w-]+):\s*(.*?)\s*$/)
      if (
        !field ||
        !['name', 'description', 'version'].includes(field[1]) ||
        !field[2] ||
        /^[>|]/.test(field[2])
      )
        throw new Error(
          'Markdown 元数据仅支持单行 name、description、version；工具依赖请使用 JSON 包'
        )
      fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2')
    }
    instructions = instructions.slice(match[0].length).trim()
  }
  return { instructions, fields }
}

/** Markdown skills are content only; executable dependencies must use a JSON manifest. */
export function parseSkillUpload(name: string, content: string): SkillPackage {
  if (new TextEncoder().encode(content).byteLength > 131072) throw new Error('技能文件超过 128 KiB')
  if (/\.json$/i.test(name)) return SkillPackageSchema.parse(JSON.parse(content))
  if (!/\.md$/i.test(name)) throw new Error('请选择 SKILL.md 或 JSON 技能包')
  const { instructions, fields } = parseSkillMarkdown(content)
  const title = fields.name || name.replace(/\.md$/i, '')
  return SkillPackageSchema.parse({
    schemaVersion: 1,
    id: `uploaded-${fingerprint(title)}`,
    version: fields.version || `md-${fingerprint(content)}`,
    name: title,
    description: fields.description || '用户上传的内容处理技能',
    instructions,
    requiredTools: [],
    resources: {}
  })
}

/**
 * P2 Skill 扩展：受控的技能目录包。输入是相对路径 → 文本内容的条目列表
 * （renderer 从 webkitRelativePath 收集），只接受根部一个 SKILL.md 加至多 16 个
 * 扁平 .md 参考资源——与 SkillPackageSchema 的资源键格式一致；嵌套目录、
 * 路径穿越、绝对路径、非 Markdown 资源全部显式拒绝。版本对全部文件内容寻址，
 * 任何文件变化都会产生新版本（版本完整性），不做部分安装。
 */
export function parseSkillBundleUpload(
  entries: Array<{ path: string; content: string }>
): SkillPackage {
  if (entries.length === 0) throw new Error('技能目录为空')
  if (entries.length > 17) throw new Error('技能目录最多 1 个 SKILL.md 加 16 个 .md 参考资源')
  let totalBytes = 0
  const normalized: Array<{ path: string; content: string }> = []
  for (const entry of entries) {
    const path = String(entry.path ?? '').replaceAll('\\', '/')
    if (!path || path.includes('\u0000')) throw new Error(`技能文件路径无效：${path || '(空)'}`)
    if (/^([A-Za-z]:)?\//.test(path)) throw new Error(`技能文件不允许绝对路径：${path}`)
    const segments = path.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`技能文件路径不允许穿越目录：${path}`)
    }
    if (segments.length > 1) {
      throw new Error(`参考资源必须位于技能目录根部：${path}`)
    }
    const bytes = new TextEncoder().encode(entry.content ?? '').byteLength
    totalBytes += bytes
    if (totalBytes > 131072) throw new Error('技能目录总大小超过 128 KiB')
    normalized.push({ path, content: String(entry.content ?? '') })
  }
  const skillEntry = normalized.find((entry) => entry.path === 'SKILL.md')
  if (!skillEntry) throw new Error('技能目录必须包含根部的 SKILL.md')
  const { instructions, fields } = parseSkillMarkdown(skillEntry.content)
  const resources: Record<string, string> = {}
  for (const entry of normalized) {
    if (entry.path === 'SKILL.md') continue
    const key = entry.path.split('/').at(-1) ?? ''
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(key)) {
      throw new Error(`参考资源只支持扁平的 .md 文件名：${entry.path}`)
    }
    if (resources[key] !== undefined) throw new Error(`参考资源重名：${key}`)
    resources[key] = entry.content
  }
  const digest = fingerprint(
    normalized
      .map((entry) => `${entry.path}\u0000${entry.content}`)
      .sort()
      .join('\u0001')
  )
  const title = fields.name || '目录技能包'
  return SkillPackageSchema.parse({
    schemaVersion: 1,
    id: `uploaded-${fingerprint(title)}`,
    version: fields.version || `bundle-${digest}`,
    name: title,
    description: fields.description || '用户上传的目录技能包',
    instructions,
    requiredTools: [],
    resources
  })
}
