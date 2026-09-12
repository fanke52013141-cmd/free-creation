/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 拆图节点专项审查（2026-09-12 全节点审查 · 第 4 个节点）。
 * 覆盖：空态几何与空跑、连接原图、行列/面积配置、运行产物、out-images→循环 与
 * out-image→下游消费、非法连线、重载持久性。
 * 用法：node scripts/audit-image-split-node.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outputDir =
  process.argv[3] ?? join(process.cwd(), 'artifacts', 'split-node-audit-2026-09-12')

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
      bodyText: body ? body.textContent?.slice(0, 260) : null,
      previewTiles: el.querySelectorAll('.image-split-preview-tile').length,
      hasSourceImg: Boolean(el.querySelector('.image-split-quick-grid img')),
      workbenchImg: Boolean(el.querySelector('.crop-inline-canvas img')),
      rows: el.querySelector('label:nth-of-type(1) input')?.value ?? '',
      cols: el.querySelectorAll('label input')[1]?.value ?? '',
      scale: el.querySelectorAll('label input')[2]?.value ?? '',
      connectedInputs: Array.from(el.querySelectorAll('.connected-input-item')).map((item) => ({
        target: item.querySelector('.connected-input-target')?.textContent ?? '',
        source: item.querySelector('.connected-input-source')?.textContent ?? ''
      }))
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
    const split = await createNode(page, '拆分')
    let state = await cardState(page, split.card)
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
      'fresh-ports-one-in-two-out',
      JSON.stringify(state.ports) ===
        JSON.stringify([
          { dir: 'in', id: '原图', size: 18, hasOutput: false, connected: false },
          { dir: 'out', id: '当前图片', size: 18, hasOutput: false, connected: false },
          { dir: 'out', id: '图片集合', size: 18, hasOutput: false, connected: false }
        ]),
      state.ports,
      'in-原图 + out-当前图片 + out-图片集合，18px'
    )
    assert('fresh-no-overflow', state.overflow && !state.overflow.x && !state.overflow.y, state.overflow, { x: false, y: false })
    assert('fresh-default-3x3', state.rows === '3' && state.cols === '3', { rows: state.rows, cols: state.cols }, '默认 3×3')
    assert('fresh-hint-connect', (state.bodyText ?? '').includes('连接原图'), state.bodyText, '空态提示连接原图')

    // ── 2. 空跑：缺必填输入不得伪装成功 ───────────────────────
    await runNode(page, split.card, '.image-split-quick')
    await page
      .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').length > 0, { timeout: 4000 })
      .catch(() => {})
    const emptyToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    await page.waitForTimeout(400)
    state = await cardState(page, split.card)
    report.states.emptyRun = { toast: emptyToast, status: state.status }
    await shot(page, '02-empty-run')
    assert(
      'empty-run-blocked-with-port-hint',
      state.status !== 'node-status-success' && (emptyToast.includes('原图') || emptyToast.includes('连接')),
      { toast: emptyToast, status: state.status },
      '非 success + toast 指明缺原图'
    )

    // ── 3. 连接原图 + 配置 2×2 ───────────────────────────────
    await pasteImage(page, 'split-audit.png')
    const imported = page.locator('.node-card-wrap', { has: page.locator('.node-media img') }).last()
    const menu1 = await dragConnect(page, imported, '图片', split.card, '原图')
    await split.card
      .waitForFunction(() => Boolean(document.querySelector('.image-split-quick-grid img')), { timeout: 5000 })
      .catch(() => {})
    await split.card.locator('label', { hasText: '行数' }).locator('input').fill('2')
    await page.waitForTimeout(250)
    await split.card.locator('label', { hasText: '列数' }).locator('input').fill('2')
    await page.waitForTimeout(400)
    state = await cardState(page, split.card)
    report.states.configured = state
    await shot(page, '03-configured-2x2')
    assert(
      'source-connected-and-tiles-preview',
      !menu1 && state.hasSourceImg && state.previewTiles === 4,
      { menu: menu1, img: state.hasSourceImg, tiles: state.previewTiles },
      '原图预览 + 2×2 四格预览'
    )
    assert('config-2x2-persisted', state.rows === '2' && state.cols === '2', { rows: state.rows, cols: state.cols }, '行列写入配置')

    // ── 4. 运行 → 4 个产物资产 + 双输出可用 ──────────────────
    const beforeRun = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await runNode(page, split.card, '.image-split-quick')
    await split.card
      .waitForFunction(
        () => document.querySelector('.node-status')?.classList.contains('node-status-success'),
        { timeout: 8000 }
      )
      .catch(() => {})
    await page.waitForTimeout(700)
    state = await cardState(page, split.card)
    const afterRun = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const artifacts = afterRun.filter((nid) => !beforeRun.includes(nid))
    report.states.runSuccess = {
      status: state.status,
      artifacts: artifacts.length,
      ports: state.ports.filter((p) => p.dir === 'out')
    }
    await shot(page, '04-run-success-artifacts')
    assert('run-status-success', state.status === 'node-status-success', state.status, 'node-status-success')
    assert('run-produces-4-tile-assets', artifacts.length === 4, artifacts.length, 4)
    assert(
      'both-out-ports-has-output',
      state.ports.filter((p) => p.dir === 'out').every((p) => p.hasOutput),
      state.ports.filter((p) => p.dir === 'out'),
      '当前图片 + 图片集合 都可用'
    )

    // ── 5. out-图片集合 → 循环节点（list.items 通道） ─────────
    const iterate = await createNode(page, '循环')
    const menu2 = await dragConnect(page, split.card, '图片集合', iterate.card, '列表')
    await iterate.card
      .waitForFunction(() => document.querySelectorAll('.connected-input-item').length > 0, { timeout: 5000 })
      .catch(() => {})
    const iterState = await cardState(page, iterate.card)
    report.states.iterateLink = { menu: menu2, inputs: iterState.connectedInputs }
    await shot(page, '05-out-images-to-iterate')
    assert(
      'out-images-feeds-iterate-list',
      !menu2 && iterState.connectedInputs.some((i) => i.target === '列表'),
      iterState.connectedInputs,
      '图片集合接入循环 in-列表并显示来源'
    )

    // ── 6. out-当前图片 → 下游裁剪可消费 ─────────────────────
    // 拆分会物化 4 个产物资产节点，画布拥挤时拖拽可能脱靶：适配画布 + 最多三次尝试；
    // 一旦 in-端口已连接就只等工作台出图（高负载下渲染可能 >4s），不再重拖（单值口会被正确拒绝）。
    const crop2 = await createNode(page, '裁剪')
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await page.waitForTimeout(300)
    let menu3 = false
    let cropState = null
    let chainOk = false
    for (let attempt = 0; attempt < 3 && !chainOk; attempt += 1) {
      menu3 = await dragConnect(page, split.card, '当前图片', crop2.card, '原图')
      const connected = await crop2.card
        .evaluate((el) => (el.querySelector('.port-dot.in')?.getAttribute('title') ?? '').includes('已连接'))
        .catch(() => false)
      if (connected) {
        await crop2.card
          .waitForFunction(() => Boolean(document.querySelector('.crop-inline-canvas img')), { timeout: 8000 })
          .catch(() => {})
      }
      cropState = await cardState(page, crop2.card)
      chainOk = cropState.workbenchImg
      if (!chainOk && !connected) {
        await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
        await page.waitForTimeout(300)
      }
    }
    report.states.chain = { menu: menu3, workbenchImg: cropState.workbenchImg }
    await shot(page, '06-current-image-consumable')
    assert(
      'current-image-consumable-downstream',
      !menu3 && chainOk,
      { menu: menu3, workbenchImg: cropState.workbenchImg },
      '下游裁剪工作台显示当前图片'
    )

    // ── 7. 非法连线：text → in-原图 必须被拒 ─────────────────
    const textNode = await createNode(page, '文本')
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await page.waitForTimeout(300)
    await textNode.card.locator('.port-dot.out').first().waitFor({ state: 'visible' })
    await dragConnect(page, textNode.card, '文本', split.card, '原图')
    await page
      .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').includes('不兼容'), { timeout: 4000 })
      .catch(() => {})
    const rejectToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    await shot(page, '07-illegal-text-to-split')
    report.states.illegal = { toast: rejectToast }
    assert('illegal-text-to-split-rejected', rejectToast.includes('不兼容'), rejectToast, 'toast 含不兼容')

    // ── 8. 重载持久性 ─────────────────────────────────────────
    const idsBefore = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)
    const idsAfter = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const survived = idsBefore.filter((nid) => idsAfter.includes(nid))
    const splitAfter = page
      .locator('.node-card-wrap')
      .filter({ has: page.locator('.type-image-split') })
      .filter({ has: page.locator('.image-split-quick') })
      .first()
    const reloaded = await cardState(page, splitAfter)
    report.states.reload = {
      before: idsBefore.length,
      after: idsAfter.length,
      survived: survived.length,
      rows: reloaded.rows,
      cols: reloaded.cols,
      inConnected: reloaded.ports.find((p) => p.dir === 'in')?.connected,
      outsHasOutput: reloaded.ports.filter((p) => p.dir === 'out').map((p) => p.hasOutput)
    }
    await shot(page, '08-reload')
    console.log(`RELOAD ${JSON.stringify(report.states.reload)}`)
    assert(
      'reload-keeps-config-connection-results',
      reloaded.rows === '2' && reloaded.cols === '2' && reloaded.ports.find((p) => p.dir === 'in')?.connected &&
        reloaded.ports.filter((p) => p.dir === 'out').every((p) => p.hasOutput),
      report.states.reload,
      '配置/连线/双输出全部保留'
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
