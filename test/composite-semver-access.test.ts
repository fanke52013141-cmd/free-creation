import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAccessService } from '../src/main/agent-access/service'
import { closeDb } from '../src/main/store/db'
import {
  ACCESS_OPERATIONS,
  operationResponseSchema,
  operationSpec,
  validateAccessRegistry,
  type AccessOperationId
} from '../src/shared/agent-access/registry'
import { COMPOSITE_OPERATIONS } from '../src/shared/agent-access/ops/composite'
import type { CompositeManifest } from '../src/shared/composite/manifest'

function buildManifest(version: string): CompositeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: 2,
    capabilityId: 'minor-version-flow',
    version,
    name: '次版本节点流',
    inputs: [
      {
        id: 'copy',
        label: '输入文案',
        type: 'text',
        required: true,
        cardinality: 'one',
        targets: [{ nodeId: 'n1', portId: 'in-text' }]
      }
    ],
    outputs: [
      {
        id: 'result',
        label: '输出文案',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'n1', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'n1',
          nodeType: 'text',
          contractVersion: 3,
          title: '文本节点',
          dx: 0,
          dy: 0,
          w: 340,
          h: 300,
          ports: [
            {
              id: 'in-text',
              name: '文本输入',
              dir: 'in',
              type: 'text',
              required: false,
              cardinality: 'many'
            },
            {
              id: 'out-text',
              name: '文本输出',
              dir: 'out',
              type: 'text',
              required: true,
              cardinality: 'one'
            }
          ]
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'text', contractVersion: 3 }]
  }
}

describe('BL-34 / NF-11.2 节点流 major.minor 外部契约一致性', () => {
  it('composite.* 入参与出参 Schema 放行 1.1 等 minor 版本，并兼容历史 1.0 / 1.0.0', async () => {
    for (const valid of ['1.0', '1.1', '2.15', '1.0.0']) {
      expect(
        COMPOSITE_OPERATIONS['composite.get'].input.safeParse({
          capabilityId: 'minor-version-flow',
          version: valid
        }).success,
        `composite.get should accept ${valid}`
      ).toBe(true)
      expect(
        COMPOSITE_OPERATIONS['composite.execute'].input.safeParse({
          capabilityId: 'minor-version-flow',
          version: valid,
          confirmCost: true
        }).success,
        `composite.execute should accept ${valid}`
      ).toBe(true)
    }
    for (const invalid of ['1', 'v1.1', '1.1.2', '1.0.1']) {
      expect(
        COMPOSITE_OPERATIONS['composite.get'].input.safeParse({
          capabilityId: 'minor-version-flow',
          version: invalid
        }).success,
        `composite.get should reject ${invalid}`
      ).toBe(false)
    }

    const directory = mkdtempSync(join(tmpdir(), 'canvas-composite-semver-'))
    const priorDirectory = process.env.CANVAS_DATA_DIR
    process.env.CANVAS_DATA_DIR = directory
    try {
      const service = new LocalAccessService({
        instanceId: 'composite-semver-test',
        appVersion: 'test',
        exportDirectory: join(directory, 'exports'),
        activeProjectId: () => null,
        desktop: {
          async run() {
            return {}
          },
          async ask() {
            return { authorized: false, code: 'NOT_USED' }
          }
        }
      })
      const call = async (operationId: AccessOperationId, input: Record<string, unknown>) => {
        const res = await service.dispatch({
          apiVersion: 1,
          operationVersion: 1,
          operationId,
          requestId: randomUUID(),
          idempotencyKey: `${Date.now()}:${randomUUID()}`,
          expectedDataStoreId: service.dataStoreId,
          input
        })
        expect(
          operationResponseSchema(operationId).safeParse(res).success,
          `${operationId} response schema failed: ${JSON.stringify(res)}`
        ).toBe(true)
        return res
      }

      const v10 = await call('composite.publish', { manifest: buildManifest('1.0') })
      expect(v10.status).toBe('completed')

      const v11 = await call('composite.publish', { manifest: buildManifest('1.1') })
      expect(v11.status).toBe('completed')
      expect(v11.data).toMatchObject({ capabilityId: 'minor-version-flow', version: '1.1' })

      const searched = await call('composite.search', { query: 'minor-version-flow' })
      expect(searched.status).toBe('completed')
      expect(searched.data).toMatchObject({
        items: [expect.objectContaining({ id: 'minor-version-flow', latestVersion: '1.1' })]
      })

      const got = await call('composite.get', { capabilityId: 'minor-version-flow', version: '1.1' })
      expect(got.status).toBe('completed')
      expect(got.data).toMatchObject({ capabilityId: 'minor-version-flow', version: '1.1' })

      const unconfirmed = await call('composite.execute', {
        capabilityId: 'minor-version-flow',
        version: '1.1',
        inputs: [{ portId: 'in-copy', value: { kind: 'text', text: '测试' } }]
      })
      expect(unconfirmed.status).toBe('failed')
      expect(unconfirmed.error?.code).toBe('COST_CONFIRM_REQUIRED')

      const executed = await call('composite.execute', {
        capabilityId: 'minor-version-flow',
        version: '1.1',
        inputs: [{ portId: 'in-copy', value: { kind: 'text', text: '测试' } }],
        confirmCost: true
      })
      expect(executed.status).toBe('completed')
      expect(executed.data).toMatchObject({ capabilityId: 'minor-version-flow', version: '1.1' })
    } finally {
      closeDb()
      if (priorDirectory === undefined) delete process.env.CANVAS_DATA_DIR
      else process.env.CANVAS_DATA_DIR = priorDirectory
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('BL-37 深化：注册表不变量成立，常规可逆写/导出不标 destructive，删除/不可逆恢复标 destructive', () => {
    expect(validateAccessRegistry()).toEqual([])
    for (const nonDestructive of [
      'project.open',
      'project.save',
      'project.rename',
      'project.export',
      'graph.patch',
      'graph.layout',
      'media.import',
      'composite.draft.save',
      'composite.publish',
      'composite.execute'
    ] as const) {
      expect(operationSpec(nonDestructive).destructive, nonDestructive).toBe(false)
    }
    for (const destructive of [
      'project.delete',
      'media.delete',
      'composite.delete',
      'composite.archive',
      'history.restore',
      'run.cancel'
    ] as const) {
      expect(operationSpec(destructive).destructive, destructive).toBe(true)
    }
    for (const id of Object.keys(ACCESS_OPERATIONS) as AccessOperationId[]) {
      const spec = operationSpec(id)
      if (spec.effect === 'read') {
        expect(spec.destructive, id).toBe(false)
        expect(spec.idempotent, id).toBe(true)
        expect(spec.cost, id).toBe('none')
      }
      if (spec.effect === 'delete') expect(spec.destructive, id).toBe(true)
      if (spec.effect === 'export') expect(spec.destructive, id).toBe(false)
    }
  })
})
