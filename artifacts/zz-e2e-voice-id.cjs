/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 一次性真机验收（scratch，不入库、不提交）：用 MiniMax 音色库的 preset 音色 ID
// （含空格与括号）跑一条真实配音，验证这个 ID 从输入框到磁盘全链路都不被改写。
//
// 复用上一轮的隔离库（供应商与密钥已在里面），只把数据目录换成 CANVAS_DATA_DIR。
// 本脚本完全不接触密钥：填 Key 那一步由 zz-e2e-minimax-voice.cjs 在隔离库里做过。
const { _electron } = require('playwright')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

const probe = promisify(execFile)
const ROOT = 'D:/Program Files (x86)/free-creation'
const DATA_DIR = process.env.E2E_DATA_DIR
const VOICE_ID = process.env.VOICE_ID || 'Chinese (Mandarin)_News_Anchor'
const SHOT = path.join(ROOT, 'artifacts/e2e-2026-09-19')

const results = []
const log = (...a) => console.log('[voice]', ...a)
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

async function main() {
  if (!DATA_DIR) throw new Error('E2E_DATA_DIR 未注入')
  const app = await _electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(ROOT, 'out/main/index.js')],
    env: { ...process.env, CANVAS_DATA_DIR: DATA_DIR, NODE_ENV: 'production' }
  })
  const win = await app.firstWindow()
  win.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !/Content Security Policy|cdn\.tldraw|NetworkError/.test(t)) {
      log('renderer>', t.slice(0, 220))
    }
  })
  await win.waitForLoadState()
  if (!(await win.locator('.node-palette').count())) {
    await win.getByRole('button', { name: /打开项目 E2E 配音验收/ }).click()
  }
  const card = win.locator('.node-card-wrap:has(.type-speech)').first()
  await card.waitFor({ timeout: 30000 })

  // ---- 1. 音色 ID 原样进配置：空格与括号不能被改写、不能被判非法 ----
  const voiceInput = card.locator('input.gen-input[placeholder^="音色 ID"]')
  await voiceInput.fill(VOICE_ID)
  await win.waitForTimeout(600)
  const echoed = await voiceInput.inputValue()
  check('输入框原样回显音色 ID', echoed === VOICE_ID, echoed)
  const warn = await card.locator('.gen-capability-note, .gen-field-error').allInnerTexts()
  check(
    '配音节点没有把 preset 音色判成非法',
    !/非法|不合法|格式/.test(warn.join(' ')),
    warn.join(' | ').slice(0, 160)
  )
  const footer = (await card.innerText()).replace(/\n+/g, ' / ')
  check('音色输入框仍在卡片可见区域内', footer.includes('音色'), footer.slice(0, 120))

  const before = await win.evaluate(async () => {
    const pid = (await window.api.listProjects()).data.find((p) => p.name === 'E2E 配音验收').id
    return { pid, media: (await window.api.listMedia(pid)).data.map((x) => x.id) }
  })
  log('media before', JSON.stringify(before.media))

  if (process.env.RUN_PAID !== '1') {
    check('（干跑）界面已就绪、未发起计费请求', true, 'RUN_PAID 未设置')
    await win.screenshot({ path: path.join(SHOT, '09-voice-id-dry.png') })
    await app.close()
    return
  }

  // ---- 2. 真实合成：MiniMax 接受这个 preset ID 才算跑通 ----
  await card.locator('[aria-label="运行节点"]').click()
  let asset = null
  const deadline = Date.now() + 180000
  for (let round = 0; Date.now() < deadline; round += 1) {
    await win.waitForTimeout(2000)
    const snap = await win.evaluate(
      async ({ pid, seen }) => (await window.api.listMedia(pid)).data.filter((x) => !seen.includes(x.id)),
      { pid: before.pid, seen: before.media }
    )
    if (round % 5 === 0 || snap.length) {
      log('round', round, 'fresh', snap.length, 'card', (await card.innerText()).replace(/\n+/g, ' / ').slice(0, 120))
    }
    if (snap.length) {
      asset = snap[snap.length - 1]
      break
    }
    const t = await card.innerText()
    if (/失败|异常/.test(t) && round > 3) {
      check('用该音色合成成功', false, t.replace(/\n+/g, ' / ').slice(0, 300))
      break
    }
  }
  check('新音频入库', asset && asset.kind === 'audio', JSON.stringify(asset && { id: asset.id, size: asset.sizeBytes, mime: asset.mime }))
  if (!asset) throw new Error('没有产出音频资产')
  const abs = path.join(DATA_DIR, asset.path)
  const size = fs.statSync(abs).size
  const { stdout } = await probe('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name:format=duration',
    '-of', 'default=noprint_wrappers=1', abs
  ])
  const seconds = Number(/duration=([\d.]+)/.exec(stdout)?.[1] ?? '0')
  check('ffprobe 能解码且有时长', seconds > 0.4, `${seconds}s / ${size} B`)
  const toast = await win.locator('.global-toast').first().innerText().catch(() => '')
  check('运行提示为完成', /已完成/.test(toast), toast)
  await win.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  await win.waitForTimeout(1200)
  const audioNodes = await win.locator('.node-card-wrap:has(.type-audio)').count()
  const players = await win.locator('.node-card-wrap:has(.type-audio) audio').count()
  check('两条产物各自成节点并渲染播放器', audioNodes >= 2 && players >= 2, `${audioNodes} 节点 / ${players} 播放器`)
  await win.screenshot({ path: path.join(SHOT, '10-voice-id-done.png') })

  // ---- 3. 磁盘真值：voiceId 必须与用户填的逐字符相同 ----
  const persisted = await win.evaluate(async (pid) => {
    const doc = await (async () => {
      const r = await window.api.openProject(pid)
      const s = r.data.tldrawSnapshot
      return typeof s === 'string' ? JSON.parse(s) : s
    })()
    const list = Object.values(doc.store || doc)
    const shapes = list.filter((v) => v && v.props && typeof v.props === 'object' && 'nodeType' in v.props)
    const speech = shapes.find((s) => s.props.nodeType === 'speech')
    return {
      voiceId: JSON.parse(speech.props.config || '{}').voiceId ?? null,
      resultCount: JSON.parse(speech.meta.nodeResult || '{}').results.length,
      audioCount: shapes.filter((s) => s.props.nodeType === 'audio').length
    }
  }, before.pid)
  log('persisted', JSON.stringify(persisted))
  check('落盘的 voiceId 与输入逐字符相同', persisted.voiceId === VOICE_ID, JSON.stringify(persisted.voiceId))
  check('两次运行都进了结果集合', persisted.resultCount >= 2, persisted.resultCount)

  await win.reload()
  await win.waitForLoadState()
  if (await win.locator('[aria-label^="打开项目"]').count()) {
    await win.getByRole('button', { name: /打开项目 E2E 配音验收/ }).click()
  }
  await win.locator('.node-card-wrap:has(.type-speech)').waitFor({ timeout: 30000 })
  const afterVoice = await win
    .locator('.node-card-wrap:has(.type-speech) input.gen-input[placeholder^="音色 ID"]')
    .first()
    .inputValue()
  check('重载后音色 ID 仍是原值', afterVoice === VOICE_ID, afterVoice)
  await win.screenshot({ path: path.join(SHOT, '11-voice-id-reload.png') })
  await app.close()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log('\n==== SUMMARY ====')
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.log('\n==== SUMMARY（异常中断）====')
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
    console.error('[voice] ABORT:', e.message)
    process.exit(2)
  })
