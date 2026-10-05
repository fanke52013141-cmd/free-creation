/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const path = require('node:path')
const url = 'http://127.0.0.1:5194'
;(async () => {
  const server = spawn(
    process.execPath,
    [
      path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
      '--config',
      'vite.browser.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      '5194',
      '--strictPort'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  try {
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('浏览器验收服务启动失败')
      try {
        if ((await fetch(url)).ok) break
      } catch {
        /* wait for the local server */
      }
      if (Date.now() > deadline) throw new Error('浏览器验收服务启动超时')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    for (const script of ['verify-remaining-optimization.cjs', 'test-browser-node-standard.cjs', 'test-browser-node-colors.cjs', 'test-browser-node-flexible.cjs', 'test-browser-node-selection.cjs']) {
    const code = await new Promise((resolve, reject) => {
      const test = spawn(
        process.execPath,
        [path.join(__dirname, script)],
        { env: { ...process.env, CANVAS_QA_URL: url }, stdio: 'inherit', windowsHide: true }
      )
      test.on('error', reject)
      test.on('exit', resolve)
    })
    if (code !== 0) throw new Error(`浏览器行为门禁失败（${script}）：${code}`)
    }
  } finally {
    server.kill()
  }
})().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
