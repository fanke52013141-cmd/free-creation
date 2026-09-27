const { chromium } = require('playwright')

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const contexts = browser.contexts()
  let page = null
  for (const c of contexts) {
    for (const p of c.pages()) {
      const url = p.url()
      if (url && /index\.html|localhost|127\.0\.0\.1/.test(url)) page = p
      console.log('PAGE', url || '(devtools?)', 'title=', p.title())
    }
  }
  if (!page) {
    // pick the last page (the app window)
    const all = contexts.flatMap((c) => c.pages())
    page = all[all.length - 1]
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1500)
  console.log('FINAL TARGET', page && page.url(), 'title=', page && page.title())

  const res = { steps: [] }
  const step = (name, ok, extra) => res.steps.push({ name, ok: !!ok, extra })

  // ensure a project exists / navigate to canvas
  const body = await page.locator('body').innerText().catch(() => '')
  res.bodyHead = body.slice(0, 120)
  console.log('BODY>>>', JSON.stringify(body.slice(0, 150)))

  // try to create a new project if we're on home
  const homeProject = page.getByRole('button', { name: '新建项目' })
  if (await homeProject.count()) {
    await homeProject.click(); await page.waitForTimeout(300)
    const submit = page.getByRole('button', { name: '创建', exact: true })
    if (await submit.count()) { await submit.click() }
    await page.waitForTimeout(1200)
    step('新建项目进入画布', await page.locator('.node-palette').count() > 0, bodyBal='')
  }

  // expand category
  const cat = page.getByRole('button', { name: '展开文本与AI节点' })
  const favCat = page.getByRole('button', { name: '展开常用节点' })
  let expanded = false
  if (await cat.count()) { await cat.hover(); await cat.click(); await page.waitForTimeout(400); expanded = await page.locator('.palette-node-flyout').count() > 0 }
  else if (await favCat.count()) { await favCat.hover().catch(()=>{}); await favCat.click(); await page.waitForTimeout(400); expanded = await page.locator('.palette-node-flyout').count() > 0 }
  step('展开分类出现二级抽屉', expanded, 'cat')
  if (expanded) {
    await page.screenshot({ path: 'results/2026-09-23/batch1/evidence/flyout-open.png' }).catch(()=>{})
  }

  // add text node
  const addText = page.getByRole('button', { name: '添加文本节点', exact: true })
  const textCountBefore = await page.locator('.type-text').count()
  if (expanded && (await addText.count())) {
    await addText.hover(); await addText.click(); await page.waitForTimeout(600)
    const textCountAfter = await page.locator('.type-text').count()
    step('创建文本节点(多级入口)', textCountAfter > textCountBefore, { before: textCountBefore, after: textCountAfter })
    await page.screenshot({ path: 'results/2026-09-23/batch1/evidence/node-added.png' }).catch(()=>{})
  } else {
    step('创建文本节点(多级入口)', false, 'buttonNotFound or flyout closed')
  }

  console.log('RESULT>>>', JSON.stringify(res, null, 2))
  await browser.close()
}

main().catch((e) => { console.error('DRIVE_ERR', e.message); process.exit(1) })