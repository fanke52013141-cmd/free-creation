import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  saveProject: vi.fn(() => ({ graphVersion: 1 })),
  saveRecoveryCopySync: vi.fn(() => true)
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: any[]) => any) => {
      state.handlers[channel] = handler
    },
    handle: (channel: string, handler: (...args: any[]) => any) => {
      state.handlers[channel] = handler
    }
  },
  dialog: {}
}))
vi.mock('../src/main/store/db', () => ({ getSetting: () => null, setSetting: () => {} }))
vi.mock('../src/main/ipc/project-watcher', () => ({ ProjectFileWatcher: class {} }))
vi.mock('../src/main/store/transfer', () => ({ exportProject: () => {}, importProject: () => {} }))
vi.mock('../src/main/store/canvas-structure-transfer', () => ({
  exportCanvasStructure: () => {},
  importCanvasStructure: () => {}
}))
vi.mock('../src/main/store/projects.repo', () => ({
  saveProject: state.saveProject,
  saveRecoveryCopySync: state.saveRecoveryCopySync
}))

import { registerProjectIpc } from '../src/main/ipc/project.ipc'
import { IPC } from '../src/shared/contracts'
import { DEFAULT_AGENT_NODE_CONFIG } from '../src/shared/agent-flow/node-contracts'

const events: any[] = []

beforeEach(() => {
  state.handlers = {}
  state.saveProject.mockClear()
  state.saveRecoveryCopySync.mockClear()
  events.length = 0
  setGatewayEventSink({ emit: (event) => { if (event) events.push(event) } })
  registerProjectIpc()
})

afterEach(() => setGatewayEventSink(null))

function inputWithAgentConfig(config: unknown) {
  const node = {
    id: 'agent-1',
    type: 'node-card',
    props: { nodeType: 'agent', config: JSON.stringify(config) }
  }
  return {
    id: 'project',
    expectedGraphVersion: 0,
    graph: { nodes: [node], edges: [], groups: [] }
  }
}

function syncReply(channel: string, input: unknown): unknown {
  const event = { returnValue: undefined as unknown }
  state.handlers[channel](event, input)
  return event.returnValue
}

describe('Agent config validation at project save IPC boundaries', () => {
  it.each([
    ['async project save', IPC.project.save],
    ['sync project save', IPC.project.saveSync],
    ['sync recovery copy', IPC.project.saveRecoveryCopySync]
  ] as const)('rejects invalid Agent configs before %s writes', (_label, channel) => {
    const invalid = inputWithAgentConfig({ ...DEFAULT_AGENT_NODE_CONFIG, maxSteps: 0 })
    const reply =
      channel === IPC.project.save
        ? state.handlers[channel]({}, invalid)
        : syncReply(channel, invalid)

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'INVALID_AGENT_CONFIG' }
    })
    expect(state.saveProject).not.toHaveBeenCalled()
    expect(state.saveRecoveryCopySync).not.toHaveBeenCalled()
    expect(events.map((event) => event.event)).toEqual([
      'project.save.started',
      'project.save.failed'
    ])
    expect(events[1]).toMatchObject({
      status: 'failed',
      attributes: { phase: 'validate-agent-config', code: 'INVALID_AGENT_CONFIG' }
    })
    expect(JSON.stringify(events)).not.toContain('maxSteps')
  })

  it('rejects a malformed Agent config carried in the tldraw snapshot', () => {
    const input = {
      id: 'project',
      tldrawSnapshot: {
        store: {
          'shape:agent-1': {
            id: 'shape:agent-1',
            typeName: 'shape',
            type: 'node-card',
            props: {
              nodeType: 'agent',
              config: JSON.stringify({ ...DEFAULT_AGENT_NODE_CONFIG, maxParallelTasks: 5 })
            }
          }
        }
      }
    }

    expect(state.handlers[IPC.project.save]({}, input)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_AGENT_CONFIG' }
    })
    expect(state.saveProject).not.toHaveBeenCalled()
  })

  it('rejects a malformed Agent config in the derived graph format', () => {
    const input = {
      id: 'project',
      graph: {
        nodes: [
          {
            id: 'agent-1',
            type: 'agent',
            params: { config: JSON.stringify({ ...DEFAULT_AGENT_NODE_CONFIG, maxSteps: 65 }) }
          }
        ],
        edges: [],
        groups: []
      }
    }

    expect(state.handlers[IPC.project.save]({}, input)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_AGENT_CONFIG' }
    })
    expect(state.saveProject).not.toHaveBeenCalled()
  })

  it.each([
    ['minimum maxSteps', { maxSteps: 1 }],
    ['maximum maxSteps', { maxSteps: 64 }],
    ['minimum maxParallelTasks', { maxParallelTasks: 1 }],
    ['maximum maxParallelTasks', { maxParallelTasks: 4 }]
  ])('accepts legal Agent config boundary: %s', (_label, patch) => {
    const input = inputWithAgentConfig({ ...DEFAULT_AGENT_NODE_CONFIG, ...patch })
    expect(state.handlers[IPC.project.save]({}, input)).toMatchObject({ ok: true })
    expect(state.saveProject).toHaveBeenCalledOnce()
    expect(events.map((event) => event.event)).toEqual([
      'project.save.started',
      'project.save.completed'
    ])
  })
})
