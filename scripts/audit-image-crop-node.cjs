/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 裁剪节点专项审查（2026-09-12 全节点审查 · 第 3 个节点）。
 * 覆盖：空态几何与空跑、连接原图、比例切换、角点拖拽、矩形运行、产物下游消费、
 * 非法连线、四角透视（设置面板）、重载持久性。
 * 用法：node scripts/audit-image-crop-node.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outputDir =
  process.argv[3] ?? join(process.cwd(), 'artifacts', 'crop-node-audit-2026-09-12')

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
      bodyText: body ? body.textContent?.slice(0, 300) : null,
      workbenchImg: Boolean(el.querySelector('.crop-inline-canvas img')),
      selectionStyle: el.querySelector('.crop-inline-selection')?.getAttribute('style') ?? '',
      activeAspect: el.querySelector('.crop-inline-toolbar button.active')?.textContent ?? ''
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

/** 拖拽连线：默认落点从端口圆心向卡片内移 40px，保证命中目标节点。 */
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

async function runNode(page, card, clickTarget) {
  await card.locator(clickTarget).click()
  await page.waitForTimeout(150)
  await card.getByRole('button', { name: '运行此节点' }).waitFor({ state: 'visible' })
  await card.getByRole('button', { name: '运行此节点' }).click()
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
    const crop = await createNode(page, '裁剪')
    let state = await cardState(page, crop.card)
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
          { dir: 'out', id: '裁剪图', size: 18, hasOutput: false, connected: false }
        ]),
      state.ports,
      'in-原图(req) + out-裁剪图，18px'
    )
    assert('fresh-no-overflow', state.overflow && !state.overflow.x && !state.overflow.y, state.overflow, { x: false, y: false })
    assert(
      'fresh-empty-hint',
      (state.bodyText ?? '').includes('连接一张图片') && (state.bodyText ?? '').includes('配置裁剪'),
      state.bodyText,
      '空态提示 + 配置裁剪入口'
    )

    // ── 2. 空跑：缺必填输入不得伪装成功 ───────────────────────
    await runNode(page, crop.card, '.asset-empty')
    await page
      .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').length > 0, { timeout: 4000 })
      .catch(() => {})
    const emptyToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    await page.waitForTimeout(400)
    state = await cardState(page, crop.card)
    report.states.emptyRun = { toast: emptyToast, status: state.status }
    await shot(page, '02-empty-run')
    assert(
      'empty-run-blocked-with-port-hint',
      state.status !== 'node-status-success' && (emptyToast.includes('原图') || emptyToast.includes('连接')),
      { toast: emptyToast, status: state.status },
      '非 success + toast 提示缺原图输入'
    )

    // ── 3. 连接原图 → 内联工作台 ─────────────────────────────
    await pasteImage(page, 'crop-audit.png')
    const imported = page.locator('.node-card-wrap', { has: page.locator('.node-media img') }).last()
    const menu1 = await dragConnect(page, imported, '图片', crop.card, '原图')
    await crop.card
      .waitForFunction(() => Boolean(document.querySelector('.crop-inline-canvas img')), { timeout: 5000 })
      .catch(() => {})
    state = await cardState(page, crop.card)
    report.states.withSource = state
    await shot(page, '03-workbench-with-source')
    assert(
      'workbench-shows-source-image',
      !menu1 && state.workbenchImg && state.ports.some((p) => p.dir === 'in' && p.connected),
      { menu: menu1, workbenchImg: state.workbenchImg, ports: state.ports },
      '工作台显示待裁剪图片 + in-端口已连接'
    )

    // ── 4. 比例切换 + 角点拖拽 ───────────────────────────────
    await crop.card.locator('.crop-inline-toolbar button', { hasText: '16:9' }).click()
    await page.waitForTimeout(300)
    const beforeDrag = await cardState(page, crop.card)
    const handle = await crop.card.locator('.crop-inline-handle.corner-3').boundingBox()
    if (handle) {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + 30, handle.y + 24, { steps: 4 })
      await page.mouse.up()
    }
    await page.waitForTimeout(400)
    const afterDrag = await cardState(page, crop.card)
    report.states.aspectDrag = {
      activeAspect: afterDrag.activeAspect,
      selectionBefore: beforeDrag.selectionStyle,
      selectionAfter: afterDrag.selectionStyle
    }
    await shot(page, '04-aspect-and-drag')
    assert('aspect-16-9-active', afterDrag.activeAspect === '16:9', afterDrag.activeAspect, '16:9')
    assert(
      'corner-drag-changes-selection',
      afterDrag.selectionStyle !== beforeDrag.selectionStyle && afterDrag.selectionStyle.length > 0,
      { before: beforeDrag.selectionStyle, after: afterDrag.selectionStyle },
      '角点拖拽改写选区'
    )

    // ── 5. 运行裁剪 → 产物资产 + out 可消费 ──────────────────
    const beforeRun = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await crop.card.getByRole('button', { name: '裁剪图片', exact: true }).click()
    await crop.card
      .waitForFunction(
        () => document.querySelector('.node-status')?.classList.contains('node-status-success'),
        { timeout: 6000 }
      )
      .catch(() => {})
    await page.waitForTimeout(500)
    state = await cardState(page, crop.card)
    const afterRun = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const artifacts = afterRun.filter((nid) => !beforeRun.includes(nid))
    report.states.runSuccess = { status: state.status, artifacts: artifacts.length, outHasOutput: state.ports.find((p) => p.dir === 'out')?.hasOutput }
    await shot(page, '05-run-success')
    assert('run-status-success', state.status === 'node-status-success', state.status, 'node-status-success')
    assert('run-produces-artifact-asset', artifacts.length === 1, artifacts.length, 1)
    assert('run-out-port-has-output', state.ports.find((p) => p.dir === 'out')?.hasOutput === true, state.ports, 'out-裁剪图 has-output')

    // ── 6. 裁剪产物可继续下游消费（链式） ─────────────────────
    const crop2 = await createNode(page, '裁剪')
    const menu2 = await dragConnect(page, crop.card, '裁剪图', crop2.card, '原图')
    await crop2.card
      .waitForFunction(() => Boolean(document.querySelector('.crop-inline-canvas img')), { timeout: 5000 })
      .catch(() => {})
    const chainState = await cardState(page, crop2.card)
    report.states.chain = { menu: menu2, workbenchImg: chainState.workbenchImg }
    await shot(page, '06-chain-consumes-crop-output')
    assert(
      'crop-output-consumable-downstream',
      !menu2 && chainState.workbenchImg,
      { menu: menu2, workbenchImg: chainState.workbenchImg },
      '下游裁剪节点工作台显示裁剪产物'
    )

    // ── 7. 非法连线：text → in-原图 必须被拒 ─────────────────
    const textNode = await createNode(page, '文本')
    await dragConnect(page, textNode.card, '文本', crop.card, '原图')
    await page
      .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').includes('不兼容'), { timeout: 4000 })
      .catch(() => {})
    const rejectToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    await shot(page, '07-illegal-text-to-crop')
    const portStillSingle = await crop.card.evaluate((el) => {
      const inPort = el.querySelector('.port-dot.in')
      return (inPort?.getAttribute('title') ?? '').split('·').filter((s) => s.includes('已连接')).length
    })
    report.states.illegal = { toast: rejectToast, portStillSingle }
    assert(
      'illegal-text-to-crop-rejected',
      rejectToast.includes('不兼容') && portStillSingle === 1,
      { toast: rejectToast, portStillSingle },
      'toast 不兼容 + 原连接未被破坏'
    )

    // ── 8. 四角透视（设置面板切 quad + 运行） ────────────────
    // 浏览器演示的媒体引擎明确不支持透视裁剪（browserMedia 抛"桌面端支持透视裁剪"）；
    // 这里验收：①模式切换写入配置并持久化；②演示环境诚实地失败且错误可操作。
    // 真实透视（napi-rs 单应变换）留桌面阶段验收。
    await crop.card.locator('.crop-inline-actions').getByRole('button', { name: '精细框选' }).click()
    await page.waitForTimeout(500)
    const quadButton = page.getByRole('button', { name: '四角透视', exact: true })
    const quadVisible = await quadButton.isVisible().catch(() => false)
    if (quadVisible) {
      await quadButton.click()
      await page.waitForTimeout(300)
      const quadActive = await quadButton.evaluate((el) => el.classList.contains('active'))
      await shot(page, '08a-quad-mode-settings')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      await runNode(page, crop.card, '.crop-inline-workbench')
      await crop.card
        .waitForFunction(
          () => document.querySelector('.node-status')?.classList.contains('node-status-failed'),
          { timeout: 6000 }
        )
        .catch(() => {})
      state = await cardState(page, crop.card)
      report.states.quadRun = { status: state.status, quadActive }
      await shot(page, '08-quad-run-honest-failure')
      assert('quad-mode-switch-persists', quadActive, quadActive, '四角透视按钮激活')
      assert(
        'quad-in-browser-honest-failure',
        state.status === 'node-status-failed',
        { status: state.status },
        '演示环境明确拒绝透视（failed，不伪装成功）'
      )
      // 失败原因记录在运行中心（engine store errors），必须可操作可见
      await page.getByRole('button', { name: '打开运行中心' }).click()
      await page.waitForTimeout(600)
      const centerText = await page.evaluate(() => document.body.textContent ?? '')
      const reasonVisible = centerText.includes('透视') || centerText.includes('桌面端')
      await shot(page, '08b-run-center-reason')
      await page.getByRole('button', { name: '打开运行中心' }).click().catch(() => {})
      await page.waitForTimeout(300)
      report.states.quadRun.reasonVisible = reasonVisible
      assert('quad-failure-reason-in-run-center', reasonVisible, reasonVisible, '运行中心含透视失败原因')
    } else {
      assert('quad-mode-switch-persists', false, 'settings panel not opened', '四角透视按钮可见')
      assert('quad-in-browser-honest-failure', false, 'settings panel not opened', '')
    }

    // ── 9. 重载持久性（配置 + 连线 + 结果） ───────────────────
    const idsBefore = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)
    const idsAfter = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const survived = idsBefore.filter((nid) => idsAfter.includes(nid))
    // 重载后定位"主裁剪节点"（带内联工作台的那个；链式 crop2 可能仍是空态）
    const cropAfter = page
      .locator('.node-card-wrap')
      .filter({ has: page.locator('.type-image-crop') })
      .filter({ has: page.locator('.crop-inline-toolbar') })
      .first()
    const reloaded = await cardState(page, cropAfter)
    report.states.reload = {
      before: idsBefore.length,
      after: idsAfter.length,
      survived: survived.length,
      activeAspect: reloaded.activeAspect,
      inConnected: reloaded.ports.find((p) => p.dir === 'in')?.connected,
      outHasOutput: reloaded.ports.find((p) => p.dir === 'out')?.hasOutput
    }
    await shot(page, '09-reload')
    console.log(`RELOAD ${JSON.stringify(report.states.reload)}`)
    assert(
      'reload-keeps-config-connection-result',
      reloaded.activeAspect === '16:9' && reloaded.ports.find((p) => p.dir === 'in')?.connected && reloaded.ports.find((p) => p.dir === 'out')?.hasOutput,
      report.states.reload,
      '比例/连线/产物输出全部保留'
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
