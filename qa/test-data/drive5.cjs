const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.waitForLoadState('domcontentloaded').catch(()=>{})
  await page.waitForTimeout(800)
  const res = { steps: [] }
  const step = (name, ok, extra) => res.steps.push({ name, ok: !!ok, extra })

  // Create project A (skip if already in canvas)
  const onCanvas = await page.locator('.node-palette').count() > 0
  if (!onCanvas) {
    const newProj = page.getByRole('button', { name: '新建项目' })
    if (await newProj.count()) {
      await newProj.click(); await page.waitForTimeout(400)
      const nameInput = page.locator('input').first()
      if (await nameInput.count()) { await nameInput.fill('B2持久化测试项目'); await page.waitForTimeout(200) }
      const create = page.getByRole('button', { name: '创建', exact: true })
      if (await create.count()) { await create.click(); await page.waitForTimeout(1000) }
      step('POR 新建项目进入画布', await page.locator('.node-palette').count() > 0, {})
    } else {
      step('POR 新建项目进入画布', false, 'no new-project button')
    }
  } else {
    step('POR 新建项目进入画布', true, { skipped: 'already on canvas' })
  }

  // add 3 text nodes
  const addTextNode = async () => {
    const cat = page.locator('.palette-category-item').filter({ hasText: '文本与 AI' }).first()
    if (await cat.count()) { await cat.hover().catch(()=>{}); await cat.click(); await page.waitForTimeout(300) }
    const addText = page.getByRole('button', { name: '添加文本节点', exact: true })
    if (await addText.count()) { await addText.click(); await page.waitForTimeout(400) }
  }
  const b0 = await page.locator('.type-text').count()
  await addTextNode(); await addTextNode(); await addTextNode()
  const b1 = await page.locator('.type-text').count()
  step('C01 连续创建3个文本节点', b1 - b0 === 3, { before: b0, after: b1 })

  // edit first two nodes with marked text
  const cards = page.locator('.type-text')
  let edited = 0
  for (let i = 0; i < Math.min(await cards.count(), 3); i++) {
    const txt = (await cards.nth(i).innerText().catch(()=>''))
    if (!txt.includes('双击输入文本')) continue
    await cards.nth(i).dblclick().catch(()=>{})
    await page.waitForTimeout(350)
    const editable = cards.nth(i).locator('[contenteditable="true"], textarea, [role="textbox"], [contenteditable]').first()
    const val = i === 0 ? '来源A：ALPHA-B2' : (i === 1 ? '来源B：BETA-B2' : '来源C：GAMMA-B2')
    if (await editable.count()) {
      await editable.fill(val).catch(async()=>{ await page.keyboard.type(val,{delay:5}) })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      edited++
    }
  }
  step('C04/N-text 编辑文本节点', edited >= 2, { edited })

  // screenshot evidence
  await page.screenshot({ path: 'results/2026-09-23/batch2/evidence/b2-edited-cards.png' }).catch(()=>{})

  console.log('RESULT>>>', JSON.stringify(res, null, 2))
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })