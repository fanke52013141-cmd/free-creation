/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// One-off visual inventory capture, isolated from the user's real application data.
const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const root = path.resolve(__dirname, '..')
const out = path.join(root, 'artifacts', 'ui-optimization-capture')
const data = path.join(os.tmpdir(), `canvas-ui-capture-${Date.now()}`)
const nodes = [
  ['text', '文本'], ['image', '图片'], ['image-crop', '裁剪'], ['image-split', '拆分'],
  ['image-gen', '生图'], ['image-edit', 'P图'], ['video-asset', '视频素材'],
  ['video-frame', '抽帧'], ['video-clip', '视频截取'], ['video-audio', '截音频'], ['vocal-separate', '人声分离'],
  ['audio', '音频'], ['file', '文件'], ['speech', '配音'], ['tts', '语音克隆'], ['voice-design', '音色设计'],
  ['chat', 'AI 对话'], ['script', '脚本'], ['processor', '数据处理'], ['json', 'JSON'], ['structured', '结构数据'],
  ['code', '代码'], ['storyboard', '分镜板'], ['ai-process', 'AI 处理'], ['iterate', '批量处理'], ['director', '3D 预演台']
]
const safe = (s) => s.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function importFixture(page, file, name, mime) {
  const b64 = fs.readFileSync(file).toString('base64')
  const before = await page.locator('.node-card-wrap').count()
  await page.evaluate(({ name: fileName, mime: fileMime, b64: payload }) => {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], fileName, { type: fileMime }))
    const host = document.querySelector('.canvas-host')
    if (!host) throw new Error('Canvas host missing')
    host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 460, clientY: 320 }))
  }, { name, mime, b64 })
  await page.waitForFunction((count) => document.querySelectorAll('.node-card-wrap').length > count, before, { timeout: 20000 })
}

async function connectPorts(page, source, sourcePort, target, targetPort) {
  const from = page.locator(`.node-card-wrap[data-node-id="${source}"] .port-dot.out[data-port-id="${sourcePort}"]`)
  const to = page.locator(`.node-card-wrap[data-node-id="${target}"] .port-dot.in[data-port-id="${targetPort}"]`)
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error('Connection ports are not visible')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 })
  await page.mouse.up()
  await sleep(350)
}

async function reveal(page, label) {
  const button = page.getByRole('button', { name: `添加${label}节点`, exact: true })
  if (await button.isVisible().catch(() => false)) return button
  const categories = page.locator('.palette-category-item')
  for (let i = 0; i < await categories.count(); i++) {
    const item = categories.nth(i)
    await item.hover().catch(() => {})
    await sleep(120)
    if (await button.isVisible().catch(() => false)) return button
    await item.click().catch(() => {})
    if (await button.isVisible().catch(() => false)) return button
  }
  throw new Error(`Cannot find create button for ${label}`)
}

