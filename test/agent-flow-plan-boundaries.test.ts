import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowSkillStore, BUILTIN_FLOW_SKILLS } from '../src/main/agent-flow/skill-store'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema,
  DEFAULT_AGENT_NODE_CONFIG,
  DEFAULT_REVIEW_NODE_CONFIG
} from '../src/shared/agent-flow/node-contracts'
import { BuildPlanSchema } from '../src/shared/agent-flow/builder'

// Explicit parameters from the 2026-10-16 acceptance plan. No provider requests.
describe('CFG-04 config admission boundaries (schema layer)', () => {
  it.each([
    [0, false],
    [1, true],
    [64, true],
    [65, false]
  ])('maxSteps=%i accepted=%s', (maxSteps, accepted) => {
    expect(
      AgentNodeConfigSchema.safeParse({ ...DEFAULT_AGENT_NODE_CONFIG, maxSteps }).success
    ).toBe(accepted)
  })
  it.each([
    [0, false],
    [1, true],
    [4, true],
    [5, false]
  ])('maxParallelTasks=%i accepted=%s', (maxParallelTasks, accepted) => {
    expect(
      AgentNodeConfigSchema.safeParse({ ...DEFAULT_AGENT_NODE_CONFIG, maxParallelTasks }).success
    ).toBe(accepted)
  })
})
describe('REV-07 manual rework admission boundaries (schema layer)', () => {
  it.each([
    [0, true],
    [1, true],
    [10, true],
    [11, false]
  ])('maxReworks=%i accepted=%s', (maxReworks, accepted) => {
    expect(
      ReviewNodeConfigSchema.safeParse({ ...DEFAULT_REVIEW_NODE_CONFIG, maxReworks }).success
    ).toBe(accepted)
  })
})
const step = { title: 'isolated', goal: 'format input', mode: 'autonomous', template: '{{value}}' }
describe('BLD-04 bounded topology admission', () => {
  it.each([
    [1, true],
    [4, true],
    [5, false]
  ])('sequential steps=%i accepted=%s', (count, accepted) => {
    expect(
      BuildPlanSchema.safeParse({
        title: 'test',
        topology: 'sequential',
        steps: Array(count).fill(step)
      }).success
    ).toBe(accepted)
  })
  it.each([
    [1, false],
    [2, true],
    [3, true],
    [4, true],
    [5, false]
  ])('parallel branches=%i accepted=%s', (count, accepted) => {
    expect(
      BuildPlanSchema.safeParse({
        title: 'test',
        topology: 'parallel-fork',
        steps: Array(count).fill(step)
      }).success
    ).toBe(accepted)
  })
})
describe('BLD-06 builder review admission', () => {
  it.each(['text-template@1', 'video@7', 'image-gen@3', 'image-edit@2', 'speech@4', 'tts@4'])(
    'capability=%s',
    (capability) => {
      const item = {
        title: 'test',
        goal: 'test',
        mode: 'autonomous',
        capability,
        review: { criteria: 'test', maxReworks: 1 },
        ...(capability === 'text-template@1'
          ? { template: '{{value}}' }
          : ['image-gen@3', 'image-edit@2', 'video@7'].includes(capability)
            ? { instruction: 'test' }
            : {})
      }
      const prefix =
        capability === 'image-edit@2'
          ? [
              {
                title: 'image',
                goal: 'image',
                mode: 'autonomous',
                capability: 'image-gen@3',
                instruction: 'test'
              }
            ]
          : capability === 'tts@4'
            ? [{ title: 'audio', goal: 'audio', mode: 'autonomous', capability: 'speech@4' }]
            : []
      expect(BuildPlanSchema.safeParse({ title: 'test', steps: [...prefix, item] }).success).toBe(
        ['text-template@1', 'video@7'].includes(capability)
      )
    }
  )
  it.each([
    [0, true],
    [3, true],
    [4, false]
  ])('builder maxReworks=%i accepted=%s', (maxReworks, accepted) => {
    expect(
      BuildPlanSchema.safeParse({
        title: 'test',
        steps: [{ ...step, review: { criteria: 'test', maxReworks } }]
      }).success
    ).toBe(accepted)
  })
})
const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function library() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  return { db, store: new FlowSkillStore(db) }
}
describe('SKL-02 same-version content immutability', () => {
  it('deduplicates identical content and retains the original binding after a conflicting import', () => {
    const { db, store } = library()
    const skill = BUILTIN_FLOW_SKILLS[2]
    const original = store.import(skill)
    expect(store.import(skill)).toEqual(original)
    expect(() => store.import({ ...skill, instructions: skill.instructions + 'x' })).toThrow(
      'SKILL_VERSION_IMMUTABLE'
    )
    expect(store.bind([{ id: skill.id, version: skill.version }], skill.requiredTools)).toEqual([
      original
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({ n: 1 })
  })
})
describe('SKL-08 atomic Skill capacity and UTF-8 admission', () => {
  it.each([32768, 32769])('resource character length=%i', (length) => {
    const { db, store } = library()
    const value = { ...BUILTIN_FLOW_SKILLS[0], resources: { 'large.md': 'x'.repeat(length) } }
    if (length === 32768) expect(store.import(value).resources['large.md'].length).toBe(length)
    else expect(() => store.import(value)).toThrow('SKILL_PACKAGE_INVALID')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({
      n: length === 32768 ? 1 : 0
    })
  })
  it.each([131071, 131072, 131073])('total ASCII package characters=%i', (characters) => {
    const { db, store } = library()
    const value = {
      ...BUILTIN_FLOW_SKILLS[0],
      name: 'ascii-only',
      description: 'ascii-only',
      instructions: 'x'.repeat(32768),
      resources: { 'a.md': 'x'.repeat(32768), 'b.md': 'x'.repeat(32768), 'c.md': '' }
    }
    value.resources['c.md'] = 'x'.repeat(characters - JSON.stringify(value).length)
    expect(value.resources['c.md'].length).toBeLessThan(32768)
    expect(JSON.stringify(value).length).toBe(characters)
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(characters)
    if (characters <= 131072) expect(store.import(value).contentHash).toMatch(/^sha256:/)
    else expect(() => store.import(value)).toThrow('SKILL_PACKAGE_INVALID')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({
      n: characters <= 131072 ? 1 : 0
    })
  })
  it.each([131071, 131072, 131073])('total UTF-8 bytes=%i', (bytes) => {
    const { db, store } = library()
    const value = {
      ...BUILTIN_FLOW_SKILLS[0],
      instructions: '中'.repeat(32768),
      resources: { 'boundary.md': '' }
    }
    value.resources['boundary.md'] = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(value)))
    expect(value.resources['boundary.md'].length).toBeLessThan(32768)
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes)
    expect(JSON.stringify(value).length).toBeLessThan(131072)
    if (bytes <= 131072) expect(store.import(value).contentHash).toMatch(/^sha256:/)
    else expect(() => store.import(value)).toThrow('SKILL_PACKAGE_TOO_LARGE')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({
      n: bytes <= 131072 ? 1 : 0
    })
  })
  it.each([
    [16, true],
    [17, false]
  ])('resources=%i accepted=%s', (count, accepted) => {
    const { db, store } = library()
    const value = {
      ...BUILTIN_FLOW_SKILLS[0],
      resources: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`r${i}.md`, 'content'])
      )
    }
    if (accepted) expect(store.import(value).contentHash).toMatch(/^sha256:/)
    else expect(() => store.import(value)).toThrow('SKILL_PACKAGE_INVALID')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({
      n: accepted ? 1 : 0
    })
  })
  it.each([32768, 32769])('instruction length=%i', (length) => {
    const { db, store } = library()
    const value = { ...BUILTIN_FLOW_SKILLS[0], instructions: 'x'.repeat(length) }
    if (length === 32768) expect(store.import(value).instructions.length).toBe(length)
    else expect(() => store.import(value)).toThrow('SKILL_PACKAGE_INVALID')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({
      n: length === 32768 ? 1 : 0
    })
  })
  it('rejects UTF-8 byte overflow although character limits pass, leaving no rows', () => {
    const { db, store } = library()
    const value = {
      ...BUILTIN_FLOW_SKILLS[0],
      instructions: '中'.repeat(32768),
      resources: { 'large.md': '文'.repeat(32768) }
    }
    expect(JSON.stringify(value).length).toBeLessThan(131072)
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(131072)
    expect(() => store.import(value)).toThrow('SKILL_PACKAGE_TOO_LARGE')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({ n: 0 })
  })
  it('rejects duplicate required tools without a partial library entry', () => {
    const { db, store } = library()
    const value = {
      ...BUILTIN_FLOW_SKILLS[0],
      requiredTools: [
        { id: 'execute-node', version: '1' },
        { id: 'execute-node', version: '2' }
      ]
    }
    expect(() => store.import(value)).toThrow('SKILL_PACKAGE_INVALID')
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_skill_versions').get()).toEqual({ n: 0 })
  })
})
