/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Deterministic contract generation plus explicit change-impact acknowledgement.
// This compiler hook is confined to this maintenance process, never the application runtime.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
require.extensions['.ts'] = (module, file) => {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  module._compile(output, file)
}
const registry = require('../src/shared/agent-access/registry.ts')
const directory = path.join(root, 'docs/local-agent-access/generated')
const option = name => { const at=process.argv.indexOf(name);return at>=0?process.argv[at+1]:undefined }
const snapshotPath = option('--snapshot-file') || path.join(directory, 'contracts.json')
const impactPath = option('--impact-file') || path.join(root, 'docs/local-agent-access/change-impact.json')
const scope = [
  'src/shared/agent-access/', 'src/main/agent-access/', 'src/local-agent/',
  'src/shared/types/', 'src/shared/engine/', 'src/shared/node-schemas.ts',
  'src/renderer/src/nodes/', 'src/main/agent-flow/', 'src/main/ipc/project',
  'src/main/store/projects.repo.ts', 'src/main/store/transfer.ts', 'src/main/store/db-migrations.ts',
  'src/main/index.ts', 'src/shared/observability/', 'scripts/check-agent-access.cjs'
  , 'src/preload/index.ts', 'src/renderer/src/App.tsx', 'src/renderer/src/pages/CanvasPage.tsx',
  'src/renderer/src/canvas/CanvasEditor.tsx', 'src/renderer/src/stores/save-coordinator.ts',
  'src/renderer/src/canvas/flow-asset-actions.ts'
]
function currentFiles() {
  const listing = cp.execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  const files = [...new Set(listing.split('\0'))].filter(file => scope.some(prefix => file.startsWith(prefix)) && /\.(ts|tsx|cjs)$/.test(file)).sort()
  // Git Windows checkouts may use CRLF; a line-ending conversion is not a behavioral change.
  return Object.fromEntries(files.filter(file => fs.existsSync(path.join(root, file))).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file),'utf8').replace(/\r\n/g,'\n')).digest('hex')]))
}
function snapshot() {
  return { apiVersion:1, operations:registry.operationDirectory(), nodes:registry.nodeAccessDirectory() }
}
const errors = registry.validateAccessRegistry()
if (errors.length) { process.stderr.write(errors.join('\n')+'\n'); process.exit(1) }
const now = snapshot()
if (process.argv.includes('--write')) {
  const reasonAt = process.argv.indexOf('--reason')
  const reason = process.argv[reasonAt+1]
  if (reasonAt < 0 || !reason || reason.length < 12) throw new Error('Explicit change impact reason is required')
  // Changing/removing an already published schema requires a version bump or a reviewed migration.
  if (fs.existsSync(snapshotPath) && !process.argv.includes('--accept-contract-change')) {
    const old = JSON.parse(fs.readFileSync(snapshotPath,'utf8'))
    for (const previous of old.operations) {
      const next = now.operations.find(o => o.operationId === previous.operationId)
      if (!next || JSON.stringify(previous.inputSchema)!==JSON.stringify(next.inputSchema) || JSON.stringify(previous.outputSchema)!==JSON.stringify(next.outputSchema)) {
        throw new Error('Contract changed: document compatibility and use --accept-contract-change explicitly')
      }
    }
  }
  fs.mkdirSync(directory,{recursive:true})
  fs.writeFileSync(snapshotPath,JSON.stringify(now,null,2)+'\n')
  fs.writeFileSync(impactPath,JSON.stringify({ schemaVersion:1, reason, declaration:'Registry, transport, persistence, logging and compatibility impact reviewed. See delivery ledger for evidence.', sourceHashes:currentFiles() },null,2)+'\n')
} else {
  const old = JSON.parse(fs.readFileSync(snapshotPath,'utf8'))
  const impact = JSON.parse(fs.readFileSync(impactPath,'utf8'))
  if (JSON.stringify(old)!==JSON.stringify(now)) throw new Error('Generated contract is stale; update registry, compatibility and evidence together')
  if (impact.reason.length < 12 || JSON.stringify(impact.sourceHashes)!==JSON.stringify(currentFiles())) throw new Error('Protected source changed without refreshed Agent-access impact declaration')
  process.stdout.write(`Agent access gate passed: ${now.operations.length} operations; ${now.nodes.length} planned nodes.\n`)
}
