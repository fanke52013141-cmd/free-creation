/* eslint-disable */
// 代码/数据节点 UX 深度探针（2026-10-05）
//
// 与 node-matrix 的区别：矩阵验证「能不能用」，本探针验证「用起来顺不顺」。
// 聚焦代码 / JSON / 结构数据 / 处理节点的真实用户旅程中的反馈质量：
//  - 错误信息能否定位问题（行号/原因/下一步）
//  - 调试手段（console.log、超时、禁用 API）的用户体验
//  - 复制/占位符等操作的反馈完整性
//  - 文档承诺与实际行为的落差（dayjs 固定时钟、模板提示）
// 全程免费通道：不配供应商、不调模型。隔离数据目录。
const { _electron } = require('playwright')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const DATA_DIR =
  process.env.E2E_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), `canvas-ux-probe-${Date.now()}`)
const SHOT_DIR = path.join(ROOT, 'qa', 'ux-probe-code-data-2026-10-05', 'shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const findings = []
let app
let win
let shotSeq = 0
const log = (...a) => console.log('[probe]', ...a)
function note(area, observation, severity) {
  findings.push({ area, observation, severity })
  log(`[${severity}] ${area} :: ${observation}`)
}
async function shot(name) {
  shotSeq += 1
  const file = path.join(SHOT_DIR, `${String(shotSeq).padStart(2, '0')}-${name}.png`)
  await win.screenshot({ path: file })
  log('截图', file)
}

async function launch() {
  app = await _electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [ROOT],
    env: { ...process.env, CANVAS_DATA_DIR: DATA_DIR, NODE_ENV: 'production' }
  })
  win = await app.firstWindow()
  await win.waitForLoadState()
}

async function freshProject(name) {
  const home = win.getByRole('button', { name: '回到主页' })
  if (await home.count()) await home.click({ timeout: 8000 }).catch(() => home.click({ force: true }))
  const create = win.getByRole('button', { name: '新建项目' })
  await create.waitFor({ timeout: 15000 })
  await create.click()
  await win.locator('input[placeholder="给这个项目起个名字"]').fill(name)
  await win.getByRole('button', { name: '创建项目', exact: true }).click()
  await win.locator('.node-palette').waitFor({ timeout: 30000 })
  slot = 0
  projectId = await win.evaluate(
    async (projectName) =>
      (await window.api.listProjects()).data.find((p) => p.name === projectName).id,
    name
  )
}

const GRID = { originX: 240, originY: 180, cellW: 420, cellH: 420, cols: 4 }
let slot = 0
let projectId = ''
let zoom = 1
const NODE_W = 340
const NODE_H = 260

function card(id) {
  return win.locator(`.node-card-wrap[data-node-id="${id}"]`)
}

async function addNode(label) {
  const where = GRID.originX + (slot % GRID.cols) * GRID.cellW + (NODE_W * zoom) / 2
  const y = GRID.originY + Math.floor(slot / GRID.cols) * GRID.cellH + (NODE_H * zoom) / 2
  const before = await win.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const btn = await revealNodeButton(label)
  slot += 1
  const from = await btn.boundingBox()
  await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await win.mouse.down()
  for (let step = 1; step <= 12; step += 1) {
    await win.mouse.move(from.x + ((where - from.x) * step) / 12, from.y + ((y - from.y) * step) / 12)
    await win.waitForTimeout(20)
  }
  await win.mouse.up()
  for (let i = 0; i < 40; i += 1) {
    await win.waitForTimeout(120)
    const after = await win.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
    const fresh = after.filter((x) => !before.includes(x))
    if (fresh.length) return fresh[0]
  }
  throw new Error(`创建「${label}」节点失败`)
}

async function revealNodeButton(label) {
  const btn = win.getByRole('button', { name: `添加${label}节点`, exact: true })
  if (await btn.isVisible().catch(() => false)) return btn
  const categories = win.locator('.palette-category-item')
  const count = await categories.count()
  for (let index = 0; index < count; index += 1) {
    const category = categories.nth(index)
    await category.hover()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await category.getAttribute('aria-expanded')) === 'true' && await btn.isVisible().catch(() => false)) return btn
      await win.waitForTimeout(80)
    }
    await category.click()
    if (await btn.isVisible().catch(() => false)) return btn
  }
  throw new Error(`未找到「添加${label}节点」`)
}

async function editCodeLike(id, buttonText, value) {
  const c = card(id)
  // 不用 getByRole：个别状态下角色树查询会失效（返回空），CSS+文本定位更稳。
  const btn = c.locator('button').filter({ hasText: new RegExp(buttonText) }).first()
  const n = await btn.count()
  if (n) {
    await btn.scrollIntoViewIfNeeded().catch(() => {})
    await btn.click({ timeout: 5000 }).catch(async (e) => {
      log('按钮点击失败，重试一次：', String(e).slice(0, 120))
      await win.waitForTimeout(600)
      await btn.click({ force: true }).catch(() => {})
    })
  } else {
    const names = await c.locator('button').allInnerTexts().catch(() => [])
    log(`未找到按钮 /${buttonText}/，卡片按钮：`, JSON.stringify(names))
  }
  const ta = c.locator('textarea').last()
  await ta.waitFor({ timeout: 5000 })
  await ta.fill(value)
  await ta.blur()
  await win.waitForTimeout(600)
}

const obj = (v) => {
  if (typeof v !== 'string' || !v) return v ?? {}
  try { return JSON.parse(v) } catch { return {} }
}

async function readDoc() {
  const file = path.join(DATA_DIR, 'projects', projectId, 'project.json')
  for (let round = 0; round < 10; round += 1) {
    if (fs.existsSync(file)) {
      try {
        const project = JSON.parse(fs.readFileSync(file, 'utf8'))
        const snap = project.tldrawSnapshot
        const doc = typeof snap === 'string' ? JSON.parse(snap) : snap
        if (doc) return Object.values(doc.store || doc)
      } catch { /* 正在写盘 */ }
    }
    await win.waitForTimeout(300)
  }
  return []
}

async function readShapes() {
  const raw = await readDoc()
  return new Map(
    raw
      .filter((v) => v && v.props && typeof v.props === 'object' && 'nodeType' in v.props)
      .map((v) => [
        v.id,
        {
          id: v.id,
          nodeType: v.props.nodeType,
          text: v.props.text ?? '',
          exec: v.props.exec,
          config: obj(v.props.config),
          run: obj((v.meta || {}).nodeRun),
          resultRaw: (v.meta || {}).nodeResult ?? ''
        }
      ])
  )
}

async function disk(id, predicate) {
  for (let i = 0; i < 40; i += 1) {
    const shape = (await readShapes()).get(id)
    if (shape && (!predicate || predicate(shape))) return shape
    await win.waitForTimeout(300)
  }
  return (await readShapes()).get(id)
}

async function runNode(id, timeoutSec = 30) {
  const btn = card(id).locator('.node-run-btn')
  const disabled = await btn.isDisabled().catch(() => true)
  if (disabled) return { blocked: true }
  const previous = await disk(id)
  const settled = (s) =>
    s && s.exec !== 'running' && s.exec !== 'queued' &&
    s.run?.runId !== undefined && s.run?.runId !== previous?.run?.runId
  await btn.click()
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    await win.waitForTimeout(400)
    const shape = await disk(id)
    if (settled(shape)) return { blocked: false, shape }
  }
  return { blocked: false, shape: await disk(id), timeout: true }
}

async function pickOption(trigger, optionText) {
  await trigger.click()
  const item = win.getByRole('option', { name: optionText, exact: true })
  await item.waitFor({ timeout: 5000 })
  await item.click()
  await win.waitForTimeout(400)
}

/* ─────────────────────── 探针开始 ─────────────────────── */

async function probeCode() {
  await freshProject('UX-代码')
  const a = await addNode('代码')
  await shot('code-empty')

  // 1. 空代码直接运行：反馈质量
  const st = await card(a).locator('.node-run-btn').isDisabled()
  note('代码/空态', `空代码时运行按钮置灰=${st}；卡片提示=${(await card(a).innerText()).replace(/\n/g, '｜').slice(0, 110)}`, st ? 'info' : 'warn')

  // 2. 运行时 TypeError：能否定位行号
  await editCodeLike(a, '编写代码', 'async function main(args) {\n  const x = null\n  return x.deep.field\n}')
  const r1 = await runNode(a)
  note('代码/运行错误', `TypeError 反馈=${JSON.stringify(r1.shape?.run?.error?.reason ?? r1.shape?.run?.status)}`, 'info')
  await shot('code-runtime-error')
  const errText = await card(a).locator('.code-result.error').innerText().catch(() => '')
  note('代码/运行错误', `卡片错误条内容="${errText.replace(/\n/g, ' ')}"（用户能否知道去哪改？）`, errText.includes('行') || errText.includes('line') ? 'info' : 'warn')

  // 3. console.log 调试：输出去了哪里（检查专用 logs 块，避免匹配到代码正文）
  await editCodeLike(a, '编辑代码', 'async function main(args) {\n  console.log("调试信息XYZ")\n  return "ok"\n}')
  const r2 = await runNode(a)
  const logsBlockCount = await card(a).locator('.code-result-logs').count()
  const logsBlockText = logsBlockCount > 0 ? await card(a).locator('.code-result-logs').innerText() : ''
  note(
    '代码/调试',
    `console.log 运行结果=${r2.shape?.run?.status}；logs 块=${logsBlockCount} 个，内容="${logsBlockText.replace(/\n/g, '｜')}"`,
    logsBlockCount > 0 && logsBlockText.includes('调试信息XYZ') ? 'info' : 'warn'
  )

  // 4. 禁用 API：fetch 的失败反馈（编辑时不拦截，仅运行时）
  await editCodeLike(a, '编辑代码', 'async function main(args) {\n  const r = await fetch("https://example.com")\n  return "done"\n}')
  const r3 = await runNode(a)
  const fetchObj = r3.shape?.run?.error ?? {}; const fetchErr = fetchObj.reason ?? fetchObj ?? r3.shape?.run?.status
  note('代码/禁用API', `fetch 代码反馈=${JSON.stringify(fetchErr)}`, String(fetchErr ?? '').length > 0 ? 'info' : 'warn')
  await shot('code-fetch-blocked')

  // 5. 类型不符：声明输出文本但返回对象
  const b = await addNode('代码')
  await editCodeLike(b, '编写代码', 'async function main(args) {\n  return { a: 1 }\n}')
  // 输出类型默认 any；先声明成 文本
  const outType = card(b).locator('.code-variable-contract .variable-row.output button.app-select-trigger').first()
  await pickOption(outType, '文本')
  const r4 = await runNode(b)
  const errObj = r4.shape?.run?.error ?? {}; const mismatch = String(errObj.reason ?? errObj ?? r4.shape?.run?.status ?? '')
  note('代码/类型不符', `声明文本但返回对象的反馈="${mismatch}"`, mismatch.includes('应返回') ? 'info' : 'warn')
  await shot('code-type-mismatch')

  // 6. dayjs 固定时钟：文档说可用，实际返回 1970
  const c = await addNode('代码')
  await editCodeLike(c, '编写代码', 'async function main(args) {\n  return { now: dayjs().format("YYYY-MM-DD HH:mm:ss") }\n}')
  const r5 = await runNode(c)
  note('代码/确定性', `dayjs() 输出=${String(r5.shape?.resultRaw ?? '').slice(0, 80)}（固定 1970 纪元，界面上有没有任何说明？）`, 'warn')
  await shot('code-dayjs-fixed-clock')

  // 7. 超时体验：while 死循环（10 秒上限）
  // 复用节点 b（视口内第 2 张卡）：新建第 4 张会落到视口外，tldraw 不渲染无 DOM。
  const d = b
  await editCodeLike(d, '编辑代码|编写代码', 'async function main(args) {\n  while (true) { await new Promise((r) => setTimeout(r, 500)) }\n}')
  const t0 = Date.now()
  const r6 = await runNode(d, 30)
  const elapsed = Math.round((Date.now() - t0) / 1000)
  note('代码/超时', `死循环 ${elapsed}s 后反馈=${JSON.stringify(r6.shape?.run?.error?.reason ?? r6.shape?.run?.error ?? r6.shape?.run?.status)}；运行中卡片是否有进度提示=${(await card(d).innerText()).includes('正在') || (await card(d).locator('.node-execution-overlay').count()) > 0}`, 'info')
  await shot('code-timeout')

  // 8. 参数重命名后端口 ID 稳定性（UI 承诺）
  const paramRow = card(a).locator('.code-params-section:not(.code-outputs-section) .code-params-header button')
  await paramRow.click()
  await win.waitForTimeout(500)
  const nameInput = card(a).locator('input.code-param-name').last()
  await nameInput.fill('renamed')
  await win.waitForTimeout(700)
  const shapeNow = await disk(a, (s) => ((s?.config || {}).params || []).some((p) => p.name === 'renamed'))
  const params = (shapeNow?.config || {}).params || []
  note('代码/参数稳定性', `重命名后 params=${JSON.stringify(params)}（portId 是否不变）`, params[0] && params[0].portId === 'in-param-param1' ? 'info' : 'warn')

  await win.keyboard.press('Escape')
}

