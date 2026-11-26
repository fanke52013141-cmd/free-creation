/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Deterministic contract generation plus explicit change-impact acknowledgement.
// This compiler hook is confined to this maintenance process, never the application runtime.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
// 操作登记文件（src/shared/agent-access/ops/*）允许复用共享契约 Schema（例如
// @free-creation/model-contracts），这样外部 Schema 与 GUI 用的是同一份 zod 定义，
// 不会因为"为了能在门禁里跑"而复制一份而漂移。本进程用 tsconfig 的 paths 做解析，
// 只在维护期生效，不影响应用运行时。
const tsconfigPath = path.join(root, 'tsconfig.node.json')
let workspacePaths = {
  '@shared/*': ['src/shared/*'],
  '@free-creation/model-contracts': ['packages/model-contracts/src/index.ts'],
  '@free-creation/model-runtime': ['packages/model-runtime/src/index.ts'],
  '@free-creation/license-protocol': ['packages/license-protocol/src/index.ts']
}
try {
  const parsed = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'))
  if (parsed?.compilerOptions?.paths) workspacePaths = parsed.compilerOptions.paths
} catch {
  // 读不到 tsconfig 时用上面的默认映射（与 tsconfig.node.json 保持一致）。
}
const NodeModule = require('node:module')
const resolveFilename = NodeModule._resolveFilename
NodeModule._resolveFilename = function (request, ...rest) {
  for (const [pattern, targets] of Object.entries(workspacePaths)) {
    const target = Array.isArray(targets) ? targets[0] : undefined
    if (!target) continue
    if (pattern.includes('*')) {
      const [prefix, suffix = ''] = pattern.split('*')
      if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue
      const middle = request.slice(prefix.length, request.length - suffix.length)
      const absolute = path.resolve(root, String(target).replace('*', middle))
      if (fs.existsSync(absolute)) return absolute
    } else if (pattern === request) {
      const absolute = path.resolve(root, String(target))
      if (fs.existsSync(absolute)) return absolute
    }
  }
  return resolveFilename.call(this, request, ...rest)
}
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
  'src/renderer/src/engine/executor.ts', 'src/renderer/src/canvas/snapshot-restore.ts',
  'src/renderer/src/canvas/RunTimeline.tsx', 'src/renderer/src/canvas/CanvasSidePanel.tsx',
  'src/renderer/src/canvas/ChatSidePanel.tsx',
  'src/shared/skill-agent.ts', 'src/shared/contracts/', 'src/main/ipc/skill-library.ipc.ts', 'src/main/ipc/flow-agents.ipc.ts', 'src/main/gateway/',
  'src/shared/agent-access/', 'src/main/agent-access/', 'src/local-agent/',
  'src/shared/agent-flow/', 'src/shared/composite/', 'src/renderer/src/composite/',
  'src/main/ipc/flow-assets.ipc.ts', 'src/main/ipc/flow-commands.ipc.ts', 'src/main/ipc/composite.ipc.ts',
  'src/main/store/composite*.repo.ts', 'src/main/diagnostics/',
  'src/shared/types/', 'src/shared/engine/', 'src/shared/node-schemas.ts',
  'src/renderer/src/nodes/', 'src/main/agent-flow/', 'src/main/ipc/project', 'src/main/ipc/gateway.ipc.ts',
  'src/main/ipc/media.ipc.ts', 'src/main/media/',
  'src/main/store/projects.repo.ts', 'src/main/store/transfer.ts', 'src/main/store/db-migrations.ts',
  'src/main/store/db.ts', 'src/main/store/process-lock.ts',
  'src/main/index.ts', 'src/shared/observability/', 'scripts/check-agent-access.cjs'
  , 'src/preload/index.ts', 'src/renderer/src/App.tsx', 'src/renderer/src/pages/CanvasPage.tsx',
  'src/main/model-host/sqlite-model-host.ts', 'src/main/store/library.repo.ts',
  'src/renderer/src/canvas/CanvasEditor.tsx', 'src/renderer/src/stores/save-coordinator.ts',
  'src/renderer/src/canvas/flow-asset-actions.ts'
]
const SOURCE_FILE = /\.(ts|tsx|cjs)$/
function matchesScope(file, prefix) {
  const star = prefix.indexOf('*')
  if (star < 0) return file.startsWith(prefix)
  const head = prefix.slice(0, star)
  const tail = prefix.slice(star + 1)
  return file.startsWith(head) && file.endsWith(tail) && file.length >= head.length + tail.length
}
function isProtectedSource(file) {
  return SOURCE_FILE.test(file) && scope.some((prefix) => matchesScope(file, prefix))
}
function currentFiles() {
  const listing = cp.execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  const files = [...new Set(listing.split('\0'))].filter(isProtectedSource).sort()
  // Git Windows checkouts may use CRLF; a line-ending conversion is not a behavioral change.
  return Object.fromEntries(files.filter(file => fs.existsSync(path.join(root, file))).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file),'utf8').replace(/\r\n/g,'\n')).digest('hex')]))
}
function assertSourceHashCoverage(declared) {
  const current = currentFiles()
  const hashes = declared && typeof declared === 'object' ? declared : {}
  const missing = Object.keys(current).filter((file) => !Object.prototype.hasOwnProperty.call(hashes, file))
  const stale = Object.keys(hashes).filter((file) => !Object.prototype.hasOwnProperty.call(current, file))
  if (missing.length) throw new Error(`Protected source missing from sourceHashes: ${missing.join(', ')}`)
  if (stale.length) throw new Error(`sourceHashes contains files outside the protected scope: ${stale.join(', ')}`)
  for (const file of Object.keys(current)) {
    if (hashes[file] !== current[file]) throw new Error(`Protected source hash changed without refreshed Agent-access impact declaration: ${file}`)
  }
}
function protectedScopeSelfTest() {
  const current = currentFiles()
  const files = Object.keys(current)
  const errors = []
  for (const prefix of scope) {
    if (!files.some((file) => matchesScope(file, prefix))) errors.push(`PROTECTED_SCOPE_EMPTY:${prefix}`)
  }
  const expectRejected = (label, hashes, pattern) => {
    try {
      assertSourceHashCoverage(hashes)
      errors.push(`SELF_TEST_ACCEPTED_${label}`)
    } catch (error) {
      if (!pattern.test(String(error && error.message))) errors.push(`SELF_TEST_WRONG_ERROR_${label}:${error}`)
    }
  }
  if (files.length > 0) {
    const sample = files[0]
    const missing = { ...current }
    delete missing[sample]
    expectRejected('MISSING_HASH', missing, /missing from sourceHashes/)
    expectRejected('OUT_OF_SCOPE_HASH', { ...current, '__outside_scope__.ts': '0'.repeat(64) }, /outside the protected scope/)
    expectRejected('CHANGED_HASH', { ...current, [sample]: '0'.repeat(64) }, /hash changed/)
  }
  return { errors, fileCount: files.length }
}
if (process.argv.includes('--self-test')) {
  const result = protectedScopeSelfTest()
  if (result.errors.length) {
    process.stderr.write(result.errors.join('\n') + '\n')
    process.exit(1)
  }
  process.stdout.write(`Agent access protected-scope self-test passed: ${result.fileCount} files across ${scope.length} scope entries.\n`)
  process.exit(0)
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
  if (impact.reason.length < 12) throw new Error('Protected source changed without refreshed Agent-access impact declaration')
  assertSourceHashCoverage(impact.sourceHashes)
  process.stdout.write(`Agent access gate passed: ${now.operations.length} operations; ${now.nodes.length} planned nodes.\n`)
}
