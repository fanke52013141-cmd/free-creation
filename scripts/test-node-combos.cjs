/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const root = resolve(__dirname, '..')
const tests = [
  'test/connection-matrix.test.ts',
  'test/flow-matrix-basic.test.ts',
  'test/flow-matrix-iterate.test.ts',
  'test/flow-matrix-media.test.ts',
  'test/flow-matrix-model-host.test.ts',
  'test/node-flow-e2e-composition.test.ts'
]
const result = spawnSync(process.execPath, [
  resolve(root, 'scripts/run-vitest.cjs'), 'run', '--maxWorkers=1', '--minWorkers=1', ...tests
], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
