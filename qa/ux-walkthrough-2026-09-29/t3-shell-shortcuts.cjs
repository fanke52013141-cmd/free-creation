/* eslint-disable */
// UX 走查 任务3：长标题/多行滚动/混选Delete/弹层叠开/小窗口裁切（UX-C09/C11/C12 专项）
// 用法：BROWSER_ORIGIN=http://127.0.0.1:5211 node t3-shell-shortcuts.cjs
const { chromium } = require('playwright')
const fs = require('node:fs')
const DIR = __dirname
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5211'
const LOG = []
const note = (m) => { LOG.push(m); console.log('NOTE', m) }
const dumpLog = () => fs.writeFileSync(`${DIR}/t3-observations.log`, LOG.join('\n'), 'utf8')

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const o of attempts) { try { return await chromium.launch({ ...o, headless: true, timeout: 30_000 }) } catch (e) { lastError = e } }
  throw lastError
}
const shot = async (page, name) => { await page.screenshot({ path: `${DIR}/${name}` }); note(`截图 ${name}`) }
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
const dumpToasts = async (page, tag) => {
  const t = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('[class*="toast"]')) { const r = el.getBoundingClientRect(); if (r.width && r.height) out.push(el.innerText.slice(0, 150)) }
    return [...new Set(out)]
  })
  if (t.length) note(`TOASTS[${tag}] ` + JSON.stringify(t))
}
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

