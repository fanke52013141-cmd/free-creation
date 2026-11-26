import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalAccessService } from '../src/main/agent-access/service'
import { publishCompositeVersion } from '../src/main/store/composite.repo'
import {
  createCompositeRun,
  finishCompositeRun,
  getCompositeRun,
  waitCompositeRun
} from '../src/main/store/composite-run.repo'
import {
  getOpenCompositeRunWait,
  getSatisfiedHumanSubmissions,
  openCompositeRunWait
} from '../src/main/store/composite-run-wait.repo'
import { closeDb, getDb } from '../src/main/store/db'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import type { CompositeManifest } from '../src/shared/composite/manifest'

let directory: string
const originalDirectory = process.env.CANVAS_DATA_DIR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-human-gates-'))
  process.env.CANVAS_DATA_DIR = directory
  migrateDatabase(getDb())
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

function humanManifest(): CompositeManifest {
  return {
    schemaVersion: 1,
    capabilityId: 'human-gate',
    version: '1.0',
    name: '人工门禁',
    inputs: [],
    outputs: [
      {
        id: 'result',
        label: '结果',
        type: 'text',
        required: true,
        cardinality: 'one',
        source: { nodeId: 'h1', portId: 'out-text' }
      }
    ],
    graph: {
      nodes: [
        {
          id: 'h1',
          nodeType: 'human-task',
          contractVersion: 1,
          title: '人工提交',
          dx: 0,
          dy: 0,
          w: 340,
          h: 260,
          ports: [
            { id: 'in-text', name: '输入', dir: 'in', type: 'text', required: false, cardinality: 'one' },
            { id: 'out-text', name: '结果', dir: 'out', type: 'text', required: true, cardinality: 'one' }
          ],
          config: JSON.stringify({ schemaVersion: 1, outputType: 'text' })
        }
      ],
      edges: []
    },
    dependencies: [{ kind: 'node', id: 'human-task', contractVersion: 1 }],
    executionPolicy: { requiresManualGate: true }
  }
}

function dispatch(service: LocalAccessService, operationId: string, input: Record<string, unknown>) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    requestId: randomUUID(),
    idempotencyKey: `${Date.now()}:${randomUUID()}`,
    expectedDataStoreId: service.dataStoreId,
    input
  })
}

