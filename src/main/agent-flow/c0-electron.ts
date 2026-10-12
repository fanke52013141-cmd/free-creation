// Separate opt-in C0 test entry; never starts the product or opens its database.
import { app, BrowserWindow, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createC0Runtime } from './c0/runtime'
import { C0SqliteSaver } from './c0/checkpoint'
import { C0CommandLedger } from './c0/command-ledger'
import {
  C0CommandSchema,
  C0Error,
  type C0ModelPort,
  type C0Scope
} from '../../shared/agent-flow/c0-contracts'
import { initDiagnosticsService } from '../diagnostics/service'
import { createC0Telemetry } from './c0/diagnostics'

const directory = process.argv
  .find((arg) => arg.startsWith('--c0-directory='))
  ?.slice('--c0-directory='.length)
const phase = process.argv.find((arg) => arg.startsWith('--c0-phase='))?.slice('--c0-phase='.length)
if (
  !directory ||
  !['pause', 'resume'].includes(phase ?? '') ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-agent-c0-')
) {
  app.exit(2)
} else {
  app.setPath('userData', directory)
  process.env.LANGSMITH_TRACING = 'false'
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  void app.whenReady().then(async () => {
    let window: BrowserWindow | undefined
    let db: Database.Database | undefined
    let diagnostics: Awaited<ReturnType<typeof initDiagnosticsService>> | undefined
    let exitCode = 0
    try {
      await mkdir(directory, { recursive: true })
      diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
      const telemetry = createC0Telemetry(diagnostics, {
        projectId: 'c0-project',
        nodeId: 'c0-agent',
        taskId: 'c0-task',
        traceId: `c0-${phase}`,
        ...(phase === 'resume' ? { resumesTraceId: 'c0-pause' } : {}),
        spanId: 'c0-runtime'
      })
      db = new Database(join(directory, 'experiment.db'))
      db.pragma('journal_mode = WAL')
      db.exec(
        'CREATE TABLE IF NOT EXISTS c0_effects(command TEXT PRIMARY KEY, executions INTEGER NOT NULL);'
      )
      const database = db
      const preload = join(directory, 'c0-preload.cjs')
      await writeFile(
        preload,
        `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('c0Fixture',{effect:(command)=>ipcRenderer.invoke('c0:effect',command)});
ipcRenderer.on('c0:execute',async(_,command)=>{
  const output=await ipcRenderer.invoke('c0:effect',command);
  document.getElementById('asset').textContent=output.text;
  ipcRenderer.send('c0:result',{commandId:command.commandId,output});
});`,
        'utf8'
      )
      window = new BrowserWindow({
        show: false,
        title: '测试：Agent Flow C0',
        webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
      })
      const fixtureWindow = window
      fixtureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      fixtureWindow.webContents.on('will-navigate', (event) => event.preventDefault())
      ipcMain.handle('c0:effect', (event, raw) => {
        if (
          event.sender !== fixtureWindow.webContents ||
          event.senderFrame !== fixtureWindow.webContents.mainFrame
        )
          throw new C0Error('SENDER_DENIED')
        const command = C0CommandSchema.parse(raw)
        database
          .prepare(
            'INSERT INTO c0_effects VALUES (?,1) ON CONFLICT(command) DO UPDATE SET executions=executions+1'
          )
          .run(command.commandId)
        return { text: command.input.text.toUpperCase() }
      })
      await fixtureWindow.loadURL('data:text/html,<html><body><div id="asset"></div></body></html>')
      const scope: C0Scope = {
        projectId: 'c0-project',
        agentNodeId: 'c0-agent',
        taskId: 'c0-task',
        revision: 1,
        allowedNodeIds: ['c0-processor']
      }
      const transport = {
        execute: async (command, signal) =>
          new Promise((resolveOutput, reject) => {
            const cleanup = (): void => {
              ipcMain.removeListener('c0:result', onResult)
              signal.removeEventListener('abort', onAbort)
            }
            const onAbort = (): void => {
              cleanup()
              reject(new C0Error('BRIDGE_DISCONNECTED'))
            }
            const onResult = (event, value): void => {
              if (
                event.sender !== fixtureWindow.webContents ||
                event.senderFrame !== fixtureWindow.webContents.mainFrame ||
                value?.commandId !== command.commandId
              )
                return
              cleanup()
              resolveOutput(value.output)
            }
            ipcMain.on('c0:result', onResult)
            signal.addEventListener('abort', onAbort, { once: true })
            fixtureWindow.webContents.send('c0:execute', command)
          })
      } satisfies import('../../shared/agent-flow/c0-contracts').C0Transport
      const model: C0ModelPort = {
        decide: async (input) =>
          !input.outputs.length
            ? { kind: 'tool', targetNodeId: 'c0-processor', input: { text: input.text } }
            : input.humanAccepted === null
              ? { kind: 'wait' }
              : { kind: 'finish', output: input.outputs[0] }
      }
      const runtime = createC0Runtime({
        scope,
        saver: new C0SqliteSaver(database, telemetry),
        ledger: new C0CommandLedger(database, telemetry),
        model,
        transport,
        telemetry
      })
      const result =
        phase === 'pause'
          ? await runtime.start('isolated fixture', 'collaborative')
          : await runtime.resume({ taskId: scope.taskId, expectedRevision: 1, accepted: true })
      const effect = database.prepare('SELECT SUM(executions) AS count FROM c0_effects').get() as {
        count: number
      }
      if (effect.count !== 1 || result.status !== (phase === 'pause' ? 'waiting' : 'completed'))
        throw new C0Error('SMOKE_ASSERTION_FAILED')
      const receipt = await runtime.inspect()
      const ledger = new C0CommandLedger(database, telemetry)
      await ledger.execute(
        {
          commandId: 'c0-task:tool:0',
          projectId: scope.projectId,
          agentNodeId: scope.agentNodeId,
          taskId: scope.taskId,
          targetNodeId: 'c0-processor',
          expectedRevision: 1,
          input: { text: 'isolated fixture' }
        },
        scope,
        transport
      )
      const rechecked = database
        .prepare('SELECT SUM(executions) AS count FROM c0_effects')
        .get() as { count: number }
      if (rechecked.count !== 1) throw new C0Error('DUPLICATE_EFFECT')
      await writeFile(
        join(directory, `${phase}-report.json`),
        JSON.stringify(
          {
            status: 'pass',
            phase,
            taskStatus: result.status,
            effectCount: rechecked.count,
            checkpointPresent: receipt.checkpointPresent,
            hiddenWindow: !fixtureWindow.isVisible(),
            model: 'deterministic-fixture',
            electron: process.versions.electron,
            node: process.versions.node
          },
          null,
          2
        )
      )
    } catch (error) {
      exitCode = 1
      await writeFile(
        join(directory, `${phase}-report.json`),
        JSON.stringify({
          status: 'fail',
          phase,
          code: error instanceof C0Error ? error.code : 'SMOKE_FAILED'
        })
      ).catch(() => undefined)
    } finally {
      ipcMain.removeHandler('c0:effect')
      ipcMain.removeAllListeners('c0:result')
      window?.destroy()
      db?.close()
      await diagnostics?.flushOnQuit()
      app.exit(exitCode)
    }
  })
}
