/* eslint-disable */
// UX 走查 任务3 补测：长标题重命名（mousedown detail=2 手势）+ 滚轮缩放（卡片矩形探针）
const { chromium } = require('playwright')
const fs = require('node:fs')
const DIR = __dirname
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5211'
const LOG = []
const note = (m) => { LOG.push(m); console.log('NOTE', m) }
const dumpLog = () => fs.writeFileSync(`${DIR}/t3b-observations.log`, LOG.join('\n'), 'utf8')
async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const o of attempts) { try { return await chromium.launch({ ...o, headless: true, timeout: 30_000 }) } catch (e) { lastError = e } }
  throw lastError
}
const shot = async (page, name) => { await page.screenshot({ path: `${DIR}/${name}` }); note(`截图 ${name}`) }

;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.goto(ORIGIN + '/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  // 添加文本节点
  const before = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const expand = page.getByRole('button', { name: '展开输入与 AI节点', exact: true })
  try { await expand.click({ timeout: 4000 }) } catch { await expand.evaluate((el) => { const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...b, pointerId: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...b, pointerId: 1 })); el.dispatchEvent(new MouseEvent('click', b)) }) }
  await page.waitForTimeout(600)
  const addBtn = page.getByRole('button', { name: '添加文本节点', exact: true })
  try { await addBtn.click({ timeout: 4000 }) } catch { await addBtn.evaluate((el) => { const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...b, pointerId: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...b, pointerId: 1 })); el.dispatchEvent(new MouseEvent('click', b)) }) }
  await page.waitForTimeout(900)
  const after = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const t1 = after.filter((x) => !before.includes(x))[0]
  note('文本节点 ' + t1)

  // 双击标题（mousedown detail=2 原生手势）
  const titleLoc = page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-title`)
  const tb = await titleLoc.boundingBox()
  if (tb) {
    const x = tb.x + 30, y = tb.y + tb.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down(); await page.mouse.up()
    await page.mouse.down(); await page.mouse.up()
    await page.waitForTimeout(500)
  }
  const editingNow = await page.evaluate((id) => {
    const w = document.querySelector(`.node-card-wrap[data-node-id="${id}"] .node-title`)
    return { cls: w?.className, hasInput: !!w?.querySelector('input, textarea'), html: w?.innerHTML.slice(0, 200) }
  }, t1)
  note('双击标题后标题态：' + JSON.stringify(editingNow))
  const titleInput = page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-title input, .node-card-wrap[data-node-id="${t1}"] .node-title textarea`).first()
  if (await titleInput.count()) {
    await titleInput.fill('这是一个特别长的节点标题用来验证长标题截断与运行按钮布局 Mixed Text 1234567890 结尾')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
  } else { note('标题未进入编辑态，放弃长标题测量') }
  const titleState = await page.evaluate((id) => {
    const w = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
    const t = w?.querySelector('.node-title')
    const r = w?.querySelector('.node-run-btn')
    if (!t || !r) return null
    const st = getComputedStyle(t)
    const tr = t.getBoundingClientRect()
    const rr = r.getBoundingClientRect()
    return { shown: t.textContent?.slice(0, 60), titleW: Math.round(tr.width), titleH: Math.round(tr.height), runLeft: Math.round(rr.left), cardRight: Math.round(w.getBoundingClientRect().right), overlap: tr.right > rr.left, whiteSpace: st.whiteSpace, textOverflow: st.textOverflow, overflow: st.overflow }
  }, t1)
  note('长标题布局：' + JSON.stringify(titleState, null, 1))
  await shot(page, 't3b-01-long-title.png')

  // 滚轮缩放探针：卡片屏幕矩形变化
  const cardRect = async () => page.evaluate((id) => { const r = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } : null }, t1)
  const r0 = await cardRect()
  // 滚轮在文本内容上
  const bodyBox = await page.locator(`.node-card-wrap[data-node-id="${t1}"] .node-text`).boundingBox()
  if (bodyBox) {
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2)
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(600)
  }
  const r1 = await cardRect()
  note(`滚轮于文本上：卡片矩形 ${JSON.stringify(r0)} → ${JSON.stringify(r1)}（不变=画布未缩放/平移）`)
  // 滚轮在空白画布
  await page.mouse.move(250, 780)
  const r2pre = await cardRect()
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(600)
  const r2 = await cardRect()
  note(`滚轮于空白画布：卡片矩形 ${JSON.stringify(r2pre)} → ${JSON.stringify(r2)}（变化=画布缩放生效）`)
  await shot(page, 't3b-02-after-wheel-canvas.png')
  dumpLog()
  await browser.close()
})().catch((e) => { console.error('FAIL', e); note('FAIL ' + String(e).slice(0, 300)); dumpLog(); process.exitCode = 1 })