describe('外部人工决定门禁', () => {
  it('composite.run.submitHuman 拒绝时不满足人工等待', async () => {
    const { record } = await publishCompositeVersion(humanManifest())
    const runId = randomUUID()
    createCompositeRun({
      id: runId,
      projectId: 'human-gate-project',
      capabilityId: record.manifest.capabilityId,
      capabilityVersion: record.manifest.version,
      contentHash: record.contentHash,
      inputValues: {}
    })
    waitCompositeRun({ runId, stepKey: 'h1' })
    openCompositeRunWait({ requestId: `${runId}:h1`, runId, stepKey: 'h1', kind: 'human', fields: [] })

    const asks: unknown[] = []
    const service = new LocalAccessService({
      instanceId: 'human-gate-test',
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => 'human-gate-project',
      desktop: {
        async ask(input) {
          asks.push(input)
          return { authorized: false, code: 'HUMAN_DENIED' }
        },
        async run() {
          return {}
        }
      }
    })

    const response = await dispatch(service, 'composite.run.submitHuman', {
      runId,
      nodeId: 'h1',
      value: { kind: 'text', text: '外部伪造结果' }
    })
    expect(response.error?.code).toBe('HUMAN_DENIED')
    expect(asks).toHaveLength(1)
    expect(getOpenCompositeRunWait(runId)?.state).toBe('open')
    expect(getSatisfiedHumanSubmissions(runId)).toEqual({})
  })

  it('composite.run.submitHuman 确认后才满足人工等待', async () => {
    const { record } = await publishCompositeVersion(humanManifest())
    const runId = randomUUID()
    createCompositeRun({
      id: runId,
      projectId: 'human-gate-project',
      capabilityId: record.manifest.capabilityId,
      capabilityVersion: record.manifest.version,
      contentHash: record.contentHash,
      inputValues: {}
    })
    waitCompositeRun({ runId, stepKey: 'h1' })
    openCompositeRunWait({ requestId: `${runId}:h1`, runId, stepKey: 'h1', kind: 'human', fields: [] })

    const service = new LocalAccessService({
      instanceId: 'human-gate-test',
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => 'human-gate-project',
      desktop: {
        async ask() {
          return { authorized: true }
        },
        async run() {
          return {}
        }
      }
    })

    const response = await dispatch(service, 'composite.run.submitHuman', {
      runId,
      nodeId: 'h1',
      value: { kind: 'text', text: '人工确认结果' }
    })
    expect(response.error).toBeUndefined()
    expect(getOpenCompositeRunWait(runId)).toBeNull()
    expect(getSatisfiedHumanSubmissions(runId)).toEqual({
      h1: { kind: 'text', text: '人工确认结果' }
    })
  })

  it('composite.run.resubmit 拒绝时不改写失败运行', async () => {
    const { record } = await publishCompositeVersion(humanManifest())
    const runId = randomUUID()
    createCompositeRun({
      id: runId,
      projectId: 'human-gate-project',
      capabilityId: record.manifest.capabilityId,
      capabilityVersion: record.manifest.version,
      contentHash: record.contentHash,
      inputValues: {}
    })
    finishCompositeRun({ runId, status: 'failed', failurePhase: 'step' })

    const service = new LocalAccessService({
      instanceId: 'human-gate-test',
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => 'human-gate-project',
      desktop: {
        async ask() {
          return { authorized: false, code: 'HUMAN_DENIED' }
        },
        async run() {
          return {}
        }
      }
    })

    const response = await dispatch(service, 'composite.run.resubmit', {
      runId,
      outputs: [{ portId: 'out-result', value: { kind: 'text', text: '外部补交' } }]
    })
    expect(response.error?.code).toBe('HUMAN_DENIED')
    expect(getCompositeRun(runId)?.run.status).toBe('failed')
  })

  it('flowStateMachine.submitEvent 拒绝时不写 pending、不调用桌面执行', async () => {
    const project = createProject('state-machine-human-gate')
    const config = JSON.stringify({ schemaVersion: 1, initialState: 'idle', transitions: [] })
    saveProject({
      id: project.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{
          id: 'shape:sm',
          type: 'state-machine',
          contractVersion: 1,
          ports: [],
          props: { title: '状态机', config },
          x: 0,
          y: 0
        }],
        edges: [],
        groups: []
      },
      tldrawSnapshot: {
        store: {
          'shape:sm': {
            id: 'shape:sm',
            type: 'node-card',
            props: { nodeType: 'state-machine', title: '状态机', config }
          }
        }
      }
    })

    const runs: unknown[] = []
    const service = new LocalAccessService({
      instanceId: 'human-gate-test',
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => project.id,
      desktop: {
        async ask() {
          return { authorized: false, code: 'HUMAN_DENIED' }
        },
        async run(input) {
          runs.push(input)
          return {}
        }
      }
    })

    const response = await dispatch(service, 'flowStateMachine.submitEvent', {
      projectId: project.id,
      nodeId: 'shape:sm',
      event: 'approve',
      expectedRevision: 1
    })
    expect(response.error?.code).toBe('HUMAN_DENIED')
    expect(runs).toHaveLength(0)
  })

  it('flowStateMachine.submitEvent 确认后才写 pending', async () => {
    const project = createProject('state-machine-human-gate')
    const config = JSON.stringify({ schemaVersion: 1, initialState: 'idle', transitions: [] })
    saveProject({
      id: project.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{
          id: 'shape:sm',
          type: 'state-machine',
          contractVersion: 1,
          ports: [],
          props: { title: '状态机', config },
          x: 0,
          y: 0
        }],
        edges: [],
        groups: []
      },
      tldrawSnapshot: {
        store: {
          'shape:sm': {
            id: 'shape:sm',
            type: 'node-card',
            props: { nodeType: 'state-machine', title: '状态机', config }
          }
        }
      }
    })

    const service = new LocalAccessService({
      instanceId: 'human-gate-test',
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => project.id,
      desktop: {
        async ask() {
          return { authorized: true }
        },
        async run() {
          const current = openProject(project.id)!
          const snapshot = current.tldrawSnapshot as {
            store: Record<string, { meta?: Record<string, unknown> }>
          }
          snapshot.store['shape:sm']!.meta = {
            ...snapshot.store['shape:sm']!.meta,
            stateMachinePending: JSON.stringify({
              eventId: 'event-1',
              event: 'approve',
              expectedRevision: 1
            })
          }
          saveProject({
            id: project.id,
            expectedGraphVersion: current.meta.graphVersion,
            graph: { nodes: current.nodes, edges: current.edges, groups: current.groups },
            tldrawSnapshot: snapshot
          })
          return { graphVersion: current.meta.graphVersion + 1, result: { revision: 1, eventId: 'event-1' } }
        }
      }
    })

    const response = await dispatch(service, 'flowStateMachine.submitEvent', {
      projectId: project.id,
      nodeId: 'shape:sm',
      event: 'approve',
      expectedRevision: 1
    })
    expect(response.error).toBeUndefined()
    expect(response.data).toMatchObject({ pending: true, event: 'approve', eventId: 'event-1' })
  })

  it.each(['allow', 'deny', 'expire'] as const)('pure headless submitHuman active=null：%s', async (mode) => {
    const { record } = await publishCompositeVersion(humanManifest())
    const runId = randomUUID()
    createCompositeRun({
      id: runId,
      projectId: `headless-${runId}`,
      capabilityId: record.manifest.capabilityId,
      capabilityVersion: record.manifest.version,
      contentHash: record.contentHash,
      inputValues: {}
    })
    waitCompositeRun({ runId, stepKey: 'h1' })
    openCompositeRunWait({ requestId: `${runId}:h1`, runId, stepKey: 'h1', kind: 'human', fields: [] })
    const asks: unknown[] = []
    const service = new LocalAccessService({
      instanceId: 'headless-human-gate-test',
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => null,
      desktop: {
        async ask(input) {
          asks.push(input)
          return mode === 'allow'
            ? { authorized: true }
            : {
                authorized: false,
                code: mode === 'expire' ? 'PUBLISH_AUTHORIZATION_EXPIRED' : 'HUMAN_DENIED'
              }
        },
        async run() { return {} }
      }
    })
    const response = await dispatch(service, 'composite.run.submitHuman', {
      runId, nodeId: 'h1', value: { kind: 'text', text: 'headless 人工结果' }
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ headless: true })
    if (mode === 'allow') {
      expect(response.error).toBeUndefined()
      expect(getSatisfiedHumanSubmissions(runId).h1).toEqual({ kind: 'text', text: 'headless 人工结果' })
    } else {
      expect(response.error?.code).toBe(mode === 'expire' ? 'HUMAN_DECISION_TIMEOUT' : 'HUMAN_DENIED')
      expect(getOpenCompositeRunWait(runId)?.state).toBe('open')
      expect(getSatisfiedHumanSubmissions(runId)).toEqual({})
    }
  })

  it('pure headless resubmit active=null 确认后写入正式输出', async () => {
    const { record } = await publishCompositeVersion(humanManifest())
    const runId = randomUUID()
    createCompositeRun({
      id: runId, projectId: `headless-${runId}`,
      capabilityId: record.manifest.capabilityId,
      capabilityVersion: record.manifest.version,
      contentHash: record.contentHash, inputValues: {}
    })
    finishCompositeRun({ runId, status: 'failed', failurePhase: 'step' })
    const service = new LocalAccessService({
      instanceId: 'headless-resubmit-test', appVersion: 'test',
      exportDirectory: join(directory, 'exports'), activeProjectId: () => null,
      desktop: { async ask() { return { authorized: true } }, async run() { return {} } }
    })
    const response = await dispatch(service, 'composite.run.resubmit', {
      runId, outputs: [{ portId: 'out-result', value: { kind: 'text', text: 'headless 补交' } }]
    })
    expect(response.error).toBeUndefined()
    expect(getCompositeRun(runId)?.run.outputValues).toEqual({
      result: { kind: 'text', text: 'headless 补交' }
    })
  })
})
