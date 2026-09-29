/* eslint-disable @typescript-eslint/no-require-imports */
// R-47 运行时验证（一次性脚本）：画布级 Delete/Backspace window 捕获对聚焦 button 的误删。
// 说明：浏览器演示 profile 隐藏了「数据处理」(processor) 节点，改用同样在卡片内
// 渲染 AppSelect 触发器（.gen-panel：选择供应商/生成图片数量）+ prompt 输入框 +
// 右上角运行按钮的「生图」节点，R-47 关注的控件类型（AppSelect 触发器=button、
// 卡片按钮、卡片内输入框）完全一致。
// 场景：
//   a  基线：节点选中+画布焦点，Delete → 节点应被删除（对照组）
//   b  焦点在卡片内输入框（gen-prompt textarea）+节点选中，Delete → 只删文字，节点保留
//   c1 焦点在卡片内 AppSelect 触发器（focus，弹层未开）+节点选中，Delete → 若删节点=BUG
//   c2 点击聚焦 AppSelect 触发器（弹层开启）+节点选中，Delete → 若删节点=BUG
//   d  焦点在卡片运行按钮（.node-run-btn）+节点选中，Delete → 若删节点=BUG
//   e  同 c1，但按 Backspace → 若删节点=BUG
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5288'
const OUT_DIR = __dirname
const results = []

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

  const renderedNodeIds = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.node-card-wrap'))
        .map((w) => ({
          id: w.getAttribute('data-node-id'),
          type: w.getAttribute('data-node-type'),
          h: w.getBoundingClientRect().height
        }))
        .filter((w) => w.h > 0)
    )
  const renderedCount = async () => (await renderedNodeIds()).length
  // 每个场景开始前画布已清空，新增的生图卡是唯一已渲染卡片；用 .gen-panel 兜底确认类型
  const genNodeIds = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.node-card-wrap'))
        .filter((w) => w.getBoundingClientRect().height > 0 && w.querySelector('.gen-panel'))
        .map((w) => w.getAttribute('data-node-id'))
    )
  const selectedIds = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.node-card-wrap.is-selected')).map((w) =>
        w.getAttribute('data-node-id')
      )
    )
  const activeInfo = () =>
    page.evaluate(() => {
      const a = document.activeElement
      if (!a) return { tag: 'null' }
      return {
        tag: a.tagName,
        cls: typeof a.className === 'string' ? a.className.slice(0, 70) : '',
        label: a.getAttribute ? a.getAttribute('aria-label') : null,
        contentEditable: a.isContentEditable || false
      }
    })
  const toastText = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast, [class*="toast" i]'))
        .map((t) => t.textContent.trim())
        .filter(Boolean)
        .join(' | ')
    )
  const renderedCountEval = (n) =>
    Array.from(document.querySelectorAll('.node-card-wrap')).filter(
      (w) => w.getBoundingClientRect().height > 0
    ).length === n
  const waitCount = (want, timeout = 3500) =>
    page
      .waitForFunction(renderedCountEval, want, { timeout })
      .then(
        () => true,
        () => false
      )

  // hover「图片创作」分类展开 flyout，点击「添加生图节点」
  const addImageGenNode = async () => {
    const before = await renderedCount()
    const cat = page.getByRole('button', { name: '展开图片创作节点', exact: true })
    await cat.hover()
    const item = page.getByRole('button', { name: '添加生图节点', exact: true })
    await item.waitFor({ state: 'visible', timeout: 4000 })
    await item.click()
    await page
      .waitForFunction(
        (n) =>
          Array.from(document.querySelectorAll('.node-card-wrap')).filter(
            (w) => w.getBoundingClientRect().height > 0
          ).length === n + 1,
        before,
        { timeout: 6000 }
      )
      .catch(async () => {
        await shot('r47-error-add-node.png')
        throw new Error('添加生图节点后节点数未 +1')
      })
    await page.waitForTimeout(400)
    const ids = await genNodeIds()
    if (ids.length !== 1) throw new Error(`期望 1 张生图节点卡，实际 ${ids.length}`)
    return ids[0]
  }

  // 点击卡片内的中性点选中节点（避开 button/input/select/textarea 等控件）
  const selectCard = async (nodeId) => {
    const point = await page.evaluate((id) => {
      const wrap = document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)
      if (!wrap) return null
      const card = wrap.querySelector('.node-card')
      if (!card) return null
      const rect = card.getBoundingClientRect()
      const isControl = (node) =>
        !!node.closest(
          'button, input, select, textarea, [contenteditable="true"], [class*="btn"], [class*="run"]'
        )
      for (const fy of [0.5, 0.65, 0.8, 0.35, 0.9, 0.25]) {
        for (const fx of [0.5, 0.6, 0.4, 0.7, 0.3, 0.8]) {
          const x = Math.round(rect.x + rect.width * fx)
          const y = Math.round(rect.y + rect.height * fy)
          const hit = document.elementFromPoint(x, y)
          if (hit && card.contains(hit) && !isControl(hit)) return { x, y }
        }
      }
      return null
    }, nodeId)
    if (!point) throw new Error(`节点 ${nodeId} 内找不到可点击的中性区域`)
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`.node-card-wrap[data-node-id="${id}"]`)
          ?.classList.contains('is-selected'),
      nodeId,
      { timeout: 3000 }
    )
  }

  // 清场：Esc 两次（关弹层/取消选中），再把遗留节点逐个选中删除
  const cleanupToEmpty = async (label) => {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    for (let i = 0; i < 10; i++) {
      if ((await renderedCount()) === 0) return
      const ids = await renderedNodeIds()
      await selectCard(ids[0].id)
      await page.keyboard.press('Delete')
      const gone = await waitCount(ids.length - 1)
      if (!gone) {
        await shot(`r47-cleanup-stuck-${label}.png`)
        throw new Error(`清场失败：Delete 后节点数未减少（${label}）`)
      }
      await page.waitForTimeout(120)
    }
    if ((await renderedCount()) !== 0) throw new Error(`清场后画布仍非空（${label}）`)
  }

  const record = (entry) => {
    results.push(entry)
    console.log(
      `[${entry.verdict}] ${entry.id}: before=${entry.before} after=${entry.after} active=${JSON.stringify(entry.activeBefore)}`
    )
  }

  // 按键并等待节点数稳定（要么 -1 要么不变）
  const pressAndObserve = async (key, before) => {
    await page.keyboard.press(key)
    await waitCount(before - 1, 3000)
    const after = await renderedCount()
    return { before, after, deleted: after === before - 1 }
  }

  const wrap = (id) => page.locator(`.node-card-wrap[data-node-id="${id}"]`)

  try {
    await page.goto(`${ORIGIN}/`, { timeout: 30_000 })
    await page.waitForSelector('.palette-category-item', { timeout: 20_000 })
    await page.waitForTimeout(800)

    // ---------------- 场景 a：基线 ----------------
    {
      const id = await addImageGenNode()
      await selectCard(id)
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      await page.waitForTimeout(120)
      const before = await renderedCount()
      const sel = await selectedIds()
      const activeB = await activeInfo()
      await shot('r47-a-baseline-before.png')
      const obs = await pressAndObserve('Delete', before)
      const activeA = await activeInfo()
      await shot('r47-a-baseline-after.png')
      const pass = obs.deleted && sel.length === 1
      record({
        id: 'a-baseline-canvas-focus-Delete',
        expect: '节点被删除（对照组）',
        selectedBefore: sel,
        activeBefore: activeB,
        activeAfter: activeA,
        toast: obs.deleted ? await toastText() : '',
        before: obs.before,
        after: obs.after,
        verdict: pass ? 'PASS' : 'FAIL'
      })
      await cleanupToEmpty('a')
    }

    // ---------------- 场景 b：卡片内输入框豁免回归 ----------------
    {
      const id = await addImageGenNode()
      await selectCard(id)
      const prompt = wrap(id).locator('textarea.gen-prompt')
      if ((await prompt.count()) === 0) throw new Error('生图卡片内没找到 gen-prompt 输入框')
      await prompt.click()
      await page.keyboard.type('ABC')
      const typed = await prompt.inputValue()
      await page.keyboard.press('Home') // 光标移到开头，Delete 才删得到字符
      const before = await renderedCount()
      const sel = await selectedIds()
      const activeB = await activeInfo()
      await shot('r47-b-input-before.png')
      await page.keyboard.press('Delete')
      await page.waitForTimeout(700)
      const valueAfter = await prompt.inputValue()
      const after = await renderedCount()
      const selAfter = await selectedIds()
      await shot('r47-b-input-after.png')
      const pass = after === before && valueAfter === 'BC'
      record({
        id: 'b-in-card-textarea-Delete',
        expect: '只删输入框文字（ABC→BC），节点保留',
        typed,
        inputValueAfter: valueAfter,
        selectedBefore: sel,
        selectedAfter: selAfter,
        activeBefore: activeB,
        before,
        after,
        verdict: pass ? 'PASS' : 'FAIL'
      })
      await cleanupToEmpty('b')
    }

    // ---------------- 场景 c1：AppSelect 触发器 focus + Delete（R-47 核心） ----------------
    {
      const id = await addImageGenNode()
      await selectCard(id)
      const trigger = wrap(id).locator('button[aria-label="选择供应商"]').first()
      if ((await trigger.count()) === 0) throw new Error('生图卡片内没找到「选择供应商」AppSelect 触发器')
      await trigger.focus()
      await page.waitForTimeout(150)
      const before = await renderedCount()
      const sel = await selectedIds()
      const activeB = await activeInfo()
      await shot('r47-c1-appselect-focus-before.png')
      const obs = await pressAndObserve('Delete', before)
      const activeA = await activeInfo()
      await shot('r47-c1-appselect-focus-after.png')
      const bug = obs.deleted && sel.length === 1
      record({
        id: 'c1-appselect-trigger-focus-Delete',
        expect: 'R-47 核心场景：焦点在下拉触发器上按 Delete，若删节点=BUG',
        selectedBefore: sel,
        activeBefore: activeB,
        activeAfter: activeA,
        toast: obs.deleted ? await toastText() : '',
        before: obs.before,
        after: obs.after,
        verdict: bug ? 'BUG' : 'PASS'
      })
      await cleanupToEmpty('c1')
    }

    // ---------------- 场景 c2：点击聚焦 AppSelect（弹层开启）+ Delete ----------------
    {
      const id = await addImageGenNode()
      await selectCard(id)
      const trigger = wrap(id).locator('button[aria-label="选择供应商"]').first()
      await trigger.click()
      await page.waitForTimeout(450)
      const popupOpen = await page.evaluate(() => document.querySelectorAll('[role="listbox"]').length)
      const before = await renderedCount()
      const sel = await selectedIds()
      const activeB = await activeInfo()
      await shot('r47-c2-appselect-click-before.png')
      const obs = await pressAndObserve('Delete', before)
      const activeA = await activeInfo()
      await shot('r47-c2-appselect-click-after.png')
      const bug = obs.deleted && sel.length === 1
      record({
        id: 'c2-appselect-trigger-click-Delete',
        expect: '点击聚焦（弹层开启）按 Delete，若删节点=BUG',
        popupListboxCount: popupOpen,
        selectedBefore: sel,
        activeBefore: activeB,
        activeAfter: activeA,
        toast: obs.deleted ? await toastText() : '',
        before: obs.before,
        after: obs.after,
        verdict: bug ? 'BUG' : 'PASS'
      })
      await cleanupToEmpty('c2')
    }

    // ---------------- 场景 d：运行按钮 focus + Delete ----------------
    {
      const id = await addImageGenNode()
      await selectCard(id)
      const runBtn = wrap(id).locator('.node-run-btn').first()
      if ((await runBtn.count()) === 0) throw new Error('没找到节点运行按钮 .node-run-btn')
      await runBtn.focus()
      await page.waitForTimeout(150)
      const before = await renderedCount()
      const sel = await selectedIds()
      const activeB = await activeInfo()
      await shot('r47-d-runbtn-before.png')
      const obs = await pressAndObserve('Delete', before)
      const activeA = await activeInfo()
      await shot('r47-d-runbtn-after.png')
      const bug = obs.deleted && sel.length === 1
      record({
        id: 'd-run-button-focus-Delete',
        expect: '焦点在卡片运行按钮按 Delete，若删节点=BUG',
        selectedBefore: sel,
        activeBefore: activeB,
        activeAfter: activeA,
        toast: obs.deleted ? await toastText() : '',
        before: obs.before,
        after: obs.after,
        verdict: bug ? 'BUG' : 'PASS'
      })
      await cleanupToEmpty('d')
    }

    // ---------------- 场景 e：AppSelect 触发器 focus + Backspace ----------------
    {
      const id = await addImageGenNode()
      await selectCard(id)
      const trigger = wrap(id).locator('button[aria-label="选择供应商"]').first()
      await trigger.focus()
      await page.waitForTimeout(150)
      const before = await renderedCount()
      const sel = await selectedIds()
      const activeB = await activeInfo()
      await shot('r47-e-appselect-backspace-before.png')
      const obs = await pressAndObserve('Backspace', before)
      const activeA = await activeInfo()
      await shot('r47-e-appselect-backspace-after.png')
      const bug = obs.deleted && sel.length === 1
      record({
        id: 'e-appselect-trigger-focus-Backspace',
        expect: 'Backspace 同 R-47 场景，若删节点=BUG',
        selectedBefore: sel,
        activeBefore: activeB,
        activeAfter: activeA,
        toast: obs.deleted ? await toastText() : '',
        before: obs.before,
        after: obs.after,
        verdict: bug ? 'BUG' : 'PASS'
      })
      await cleanupToEmpty('e')
    }

    fs.writeFileSync(
      path.join(OUT_DIR, 'r47-results.json'),
      JSON.stringify({ origin: ORIGIN, finishedAt: new Date().toISOString(), results }, null, 2)
    )
    console.log('ALL DONE')
  } catch (e) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'r47-results.json'),
      JSON.stringify({ origin: ORIGIN, error: String(e && e.stack ? e.stack : e), results }, null, 2)
    )
    await shot('r47-error-state.png').catch(() => {})
    throw e
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
