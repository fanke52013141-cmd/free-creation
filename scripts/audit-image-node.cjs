/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 图片资产节点专项审查（2026-09-12 全节点审查 · 第 2 个节点）。
 * 覆盖：空态几何、粘贴导入、双击预览、运行、后续动作快捷建节点、多输入角色、非法连线、空运行、重载。
 * 用法：node scripts/audit-image-node.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outputDir =
  process.argv[3] ?? join(process.cwd(), 'artifacts', 'image-node-audit-2026-09-12')

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
        hasOutput: p.classList.contains('has-output')
      })),
      overflow: body
        ? {
            x: body.scrollWidth > body.clientWidth + 1,
            y: body.scrollHeight > body.clientHeight + 1
          }
        : null,
      status: status ? Array.from(status.classList).find((c) => c.startsWith('node-status-')) : null,
      bodyText: body ? body.textContent?.slice(0, 300) : null,
      hasMedia: Boolean(el.querySelector('.node-media img')),
      mediaTitle: el.querySelector('.node-title')?.textContent ?? '',
      connectedInputs: Array.from(el.querySelectorAll('.connected-input-item')).map((item) => ({
        target: item.querySelector('.connected-input-target')?.textContent ?? '',
        order: item.querySelector('.connected-input-order')?.textContent ?? '',
        source: item.querySelector('.connected-input-source')?.textContent ?? '',
        hasThumb: Boolean(item.querySelector('img'))
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
  await page.waitForTimeout(800)
}

async function dragPortToPort(page, fromCard, fromTitle, toCard, toTitle) {
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
  return to
}

/**
 * 落点策略：默认从端口圆心向卡片内移 40px 再松手。
 * 端口圆心在卡边外 16px，正好贴着 getShapeAtPoint 的 24px 命中余量边缘，
 * 实测会偶发脱靶并弹出"创建节点"菜单污染后续步骤；内移落点稳定命中节点，
 * tryConnect 会自动选择最近兼容端口（单一兼容口时与瞄准端口一致）。
 */
async function finishDrag(page, to, inset = 40) {
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
    // 演示画布持久化在 sessionStorage（同 tab 跨 reload 保留），先清场保证每次运行等价
    await page.evaluate(() => sessionStorage.clear())
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(500)

    // ── 1. 空态 ──────────────────────────────────────────────
    const target = await createNode(page, '图片')
    let state = await cardState(page, target.card)
    report.states.fresh = state
    await shot(page, '01-fresh-empty')
    assert('fresh-size-340x260', state.size?.w === 340 && state.size?.h === 260, state.size, { w: 340, h: 260 })
    assert('fresh-header-28-floating', state.headerHeight === 28, state.headerHeight, 28)
    assert(
      'fresh-colorbar-8-bottom',
      state.colorBar?.h === 8 && state.colorBar?.atBottom,
      state.colorBar,
      { h: 8, atBottom: true }
    )
    assert('fresh-radius-12', state.borderRadius === '12px', state.borderRadius, '12px')
    assert(
      'fresh-ports-no-in-one-out',
      JSON.stringify(state.ports) === JSON.stringify([{ dir: 'out', id: '图片', size: 18, hasOutput: false }]),
      state.ports,
      '仅 1 个 out-image 端口，18px，无输入端口'
    )
    assert('fresh-no-overflow', state.overflow && !state.overflow.x && !state.overflow.y, state.overflow, { x: false, y: false })
    assert(
      'fresh-hint-and-import-button',
      (state.bodyText ?? '').includes('上传或粘贴') && (state.bodyText ?? '').includes('导入图片'),
      state.bodyText,
      '空态提示 + 导入按钮'
    )

    // ── 2. 粘贴导入 ──────────────────────────────────────────
    await pasteImage(page, 'image-audit.png')
    const importedId = await page
      .waitForFunction(() => {
        const cards = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
        return (
          cards
            .filter((c) => c.querySelector('.node-media img'))
            .map((c) => c.getAttribute('data-node-id'))
            .find(Boolean) ?? null
        )
      })
      .then((h) => h.jsonValue())
    const imported = page.locator(`.node-card-wrap[data-node-id="${importedId}"]`)
    state = await cardState(page, imported)
    report.states.imported = state
    await shot(page, '02-pasted-imported')
    assert('paste-import-shows-thumbnail', state.hasMedia === true, state.hasMedia, true)
    assert('paste-import-sets-title', state.mediaTitle.includes('image-audit'), state.mediaTitle, '标题=文件名')
    assert('imported-no-overflow', state.overflow && !state.overflow.x && !state.overflow.y, state.overflow, { x: false, y: false })
    assert(
      'imported-output-port-available',
      state.ports.some((p) => p.dir === 'out' && p.hasOutput),
      state.ports,
      'out 端口 has-output'
    )

    // ── 3. 双击预览 ──────────────────────────────────────────
    await imported.locator('.node-media').dblclick()
    const previewVisible = await page.locator('.media-preview-mask').isVisible().catch(() => false)
    await shot(page, '03-doubleclick-preview')
    assert('doubleclick-opens-media-preview', previewVisible, previewVisible, true)
    if (previewVisible) {
      // 遮罩中心被预览舞台拦截，直接对遮罩元素本身派发 click 关闭
      await page.evaluate(() => {
        document.querySelector('.media-preview-mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await page.waitForTimeout(250)
    }
    const previewClosed = !(await page.locator('.media-preview-mask').isVisible().catch(() => false))
    assert('media-preview-closes-on-mask-click', previewClosed, previewClosed, true)

    // ── 4. 运行成功 ──────────────────────────────────────────
    await runNode(page, imported, '.node-media')
    await page.waitForTimeout(500)
    state = await cardState(page, imported)
    report.states.runSuccess = state
    await shot(page, '04-run-success')
    assert('run-status-success', state.status === 'node-status-success', state.status, 'node-status-success')

    // ── 5. 后续动作：快捷创建已连线的声明节点 ─────────────────
    const beforeCont = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await imported.getByRole('button', { name: '裁剪图片' }).click()
    await page.waitForTimeout(300)
    await imported.getByRole('button', { name: '生成视频' }).click()
    await page.waitForTimeout(300)
    const afterCont = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const createdCont = afterCont.filter((nid) => !beforeCont.includes(nid))
    await shot(page, '05-continuation-nodes')
    const typeOfCard = await page.evaluate((ids) => {
      const out = {}
      for (const card of document.querySelectorAll('.node-card-wrap[data-node-id]')) {
        const id = card.getAttribute('data-node-id')
        if (ids.includes(id)) {
          const el = card.querySelector('.node-card')
          out[id] = Array.from(el?.classList ?? []).find((c) => c.startsWith('type-')) ?? ''
        }
      }
      return out
    }, createdCont)
    const cropId = createdCont.find((nid) => typeOfCard[nid] === 'type-image-crop')
    const videoId = createdCont.find((nid) => typeOfCard[nid] === 'type-video')
    const cropCard = page.locator(`.node-card-wrap[data-node-id="${cropId}"]`)
    const videoCard = page.locator(`.node-card-wrap[data-node-id="${videoId}"]`)
    // crop/video 使用专用输入面（无通用 .connected-input-item）：分别断言各自的真实呈现。
    // 高负载下 React 提交可能晚于固定 sleep，全部改为 waitForFunction 轮询。
    await cropCard
      .waitForFunction(() => Boolean(document.querySelector('img[alt="待裁剪图片"]')), { timeout: 5000 })
      .catch(() => {})
    const cropSurface = await cropCard.evaluate((el) => ({
      hasSource: Boolean(el.querySelector('img[alt="待裁剪图片"]')),
      emptyHint: Boolean(el.querySelector('.crop-no-source'))
    }))
    await videoCard
      .waitForFunction(() => document.querySelectorAll('.video-reference-chip').length > 0, { timeout: 5000 })
      .catch(() => {})
    const videoSurface = await videoCard.evaluate((el) => {
      const chips = Array.from(el.querySelectorAll('.video-reference-chip'))
      return {
        count: chips.length,
        names: chips.map((c) => c.querySelector('.video-reference-name')?.textContent ?? ''),
        roles: chips.map((c) => c.querySelector('.video-reference-role')?.textContent ?? '')
      }
    })
    report.states.continuation = { created: createdCont.length, cropSurface, videoSurface }
    assert('continuation-creates-2-nodes', createdCont.length === 2, createdCont.length, 2)
    assert(
      'continuation-crop-connected-in-image',
      cropSurface.hasSource && !cropSurface.emptyHint,
      cropSurface,
      '裁剪专用输入面显示待裁剪图片'
    )
    assert(
      'continuation-video-connected-in-images',
      videoSurface.count === 1 &&
        videoSurface.roles[0]?.includes('参考图') &&
        videoSurface.names[0]?.includes('image-audit'),
      videoSurface,
      '视频专用输入面显示 来源名 + 参考图 1 角色'
    )

    // ── 6. 手动连线到生图 many 口 ─────────────────────────────
    const imageGen = await createNode(page, '生图')
    await dragPortToPort(page, imported, '图片', imageGen.card, '参考图')
    const genMenu = await finishDrag(page, (await imageGen.card.locator('.port-dot.in[title^="参考图"]').boundingBox()))
    await imageGen.card
      .waitForFunction(
        () => Boolean(document.querySelector('.connected-input-item')),
        { timeout: 5000 }
      )
      .catch(() => {})
    const genState = await cardState(page, imageGen.card)
    report.states.genConnected = { menuOpened: genMenu, inputs: genState.connectedInputs }
    await shot(page, '06-manual-connect-image-gen')
    assert(
      'manual-connect-image-gen-many-order',
      !genMenu &&
        genState.connectedInputs.some((i) => i.target === '参考图' && i.order === '1' && i.hasThumb),
      genState.connectedInputs,
      '参考图 order=1 带缩略图（且未弹出创建菜单）'
    )

    // ── 7. 非法连线：image → 文本 in-text 必须被拒 ────────────
    const textNode = await createNode(page, '文本')
    await dragPortToPort(page, imported, '图片', textNode.card, '文本')
    await finishDrag(page, (await textNode.card.locator('.port-dot.in[title^="文本"]').boundingBox()))
    await page
      .waitForFunction(() => (document.querySelector('.global-toast')?.textContent ?? '').includes('不兼容'), { timeout: 4000 })
      .catch(() => {})
    const rejectToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    const textState = await cardState(page, textNode.card)
    report.states.illegalDrop = { toast: rejectToast, connectedInputs: textState.connectedInputs }
    await shot(page, '07-illegal-image-to-text-rejected')
    assert(
      'illegal-image-to-text-rejected',
      textState.connectedInputs.length === 0 && rejectToast.includes('不兼容'),
      { toast: rejectToast, connectedInputs: textState.connectedInputs },
      '无连线 + toast 含"不兼容"'
    )

    // ── 8. 空资产运行（skipped 语义） ─────────────────────────
    const emptyNode = await createNode(page, '图片')
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await page.waitForTimeout(300)
    await runNode(page, emptyNode.card, '.asset-empty')
    await page.waitForTimeout(500)
    state = await cardState(page, emptyNode.card)
    report.states.emptyRun = state
    await shot(page, '08-empty-run')
    assert('empty-run-does-not-fake-success', state.status !== 'node-status-success', state.status, '非 success')

    // ── 9. 重载持久性（browser demo 如实记录） ────────────────
    const idsBefore = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    const idsAfter = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    const survived = idsBefore.filter((nid) => idsAfter.includes(nid))
    report.states.reload = { before: idsBefore.length, after: idsAfter.length, survived: survived.length }
    await shot(page, '09-reload')
    console.log(`RELOAD before=${idsBefore.length} after=${idsAfter.length} survived=${survived.length}`)
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
