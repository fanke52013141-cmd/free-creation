import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import { AgentNodeConfigSchema } from '../../shared/agent-flow/node-contracts'
import {
  FlowDefinitionSchema,
  definitionContent,
  diffDefinitions,
  type FlowDefinition,
  type DefinitionDiff
} from '../../shared/agent-flow/flow-definition'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

interface DefinitionRow {
  project_id: string
  definition_id: string
  version: number
  body_json: string
  content_hash: string
  created_at: number
}

/**
 * AF-06：流程定义版本存储（不可变；与运行分离）。定义快照来自固定顺序主控的已保存配置，
 * 只存阶段/方法/输入/进入条件等定义内容，不存运行正文或产物。
 */
export class FlowDefinitionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null
  ) {}

  /** 从主控节点已保存配置发布一个新定义版本（版本递增；内容相同也允许新版本以便评测）。 */
  publish(input: {
    projectId: string
    definitionId: string
    name: string
    coordinatorNodeId: string
  }): FlowDefinition {
    const file = this.open(input.projectId)
    if (!file) throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'definition')
    const shape = (
      file.tldrawSnapshot as {
        store: Record<string, { props: { nodeType: string; config: string; text: string } }>
      }
    ).store[input.coordinatorNodeId]
    if (!shape || shape.props.nodeType !== 'agent')
      throw new AgentRuntimeError('FLOW_DEFINITION_NODE_INVALID', 'definition')
    const config = AgentNodeConfigSchema.parse(JSON.parse(shape.props.config))
    if (config.executionMode !== 'fixed-order' || !config.stages)
      throw new AgentRuntimeError('FLOW_DEFINITION_NOT_FIXED_ORDER', 'definition')
    const content = definitionContent({
      name: input.name,
      coordinatorGoal: shape.props.text,
      stages: config.stages
    })
    const contentHash = sha256(canonicalFlowJson(content))
    const last = this.db
      .prepare(
        'SELECT MAX(version) AS version FROM flow_definitions WHERE project_id=? AND definition_id=?'
      )
      .get(input.projectId, input.definitionId) as { version: number | null }
    const version = (last.version ?? 0) + 1
    const definition = FlowDefinitionSchema.parse({
      schemaVersion: 1,
      definitionId: input.definitionId,
      version,
      name: input.name,
      coordinatorGoal: content.coordinatorGoal,
      stages: content.stages,
      contentHash,
      createdAt: Date.now()
    })
    this.db
      .prepare('INSERT INTO flow_definitions VALUES (?,?,?,?,?,?)')
      .run(
        input.projectId,
        input.definitionId,
        version,
        JSON.stringify(definition),
        contentHash,
        definition.createdAt
      )
    return definition
  }

  get(projectId: string, definitionId: string, version?: number): FlowDefinition | null {
    const row = (
      version === undefined
        ? this.db
            .prepare(
              'SELECT * FROM flow_definitions WHERE project_id=? AND definition_id=? ORDER BY version DESC LIMIT 1'
            )
            .get(projectId, definitionId)
        : this.db
            .prepare(
              'SELECT * FROM flow_definitions WHERE project_id=? AND definition_id=? AND version=?'
            )
            .get(projectId, definitionId, version)
    ) as DefinitionRow | undefined
    return row ? FlowDefinitionSchema.parse(JSON.parse(row.body_json)) : null
  }

  list(projectId: string): FlowDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flow_definitions WHERE project_id=? AND version=(
           SELECT MAX(version) FROM flow_definitions f2
           WHERE f2.project_id=flow_definitions.project_id AND f2.definition_id=flow_definitions.definition_id
         ) ORDER BY definition_id`
      )
      .all(projectId) as DefinitionRow[]
    return rows.map((row) => FlowDefinitionSchema.parse(JSON.parse(row.body_json)))
  }

  diff(
    projectId: string,
    definitionId: string,
    versionA: number,
    versionB: number
  ): DefinitionDiff {
    const a = this.get(projectId, definitionId, versionA)
    const b = this.get(projectId, definitionId, versionB)
    if (!a || !b) throw new AgentRuntimeError('FLOW_DEFINITION_MISSING', 'definition')
    return diffDefinitions(definitionContent(a), definitionContent(b))
  }
}