async function probeJsonStructured() {
  await freshProject('UX-数据')
  const j = await addNode('JSON')

  // 1. 错误定位质量
  await editCodeLike(j, '粘贴 JSON', '{"a": 1,\n "b": [1,2,}')
  const status = await card(j).locator('.json-status').innerText().catch(() => '')
  const statusTitle = await card(j).locator('.json-status').getAttribute('title').catch(() => '')
  note('JSON/错误定位', `非法 JSON 状态徽标="${status}"；tooltip="${(statusTitle || '').slice(0, 120)}"`, status.length > 0 ? 'info' : 'warn')
  await shot('json-error-location')

  // 2. 大数组渲染上限
  const big = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, title: `条目${i}` })))
  await editCodeLike(j, '编辑数据', big)
  await win.waitForTimeout(400)
  const more = await card(j).locator('.json-card-more').innerText().catch(() => '')
  note('JSON/大列表', `60 项列表渲染截断提示="${more}"`, more.includes('未显示') ? 'info' : 'warn')
  await shot('json-large-array')

  // 3. 结构数据占位符复制反馈
  const s = await addNode('结构数据')
  const token = card(s).locator('.structured-token').first()
  await token.click()
  const clip = await win.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  const toastCount = await win.locator('.global-toast').count()
  note('结构数据/复制反馈', `点击 {{text}} 后剪贴板="${clip}"；toast 反馈=${toastCount > 0 ? await win.locator('.global-toast').innerText() : '（无任何反馈）'}`, toastCount > 0 ? 'info' : 'warn')
  await shot('structured-token-copy')

  // 4. 结构数据：Schema 切换时旧正文即时重校验
  await editCodeLike(s, '输入 JSON|编辑', '[{"id":"a"}]')
  await win.waitForTimeout(400)
  const schemaSelect = card(s).locator('button[aria-label="结构 Schema"]')
  await pickOption(schemaSelect, '角色设定')
  await win.waitForTimeout(500)
  const badge = await card(s).locator('.json-status').innerText().catch(() => '')
  note('结构数据/切换Schema', `对象列表→角色设定后状态徽标="${badge}"（应即时转红）`, /不符合/.test(badge) ? 'info' : 'warn')
  await shot('structured-schema-switch')

  // 5. 处理节点固定值 JSON 类型
  const p = await addNode('数据处理')
  const fallback = card(p).locator('input[aria-label="固定值"]')
  await fallback.fill('[1,2,3]')
  const fixType = card(p).locator('button[aria-label="固定值类型"]')
  await pickOption(fixType, '数组')
  const r = await runNode(p)
  const outText = String(r.shape?.resultRaw ?? '')
  note('处理/固定值类型', `固定值 [1,2,3] 按数组解释 → ${outText.slice(0, 90)}`, outText.includes('[1,2,3]') ? 'info' : 'warn')
  await shot('processor-fallback-array')
}

;(async () => {
  await launch()
  await probeCode()
  await probeJsonStructured()
  fs.writeFileSync(
    path.join(ROOT, 'qa', 'ux-probe-code-data-2026-10-05', 'findings.json'),
    JSON.stringify(findings, null, 2)
  )
  log('---- 发现汇总 ----')
  for (const f of findings) log(`[${f.severity}] ${f.area} :: ${f.observation}`)
  await app.close()
})().catch(async (e) => {
  console.error('[probe] 中断', e)
  await app?.close().catch(() => {})
  process.exit(1)
})
