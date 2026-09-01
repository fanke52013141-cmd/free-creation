import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
execFileSync(process.execPath, [resolve(root, 'scripts/build-agent.mjs')], { stdio: 'inherit' })
execFileSync(process.execPath, [resolve(root, 'out/agent/contract-generator.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, CANVAS_CONTRACT_OUTPUT: resolve(root, 'generated/agent-contracts.json') }
})
