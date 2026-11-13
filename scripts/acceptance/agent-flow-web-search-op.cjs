/* eslint-disable */
// C2 外部 op webSearch.run 桌面级验收：双确认默认拒绝（不发请求）+ 真实豆包搜索（免费额度）。
// 搜索 key 经 CANVAS_DOUBAO_SEARCH_KEY（不进仓库/日志/回复）。无需决策模型。
// 前置：CANVAS_OWNER=1 构建。运行：node scripts/acceptance/agent-flow-web-search-op.cjs
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '..', '..')
const evidenceDir = path.join(root, 'qa', 'agent-flow-web-search-op')
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cli(dir, args, input) {
  const file = path.join(dir, `input-${randomUUID()}.json`)
  if (input) fs.writeFileSync(file, JSON.stringify({ input, idempotencyKey: key() }))
  return await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [
      path.join(root, 'out/main/local-agent.js'),
      ...args, '--data-dir', dir,
      ...(input ? ['--input-file', file] : [])
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 90000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err = (err + c).slice(-1000)))
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try { resolve({ code, response: JSON.parse(out), err }) } catch { resolve({ code, response: null, raw: out, err }) }
    })
  })
}
const ok = (res, label) => {
  if (res.code !== 0 || !res.response || res.response.error)
    throw new Error(`${label}:${JSON.stringify(res.response || res).slice(0, 700)}`)
  return res.response.data
}
const errCode = (res) => res.response?.error?.code ?? res.response?.status ?? null

;(async () => {
  if (!process.env.CANVAS_DOUBAO_SEARCH_KEY) throw new Error('CANVAS_DOUBAO_SEARCH_KEY_MISSING')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-web-search-op-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  await fsp.mkdir(evidenceDir, { recursive: true })
  let app
  const receipt = { mode: 'external op webSearch.run (doubao free quota)', checks: [], outputs: {} }
  const check = (label) => { receipt.checks.push(label); console.log(`[check] ${label}`) }
  const assert = (cond, label) => { if (!cond) throw new Error(`ASSERT_FAILED:${label}`); check(label) }
  try {
    const launchEnv = { ...process.env, CANVAS_DATA_DIR: dir }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root, '--local-agent-access'], env: launchEnv })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(dir, 'agent-access/connection.json'))) break
      await sleep(200)
    }
    if (!fs.existsSync(path.join(dir, 'agent-access/connection.json'))) throw new Error('CONNECTION_NOT_READY')

    // 1. 操作目录可见（CLI contracts 与 MCP tools/list 同源派生）。
    const contracts = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [
        path.join(root, 'out/main/local-agent.js'), 'contracts', '--data-dir', dir
      ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.once('exit', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(e) } })
    })
    assert(Array.isArray(contracts.operations) && contracts.operations.some((o) => (o.id ?? o.operationId ?? o) === 'webSearch.run'), '操作目录含 webSearch.run（CLI/MCP 自动派生）')

    // 2. 未配置密钥时双确认也拒绝（WEB_SEARCH_NO_KEY，不发请求）。
    const noKey = await cli(dir, ['webSearch', 'run'], { query: '测试', confirmNetwork: true, confirmCost: true })
    assert(errCode(noKey) === 'WEB_SEARCH_NO_KEY', '未配置搜索连接密钥拒绝 WEB_SEARCH_NO_KEY')

    // 3. 配置搜索专用连接（legacy provider，真实豆包端点）。
    ok(await cli(dir, ['provider', 'save'], {
      id: 'doubao-search', name: '豆包搜索', specId: 'openai-compatible',
      baseUrl: 'https://open.feedcoopapi.com', apiKey: process.env.CANVAS_DOUBAO_SEARCH_KEY, models: []
    }), 'SEARCH_PROVIDER_SAVE')
    check('配置豆包搜索连接 doubao-search（真实端点 open.feedcoopapi.com）')

    // 4. 缺 confirmNetwork 拒绝（不发请求）。
    const noNet = await cli(dir, ['webSearch', 'run'], { query: '测试' })
    assert(errCode(noNet) === 'NETWORK_CONFIRM_REQUIRED', '缺 confirmNetwork 拒绝 NETWORK_CONFIRM_REQUIRED')

    // 5. 缺 confirmCost 拒绝（不发请求）。
    const noCost = await cli(dir, ['webSearch', 'run'], { query: '测试', confirmNetwork: true })
    assert(errCode(noCost) === 'COST_CONFIRM_REQUIRED', '缺 confirmCost 拒绝 COST_CONFIRM_REQUIRED')

    // 6. 双确认真实搜索（免费额度内，已授权）。
    let search = null
    for (let attempt = 0; attempt < 3; attempt++) {
      search = await cli(dir, ['webSearch', 'run'], { query: '人机协同 智能制造 2026', count: 5, confirmNetwork: true, confirmCost: true })
      if (search.code === 0 && !search.response?.error) break
      await sleep(1500)
    }
    const data = ok(search, 'REAL_SEARCH')
    assert(data.resultCount > 0 && data.items.length > 0, `真实搜索返回 ${data.resultCount} 条结果`)
    assert(data.items.every((it) => typeof it.url === 'string' && typeof it.summary === 'string'), '结果项含 url/summary 结构化字段')
    receipt.outputs.resultCount = data.resultCount
    receipt.outputs.firstTitle = data.items[0]?.title ?? ''
    fs.writeFileSync(path.join(evidenceDir, 'search-result.json'), JSON.stringify(data, null, 2))
    check('搜索结果留档 qa/agent-flow-web-search-op/search-result.json')

    receipt.ok = true
  } catch (error) {
    receipt.ok = false
    receipt.error = String(error?.stack || error).slice(0, 1500)
  } finally {
    fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    if (app) await app.close().catch(() => {})
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  console.log(receipt.ok ? 'ACCEPTANCE OK' : 'ACCEPTANCE FAILED')
  process.exit(receipt.ok ? 0 : 1)
})()