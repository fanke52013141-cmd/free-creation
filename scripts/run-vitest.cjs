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
  } catch {
    process.stderr.write(
      'SQLite does not match the Electron runtime. Run electron-builder install-app-deps before testing.\n'
    )
    process.exitCode = 1
  }
  if (!process.exitCode) {
    import(require('node:url').pathToFileURL(require.resolve('vitest/vitest.mjs')).href)
  }
}
