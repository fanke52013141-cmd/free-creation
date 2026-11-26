import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { closeDb, getDb } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { graphCanvasScopeHash } from '../src/main/agent-flow/graph-canvas-version'
import type { FlowGraphPreview } from '../src/shared/agent-flow/flow-graph-compiler'
import {
  publishFlowAgentAccessPort,
  resetFlowAgentAccessPortForTest,
  type FlowAgentAccessPort
} from '../src/main/agent-access/flow-bridge'
import { runFlowAgentOperation } from '../src/main/agent-access/flow-agents-ops'

let directory: string
const originalDirectory = process.env.CANVAS_DATA_DIR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-graph-confirm-scope-'))
  process.env.CANVAS_DATA_DIR = directory
  migrateDatabase(getDb())
})

afterEach(() => {
  resetFlowAgentAccessPortForTest()
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('external FlowGraph idempotent confirm scope', () => {
  it('rejects a committed preview after its committed canvas scope changes', async () => {
    const project = createProject('scope-test')
    const graph = (text: string) => ({
      nodes: [{
        id: 'shape:a',
        type: 'text',
        contractVersion: 1,
        ports: [],
        props: { text, config: {} },
        x: 0,
        y: 0
      }],
      edges: [],
      groups: []
    })
    const snapshot = (text: string) => ({
      store: {
        'shape:a': {
          id: 'shape:a',
          type: 'node-card',
          props: { nodeType: 'text', text, config: {} }
        }
      }
    })
    saveProject({
      id: project.id,
      expectedGraphVersion: 0,
      graph: graph('before'),
      tldrawSnapshot: snapshot('before')
    })
    const before = openProject(project.id)!
    const preview = {
      state: 'committed',
      buildId: 'build-1',
      nodes: [{ id: 'shape:a' }],
      edges: []
    } as unknown as FlowGraphPreview
    preview.committedScopeHash = graphCanvasScopeHash(before, preview)

    saveProject({
      id: project.id,
      expectedGraphVersion: before.meta.graphVersion,
      graph: graph('after'),
      tldrawSnapshot: snapshot('after')
    })

    publishFlowAgentAccessPort({
      previewGraph: async () => preview
    } as unknown as FlowAgentAccessPort)

    await expect(
      runFlowAgentOperation(
        'flowGraph.confirm',
        { projectId: project.id, buildId: 'build-1' },
        {
          activeProjectId: () => project.id,
          diagnostics: { traceId: 'trace', spanId: 'span' },
          desktop: {} as never
        }
      )
    ).rejects.toMatchObject({ code: 'FLOW_CANVAS_DIVERGED' })
  })
})
