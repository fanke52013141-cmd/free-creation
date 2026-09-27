const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.waitForTimeout(500)
  const res = { steps: [] }
  const step = (name, ok, extra) => res.steps.push({ name, ok: !!ok, extra })

  // Ensure asset panel open
  const open = page.getByRole('button', { name: '打开资产管理' })
  if (!(await page.locator('text=资产中心').count())) { if (await open.count()) { await open.click(); await page.waitForTimeout(600) } }
  step('AS 资产中心面板打开', (await page.locator('text=资产中心').count()) > 0, {})

  // Click 导入素材 and capture filechooser
  const importBtn = page.getByRole('button', { name: '导入素材', exact: true }).first()
  step('AS 导入素材按钮存在', (await importBtn.count()) > 0, {})
  const fixture = 'D:/software/free-creation/qa-fixtures/media/images/I-GRID.png'
  let chooser = null
  const fcPromise = page.waitForEvent('filechooser', { timeout: 6000 }).then((c) => { chooser = c }).catch(()=>{})
  await importBtn.click().catch(()=>{})
  await fcPromise
  if (chooser) {
    await chooser.setFiles(fixture).catch(async (e) => {
      // Electron remote chooser may reject; fallback via input element
      step('AS 文件选择器 setFiles', false, e.message.split('\n')[0])
    })
    step('AS 文件选择器出现', true, {})
    await page.waitForTimeout(2500)
  } else {
    step('AS 文件选择器出现', false, 'no chooser event after click')
  }

  // Assert asset card using name I-GRID
  await page.waitForTimeout(1500)
  const gridCard = page.locator('text=I-GRID').first()
  step('AS03/AS01 素材 I-GRID 出现(名称保留)', (await gridCard.count()) > 0, {})
  const gridCard2 = page.locator('text=I-GRID.png').first()
  step('AS03 文件名含.png 保留原名', (await gridCard2.count()) > 0, {})

  // persistence via browser reload of same project context
  const cardCountBefore = await page.locator('[class*="asset"][class*="card"], .asset-grid [data-testid]').count().catch(()=> -1)
  await page.screenshot({ path: 'results/2026-09-23/batch3/evidence/asset-import.png' }).catch(()=>{})
  await browser.close()
  console.log('RESULT>>>', JSON.stringify(res, null, 2))
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })