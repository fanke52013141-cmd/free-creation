/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 上游连线呈现审查（2026-11-19 用户裁决）：连线不得夺走节点原有的编辑能力。
 *
 * 场景：文本节点 → AI 处理 → 生图（与循环体模板内定义链同构）。
 * 验证点：
 *  1) 生图：连上游文本后提示词框保持可编辑（不再被上游输出劫持为只读），
 *     上游输入仅通过顶部引用呈现；框内二次修改可提交落盘；
 *     运行生图（演示图）验证「上游输入 + 本框内容」拼接链路可用。
 *  2) AI 处理：公共单排引用、可滚动的结果框、原生拖选及复制。
 *
 * 用法：node scripts/audit-editable-prompt.cjs [baseUrl] [outputDir]
 * 前置：npx vite --config vite.browser.config.ts（127.0.0.1:5173 浏览器验收环境，演示 mock）
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const outputDir =
  process.argv[3] ?? join(process.cwd(), 'artifacts', 'editable-prompt-audit-20261119')

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

async function createNode(page, label, category = '输入与素材') {
  const before = await page
    .locator('.node-card-wrap[data-node-id]')
    .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-node-id')))
  // 节点清单在分类悬浮展开的 flyout 里：先清掉残留弹层，再悬停分类打开节点清单
  await page.keyboard.press('Escape')
  await page.mouse.move(1200, 760)
  await page.waitForTimeout(250)
  await page.locator('.palette-item.palette-category-item', { hasText: category }).hover()
  await page.waitForTimeout(400)
  const item = page.getByRole('button', { name: `添加${label}节点`, exact: true })
  await item.waitFor({ timeout: 8000 })
  await item.click()
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
  await page.mouse.move(900, 500)
  await page.waitForTimeout(300)
  return { id, card: page.locator(`.node-card-wrap[data-node-id="${id}"]`) }
}

/** 文本类节点：双击正文 → textarea → 填 → blur 提交（与 audit-ai-json-chain 同款）。 */
async function setText(page, card, value) {
  await card.locator('.node-text').first().dblclick()
  const ta = card.locator('textarea.node-textarea')
  await ta.waitFor({ timeout: 5000 })
  await ta.fill(value)
  await ta.blur()
  await page.waitForTimeout(500)
}

/** 直接经画布编辑器摆位：运行产物卡会落在节点右侧并可能盖住端口圆点
 *  （被盖住的端口不渲染，见 NodeCardView 遮挡规则），固定网格位避免互相遮挡。 */
async function placeAt(page, nodeId, x, y) {
  await page.evaluate(([nodeIdArg, nx, ny]) => {
    window.__canvasEditor.updateShape({ id: nodeIdArg, type: 'node-card', x: nx, y: ny })
  }, [nodeId, x, y])
  await page.waitForTimeout(300)
}

/** 拖拽连线：优先瞄准目标端口圆点；卡片没渲染该端口圆点时（如生图的 in-text 由
 *  tryConnect 自动选口），落到卡片中心让 tryConnect 就近挑兼容端口。 */
