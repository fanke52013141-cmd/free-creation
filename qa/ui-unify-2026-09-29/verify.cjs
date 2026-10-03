/* eslint-disable @typescript-eslint/no-require-imports */
// UI 统一目检（一次性脚本）：对统一后的节点采集截图与计算样式证据。
// 覆盖：speech/tts/voice-design 的 .btn-generate（应 28px/r7）、tts 卡圆角（应 12px）、
// video-ai 设置面板下拉（应为 .app-select-trigger，无原生 select）。节点不可建时优雅跳过。
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
  const evidence = { origin: ORIGIN, nodes: {}, videoAiSettings: null }

  const renderedCount = async () =>
    page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        ).length
    )

  const addNode = async (categoryButton, itemPattern, marker) => {
    const before = await renderedCount()
    const cat = page.getByRole('button', { name: new RegExp(categoryButton) })
    if ((await cat.count()) === 0) return null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await cat.hover()
      await page.waitForTimeout(350)
      const item = page.getByRole('button', { name: new RegExp(itemPattern) })
      try {
        await item.waitFor({ state: 'visible', timeout: 3500 })
      } catch {
        continue
      }
      await item.click()
      const ok = await page
        .waitForFunction(
          (n) =>
            Array.from(document.querySelectorAll('.node-card-wrap')).filter(
              (w) => w.getBoundingClientRect().height > 0
            ).length === n + 1,
          before,
          { timeout: 6000 }
        )
        .then(
          () => true,
          () => false
        )
      if (ok) break
    }
    await page.waitForTimeout(500)
    if ((await renderedCount()) !== before + 1) return null
    return page.evaluate(
      (sel) => {
        const wraps = Array.from(document.querySelectorAll('.node-card-wrap')).filter(
          (w) => w.getBoundingClientRect().height > 0
        )
        const hit = wraps.find((w) => (sel ? w.querySelector(sel) : true))
        return hit ? hit.getAttribute('data-node-id') : null
      },
      marker || null
    )
  }

  const cardStyles = (id) =>
    page.evaluate((nodeId) => {
      const wrap = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
      if (!wrap) return null
      const card = wrap.querySelector('.node-card')
      const cs = card ? getComputedStyle(card) : null
      const btn = wrap.querySelector('.btn-generate')
      const bcs = btn ? getComputedStyle(btn) : null
      return {
        nodeType: wrap.getAttribute('data-node-type'),
        cardRadius: cs ? cs.borderRadius : null,
        generateButton: bcs
          ? {
              height: btn.getBoundingClientRect().height,
              borderRadius: bcs.borderRadius,
              fontSize: bcs.fontSize,
              fontWeight: bcs.fontWeight,
              background: bcs.backgroundColor
            }
          : null
      }
    }, id)

  await page.goto(`${ORIGIN}/`, { timeout: 30_000 })
  await page.waitForSelector('.palette-category-item', { timeout: 20_000 })
  await page.waitForTimeout(800)

  const targets = [
    { key: 'speech', cat: '展开声音创作节点', item: '添加语音合成节点' },
    { key: 'tts', cat: '展开声音创作节点', item: '添加语音克隆节点' },
    { key: 'voice-design', cat: '展开声音创作节点', item: '添加音色设计节点' },
    { key: 'video-depth', cat: '展开视频创作节点', item: '添加深度视频节点' }
  ]

  // 默认工作区预设会隐藏部分节点：经真实用户路径（项目菜单 → 工作台节点设置）启用。
  // 菜单浮层在 tldraw 画布之下时常规点击会被背景拦截，改用 DOM 层派发点击。
  const dispatchClick = (locator) =>
    locator.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  const enableNodes = async (names) => {
    await page.getByRole('button', { name: '项目菜单', exact: true }).click()
    await page.waitForSelector('.node-menu-item', { timeout: 5000 })
    await dispatchClick(page.getByRole('button', { name: '工作台节点设置', exact: true }))
    await page.waitForSelector('.project-create-dialog', { timeout: 5000 })
    await page.waitForTimeout(400)
    for (const name of names) {
      const box = page.getByRole('checkbox', { name, exact: true })
      if ((await box.count()) > 0 && !(await box.isChecked())) {
        await box.click()
        await page.waitForTimeout(250)
      }
    }
    await page.locator('.project-create-submit').click()
    await page.waitForTimeout(1200)
  }
  await enableNodes(['音色设计', '深度视频'])
  const addedIds = {}
  for (const t of targets) {
    const id = await addNode(t.cat, t.item)
    if (!id) {
      evidence.nodes[t.key] = { skipped: true }
      continue
    }
    addedIds[t.key] = id
    const wrap = page.locator(`.node-card-wrap[data-node-id="${id}"]`)
    await wrap.screenshot({ path: path.join(OUT_DIR, `ui-${t.key}-card.png`) })
    evidence.nodes[t.key] = await cardStyles(id)
  }

  // video-ai 设置面板：选中本会话创建的深度视频卡 → 详情「设置」页
  if (addedIds['video-depth']) {
    const depthId = addedIds['video-depth']
    await page.evaluate((id) => {
      const wrap = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
      const card = wrap.querySelector('.node-card')
      const r = card.getBoundingClientRect()
      const ev = (type) =>
        card.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            clientX: r.x + r.width / 2,
            clientY: r.y + r.height / 2
          })
        )
      ev('pointerdown')
      ev('pointerup')
      ev('click')
    }, depthId)
    await page.waitForTimeout(900)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === '设置'
      )
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForTimeout(900)
    await shot('ui-video-ai-settings.png')
    evidence.videoAiSettings = await page.evaluate(() => {
      const panel = document.querySelector('.video-ai-settings')
      if (!panel) return { present: false }
      const trigger = panel.querySelector('.app-select-trigger')
      const install = panel.querySelector('.video-ai-install-button')
      const ics = install ? getComputedStyle(install) : null
      return {
        present: true,
        nativeSelects: panel.querySelectorAll('select').length,
        appSelects: panel.querySelectorAll('.app-select-trigger').length,
        triggerHeight: trigger ? trigger.getBoundingClientRect().height : null,
        installButton:
          install !== null
            ? {
                height: install.getBoundingClientRect().height,
                radius: ics.borderRadius,
                background: ics.backgroundColor,
                border: `${ics.borderWidth} ${ics.borderColor}`
              }
            : null
      }
    })
  }

  fs.writeFileSync(path.join(OUT_DIR, 'ui-unify-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
