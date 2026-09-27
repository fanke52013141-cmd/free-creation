const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.waitForLoadState('domcontentloaded').catch(()=>{})
  await page.waitForTimeout(1000)
  const res = { steps: [] }
  const step = (name, ok, extra) => res.steps.push({ name, ok: !!ok, extra })

  // Helper: expand 文本与AI category, add one text node, then collapse
  const addTextNode = async () => {
    const cat = page.getByRole('button', { name: '展开文本与AI节点' })
    if (await cat.count()) { await cat.hover().catch(()=>{}); await cat.click(); await page.waitForTimeout(350) }
    const addText = page.getByRole('button', { name: '添加文本节点', exact: true })
    if (await addText.count()) { await addText.click(); await page.waitForTimeout(450) }
  }
  const b0 = await page.locator('.type-text').count()
  await addTextNode()
  await addTextNode()
  const b1 = await page.locator('.type-text').count()
  step('C01 同分类连续创建2个文本节点', b1 - b0 === 2, { before: b0, after: b1 })

  // Edit a text node: dblclick the first card showing placeholder, then type
  const cards = page.locator('.type-text')
  let edited = false
  for (let i = 0; i < await cards.count(); i++) {
    if (edited) break
    const txt = (await cards.nth(i).innerText().catch(()=>''))
    if (!txt.includes('双击输入文本')) continue
    await cards.nth(i).dblclick().catch(()=>{})
    await page.waitForTimeout(400)
    const editable = cards.nth(i).locator('[contenteditable="true"], textarea, [role="textbox"], [contenteditable]').first()
    if (await editable.count()) {
      await editable.fill('来源A：ALPHA-01').catch(async()=>{ await page.keyboard.type('来源A：ALPHA-01',{delay:6}) })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      edited = true
      res.editedIndex = i
    }
  }
  step('N-text-S01 编辑文本节点写入(占位卡)', edited, {})
  const now = []
  for (let i = 0; i < await cards.count(); i++) {
    now.push((await cards.nth(i).innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,40))
  }
  res.cardTexts = now
  step('卡片文本读回含标记', edited && now.some((t)=>t.includes('ALPHA')), { now })

  console.log('RESULT>>>', JSON.stringify(res, null, 2))
  // evidence screenshots
  await page.screenshot({ path: 'results/2026-09-23/batch2/evidence/text-nodes.png' }).catch(()=>{})
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })