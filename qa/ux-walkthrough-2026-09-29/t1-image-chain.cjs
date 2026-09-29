/* eslint-disable */
// UX 走查 任务1：生图「蓝色立方体」→ P图修改说明 → 裁剪取半幅（专家走查，浏览器演示模式）
// 用法：BROWSER_ORIGIN=http://127.0.0.1:5211 node t1-image-chain.cjs
const { chromium } = require('playwright')
const fs = require('node:fs')
const DIR = __dirname
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5211'
const LOG = []
const note = (m) => { LOG.push(m); console.log('NOTE', m) }
const dumpLog = () => fs.writeFileSync(`${DIR}/t1-observations.log`, LOG.join('\n'), 'utf8')

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const o of attempts) { try { return await chromium.launch({ ...o, headless: true, timeout: 30_000 }) } catch (e) { lastError = e } }
  throw lastError
}
const shot = async (page, name) => { await page.screenshot({ path: `${DIR}/${name}` }); note(`截图 ${name}`) }
/** 悬浮 tooltip / 画布命中层可能拦截常规 click；超时后派发完整 pointer 事件序列兜底。 */
const safeClick = async (page, locator, tag) => {
  try { await locator.click({ timeout: 4000 }); return } catch (e) {
    note(`safeClick[${tag}] 常规点击被拦截，改用 DOM 事件序列`)
    await locator.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const base = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }))
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }))
      el.dispatchEvent(new MouseEvent('click', base))
    })
  }
}
const dumpCard = async (page, id, tag) => {
  const info = await page.evaluate((nodeId) => {
    const el = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
    if (!el) return null
    const btns = [...el.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
    const ports = [...el.querySelectorAll('.port-dot')].map((p) => `${p.classList.contains('out') ? 'out' : 'in'}:${p.dataset.portId}`)
    return { text: el.innerText.replace(/\n{2,}/g, '\n').slice(0, 900), btns: [...new Set(btns)], ports }
  }, id)
  note(`DUMP[${tag}] ${JSON.stringify(info, null, 1)}`)
  return info
}
const dumpToasts = async (page, tag) => {
  const t = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('[class*="toast"]')) { const r = el.getBoundingClientRect(); if (r.width && r.height) out.push(el.innerText.slice(0, 200)) }
    return [...new Set(out)]
  })
  if (t.length) note(`TOASTS[${tag}] ` + JSON.stringify(t))
}
/** 把卡片拖到目标屏幕坐标（抓标题栏左侧空白，避开按钮与端口）。 */
const moveNode = async (page, id, tx, ty) => {
  const box = await page.locator(`.node-card-wrap[data-node-id="${id}"]`).boundingBox()
  if (!box) throw new Error('moveNode: 卡片不存在 ' + id)
  await page.keyboard.press('Escape')
  const sx = box.x + 30, sy = box.y + 12
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(tx, ty, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(400)
}
async function addNodeViaPalette(page, category, chip) {
  const before = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const expand = page.getByRole('button', { name: `展开${category}节点`, exact: true })
  await safeClick(page, expand, `展开${category}`)
  await page.waitForTimeout(600)
  const btn = page.getByRole('button', { name: `添加${chip}节点`, exact: true })
  await safeClick(page, btn, `添加${chip}`)
  await page.waitForTimeout(900)
  const after = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const fresh = after.filter((x) => !before.includes(x))
  if (!fresh.length) throw new Error(`添加${chip}失败`)
  note(`添加节点：${category} → 添加${chip}节点 → node-id=${fresh[0]}`)
  return fresh[0]
}
async function connect(page, fromId, outPort, toId, inPort) {
  await page.keyboard.press('Escape')
  const sel = (id, dir, port) => `.node-card-wrap[data-node-id="${id}"] .port-dot.${dir}[data-port-id="${port}"]`
  const hit = async (s) => {
    for (let i = 0; i < 10; i++) {
      const b = await page.locator(s).boundingBox()
      if (b && b.width > 0 && (await page.locator(s).evaluate((el, c) => { const h = document.elementFromPoint(c.x, c.y); return h === el || el.contains(h) }, { x: b.x + b.width / 2, y: b.y + b.height / 2 }))) return b
      await page.waitForTimeout(150)
    }
    throw new Error('端口不可命中: ' + s)
  }
  const a = await hit(sel(fromId, 'out', outPort))
  const b = await hit(sel(toId, 'in', inPort))
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2
  const bx = b.x + b.width / 2, by = b.y + b.height / 2
  await page.mouse.move(ax, ay); await page.mouse.down()
  await page.waitForTimeout(120)
  for (let s = 1; s <= 16; s++) { await page.mouse.move(ax + ((bx - ax) * s) / 16, ay + ((by - ay) * s) / 16); await page.waitForTimeout(16) }
  await page.mouse.move(bx, by); await page.waitForTimeout(150); await page.mouse.up()
  await page.waitForTimeout(700)
  note(`连线 ${fromId}.${outPort} → ${toId}.${inPort}`)
}
const waitRunSettled = async (page, id, busyWords, timeout = 40_000) => {
  try {
    await page.waitForFunction(({ nodeId, words }) => {
      const el = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
      if (!el) return false
      const t = el.innerText
      return !words.some((w) => t.includes(w))
    }, { nodeId: id, words: busyWords }, { timeout })
    note(`节点 ${id} 运行结束（运行态提示消失）`)
  } catch (e) {
    note(`节点 ${id} ${timeout / 1000}s 内运行态提示未消失`)
  }
  await page.waitForTimeout(800)
}

;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 300)))

  // 1 入口：浏览器演示模式直接进入演示画布
  await page.goto(ORIGIN + '/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  await shot(page, 't1-01-home.png')
  note('浏览器演示模式无主页项目列表，加载后直接进入「浏览器演示项目」空画布')

  // 2 发现性：Ctrl+K 搜索「P图」「生图」（空画布）
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(500)
  const searchInput = page.getByLabel('搜索画布节点或节点库')
  if (await searchInput.count()) {
    await searchInput.fill('P图')
    await page.waitForTimeout(600)
    await shot(page, 't1-03-search-p.png')
    note('搜索「P图」结果：\n' + await page.evaluate(() => document.querySelector('.search-panel')?.innerText.slice(0, 400) || '(无面板)'))
    await searchInput.fill('裁剪')
    await page.waitForTimeout(600)
    note('搜索「裁剪」结果：\n' + await page.evaluate(() => document.querySelector('.search-panel')?.innerText.slice(0, 400) || '(无面板)'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    const escClosed = (await page.locator('.search-overlay').count()) === 0
    note(`Esc 关闭搜索浮层：${escClosed ? '成功' : '失败（浮层仍在）'}`)
    if (!escClosed) {
      await page.getByRole('button', { name: '关闭搜索', exact: true }).click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await page.mouse.move(853, 620)
    await page.waitForTimeout(300)
  }

  // 3 图片创作 flyout
  const expandImage = page.getByRole('button', { name: '展开图片创作节点', exact: true })
  await safeClick(page, expandImage, '展开图片创作')
  await page.waitForTimeout(600)
  note('图片创作 flyout chips：' + JSON.stringify(await page.getByRole('button', { name: /^添加.+节点$/ }).allTextContents()))
  await shot(page, 't1-04-palette-image.png')

  // 4 生图节点
  const genId = await addNodeViaPalette(page, '图片创作', '生图')
  await moveNode(page, genId, 350, 320)
  await dumpCard(page, genId, '生图空态')
  await shot(page, 't1-05-imagegen-empty.png')
  const inPort = page.locator(`.node-card-wrap[data-node-id="${genId}"] .port-dot.in`).first()
  if (await inPort.count()) { await inPort.hover(); await page.waitForTimeout(600); await shot(page, 't1-05b-port-hover.png'); await page.mouse.move(853, 620) }

  // 5 填提示词并运行
  const promptBox = page.locator(`.node-card-wrap[data-node-id="${genId}"] textarea`).first()
  await promptBox.click()
  await promptBox.fill('蓝色立方体')
  await shot(page, 't1-06-prompt-typed.png')
  note('运行入口观察：卡片头「运行节点」+ 卡片体「生成图片」+ 顶栏「运行」并存')
  await safeClick(page, page.locator(`.node-card-wrap[data-node-id="${genId}"]`).getByRole('button', { name: '生成图片' }), '生成图片')
  await page.waitForTimeout(300)
  await shot(page, 't1-07-gen-running.png')
  note('运行中卡片文本：\n' + await page.evaluate((id) => document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)?.innerText.replace(/\n{2,}/g, '\n').slice(0, 400), genId))
  await waitRunSettled(page, genId, ['生成进度', '生成中'])
  await page.waitForTimeout(1500)
  await dumpCard(page, genId, '生图完成后')
  await dumpToasts(page, '生图完成后')
  await shot(page, 't1-08-gen-done.png')
  const mediaMode = await page.evaluate((id) => {
    const el = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
    if (!el) return null
    return {
      hasImg: !!el.querySelector('img'),
      ports: [...el.querySelectorAll('.port-dot')].map((p) => `${p.classList.contains('out') ? 'out' : 'in'}:${p.dataset.portId}`),
      text: el.innerText.replace(/\n{2,}/g, '\n').slice(0, 500)
    }
  }, genId)
  note('生图结果态卡片：' + JSON.stringify(mediaMode, null, 1))

  // 6 P图节点：走用户真实路径——结果卡「对当前图片添加标注并 P 图」一键创建并连线
  const pAction = page.getByRole('button', { name: '对当前图片添加标注并 P 图' }).first()
  if (await pAction.count()) {
    await safeClick(page, pAction, '一键P图')
    await page.waitForTimeout(1400)
    note('点击「对当前图片添加标注并 P 图」自动创建 P图 节点')
  } else { note('生图结果卡上没有 P图 后续动作') }
  const editWrap = page.locator('.node-card-wrap:has(.type-image-edit)').first()
  await editWrap.waitFor({ timeout: 8000 })
  const editId = await editWrap.getAttribute('data-node-id')
  await moveNode(page, editId, 1050, 320)
  await dumpCard(page, editId, 'P图卡（一键创建后）')
  await shot(page, 't1-10-edit-connected.png')
  const edgeInfo = await page.evaluate(() => document.querySelectorAll('.data-edge').length)
  note('画布 .data-edge 数量（>0 即自动连线成功）：' + edgeInfo)
  const cardTextareas = await page.locator(`.node-card-wrap[data-node-id="${editId}"] textarea`).count()
  note(`P图卡片本体内 textarea 数量：${cardTextareas}（0 = 修改说明必须去工作台写）`)
  await safeClick(page, page.locator(`.node-card-wrap[data-node-id="${editId}"]`).getByRole('button', { name: '打开工作台' }), '打开P图工作台')
  await page.waitForTimeout(900)
  await shot(page, 't1-11-edit-workbench.png')
  const wbDump = await page.evaluate(() => {
    const cands = ['.node-workbench', '[class*="workbench"]', '.side-panel', '.node-contract-panel']
    for (const s of cands) {
      const el = document.querySelector(s)
      if (el && el.getBoundingClientRect().width > 100) return { sel: s, text: el.innerText.replace(/\n{2,}/g, '\n').slice(0, 900), textareas: el.querySelectorAll('textarea').length, inputs: el.querySelectorAll('input[type="text"]').length }
    }
    return null
  })
  note('P图工作台：' + JSON.stringify(wbDump, null, 1))
  if (wbDump) {
    const ta = page.locator(`${wbDump.sel} textarea`).first()
    if (await ta.count()) {
      await ta.click()
      await ta.fill('把立方体表面改成金属拉丝质感')
      await page.keyboard.press('Tab')
      await page.waitForTimeout(400)
      note('已在工作台填写修改说明')
    } else { note('工作台内未找到 textarea') }
  }
  await shot(page, 't1-12-edit-instruction.png')
  // 关闭工作台（找关闭按钮或 Esc）
  const closeWb = page.getByRole('button', { name: /关闭|收起/ }).first()
  if (await closeWb.count()) await safeClick(page, closeWb, '关闭工作台')
  else { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
  await page.waitForTimeout(400)
  await safeClick(page, page.locator(`.node-card-wrap[data-node-id="${editId}"] .node-run-btn`), 'P图运行节点')
  await page.waitForTimeout(500)
  await shot(page, 't1-13-edit-running.png')
  await waitRunSettled(page, editId, ['P图中', '运行中', '执行中'])
  await dumpCard(page, editId, 'P图运行后')
  await dumpToasts(page, 'P图运行后')
  await shot(page, 't1-14-edit-after-run.png')

  // 7 裁剪：用户真实路径 = 生图结果卡上的「创建裁剪节点并连接当前图片」
  const cropAction = page.getByRole('button', { name: '创建裁剪节点并连接当前图片' }).first()
  if (await cropAction.count()) {
    await safeClick(page, cropAction, '创建裁剪节点')
    await page.waitForTimeout(1200)
    const ids = await page.$$eval('.node-card-wrap:has(.type-image-crop), .node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
    note('点击「创建裁剪节点并连接当前图片」后画布节点数：' + ids.length)
  } else { note('生图结果卡上没有「创建裁剪节点」动作') }
  // 找到新裁剪卡
  const cropWrap = page.locator('.node-card-wrap:has(.type-image-crop)').first()
  const cropId = await cropWrap.getAttribute('data-node-id')
  note('裁剪节点 id=' + cropId)
  await moveNode(page, cropId, 1450, 320)
  await dumpCard(page, cropId, '裁剪初始（已连上游）')
  await shot(page, 't1-15-crop-inline.png')

  // 精细框选工作台
  const fineBtn = page.locator(`.node-card-wrap[data-node-id="${cropId}"]`).getByRole('button', { name: '精细框选' })
  if (await fineBtn.count()) {
    await safeClick(page, fineBtn, '精细框选')
    await page.waitForTimeout(900)
    await shot(page, 't1-16-crop-workbench.png')
    note('裁剪工作台文本：\n' + await page.evaluate(() => document.querySelector('.crop-settings')?.innerText.replace(/\n{2,}/g, '\n').slice(0, 700) || '(未找到 .crop-settings)'))
    const handle = page.getByRole('button', { name: '调整矩形角点 4' })
    const preview = page.locator('.crop-preview')
    const hb = await handle.boundingBox().catch(() => null)
    const pb = await preview.boundingBox().catch(() => null)
    if (hb && pb) {
      const tx = pb.x + pb.width * 0.5
      const ty = pb.y + pb.height * 0.999
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(tx, ty, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(400)
      note('已拖动角点4 → 选区改为左半幅')
    } else { note('未找到裁剪角点/预览区 hb=' + !!hb + ' pb=' + !!pb) }
    await shot(page, 't1-17-crop-half-rect.png')
    note('工作台状态：' + JSON.stringify(await page.evaluate(() => { const s = document.querySelector('.crop-settings small'); return s ? s.textContent : null })))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  } else { note('裁剪卡没有「精细框选」按钮') }
  await shot(page, 't1-18-crop-inline-selected.png')
  const cropRun = page.locator(`.node-card-wrap[data-node-id="${cropId}"]`).getByRole('button', { name: '裁剪图片' })
  if (await cropRun.count()) {
    await safeClick(page, cropRun, '裁剪图片')
    await waitRunSettled(page, cropId, ['正在裁剪图片', '裁剪中'], 20_000)
  } else { note('没有「裁剪图片」按钮') }
  await dumpCard(page, cropId, '裁剪完成后')
  await shot(page, 't1-19-crop-result.png')
  await dumpToasts(page, '裁剪完成后')

  note('CONSOLE ERRORS: ' + JSON.stringify(errors.slice(0, 12)))
  dumpLog()
  await browser.close()
})().catch((e) => {
  console.error('FAIL', e)
  note('FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)))
  dumpLog()
  process.exitCode = 1
})
