/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * P图（图片修改）节点专项审查（2026-09-12 全节点审查 · 第 5 个节点）。
 * 覆盖：空态几何与空跑、连接原图、全屏工作台（画笔标注/撤销重做/颜色/修改说明）、
 * 浏览器演示诚实失败、配置持久化、非法连线。
 * 真实 /images/edits 供应商调用留桌面阶段（浏览器 mock 明确拒绝，属如实边界）。
 * 用法：node scripts/audit-image-edit-node.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outputDir =
  process.argv[3] ?? join(process.cwd(), 'artifacts', 'edit-node-audit-2026-09-12')

async function launchBrowser() {
  let lastError
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ ...options, headless: true })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function shot(page, name) {
  await page.screenshot({ path: join(outputDir, `${name}.png`), fullPage: false })
}

async function cardState(page, card) {
  return card.evaluate((el) => {
    const cardEl = el.querySelector('.node-card')
    const header = el.querySelector('.node-header')
    const bar = el.querySelector('.node-color-bar')
    const body = el.querySelector('.node-body')
    const status = el.querySelector('.node-status')
    const cardRect = cardEl?.getBoundingClientRect()
    const headerRect = header?.getBoundingClientRect()
    const barRect = bar?.getBoundingClientRect()
    return {
      size: cardRect ? { w: Math.round(cardRect.width), h: Math.round(cardRect.height) } : null,
      headerHeight: headerRect ? Math.round(headerRect.height) : null,
      colorBar: barRect
        ? { h: Math.round(barRect.height), atBottom: Math.abs(cardRect.bottom - barRect.bottom) < 2 }
        : null,
      borderRadius: cardEl ? getComputedStyle(cardEl).borderRadius : null,
      ports: Array.from(el.querySelectorAll('.port-dot')).map((p) => ({
        dir: p.classList.contains('in') ? 'in' : 'out',
        id: (p.getAttribute('title') ?? '').split('（')[0],
        size: Math.round(p.getBoundingClientRect().width),
        hasOutput: p.classList.contains('has-output'),
        connected: (p.getAttribute('title') ?? '').includes('已连接')
      })),
      overflow: body
        ? {
            x: body.scrollWidth > body.clientWidth + 1,
            y: body.scrollHeight > body.clientHeight + 1
          }
        : null,
      status: status ? Array.from(status.classList).find((c) => c.startsWith('node-status-')) : null,
      bodyText: body ? body.textContent?.slice(0, 220) : null,
      hasOpenWorkbench: Boolean(el.querySelector('.image-edit-workbench-mask')),
      inlineText: el.querySelector('.image-edit-inline-text')?.textContent ?? ''
    }
  })
}

async function createNode(page, label) {
  const before = await page
    .locator('.node-card-wrap[data-node-id]')
    .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
  await page.getByRole('button', { name: `添加${label}节点`, exact: true }).click()
  const id = await page
    .waitForFunction((known) => {
      const cards = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
      return (
        cards
          .map((c) => c.getAttribute('data-node-id'))
          .find((nid) => nid && !known.includes(nid)) ?? null
      )
    }, before)
    .then((h) => h.jsonValue())
  return { id, card: page.locator(`.node-card-wrap[data-node-id="${id}"]`) }
}

async function pasteImage(page, filename) {
  await page.evaluate((name) => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
      ),
      (char) => char.charCodeAt(0)
    )
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type: 'image/png' }))
    const target = document.querySelector('.canvas-host')
    target?.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    )
  }, filename)
  await page.waitForTimeout(600)
}

async function dragConnect(page, fromCard, fromTitle, toCard, toTitle, inset = 40) {
  const from = await fromCard.locator(`.port-dot.out[title^="${fromTitle}"]`).boundingBox()
  const to = await toCard.locator(`.port-dot.in[title^="${toTitle}"]`).boundingBox()
  if (!from || !to) throw new Error(`端口定位失败 ${fromTitle} -> ${toTitle}`)
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(
      from.x + from.width / 2 + ((to.x + to.width / 2 - (from.x + from.width / 2)) * i) / 8,
      from.y + from.height / 2 + ((to.y + to.height / 2 - (from.y + from.height / 2)) * i) / 8
    )
  }
  await page.mouse.move(to.x + to.width / 2 + inset, to.y + to.height / 2)
  await page.mouse.up()
  const menuOpened = await page.locator('.node-create-menu').isVisible().catch(() => false)
  if (menuOpened) await page.keyboard.press('Escape')
  return menuOpened
}

