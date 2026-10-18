import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  DIAGNOSTICS_EVENT_MAX_BYTES,
  DIAGNOSTICS_QUEUE_CRITICAL_RESERVED,
  DIAGNOSTICS_QUEUE_MAX_BYTES,
  DIAGNOSTICS_QUEUE_MAX_ITEMS,
  DIAGNOSTICS_RETENTION_ERROR_BYTES,
  DIAGNOSTICS_RETENTION_MAX_BYTES,
  DIAGNOSTICS_SHARD_MAX_BYTES,
  DIAGNOSTICS_TOTAL_HARD_LIMIT_BYTES,
  DiagnosticsProducer,
  newEventId,
  type DiagnosticsEvent,
  type DiagnosticsEventInput
} from '@shared/observability'
import { DiagnosticsQueue } from '../src/main/diagnostics/queue'
import { enforceRetention } from '../src/main/diagnostics/retention'
import { manualClock } from '../src/main/diagnostics/clock'
import { memoryFsStore } from '../src/main/diagnostics/fs-types'
import { DiagnosticsShardWriter } from '../src/main/diagnostics/writer'
import { initDiagnosticsService } from '../src/main/diagnostics/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowSkillStore } from '../src/main/agent-flow/skill-store'
import { FlowTaskStore } from '../src/main/agent-flow/task-store'
import {
  createAgentRuntime,
  type AgentModelPort
} from '../src/main/agent-flow/runtime'
import { createAgentTelemetry } from '../src/main/agent-flow/runtime-diagnostics'
import {
  AgentTaskSnapshotSchema,
  type AgentTaskSnapshot
} from '../src/shared/agent-flow/runtime-contracts'
import type { FlowCommandReceipt, NodeExecuteCommand } from '../src/shared/agent-flow/commands'

const nowMs = Date.parse('2026-10-17T00:00:00.000Z')

function producer(): DiagnosticsProducer {
  return new DiagnosticsProducer({
    process: 'main',
    producerId: 'agent-log07-stress',
    now: () => nowMs
  })
}

function finalizedAgentEvent(
  source: DiagnosticsProducer,
  sequence: number,
  level: 'info' | 'error' = 'info',
  message = `Agent diagnostic stress ${sequence}: ${'x'.repeat(360)}`
): DiagnosticsEvent {
  const input = source.build(
    'agent.coordination.stage',
    level,
    message,
    { traceId: 'trace-log07-stress', projectId: 'project-log07', nodeId: 'shape:log07' },
    {
      status: level === 'error' ? 'failed' : undefined,
      attributes: { phase: 'retention-stress', round: sequence }
    }
  )
  if (!input) throw new Error('LOG07_AGENT_EVENT_NOT_REGISTERED')
  const { producerMeta: _producerMeta, ...event } = input as DiagnosticsEventInput
  return {
    ...event,
    schemaVersion: 1,
    eventId: newEventId(),
    sessionId: 'session-log07-stress',
    producerId: 'agent-log07-stress',
    sequence,
    process: 'main',
    receivedAt: new Date(nowMs).toISOString()
  }
}

describe('Agent LOG-07 高频诊断轮转与保留压力', () => {
  it('报告队列丢弃，轮转完整 JSONL，并按显式 QA 容量清理', async () => {
    const source = producer()
    const queue = new DiagnosticsQueue()
    const normalInputs = DIAGNOSTICS_QUEUE_MAX_ITEMS + 952
    let acceptedNormal = 0
    let normalDropped = 0
    for (let index = 1; index <= normalInputs; index += 1) {
      const result = queue.push(finalizedAgentEvent(source, index))
      if (result.ok) acceptedNormal += 1
      else normalDropped += 1
    }
    const normalDepth = queue.depth
    const criticalInputs = DIAGNOSTICS_QUEUE_CRITICAL_RESERVED + 1
    const criticalDrops: string[] = []
    let acceptedCritical = 0
    for (let index = 1; index <= criticalInputs; index += 1) {
      const result = queue.push(
        finalizedAgentEvent(source, normalInputs + index, 'error', `Agent failure ${index}`)
      )
      if (result.ok) acceptedCritical += 1
      if (result.drop) criticalDrops.push(result.drop.reason)
    }
    const queued = queue.drain(DIAGNOSTICS_QUEUE_MAX_ITEMS + 1)
    const retainedCritical = queued.filter((event) => event.level === 'error').length

    expect(normalDepth).toBe(DIAGNOSTICS_QUEUE_MAX_ITEMS - DIAGNOSTICS_QUEUE_CRITICAL_RESERVED)
    expect(acceptedNormal).toBe(normalDepth)
    expect(normalDropped).toBe(normalInputs - normalDepth)
    expect(acceptedCritical).toBe(criticalInputs)
    expect(criticalDrops).toEqual(['overflow_evicted'])
    expect(queued).toHaveLength(DIAGNOSTICS_QUEUE_MAX_ITEMS)
    expect(retainedCritical).toBe(criticalInputs)

    const store = memoryFsStore()
    const clock = manualClock(nowMs)
    const writer = new DiagnosticsShardWriter({
      store,
      clock,
      dir: '/data/diagnostics/events',
      sessionId: 'agent-log07-stress'
    })
    const persistedEvents = 24_000
    const batchSize = 64
    for (let offset = 0; offset < persistedEvents; offset += batchSize) {
      const batch = Array.from(
        { length: Math.min(batchSize, persistedEvents - offset) },
        (_, index) =>
          finalizedAgentEvent(source, normalInputs + criticalInputs + offset + index + 1)
      )
      const result = await writer.append(batch)
      expect(result).toEqual({ written: batch.length, failed: 0 })
    }

    const shardsBefore = await writer.listShards()
    const bytesBefore = shardsBefore.reduce(
      (total, name) => total + (store.files.get(`/data/diagnostics/events/${name}`)?.length ?? 0),
      0
    )
    const parsedBefore = await writer.readEvents({ limit: persistedEvents + 1 })
    expect(shardsBefore.length).toBeGreaterThanOrEqual(2)
    expect(bytesBefore).toBeGreaterThan(DIAGNOSTICS_SHARD_MAX_BYTES)
    expect(parsedBefore.events).toHaveLength(persistedEvents)
    expect(parsedBefore.badLines).toBe(0)
    expect(parsedBefore.truncated).toBe(false)

    for (const name of shardsBefore) {
      const raw = store.files.get(`/data/diagnostics/events/${name}`) ?? ''
      for (const line of raw.split('\n').filter(Boolean)) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(DIAGNOSTICS_EVENT_MAX_BYTES)
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }

    const businessFile = '/data/projects/agent-log07/project.json'
    await store.writeFile(businessFile, 'agent project data remains untouched')
    const qaRetention = {
      maxBytes: 12 * 1024 * 1024,
      errorBytes: 2 * 1024 * 1024,
      hardLimitBytes: 16 * 1024 * 1024
    }
    const retention = await enforceRetention(store, '/data/diagnostics/events', {
      nowMs,
      currentShard: null,
      ...qaRetention
    })
    const shardsAfter = await writer.listShards()
    const actualBytesAfter = shardsAfter.reduce(
      (total, name) => total + (store.files.get(`/data/diagnostics/events/${name}`)?.length ?? 0),
      0
    )
    const parsedAfter = await writer.readEvents({ limit: persistedEvents + 1 })
    expect(retention.removed.length).toBeGreaterThan(0)
    expect(retention.freedBytes).toBeGreaterThan(0)
    expect(retention.remainingBytes).toBe(actualBytesAfter)
    expect(actualBytesAfter).toBeLessThanOrEqual(qaRetention.maxBytes)
    expect(parsedAfter.events.length).toBeGreaterThan(0)
    expect(parsedAfter.badLines).toBe(0)
    expect(parsedAfter.truncated).toBe(false)
    expect(store.files.get(businessFile)).toBe('agent project data remains untouched')

    const result = {
      scope:
        'Agent diagnostics only; synthetic events; in-memory file store; no model/provider/network calls',
      queue: {
        productionMaxItems: DIAGNOSTICS_QUEUE_MAX_ITEMS,
        productionMaxBytes: DIAGNOSTICS_QUEUE_MAX_BYTES,
        criticalReserved: DIAGNOSTICS_QUEUE_CRITICAL_RESERVED,
        normalInputs,
        acceptedNormal,
        normalDropped,
        criticalInputs,
        criticalAccepted: acceptedCritical,
        criticalDropReasons: criticalDrops,
        drained: queued.length,
        criticalRetained: retainedCritical
      },
      rotation: {
        productionShardMaxBytes: DIAGNOSTICS_SHARD_MAX_BYTES,
        eventsWritten: persistedEvents,
        shardCountBefore: shardsBefore.length,
        bytesBefore,
        parsedBefore: parsedBefore.events.length,
        invalidLinesBefore: parsedBefore.badLines,
        overlongRowsBefore: 0
      },
      retention: {
        qaOverrides: qaRetention,
        productionDefaults: {
          maxBytes: DIAGNOSTICS_RETENTION_MAX_BYTES,
          errorBytes: DIAGNOSTICS_RETENTION_ERROR_BYTES,
          hardLimitBytes: DIAGNOSTICS_TOTAL_HARD_LIMIT_BYTES
        },
        removedShards: retention.removed,
        freedBytes: retention.freedBytes,
        actualBytesAfter,
        retainedShards: shardsAfter.length,
        parsedRowsAfter: parsedAfter.events.length,
        invalidLinesAfter: parsedAfter.badLines,
        queueDropsVisible: normalDropped,
        businessFilePreserved: store.files.has(businessFile)
      }
    }
    const evidenceDir = process.env.CANVAS_AGENT_EVIDENCE_DIR
    if (evidenceDir) {
      mkdirSync(resolve(evidenceDir), { recursive: true })
      writeFileSync(
        join(resolve(evidenceDir), 'log07-stress-results.json'),
        JSON.stringify(result, null, 2)
      )
    }
  })

  it('keeps Agent completion correct while a slow diagnostic write fails under bounded queue pressure', async () => {
    let modelEntered!: () => void
    let allowDecision!: () => void
    let appendEntered!: () => void
    let allowAppend!: () => void
    const modelEnteredPromise = new Promise<void>((resolve) => (modelEntered = resolve))
    const allowDecisionPromise = new Promise<void>((resolve) => (allowDecision = resolve))
    const appendEnteredPromise = new Promise<void>((resolve) => (appendEntered = resolve))
    const allowAppendPromise = new Promise<void>((resolve) => (allowAppend = resolve))

    const database = new Database(':memory:')
    migrateDatabase(database)
    database
      .prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)')
      .run('project-per07', 'Agent diagnostics pressure fixture')
    const skills = new FlowSkillStore(database)
    const tasks = new FlowTaskStore(database)
    const snapshot: AgentTaskSnapshot = AgentTaskSnapshotSchema.parse({
      runtimeVersion: 1,
      projectId: 'project-per07',
      agentNodeId: 'shape:agent-per07',
      taskId: 'task-per07',
      semanticRevision: `sha256:${'b'.repeat(64)}`,
      goal: 'Complete one fixed processor operation under diagnostic pressure.',
      config: {
        schemaVersion: 1,
        role: 'specialist',
        interactionMode: 'autonomous',
        skills: [],
        tools: [{ id: 'node.execute', version: '1' }],
        allowedNodeIds: ['processor-per07'],
        maxSteps: 4,
        relations: []
      },
      targets: [{ nodeId: 'processor-per07', contractVersion: 1, inputs: [] }],
      traceId: 'trace-per07-agent',
      spanId: 'span-per07-agent'
    })
    const output = {
      assetId: 'asset-per07',
      versionId: 'version-per07',
      sourceNodeId: 'processor-per07',
      sourcePortId: 'out-value'
    }
    let decisions = 0
    let toolCalls = 0
    const model: AgentModelPort = {
      decide: async () => {
        decisions += 1
        if (decisions === 1) {
          modelEntered()
          await allowDecisionPromise
          return { kind: 'execute', targetNodeId: 'processor-per07' }
        }
        return { kind: 'finish', outputs: [output] }
      }
    }
    const tools = {
      execute: async (command: NodeExecuteCommand): Promise<FlowCommandReceipt> => {
        toolCalls += 1
        return {
          commandId: command.commandId,
          projectId: command.projectId,
          taskId: command.taskId,
          targetNodeId: command.targetNodeId,
          runId: 'run-per07',
          state: 'committed',
          inputs: command.inputs,
          outputRefs: [output]
        }
      }
    }
    const runtime = createAgentRuntime({
      snapshot,
      skills,
      store: tasks,
      model,
      tools,
      assertRevision: () => undefined,
      telemetry: createAgentTelemetry(snapshot)
    })

    const underlyingStore = memoryFsStore()
    let failFirstAppend = true
    let writePending = false
    const slowStore = {
      ...underlyingStore,
      appendFile: async (path: string, data: string): Promise<void> => {
        if (failFirstAppend) {
          failFirstAppend = false
          writePending = true
          appendEntered()
          await allowAppendPromise
          writePending = false
          throw new Error('ENOSPC: injected isolated QA capacity limit')
        }
        await underlyingStore.appendFile(path, data)
      }
    }
    const service = await initDiagnosticsService({
      dataDir: '/data',
      store: slowStore,
      clock: manualClock(nowMs),
      disableTimers: true
    })
    setGatewayEventSink({ emit: (event) => service.emit(event) })
    let firstFlush: Promise<void> | null = null
    try {
      const running = runtime.start()
      await modelEnteredPromise
      expect(service.health().queueDepth).toBeGreaterThan(0)

      firstFlush = service.flushNow()
      await appendEnteredPromise
      expect(writePending).toBe(true)

      const pressureEvents: DiagnosticsEventInput[] = []
      const source = producer()
      for (let index = 0; index < DIAGNOSTICS_QUEUE_MAX_ITEMS + 64; index += 1) {
        const event = source.build(
          'agent.coordination.stage',
          'info',
          `Agent diagnostic pressure ${index}`,
          {
            traceId: 'trace-per07-pressure',
            taskId: 'task-per07',
            projectId: 'project-per07',
            nodeId: 'shape:agent-per07',
            nodeType: 'agent'
          },
          { attributes: { phase: 'slow-write-pressure', round: index } }
        )
        if (!event) throw new Error('PER07_AGENT_DIAGNOSTIC_EVENT_NOT_REGISTERED')
        pressureEvents.push(event)
      }
      for (let offset = 0; offset < pressureEvents.length; offset += 512)
        await service.ingest(pressureEvents.slice(offset, offset + 512))

      const saturated = service.health()
      expect(saturated.queueDepth).toBeLessThanOrEqual(DIAGNOSTICS_QUEUE_MAX_ITEMS)
      expect(saturated.droppedTotal).toBeGreaterThan(0)
      allowDecision()
      const result = await running
      expect(result.state).toBe('completed')
      expect(result.outputRefs).toEqual([output])
      expect(runtime.inspect().state).toBe('completed')
      expect(decisions).toBe(2)
      expect(toolCalls).toBe(1)
      expect(writePending).toBe(true)

      allowAppend()
      await firstFlush
      const afterFailure = service.health()
      expect(afterFailure.degraded).toBe(true)
      expect(afterFailure.writeFailures).toBe(1)

      for (let attempt = 0; attempt < 8 && service.health().queueDepth > 0; attempt += 1)
        await service.flushNow()
      const recovered = service.health()
      expect(recovered.degraded).toBe(false)
      expect(recovered.queueDepth).toBe(0)
      expect(recovered.written).toBeGreaterThan(0)
      expect(recovered.droppedTotal).toBeGreaterThan(0)
      expect(recovered.incidentLog.map((item) => item.kind)).toContain('write.recovered')
      const persisted = await service.query({ traceId: 'trace-per07-pressure', limit: 20 })
      expect(persisted.events).toHaveLength(20)
      expect(persisted.badLines).toBe(0)
    } finally {
      allowDecision()
      allowAppend()
      if (firstFlush) await firstFlush
      setGatewayEventSink(null)
      database.close()
    }
  })
})