;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)))

  await page.goto(ORIGIN + '/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  // 1 长标题：双击重命名 60 字标题，检查是否挤掉运行按钮
  const t1 = await addNodeViaPalette(page, '输入与 AI', '文本')
  await moveNode(page, t1, 420, 300)
  const title = page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-title`)
  await title.dblclick()
  await page.waitForTimeout(300)
  const titleInput = page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-title input, .node-card-wrap[data-node-id="${t1}"] .node-title textarea, .node-card-wrap[data-node-id="${t1}"] input.node-title-input`).first()
  const longTitle = '这是一个特别长的节点标题用来验证长标题截断与运行按钮布局——追加验证中文英文Mixed Text 1234567890 结尾'
  if (await titleInput.count()) {
    await titleInput.fill(longTitle)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    note('长标题已输入并 Enter 提交')
  } else {
    note('未找到标题编辑输入框，改用 contentEditable 方案')
    await page.evaluate((t) => { const el = document.activeElement; if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.value = '' }, 0)
  }
  const titleState = await page.evaluate((id) => {
    const w = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
    const t = w?.querySelector('.node-title')
    const r = w?.querySelector('.node-run-btn')
    if (!t || !r) return null
    const tr = t.getBoundingClientRect()
    const rr = r.getBoundingClientRect()
    return {
      shown: t.textContent?.slice(0, 80),
      titleRect: { right: tr.right, width: tr.width, h: tr.height },
      runRect: { left: rr.left, right: rr.right },
      overlap: tr.right > rr.left,
      ellipsized: t.scrollWidth > t.clientWidth + 2
    }
  }, t1)
  note('长标题布局：' + JSON.stringify(titleState, null, 1))
  await shot(page, 't3-01-long-title.png')

  // 2 文本多行滚动 vs 画布缩放（双击进入编辑，点空白处失焦提交；Esc 会丢弃草稿）
  const body = Array.from({ length: 30 }, (_, i) => `第${i + 1}行：画布与内滚动区分测试内容`).join('\n')
  const textDiv = page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-text`)
  await textDiv.dblclick()
  await page.waitForTimeout(300)
  const ta = page.locator(`.node-card-wrap[data-node-id="${t1}"] textarea.node-textarea`)
  await ta.fill(body)
  await page.mouse.click(300, 780)
  await page.waitForTimeout(600)
  const scrollState = await page.evaluate((id) => {
    const w = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
    const b = w?.querySelector('.node-text-body')
    if (!b) return null
    return { scrollH: b.scrollHeight, clientH: b.clientHeight, scrollable: b.scrollHeight > b.clientHeight + 2, overflowY: getComputedStyle(b).overflowY, textLen: (b.textContent || '').length }
  }, t1)
  note('多行文本内滚动状态：' + JSON.stringify(scrollState))
  await shot(page, 't3-02-multiline.png')
  // 滚轮在文本上：画布 zoom 不应变化
  const zoomBefore = await page.evaluate(() => document.querySelector('.tl-container')?.style.transform)
  const bodyBox = await page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-text-body`).boundingBox()
  if (bodyBox) {
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2)
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(500)
  }
  const zoomAfter = await page.evaluate(() => document.querySelector('.tl-container')?.style.transform)
  note(`滚轮于文本上：transform 前=${zoomBefore} 后=${zoomAfter}（相同=未缩放画布）`)
  // 滚轮在空白画布：应缩放
  await page.mouse.move(300, 700)
  const zBefore2 = await page.evaluate(() => document.querySelector('.tl-container')?.style.transform)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(500)
  const zAfter2 = await page.evaluate(() => document.querySelector('.tl-container')?.style.transform)
  note(`滚轮于空白画布：transform 前=${zBefore2} 后=${zAfter2}（不同=画布缩放生效）`)
  await shot(page, 't3-03-after-wheel.png')

  // 3 混选节点+连线 Delete
  const t2 = await addNodeViaPalette(page, '输入与 AI', '文本')
  await moveNode(page, t2, 900, 300)
  await connect(page, t1, 'out-text', t2, 'in-text')
  const countsBefore = await page.evaluate(() => ({ wraps: document.querySelectorAll('.node-card-wrap').length, edges: document.querySelectorAll('.data-edge').length }))
  note('Delete 前：' + JSON.stringify(countsBefore))
  // 3a 焦点在文本输入时按 Delete：只删字符（双击进入编辑态）
  await page.locator(`.node-card-wrap[data-node-id="${t2}"] .node-text`).dblclick()
  await page.waitForTimeout(400)
  const ta2 = page.locator(`.node-card-wrap[data-node-id="${t2}"] textarea.node-textarea`)
  if (await ta2.count()) {
    await ta2.fill('ABCDEF')
    await page.keyboard.press('Home')
    await page.keyboard.press('Delete')
    await page.waitForTimeout(300)
    const v = await ta2.inputValue()
    note(`聚焦文本框按 Delete：值=${v}（预期 BCDEF，节点不删）`)
    const wrapsNow = await page.evaluate(() => document.querySelectorAll('.node-card-wrap').length)
    note(`此时画布节点数=${wrapsNow}（应仍为 ${countsBefore.wraps}）`)
    await page.mouse.click(300, 780)
    await page.waitForTimeout(500)
    const t2still = await page.evaluate((id) => !!document.querySelector(`.node-card-wrap[data-node-id="${id}"]`), t2)
    note(`失焦提交后 t2 节点仍在：${t2still}`)
  } else { note('t2 文本节点未能进入编辑态（无 textarea）') }
  // 3b 混选两张卡 + 一条线，一次 Delete
  await page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-card`).click({ position: { x: 60, y: 14 } })
  await page.waitForTimeout(200)
  let bothSel = false
  for (let i = 0; i < 3 && !bothSel; i++) {
    await page.locator(`.node-card-wrap[data-node-id="${t2}"] .node-card`).click({ position: { x: 60, y: 14 }, modifiers: ['Shift'] })
    await page.waitForTimeout(300)
    bothSel = await page.evaluate(() => document.querySelectorAll('.node-card-wrap.is-selected').length === 2)
  }
  note('两张卡同时选中：' + bothSel)
  // 点选连线（data-edge 中心）
  const edgeBox = await page.evaluate(() => {
    const e = document.querySelector('.data-edge')
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: Math.min(Math.max(r.y + r.height / 2, 60), 860), w: r.width }
  })
  note('连线包围盒中心：' + JSON.stringify(edgeBox))
  if (edgeBox && edgeBox.w > 5) {
    await page.mouse.click(edgeBox.x, edgeBox.y)
    await page.waitForTimeout(300)
  }
  const selState = await page.evaluate(() => ({
    cards: document.querySelectorAll('.node-card-wrap.is-selected').length,
    edgeSelected: document.querySelectorAll('.data-edge.is-selected, .data-edge[data-selected="true"]').length
  }))
  note('混选后选中态：' + JSON.stringify(selState))
  await shot(page, 't3-04-mixed-selection.png')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(900)
  const countsAfter = await page.evaluate(() => ({ wraps: document.querySelectorAll('.node-card-wrap').length, edges: document.querySelectorAll('.data-edge').length }))
  note('一次 Delete 后：' + JSON.stringify(countsAfter) + '（Delete 前 ' + JSON.stringify(countsBefore) + '）')
  await shot(page, 't3-05-after-delete.png')
  // 3c 撤销恢复
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(900)
  const countsUndo = await page.evaluate(() => ({ wraps: document.querySelectorAll('.node-card-wrap').length, edges: document.querySelectorAll('.data-edge').length }))
  note('Ctrl+Z 后：' + JSON.stringify(countsUndo))
  await shot(page, 't3-06-after-undo.png')

  // 4 弹层叠开 + 点外部关闭
  await safeClick(page, page.locator('.node-card-wrap').first().locator('.node-info-btn'), '打开节点说明')
  await page.waitForTimeout(700)
  await shot(page, 't3-07-contract-panel.png')
  const panelTabs = await page.evaluate(() => [...document.querySelectorAll('.node-contract-panel [role="tab"], .node-contract-panel button')].slice(0, 10).map((b) => b.textContent?.trim()))
  note('节点说明面板入口：' + JSON.stringify(panelTabs))
  // 面板上再开一个下拉（找到第一个 app-select-trigger）
  const selTrigger = page.locator('.node-contract-panel .app-select-trigger, .side-panel .app-select-trigger').first()
  let dropdownOpened = false
  if (await selTrigger.count()) {
    await safeClick(page, selTrigger, '面板下拉')
    await page.waitForTimeout(500)
    dropdownOpened = await page.evaluate(() => !!document.querySelector('[role="listbox"], .app-select-content, [data-radix-popper-content-wrapper]'))
    note('面板内下拉打开：' + dropdownOpened)
    await shot(page, 't3-08-panel-with-dropdown.png')
    // 点外部（画布空白处）
    await page.mouse.click(300, 750)
    await page.waitForTimeout(500)
    const dropdownClosed = await page.evaluate(() => !document.querySelector('[role="listbox"], .app-select-content, [data-radix-popper-content-wrapper]'))
    note('点外部后下拉关闭：' + dropdownClosed)
    await shot(page, 't3-09-after-outside-click.png')
  }
  // Esc 关闭说明面板
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const panelGone = await page.evaluate(() => !document.querySelector('.node-contract-panel'))
  note('Esc 关闭节点说明面板：' + panelGone)
  // 搜索浮层 + 说明面板 叠开
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(400)
  await safeClick(page, page.locator('.node-card-wrap').first().locator('.node-info-btn'), '叠开节点说明')
  await page.waitForTimeout(600)
  const stack = await page.evaluate(() => ({ search: !!document.querySelector('.search-overlay'), panel: !!document.querySelector('.node-contract-panel') }))
  note('搜索浮层+说明面板 叠开状态：' + JSON.stringify(stack))
  await shot(page, 't3-10-stacked-layers.png')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const stackAfterEsc = await page.evaluate(() => ({ search: !!document.querySelector('.search-overlay'), panel: !!document.querySelector('.node-contract-panel') }))
  note('一次 Esc 后叠层状态：' + JSON.stringify(stackAfterEsc))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const stackAfterEsc2 = await page.evaluate(() => ({ search: !!document.querySelector('.search-overlay'), panel: !!document.querySelector('.node-contract-panel') }))
  note('两次 Esc 后叠层状态：' + JSON.stringify(stackAfterEsc2))

  // 5 缩小窗口：端口/弹层裁切
  await page.setViewportSize({ width: 1024, height: 620 })
  await page.waitForTimeout(800)
  await shot(page, 't3-11-small-window.png')
  // 打开一个右侧面板看裁切
  await safeClick(page, page.locator('.node-card-wrap').first().locator('.node-info-btn'), '小窗打开说明')
  await page.waitForTimeout(700)
  await shot(page, 't3-12-small-window-panel.png')
  const panelClip = await page.evaluate(() => {
    const p = document.querySelector('.node-contract-panel')
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { left: r.left, right: r.right, vw: window.innerWidth, clippedRight: r.right > window.innerWidth + 1, clippedLeft: r.left < -1 }
  })
  note('小窗口下说明面板矩形：' + JSON.stringify(panelClip))
  // 端口裁切：检查可见卡片的端口是否在视口内
  const portClip = await page.evaluate(() => {
    const out = []
    for (const p of document.querySelectorAll('.port-dot')) {
      const r = p.getBoundingClientRect()
      if (r.width === 0) continue
      if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) out.push({ id: p.dataset.portId, rect: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) } })
    }
    return out
  })
  note('小窗口下越界端口：' + JSON.stringify(portClip))
  // 恢复
  await page.setViewportSize({ width: 1707, height: 900 })
  await page.waitForTimeout(500)

  note('PAGEERRORS: ' + JSON.stringify(errors.slice(0, 8)))
  dumpLog()
  await browser.close()
})().catch((e) => {
  console.error('FAIL', e)
  note('FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)))
  dumpLog()
  process.exitCode = 1
})
