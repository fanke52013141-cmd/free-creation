/* eslint-disable */
// BL-23 桌面确认：speech / voice-design / image-edit 卡内结果区必须读取本节点
// meta.nodeResult 集合的「当前选中项」，与 MediaResultGrid 同源；失败运行不展示结果区。
// 运行方式：node scripts/acceptance/node-result-area-desktop.cjs
// 前置：已构建 out/（CANVAS_OWNER=1）。渲染层用 vite dev 载入源码，主进程/预载用 out/ 真实构建。
const { _electron } = require('playwright')
const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const ROOT = path.resolve(__dirname, '..', '..')
const EVIDENCE = path.join(ROOT, 'qa', 'node-result-area-desktop')
const SHOT_DIR = path.join(EVIDENCE, 'shots')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const port = 5197
const url = `http://127.0.0.1:${port}`

function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill('SIGTERM'))
  } catch {
    child.kill('SIGTERM')
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`TIMEOUT:${label}`)
}

async function startVite() {
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
  const server = spawn(
    process.execPath,
    [viteBin, '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true }
  )
  await waitFor(
    async () => {
      if (server.exitCode !== null) throw new Error('VITE_EXITED')
      return (await fetch(url)).ok
    },
    45000,
    'vite'
  )
  return server
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-result-area-'))
  const security = path.join(process.env.APPDATA || '', 'canvas-studio/data/security')
  await fsp.cp(security, path.join(dir, 'security'), { recursive: true })
  await fsp.mkdir(SHOT_DIR, { recursive: true })

  const receipt = { mode: 'desktop (Electron + vite renderer, no model calls)', checks: [], screenshots: [] }
  const check = (label, ok, detail = '') => {
    if (!ok) throw new Error(`${label}:${detail}`)
    receipt.checks.push(label)
    console.log(`[check] ${label}${detail ? ` :: ${detail}` : ''}`)
  }

  let viteServer = null
  let app = null
  try {
    viteServer = await startVite()
    const launchEnv = {
      ...process.env,
      CANVAS_DATA_DIR: dir,
      NODE_ENV: 'development',
      ELECTRON_RENDERER_URL: url
    }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: require('electron'),
      // 仓库惯例：受限/远程桌面宿主上 Chromium GPU 沙箱初始化可能失败，验收脚本显式关闭沙箱。
      args: ['--no-sandbox', ROOT, '--local-agent-access'],
      env: launchEnv
    })
    const page = await app.firstWindow()
    await page.waitForLoadState()
    page.on('pageerror', (error) => {
      const message = String(error?.message || error)
      if (!/source image cannot be decoded|Failed to fetch/i.test(message)) console.log('[pageerror]', message.slice(0, 200))
    })
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setTitle('[TEST] BL-23 操作节点卡内结果区')
    })

    // 等主进程 agent access 通道就绪，用 CLI 建项目并打开，确保画布编辑器真实挂载。
    await waitFor(
      async () => fs.existsSync(path.join(dir, 'agent-access/connection.json')),
      60000,
      'connection'
    )
    const cli = async (args, input) => {
      const inputFile = path.join(dir, `input-${randomUUID()}.json`)
      if (input) await fsp.writeFile(inputFile, JSON.stringify({ input, idempotencyKey: `${Date.now()}:${randomUUID()}` }))
      return await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [path.join(ROOT, 'out/main/local-agent.js'), ...args, '--data-dir', dir, ...(input ? ['--input-file', inputFile] : [])], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
        let out = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 60000)
        child.stdout.on('data', (chunk) => (out += chunk))
        child.once('error', reject)
        child.once('exit', (code) => {
          clearTimeout(timer)
          if (code !== 0) return reject(new Error(`CLI_EXIT_${code}:${out.slice(0, 300)}`))
          try { resolve(JSON.parse(out)) } catch { reject(new Error(`CLI_BAD_JSON:${out.slice(0, 300)}`)) }
        })
      })
    }
    const created = await cli(['project', 'create'], { name: '[TEST] BL-23 卡内结果区' })
    const projectId = created?.data?.meta?.id
    if (!projectId) throw new Error(`PROJECT_CREATE_FAILED:${JSON.stringify(created).slice(0, 300)}`)
    await cli(['project', 'open'], { projectId })
    await waitFor(() => page.locator('.tl-container').count().then((n) => n > 0), 60000, 'canvas')

    // 固定夹具：三条正常结果（选中 + 另一条）+ 一张失败运行卡片 + 一张无 selectedMediaId 的回退卡片。
    const fixture = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })

      // 1 秒静音 WAV data URL；mediaUrl 对 data: 原样透传，便于断言「点的是选中项」。
      const wave = new Uint8Array(44 + 16000)
      const view = new DataView(wave.buffer)
      for (const [offset, tag] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']])
        wave.set(new TextEncoder().encode(tag), offset)
      for (const [offset, value] of [[4, wave.length - 8], [16, 16], [24, 8000], [28, 16000], [40, 16000]])
        view.setUint32(offset, value, true)
      for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]])
        view.setUint16(offset, value, true)
      const audioUrl = 'data:audio/wav;base64,' + btoa(String.fromCharCode(...wave))
      window.__qaMedia = {
        selectedAudio: audioUrl,
        recentAudio: audioUrl + '?recent',
        selectedImage: 'qa-picked-image-edit',
        recentImage: 'qa-recent-image-edit'
      }
      window.qaPlayback = []
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = async function () {
        try { await play.call(this) } catch { /* 无声卡环境忽略播放失败 */ }
        window.qaPlayback.push({ src: this.src, duration: this.duration })
      }
      const makeCollection = (type, selectedFirst) => {
        const image = type === 'image-edit'
        const selectedPath = image ? window.__qaMedia.selectedImage : window.__qaMedia.selectedAudio
        const recentPath = image ? window.__qaMedia.recentImage : window.__qaMedia.recentAudio
        return JSON.stringify({
          kind: 'media-source', version: 1,
          ...(selectedFirst ? { selectedMediaId: 'picked' } : {}),
          results: [
            { mediaId: 'picked', mediaPath: selectedPath, mime: image ? 'image/png' : 'audio/wav', createdAt: 1 },
            { mediaId: 'recent', mediaPath: recentPath, mime: image ? 'image/png' : 'audio/wav', createdAt: 2 }
          ]
        })
      }
      const createCard = (type, index, nodeResult, status = 'success', suffix = '') => {
        editor.createShape({
          id: `shape:result-${type}${suffix}`, type: 'node-card', x: 80 + index * 390, y: 80,
          props: { nodeType: type, title: type, w: 340, h: 300, config: getNodeType(type).initialConfig || '' },
          meta: {
            nodeRun: { runId: 'qa-result', startedAt: 1, status, inputs: {} },
            nodeResult
          }
        })
      }
      createCard('speech', 0, makeCollection('speech', true))
      createCard('voice-design', 1, makeCollection('voice-design', true))
      createCard('image-edit', 2, makeCollection('image-edit', true))
      // 旧集合回退：没有 selectedMediaId 时按最近一条（results 末项）呈现。
      createCard('image-edit', 3, makeCollection('image-edit', false).replace('"version":1', '"version":1,"legacy":true'), 'success', '-legacy')
      // 失败运行：不展示结果区（不把旧结果伪装成本次成功）。
      createCard('speech', 4, makeCollection('speech', true), 'failed', '-failed')
      const ids = [...editor.getCurrentPageShapeIds()]
      if (ids.length !== 5) throw new Error(`FIXTURE_SHAPE_COUNT:${ids.length}`)
      return { shapeCount: ids.length, selectedAudio: window.__qaMedia.selectedAudio }
    })
    check('桌面夹具创建三张操作节点卡片 + 回退卡片 + 失败卡片', fixture.shapeCount === 5)

    // speech / voice-design：播放按钮必须播「选中项」，不是最近一条。
    for (const [index, type] of ['speech', 'voice-design'].entries()) {
      const card = page.locator(`[data-node-id="shape:result-${type}"]`)
      const tiles = card.locator('.media-result-tile')
      check(`${type} 卡内结果区展示 2 条结果`, (await tiles.count()) === 2, String(await tiles.count()))
      check(`${type} 选中项高亮唯一`, (await card.locator('.media-result-tile.selected').count()) === 1)
      await card.getByRole('button', { name: '播放', exact: true }).first().click()
      await page.waitForFunction((count) => window.qaPlayback.length >= count, index + 1, { timeout: 15000 })
      const played = await page.evaluate((position) => window.qaPlayback[position].src, index)
      check(`${type} 播放的是选中项（非最近一条）`, played === fixture.selectedAudio, played.slice(0, 60))
    }

    // image-edit：预览图必须是选中项。
    const editCard = page.locator('[data-node-id="shape:result-image-edit"]')
    const selectedTile = editCard.locator('.media-result-tile.selected')
    check('image-edit 选中项高亮唯一', (await selectedTile.count()) === 1)
    const pickedSrc = await selectedTile.locator('img').getAttribute('src')
    const media = await page.evaluate(() => window.__qaMedia)
    check('image-edit 预览指向选中项', String(pickedSrc).includes(media.selectedImage), String(pickedSrc).slice(0, 80))

    // 旧集合回退：没有 selectedMediaId 时仍渲染（取最近一条），不空白。
    const legacy = page.locator('[data-node-id="shape:result-image-edit-legacy"]')
    check('无 selectedMediaId 的旧集合回退渲染', (await legacy.locator('.media-result-tile').count()) === 2)

    // 失败运行：不展示结果区。
    const failed = page.locator('[data-node-id="shape:result-speech-failed"]')
    check('失败运行不展示结果区', (await failed.locator('.media-result-grid').count()) === 0)

    await page.screenshot({ path: path.join(SHOT_DIR, 'result-area-desktop.png') })
    receipt.screenshots.push('shots/result-area-desktop.png')
    receipt.status = 'passed'
    console.log('[passed] BL-23 桌面确认：speech / voice-design / image-edit 卡内结果区读取选中项一致')
  } catch (error) {
    receipt.status = 'failed'
    receipt.error = String(error?.stack || error)
    console.error('[failed]', error)
    process.exitCode = 1
  } finally {
    await fsp.writeFile(path.join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2)).catch(() => {})
    if (app) await app.close().catch(() => {})
    if (viteServer) killTree(viteServer)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})()