import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { newTraceId, newSpanId } from '../../shared/observability'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import {
  SkillPackageSchema,
  AgentRuntimeError,
  type FixedSkill
} from '../../shared/agent-flow/runtime-contracts'

/** Content only. Packages grant no scripts, network, shell or filesystem access. */
export class FlowSkillStore {
  constructor(private readonly db: Database.Database) {}

  import(raw: unknown): FixedSkill {
    return this.operation('import', () => this.importPackage(raw))
  }

  setEnabled(id: string, version: string, enabled: boolean): void {
    this.operation('enablement', () => this.changeEnabled(id, version, enabled))
  }

  list(): FixedSkill[] {
    return this.operation('list', () => {
      const rows = this.db
        .prepare(
          'SELECT skill_id, version, body_json FROM flow_skill_versions WHERE enabled=1 ORDER BY skill_id, version'
        )
        .all() as Array<{ skill_id: string; version: string; body_json: string }>
      return rows.map((row) => {
        const skill = SkillPackageSchema.parse(JSON.parse(row.body_json))
        return this.bindVersions(
          [{ id: row.skill_id, version: row.version }],
          skill.requiredTools
        )[0]
      })
    })
  }

  bind(
    bindings: Array<{ id: string; version: string }>,
    tools: Array<{ id: string; version: string }>
  ): FixedSkill[] {
    return this.operation('bind', () => this.bindVersions(bindings, tools))
  }

  private operation<T>(phase: string, run: () => T): T {
    const context = { traceId: newTraceId(), spanId: newSpanId() }
    emitGatewayEvent('skill.library.started', 'Skill 库操作开始', context, {
      attributes: { phase }
    })
    try {
      const result = run()
      emitGatewayEvent('skill.library.completed', 'Skill 库操作完成', context, {
        attributes: { phase },
        status: 'success'
      })
      return result
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : 'SKILL_STORAGE_FAILED'
      emitGatewayEvent('skill.library.failed', 'Skill 库操作失败', context, {
        attributes: { phase, code },
        status: 'failed'
      })
      throw error instanceof AgentRuntimeError ? error : new AgentRuntimeError(code, phase)
    }
  }

  private importPackage(raw: unknown): FixedSkill {
    const parsed = SkillPackageSchema.safeParse(raw)
    if (!parsed.success) throw new AgentRuntimeError('SKILL_PACKAGE_INVALID', 'skill-validation')
    const value = parsed.data
    const body = canonicalFlowJson(value)
    if (Buffer.byteLength(body) > 131072)
      throw new AgentRuntimeError('SKILL_PACKAGE_TOO_LARGE', 'skill-validation')
    const contentHash = `sha256:${createHash('sha256').update(body).digest('hex')}`
    return this.db.transaction(() => {
      const old = this.db
        .prepare('SELECT content_hash FROM flow_skill_versions WHERE skill_id=? AND version=?')
        .get(value.id, value.version) as { content_hash: string } | undefined
      if (old && old.content_hash !== contentHash)
        throw new AgentRuntimeError('SKILL_VERSION_IMMUTABLE', 'skill-version')
      if (!old)
        this.db
          .prepare('INSERT INTO flow_skill_versions VALUES (?, ?, ?, ?, 1)')
          .run(value.id, value.version, contentHash, body)
      return { ...value, contentHash }
    })()
  }

  private changeEnabled(id: string, version: string, enabled: boolean): void {
    if (
      !this.db
        .prepare('UPDATE flow_skill_versions SET enabled=? WHERE skill_id=? AND version=?')
        .run(Number(enabled), id, version).changes
    )
      throw new AgentRuntimeError('SKILL_MISSING', 'skill-lookup')
  }

  private bindVersions(
    bindings: Array<{ id: string; version: string }>,
    tools: Array<{ id: string; version: string }>
  ): FixedSkill[] {
    return bindings.map((binding) => {
      const row = this.db
        .prepare(
          'SELECT content_hash, body_json, enabled FROM flow_skill_versions WHERE skill_id=? AND version=?'
        )
        .get(binding.id, binding.version) as
        { content_hash: string; body_json: string; enabled: number } | undefined
      if (!row) throw new AgentRuntimeError('SKILL_MISSING', 'skill-lookup')
      if (!row.enabled) throw new AgentRuntimeError('SKILL_DISABLED', 'skill-lookup')
      if (`sha256:${createHash('sha256').update(row.body_json).digest('hex')}` !== row.content_hash)
        throw new AgentRuntimeError('SKILL_CONTENT_INVALID', 'skill-validation')
      const skill = SkillPackageSchema.parse(JSON.parse(row.body_json))
      if (
        skill.requiredTools.some(
          (required) =>
            !tools.some((tool) => tool.id === required.id && tool.version === required.version)
        )
      )
        throw new AgentRuntimeError('SKILL_TOOL_MISSING', 'skill-dependency')
      return { ...skill, contentHash: row.content_hash }
    })
  }
}

export const BUILTIN_FLOW_SKILLS = ['material-analysis', 'json-organize', 'result-check'].map(
  (id) => ({
    schemaVersion: 1 as const,
    id,
    version: '1',
    name: {
      'material-analysis': '材料分析',
      'json-organize': 'JSON 整理',
      'result-check': '结果检查'
    }[id]!,
    description: '按固定输入和真实回执处理材料；缺少能力时明确说明，禁止猜测已执行。',
    instructions: {
      'material-analysis':
        '提取材料的事实、问题和不确定项。使用指定能力节点，逐项核对来源；不得编造材料之外的事实。',
      'json-organize':
        '先确定字段和类型，再整理 JSON；核对必填项、来源和不确定值。只有实际能力节点的固定资产版本可以作为成果。',
      'result-check':
        '检查工具回执和资产引用是否存在，核对输入和目标；发现失败不得宣称完成。无法达到目标时停止并明确等待原因。'
    }[id]!,
    requiredTools: [{ id: 'node.execute', version: '1' }],
    resources: {
      'examples.md':
        '成功：处理器回执 committed 且包含 out-value 固定版本。失败：只有文字声称成功、pending、unknown 或失败回执，均不可提交为成果。'
    }
  })
)
