/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Requires the browser dev server; uses an isolated profile and never edits desktop projects.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

// 与另外四支浏览器门禁一致：默认 5173，可用 BROWSER_ORIGIN 指到别的端口。
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5173'

// 优先真实 Chrome（历史基线），缺失时回退 Edge / Playwright 内置 Chromium，
// 保证审查通道在不同机器上都能启动。
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
  try {
    const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
    page.setDefaultTimeout(8_000)
    await page.goto(`${ORIGIN}/`)
    await page.getByRole('button', { name: '添加图片节点', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '导入图片', exact: true }).click()
    await (
      await chooser
    ).setFiles({
      name: 'ui-fixture.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64'
      )
    })
    await page.waitForFunction(() => {
      const img = document.querySelector('.type-image .node-media img')
      return img && img.complete && img.naturalWidth === 1
    })
    await page.locator('.type-image .node-media img').click()
    assert.equal(
      await page.locator('.media-preview-mask').count(),
      0,
      '单击媒体只应选中节点，不应打开预览'
    )
    await page.locator('.type-image .node-media img').dblclick()
    await page.locator('.media-preview-mask').waitFor()
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.locator('.media-preview-mask').waitFor({ state: 'detached' })
    const browserMediaResults = await page.evaluate(async () => {
      const media = await window.api.listMedia('demo')
      const source = media.data.find((item) => item.kind === 'image')
      if (!media.ok || !source)
        return { crop: false, split: false, generated: false, savedModel: false }
      const crop = await window.api.cropImage({
        projectId: 'demo',
        sourceMediaId: source.id,
        config: {
          version: 1,
          mode: 'rect',
          aspectRatio: 'free',
          rect: { x: 0, y: 0, width: 0.5, height: 1 },
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
            { x: 1, y: 1 }
          ]
        }
      })
      const split = await window.api.splitImageGrid({
        projectId: 'demo',
        sourceMediaId: source.id,
        config: { version: 1, rows: 1, columns: 2, scalePercent: 100 }
      })
      const saved = await window.api.gateway.saveProvider({
        name: '浏览器验收模型',
        specId: 'relay',
        baseURL: 'https://example.com/v1',
        apiKey: 'browser-demo-key',
        models: [{ id: 'browser-image', modality: 'image' }]
      })
      const generated = await window.api.gateway.imageGenerate({
        projectId: 'demo',
        providerId: saved.ok ? saved.data.id : 'mock-relay',
        modelId: 'browser-image',
        prompt: '浏览器验收生图',
        size: '512x512'
      })
      const providers = await window.api.gateway.listProviders()
      return {
        crop: crop.ok,
        cropMessage: crop.ok ? '' : crop.error.message,
        split: split.ok && split.data.length === 2,
        splitMessage: split.ok ? String(split.data.length) : split.error.message,
        generated: generated.ok && generated.data.kind === 'image',
        savedModel:
          saved.ok &&
          providers.ok &&
          providers.data.some((provider) =>
            provider.models.some((model) => model.id === 'browser-image')
          )
      }
    })
    assert.deepEqual(browserMediaResults, {
      crop: true,
      cropMessage: '',
      split: true,
      splitMessage: '2',
      generated: true,
      savedModel: true
    })
    // 浏览器演示同样要能完成真实的画布内图片拆分，而不是把能力 mock 成失败。
    await page.getByRole('button', { name: '添加拆分节点', exact: true }).click()
    // P1-1 回归（QA-NODE-AUDIT-2026-09-06）：卡片必须整体落在顶栏之下，否则标题行的
    // 运行/说明按钮会被顶栏截获命中而不可点。
    // 只统计**已渲染**的卡片：tldraw 会剔除视口外的形状，被剔除的 `.node-card-wrap`
    // 量出来是 0×0 且 top 为 0，会被当成「顶在顶栏里」。2026-09-19 实测：适配画布把
    // 相机对准旧节点后，刚新建的那张卡还在视口外，门禁就是被这个假形状卡住的。
    // minRendered 用来防止「全部被剔除 → 断言空转通过」。
    const assertCardsClearOfTopbar = async (minRendered) => {
      await page.waitForFunction(
        (want) => {
          const bar = document.querySelector('.canvas-topbar')
          const minY = bar ? bar.getBoundingClientRect().bottom : 0
          const rendered = Array.from(document.querySelectorAll('.node-card-wrap'))
            .map((c) => c.getBoundingClientRect())
            .filter((r) => r.height > 0)
          return rendered.length >= want && Math.min(...rendered.map((r) => r.top)) >= minY
        },
        minRendered
      )
    }
    // 端口只有在「这一点上真的是端口本身」时才拖得动：相机动画未停、或 tldraw 每次按下后
    // 临时铺的 .tl-hit-test-blocker 盖住端口，都会让随后的拖线拖在空处。这两件事都不该靠写死
    // 的毫秒数猜（2026-09-19 试过「等 blocker 从 DOM 消失」，实测那层一直留在 DOM 里，直接把
    // 门禁卡死），所以要问命中测试本身：端口中心点上是不是就是那个端口。
    const portHitBox = async (locator) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const box = await locator.boundingBox()
        if (
          box &&
          (await locator.evaluate(
            (el, center) => {
              const hit = document.elementFromPoint(center.x, center.y)
              return hit === el || el.contains(hit)
            },
            { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          ))
        )
          return box
        await page.waitForTimeout(150)
      }
      return null
    }
    await assertCardsClearOfTopbar(2)
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    const splitNode = page.locator('.node-card-wrap:has(.type-image-split)').first()
    await splitNode.waitFor()
    assert.match(await splitNode.innerText(), /原图（in-image）未连线/)
    assert.equal(
      await splitNode.locator('.image-split-quick-controls').count(),
      1,
      '图片拆分的行列与面积必须直接显示在节点内'
    )
    assert.equal(
      await splitNode.getByRole('button', { name: '快速拆分', exact: true }).count(),
      0,
      '图片拆分不再保留底部快速拆分按钮，应由节点右上角统一运行入口执行'
    )
    const upload = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传本地文件', exact: true }).click()
    await (
      await upload
    ).setFiles({
      name: 'ui-text.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('你好，导入测试')
    })
    await page.getByText('你好，导入测试', { exact: true }).waitFor()
    await page.getByRole('button', { name: '添加文本节点', exact: true }).click()
    await assertCardsClearOfTopbar(2)
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    // 适配是 220ms 的相机动画；不等它就量端口坐标，拖线会拖在上一帧的位置上。
    await page.waitForTimeout(260)
    const nodes = page.locator('.node-card-wrap:has(.type-text)')
    assert.equal(await nodes.count(), 2)
    const source = nodes.first()
    const destination = nodes.last()
    await source.locator('.node-card').click({ position: { x: 120, y: 100 } })
    assert.match(await source.getAttribute('class'), /is-selected/)
    const before = await source.boundingBox()
    const a = await portHitBox(source.locator('.port-dot.out'))
    const b = await portHitBox(destination.locator('.port-dot.in'))
    const sourceRect = await source.boundingBox()
    const destinationRect = await destination.boundingBox()
    assert.equal(
      await source.locator('.port-dot.out').evaluate((port) => getComputedStyle(port).width),
      '18px',
      '端口需要是更大的可命中圆环'
    )
    assert.ok(a.x >= sourceRect.x + sourceRect.width, '输出端口必须完整位于节点外侧')
    assert.ok(b.x + b.width <= destinationRect.x, '输入端口必须完整位于节点外侧')
    // §16.1 端口材质：类型色就是类型色。18px 只是透明命中区，视觉是 ::after 的
    // 10px 实色圆点，描边一律没有；未连接只降不透明度。旧版本这里断言
    // borderStyle === 'dashed'，那是被 #1 废止的虚线空心口，不是缺陷。
    const outPortStyle = await source
      .locator('.port-dot.out')
      .evaluate((port) => {
        const after = getComputedStyle(port, '::after')
        return {
          hitAreaBorder: getComputedStyle(port).borderStyle,
          hitAreaBackground: getComputedStyle(port).backgroundColor,
          dotBorder: after.borderStyle,
          dotWidth: after.width,
          dotBackground: after.backgroundColor,
          dotOpacity: getComputedStyle(port).opacity
        }
      })
    assert.equal(outPortStyle.hitAreaBorder, 'none', '命中区不得自带描边')
    assert.equal(outPortStyle.hitAreaBackground, 'rgba(0, 0, 0, 0)', '命中区必须透明')
    assert.equal(outPortStyle.dotBorder, 'none', '未连接端口不得用虚线描边，只降不透明度')
    assert.equal(outPortStyle.dotWidth, '10px', '视觉圆点固定 10px')
    assert.notEqual(outPortStyle.dotBackground, 'rgba(0, 0, 0, 0)', '圆点必须是实色填充')
    assert.ok(
      Number(outPortStyle.dotOpacity) < 1,
      `未连接端口必须降低不透明度，实测 ${outPortStyle.dotOpacity}`
    )
    const edgeCountBeforeTextConnect = await page.locator('.data-edge').count()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
    await page.mouse.up()
    await page.waitForFunction(
      (count) => document.querySelectorAll('.data-edge').length > count,
      edgeCountBeforeTextConnect
    )
    assert.equal(
      await page
        .locator('.data-edge-visible')
        .first()
        .evaluate((line) => getComputedStyle(line).strokeDasharray),
      'none',
      '普通数据线必须为实线；重叠效果仅应通过透明度实现'
    )
    assert.ok(
      await page.locator('.data-edge-visible[data-edge-obscured], .data-edge-obscured').count(),
      '数据线必须存在节点遮挡片段的淡化层'
    )
    // §16.1 文本节点：连线验收以真实数据边为准。正文卡片不再重复渲染
    // “上游 N 路”提示（节点正文和右侧契约面板分别承担内容与配置展示），
    // 因此不能再把不存在的 `.node-wiring` 当作连线失败。
    assert.equal(await nodes.count(), 2)
    assert.equal(
      await page.locator('.data-edge').count(),
      1,
      '文本节点连线后必须存在且仅存在一条真实数据边'
    )
    const after = await source.boundingBox()
    assert.equal(after.width, before.width, 'port drag must not resize width')
    assert.equal(after.height, before.height, 'port drag must not resize height')
    // The edge away from the port must still resize normally.
    await page.mouse.move(after.x + after.width, after.y + 40)
    await page.mouse.down()
    await page.mouse.move(after.x + after.width + 45, after.y + 40, { steps: 10 })
    await page.mouse.up()
    assert.ok(
      (await source.boundingBox()).width > after.width + 20,
      'edge away from port must resize'
    )
    assert.equal(await page.locator('.node-readiness-badge').count(), 0)
    const headerAlignment = await source.evaluate((card) => {
      const cardRect = card.getBoundingClientRect()
      const runRect = card.querySelector('.node-run-btn')?.getBoundingClientRect()
      return runRect ? cardRect.right - runRect.right : Number.POSITIVE_INFINITY
    })
    assert.ok(headerAlignment <= 4, '运行按钮必须贴齐节点右上角')

    // 两个已连接节点分组后，数据边必须继续存在。
    await source.locator('.node-card').click()
    await destination.locator('.node-card').click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: '打组', exact: true }).click()
    await page.locator('.canvas-group-outline').waitFor()
    assert.ok(await page.locator('.data-edge').count(), '分组后应保留真实数据边')
    const readGroupGeometry = () =>
      page.evaluate(() => {
        const group = document.querySelector('.canvas-group-outline')
        const cards = Array.from(document.querySelectorAll('.node-card-wrap:has(.type-text)'))
        if (!group || cards.length < 2) return null
        const groupRect = group.getBoundingClientRect()
        const cardRects = cards.map((card) => card.getBoundingClientRect())
        const minLeft = Math.min(...cardRects.map((rect) => rect.left))
        return {
          zoom: Number(getComputedStyle(group).getPropertyValue('--group-zoom')),
          horizontalPadding: minLeft - groupRect.left
        }
      })
    const groupBeforeZoom = await readGroupGeometry()
    await page.getByRole('button', { name: '缩小', exact: true }).click()
    await page.waitForTimeout(280)
    const groupAfterZoom = await readGroupGeometry()
    assert.ok(groupBeforeZoom && groupAfterZoom, '分组线框应保留可读的几何信息')
    assert.ok(groupAfterZoom.zoom < groupBeforeZoom.zoom, '分组线框必须感知画布缩小')
    assert.ok(
      groupAfterZoom.horizontalPadding < groupBeforeZoom.horizontalPadding,
      '分组边距必须随缩放同比缩小，不能在缩小时拉成细长框'
    )
    await page.getByRole('button', { name: '切换为浅色画布', exact: true }).click()
    await destination.getByRole('button', { name: '打开节点说明' }).click()
    await page.getByRole('tab', { name: '输入输出', exact: true }).click()
    const colors = await page
      .locator('.node-contract-panel textarea')
      .first()
      .evaluate((el) => ({
        bg: getComputedStyle(el).backgroundColor,
        text: getComputedStyle(el).color
      }))
    assert.equal(colors.bg, 'rgb(255, 255, 255)')
    assert.equal(colors.text, 'rgb(24, 33, 45)')
    assert.equal(
      await page
        .locator('.node-seq')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
      'rgb(229, 57, 53)'
    )
    // P1-2 回归（QA-NODE-AUDIT-2026-09-06）：运行中心打开时，节点详情请求必须
    // 收口侧栏并打开详情面板，而不是被静默忽略。
    await page.getByRole('button', { name: '打开运行中心', exact: true }).click()
    await page.locator('.side-panel').waitFor()
    await page.locator('.node-card-wrap:has(.type-text)').first().locator('.node-info-btn').click()
    await page.locator('.node-contract-panel').waitFor()
    assert.equal(await page.locator('.side-panel').count(), 0, '运行中心必须被节点详情请求收口')
    // 后加的节点可能落在相机之外：tldraw 用 transform 平移画布，DOM 不会滚动，
    // Playwright 的 scrollIntoView 因此无效，点击会被 tl-background 截获。所以先适配
    // 画布，再在卡片内现算一个非控件落点单击（固定偏移在放大后会压到运行按钮和模型
    // 芯片，而 .node-header-spacer 在样式里是 display:none，都不能当靶子）。
    // 找落点要重试：相机动画 220ms，且 tldraw 在每次按下后临时铺一层
    // .tl-hit-test-blocker，抢在窗口里探测会 20 个点全部命中遮挡层、误判成“没有可点区”。
    const findNeutralCardPoint = async (wrap) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const point = await wrap.evaluate((el) => {
          const card = el.querySelector('.node-card')
          const rect = card.getBoundingClientRect()
          // 卡片正文带 data-node-interactive 是允许的：单击由卡片承接为选中，双击才编辑。
          const isControl = (node) =>
            !!node.closest(
              'button, input, select, textarea, [contenteditable="true"], [class*="btn"], [class*="run"]'
            )
          for (const fy of [0.5, 0.65, 0.8, 0.35]) {
            for (const fx of [0.5, 0.6, 0.4, 0.7, 0.3]) {
              const x = Math.round(rect.x + rect.width * fx)
              const y = Math.round(rect.y + rect.height * fy)
              const hit = document.elementFromPoint(x, y)
              if (hit && card.contains(hit) && !isControl(hit)) return { x, y }
            }
          }
          return null
        })
        if (point) return point
        await page.waitForTimeout(150)
      }
      assert.fail('卡片内必须存在可单击的中性区域')
    }
    const clickNeutralCardPoint = async (wrap) => {
      const point = await findNeutralCardPoint(wrap)
      await page.mouse.click(point.x, point.y)
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '添加对话节点', exact: true }).click()
    const chatCard = page.locator('.node-card-wrap:has(.type-chat)').first()
    await chatCard.waitFor()
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await page.waitForTimeout(260)
    // P2-2 回归（QA-NODE-AUDIT-2026-09-06）：单选对话节点必须自动打开右侧聊天面板，
    // 由 CanvasEditor 里监听选中变化的 store listener 实现。新建节点不算选中，所以下面
    // 的单击才是第一次选中；关掉面板、改选别的节点、再选回来，能证明弹面板确实由
    // “选中变化”触发，而不是建节点或刷新时的残留。
    await clickNeutralCardPoint(chatCard)
    assert.match(await chatCard.getAttribute('class'), /is-selected/, '单击卡片必须选中节点')
    await page.locator('.chat-side-panel').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.chat-side-panel').waitFor({ state: 'detached' })
    await clickNeutralCardPoint(page.locator('.node-card-wrap:has(.type-text)').first())
    await clickNeutralCardPoint(chatCard)
    await page.locator('.chat-side-panel').waitFor()
    // 收口再刷新：面板展开时盖住画布右侧，后面所有按视口坐标操作的回归都会被它吞掉。
    await page.keyboard.press('Escape')
    await page.locator('.chat-side-panel').waitFor({ state: 'detached' })
    await page.reload()
    // 刷新后相机回到默认机位，视口外的卡片被 tldraw 剔除成 0×0 的隐藏 wrapper，
    // `.node-card-wrap` 的 first() 可能就是它们，所以要先适配画布再按“真正渲染出来”
    // 的卡片数量判定（顺带复验 P1-1：卡片不得顶进顶栏）。
    await page
      .getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true })
      .waitFor()
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    await assertCardsClearOfTopbar(2)
    assert.ok(await page.locator('.node-card-wrap').count(), '刷新浏览器演示页不能丢失画布节点')
    // 刷新会保留选中态，对话节点因此可能又自动弹出面板；同样收口后再继续。
    await page.keyboard.press('Escape')
    await page.locator('.chat-side-panel').waitFor({ state: 'detached' })
    const persistedMedia = await page.evaluate(async () => {
      const media = await window.api.listMedia('demo')
      const source = media.ok ? media.data.find((item) => item.kind === 'image') : undefined
      if (!source) return { ok: false, message: '刷新后找不到已导入图片' }
      const crop = await window.api.cropImage({
        projectId: 'demo',
        sourceMediaId: source.id,
        config: {
          version: 1,
          mode: 'rect',
          aspectRatio: 'free',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
            { x: 1, y: 1 }
          ]
        }
      })
      return crop.ok ? { ok: true, message: '' } : { ok: false, message: crop.error.message }
    })
    assert.deepEqual(persistedMedia, { ok: true, message: '' }, '刷新后媒体资产仍应能继续裁剪')
    // 批量删除回归：框选/多选节点时，隐藏的 carrier arrow 不能抢走第一次 Delete。
    const textCards = page.locator('.node-card-wrap:has(.type-text)')
    const initialTextCount = await textCards.count()
    await page.getByRole('button', { name: '添加文本节点', exact: true }).click()
    await page.getByRole('button', { name: '添加文本节点', exact: true }).click()
    await page.waitForFunction(
      (count) => document.querySelectorAll('.node-card-wrap:has(.type-text)').length === count + 2,
      initialTextCount
    )
    // 重载后的相机可能仍停在上一处工作区；先适配全部节点，确保回归测试实际拖到
    // 可见的外置端口，而不是把空的视口坐标误判成端口命中失败。
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    // 候选配对按横向位置从左到右、从最远的目标开始试：两张新建卡可能叠在同一处（端口被
    // 对方卡片压住就拖不动），所以「哪两张卡来做回归」不能写死 DOM 下标也不能写死新建对，
    // 只能现场验证「这两个端口都可命中、而且这一拖真的产出了一条线」。
    const textCardRects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.node-card-wrap:has(.type-text)'))
        .map((c) => {
          const r = c.getBoundingClientRect()
          return { id: c.getAttribute('data-node-id'), x: r.x, w: r.width }
        })
        .filter((c) => c.w > 40)
        .sort((p, q) => p.x - q.x)
    )
    assert.ok(textCardRects.length >= 2, '批量删除回归需要至少两张已渲染的文本卡片')
    const cardWrap = (id) => page.locator(`.node-card-wrap[data-node-id="${id}"]`)
    const candidates = []
    textCardRects.forEach((from, i) => {
      for (let j = textCardRects.length - 1; j > i; j--) candidates.push([from.id, textCardRects[j].id])
    })
    const edgeCountBeforeConnectForDelete = await page.locator('.data-edge').count()
    let connectedPair = null
    for (const [fromId, toId] of candidates) {
      const out = await portHitBox(cardWrap(fromId).locator('.port-dot.out'))
      const into = await portHitBox(cardWrap(toId).locator('.port-dot.in'))
      if (!out || !into) continue
      await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2)
      await page.mouse.down()
      // tldraw 需先处理 pointerdown 才会进入端口连线态；没有这小段等待时，CI 或高负载
      // 机器偶尔会把紧随的第一帧移动当成普通画布拖动，造成假阴性的删除回归。
      await page.waitForTimeout(120)
      await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 20 })
      await page.mouse.up()
      const connected = await page
        .waitForFunction(
          (count) => document.querySelectorAll('.data-edge').length > count,
          edgeCountBeforeConnectForDelete,
          { timeout: 2_000 }
        )
        .then(
          () => true,
          () => false
        )
      if (connected) {
        connectedPair = [fromId, toId]
        break
      }
    }
    assert.ok(
      connectedPair,
      `批量删除回归要先连出一条线：${candidates.length} 组候选端口配对都没能建立连线`
    )
    const deleteSource = cardWrap(connectedPair[0])
    const deleteTarget = cardWrap(connectedPair[1])
    const edgeCountBeforeDelete = await page.locator('.data-edge').count()
    // 「一次 Delete 删掉整批」的前提是两张卡都真的在选中态里，所以先把选中态确认到位再按
    // Delete。实测（2026-09-19，11/11）：自动化里紧接普通单击之后的第一次 Shift 单击会落空
    // ——选中态仍只有第一张卡——再发一次一模一样的 Shift 单击就能加选成功；中间等 260ms、
    // 700ms 或先 hover 都不能救回第一次，可见它是「那一次按下没被识别成 Shift 加选」而不是
    // 「发得太快」。门禁不该把这种落空当失败，也不该把它当常态，所以按选中态断言重试，
    // 三次仍选不齐才报错。
    const bothSelected = () =>
      page
        .waitForFunction(
          () => {
            const picked = [...document.querySelectorAll('.node-card-wrap.is-selected')]
            return picked.length === 2 && picked.every((c) => c.querySelector('.type-text'))
          },
          undefined,
          { timeout: 1_500 }
        )
        .then(
          () => true,
          () => false
        )
    await deleteSource.locator('.node-card').click({ position: { x: 120, y: 80 } })
    let bothPicked = false
    for (let attempt = 0; attempt < 3 && !bothPicked; attempt++) {
      await deleteTarget
        .locator('.node-card')
        .click({ position: { x: 120, y: 80 }, modifiers: ['Shift'] })
      bothPicked = await bothSelected()
    }
    assert.ok(
      bothPicked,
      `批量删除回归要先选中两张卡：Shift 加选重试 3 次后选中态仍未同时包含 ${connectedPair.join(
        ' 和 '
      )}`
    )
    await page.keyboard.press('Delete')
    await page.waitForFunction(
      (count) => document.querySelectorAll('.node-card-wrap:has(.type-text)').length === count,
      initialTextCount
    )
    await page.waitForFunction(
      (count) => document.querySelectorAll('.data-edge').length < count,
      edgeCountBeforeDelete,
      { timeout: 5_000 }
    )
    assert.ok(
      (await page.locator('.data-edge').count()) < edgeCountBeforeDelete,
      '删除节点时必须在同一次操作中清理关联连线'
    )
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT })
    console.log(
      'PASS: image double-click preview, browser crop/split/model generation, outside solid-color ports, refresh persistence and crop, zoom-stable grouping, light inspector, sequence color, topbar clearance, run-center/contract handoff, chat select-to-open, one-key batch node delete'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
