const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.waitForLoadState('domcontentloaded').catch(()=>{})
  await page.waitForTimeout(1200)
  const out = {}
  out.bodyHead = (await page.locator('body').innerText().catch(()=>'')).slice(0,200)
  // home vs canvas
  out.hasNewProject = await page.getByRole('button',{name:'新建项目'}).count()
  out.hasPalette = await page.locator('.node-palette').count()
  out.textCards = await page.locator('.type-text').count()
  // input elements
  out.inputs = await page.locator('input').count()
  out.textareas = await page.locator('textarea').count()
  out.contenteditable = await page.locator('[contenteditable="true"]').count()
  // common selectors
  for (const s of ['.canvas-node','.node-card','[data-testid]','.sqlite-save','.project-title','button']) {
    out[s] = await page.locator(s).count()
  }
  // list some buttons
  out.buttons = (await page.locator('button').allInnerTexts().catch(()=>[])).slice(0,30)
  console.log('RESULT>>>', JSON.stringify(out, null, 2))
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })