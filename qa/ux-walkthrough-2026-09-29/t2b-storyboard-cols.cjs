/* eslint-disable */
// 补测：分镜板手填后的表格列宽分布（scene 列是否被压缩不可读）
const { chromium } = require('playwright')
const fs = require('node:fs')
const DIR = __dirname
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5211'
const LOG = []
const note = (m) => { LOG.push(m); console.log('NOTE', m) }
const dumpLog = () => fs.writeFileSync(`${DIR}/t2b-observations.log`, LOG.join('\n'), 'utf8')
async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const o of attempts) { try { return await chromium.launch({ ...o, headless: true, timeout: 30_000 }) } catch (e) { lastError = e } }
  throw lastError
}
;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.goto(ORIGIN + '/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  const before = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const expand = page.getByRole('button', { name: '展开流程与高级节点', exact: true })
  await expand.click({ timeout: 5000 }).catch(async () => { await expand.evaluate((el) => { const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...b, pointerId: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...b, pointerId: 1 })); el.dispatchEvent(new MouseEvent('click', b)) }) })
  await page.waitForTimeout(600)
  const addBtn = page.getByRole('button', { name: '添加分镜板节点', exact: true })
  await addBtn.click({ timeout: 5000 }).catch(async () => { await addBtn.evaluate((el) => { const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...b, pointerId: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...b, pointerId: 1 })); el.dispatchEvent(new MouseEvent('click', b)) }) })
  await page.waitForTimeout(900)
  const after = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const sbId = after.filter((x) => !before.includes(x))[0]
  // 新增 2 镜并填 scene/dialogue
  const wrap = `.node-card-wrap[data-node-id="${sbId}"]`
  const addShot = page.locator(wrap).getByRole('button', { name: '新增镜头' }).first()
  for (let i = 0; i < 2; i++) { await addShot.click({ timeout: 5000 }).catch(async () => { await addShot.evaluate((el) => { const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...b, pointerId: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...b, pointerId: 1 })); el.dispatchEvent(new MouseEvent('click', b)) }) }); await page.waitForTimeout(400) }
  const rows = await page.evaluate((id) => [...document.querySelectorAll(`.node-card-wrap[data-node-id="${id}"] .storyboard-table tbody tr`)].map((tr) => tr.dataset.shotId), sbId)
  for (const [idx, shot] of rows.entries()) {
    for (const [field, text] of [['scene', `画面描述${idx + 1}：雨夜霓虹街头特写`], ['dialogue', idx === 0 ? '别回头' : ''], ['duration', `${idx + 3}s`]]) {
      const cellSel = `${wrap} [data-shot-id="${shot}"] [data-field="${field}"]`
      if (await page.locator(`${cellSel} .storyboard-cell-editor textarea`).count()) {
        await page.locator(`${cellSel} .storyboard-cell-editor textarea`).first().fill(text)
      } else {
        await page.locator(`${cellSel} .storyboard-cell-value`).dblclick()
        await page.waitForTimeout(250)
        await page.locator(`${cellSel} .storyboard-cell-editor textarea`).first().fill(text)
      }
      await page.locator(cellSel).getByRole('button', { name: '保存', exact: true }).first().click()
      await page.waitForTimeout(300)
    }
  }
  const cols = await page.evaluate((id) => {
    const w = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
    const table = w?.querySelector('.storyboard-table')
    if (!table) return null
    const heads = [...table.querySelectorAll('thead th')].map((th) => ({ text: th.innerText.trim(), w: Math.round(th.getBoundingClientRect().width) }))
    const firstRow = [...table.querySelectorAll('tbody tr')][0]
    const cells = firstRow ? [...firstRow.querySelectorAll('td')].map((td) => ({ field: td.dataset.field, w: Math.round(td.getBoundingClientRect().width), text: (td.innerText || '').trim().slice(0, 24) })) : []
    const tableW = Math.round(table.getBoundingClientRect().width)
    return { tableW, heads, cells }
  }, sbId)
  note('分镜表列宽：' + JSON.stringify(cols, null, 1))
  await page.screenshot({ path: `${DIR}/t2b-01-storyboard-cols.png` })
  note('截图 t2b-01-storyboard-cols.png')
  dumpLog()
  await browser.close()
})().catch((e) => { console.error('FAIL', e); note('FAIL ' + String(e).slice(0, 300)); dumpLog(); process.exitCode = 1 })
