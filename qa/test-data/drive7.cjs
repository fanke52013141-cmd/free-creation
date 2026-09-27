const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.waitForTimeout(600)
  const res = { steps: [] }
  const step = (name, ok, extra) => res.steps.push({ name, ok: !!ok, extra })

  // capture current card texts (expected persisted state)
  const before = []
  const cards = page.locator('.type-text')
  for (let i = 0; i < await cards.count(); i++) before.push((await cards.nth(i).innerText().catch(()=>'')).replace(/\s+/g,' ').trim())
  res.beforeCards = before

  // navigate back home
  const home = page.getByRole('button', { name: '回到主页' })
  if (await home.count()) { await home.click(); await page.waitForTimeout(1200) }
  step('C06 回到主页', await page.getByRole('button',{name:'新建项目',exact:true}).count() > 0, {})

  // reopen the project by name
  const projCard = page.locator('text=B2持久化测试项目').first()
  if (await projCard.count()) { await projCard.click(); await page.waitForTimeout(1200) }
  step('C06 从列表重开项目', await page.locator('.node-palette').count() > 0, {})

  // verify text nodes + text persisted
  const after = []
  const cards2 = page.locator('.type-text')
  for (let i = 0; i < await cards2.count(); i++) after.push((await cards2.nth(i).innerText().catch(()=>'')).replace(/\s+/g,' ').trim())
  res.afterCards = after
  const countMatch = after.length === before.length
  const textMatch = after[0] === before[0] && after[1] === before[1]
  step('DATA01 重开后节点数量一致', countMatch, { before: before.length, after: after.length })
  step('DATA01 重开后文本内容一致', textMatch, { before0: before[0], after0: after[0], before1: before[1], after1: after[1] })

  console.log('RESULT>>>', JSON.stringify(res, null, 2))
  await page.screenshot({ path: 'results/2026-09-23/batch2/evidence/reopen-persist.png' }).catch(()=>{})
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })