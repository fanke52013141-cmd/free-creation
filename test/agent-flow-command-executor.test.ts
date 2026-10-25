// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { Editor } from 'tldraw'
import type { ProjectFile } from '../src/shared/types'
import type {
  FlowCommandGrant,
  FlowCommandReceipt,
  NodeExecuteCommand
} from '../src/shared/agent-flow/commands'
import { projectSemanticRevision } from '../src/main/agent-flow/command-intent'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import { deriveGraph } from '@renderer/canvas/graph'
import { getNodeType } from '@renderer/nodes/registry'
import { runNodeManually, cancelFlowCommandExecution } from '@renderer/engine/executor'
import { runFlowNodeCommand, executeFlowCommandGrant } from '@renderer/engine/flow-command-bridge'
import {
  acquireNodeResource,
  setResourceLimit,
  useResourceQueue
} from '@renderer/engine/resource-queue'
import { useAppStore } from '@renderer/stores/app'
import { useEditorStore } from '@renderer/stores/editor'
import { ensureCanvasSaved } from '@renderer/canvas/flow-asset-actions'
import { registerAllNodeTypes } from './helpers/registerNodes'

vi.mock('@renderer/canvas/flow-asset-actions', async (original) => ({
  ...(await original<typeof import('@renderer/canvas/flow-asset-actions')>()),
  ensureCanvasSaved: vi.fn()
}))
beforeAll(() => registerAllNodeTypes())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setResourceLimit('local', 4)
})
function fixture() {
  vi.stubGlobal('crypto', webcrypto)
  const shape = (id: string, nodeType: string): NodeCardShape => ({
    id: id as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      nodeType,
      title: nodeType,
      config: '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      w: 340,
      h: 260
    },
    meta: {}
  })
  const source = shape('shape:pinned', 'text'),
    target = shape('shape:target', 'processor')
  const ref = {
    assetId: 'asset-a',
    versionId: 'version-a',
    sourceNodeId: 'shape:original',
    sourcePortId: 'out-text'
  }
  source.props.text = 'v2 edited draft'
  source.meta.pinnedOutput = JSON.stringify({
    version: 1,
    outputs: { 'out-text': { kind: 'text', text: 'immutable v1' } }
  })
  source.meta.flowAssetRef = JSON.stringify(ref)
  target.props.config = JSON.stringify({ operation: 'template', template: '结果：{{value}}' })
  const arrow = {
    id: 'shape:arrow',
    type: 'arrow',
    index: 'a2',
    meta: { fromPort: 'out-text', toPort: 'in-value' }
  }
  const shapes = new Map<string, NodeCardShape | typeof arrow>([
    [source.id, source],
    [target.id, target],
    [arrow.id, arrow]
  ])
  const editor = {
    getCurrentPageShapes: () => [...shapes.values()],
    getShape: (id: string) => shapes.get(id),
    getBindingsFromShape: (id: string) =>
      id === arrow.id
        ? [
            { props: { terminal: 'start' }, toId: source.id },
            { props: { terminal: 'end' }, toId: target.id }
          ]
        : [],
    updateShape: (patch: { id: string; props?: object; meta?: object }) => {
      const current = shapes.get(patch.id)
      if (current?.type !== 'node-card') return
      Object.assign(current.props, patch.props)
      Object.assign(current.meta, patch.meta)
    },
    markHistoryStoppingPoint: () => {},
    store: { getStoreSnapshot: () => ({ store: Object.fromEntries(shapes) }) }
  } as unknown as Editor
  const meta = { id: 'project-a', name: 'fixture', createdAt: 0, updatedAt: 0, graphVersion: 1 }
  const file = (): ProjectFile => ({
    version: 1,
    meta,
    ...deriveGraph(editor),
    tldrawSnapshot: editor.store.getStoreSnapshot('document')
  })
  const command: NodeExecuteCommand = {
    schemaVersion: 1,
    kind: 'node.execute',
    commandId: 'command-a',
    projectId: 'project-a',
    taskId: 'task-a',
    agentNodeId: 'shape:agent',
    targetNodeId: target.id,
    contractVersion: 1,
    expectedSemanticRevision: projectSemanticRevision(file()),
    inputs: [{ targetPortId: 'in-value', assets: [ref] }],
    traceId: 'trace-a',
    spanId: 'span-a'
  }
  const grant: FlowCommandGrant = {
    command,
    runId: 'run-a',
    leaseId: 'lease-a',
    inputs: [
      {
        targetPortId: 'in-value',
        versions: [
          {
            ref,
            projectId: 'project-a',
            ordinal: 1,
            graphVersion: 1,
            createdAt: 0,
            digest: 'digest-a',
            value: { kind: 'text', text: 'immutable v1' }
          }
        ],
        sources: [{ nodeId: source.id, portId: 'out-text' }]
      }
    ]
  }
  let admitted = false
  let receipt: FlowCommandReceipt = {
    commandId: command.commandId,
    projectId: 'project-a',
    taskId: 'task-a',
    targetNodeId: target.id,
    state: 'pending',
    runId: grant.runId,
    inputs: command.inputs,
    outputRefs: []
  }
  const api = {
    openProject: vi.fn(async () => ({ ok: true, data: file() })),
    prepareFlowCommand: vi.fn(async () =>
      receipt.state === 'pending'
        ? { ok: true, data: { state: 'ready', grant } }
        : { ok: true, data: { state: receipt.state, receipt } }
    ),
    checkFlowCommand: vi.fn(async () => {
      admitted = true
      return { ok: true, data: null }
    }),
    abortUnstartedFlowCommand: vi.fn(async () => {
      if (admitted) return { ok: false, error: { code: 'FLOW_LEASE_REJECTED', message: 'fixture' } }
      receipt = { ...receipt, state: 'skipped' }
      return { ok: true, data: receipt }
    }),
    commitFlowCommand: vi.fn(async () => {
      receipt = { ...receipt, state: 'committed' }
      return { ok: true, data: receipt }
    }),
    markFlowCommandUnknown: vi.fn(async () => {
      if (receipt.state === 'pending') receipt = { ...receipt, state: 'unknown' }
      return { ok: true, data: receipt }
    })
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  useAppStore.getState().openProject(meta)
  useEditorStore.getState().setEditor(editor)
  vi.mocked(ensureCanvasSaved).mockReset().mockResolvedValue(undefined)
  const spy = vi.spyOn(getNodeType('processor')!, 'executor')
  return {
    editor,
    source,
    target,
    file,
    command,
    grant,
    api,
    spy,
    setReceipt: (next: FlowCommandReceipt) => {
      receipt = next
    }
  }
}
async function block(projectId: string): Promise<() => void> {
  setResourceLimit('local', 1)
  const release = await acquireNodeResource({
    projectId,
    nodeId: 'fixture-blocker',
    label: 'fixture',
    resource: 'local',
    cancel: () => {}
  })
  if (!release) throw new Error('fixture blocker failed')
  return release
}
async function queued() {
  await vi.waitFor(() =>
    expect(
      useResourceQueue
        .getState()
        .tasks.some((task) => task.key === 'project-a/shape:target' && task.status === 'queued')
    ).toBe(true)
  )
}
describe('manual/Agent command shared executor parity', () => {
  it.each(['resolved', 'rejected'] as const)(
    'does not enter an executor after stop during %s command admission',
    async (outcome) => {
      const f = fixture()
      let release!: () => void
      let entered!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const running = runNodeManually(f.editor, 'project-a', [], f.target.id, {
        grant: f.grant,
        beforeExecutor: async () => {
          entered()
          await waiting
          if (outcome === 'rejected') throw new Error('private admission response')
        }
      })
      await ready
      try {
        cancelFlowCommandExecution({ projectId: 'project-a', commandId: f.command.commandId })
      } finally {
        release()
      }
      expect(await running).toEqual({ status: 'skipped', reason: '已取消' })
      expect(f.spy).not.toHaveBeenCalled()
      expect(f.target.meta.nodeRun).toMatchObject({ status: 'cancelled' })
      expect(useResourceQueue.getState().tasks).toHaveLength(0)
    }
  )
  it('replays a completed command after semantic edits instead of rejecting or executing it again', async () => {
    const f = fixture()
    const first = await runFlowNodeCommand(f.editor, 'project-a', [], f.command)
    f.target.props.config = '{"operation":"pick","path":"later-edit"}'
    const replay = await runFlowNodeCommand(f.editor, 'project-a', [], f.command)
    expect(replay).toEqual(first)
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('uses the same executor/output/fingerprint and complete asset source across both entrances', async () => {
    const f = fixture()
    const manual = await runNodeManually(f.editor, 'project-a', [], f.target.id)
    const record = structuredClone(f.target.meta.nodeRun)
    const value = f.target.meta.nodeResult
    const result = await runFlowNodeCommand(f.editor, 'project-a', [], f.command)
    expect(manual.status).toBe('done')
    expect(result.state).toBe('committed')
    expect(f.target.meta.nodeResult).toBe(value)
    expect(f.target.meta.nodeRun).toMatchObject({
      inputs: (record as { inputs: unknown }).inputs,
      inputFingerprint: (record as { inputFingerprint: string }).inputFingerprint,
      commandId: f.command.commandId,
      fixedInputs: f.command.inputs
    })
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.api.checkFlowCommand).toHaveBeenCalledTimes(1)
    expect(f.api.commitFlowCommand).toHaveBeenCalledTimes(1)
  })
  it('joins concurrent identical callers but rejects concurrent changed intent', async () => {
    const f = fixture()
    let resolve!: () => void
    vi.mocked(ensureCanvasSaved).mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const first = runFlowNodeCommand(f.editor, 'project-a', [], f.command)
    const duplicate = runFlowNodeCommand(f.editor, 'project-a', [], {
      ...f.command,
      traceId: 'retry-trace'
    })
    expect(duplicate).toBe(first)
    await expect(
      runFlowNodeCommand(f.editor, 'project-a', [], { ...f.command, taskId: 'changed-task' })
    ).rejects.toThrow('FLOW_COMMAND_CONFLICT')
    resolve()
    await first
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('does not reexecute after save failure and retained unknown', async () => {
    const f = fixture()
    vi.mocked(ensureCanvasSaved)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fixture save failure'))
    const first = await runFlowNodeCommand(f.editor, 'project-a', [], f.command)
    expect(first.state).toBe('unknown')
    expect(f.api.commitFlowCommand).not.toHaveBeenCalled()
    const replay = await runFlowNodeCommand(f.editor, 'project-a', [], f.command)
    expect(replay.state).toBe('unknown')
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('preserves a committed receipt when only its transport response is lost', async () => {
    const f = fixture()
    f.api.commitFlowCommand.mockImplementationOnce(async () => {
      f.setReceipt({
        commandId: f.command.commandId,
        projectId: 'project-a',
        taskId: 'task-a',
        targetNodeId: f.target.id,
        state: 'committed',
        runId: f.grant.runId,
        inputs: f.command.inputs,
        outputRefs: []
      })
      throw new Error('fixture transport loss')
    })
    expect((await runFlowNodeCommand(f.editor, 'project-a', [], f.command)).state).toBe('committed')
    expect(f.spy).toHaveBeenCalledTimes(1)
  })
  it('cancels a queued command before admission without an effect and releases the unstarted lease', async () => {
    const f = fixture(),
      release = await block('project-a')
    try {
      const running = runFlowNodeCommand(f.editor, 'project-a', [], f.command)
      await queued()
      useResourceQueue
        .getState()
        .tasks.find((task) => task.key === 'project-a/shape:target')!
        .cancel()
      expect((await running).state).toBe('skipped')
      expect(f.api.abortUnstartedFlowCommand).toHaveBeenCalledTimes(1)
      expect(f.spy).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })
  it('checks live semantic changes after queuing, before any business executor call', async () => {
    const f = fixture(),
      release = await block('project-a')
    const pending = executeFlowCommandGrant(f.editor, 'project-a', [], f.grant, f.file())
    await queued()
    f.target.props.config = '{"operation":"pick","path":"changed"}'
    release()
    await pending
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.api.checkFlowCommand).not.toHaveBeenCalled()
    expect(f.target.meta.nodeRun).toMatchObject({ status: 'failed' })
  })
  it('blocks a switched-away canvas after queue admission', async () => {
    const f = fixture(),
      release = await block('project-a')
    const pending = executeFlowCommandGrant(f.editor, 'project-a', [], f.grant, f.file())
    await queued()
    useAppStore.getState().setHome()
    release()
    await pending
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.api.checkFlowCommand).not.toHaveBeenCalled()
  })
})
