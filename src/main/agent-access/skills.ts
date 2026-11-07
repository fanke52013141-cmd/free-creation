import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import {
  parseSkillBundleUpload,
  parseSkillUpload,
  skillAgentConfig,
  SKILL_AGENT_TOOLS
} from '../../shared/skill-agent'
import { SkillPackageSchema, type FixedSkill } from '../../shared/agent-flow/runtime-contracts'
import { FlowSkillStore } from '../agent-flow/skill-store'
import { getDb } from '../store/db'
import type { CanvasNode } from '../../shared/types'

export function skillSummary(skill: FixedSkill): {
  id: string
  version: string
  name: string
  description: string
  contentHash: string
} {
  return {
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    contentHash: skill.contentHash
  }
}

/** Reuses the desktop content-only parsers. Bounded reads, no links or executable dependencies. */
export function installAccessSkill(source: string, name: string): FixedSkill {
  if (!isAbsolute(source)) throw new Error('SKILL_PATH_INVALID')
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error('SKILL_PATH_INVALID')
  let bytes = 0
  const read = (path: string): string => {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink() || (bytes += file.size) > 131072)
      throw new Error('SKILL_PACKAGE_INVALID')
    const content = readFileSync(path, 'utf8')
    if (Buffer.byteLength(content) > 131072) throw new Error('SKILL_PACKAGE_INVALID')
    return content
  }
  const parsed = stat.isDirectory()
    ? (() => {
        const files = readdirSync(source)
        if (files.length > 17) throw new Error('SKILL_PACKAGE_INVALID')
        return parseSkillBundleUpload(
          files.map((path) => ({ path, content: read(join(source, path)) }))
        )
      })()
    : (() => {
        if (!/\.(md|json)$/i.test(source)) throw new Error('SKILL_PACKAGE_INVALID')
        return parseSkillUpload(basename(source), read(source))
      })()
  const skill = SkillPackageSchema.parse({ ...parsed, name })
  // Reject unsupported tool requirements before adding an unusable skill to the library.
  skillAgentConfig({ skills: [skill] })
  return new FlowSkillStore(getDb()).import(skill)
}

export function accessSkillAgent(input: {
  skills: Array<{ id: string; version: string }>
  maxSteps: number
}): ReturnType<typeof skillAgentConfig> {
  const fixed = new FlowSkillStore(getDb()).bind(input.skills, SKILL_AGENT_TOOLS)
  return skillAgentConfig({
    skills: fixed.map((skill) =>
      SkillPackageSchema.parse({
        schemaVersion: skill.schemaVersion,
        id: skill.id,
        version: skill.version,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        requiredTools: skill.requiredTools,
        resources: skill.resources
      })
    ),
    maxSteps: input.maxSteps
  })
}

export function chatNodeAgent(node: CanvasNode): ReturnType<typeof skillAgentConfig> {
  if (node.type !== 'chat') throw new Error('CHAT_NODE_REQUIRED')
  const config: unknown = JSON.parse(String(node.params.config || '{}'))
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('CHAT_CONFIG_INVALID')
  return skillAgentConfig((config as Record<string, unknown>).agent)
}
