/** 构建后由 scripts/generate-agent-contracts.mjs 调用，禁止人工编辑生成结果。 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { generateAll, normalizeArtifacts } from './index'

const output = resolve(process.env.CANVAS_CONTRACT_OUTPUT || 'generated/agent-contracts.json')
// 归一化逻辑必须与 test/agent/contract-snapshot-fresh.test.ts 共用（见 normalizeArtifacts 注释）。
const stableArtifacts = normalizeArtifacts(generateAll())
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(stableArtifacts, null, 2)}\n`, 'utf-8')
