/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Batch-ingest the ai-pose-gallery-zh pose library into the local canvas-studio
// resource library through the external Agent CLI (library.create_resource).
//
// The desktop app must be running with --local-agent-access; this script only
// feeds local file paths to the CLI, bytes never cross the wire.
// After ingesting, run scripts/assign-figure-pose-category.cjs to file the
// resources into the「人物站位」category (public IPC, dedupes blob storage).
//
// Usage:
//   node scripts/ingest-pose-gallery.cjs --repo D:\pose-ingest\repo [--limit 30]
//     [--data data/pose-zh.json] [--filter pair60] [--ledger <path>] [--dry-run] [--data-dir <dir>]
// Records already present in the ledger are skipped, so the run is resumable.
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync, appendFileSync, statSync } = require('node:fs')
const { basename, isAbsolute, join, resolve } = require('node:path')

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
function flag(name) {
  return args.includes(`--${name}`)
}

const repo = option('repo', 'D:\\pose-ingest\\repo')
const dataRelative = option('data', 'data/pose-zh.json')
const limit = Number(option('limit', '0')) || Infinity
const filter = option('filter', '')
const dryRun = flag('dry-run')
const dataDir = option('data-dir', '')
const ledger = option('ledger', resolve(repo, '..', 'ingest-ledger.jsonl'))
const cliPath = option('cli', join(__dirname, '..', 'out', 'main', 'local-agent.js'))

const electron = require('electron')
function runCli(input) {
  const inputPath = join(repo, '..', `ingest-input-${randomUUID()}.json`)
  writeFileSync(inputPath, JSON.stringify(input))
  return new Promise((done, fail) => {
    const child = spawn(
      electron,
      [cliPath, 'library', 'create_resource', ...(dataDir ? ['--data-dir', dataDir] : []), '--input-file', inputPath],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    let output = ''
    let error = ''
    const timer = setTimeout(() => { child.kill(); fail(new Error('CLI_TIMEOUT')) }, 60000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-500) })
    child.once('error', fail)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try { done({ code, response: JSON.parse(output) }) }
      catch { fail(new Error(`CLI_INVALID_RESULT:${code}:${error || output.slice(-200)}`)) }
    })
  })
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

function loadLedger() {
  const done = new Map()
  if (!existsSync(ledger)) return done
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record.id && record.resourceId && record.status === 'created') done.set(record.id, record)
    } catch { /* tolerate a torn trailing line */ }
  }
  return done
}

function buildTitle(record, seen) {
  // Pose records carry 姿势名称+角度; costume records carry 服装名称 only.
  const name = String(record['姿势名称'] || record['服装名称'] || record.id).trim()
  const angle = String(record['角度'] || '').trim()
  const base = angle ? `${name} · ${angle}` : name
  if (!seen.has(base)) return base
  const withNumber = `${base}（${String(record['姿势编号'] || record.id)}）`
  if (!seen.has(withNumber)) return withNumber
  let counter = 2
  while (seen.has(`${base} #${counter}`)) counter += 1
  return `${base} #${counter}`
}

function buildTags(record) {
  const raw = record['姿势名称']
    ? [record['体系'], record['分类'], record['角度'], '姿势模板']
    : [record['分类'], '服装模板', ...(Array.isArray(record['标签']) ? record['标签'] : [])]
  const tags = []
  for (const item of raw) {
    const value = String(item || '').trim().slice(0, 40)
    if (value && !tags.includes(value)) tags.push(value)
  }
  return tags.slice(0, 20)
}

;(async () => {
  if (!existsSync(cliPath)) throw new Error(`CLI missing: ${cliPath} — run "npm run build" first`)
  const dataPath = isAbsolute(dataRelative) ? dataRelative : join(repo, dataRelative)
  const records = JSON.parse(readFileSync(dataPath, 'utf8'))
  if (!Array.isArray(records) || records.length === 0) throw new Error(`No records in ${dataPath}`)
  const finished = loadLedger()
  const seenTitles = new Set([...finished.values()].map((record) => record.title))
  const pending = []
  for (const record of records) {
    if (filter && !String(record.id || '').includes(filter)) continue
    const image = String(record['原图'] || '')
    const extension = image ? image.slice(image.lastIndexOf('.')).toLowerCase() : ''
    if (!IMAGE_EXTENSIONS.has(extension)) continue
    const imagePath = isAbsolute(image) ? image : join(repo, image)
    if (!existsSync(imagePath)) continue
    const title = buildTitle(record, seenTitles)
    seenTitles.add(title)
    pending.push({ id: String(record.id || imagePath), title, tags: buildTags(record), imagePath })
  }
  const skippedLedger = pending.filter((item) => finished.has(item.id)).length
  const queue = pending.filter((item) => !finished.has(item.id)).slice(0, limit)
  console.log(
    `records=${records.length} ingestable=${pending.length} ledger-done=${skippedLedger} queue=${queue.length}${dryRun ? ' (dry-run)' : ''}`
  )
  if (!dryRun && !existsSync(ledger)) appendFileSync(ledger, '')

  let created = 0
  let failed = 0
  const failures = []
  let index = 0
  for (const item of queue) {
    index += 1
    if (dryRun) {
      console.log(`[dry] ${index}/${queue.length} ${item.title} <- ${basename(item.imagePath)}`)
      continue
    }
    if (!process.versions.electron) {
      const size = statSync(item.imagePath).size
      if (size < 1 || size > 128 * 1024 * 1024) {
        failures.push({ ...item, reason: 'SIZE_OUT_OF_RANGE' })
        failed += 1
        continue
      }
    }
    const idempotencyKey = `${Date.now()}:${randomUUID()}`
    let result
    try {
      result = await runCli({ input: { title: item.title, imagePath: item.imagePath, tags: item.tags }, idempotencyKey })
    } catch (error) {
      result = { code: 1, response: { status: 'failed', error: { code: String(error.message || error) } } }
    }
    const { response } = result
    if (response.status === 'completed') {
      created += 1
      appendFileSync(ledger, `${JSON.stringify({ id: item.id, title: item.title, resourceId: response.data.resourceId, status: 'created', ts: Date.now() })}\n`)
    } else {
      failed += 1
      const reason = response.error?.code || `EXIT_${result.code}`
      failures.push({ id: item.id, title: item.title, reason })
      appendFileSync(ledger, `${JSON.stringify({ id: item.id, title: item.title, resourceId: null, status: `failed:${reason}`, ts: Date.now() })}\n`)
    }
    if (index % 10 === 0 || index === queue.length) {
      console.log(`progress ${index}/${queue.length} created=${created} failed=${failed}`)
    }
    if (response.status !== 'completed' && response.error?.code === 'APP_NOT_RUNNING') {
      throw new Error('桌面应用未运行或未开启 Agent 接入：请先用 --local-agent-access 参数启动 canvas-studio')
    }
  }
  console.log(`done: created=${created} failed=${failed} ledger=${ledger}`)
  if (failures.length) {
    console.log('failures:')
    for (const item of failures.slice(0, 20)) console.log(`  - ${item.title}: ${item.reason}`)
    process.exitCode = 2
  }
})().catch((error) => {
  process.stderr.write(`${String(error.message || error)}\n`)
  process.exitCode = 1
})
