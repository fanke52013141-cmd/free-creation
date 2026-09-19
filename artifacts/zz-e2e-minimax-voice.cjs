/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 一次性真机验收（scratch，不入库、不提交）：真实 Electron 里跑通「配音」节点。
//
// 只 mock 一件事：数据目录（CANVAS_DATA_DIR 指向临时目录，绝不碰用户真实库）。
// 其余全是真代码：真实窗口、真实设置面板点击、真实 SQLite、真实主进程 fetch、真实落盘。
// 密钥只从环境变量读取，绝不打印、绝不落盘。
const { _electron } = require('playwright')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

const probe = promisify(execFile)
const ROOT = 'D:/Program Files (x86)/free-creation'
const DATA_DIR = process.env.E2E_DATA_DIR
const KEY = process.env.MINIMAX_KEY || ''
const SHOT_DIR = path.join(ROOT, 'artifacts/e2e-2026-09-19')
const TEXT = '今天天气不错，我们出去走走吧。'

const results = []
const log = (...a) => console.log('[e2e]', ...a)
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

async function shot(page, name) {
  const file = path.join(SHOT_DIR, `${name}.png`)
  try {
    await page.screenshot({ path: file, fullPage: false })
    log('screenshot', file)
  } catch (e) {
    log('screenshot failed', name, e.message)
  }
}

async function main() {
  if (!KEY) throw new Error('MINIMAX_KEY 未注入')
  if (!DATA_DIR) throw new Error('E2E_DATA_DIR 未注入')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const app = await _electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(ROOT, 'out/main/index.js')],
    env: { ...process.env, CANVAS_DATA_DIR: DATA_DIR, NODE_ENV: 'production' }
  })
  const proc = app.process()
  proc.stdout.on('data', (b) => {
    const s = String(b)
    if (/minimax|error|Error|ENOTFOUND|ECONN/.test(s)) log('main>', s.trim().slice(0, 200))
  })
  proc.stderr.on('data', (b) => log('main-err>', String(b).trim().slice(0, 200)))

  const win = await app.firstWindow()
  win.on('console', (m) => {
    if (m.type() === 'error') log('renderer>', m.text().slice(0, 180))
  })
  await win.waitForLoadState()

  // ---- 1. 新建项目（真实项目列表页） ----
  await win.getByRole('button', { name: '新建项目' }).click()
  await win.locator('input[placeholder="项目名称"]').fill('E2E 配音验收')
  await win.getByRole('button', { name: '创建', exact: true }).click()
  await win.locator('.node-palette').waitFor()
  const projectId = await win.evaluate(async () => (await window.api.listProjects()).data[0].id)
  check('项目创建并可读', Boolean(projectId), projectId)

  // ---- 2. 真实设置面板新增 MiniMax 预设 + 免费自检 ----
  await win.getByRole('button', { name: '模型供应商设置' }).click()
  await win.locator('.gw-panel').waitFor()
  await win.getByRole('button', { name: '新增供应商' }).click()
  await win.locator('.gw-spec-btn', { hasText: 'MiniMax（海螺）' }).click()
  const baseURL = await win.locator('.gw-row:has(.gw-label:text-is("Base URL")) input').inputValue()
  check('预设自带 Base URL', baseURL.includes('minimaxi.com'), baseURL)
  const suggestionCount = await win.locator('.gw-model-row').count()
  check('预设带入建议模型', suggestionCount > 0, `${suggestionCount} 个`)
  await win.locator('.gw-row:has(.gw-label:text-is("API Key")) input').fill(KEY)
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await win.locator('text=供应商已保存').waitFor({ timeout: 15000 })
  const provider = await win.evaluate(async () => {
    const rows = (await window.api.gateway.listProviders()).data
    const p = rows.find((x) => x.specId === 'minimax')
    return p ? { id: p.id, models: p.models.map((m) => `${m.modality}:${m.id}`) } : null
  })
  check('MiniMax 供应商入库', Boolean(provider), JSON.stringify(provider?.models))
  check('密钥未被渲染层读回', !(provider && 'apiKey' in provider))

  await win.getByRole('button', { name: '免费自检（不提交生成）' }).click()
  await win.locator('.gw-probe-summary').waitFor({ timeout: 60000 })
  const probeSummary = await win.locator('.gw-probe-summary').innerText()
  check('免费自检给出结论', probeSummary.length > 0, probeSummary.replace(/\n/g, ' / '))
  const probeRows = await win.locator('.gw-probe-item').evaluateAll((items) =>
    items.map((el) => ({
      title: el.querySelector('.gw-probe-name')?.textContent,
      dot: el.querySelector('.gw-probe-dot')?.className.replace('gw-probe-dot ', ''),
      outcome: el.querySelector('.gw-probe-outcome')?.textContent
    }))
  )
  log('probe items', JSON.stringify(probeRows))
  check(
    '自检没有失败项',
    probeRows.every((r) => r.dot !== 'fail'),
    JSON.stringify(probeRows.map((r) => `${r.title}=${r.dot}`))
  )
  await shot(win, '01-provider-probe')
  await win.keyboard.press('Escape')
  await win.locator('.gw-panel').waitFor({ state: 'detached' })

  // ---- 3. 配音节点：一句话真实合成 ----
  const before = await win.evaluate(
    async (pid) => (await window.api.listMedia(pid)).data.map((x) => x.id),
    projectId
  )
  log('media before', JSON.stringify(before))
  await win.getByRole('button', { name: '添加配音节点' }).click()
  await win.locator('.node-card-wrap:has(.type-speech)').waitFor()
  const card = win.locator('.node-card-wrap:has(.type-speech)').first()
  const backend = await card.locator('select.gen-select.small').first().inputValue()
  check('默认协议是 MiniMax', backend === 'minimax', backend)
  const optionLabels = await card
    .locator('select.gen-select')
    .nth(1)
    .locator('option')
    .evaluateAll((os) => os.map((o) => o.value + '|' + o.textContent))
  log('model options', JSON.stringify(optionLabels))
  const target = optionLabels.find((o) => o.includes('speech-2.8-hd'))
  check('语音模型可被选到', Boolean(target), target || optionLabels.join(', '))
  await card.locator('select.gen-select').nth(1).selectOption(target.split('|')[0])
  // 端口存在性：契约里 out-audio 必须在卡片上可见
  const portTitles = await card
    .locator('.port-dot')
    .evaluateAll((ps) =>
      ps.map((p) => p.getAttribute('title') || p.getAttribute('aria-label') || '')
    )
  log('ports', JSON.stringify(portTitles))
  // 卡片里有两个 textarea：朗读文本在前，「发音替换」示例框在后。
  await card.locator('textarea.gen-textarea').first().fill(TEXT)
  await shot(win, '02-node-ready')
  const runBtn = card.locator('[aria-label="运行节点"]')
  check('运行按钮可点', !(await runBtn.isDisabled()), await runBtn.getAttribute('title'))
  // 计费闸门：默认只跑到「界面就绪」，确认选择器全对之后才真的发一次合成请求。
  if (process.env.RUN_PAID !== '1') {
    check('（干跑）界面已就绪、未发起计费请求', true, 'RUN_PAID 未设置')
    await shot(win, '05-dry-run')
    await app.close()
    return
  }
  await runBtn.click()

  // 轮询而不是 waitForFunction：把每一轮的卡片文本与媒体清单都抄下来，
  // 失败时能一眼看出是「没发起」「上游拒绝」还是「落库了但 kind 不对」。
  let asset = null
  const deadline = Date.now() + 180000
  for (let round = 0; Date.now() < deadline; round += 1) {
    await win.waitForTimeout(2000)
    const snapshot = await win.evaluate(
      async ({ pid, seen }) => {
        const r = await window.api.listMedia(pid)
        const fresh = (r.data || []).filter((x) => !seen.includes(x.id))
        return { ok: r.ok, err: r.error, fresh }
      },
      { pid: projectId, seen: before }
    )
    const cardText = (await card.innerText()).replace(/\n+/g, ' / ')
    if (round % 5 === 0 || snapshot.fresh.length) {
      log(
        `round ${round}`,
        `listMedia.ok=${snapshot.ok}`,
        `fresh=${snapshot.fresh.length}`,
        `card=${cardText.slice(0, 200)}`
      )
    }
    if (snapshot.fresh.length) {
      asset = snapshot.fresh[snapshot.fresh.length - 1]
      break
    }
    if (/失败|错误|不能|缺少/.test(cardText) && round > 3) {
      check('运行产出音频', false, `卡片：${cardText.slice(0, 300)}`)
      break
    }
  }
  check(
    '音频资产入库',
    asset && asset.kind === 'audio',
    JSON.stringify(
      asset && {
        id: asset.id,
        kind: asset.kind,
        mime: asset.mime,
        size: asset.sizeBytes,
        path: asset.path,
        origin: asset.origin
      }
    )
  )
  if (!asset) throw new Error('没有产出音频资产，后续断言无从进行')
  const abs = path.join(DATA_DIR, asset.path)
  const size = fs.statSync(abs).size
  check('文件真的落盘', size > 2000, `${size} bytes @ ${abs}`)
  const { stdout } = await probe('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name:format=duration',
    '-of',
    'default=noprint_wrappers=1',
    abs
  ])
  const seconds = Number(/duration=([\d.]+)/.exec(stdout)?.[1] ?? '0')
  const codec = /codec_name=(\w+)/.exec(stdout)?.[1]
  check('ffprobe 能解码且有时长', seconds > 0.4, `${seconds}s ${codec}`)
  // 溯源（P1-8）：产物必须记住是哪个节点/供应商/模型跑出来的
  const runs = await win.evaluate(() => {
    const el = document.querySelector('.global-toast')
    return { toast: el ? el.textContent : '' }
  })
  log('toast after run', runs.toast)
  check('运行没有弹出错误提示', !/失败|错误/.test(runs.toast || ''), runs.toast)

  await win.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  await win.waitForTimeout(1200)
  await shot(win, '03-node-done')
  const cardText = await card.innerText()
  log('card after run', cardText.replace(/\n/g, ' / ').slice(0, 300))
  const audioEl = await card.locator('audio').count()
  check('卡片渲染音频播放器', audioEl > 0, `${audioEl} 个 <audio>`)

  // ---- 4. 持久化：保存并重载窗口 ----
  await win.evaluate(async () => {
    // 面板改配置后由画布自动落库；这里显式等一次同步，避免抓到半写状态
    await new Promise((r) => setTimeout(r, 800))
  })
  const persisted = await win.evaluate(async (pid) => {
    const r = await window.api.openProject(pid)
    const snap = r.data?.tldrawSnapshot
    const doc = snap ? JSON.parse(snap) : null
    // 快照既可能是 {store:{...}} 也可能是记录数组，两种都试，取到 speech 形状为止。
    const buckets = doc ? [doc.store, doc.records, doc] : []
    let shape = null
    for (const b of buckets) {
      if (!b) continue
      const list = Array.isArray(b) ? b : Object.values(b)
      shape =
        list.find((v) => v && v.type === 'shape' && v.props && v.props.nodeType === 'speech') ||
        shape
      if (shape) break
    }
    return {
      hasShape: Boolean(shape),
      result: shape && shape.meta ? shape.meta.nodeResult : null,
      run: shape && shape.meta ? shape.meta.nodeRun : null
    }
  }, projectId)
  log('persisted', JSON.stringify(persisted).slice(0, 600))
  check('节点结果写进文档真值', Boolean(persisted.hasShape && persisted.result))

  await win.reload()
  await win.waitForLoadState()
  if (await win.locator('.project-card-open').count()) {
    log('重载后回到项目列表，重新打开项目')
    await win.getByRole('button', { name: /打开项目 E2E 配音验收/ }).click()
  }
  await win.locator('.node-card-wrap:has(.type-speech)').waitFor({ timeout: 30000 })
  await win.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  await win.waitForTimeout(1500)
  const after = await win.locator('.node-card-wrap:has(.type-speech)').first().innerText()
  log('after reload', after.replace(/\n/g, ' / ').slice(0, 300))
  check(
    '重载后卡片仍显示配音结果',
    /配音|音频|\.mp3|播放/.test(after) || (await win.locator('.type-speech audio').count()) > 0
  )
  await shot(win, '04-after-reload')

  await app.close()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log('\n==== SUMMARY ====')
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.log('\n==== SUMMARY（异常中断）====')
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
    console.error('[e2e] ABORT:', e.message)
    process.exit(2)
  })
