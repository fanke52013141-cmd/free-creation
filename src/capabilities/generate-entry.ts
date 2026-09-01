/** 构建后由 scripts/generate-agent-contracts.mjs 调用，禁止人工编辑生成结果。 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { generateAll } from './index'

const output = resolve(process.env.CANVAS_CONTRACT_OUTPUT || 'generated/agent-contracts.json')
const artifacts = generateAll()
const stableArtifacts = {
  ...artifacts,
  generatedAt: undefined,
  snapshots: artifacts.snapshots.map((current) => {
    const { snapshotAt, ...snapshot } = current
    void snapshotAt
    return snapshot
  })
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(stableArtifacts, null, 2)}\n`, 'utf-8')
