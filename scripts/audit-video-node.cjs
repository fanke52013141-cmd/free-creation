/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 视频节点深度审查：记录空节点、选模型、连接图片、切换模式和提交按钮的真实 UI 状态。
 * 该脚本只使用 browserMock，不读写桌面项目；每次运行都在独立浏览器上下文中完成。
 *
 * Usage: node scripts/audit-video-node.cjs [baseUrl] [outputDir]
 */
const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3123/'
const outputDir = process.argv[3] ?? join(process.cwd(), 'artifacts', 'video-node-audit')

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

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1708, height: 879 } })
  const page = await context.newPage()
  page.setDefaultTimeout(8_000)
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  return { context, page }
}

async function cardState(page, card) {
  return card.evaluate((element) => {
    const controls = Array.from(element.querySelectorAll('select, textarea, input, button')).map(
      (node) => ({
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type'),
        label: node.getAttribute('aria-label'),
        value: node.value,
        text: node.textContent?.trim() ?? '',
        disabled: node.disabled === true,
        options:
          node.tagName === 'SELECT'
            ? Array.from(node.options).map((option) => option.value)
            : undefined
      })
    )
    const rect = element.getBoundingClientRect()
    return {
      nodeType: element.querySelector('.node-card')?.getAttribute('data-node-type') ?? '',
      title: element.querySelector('.node-title')?.textContent?.trim() ?? '',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      controls,
      inputs: Array.from(element.querySelectorAll('.port-dot.in')).map((port) => ({
        id: port.getAttribute('data-port-id'),
        color: getComputedStyle(port).borderColor
      })),
      outputs: Array.from(element.querySelectorAll('.port-dot.out')).map((port) => ({
        id: port.getAttribute('data-port-id'),
        color: getComputedStyle(port).borderColor
      })),
      alerts: Array.from(element.querySelectorAll('[role="alert"]')).map(
        (node) => node.textContent?.trim() ?? ''
      )
    }
  })
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(outputDir, `${name}.png`) })
}

async function addNode(page, label) {
  const beforeIds = await page
    .locator('.node-card-wrap[data-node-id]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-node-id')).filter(Boolean))
  await page.getByRole('button', { name: label, exact: true }).click()
  const newId = await page
    .waitForFunction((knownIds) => {
      const ids = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
        .map((card) => card.getAttribute('data-node-id'))
        .filter(Boolean)
      return ids.find((id) => !knownIds.includes(id)) ?? null
    }, beforeIds)
    .then((handle) => handle.jsonValue())
  return page.locator(`.node-card-wrap[data-node-id="${newId}"]`)
}

async function main() {
  mkdirSync(outputDir, { recursive: true })
  const browser = await launchBrowser()
  const report = { baseUrl, viewport: { width: 1708, height: 879 }, states: [], assertions: [] }
  try {
    const { context, page } = await newPage(browser)
    try {
      const video = await addNode(page, '添加视频节点')
      await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
      report.states.push({ name: 'fresh', ...(await cardState(page, video)) })
      await screenshot(page, '01-fresh')

      const selects = video.locator('select')
      const modelSelect = selects.nth(0)
      report.assertions.push({
        name: 'fresh-requires-an-explicit-model-choice',
        pass:
          (await modelSelect.inputValue()) === '' &&
          (await video.locator('[role="alert"]').allTextContents()).some((text) =>
            text.includes('请选择视频模型')
          ),
        actual: await modelSelect.inputValue(),
        expected: 'empty model key with an explicit select-model state'
      })
      await modelSelect.selectOption({ label: '演示 MiniMax · MiniMax-H3' })
      await page.waitForTimeout(250)
      report.states.push({ name: 'h3-selected', ...(await cardState(page, video)) })
      await screenshot(page, '02-h3-selected')

      const imageIdsBefore = await page
        .locator('.node-card-wrap:has(.type-image)[data-node-id]')
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-node-id')).filter(Boolean)
        )
      await page.evaluate(() => {
        const bytes = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
          ),
          (char) => char.charCodeAt(0)
        )
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'video-audit.png', { type: 'image/png' }))
        const target = document.querySelector('.canvas-host')
        target?.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
        )
      })
      await page.waitForTimeout(300)
      const imageId = await page
        .waitForFunction((knownIds) => {
          const cards = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
          return (
            cards
              .filter((card) => card.querySelector('.type-image'))
              .map((card) => card.getAttribute('data-node-id'))
              .find((id) => id && !knownIds.includes(id)) ?? null
          )
        }, imageIdsBefore)
        .then((handle) => handle.jsonValue())
      const image = page.locator(`.node-card-wrap[data-node-id="${imageId}"]`)
      report.states.push({ name: 'pasted-image', ...(await cardState(page, image)) })
      await screenshot(page, '03-pasted-image')
      await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
      await page.waitForTimeout(250)
      const videoIdsBefore = await page
        .locator('.node-card-wrap:has(.type-video)[data-node-id]')
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-node-id')).filter(Boolean)
        )
      await image.getByRole('button', { name: '生成视频', exact: true }).click()
      const linkedVideoId = await page
        .waitForFunction((knownIds) => {
          const cards = Array.from(document.querySelectorAll('.node-card-wrap[data-node-id]'))
          return (
            cards
              .filter((card) => card.querySelector('.type-video'))
              .map((card) => card.getAttribute('data-node-id'))
              .find((id) => id && !knownIds.includes(id)) ?? null
          )
        }, videoIdsBefore)
        .then((handle) => handle.jsonValue())
      const linkedVideo = page.locator(`.node-card-wrap[data-node-id="${linkedVideoId}"]`)
      const linkedSelects = linkedVideo.locator('select')
      await linkedSelects.nth(0).selectOption({ label: '演示 MiniMax · MiniMax-H3' })
      await page.waitForTimeout(250)
      const linkedModeSelect = linkedSelects.nth(1)
      report.states.push({ name: 'h3-one-image', ...(await cardState(page, linkedVideo)) })
      await screenshot(page, '03-h3-one-image')
      report.assertions.push({
        name: 'one-image-forces-non-text-mode',
        pass: (await linkedModeSelect.inputValue()) !== 'text',
        actual: await linkedModeSelect.inputValue(),
        expected: 'reference (H3)'
      })

      report.states.push({
        name: 'h3-one-image-filtered-modes',
        ...(await cardState(page, linkedVideo))
      })
      await screenshot(page, '04-h3-one-image-filtered-modes')
      report.assertions.push({
        name: 'text-mode-is-not-selectable-after-image-connects',
        pass:
          (await linkedModeSelect.locator('option[value="text"]').count()) === 0 &&
          (await linkedModeSelect.inputValue()) === 'reference' &&
          !(await linkedVideo.getByRole('button', { name: /生成视频/ }).isDisabled()),
        actual: {
          buttonDisabled: await linkedVideo.getByRole('button', { name: /生成视频/ }).isDisabled(),
          availableModes: await linkedModeSelect
            .locator('option')
            .evaluateAll((options) => options.map((option) => option.value))
        },
        expected: 'reference mode only; text mode is absent and submit remains available'
      })

      await context.close()
    } finally {
      if (!context.pages().length) {
        // context already closed
      }
    }

    const second = await newPage(browser)
    try {
      const video = await addNode(second.page, '添加视频节点')
      await second.page
        .getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true })
        .click()
      const state = await cardState(second.page, video)
      report.states.push({ name: 'fresh-second-context', ...state })
      await screenshot(second.page, '05-fresh-second-context')
    } finally {
      await second.context.close()
    }

    writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
