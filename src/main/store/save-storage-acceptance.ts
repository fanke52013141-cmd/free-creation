// Isolated acceptance host only; never imported by the application entry point.
import type { BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getDb } from './db'
import { openProject } from './projects.repo'

export async function verifyStorageRecovery(
  window: BrowserWindow,
  directory: string,
  projectId: string,
  baseline: number,
  ready: () => Promise<boolean>,
  waitFor: (check: () => Promise<boolean>) => Promise<void>
): Promise<unknown> {
  const path = join(directory, 'projects', projectId, 'project.json')
  fs.copyFileSync(path, path + '.bak')
  const verified = fs.readFileSync(path + '.bak', 'utf8')
  const mutable = createRequire(__filename)('fs') as typeof fs
  const write = mutable.writeFileSync,
    rename = mutable.renameSync,
    sync = mutable.fsyncSync
  const db = getDb(),
    prepare = db.prepare
  let fault = ''
  const storedText = (): unknown =>
    (
      openProject(projectId)!.tldrawSnapshot as {
        store: Record<string, { props: { text: string } }>
      }
    ).store['shape:save-source'].props.text
  const drain = (): Promise<unknown> =>
    window.webContents.executeJavaScript(
      "(async()=>{await(await import('/src/engine/diagnosticsReporter.ts')).drainDiagnosticsEvents()})()"
    )
  const capture = async (name: string, failed: boolean): Promise<void> => {
    await waitFor(
      () =>
        window.webContents.executeJavaScript(
          `!!document.querySelector('.node-card-wrap')&&!document.body.innerText.includes('正在打开本地创作空间')${failed ? "&&document.body.innerText.includes('项目保存失败')" : ''}`
        ) as Promise<boolean>
    )
    await window.webContents.executeJavaScript(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))'
    )
    write(join(directory, name), (await window.webContents.capturePage()).toPNG())
  }
  mutable.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    if (fault === 'write-tmp' && String(args[0]) === path + '.tmp') {
      write(args[0], 'private-save-partial')
      throw Object.assign(new Error('private-save-disk-full'), { code: 'ENOSPC' })
    }
    return write(...args)
  }) as typeof fs.writeFileSync
  mutable.renameSync = ((from, to) => {
    if (fault === 'promote-tmp' && String(from) === path + '.tmp')
      throw Object.assign(new Error('private-save-io-failure'), { code: 'EIO' })
    return rename(from, to)
  }) as typeof fs.renameSync
  mutable.fsyncSync = (fd) => {
    if (fault === 'flush-tmp')
      throw Object.assign(new Error('private-save-flush-failure'), { code: 'EIO' })
    return sync(fd)
  }
  db.prepare = ((sql: string) => {
    if (fault === 'update-db' && sql.startsWith('UPDATE projects SET updated_at'))
      throw Object.assign(new Error('private-save-sqlite-full'), { code: 'SQLITE_FULL' })
    return prepare.call(db, sql)
  }) as typeof db.prepare
  try {
    for (const phase of ['write-tmp', 'flush-tmp', 'promote-tmp', 'update-db']) {
      write(path, '{private-save-corrupt-main')
      fault = phase
      const failed = await window.webContents.executeJavaScript(
        "(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;editor.updateShape({id:'shape:save-source',type:'node-card',props:{text:'private-save-uncommitted'}});let rejected=false;try{await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()}catch{rejected=true}const s=(await import('/src/stores/save-coordinator.ts')).useSaveCoordinator.getState();return rejected&&s.phase==='failed'&&!s.inFlight&&s.dirtyVersion>s.persistedVersion})()"
      )
      if (
        !failed ||
        storedText() !== 'private-save-original' ||
        fs.readFileSync(path + '.bak', 'utf8') !== verified
      )
        throw new Error('R09_FAILED_SAVE_LOST_VERIFIED_SNAPSHOT')
      await drain()
      if (phase === 'write-tmp') await capture('disk-failure.png', true)
      fault = ''
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const gone = new Promise<void>((done) =>
          window.webContents.once('render-process-gone', () => done())
        )
        window.webContents.forcefullyCrashRenderer()
        await Promise.race([
          gone,
          new Promise<never>((_done, reject) => {
            timer = setTimeout(() => reject(new Error('R09_RENDERER_RESTART_TIMEOUT')), 15000)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      await window.loadURL('http://127.0.0.1:5197')
      await waitFor(ready)
      const reopened = await window.webContents.executeJavaScript(
        "(async()=>{const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;return e.getShape('shape:save-source')?.props.text})()"
      )
      if (
        reopened !== 'private-save-original' ||
        openProject(projectId)!.meta.graphVersion !== baseline
      )
        throw new Error('R09_REOPEN_FACT_CHANGED')
    }
    write(path, '{private-save-corrupt-main')
    fault = 'promote-tmp'
    const profile = JSON.stringify({
      projectId,
      workspaceProfile: { schemaVersion: 1, presetId: 'custom', visibleNodeTypeIds: ['text'] }
    })
    const rejected = await window.webContents.executeJavaScript(
      `window.api.saveWorkspaceProfile(${profile})`
    )
    if (rejected.ok || fs.readFileSync(path + '.bak', 'utf8') !== verified)
      throw new Error('R09_WORKSPACE_SAVE_NOT_REJECTED')
    fault = ''
    const accepted = await window.webContents.executeJavaScript(
      `window.api.saveWorkspaceProfile(${profile})`
    )
    if (!accepted.ok || accepted.data.graphVersion !== baseline)
      throw new Error('R09_WORKSPACE_SAVE_CHANGED_GRAPH_VERSION')
    await window.webContents.executeJavaScript(
      "(async()=>{const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;e.updateShape({id:'shape:save-source',type:'node-card',props:{text:'private-save-resumed'}});await(await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved()})()"
    )
    if (
      storedText() !== 'private-save-resumed' ||
      openProject(projectId)!.meta.graphVersion !== baseline + 1
    )
      throw new Error('R09_EXPLICIT_RETRY_NOT_COMMITTED_ONCE')
    await drain()
    await capture('disk-recovered.png', false)
    return {
      boundary: 'storage-retry',
      rendererRestarts: 4,
      phases: ['write-tmp', 'flush-tmp', 'promote-tmp', 'update-db'],
      verifiedBackupPreserved: true,
      failedNotShownAsSaved: true,
      workspaceVersionPreserved: true,
      explicitRetryGraphVersionDelta: 1,
      screenshots: ['disk-failure.png', 'disk-recovered.png']
    }
  } finally {
    fault = ''
    mutable.writeFileSync = write
    mutable.renameSync = rename
    mutable.fsyncSync = sync
    db.prepare = prepare
  }
}
