/* eslint-disable @typescript-eslint/no-require-imports */
// Keep native modules on the same ABI as the desktop app; never rebuild them for QA.
const { spawn } = require('node:child_process')

if (!process.versions.electron) {
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true
  })
  child.on('error', () => {
    process.stderr.write('Unable to start the Electron test runtime.\n')
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
} else {
  try {
    const Database = require('better-sqlite3')
    const database = new Database(':memory:')
    database.close()
  } catch (error) {
    // install-app-deps 依赖预编译产物；Electron 版本缺少可用预编译时会静默保留
    // 系统 Node ABI 的二进制，此时必须从源码重编才能通过本预检。
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    process.stderr.write(
      `SQLite does not match the Electron runtime: ${detail}\n` +
        'Run "npx electron-rebuild -f -w better-sqlite3" to rebuild from source, then retry.\n'
    )
    process.exitCode = 1
  }
  if (!process.exitCode) {
    import(require('node:url').pathToFileURL(require.resolve('vitest/vitest.mjs')).href)
  }
}
