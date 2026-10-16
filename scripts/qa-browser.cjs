/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')

async function launchQaBrowser() {
  const channels = process.env.CANVAS_QA_BROWSER_CHANNEL
    ? [process.env.CANVAS_QA_BROWSER_CHANNEL]
    : ['chrome', 'msedge', undefined]
  let lastError
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
      process.stdout.write(`QA browser: ${channel || 'chromium'} ${browser.version()}\n`)
      return browser
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

module.exports = { launchQaBrowser }
