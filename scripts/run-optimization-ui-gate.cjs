/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const path = require('node:path')
const { join } = require('node:path')
const port = process.env.CANVAS_QA_GATE_PORT || '5194'
const url = `http://127.0.0.1:${port}`
// vite 在 Windows 下带子进程树；只结束直接子进程会留下接管端口的僵尸服务，
// 让下一轮门禁对着过期模块图跑出假失败。必须按进程树结束。
// taskkill 不一定在 PATH 上（精简镜像），用 System32 绝对路径；仍失败则回退
// 直接结束主进程——端口由 vite 主进程持有，主进程死端口即释放。
function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const fallback = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM')
    }, 3000)
    if (typeof fallback.unref === 'function') fallback.unref()
    killer.once('exit', () => clearTimeout(fallback))
    killer.once('error', () => {
      clearTimeout(fallback)
      if (child.exitCode === null) child.kill('SIGTERM')
    })
  } else {
    child.kill('SIGTERM')
  }
}
;(async () => {
  // 残留的旧验收服务会让新 vite 绑定失败而测试打到过期模块图上；启动前先快失败。
  try {
    if ((await fetch(url)).ok) throw new Error(`端口 ${port} 已被占用（可能是残留的验收 vite），请结束该进程后重试`)
  } catch (error) {
    if (error instanceof TypeError) {
      /* 连接被拒=端口空闲，正常继续 */
    } else {
      throw error
    }
  }
  const server = spawn(
    process.execPath,
    [
      path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
      '--config',
      'vite.browser.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      port,
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
    // 预热：首屏会触发 vite 依赖发现与整页重载，重载落在后续验收脚本上会把
    // 其页面打成注册表不完整的半启动状态；先打开一次真实页面等它稳定。
    const { launchQaBrowser } = require('./qa-browser.cjs')
    const warmBrowser = await launchQaBrowser()
    try {
      const warmPage = await warmBrowser.newPage()
      await warmPage.goto(url, { timeout: 90000 })
      await warmPage.waitForSelector('.tl-canvas', { timeout: 90000 })
      await warmPage.waitForTimeout(2000)
      await warmPage.close()
    } finally {
      await warmBrowser.close()
    }
    for (const script of ['verify-remaining-optimization.cjs', 'test-browser-node-standard.cjs', 'test-browser-node-colors.cjs', 'test-browser-node-flexible.cjs', 'test-browser-node-selection.cjs', 'test-browser-node-references.cjs', 'test-browser-hidden-scrollbars.cjs', 'test-browser-menu-order.cjs', 'test-browser-storyboard-table.cjs', 'test-browser-node-resize.cjs', 'test-browser-canvas-proportions.cjs', 'test-browser-clay-settings.cjs', 'test-browser-chat-images.cjs', 'test-browser-node-pointer.cjs', 'test-browser-agent-flow-tab.cjs', 'test-browser-agent-flow-c1.cjs', 'test-browser-agent-flow-declarations.cjs', 'test-browser-agent-flow-relation-anchors.cjs', 'test-browser-agent-flow-assets.cjs', 'test-browser-state-machine.cjs', 'test-browser-local-stop.cjs', 'test-browser-local-consistency.cjs', 'test-browser-skill-agent.cjs', 'test-browser-storyboard.cjs', 'test-browser-director-studio.cjs']) {
    const runOnce = () => new Promise((resolve, reject) => {
      const test = spawn(
        process.execPath,
        [path.join(__dirname, script)],
        { env: { ...process.env, CANVAS_QA_URL: url }, stdio: 'inherit', windowsHide: true }
      )
      test.on('error', reject)
      test.on('exit', resolve)
    })
    let code = await runOnce()
    if (code !== 0) {
      // 首屏进入画布、冷启动编译等存在与本轮改动无关的偶发抖动；失败重跑一次，
      // 连续两次失败才判定为门禁失败。
      process.stderr.write(`浏览器脚本失败，重试一次：${script}（退出码 ${code}）\n`)
      code = await runOnce()
    }
    if (code !== 0) throw new Error(`浏览器行为门禁失败（${script}）：${code}`)
    }
  } finally {
    killTree(server)
  }
})().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
