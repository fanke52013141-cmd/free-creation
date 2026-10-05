/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1850, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { createEdge } = await import('/src/canvas/graph.ts')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const image =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#5b9c76"/><circle cx="200" cy="240" r="120" fill="#eed5a2"/><path d="M0 800L200 400L400 800" fill="#364763"/></svg>'
        )
      for (const [i, type] of ['image', 'image-crop', 'image-split', 'image-gen'].entries())
        editor.createShape({
          id: `shape:flex-${type}`,
          type: 'node-card',
          x: 220 + i * 390,
          y: 80,
          props: {
            nodeType: type,
            title: type,
            ...(type === 'image'
              ? { mediaId: 'portrait', mediaPath: image, mediaMime: 'image/svg+xml' }
              : {})
          }
        })
      for (const type of ['image-crop', 'image-split', 'image-gen'])
        createEdge(
          editor,
          { shapeId: 'shape:flex-image', portId: 'out-image' },
          { shapeId: `shape:flex-${type}`, portId: type === 'image-gen' ? 'in-images' : 'in-image' }
        )
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      editor.selectNone()
    })
    await page.waitForTimeout(800)
    const output = `qa/node-flexible-${Date.now()}`
    fs.mkdirSync(output, { recursive: true })
    const inspect = () =>
      page.locator('.node-card').evaluateAll((cards) =>
        cards.map((card) => {
          const r = card.getBoundingClientRect(),
            scroll = card.querySelector('.node-standard-scroll'),
            prompt = card.querySelector('.gen-prompt'),
            button = card.querySelector('.node-standard-action-bar button')
          return {
            type: card.dataset.nodeType,
            h: r.height,
            overflow: scroll.scrollHeight - scroll.clientHeight,
            description: card.querySelectorAll('.node-standard-description').length,
            buttons: [...card.querySelectorAll('.node-standard-action-bar button')].map((b) =>
              b.textContent.trim()
            ),
            prompt: prompt && {
              w: prompt.getBoundingClientRect().width,
              h: prompt.getBoundingClientRect().height,
              gap: button.getBoundingClientRect().top - prompt.getBoundingClientRect().bottom
            },
            bottom: button && r.bottom - button.getBoundingClientRect().bottom
          }
        })
      )

    let layout = await inspect()
    fs.writeFileSync(`${output}/geometry.json`, JSON.stringify(layout, null, 2))
    await page.screenshot({ path: `${output}/dark.png` })
    for (const node of layout) {
      assert.equal(node.description, 0)
      assert.ok(!node.buttons.some((t) => /^配置(图片|裁剪|拆分)$/.test(t)))
      if (node.type !== 'image-gen') {
        assert.equal(node.h, 260)
        assert.ok(node.overflow <= 1, JSON.stringify(node))
      }
      if (node.bottom !== null) assert.ok(Math.abs(node.bottom - 8) < 1.1, JSON.stringify(node))
    }
    const gen = layout.find((n) => n.type === 'image-gen')
    assert.equal(gen.h,320,'实际引用在默认高度上增加空间')
    assert.ok(gen.prompt.w >= 314)
    assert.ok(gen.prompt.h > 72)
    assert.ok(Math.abs(gen.prompt.gap - 8) < 1.1, JSON.stringify(gen))
    for (const zoom of [0.75, 1.5, 1]) {
      await page.evaluate(
        async (zoom) =>
          void (await import('/src/stores/editor.ts')).useEditorStore
            .getState()
            .editor.setCamera({ x: 0, y: 0, z: zoom }, { immediate: true }),
        zoom
      )
      await page.waitForTimeout(120)
      const tiles = await page
        .locator('[data-node-type="image-split"] .image-split-canvas')
        .evaluateAll((els) =>
          els.map((el) => {
            const a = el.getBoundingClientRect(),
              b = el.parentElement.getBoundingClientRect()
            return {
              left: a.left - b.left,
              top: a.top - b.top,
              right: b.right - a.right,
              bottom: b.bottom - a.bottom
            }
          })
        )
      for (const tile of tiles)
        assert.ok(
          Object.values(tile).every((value) => value >= -0.6),
          JSON.stringify({ zoom, tile })
        )
    }
    const image = page.locator('[data-node-type="image"]')
    for (const label of ['裁剪', '拆分', '生图', 'P图', '生视频', '替换'])
      assert.ok((await image.textContent()).includes(label))
    await image.getByRole('button', { name: '创建图片拆分节点并连接当前图片', exact: true }).click()
    assert.equal(await page.locator('[data-node-type="image-split"]').count(), 2)
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({
        id: 'shape:flex-image-gen',
        type: 'node-card',
        props: { h: 440 },
        meta: { nodeHeightMode: 'manual' }
      })
    })
    await page.waitForTimeout(300)
    layout = await inspect()
    assert.ok(layout.find((n) => n.type === 'image-gen').prompt.h > gen.prompt.h + 100)
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({id:'shape:flex-image-gen',type:'node-card',meta:{nodeHeightMode:'auto'}})
      editor.deleteShape('shape:flex-image')
      document.querySelectorAll('.canvas-host,.canvas-page').forEach((el) => {
        el.classList.remove('canvas-theme-dark')
        el.classList.add('canvas-theme-light')
      })
    })
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-node-type="image-gen"] .connected-inputs').count(), 0)
    assert.equal((await inspect()).find(n=>n.type==='image-gen').h,260,'移除引用后恢复默认高度')
    await page.screenshot({ path: `${output}/light-no-reference.png` })
    // 已有视频只能提供缩略预览，竖屏固有比例不得触发自动高度或滚动。
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      for (const [i, type] of ['video-asset', 'video'].entries())
        editor.createShape({
          id: `shape:flex-${type}`,
          type: 'node-card',
          x: 220 + i * 390,
          y: 80,
          props: { nodeType: type, mediaPath: 'portrait-preview.mp4' }
        })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    })
    await page.waitForTimeout(500)
    // React 挂载后设置真实竖屏 poster，触发媒体尺寸测量。
    await page.locator('.video-thumbnail-wrap video').evaluateAll((videos) => {
      for (const video of videos)
        video.poster = 'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#345069"/></svg>'
        )
    })
    await page.waitForTimeout(300)
    const videos = await page.locator('.node-card:is(.type-video-asset,.type-video)').evaluateAll((nodes) =>
      nodes.map((node) => {
        const scroll = node.querySelector('.node-standard-scroll')
        return { height: node.getBoundingClientRect().height, scroll: scroll.scrollHeight, client: scroll.clientHeight }
      })
    )
    assert.equal(videos.length, 2)
    for (const video of videos) {
      assert.equal(video.height, 260)
      assert.ok(video.scroll <= video.client + 1, JSON.stringify(video))
    }
    console.log(
      `按需说明、零/多动作、260px 预览无滚动、真实后续连线、输入框填满与 8px 间距通过：${output}`
    )
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
