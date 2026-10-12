/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const root = resolve(__dirname, '..')
const result = spawnSync(require('electron'), [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/agent-flow-c0.test.ts', '--maxWorkers=1', '--minWorkers=1'
], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
})
process.exitCode = result.status ?? 1
