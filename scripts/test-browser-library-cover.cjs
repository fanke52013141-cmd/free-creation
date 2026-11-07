/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')

;(async () => {
  const browser = await launchQaBrowser({ ignoreDefaultArgs: ['--hide-scrollbars'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForFunction(() => Boolean(window.api))
    await page.evaluate(async () => {
      const svgs = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="white"/><rect x="20" y="25" width="50" height="110" fill="red"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect x="20" y="25" width="50" height="110" fill="red"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="90"><rect width="300" height="90" fill="blue"/></svg>'
      ]
      const resources = svgs.map((svg, index) => ({
        id: `r${index}`, title: ['白底竖图', '透明竖图', '宽图'][index], iconKind: 'image',
        coverPath: 'data:image/svg+xml,' + encodeURIComponent(svg), formPreset: 'custom',
        latestRevisionId: 'v2', revisionNumber: 2, componentCount: 1,
        tags: [], collectionIds: [], folderIds: [], updatedAt: 100
      }))
      window.__coverRequests = []
      window.api.listLibraryCategories = async () => ({ ok: true, data: [] })
      window.api.searchLibrary = async () => ({ ok: true, data: { items: resources, nextCursor: null } })
      window.api.getLibraryResource = async ({ resourceId, revisionId }) => {
        window.__coverRequests.push(revisionId || 'latest')
        const resource = resources.find((item) => item.id === resourceId)
        return { ok: true, data: { ...resource, selectedTitle: resource.title,
          selectedRevisionId: revisionId || 'v2', selectedRevisionNumber: revisionId === 'v1' ? 1 : 2,
          components: [], revisions: [{ id: 'v2', revisionNumber: 2, createdAt: 100 }, { id: 'v1', revisionNumber: 1, createdAt: 90 }] } }
      }
    })
    await page.getByRole('button', { name: '打开资产管理', exact: true }).click()
    await page.locator('.assets-panel').getByRole('button', { name: '资源库', exact: true }).click()
    const compact = page.locator('.library-card-cover-compact').first()
    await compact.locator('img').waitFor()
    await compact.locator('img').evaluate((img) => img.decode())
    const compactGeometry = await compact.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const img = el.querySelector('img').getBoundingClientRect()
      return { boxWidth: box.width, boxHeight: box.height, imgWidth: img.width, imgHeight: img.height }
    })
    assert.ok(Math.abs(compactGeometry.boxWidth / compactGeometry.boxHeight - 16 / 9) < 0.02, `侧栏封面保持 16:9: ${JSON.stringify(compactGeometry)}`)
    assert.ok(Math.abs(compactGeometry.imgWidth / compactGeometry.imgHeight - 9 / 16) < 0.01, '侧栏完整显示竖图')
    assert.ok(Math.abs(compactGeometry.imgHeight - compactGeometry.boxHeight) < 1, '竖图适应封面高度')
    await page.evaluate(async () => { (await import('/src/stores/app.ts')).useAppStore.getState().setHome() })
    await page.getByRole('button', { name: '资源库', exact: true }).click()
    const covers = page.locator('.library-resource-cover')
    await covers.first().locator('img').waitFor()
    await page.locator('.library-resource-cover img').evaluateAll(async (images) => Promise.all(images.map((image) => image.decode())))
    for (let i = 0; i < 3; i++) {
      const geometry = await covers.nth(i).evaluate((cover) => {
        const box = cover.getBoundingClientRect()
        const img = cover.querySelector('img').getBoundingClientRect()
        return { width: box.width, height: box.height, imgWidth: img.width, imgHeight: img.height,
          x: img.left - box.left, y: img.top - box.top }
      })
      assert.ok(Math.abs(geometry.width / geometry.height - 16 / 9) < 0.01)
      assert.ok(Math.abs(geometry.imgWidth / geometry.imgHeight - (i === 2 ? 300 / 90 : 9 / 16)) < 0.01)
      assert.ok(Math.abs(geometry.x + geometry.imgWidth / 2 - geometry.width / 2) < 1)
      assert.ok(Math.abs(geometry.y + geometry.imgHeight / 2 - geometry.height / 2) < 1)
      if (i < 2) {
        const screenshot = (await covers.nth(i).screenshot()).toString('base64')
        const colors = await page.evaluate(async ({ screenshot, x, y }) => {
          const image = new Image()
          image.src = `data:image/png;base64,${screenshot}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.width; canvas.height = image.height
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
          const pixel = (px, py) => [...context.getImageData(px, py, 1, 1).data].slice(0, 3)
          return [pixel(10, 10), pixel(Math.ceil(x) + 3, Math.ceil(y) + 3), pixel(Math.ceil(x) + 11, Math.ceil(y) + 3)]
        }, { screenshot, x: geometry.x, y: geometry.y })
        assert.deepEqual(colors[0], [255, 255, 255], '竖图两侧留白为白色')
        if (i === 0) assert.deepEqual(colors[1], colors[2], '不透明白底保持白色')
        else assert.notDeepEqual(colors[1], colors[2], '透明区域显示棋盘格')
      }
    }
    await page.getByRole('button', { name: '白底竖图', exact: true }).click()
    const detail = page.getByRole('dialog', { name: '资源详情' })
    await detail.getByRole('group', { name: '资源版本历史' }).waitFor()
    assert.equal(await detail.getByText('比较两个版本').count(), 0)
    assert.equal(await detail.locator('.library-version-entry').count(), 2)
    assert.deepEqual(await page.evaluate(() => window.__coverRequests), ['v2'])
    await detail.locator('.library-version-entry').nth(1).click()
    await page.waitForFunction(() => document.querySelector('.library-version-entry.selected strong')?.textContent === '1.0')
    assert.deepEqual(await page.evaluate(() => window.__coverRequests), ['v2', 'v1'])
    await detail.getByRole('button', { name: '关闭' }).click()
    await page.evaluate(() => {
      window.__exportedIds = []
      window.__deletedIds = []
      window.api.exportLibrary = async ({ resourceIds }) => {
        window.__exportedIds = resourceIds
        return { ok: true, data: { path: 'fixture' } }
      }
      const search = window.api.searchLibrary
      window.api.searchLibrary = async (input) => {
        const result = await search(input)
        result.data.items = result.data.items.filter((item) => !window.__deletedIds.includes(item.id))
        return result
      }
      window.api.deleteLibraryResource = async ({ resourceId }) => {
        if (resourceId === 'r1') return { ok: false, error: { code: 'DELETE_FAILED', message: 'fixture' } }
        window.__deletedIds.push(resourceId)
        return { ok: true, data: true }
      }
    })
    await page.getByRole('button', { name: '批量管理', exact: true }).click()
    await page.getByRole('button', { name: '白底竖图', exact: true }).click()
    await page.getByRole('button', { name: '宽图', exact: true }).click({ modifiers: ['Shift'] })
    assert.equal(await page.locator('.library-resource-card[aria-pressed=true]').count(), 3)
    await page.getByRole('button', { name: '取消全选', exact: true }).click()
    assert.equal(await page.locator('.library-resource-card[aria-pressed=true]').count(), 0)
    await page.getByRole('button', { name: '全选', exact: true }).click()
    await page.getByRole('button', { name: '批量导出', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__exportedIds), ['r0', 'r1', 'r2'])
    await page.getByRole('button', { name: '批量删除', exact: true }).click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.__deletedIds), [])
    await page.getByRole('button', { name: '批量删除', exact: true }).click()
    await page.getByRole('button', { name: '删除所选', exact: true }).click()
    await page.getByText('已删除 2 项，1 项删除失败').waitFor()
    assert.equal(await page.getByRole('button', { name: '透明竖图', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.evaluate(() => {
      const search = window.api.searchLibrary
      window.api.searchLibrary = async (input) => {
        const result = await search(input)
        const fixture = result.data.items[0]
        result.data.items = Array.from({ length: 30 }, (_, i) => ({ ...fixture, id: `scroll-${i}` }))
        return result
      }
    })
    await page.getByRole('textbox', { name: '搜索资源' }).fill('长列表')
    await page.locator('.library-resource-card').nth(29).waitFor({ state: 'attached' })
    const grid = page.locator('.library-resource-browser')
    const scrollbar = await grid.evaluate((element) => ({
      gutter: element.offsetWidth - element.clientWidth,
      overflow: element.scrollHeight > element.clientHeight,
      hidden: getComputedStyle(element, '::-webkit-scrollbar').display === 'none'
    }))
    assert.ok(scrollbar.overflow && scrollbar.gutter > 0 && !scrollbar.hidden, JSON.stringify(scrollbar))
    const box = await grid.boundingBox()
    const thumbX = box.x + box.width - scrollbar.gutter / 2
    await page.mouse.move(thumbX, box.y + 50)
    await page.mouse.down()
    await page.mouse.move(thumbX, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    assert.ok(await grid.evaluate((element) => element.scrollTop > 0), '可拖动滚动条快速浏览')
    console.log('PASS library covers, version history, batch selection/export/delete and scrollbar')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
