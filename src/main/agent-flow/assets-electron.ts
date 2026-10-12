// Opt-in hidden desktop IPC acceptance. Never reads the user's normal data directory.
import { app, BrowserWindow } from 'electron'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { registerFlowAssetsIpc } from '../ipc/flow-assets.ipc'
import { createProject, saveProject, openProject } from '../store/projects.repo'
import { closeDb, getDb } from '../store/db'
import { initDiagnosticsService } from '../diagnostics/service'
import { setGatewayEventSink } from '../diagnostics/gateway-events'
import type { FlowAssetVersion } from '../../shared/agent-flow/assets'
import type { IpcEnvelope } from '../../shared/contracts'

const directory = process.argv
  .find((arg) => arg.startsWith('--assets-directory='))
  ?.slice('--assets-directory='.length)
const phase = process.argv
  .find((arg) => arg.startsWith('--assets-phase='))
  ?.slice('--assets-phase='.length)
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-flow-assets-') ||
  !['submit', 'reopen'].includes(phase ?? '')
) {
  app.exit(2)
} else {
  process.env.CANVAS_DATA_DIR = directory
  app.setPath('userData', directory)
  app.on('window-all-closed', () => {
    /* Reports and diagnostics finish before app.exit(). */
  })
  void app.whenReady().then(async () => {
    let window: BrowserWindow | null = null
    let foreign: BrowserWindow | null = null
    const diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
    setGatewayEventSink(diagnostics)
    let exitCode = 0
    const checks: string[] = []
    try {
      window = new BrowserWindow({
        show: false,
        title: '测试：资产版本',
        webPreferences: {
          preload: resolve(__dirname, '../preload/index.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false
        }
      })
      const active = window
      registerFlowAssetsIpc(() => active)
      await active.loadURL('data:text/html,<title>asset acceptance</title>')
      const invoke = <T>(method: string, input: unknown): Promise<IpcEnvelope<T>> =>
        active.webContents.executeJavaScript(`window.api.${method}(${JSON.stringify(input)})`)
      if (phase === 'submit') {
        const project = createProject('测试：资产版本')
        const shape = {
          id: 'shape:asset-source',
          typeName: 'shape',
          type: 'node-card',
          props: {
            nodeType: 'text',
            text: 'private-fixture-body-v1',
            title: '材料',
            config: '',
            mediaId: '',
            mediaPath: '',
            mediaMime: '',
            exec: 'idle',
            w: 340,
            h: 260
          },
          meta: {}
        }
        const saved = saveProject({
          id: project.id,
          expectedGraphVersion: project.graphVersion,
          tldrawSnapshot: { store: { [shape.id]: shape } }
        })
        if (!saved) throw new Error('FIXTURE_SAVE_FAILED')
        const input = {
          projectId: project.id,
          nodeId: shape.id,
          portId: 'out-text',
          submissionId: 'fixture-submit',
          expectedGraphVersion: saved.graphVersion,
          traceId: 'fixture-asset-trace',
          spanId: 'fixture-asset-span'
        }
        const first = await invoke<FlowAssetVersion>('submitFlowAsset', input)
        if (
          !first.ok ||
          !first.data ||
          first.data.value.kind !== 'text' ||
          first.data.value.text !== 'private-fixture-body-v1'
        )
          throw new Error('FIXTURE_SUBMIT_FAILED')
        const v1 = first.data
        const list = await invoke<unknown[]>('listFlowAssets', {
          projectId: project.id,
          nodeId: shape.id,
          portId: 'out-text'
        })
        if (!list.ok || list.data?.length !== 1 || Object.hasOwn(list.data[0] as object, 'value'))
          throw new Error('FIXTURE_LIST_FAILED')
        const other = createProject('测试：另一个项目')
        const crossProject = await invoke<FlowAssetVersion>('readFlowAsset', {
          projectId: other.id,
          versionId: v1.ref.versionId
        })
        if (crossProject.ok || crossProject.error.code !== 'ASSET_VERSION_MISSING')
          throw new Error('FIXTURE_PROJECT_SCOPE_FAILED')
        shape.props.text = 'private-fixture-body-v2'
        saveProject({
          id: project.id,
          expectedGraphVersion: saved.graphVersion,
          tldrawSnapshot: { store: { [shape.id]: shape } }
        })
        const replay = await invoke<FlowAssetVersion>('submitFlowAsset', input)
        if (!replay.ok || replay.data?.ref.versionId !== v1.ref.versionId)
          throw new Error('FIXTURE_REPLAY_FAILED')
        const conflict = await invoke<FlowAssetVersion>('submitFlowAsset', {
          ...input,
          submissionId: 'stale'
        })
        if (conflict.ok || conflict.error.code !== 'ASSET_REVISION_CONFLICT')
          throw new Error('FIXTURE_CONFLICT_FAILED')
        const forged = await invoke<FlowAssetVersion>('submitFlowAsset', {
          ...input,
          body: 'fake-secret-key'
        })
        if (forged.ok || forged.error.code !== 'ASSET_INPUT_INVALID')
          throw new Error('FIXTURE_SCHEMA_FAILED')
        foreign = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: resolve(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false
          }
        })
        await foreign.loadURL('data:text/html,<title>foreign acceptance</title>')
        const denied = await foreign.webContents.executeJavaScript(
          `window.api.readFlowAsset(${JSON.stringify({ projectId: project.id, versionId: v1.ref.versionId })})`
        )
        if (denied.ok || denied.error.code !== 'ASSET_SENDER_REJECTED')
          throw new Error('FIXTURE_SENDER_FAILED')
        writeFileSync(
          join(directory, 'fixture-state.json'),
          JSON.stringify({ projectId: project.id, versionId: v1.ref.versionId, input })
        )
        checks.push(
          'saved formal output submitted',
          'metadata-only version list',
          'existing cross-project read rejected',
          'same submission replayed once',
          'stale revision rejected',
          'body injection rejected',
          'foreign window rejected'
        )
      } else {
        const state = JSON.parse(readFileSync(join(directory, 'fixture-state.json'), 'utf8'))
        const result = await invoke<FlowAssetVersion>('readFlowAsset', {
          projectId: state.projectId,
          versionId: state.versionId
        })
        if (
          !result.ok ||
          result.data?.value.kind !== 'text' ||
          result.data.value.text !== 'private-fixture-body-v1'
        )
          throw new Error('FIXTURE_REOPEN_FAILED')
        const replay = await invoke<FlowAssetVersion>('submitFlowAsset', state.input)
        if (!replay.ok || replay.data?.ref.versionId !== state.versionId)
          throw new Error('FIXTURE_REOPEN_REPLAY_FAILED')
        if (
          getDb().prepare('SELECT COUNT(*) AS count FROM flow_asset_versions').get()?.['count'] !==
          1
        )
          throw new Error('FIXTURE_COUNT_FAILED')
        if (!openProject(state.projectId)) throw new Error('FIXTURE_PROJECT_FAILED')
        checks.push(
          'new process reads immutable v1 despite v2 draft',
          'new process replays committed receipt',
          'one durable version'
        )
      }
    } catch {
      exitCode = 1
    } finally {
      foreign?.destroy()
      window?.destroy()
      await diagnostics.flushOnQuit()
      closeDb()
      writeFileSync(
        join(directory, `${phase}-report.json`),
        JSON.stringify({ status: exitCode === 0 ? 'pass' : 'failed', checks })
      )
      app.exit(exitCode)
    }
  })
}
