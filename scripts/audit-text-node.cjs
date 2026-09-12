/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 文本节点专项审查（2026-09-12 全节点审查 · 第 1 个节点）。
 * 覆盖：空态几何、双击编辑、单/多输入合并、非法连线、slash 指令、空运行、重载。
 * 用法：node scripts/audit-text-node.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outputDir =
  process.argv[3] ?? join(process.cwd(), 'artifacts', 'text-node-audit-2026-09-12')

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

/** 采集单张节点卡的结构化几何与状态数据 */
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
    const bodyEl = body
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
        size: Math.round(p.getBoundingClientRect().width)
      })),
      overflow: bodyEl
        ? {
            x: bodyEl.scrollWidth > bodyEl.clientWidth + 1,
            y: bodyEl.scrollHeight > bodyEl.clientHeight + 1
          }
        : null,
      status: status ? Array.from(status.classList).find((c) => c.startsWith('node-status-')) : null,
      bodyText: bodyEl ? bodyEl.textContent?.slice(0, 400) : null,
      connectedInputs: Array.from(el.querySelectorAll('.connected-input-item')).map((item) => ({
        target: item.querySelector('.connected-input-target')?.textContent ?? '',
        order: item.querySelector('.connected-input-order')?.textContent ?? '',
        value: item.querySelector('.connected-input-value')?.textContent?.slice(0, 80) ?? '',
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

/** 真实指针拖拽：源输出端口 → 目标输入端口 */
async function dragPortToPort(page, fromCard, fromPortId, toCard, toPortId) {
  const from = await fromCard
    .locator(`.port-dot.out[title^="${fromPortId}"]`)
    .boundingBox()
  const to = await toCard.locator(`.port-dot.in[title^="${toPortId}"]`).boundingBox()
  if (!from || !to) throw new Error(`端口定位失败 ${fromPortId} -> ${toPortId}`)
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  // 分步移动，让中途采样与连线预览都有机会生效
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(
      from.x + from.width / 2 + ((to.x + to.width / 2 - (from.x + from.width / 2)) * i) / 8,
      from.y + from.height / 2 + ((to.y + to.height / 2 - (from.y + from.height / 2)) * i) / 8
    )
  }
  return { from, to }
}

async function finishDrag(page, to) {
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2)
  await page.mouse.up()
}

async function typeTextAndCommit(page, card, text) {
  await card.locator('.node-text').dblclick()
  const textarea = page.locator('.node-textarea')
  await textarea.waitFor({ state: 'visible' })
  await textarea.fill(text)
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(200)
}

/** 运行按钮仅在卡片选中后渲染：先单击标题栏选中，再点运行。 */
async function runNode(page, card) {
  await card.locator('.node-text').click()
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
    await page.waitForTimeout(500)

    // ── 1. 空态 ──────────────────────────────────────────────
    const target = await createNode(page, '文本')
    let state = await cardState(page, target.card)
    report.states.fresh = state
    await shot(page, '01-fresh-empty')
    assert('fresh-size-340x260', state.size?.w === 340 && state.size?.h === 260, state.size, {
      w: 340,
      h: 260
    })
    // 2026-09-12 规范修订：--node-header-h 单源化为悬浮标题 28px（F-TEXT-01/03）
    assert('fresh-header-28-floating', state.headerHeight === 28, state.headerHeight, 28)
    assert(
      'fresh-colorbar-8-bottom',
      state.colorBar?.h === 8 && state.colorBar?.atBottom,
      state.colorBar,
      { h: 8, atBottom: true }
    )
    assert('fresh-radius-12', state.borderRadius === '12px', state.borderRadius, '12px')
    assert(
      'fresh-ports',
      JSON.stringify(state.ports) ===
        JSON.stringify([
          { dir: 'in', id: '文本', size: 18 },
          { dir: 'out', id: '文本', size: 18 }
        ]),
      state.ports,
      'in-text + out-text, 18px'
    )
    assert(
      'fresh-no-overflow',
      state.overflow && !state.overflow.x && !state.overflow.y,
      state.overflow,
      { x: false, y: false }
    )
    assert(
      'fresh-hint',
      (state.bodyText ?? '').includes('双击输入文本内容'),
      state.bodyText,
      '包含空态提示'
    )

    // ── 2. 编辑态 + 输入提交 ─────────────────────────────────
    await target.card.locator('.node-text').dblclick()
    const textarea = page.locator('.node-textarea')
    const editingVisible = await textarea.isVisible()
    const focused = editingVisible ? await textarea.evaluate((el) => document.activeElement === el) : false
    await shot(page, '02-editing')
    assert('dblclick-enters-editing', editingVisible && focused, { editingVisible, focused }, true)
    await textarea.fill('主角站在雨中的十字路口')
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(200)
    state = await cardState(page, target.card)
    report.states.typed = state
    await shot(page, '03-typed-committed')
    assert('commit-persists-text', (state.bodyText ?? '').includes('主角站在雨中的十字路口'), state.bodyText, '正文已保存')
    assert('typed-no-overflow', state.overflow && !state.overflow.x && !state.overflow.y, state.overflow, { x: false, y: false })

    // ── 3. 多上游（2 条 in-text many）+ 顺序预览 ──────────────
    const upstreamA = await createNode(page, '文本')
    await typeTextAndCommit(page, upstreamA.card, '上游文本甲')
    const upstreamB = await createNode(page, '文本')
    await typeTextAndCommit(page, upstreamB.card, '上游文本乙')
    await dragPortToPort(page, upstreamA.card, '文本', target.card, '文本')
    // 拖拽中途采样：拖到一半时检查两端端口态
    await shot(page, '04a-drag-midway')
    await finishDrag(page, (await target.card.locator('.port-dot.in[title^="文本"]').boundingBox()))
    await page.waitForTimeout(300)
    await dragPortToPort(page, upstreamB.card, '文本', target.card, '文本')
    await finishDrag(page, (await target.card.locator('.port-dot.in[title^="文本"]').boundingBox()))
    await page.waitForTimeout(300)
    state = await cardState(page, target.card)
    report.states.multiInput = state
    await shot(page, '04-multi-input-connected')
    assert(
      'multi-input-preview-2-sources-with-order',
      state.connectedInputs.length === 2 &&
        state.connectedInputs.every((i) => i.target === '文本') &&
        state.connectedInputs.map((i) => i.order).join(',') === '1,2' &&
        state.connectedInputs.every((i) => i.source.length > 0),
      state.connectedInputs,
      '两条来源，顺序 1,2，含来源名'
    )

    // ── 4. 运行合并：上游在前 + 分隔符 + 自身文本 ─────────────
    await runNode(page, target.card)
    await page.waitForTimeout(600)
    state = await cardState(page, target.card)
    report.states.runMerged = state
    await shot(page, '05-run-merged-success')
    const expectedText = '上游文本甲\n\n---\n\n上游文本乙\n\n---\n\n主角站在雨中的十字路口'
    assert(
      'run-merges-upstream-then-own-text',
      (state.bodyText ?? '').includes('上游文本甲') &&
        (state.bodyText ?? '').includes('主角站在雨中的十字路口'),
      state.bodyText?.slice(0, 200),
      expectedText.slice(0, 200)
    )
    assert('run-status-success', state.status === 'node-status-success', state.status, 'node-status-success')

    // ── 5a. 非法连线（真拒绝）：text → 取帧 in-video 无任何兼容端口 ──
    const frameNode = await createNode(page, '取帧')
    await page.waitForTimeout(200)
    await dragPortToPort(page, target.card, '文本', frameNode.card, '源视频')
    await finishDrag(page, (await frameNode.card.locator('.port-dot.in[title^="源视频"]').boundingBox()))
    await page.waitForTimeout(400)
    const rejectToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    state = await cardState(page, frameNode.card)
    report.states.illegalDropRejected = { toast: rejectToast, connectedInputs: state.connectedInputs }
    await shot(page, '06-illegal-text-to-video-rejected')
    assert(
      'illegal-text-to-video-port-rejected',
      state.connectedInputs.length === 0 && rejectToast.includes('不兼容'),
      { toast: rejectToast, connectedInputs: state.connectedInputs },
      '无连线 + toast 含"不兼容"'
    )

    // ── 5b. 落点在非法端口（生图·参考图）上：观察当前重定向行为 ──
    const imageGen = await createNode(page, '生图')
    await page.waitForTimeout(200)
    await dragPortToPort(page, target.card, '文本', imageGen.card, '参考图')
    // 中途采样：拖拽时非法端口应为 dim，兼容端口应为 ok（规范 §4.2）
    const midwayPortStates = await page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('.node-card-wrap'))
      const card = wraps.find((w) => w.querySelector('.node-card.type-image-gen'))
      if (!card) return null
      return Array.from(card.querySelectorAll('.port-dot.in')).map((p) => ({
        port: (p.getAttribute('title') ?? '').split('（')[0],
        dim: p.classList.contains('dim'),
        ok: p.classList.contains('ok')
      }))
    })
    report.states.midwayPortStates = midwayPortStates
    assert(
      'drag-dims-illegal-targets-and-marks-compatible',
      Array.isArray(midwayPortStates) &&
        midwayPortStates.find((p) => p.port === '参考图')?.dim === true &&
        midwayPortStates.find((p) => p.port === '提示词')?.ok === true,
      midwayPortStates,
      { 参考图: 'dim', 提示词: 'ok' }
    )
    await shot(page, '06a-illegal-drag-midway')
    await finishDrag(page, (await imageGen.card.locator('.port-dot.in[title^="参考图"]').boundingBox()))
    await page.waitForTimeout(400)
    state = await cardState(page, imageGen.card)
    report.states.dropOnIllegalPort = state.connectedInputs
    // F-TEXT-06 修复：磁吸改连必须 toast 明示实际接入端口
    const retargetToast = (await page.locator('.global-toast').textContent().catch(() => '')) ?? ''
    assert(
      'retarget-toast-explains-actual-port',
      retargetToast.includes('已改连') && retargetToast.includes('提示词') && retargetToast.includes('参考图'),
      retargetToast,
      '含 已改连「提示词」+ 落点「参考图」原因'
    )
    await shot(page, '06b-drop-on-illegal-port-retargets')
    console.log(
      `OBSERVE drop-on-illegal-port: aimed=参考图 connected=${JSON.stringify(state.connectedInputs.map((i) => `${i.target}#${i.order}`))} toast=${retargetToast}`
    )

    // ── 6. slash 指令：/三视图 → 一键创建 3 个生图节点 ────────
    const slashNode = await createNode(page, '文本')
    await typeTextAndCommit(page, slashNode.card, '/三视图 赛博朋克女孩')
    await page.waitForTimeout(200)
    state = await cardState(page, slashNode.card)
    report.states.slashBar = state
    await shot(page, '07a-slash-bar')
    const genBtn = slashNode.card.locator('.slash-cmd-gen')
    const slashBarVisible = await genBtn.isVisible().catch(() => false)
    assert('slash-bar-appears-after-commit', slashBarVisible, slashBarVisible, true)
    const beforeGen = await page
      .locator('.node-card-wrap[data-node-id]')
      .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
    if (slashBarVisible) {
      await genBtn.click()
      await page.waitForTimeout(500)
      const afterGen = await page
        .locator('.node-card-wrap[data-node-id]')
        .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
      const created = afterGen.filter((nid) => !beforeGen.includes(nid))
      report.states.slashCreated = created.length
      await shot(page, '07-slash-generated-3-nodes')
      assert('slash-creates-3-image-gen-nodes', created.length === 3, created.length, 3)
      const promptCount = await page.evaluate((ids) => {
        const cards = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
        return cards
          .filter((c) => ids.includes(c.getAttribute('data-node-id')))
          .filter((c) => c.querySelector('.node-card.type-image-gen'))
          .filter((c) => (c.textContent ?? '').includes('赛博朋克女孩')).length
      }, created)
      assert('slash-prompts-carry-subject', promptCount === 3, promptCount, 3)
    }

    // ── 7. 空文本节点运行（skipped 语义） ─────────────────────
    const emptyNode = await createNode(page, '文本')
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await page.waitForTimeout(300)
    await runNode(page, emptyNode.card)
    await page.waitForTimeout(500)
    state = await cardState(page, emptyNode.card)
    report.states.emptyRun = state
    await shot(page, '08-empty-run')
    assert(
      'empty-run-does-not-fake-success',
      state.status !== 'node-status-success',
      state.status,
      '非 success'
    )

    // ── 8. 重载持久性（browserMock 环境如实记录） ─────────────
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
    console.log(`RELOAD nodes before=${idsBefore.length} after=${idsAfter.length} survived=${survived.length} (browser demo 持久化能力如实记录，桌面 SQLite 持久化另行验收)`)
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
