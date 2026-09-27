const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.waitForTimeout(600)
  const res = { steps: [] }
  const step = (name, ok, extra) => res.steps.push({ name, ok: !!ok, extra })
  const cards = page.locator('.type-text')
  const now = []
  for (let i = 0; i < await cards.count(); i++) now.push((await cards.nth(i).innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,40))
  res.cardTexts = now
  step('N-text-S01 三节点文本读回', now.slice(0,3)[0] && now.slice(0,3)[0].includes('ALPHA'), { now })
  // check for save-related buttons/auto-save indicator
  res.hasRunBtn = await page.getByRole('button',{name:'运行',exact:true}).count()
  // look for persistence signals
  res.saveIndicators = await page.locator('[class*="save"]').allInnerTexts().catch(()=>[])
  // try locating "退出" or "返回" / tabs to navigate back home
  console.log('RESULT>>>', JSON.stringify(res, null, 2))
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })