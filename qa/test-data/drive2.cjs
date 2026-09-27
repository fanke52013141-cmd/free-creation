const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.waitForTimeout(400)
  // dump visible buttons + inputs
  const btns = await page.locator('button:visible').allInnerTexts()
  const inputs = await page.locator('input:visible,textarea:visible').count()
  console.log('BTNS=', JSON.stringify(btns.slice(0, 30)))
  console.log('INPUTS=', inputs)
  const input = page.locator('input:visible,textarea:visible').first()
  if (axes = await input.count()) { await input.fill('P1') }
  // click confirm
  for (const name of ['创建项目', '创建', '确定', '确认']) {
    const b = page.getByRole('button', { name, exact: true })
    if (await b.count()) { await b.click(); console.log('clicked', name); break }
  }
  await page.waitForTimeout(1200)
  console.log('HAS_PALETTE=', await page.locator('.node-palette').count())
  await page.screenshot({ path: 'results/2026-09-23/batch1/evidence/after-create.png' }).catch(()=>{})
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })