const { chromium } = require('playwright')
async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().includes('index.html'))
  await page.bringToFront().catch(()=>{})
  await page.waitForTimeout(400)
  const sess = await ctx.newCDPSession(page)
  const { data } = await sess.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const fs = require('fs')
  fs.writeFileSync('results/2026-09-23/batch1/evidence/desktop-ui.png', Buffer.from(data, 'base64'))
  console.log('saved desktop-ui.png bytes=', data.length)
  await browser.close()
}
main().catch((e)=>{ console.error('ERR', e.message); process.exit(1) })