async function newProject(page, label) {
  if (await page.locator('.chat-dialog-overlay').count()) {
    await page.getByRole('button', { name: '关闭对话' }).click()
  }
  const home = page.getByRole('button', { name: '回到主页' })
  if (await home.count()) await home.click()
  await page.getByRole('button', { name: '新建项目' }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.locator('input[placeholder="项目名称"]').fill(`UI采集-${label}`)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.locator('.node-palette').waitFor({ timeout: 30000 })
}

async function main() {
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(path.join(out, 'scenarios'), { recursive: true })
  const app = await _electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'out/main/index.js')],
    env: { ...process.env, CANVAS_DATA_DIR: data, NODE_ENV: 'production' }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '新建项目' }).waitFor({ timeout: 30000 })
  let previous = { nodes: [] }
  try {
    previous = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
  } catch {
    // A missing manifest is expected during the first capture run.
  }
  const manifest = { date: new Date().toISOString(), viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), nodes: [], interactions: [] }
  manifest.captureNotes = [
    '视频生成按用户要求跳过。',
    '25 个当前 Palette 节点中，跳过视频生成后，其余 24 个都有独立节点文件夹。',
    '运行状态截图是真实 UI 操作结果：文本/代码成功，JSON/代码失败，视频截取/抽帧本地成功。',
    '截图未调用图片生成、视频生成、语音或聊天模型 API。',
    'video-audio 已退役且不可创建；script 未列入当前 Palette。'
  ]
  for (const [type, label] of nodes) {
    const dir = path.join(out, 'nodes', `${type}-${safe(label)}`)
    fs.mkdirSync(dir, { recursive: true })
    const old = previous.nodes.find((item) => item.type === type && item.status === 'captured')
    if (old && fs.existsSync(path.join(dir, '01-default.png')) && (type === 'chat' ? fs.existsSync(path.join(dir, '04-chat-panel.png')) : fs.existsSync(path.join(dir, '04-io-top.png')))) {
      manifest.nodes.push(old)
      continue
    }
    try {
      await newProject(page, `${type}`)
      const before = await page.locator('.node-card-wrap').count()
      const add = await reveal(page, label)
      await add.click()
      await page.waitForFunction((count) => document.querySelectorAll('.node-card-wrap').length > count, before)
      const card = page.locator('.node-card-wrap').first()
      await card.scrollIntoViewIfNeeded()
      await sleep(300)
      await page.screenshot({ path: path.join(dir, '01-default.png') })
      const body = card.locator('.node-body')
      const bodyOverflow = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 2).catch(() => false)
      if (bodyOverflow) {
        await body.evaluate((el) => { el.scrollTop = 0 })
        await page.screenshot({ path: path.join(dir, '02-card-scroll-top.png') })
        await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
        await page.screenshot({ path: path.join(dir, '03-card-scroll-bottom.png') })
      }
      const info = card.getByRole('button', { name: '打开节点说明' })
      await info.click()
      if (type === 'chat') {
        await page.locator('.chat-dialog-overlay').waitFor()
        await page.screenshot({ path: path.join(dir, '04-chat-panel.png') })
        await page.getByRole('button', { name: '关闭对话' }).click()
        manifest.nodes.push({ type, label, status: 'captured', panel: 'chat dialog (specialized)', files: fs.readdirSync(dir) })
        continue
      }
      await page.locator('.node-contract-panel').waitFor()
      await page.getByRole('tab', { name: '输入输出' }).click()
      const contractScroll = page.locator('.contract-scroll')
      await contractScroll.evaluate((el) => { el.scrollTop = 0 })
      await page.screenshot({ path: path.join(dir, '04-io-top.png') })
      const panelScroll = await contractScroll.evaluate((el) => el.scrollHeight > el.clientHeight + 2)
      if (panelScroll) {
        let pageNo = 1
        const max = await contractScroll.evaluate((el) => el.scrollHeight - el.clientHeight)
        for (let pos = 0; pos < max; pos += Math.max(250, await contractScroll.evaluate((el) => el.clientHeight * 0.72))) {
          await contractScroll.evaluate((el, y) => { el.scrollTop = y }, pos)
          await sleep(80)
          await page.screenshot({ path: path.join(dir, `04-io-scroll-${String(pageNo++).padStart(2, '0')}.png`) })
        }
        await contractScroll.evaluate((el) => { el.scrollTop = el.scrollHeight })
        await page.screenshot({ path: path.join(dir, `04-io-scroll-${String(pageNo).padStart(2, '0')}.png`) })
      }
      await page.getByRole('tab', { name: '运行' }).click()
      await page.screenshot({ path: path.join(dir, '05-run-details.png') })
      manifest.nodes.push({ type, label, status: 'captured', cardScroll: bodyOverflow, ioScroll: panelScroll, files: fs.readdirSync(dir) })
    } catch (error) {
      if (await page.locator('.chat-dialog-overlay').count()) await page.getByRole('button', { name: '关闭对话' }).click().catch(() => {})
      if (type === 'video-audio' || type === 'script') {
        manifest.nodes.push({ type, label, status: 'not-in-palette', reason: type === 'video-audio' ? 'Retired node type (creatable: false); its function is merged into 视频截取.' : 'NodeTypeSpec exists but the type is absent from the current palette.' })
      } else {
        manifest.nodes.push({ type, label, status: 'failed', error: String(error.message) })
      }
    }
  }
  manifest.nodes.push({ type: 'video', label: '视频生成', status: 'skipped-by-request' })
  // Capture the three explicitly requested workbenches from their real node entries.
  const workbenches = [
    { type: 'video-clip', label: '视频截取', action: '配置视频截取', dialog: '视频截取工作台', file: '07-workbench.png', fixture: 'media/video/V-AV.mp4', mediaName: 'ui-fixture.mp4', mime: 'video/mp4', assetType: 'video-asset', sourcePort: 'out-video', targetPort: 'in-video' },
    { type: 'video-frame', label: '抽帧', action: '配置抽帧', dialog: '抽帧工作台', file: '07-workbench.png', fixture: 'media/video/V-AV.mp4', mediaName: 'ui-fixture.mp4', mime: 'video/mp4', assetType: 'video-asset', sourcePort: 'out-video', targetPort: 'in-video' },
    { type: 'image-edit', label: 'P图', action: '打开工作台', dialog: 'P图工作台', file: '07-workbench.png', fixture: 'media/images/I-GRID.png', mediaName: 'ui-fixture.png', mime: 'image/png', assetType: 'image', sourcePort: 'out-image', targetPort: 'in-image' }
  ]
  manifest.dialogs = []
  for (const item of workbenches) {
    const folder = path.join(out, 'nodes', `${item.type}-${safe(item.label)}`)
    try {
      await newProject(page, `弹窗-${item.type}`)
      await importFixture(page, path.join(root, 'qa-fixtures', ...item.fixture.split('/')), item.mediaName, item.mime)
      const before = await page.locator('.node-card-wrap').count()
      const add = await reveal(page, item.label)
      await add.click()
      await page.waitForFunction((count) => document.querySelectorAll('.node-card-wrap').length > count, before)
      const card = page.locator(`.node-card-wrap:has(.type-${item.type})`).first()
      await card.scrollIntoViewIfNeeded()
      const asset = page.locator(`.node-card-wrap:has(.type-${item.assetType})`).first()
      const sourceId = await asset.getAttribute('data-node-id')
      const targetId = await card.getAttribute('data-node-id')
      await connectPorts(page, sourceId, item.sourcePort, targetId, item.targetPort)
      await card.getByRole('button', { name: item.action, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: item.dialog, exact: true })
      await dialog.waitFor()
      await sleep(250)
      await page.screenshot({ path: path.join(folder, item.file) })
      const shots = [{ file: item.file, state: 'initial workbench' }]
      if (item.type === 'video-clip') {
        const audioOnly = dialog.getByRole('button', { name: '只保留音频', exact: true })
        if (await audioOnly.count()) {
          await audioOnly.click()
          await sleep(150)
          await page.screenshot({ path: path.join(folder, '08-audio-only-settings.png') })
          shots.push({ file: '08-audio-only-settings.png', state: 'audio-only settings' })
        }
      }
      if (item.type === 'image-edit') {
        const brush = dialog.getByRole('button', { name: '画笔', exact: true })
        if (await brush.count()) {
          await brush.click()
          await sleep(150)
          await page.screenshot({ path: path.join(folder, '08-brush-tool.png') })
          shots.push({ file: '08-brush-tool.png', state: 'brush tool selected' })
        }
      }
      if (item.type === 'video-clip' || item.type === 'video-frame') {
        const submit = dialog.getByRole('button', { name: item.type === 'video-frame' ? '开始抽帧' : '截取视频', exact: true })
        await submit.click()
        await dialog.waitFor({ state: 'detached' })
        let runtimeState = 'unknown'
        for (let i = 0; i < 160; i++) {
          const className = await card.locator('.node-status').getAttribute('class').catch(() => '')
          if (/node-status-(success|failed|cancelled)/.test(className)) {
            runtimeState = /node-status-success/.test(className) ? 'success' : /node-status-cancelled/.test(className) ? 'cancelled' : 'failed'
            break
          }
          await sleep(250)
        }
        await page.screenshot({ path: path.join(folder, '09-run-result.png') })
        shots.push({ file: '09-run-result.png', state: runtimeState })
      }
      manifest.dialogs.push({ type: item.type, label: item.label, status: 'captured', screenshots: shots })
      if (await dialog.count()) {
        await dialog.locator('button').first().click()
        await dialog.waitFor({ state: 'detached' })
      }
    } catch (error) {
      manifest.dialogs.push({ type: item.type, label: item.label, status: 'failed', error: String(error.message) })
    }
  }
  // Capture genuine local execution states without invoking configured model APIs.
  manifest.executionStates = []
  for (const item of [
    { type: 'text', label: '文本', content: '状态截图示例', expected: 'success', file: '06-run-success.png' },
    { type: 'json', label: 'JSON', content: '{ invalid json', expected: 'failed', file: '06-run-failed.png' },
    { type: 'code', label: '代码', content: 'async function main(args) { return { ok: true } }', expected: 'success', file: '06-run-success.png' },
    { type: 'code', label: '代码', content: 'async function main(args) { return 1 +', expected: 'failed', file: '07-run-failed.png' }
  ]) {
    const folder = path.join(out, 'nodes', `${item.type}-${safe(item.label)}`)
    try {
      await newProject(page, `状态-${item.type}-${item.expected}`)
      const before = await page.locator('.node-card-wrap').count()
      const add = await reveal(page, item.label)
      await add.click()
      await page.waitForFunction((count) => document.querySelectorAll('.node-card-wrap').length > count, before)
      const card = page.locator('.node-card-wrap').last()
      await card.scrollIntoViewIfNeeded()
      if (item.type === 'code') await card.getByRole('button', { name: /编写代码/ }).click()
      else await card.locator('.node-body').dblclick()
      const editor = card.locator('textarea').last()
      await editor.waitFor()
      await editor.fill(item.content)
      await editor.press('Tab')
      await sleep(300)
      const runButton = card.getByRole('button', { name: '运行节点', exact: true })
      const enabled = await runButton.isEnabled()
      if (enabled) {
        await runButton.click()
        await card.locator(`.node-status-${item.expected}`).waitFor({ timeout: 15000 })
        await sleep(150)
        await page.screenshot({ path: path.join(folder, item.file) })
      }
      manifest.executionStates.push({ type: item.type, state: enabled ? item.expected : 'blocked-before-run', screenshot: enabled ? item.file : null })
    } catch (error) {
      manifest.executionStates.push({ type: item.type, state: 'not-captured', reason: String(error.message) })
    }
  }
  try {
    await newProject(page, 'workflow-running')
    const before = await page.locator('.node-card-wrap').count()
    await (await reveal(page, '代码')).click()
    await page.waitForFunction((count) => document.querySelectorAll('.node-card-wrap').length > count, before)
    const codeCard = page.locator('.node-card-wrap:has(.type-code)').first()
    await codeCard.getByRole('button', { name: /编写代码/ }).click()
    await codeCard.locator('textarea').last().fill('async function main(args) {\n  await new Promise(resolve => setTimeout(resolve, 6000))\n  return { ok: true }\n}')
    await codeCard.locator('textarea').last().press('Tab')
    const runWorkflow = page.getByRole('button', { name: '运行', exact: true })
    await runWorkflow.click()
    await page.locator('.engine-progress-text').waitFor({ timeout: 10000 })
    await page.screenshot({ path: path.join(out, 'scenarios', '06-workflow-running.png') })
    await codeCard.locator('.node-status-success').waitFor({ timeout: 20000 })
    await page.screenshot({ path: path.join(out, 'scenarios', '07-workflow-completed.png') })
  manifest.workflowStates = ['running', 'completed']
  } catch (error) {
    manifest.workflowStates = [{ status: 'not-captured', reason: String(error.message) }]
  }
  // A small real interaction canvas: two connected text cards, selected together,
  // then alignment and native grouping toolbar states.
  try {
    await newProject(page, 'interactions')
    const src = await reveal(page, '文本'); await src.click(); await sleep(250)
    const first = page.locator('.node-card-wrap').first()
    const srcOut = first.locator('.port-dot.out').first()
    const srcBox = await srcOut.boundingBox()
    await reveal(page, '文本')
    const add = page.getByRole('button', { name: '添加文本节点', exact: true })
    await add.click(); await sleep(250)
    const second = page.locator('.node-card-wrap').nth(1)
    const inPort = second.locator('.port-dot.in').first()
    const inBox = await inPort.boundingBox()
    if (srcBox && inBox) {
      await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2)
      await page.mouse.down(); await page.mouse.move(inBox.x + inBox.width / 2, inBox.y + inBox.height / 2, { steps: 12 }); await page.mouse.up()
      await sleep(500); await page.screenshot({ path: path.join(out, 'scenarios', '01-connected-nodes.png') })
    }
    await first.click({ position: { x: 80, y: 70 } })
    await second.click({ position: { x: 80, y: 70 }, modifiers: ['Shift'] })
    await sleep(300)
    await page.screenshot({ path: path.join(out, 'scenarios', '02-multi-select.png') })
    const align = page.getByRole('button', { name: '左对齐' })
    if (await align.count()) { await align.click(); await sleep(250); await page.screenshot({ path: path.join(out, 'scenarios', '03-align-left.png') }) }
    const group = page.getByRole('button', { name: '打组' })
    if (await group.count()) { await group.click(); await sleep(300); await page.screenshot({ path: path.join(out, 'scenarios', '04-grouped.png') }) }
    const run = page.getByRole('button', { name: '运行', exact: true })
    if (await run.count()) { await run.click(); await sleep(350); await page.screenshot({ path: path.join(out, 'scenarios', '05-workflow-run.png') }) }
    manifest.interactions.push('connected-nodes', 'multi-select', 'align-left', 'group', 'workflow-run')
  } catch (error) {
    manifest.interactions.push({ status: 'partial', error: String(error.message) })
  }
  fs.mkdirSync(path.join(out, 'scenarios'), { recursive: true })
  for (const node of manifest.nodes.filter((item) => item.status === 'captured')) {
    const folder = path.join(out, 'nodes', `${node.type}-${safe(node.label)}`)
    node.files = fs.readdirSync(folder).filter((name) => name.endsWith('.png')).sort()
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await app.close()
  console.log(JSON.stringify({ output: out, captured: manifest.nodes.filter(x => x.status === 'captured').length, failed: manifest.nodes.filter(x => x.status === 'failed').length, interactions: manifest.interactions }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
