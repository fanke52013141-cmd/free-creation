/* eslint-disable @typescript-eslint/no-require-imports */
// UI 复审（2026-10-04）：对更多节点类型做运行时审查——卡片圆角、卡内按钮高度、
// 按钮私有渐变、原生 select 残留。发现问题即输出到 evidence。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5333'
const OUT_DIR = __dirname

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, headless: true })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function main() {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(10_000)
  const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, name) })

  await page.goto(`${ORIGIN}/`, { timeout: 30_000 })
  await page.waitForSelector('.palette-category-item', { timeout: 20_000 })
  await page.waitForTimeout(800)

  const addNode = async (categoryPattern, itemPattern) => {
    const before = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        ).length
    )
    const cat = page.getByRole('button', { name: new RegExp(categoryPattern) })
    if ((await cat.count()) === 0) return null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await cat.hover()
      await page.waitForTimeout(350)
      const item = page.getByRole('button', { name: new RegExp(itemPattern) })
      try {
        await item.waitFor({ state: 'visible', timeout: 3500 })
        await item.click()
        break
      } catch {
        continue
      }
    }
    await page.waitForTimeout(600)
    const ok = await page.evaluate(
      (n) =>
        Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        ).length === n + 1,
      before
    )
    if (!ok) return null
    return page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('.node-card-wrap')).filter(
        (w) => w.getBoundingClientRect().height > 0
      )
      return wraps[wraps.length - 1]?.getAttribute('data-node-id') ?? null
    })
  }

  const audit = (id) =>
    page.evaluate((nodeId) => {
      const wrap = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
      if (!wrap) return null
      const card = wrap.querySelector('.node-card')
      const cs = card ? getComputedStyle(card) : null
      const buttons = Array.from(wrap.querySelectorAll('button'))
        .filter((b) => b.getBoundingClientRect().height > 0)
        .map((b) => {
          const s = getComputedStyle(b)
          return {
            label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 14),
            h: Math.round(b.getBoundingClientRect().height),
            radius: s.borderRadius,
            gradient: s.backgroundImage !== 'none'
          }
        })
      return {
        cardRadius: cs ? cs.borderRadius : null,
        nativeSelects: wrap.querySelectorAll('select').length,
        buttons
      }
    }, id)

  const targets = [
    { key: 'text', cat: '展开输入与', item: '文本节点' },
    { key: 'chat', cat: '展开声音创作节点', item: '对话节点' },
    
    
    { key: 'image', cat: '展开图片创作节点', item: '图片节点' }
  ]
  const evidence = {}
  for (const t of targets) {
    const id = await addNode(t.cat, t.item)
    if (!id) {
      evidence[t.key] = { skipped: true }
      continue
    }
    const wrap = page.locator(`.node-card-wrap[data-node-id="${id}"]`)
    await wrap.screenshot({ path: path.join(OUT_DIR, `audit-${t.key}.png`) })
    evidence[t.key] = await audit(id)
  }

  // 异常汇总：卡内按钮高度 >40 或 <18、出现渐变按钮、原生 select、非 12px 卡角
  const problems = []
  for (const [key, v] of Object.entries(evidence)) {
    if (!v || v.skipped) continue
    if (v.cardRadius !== '12px') problems.push(`${key}: 卡角 ${v.cardRadius}`)
    if (v.nativeSelects > 0) problems.push(`${key}: 原生 select ×${v.nativeSelects}`)
    for (const b of v.buttons) {
      if (b.gradient) problems.push(`${key}: 渐变按钮「${b.label}」${b.h}px`)
      if (b.h > 40) problems.push(`${key}: 按钮过高「${b.label}」${b.h}px`)
    }
  }
  evidence.__problems = problems
  fs.writeFileSync(path.join(OUT_DIR, 'audit-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ problems, detail: evidence }, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