async function markCount(page) {
  return page.evaluate(() => document.querySelectorAll('.image-edit-overlay .image-edit-mark').length)
}

async function openWorkbench(page, card) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await card.getByRole('button', { name: '打开工作台' }).click().catch(() => {})
    await page.waitForTimeout(400)
    if (await page.locator('.image-edit-workbench-mask').isVisible().catch(() => false)) return true
  }
  return false
}

async function closeWorkbench(page) {
  // 打开运行中心等侧栏会触发单例收口、自动关闭工作台——遮罩已不在时直接跳过
  if (!(await page.locator('.image-edit-workbench-mask').isVisible().catch(() => false))) return
  await page.locator('.image-edit-workbench-head button').last().click()
  await page
    .waitForFunction(() => !document.querySelector('.image-edit-workbench-mask'), { timeout: 4000 })
    .catch(() => {})
}

async function main() {
  mkdirSync(outputDir, { recursive: true })
  const browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1708, height: 879 } })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const report = { baseUrl, viewport: { width: 1708, height: 879 }, states: {}, assertions: [] }
  const assert = (name, pass, actual, expected) => {
    report.assertions.push({ name, pass, actual, expected })
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` actual=${JSON.stringify(actual)}`}`)
  }

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.evaluate(() => sessionStorage.clear())
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(500)

    // ── 1. 空态 ──────────────────────────────────────────────
    const edit = await createNode(page, '修改')
    let state = await cardState(page, edit.card)
    report.states.fresh = state
    await shot(page, '01-fresh-empty')
    assert('fresh-size-340x260', state.size?.w === 340 && state.size?.h === 260, state.size, { w: 340, h: 260 })
    assert('fresh-header-28-floating', state.headerHeight === 28, state.headerHeight, 28)
    assert('fresh-radius-12', state.borderRadius === '12px', state.borderRadius, '12px')
    assert(
      'fresh-colorbar-8-bottom',
      state.colorBar?.h === 8 && state.colorBar?.atBottom,
      state.colorBar,
      { h: 8, atBottom: true }
    )
    assert(
      'fresh-ports',
      JSON.stringify(state.ports) ===
        JSON.stringify([
          { dir: 'in', id: '原图', size: 18, hasOutput: false, connected: false },
          { dir: 'in', id: '修改说明', size: 18, hasOutput: false, connected: false },
          { dir: 'out', id: '修改图', size: 18, hasOutput: false, connected: false }
        ]),
      state.ports,
      'in-原图(req) + in-修改说明(many) + out-修改图，18px'
    )
    assert('fresh-no-overflow', state.overflow && !state.overflow.x && !state.overflow.y, state.overflow, { x: false, y: false })
    assert(
      'fresh-empty-hint-and-workbench-entry',
      (state.bodyText ?? '').includes('连接图片后') && (state.bodyText ?? '').includes('打开工作台'),
      state.bodyText,
      '空态提示 + 打开工作台入口'
    )

    // ── 2. 空跑：缺必填输入不得伪装成功 ───────────────────────
    await edit.card.locator('.asset-empty').click()
    await page.waitForTimeout(150)
    await edit.card.getByRole('button', { name: '运行此节点' }).click()
    await page
      .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').length > 0, { timeout: 4000 })
      .catch(() => {})
    const emptyToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    await page.waitForTimeout(400)
    state = await cardState(page, edit.card)
    report.states.emptyRun = { toast: emptyToast, status: state.status }
    await shot(page, '02-empty-run')
    assert(
      'empty-run-blocked-with-port-hint',
      state.status !== 'node-status-success' && (emptyToast.includes('原图') || emptyToast.includes('连接')),
      { toast: emptyToast, status: state.status },
      '非 success + toast 指明缺原图'
    )

    // ── 3. 连接原图 ──────────────────────────────────────────
    await pasteImage(page, 'edit-audit.png')
    const imported = page.locator('.node-card-wrap', { has: page.locator('.node-media img') }).last()
    const menu1 = await dragConnect(page, imported, '图片', edit.card, '原图')
    await edit.card
      .waitForFunction(() => (document.querySelector('.port-dot.in')?.getAttribute('title') ?? '').includes('已连接'), { timeout: 5000 })
      .catch(() => {})
    state = await cardState(page, edit.card)
    report.states.connected = { menu: menu1, inConnected: state.ports.find((p) => p.dir === 'in')?.connected }
    await shot(page, '03-source-connected')
    assert(
      'source-connected',
      !menu1 && state.ports.find((p) => p.dir === 'in')?.connected === true,
      state.ports,
      'in-原图 已连接'
    )

    // ── 4. 打开工作台 + 画笔标注/撤销重做/颜色 ────────────────
    await edit.card.getByRole('button', { name: '打开工作台' }).click()
    await page.waitForTimeout(500)
    const wbVisible = await page.locator('.image-edit-workbench-mask').isVisible().catch(() => false)
    await shot(page, '04a-workbench-open')
    assert('workbench-opens', wbVisible, wbVisible, true)
    const sourceImg = await page.locator('.image-edit-preview img[alt="待修改原图"]').isVisible().catch(() => false)
    assert('workbench-shows-source', sourceImg, sourceImg, true)

    await page.locator('.image-edit-tools button', { hasText: '画笔' }).click()
    await page.locator('.image-edit-colors button', { hasText: '蓝' }).first().click()
    const preview = page.locator('.image-edit-preview')
    const pv = await preview.boundingBox()
    if (!pv) throw new Error('工作台预览区未找到')
    await page.mouse.move(pv.x + pv.width * 0.3, pv.y + pv.height * 0.4)
    await page.mouse.down()
    for (let i = 1; i <= 6; i += 1) {
      await page.mouse.move(pv.x + pv.width * (0.3 + i * 0.06), pv.y + pv.height * (0.4 + i * 0.05))
    }
    await page.mouse.up()
    await page.waitForTimeout(300)
    const marks1 = await markCount(page)
    await shot(page, '04b-brush-stroke-drawn')
    assert('brush-annotation-added', marks1 === 1, marks1, 1)
    const strokeIsBlue = await page.evaluate(() =>
      Boolean(document.querySelector('.image-edit-overlay .image-edit-mark.blue'))
    )
    assert('annotation-color-blue-applied', strokeIsBlue, strokeIsBlue, true)

    await page.getByRole('button', { name: '撤销上一步标注' }).click()
    await page.waitForTimeout(200)
    const marksUndo = await markCount(page)
    await page.getByRole('button', { name: '重做上一步标注' }).click()
    await page.waitForTimeout(200)
    const marksRedo = await markCount(page)
    assert('undo-redo-annotation', marksUndo === 0 && marksRedo === 1, { marksUndo, marksRedo }, '撤销到 0 再重做到 1')

    // 修改说明（工作台提示词区）
    await page.locator('.image-edit-workbench .gen-prompt').fill('把天空替换成黄昏色调')
    await page.waitForTimeout(300)

    // ── 5. 浏览器演示运行：诚实失败 + 运行中心原因 ────────────
    // 先选择演示图片模型（默认未选择时执行器会 skip 回 idle）
    await page
      .locator('.image-edit-workbench select.gen-select')
      .first()
      .selectOption({ label: '演示中转站 · gpt-image-2' })
    await page.waitForTimeout(300)
    await page.locator('.image-edit-workbench .gen-go').click()
    await page
      .waitForFunction(() => document.querySelector('.node-status')?.classList.contains('node-status-failed'), { timeout: 6000 })
      .catch(() => {})
    state = await cardState(page, edit.card)
    await shot(page, '05-run-honest-failure')
    assert(
      'browser-mock-edit-honest-failure',
      state.status === 'node-status-failed',
      state.status,
      '浏览器演示不支持图片修改 → failed'
    )
    // 工作台是模态遮罩，先关闭再打开运行中心
    await closeWorkbench(page)
    await page.getByRole('button', { name: '打开运行中心' }).click()
    await page.waitForTimeout(600)
    const centerText = await page.evaluate(() => document.body.textContent ?? '')
    const reasonVisible = centerText.includes('演示') || centerText.includes('图片修改')
    await shot(page, '05b-run-center-reason')
    await page.getByRole('button', { name: '打开运行中心' }).click().catch(() => {})
    await page.waitForTimeout(300)
    assert('failure-reason-in-run-center', reasonVisible, reasonVisible, '运行中心记录失败原因')

    // ── 6. 关闭并重开工作台：标注与说明持久化 ─────────────────
    await closeWorkbench(page)
    const wbClosed = !(await page.locator('.image-edit-workbench-mask').isVisible().catch(() => false))
    assert('workbench-closes', wbClosed, wbClosed, true)
    const reopened = await openWorkbench(page, edit.card)
    const marksAfterReopen = await markCount(page)
    const instructionValue = await page.locator('.image-edit-workbench .gen-prompt').inputValue().catch(() => '')
    report.states.reopen = { reopened, marks: marksAfterReopen, instruction: instructionValue.slice(0, 30) }
    await shot(page, '06-reopen-persisted')
    assert(
      'workbench-config-persists-after-reopen',
      reopened && marksAfterReopen === 1 && instructionValue.includes('黄昏'),
      { reopened, marks: marksAfterReopen, instruction: instructionValue.slice(0, 30) },
      '标注与修改说明均从 config 恢复'
    )
    await closeWorkbench(page)

    // ── 7. 非法连线：audio → P图 必须被拒 ────────────────────
    // 注意：text → P图 是合法连线（接入 in-修改说明 many 文本口），
    // 真正的非法用例是与 image/text 两类输入都不兼容的音频输出。
    const audioNode = await createNode(page, '音频')
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await page.waitForTimeout(300)
    await audioNode.card.locator('.port-dot.out').first().waitFor({ state: 'visible' })
    let rejectToast = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await dragConnect(page, audioNode.card, '音频', edit.card, '原图')
      await page
        .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').includes('不兼容'), { timeout: 4000 })
        .catch(() => {})
      rejectToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
      if (rejectToast.includes('不兼容')) break
      await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
      await page.waitForTimeout(300)
    }
    await shot(page, '07-illegal-audio-to-edit')
    report.states.illegal = { toast: rejectToast }
    assert('illegal-audio-to-edit-rejected', rejectToast.includes('不兼容'), rejectToast, 'toast 含不兼容')

    // ── 8. 重载持久性（连线 + 配置） ──────────────────────────
    const idsBefore = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)
    const idsAfter = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const survived = idsBefore.filter((nid) => idsAfter.includes(nid))
    const editAfter = page
      .locator('.node-card-wrap')
      .filter({ has: page.locator('.type-image-edit') })
      .first()
    const reloaded = await cardState(page, editAfter)
    await openWorkbench(page, editAfter)
    const marksAfterReload = await markCount(page)
    const instructionAfterReload = await page
      .locator('.image-edit-workbench .gen-prompt')
      .inputValue()
      .catch(() => '')
    await shot(page, '08-reload')
    await closeWorkbench(page)
    report.states.reload = {
      survived: survived.length,
      before: idsBefore.length,
      inConnected: reloaded.ports.find((p) => p.dir === 'in')?.connected,
      marks: marksAfterReload,
      instruction: instructionAfterReload.slice(0, 20)
    }
    console.log(`RELOAD ${JSON.stringify(report.states.reload)}`)
    assert(
      'reload-keeps-connection-and-config',
      reloaded.ports.find((p) => p.dir === 'in')?.connected === true &&
        marksAfterReload === 1 &&
        instructionAfterReload.includes('黄昏'),
      report.states.reload,
      '连线与标注配置全部保留'
    )
  } finally {
    writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
    await context.close()
    await browser.close()
  }
  const failed = report.assertions.filter((a) => !a.pass)
  console.log(`\nDONE assertions=${report.assertions.length} failed=${failed.length}`)
  process.exit(failed.length ? 2 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