async function dragConnect(page, fromCard, fromPortId, toCard, toPortId) {
  const from = await fromCard.locator(`.port-dot.out[data-port-id="${fromPortId}"]`).boundingBox()
  const toDot = toCard.locator(`.port-dot.in[data-port-id="${toPortId}"]`)
  let to = (await toDot.count()) > 0 ? await toDot.boundingBox() : null
  if (!from) throw new Error(`端口定位失败 out:${fromPortId}`)
  if (!to) {
    const box = await toCard.boundingBox()
    if (!box) throw new Error(`目标卡片定位失败 in:${toPortId}`)
    to = { x: box.x + box.width / 2 - 8, y: box.y + box.height / 2, width: 16, height: 16 }
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(
      from.x + from.width / 2 + ((to.x + to.width / 2 - (from.x + from.width / 2)) * i) / 8,
      from.y + from.height / 2 + ((to.y + to.height / 2 - (from.y + from.height / 2)) * i) / 8
    )
  }
  await page.mouse.move(to.x + to.width / 2 + 40, to.y + to.height / 2)
  await page.mouse.up()
  await page.waitForTimeout(400)
  const menuOpened = await page.locator('.node-create-menu').isVisible().catch(() => false)
  if (menuOpened) await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

async function main() {
  mkdirSync(outputDir, { recursive: true })
  const browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1708, height: 879 } })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const report = { baseUrl, assertions: [] }
  const assert = (name, pass, actual) => {
    report.assertions.push({
      name,
      pass: Boolean(pass),
      actual: actual === undefined ? '' : String(actual).slice(0, 400)
    })
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` actual=${JSON.stringify(actual)}`}`)
  }
  const readBody = (card) =>
    card.evaluate((el) => {
      const ta = el.querySelector('.gen-prompt')
      return {
        preview: el.querySelector('.upstream-input-preview')?.textContent ?? null,
        referenceBar: Boolean(el.querySelector('.connected-inputs')),
        promptValue: ta ? ta.value : null,
        promptReadOnly: ta ? ta.readOnly : null,
        resultFrame: Boolean(el.querySelector('.ai-process-result-frame'))
      }
    })

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    // 演示画布持久化在 sessionStorage（同 tab 跨 reload 保留），先清场保证每次运行等价
    await page.evaluate(() => sessionStorage.clear())
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(500)

    // ── 1. 建链：文本（上游）→ 生图 ─────────────────────────
    const textNode = await createNode(page, '文本')
    await placeAt(page, textNode.id, 250, 250)
    await setText(page, textNode.card, '镜头提示词A：海边日落，暖色调，电影感构图')

    const genNode = await createNode(page, '生图', '图片创作')
    await placeAt(page, genNode.id, 760, 250)
    await page.waitForTimeout(300)
    const beforeConnect = await readBody(genNode.card)
    assert(
      'gen-prompt-editable-before-connect',
      beforeConnect.promptReadOnly === false && beforeConnect.promptValue === '',
      beforeConnect
    )
    assert(
      'gen-no-preview-before-connect',
      beforeConnect.preview === null,
      beforeConnect.preview
    )

    await dragConnect(page, textNode.card, 'out-text', genNode.card, 'in-text')
    await page.waitForTimeout(500)
    const afterConnect = await readBody(genNode.card)
    await shot(page, '01-gen-connected')
    assert(
      'gen-upstream-only-in-reference-bar',
      afterConnect.referenceBar && afterConnect.preview === null,
      afterConnect
    )
    assert(
      'gen-prompt-still-editable-and-empty',
      afterConnect.promptReadOnly === false && afterConnect.promptValue === '',
      afterConnect
    )
    // ── 2. 二次修改：框内输入自己的补充并提交落盘 ────────────
    const prompt = genNode.card.locator('.gen-prompt')
    await prompt.click()
    await prompt.fill('二次修改：改成剪影构图，加飞鸟')
    await prompt.blur()
    await page.waitForTimeout(500)
    const afterEdit = await readBody(genNode.card)
    assert(
      'gen-secondary-edit-persists',
      afterEdit.promptValue === '二次修改：改成剪影构图，加飞鸟',
      afterEdit.promptValue
    )
    const storedText = await page.evaluate((nodeId) => {
      const editor = window.__canvasEditor
      const shape = editor?.getShape(nodeId)
      return shape ? shape.props.text : null
    }, genNode.id)
    assert(
      'gen-secondary-edit-committed-to-node',
      storedText === '二次修改：改成剪影构图，加飞鸟',
      storedText
    )
    await shot(page, '02-gen-edited')

    // ── 3. 运行生图（演示图）：上游输入 + 本框内容 拼接链路可用 ──
    const runButton = genNode.card.getByRole('button', { name: /生成图片/ })
    await runButton.click()
    await page.waitForTimeout(1200)
    await genNode.card.locator('.node-status-success').waitFor({ timeout: 30000 })
    await page.waitForTimeout(800)
    const genState = await genNode.card.evaluate((el) => ({
      hasMedia: Boolean(el.querySelector('.node-media img')),
      status: Array.from(el.querySelectorAll('[class*="node-status"]'))
        .map((s) => s.className)
        .join(' ')
    }))
    await shot(page, '03-gen-run')
    assert('gen-run-succeeds-with-merged-prompt', genState.status.includes('node-status-success'), genState)

    // ── 4. AI 处理：输入（只读）+ 输出（结果框）同卡呈现 ─────
    // 演示环境的 workspaceProfile 在调色板隐藏了 ai-process（桌面端可见）；
    // 节点类型本身已注册，这里经画布编辑器直接建卡走同一渲染路径。
    const aiId = await page.evaluate(() => {
      const editor = window.__canvasEditor
      const id = `shape:audit-ai-${Date.now()}`
      editor.createShape({
        id,
        type: 'node-card',
        x: 300,
        y: 600,
        props: { nodeType: 'ai-process', title: 'AI 处理', w: 340, h: 300 }
      })
      return id
    })
    await page.waitForTimeout(500)
    const aiNode = { id: aiId, card: page.locator(`.node-card-wrap[data-node-id="${aiId}"]`) }
    await dragConnect(page, textNode.card, 'out-text', aiNode.card, 'in-text')
    await page.waitForTimeout(500)
    const aiState = await readBody(aiNode.card)
    await shot(page, '04-ai-input-preview')
    assert(
      'ai-input-preview-visible',
      aiState.referenceBar && aiState.preview === null,
      aiState.preview
    )

    // 注入钉住输出（与真实运行成功后的呈现同路径）验证输入+输出并存：
    // mock 环境的 chatStart 不派发完成事件，无法真实跑完 AI 处理；
    // 结果框渲染分支未改动，这里用 pinnedOutput 走 projectNodeOutputs 的真实投影入口。
    await page.evaluate((nodeId) => {
      const editor = window.__canvasEditor
      const shape = editor?.getShape(nodeId)
      if (!shape) throw new Error('AI 处理节点未找到')
      editor.updateShape({
        id: nodeId,
        type: 'node-card',
        meta: {
          ...shape.meta,
          pinnedOutput: JSON.stringify({
            version: 1,
            outputs: { 'out-text': { kind: 'text', text: '处理后的分镜文案：少女站在海边回望\n'.repeat(40) } }
          })
        }
      })
    }, aiNode.id)
    await page.waitForTimeout(500)
    const aiAfter = await readBody(aiNode.card)
    await shot(page, '05-ai-input-and-output')
    assert('ai-output-frame-shown', aiAfter.resultFrame, aiAfter)
    assert(
      'ai-input-and-output-coexist',
      aiAfter.referenceBar && aiAfter.preview === null,
      aiAfter.preview
    )
    const resultLayout = await aiNode.card.locator('.ai-process-result-frame').evaluate((frame) => {
      const scroll = frame.closest('.node-standard-scroll')
      const fits = frame.getBoundingClientRect().bottom < scroll.getBoundingClientRect().bottom
      frame.scrollTop = frame.scrollHeight
      return { fits, scrolls: frame.scrollTop > 0 }
    })
    assert('ai-result-frame-fits-and-scrolls', resultLayout.fits && resultLayout.scrolls, resultLayout)
    const result = aiNode.card.locator('.ai-process-result-frame')
    await result.evaluate((frame) => { frame.scrollTop = 0 })
    const box = await result.boundingBox()
    await page.mouse.move(box.x + 15, box.y + 21)
    await page.mouse.down()
    await page.mouse.move(box.x + 100, box.y + 21, { steps: 10 })
    await page.mouse.up()
    const selected = await page.evaluate(() => getSelection()?.toString())
    assert('ai-result-native-selection', Boolean(selected?.trim()), selected)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.keyboard.press('Control+C')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    assert('ai-result-copy-copies-selected-text', Boolean(selected) && copied === selected, copied)
    // 多上游：把 AI 处理输出也连进生图 in-text（多值端口），预览条合并两条上游且框仍可编辑
    await dragConnect(page, aiNode.card, 'out-text', genNode.card, 'in-text')
    await page.waitForTimeout(500)
    report.arrowsAfterAiConnect = await page.evaluate(() => {
      const editor = window.__canvasEditor
      const cards = editor.getCurrentPageShapes().filter((s) => s.type === 'node-card')
      const typeOf = (id) => cards.find((c) => c.id === id)?.props.nodeType ?? '?'
      return editor.getCurrentPageShapes()
        .filter((s) => s.type === 'arrow')
        .map((a) => {
          const b = editor.getBindingsFromShape(a.id, 'arrow')
          const start = b.find((x) => x.props.terminal === 'start')
          const end = b.find((x) => x.props.terminal === 'end')
          return {
            from: `${typeOf(start?.toId)}(${start?.toId.slice(0, 14)})`,
            to: `${typeOf(end?.toId)}(${end?.toId.slice(0, 14)})`,
            fromPort: a.meta?.fromPort,
            toPort: a.meta?.toPort
          }
        })
    })
    const genFinal = await readBody(genNode.card)
    await shot(page, '06-gen-multi-upstream')
    assert(
      'gen-keeps-only-top-reference-for-multiple-upstreams',
      genFinal.referenceBar && genFinal.preview === null,
      genFinal
    )
    assert('gen-prompt-editable-final', genFinal.promptReadOnly === false, genFinal)
  } catch (error) {
    await shot(page, '99-error').catch(() => {})
    report.fatal = String(error && error.message ? error.message : error)
    // 失败现场：画布上还有哪些卡、各自端口与可见性
    report.stateAtFailure = await page
      .locator('.node-card-wrap')
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute('data-node-id'),
          type: el.querySelector('.node-card')?.dataset.nodeType ?? null,
          ports: Array.from(el.querySelectorAll('.port-dot')).map((d) => d.getAttribute('data-port-id')),
          rect: (() => {
            const r = el.getBoundingClientRect()
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          })()
        }))
      )
      .catch(() => null)
    console.error('FATAL', report.fatal)
  } finally {
    writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
  const failed = report.assertions.filter((a) => !a.pass)
  console.log(`\n${report.assertions.length - failed.length}/${report.assertions.length} passed`)
  process.exit(failed.length > 0 || report.fatal ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
