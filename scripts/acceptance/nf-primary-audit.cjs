/* eslint-disable */
// 主按钮主题统一视觉验证：主页新建项目 vs 资源库新建资源 vs 表单主按钮，确认同源渐变。
const { _electron } = require('playwright')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nf-primary-'))
  let app, page
  const out = {}
  try {
    const env = { ...process.env, CANVAS_DATA_DIR: dir, CANVAS_OWNER: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [root], env })
    page = await app.firstWindow()
    await page.waitForLoadState()
    await page.waitForSelector('.project-home-button-primary', { timeout: 30000 })
    await sleep(600)
    out.home = await page.locator('.project-home-button-primary').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundImage, color: cs.color, shadow: cs.boxShadow.slice(0, 40) }
    })
    await page.screenshot({ path: path.join(root, 'qa/nf-walkthrough/primary-home.png') })
    // 打开资源库
    await page.click('button[aria-label="资源库"]')
    await page.waitForSelector('.library-primary', { timeout: 15000 })
    await sleep(500)
    out.library = await page.locator('.library-primary').first().evaluate((el) => {
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundImage, color: cs.color }
    })
    await page.screenshot({ path: path.join(root, 'qa/nf-walkthrough/primary-library.png') })
    out.match = out.home.bg === out.library.bg && out.home.color === out.library.color
    fs.writeFileSync(path.join(root, 'qa/nf-walkthrough/primary-audit.json'), JSON.stringify(out, null, 2))
    console.log(JSON.stringify(out, null, 2))
  } catch (e) {
    out.error = String(e?.stack || e)
    console.log(JSON.stringify(out, null, 2))
    process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true })
  }
})()