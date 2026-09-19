/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 浏览器验收：文件框多选时，单资产卡片必须把「其余文件去哪了」说清楚（NODE_UI_SPEC §16.26）。
//
// 系统文件框（以及浏览器验收页的 mock）都允许多选，选中的文件会全部进项目素材库，但一张
// 卡片只承载一个资产。旧实现只取第一个匹配项，其余文件既不显示也不提示，用户看到的就是
// 「凭空少了几张」。这条门禁跑真实的 Chromium + 真实 <input type=file multiple>，
// vitest 不挂载 React 组件，所以只能放在浏览器通道里。
//
// 前置：npm run dev:browser -- --port 5199 --strictPort
// 运行：BROWSER_ORIGIN=http://127.0.0.1:5199 npm run test:browser-media-import
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5173'
const DEMO_MEDIA_KEY = 'canvas-studio.browser-demo.media.v1'
// 两张 1×1 PNG：只用来让 blob 解码不报错，断言看的是标题、提示与素材库条目。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42nP4z3D4PwQGAQ8Ai/1+GQAAAABJRU5ErkJggg==',
  'base64'
)

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, headless: true, timeout: 30_000 })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** toast 只显示 2.6 秒，异步导入完才出现：先用 MutationObserver 把文案收集下来再断言。 */
async function recordToasts(page) {
  await page.evaluate((key) => {
    window[key] = []
    const observer = new MutationObserver(() => {
      const el = document.querySelector('.global-toast')
      const text = el?.textContent?.trim()
      if (text && !window[key].includes(text)) window[key].push(text)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }, '__toasts')
}

const readToasts = (page) => page.evaluate(() => window.__toasts)

async function main() {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.goto(`${ORIGIN}/`)

  await page.getByRole('button', { name: '添加图片节点', exact: true }).click()
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
  await page.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  // 卡片定位必须用导入前后都存在的类：导入成功后空态按钮会卸载。
  const card = page.locator('.node-card-wrap:has(.type-image)').first()
  await card.getByRole('button', { name: '导入图片', exact: true }).waitFor()
  await recordToasts(page)

  page.once('filechooser', (chooser) => {
    void chooser.setFiles([
      { name: '多选导入A.png', mimeType: 'image/png', buffer: PNG },
      { name: '多选导入B.png', mimeType: 'image/png', buffer: PNG }
    ])
  })
  await card.getByRole('button', { name: '导入图片', exact: true }).click()

  // 卡片只吃下第一张：图片 alt 就是卡片标题，即被选中的第一个文件。
  await page.waitForFunction(() => {
    const img = document.querySelector('.type-image .node-media img')
    return img && img.complete && img.naturalWidth === 1
  })
  assert.equal(
    await card.locator('.node-media img').getAttribute('alt'),
    '多选导入A',
    '卡片必须承载第一个匹配文件'
  )
  assert.equal(await card.locator('.node-media img').count(), 1, '一张卡片只放一张图片')

  await page.waitForFunction(() => window.__toasts.some((t) => t.includes('一次只用一张图片')))
  const toasts = await readToasts(page)
  assert.ok(
    toasts.some((t) => t.includes('一次只用一张图片：另外 1 个已导入项目素材库')),
    `多选落空的其余文件必须说明去向，实际提示：${JSON.stringify(toasts)}`
  )
  assert.ok(
    !toasts.some((t) => t.includes('导入失败') || t.includes('请选择')),
    `成功导入不得报错误提示，实际提示：${JSON.stringify(toasts)}`
  )

  // 提示说「已导入项目素材库」就必须真的在里面：直接读验收页的素材存储。
  const library = await page.evaluate(
    (key) => JSON.parse(window.sessionStorage.getItem(key) ?? '{}'),
    DEMO_MEDIA_KEY
  )
  const names = Object.values(library)
    .flat()
    .filter((asset) => asset.kind === 'image')
    .map((asset) => asset.name)
  assert.ok(names.includes('多选导入A') && names.includes('多选导入B'), `素材库应含两张图，实际：${names}`)

  console.log('PASS: 多选导入的其余文件已导入素材库并被明确告知，卡片只承载一张')
  await browser.close()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
