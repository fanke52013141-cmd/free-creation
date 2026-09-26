/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Browser regression: real React/tldraw, isolated in-memory IPC fixtures. Persistence is tested separately with SQLite.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const origin = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5202'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42nP4z3D4PwQGAQ8Ai/1+GQAAAABJRU5ErkJggg==', 'base64')

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }))
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } })
    page.setDefaultTimeout(15000)
    await page.goto(origin)
    await page.waitForFunction(() => Boolean(window.api))
    await page.evaluate(async () => {
      const categories = []
      const resources = []
      window.api.listLibraryCategories = async () => ({ ok: true, data: categories })
      window.api.saveLibraryCategory = async ({ category }) => {
        const index = categories.findIndex((item) => item.id === category.id)
        if (index >= 0) categories[index] = structuredClone(category)
        else categories.push(structuredClone(category))
        return { ok: true, data: category }
      }
      window.api.searchLibrary = async ({ categoryId }) => ({ ok: true, data: { items: resources.filter((item) => !categoryId || item.category.id === categoryId), nextCursor: null } })
      window.api.createLibraryResource = async (input) => {
        const category = structuredClone(categories.find((item) => item.id === input.category.id))
        const components = input.components.map((item, index) => ({ ...item, id: `component-${index}`, order: index,
          ...(item.data ? { blobPath: `data:${item.mime};base64,${btoa(String.fromCharCode(...item.data))}` } : {}) }))
        const resource = { ...input, id: 'test-resource', category, components, componentCount: components.length,
          latestRevisionId: 'revision-1', selectedRevisionId: 'revision-1', revisionNumber: 1, selectedRevisionNumber: 1,
          selectedTitle: input.title, selectedDescription: input.description, updatedAt: Date.now(),
          revisions: [{ id: 'revision-1', revisionNumber: 1, title: input.title, createdAt: Date.now() }],
          coverPath: components.find((item) => item.valueType === 'image')?.blobPath }
        resources.push(resource)
        return { ok: true, data: resource }
      }
      window.api.getLibraryResource = async () => ({ ok: true, data: resources[0] ?? null })
      window.api.materializeLibraryResource = async (input) => {
        const components = resources[0].components.filter((item) => input.componentIds.includes(item.id))
        const componentAssets = components.filter((item) => item.blobPath).map((item) => ({ componentId: item.id,
          asset: { id: `media-${crypto.randomUUID()}`, name: item.fileName, path: item.blobPath, kind: item.valueType, mime: item.mime, sizeBytes: item.data.length, createdAt: Date.now() } }))
        return { ok: true, data: { usageId: crypto.randomUUID(), componentAssets, assets: componentAssets.map((item) => item.asset), textComponents: components.filter((item) => item.text !== undefined) } }
      }
      window.api.discardLibraryMaterialization = async () => ({ ok: true, data: true })
      const { useAppStore } = await import('/src/stores/app.ts')
      useAppStore.getState().setHome()
    })
    await page.getByRole('button', { name: '资源库', exact: true }).click()
    await page.getByRole('button', { name: '新建分类', exact: true }).click()
    const category = page.getByRole('dialog', { name: '资源分类编辑器' })
    await category.getByLabel('分类名称', { exact: true }).fill('品牌角色卡')
    await category.getByLabel('展示样式').selectOption('profile')
    await category.getByLabel('内容名称', { exact: true }).fill('形象')
    await category.getByLabel('必填', { exact: true }).check()
    await category.getByRole('button', { name: '添加节点槽位' }).click()
    await category.getByLabel('内容名称', { exact: true }).nth(1).fill('描述')
    await category.getByLabel('映射到节点').nth(1).selectOption('text')
    await category.getByLabel('允许多项').nth(1).uncheck()
    mkdirSync('artifacts/library-blueprint-ui', { recursive: true })
    await page.screenshot({ path: 'artifacts/library-blueprint-ui/category.png', fullPage: true })
    await category.getByRole('button', { name: '保存分类', exact: true }).click()
    await category.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '新建资源', exact: true }).click()
    const form = page.getByRole('dialog', { name: '新建资源', exact: true })
    await form.getByLabel('资源名称', { exact: true }).fill('林青')
    await form.locator('.library-slot-row input[type=file]').setInputFiles([
      { name: 'front.png', mimeType: 'image/png', buffer: png }, { name: 'side.png', mimeType: 'image/png', buffer: png }
    ])
    await form.getByRole('button', { name: '添加正文' }).click()
    await form.locator('.library-component-text').fill('修长的红眼树蛙，绿色皮肤。')
    await page.screenshot({ path: 'artifacts/library-blueprint-ui/resource.png', fullPage: true })
    await form.getByRole('button', { name: '保存资源', exact: true }).click()
    await form.waitFor({ state: 'hidden' })
    const detail = page.getByRole('dialog', { name: '资源详情' })
    await detail.waitFor()
    await detail.getByRole('button', { name: '打开画布并创建节点' }).click()
    const preview = page.getByRole('dialog', { name: '加入资源节点' })
    await preview.waitFor()
    await preview.getByRole('button', { name: '创建节点', exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
    const inspect = () => page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const editor = useEditorStore.getState().editor
      const shapes = editor.getCurrentPageShapes()
      return shapes.filter((item) => item.type === 'node-card' && item.meta.librarySource).map((item) => ({
        type: item.props.nodeType, title: item.props.title, text: item.props.text, source: item.meta.librarySource, parentId: item.parentId
      }))
    })
    const nodes = await inspect()
    assert.equal(nodes.length, 3)
    assert.deepEqual(nodes.map((item) => item.type), ['image', 'image', 'text'])
    assert.equal(nodes[2].text, '修长的红眼树蛙，绿色皮肤。')
    assert.equal(new Set(nodes.map((item) => item.parentId)).size, 1)
    assert.equal(new Set(nodes.map((item) => item.source.instanceId)).size, 1)
    await page.screenshot({ path: 'artifacts/library-blueprint-ui/canvas.png', fullPage: true })
    await page.evaluate(async () => { const { useEditorStore } = await import('/src/stores/editor.ts'); useEditorStore.getState().editor.undo() })
    assert.equal((await inspect()).length, 0, 'one undo removes the whole group')
    await page.evaluate(async () => { const { useEditorStore } = await import('/src/stores/editor.ts'); useEditorStore.getState().editor.redo() })
    assert.equal((await inspect()).length, 3, 'redo restores all content')
    console.log('PASS: custom category -> resource with two images and text -> real grouped nodes -> one undo/redo')
  } finally { await browser.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
