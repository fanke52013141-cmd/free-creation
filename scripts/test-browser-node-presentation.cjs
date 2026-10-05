/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Browser mock only; no real projects or model requests.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  fs.mkdirSync('qa/node-presentation', { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5173')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.createShapes([
        { id: 'shape:qa-text', type: 'node-card', x: 100, y: 100, props: { nodeType: 'text', text: '你好呀，朋友', title: '文本' } },
        { id: 'shape:qa-site', type: 'node-card', x: 600, y: 100, props: { nodeType: 'website', title: '网址节点' } },
        { id: 'shape:qa-chat', type: 'node-card', x: 100, y: 500, props: { nodeType: 'chat', title: 'AI 对话', text: JSON.stringify({ messages: [{ role: 'user', content: '测试用户正文' }, { role: 'assistant', content: '测试 AI 回复\n\n第二段回复结束。' }] }) } },
        { id: 'shape:qa-process', type: 'node-card', x: 600, y: 500, props: { nodeType: 'ai-process', title: 'AI 处理' } }
      ])
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      editor.selectNone()
      window.__qaOpened = []
      window.open = (url) => { window.__qaOpened.push(url); return null }
    })
    await page.waitForTimeout(350)
    const layout = await page.evaluate(() => {
      const card = (id) => document.querySelector(`[data-node-id="shape:qa-${id}"] .node-card`)
      const text = document.querySelector('[data-node-id="shape:qa-text"]')
      const count = text.querySelector('.node-text-count').getBoundingClientRect()
      const info = text.querySelector('.node-info-btn').getBoundingClientRect()
      const centers = ['chat', 'process'].map((id) => {
        const node = card(id), rect = node.getBoundingClientRect(), wrap = node.closest('.node-card-wrap')
        const ports = [...wrap.querySelectorAll('.port-dot')].map((port) => { const p = port.getBoundingClientRect(); return Math.abs(p.y + p.height / 2 - rect.y - rect.height / 2) })
        const icon = node.querySelector('.node-empty-icon').getBoundingClientRect()
        const button = node.querySelector(id === 'chat' ? '.chat-open-button' : '.ai-process-config-button').getBoundingClientRect()
        return { ports, iconY: icon.y - rect.y, buttonY: button.y - rect.y, buttonHeight: button.height }
      })
      return { countBeforeInfo: count.right <= info.left, count: text.querySelector('.node-text-count').textContent, centers, modelBadge: Boolean(card('chat').querySelector('.chat-compact-model')) }
    })
    assert.equal(layout.countBeforeInfo, true)
    assert.equal(layout.count, '6 字')
    assert.equal(layout.modelBadge, false)
    for (const item of layout.centers) { assert.equal(item.ports.length, 2); }
    for (const item of layout.centers) for (const deviation of item.ports) assert.ok(deviation < 1)
    assert.ok(Math.abs(layout.centers[0].iconY - layout.centers[1].iconY) < 2)
    assert.ok(Math.abs(layout.centers[0].buttonY - layout.centers[1].buttonY) < 2)
    await page.screenshot({ path: 'qa/node-presentation/cards.png' })
    const site = page.locator('[data-node-id="shape:qa-site"] .website-node-empty')
    await site.dblclick()
    const panel = await page.evaluate(async () => {
      const { kind, shapeId, initialTab } = (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState()
      return { kind, shapeId, initialTab }
    })
    assert.deepEqual(panel, { kind: 'contract', shapeId: 'shape:qa-site', initialTab: 'settings' })
    await page.evaluate(async () => {
      const panel = (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState()
      panel.close()
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({ id: 'shape:qa-site', type: 'node-card', props: { config: JSON.stringify({ name: '测试网址', url: 'https://example.com/' }) } })
      editor.selectNone()
    })
    await page.locator('[data-node-id="shape:qa-site"] .website-node-link').dblclick()
    assert.deepEqual(await page.evaluate(() => window.__qaOpened), ['https://example.com/'])
    await page.evaluate(async () => {
      (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('chat', 'shape:qa-chat', 'settings')
    })
    await page.getByRole('button', { name: '对话设置', exact: true }).click()
    await page.waitForSelector('.chat-dialog-message.assistant', { timeout: 5000 })
    const actions = await page.evaluate(() => [...document.querySelectorAll('.chat-dialog-message')].map((message) => {
      const bubble = message.querySelector('.chat-dialog-bubble').getBoundingClientRect()
      const actions = message.querySelector('.chat-dialog-message-actions')
      return { role: message.classList.contains('assistant') ? 'assistant' : 'user', buttons: [...actions.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')), below: actions.getBoundingClientRect().top >= bubble.bottom - 1 }
    }))
    assert.deepEqual(actions.find((item) => item.role === 'assistant').buttons, ['复制', '重新生成'])
    assert.deepEqual(actions.find((item) => item.role === 'user').buttons, ['复制', '编辑', '重新生成'])
    assert.ok(actions.every((item) => item.below))
    await page.waitForTimeout(350)
    await page.screenshot({ path: 'qa/node-presentation/chat.png' })
    fs.writeFileSync('qa/node-presentation/evidence.json', JSON.stringify({ layout, panel, actions }, null, 2))
    console.log('node presentation browser regression passed')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
