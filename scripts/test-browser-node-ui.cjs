/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Requires the browser dev server; uses an isolated profile and never edits desktop projects.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

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
    await page.goto('http://127.0.0.1:5173/')
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
    // P1-1 回归（QA-NODE-AUDIT-2026-09-06）：新建节点必须整体落在顶栏之下，
    // 否则卡片标题行的运行/说明按钮会被顶栏截获命中而不可点。
    const assertCardsClearOfTopbar = async () => {
      const topbarBottom = await page.evaluate(() => {
        const bar = document.querySelector('.canvas-topbar')
        return bar ? bar.getBoundingClientRect().bottom : 0
      })
      await page.waitForFunction(
        (minY) =>
          Math.min(
            ...Array.from(document.querySelectorAll('.node-card-wrap')).map(
              (c) => c.getBoundingClientRect().top
            )
          ) >= minY,
        topbarBottom
      )
    }
    await assertCardsClearOfTopbar()
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    const splitNode = page.locator('.node-card-wrap:has(.type-image-split)').first()
    await splitNode.waitFor()
    assert.match(await splitNode.innerText(), /连接原图/)
    assert.equal(
      await splitNode.locator('.image-split-quick-controls').count(),
      1,
      '图片拆分的行列与面积必须直接显示在节点内'
    )
    assert.equal(
      await splitNode.getByRole('button', { name: '快速拆分', exact: true }).count(),
      1,
      '图片拆分必须提供节点内快速执行入口'
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
    await assertCardsClearOfTopbar()
    await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
    const nodes = page.locator('.node-card-wrap:has(.type-text)')
    assert.equal(await nodes.count(), 2)
    const source = nodes.first()
    const destination = nodes.last()
    await source.locator('.node-card').click({ position: { x: 120, y: 100 } })
    assert.match(await source.getAttribute('class'), /is-selected/)
    const before = await source.boundingBox()
    const a = await source.locator('.port-dot.out').boundingBox()
    const b = await destination.locator('.port-dot.in').boundingBox()
    const sourceRect = await source.boundingBox()
    const destinationRect = await destination.boundingBox()
    assert.equal(
      await source.locator('.port-dot.out').evaluate((port) => getComputedStyle(port).width),
      '18px',
      '端口需要是更大的可命中圆环'
    )
    assert.ok(a.x >= sourceRect.x + sourceRect.width, '输出端口必须完整位于节点外侧')
    assert.ok(b.x + b.width <= destinationRect.x, '输入端口必须完整位于节点外侧')
    assert.equal(
      await source.locator('.port-dot.out').evaluate((port) => getComputedStyle(port).borderStyle),
      'dashed'
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
    // P2-2 回归：选中对话节点即打开右侧对话面板（与卡片空态文案一致）。
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '添加对话节点', exact: true }).click()
    const chatCard = page.locator('.node-card-wrap:has(.type-chat)').first()
    await chatCard.waitFor()
    await chatCard.locator('.node-card').click({ position: { x: 120, y: 60 } })
    await page.locator('.chat-side-panel').waitFor()
    await page.reload()
    await page.locator('.node-card-wrap').first().waitFor()
    assert.ok(await page.locator('.node-card-wrap').count(), '刷新浏览器演示页不能丢失画布节点')
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
    await page.waitForTimeout(260)
    const deleteSource = textCards.nth(initialTextCount)
    const deleteTarget = textCards.nth(initialTextCount + 1)
    await deleteSource.locator('.port-dot.out').waitFor({ state: 'visible' })
    await deleteTarget.locator('.port-dot.in').waitFor({ state: 'visible' })
    const deleteOut = await deleteSource.locator('.port-dot.out').boundingBox()
    const deleteIn = await deleteTarget.locator('.port-dot.in').boundingBox()
    assert.ok(deleteOut && deleteIn, '批量删除回归必须从两个可见的外置端口建立连线')
    const edgeCountBeforeConnectForDelete = await page.locator('.data-edge').count()
    await page.mouse.move(deleteOut.x + deleteOut.width / 2, deleteOut.y + deleteOut.height / 2)
    await page.mouse.down()
    await page.mouse.move(deleteIn.x + deleteIn.width / 2, deleteIn.y + deleteIn.height / 2, {
      steps: 12
    })
    await page.mouse.up()
    await page.waitForFunction(
      (count) => document.querySelectorAll('.data-edge').length > count,
      edgeCountBeforeConnectForDelete
    )
    const edgeCountBeforeDelete = await page.locator('.data-edge').count()
    await deleteSource.locator('.node-card').click({ position: { x: 120, y: 80 } })
    await deleteTarget
      .locator('.node-card')
      .click({ position: { x: 120, y: 80 }, modifiers: ['Shift'] })
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
      'PASS: image double-click preview, browser crop/split/model generation, external dashed ports, refresh persistence and crop, zoom-stable grouping, light inspector, sequence color, topbar clearance, run-center/contract handoff, chat select-to-open, one-key batch node delete'
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
