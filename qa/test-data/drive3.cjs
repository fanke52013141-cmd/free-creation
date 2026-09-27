const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
  await page.waitForTimeout(600)
  const res = {}
  res.categories = await page.locator('.palette-category-item').allInnerTexts()
  const cat = page.locator('.palette-category-item').filter({ hasText: '文本' }).first()
  res.catExists = await cat.count()
  if (await cat.count()) {
    await cat.hover().catch(()=>{}); await cat.click(); await page.waitForTimeout(600)
    res.flyoutVisible = (await page.locator('.palette-node-flyout').count()) > 0
    res.flyoutNodes = await page.locator('.palette-node-item').allInnerTexts().catch(()=>[])
  }
  const addText = page.getByRole('button', { name: '添加文本节点', exact: true })
  res.addTextExists = await addText.count()
  const before = await page.locator('.type-text').count()
  if (await addText.count()) {
    await addText.click(); await page.waitForTimeout(800)
    const after = await page.locator('.type-text').count()
    res.before = before; res.after = after; res.added = after > before
    const last = page.locator('.type-text').last()
    if (await last.count()) res.lastCardText = (await last.innerText()).slice(0, 60)
  }
  console.log('RESULT>>>', JSON.stringify(res, null, 2))
  for (const [name, sel] of [['flyout-open', '.palette-node-flyout'], ['node-added', '.type-text']]) {
    try { await page.locator(sel).first().screenshot({ path: `results/2026-09-23/batch1/evidence/${name}.png`, timeout: 10000 }) }
    catch (e) { console.log('shot-skip', name, e.message.split('\n')[0]) }
  }
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })