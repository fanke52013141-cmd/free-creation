/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 一次性真机验收（scratch，不入库、不提交）：配音节点音色**留空**跑一条真实合成，
// 验证产物溯源记的是网关兜底之后的实际音色 `male-qn-qingse`，而不是节点上的空值，
// 并且这个值在资产面板 tooltip / 关键词搜索 / 整窗重载之后都还在。
//
// 复用前面的隔离库（MiniMax 供应商与密钥已在里面）。本脚本不接触密钥。
const { _electron } = require('playwright')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

const probe = promisify(execFile)
const ROOT = 'D:/Program Files (x86)/free-creation'
const DATA_DIR = process.env.E2E_DATA_DIR
const PROJECT = 'E2E 配音验收'
const EXPECTED_FALLBACK = 'male-qn-qingse'
const SHOT = path.join(ROOT, 'artifacts/e2e-2026-09-19')

const results = []
const log = (...a) => console.log('[blank]', ...a)
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

/** 读磁盘上的节点卡：语音节点的 config.voiceId、结果集合逐条、以及产物节点数。 */
async function readDisk(win, pid) {
  return win.evaluate(
    async ({ pid }) => {
      // 真实主进程存的是结构化对象，浏览器 mock 才存字符串；两种都要能读。
      const obj = (v) => {
        if (v === undefined || v === null || v === '') return {}
        return typeof v === 'string' ? JSON.parse(v) : v
      }
      const r = await window.api.openProject(pid)
      const s = r.data.tldrawSnapshot
      const doc = typeof s === 'string' ? JSON.parse(s) : s
      const shapes = Object.values(doc.store || doc).filter(
        (v) => v && v.props && typeof v.props === 'object' && 'nodeType' in v.props
      )
      const speech = shapes.find((x) => x.props.nodeType === 'speech')
      const collection = obj(speech.meta.nodeResult)
      return {
        configVoiceId: obj(speech.props.config).voiceId ?? null,
        textLength: (speech.props.text || '').trim().length,
        selectedMediaId: collection.selectedMediaId ?? null,
        results: collection.results || [],
        runStatus: obj(speech.meta.nodeRun).status ?? null,
        audioNodes: shapes.filter((x) => x.props.nodeType === 'audio').length
      }
    },
    { pid }
  )
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
    await win.getByRole('button', { name: new RegExp(`打开项目 ${PROJECT}`) }).click()
  }
  const card = win.locator('.node-card-wrap:has(.type-speech)').first()
  await card.waitFor({ timeout: 30000 })
  const voiceInput = card.locator('input.gen-input[placeholder^="音色 ID"]')
  const pid = await win.evaluate(
    async (name) => (await window.api.listProjects()).data.find((p) => p.name === name).id,
    PROJECT
  )

  // ---- 1. 把音色清空：这是本轮唯一要验的前置状态 ----
  const beforeDisk = await readDisk(win, pid)
  check('上一轮留下的文本仍在（不必新写正文）', beforeDisk.textLength > 0, beforeDisk.textLength)
  // 只作记录：上一轮磁盘上的音色是什么不影响本轮断言，真正的对照是本轮跑完后的空配置。
  log('上一轮持久化音色 =', JSON.stringify(beforeDisk.configVoiceId))
  const idsBefore = (
    await win.evaluate(async (p) => (await window.api.listMedia(p)).data.map((x) => x.id), pid)
  ).length

  await voiceInput.fill('')
  await win.waitForTimeout(900)
  const echoed = await voiceInput.inputValue()
  check('音色输入框已清空', echoed === '', JSON.stringify(echoed))
  const placeholder = await voiceInput.getAttribute('placeholder')
  check(
    '占位文案点明 MiniMax 的兜底音色，而不是含糊的「服务端默认」',
    placeholder.includes(EXPECTED_FALLBACK),
    placeholder
  )
  await win.screenshot({ path: path.join(SHOT, '12-voice-blank-ready.png') })

  if (process.env.RUN_PAID !== '1') {
    check('（干跑）界面已就绪、未发起计费请求', true, 'RUN_PAID 未设置')
    await app.close()
    return
  }

  const mediaBefore = await win.evaluate(async (p) => (await window.api.listMedia(p)).data.map((x) => x.id), pid)

  // ---- 2. 真实合成一次 ----
  await card.locator('[aria-label="运行节点"]').click()
  let asset = null
  const deadline = Date.now() + 180000
  for (let round = 0; Date.now() < deadline; round += 1) {
    await win.waitForTimeout(2000)
    const fresh = await win.evaluate(
      async ({ p, seen }) => (await window.api.listMedia(p)).data.filter((x) => !seen.includes(x.id)),
      { p: pid, seen: mediaBefore }
    )
    if (round % 5 === 0 || fresh.length) {
      log('round', round, 'fresh', fresh.length, 'card', (await card.innerText()).replace(/\n+/g, ' / ').slice(0, 110))
    }
    if (fresh.length) {
      asset = fresh[fresh.length - 1]
      break
    }
    const t = await card.innerText()
    if (/失败|异常/.test(t) && round > 3) {
      check('留空也能合成成功', false, t.replace(/\n+/g, ' / ').slice(0, 300))
      break
    }
  }
  check('留空状态下合成成功并产出音频', asset && asset.kind === 'audio', JSON.stringify(asset && { id: asset.id, size: asset.sizeBytes, mime: asset.mime }))
  if (!asset) throw new Error('没有产出音频资产')
  const abs = path.join(DATA_DIR, asset.path)
  const { stdout } = await probe('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name:format=duration',
    '-of', 'default=noprint_wrappers=1', abs
  ])
  const seconds = Number(/duration=([\d.]+)/.exec(stdout)?.[1] ?? '0')
  check('ffprobe 能解码且有时长', seconds > 0.4, `${seconds}s / ${fs.statSync(abs).size} B`)

  // ---- 3. 磁盘真值：节点上空，产物上记了兜底音色 ----
  await win.waitForTimeout(1500)
  const disk = await readDisk(win, pid)
  log('disk', JSON.stringify({ configVoiceId: disk.configVoiceId, runStatus: disk.runStatus, n: disk.results.length }))
  check('节点配置里音色确实是空（排除输入框残留）', disk.configVoiceId === '', JSON.stringify(disk.configVoiceId))
  check('运行记录成功', disk.runStatus === 'success', disk.runStatus)
  const last = disk.results[disk.results.length - 1]
  check('本次产物在结果集合里', last && last.mediaId === (disk.selectedMediaId ?? asset.id), JSON.stringify(last && { mediaId: last.mediaId, sel: disk.selectedMediaId }))
  check('这条产物记的实际音色 = MiniMax 系统音色', last && last.voiceId === EXPECTED_FALLBACK, JSON.stringify(last && last.voiceId))
  const withVoice = disk.results.filter((x) => typeof x.voiceId === 'string')
  check('历史条目没有因为新字段被改写或补齐', withVoice.length === 1, `${withVoice.length}/${disk.results.length} 条有 voiceId`)
  check('结果集合是逐条记录而非节点级单值', new Set(disk.results.map((x) => x.mediaId)).size === disk.results.length, disk.results.length)

  // ---- 4. UI 消费面：来源 tooltip 与关键词搜索 ----
  await win.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  await win.waitForTimeout(1000)
  await win.locator('button[aria-label="打开资产管理"]').click()
  await win.locator('.assets-panel').waitFor({ timeout: 15000 })
  const titles = await win.$$eval('.asset-card .asset-source', (els) =>
    els.map((e) => e.getAttribute('title') || '')
  )
  check(
    '资产卡片来源 tooltip 显示该音色',
    titles.some((t) => t.includes(EXPECTED_FALLBACK)),
    titles.filter((t) => t.includes(EXPECTED_FALLBACK))[0] || titles.slice(0, 2).join(' | ')
  )
  const search = win.locator('.assets-search')
  await search.fill(EXPECTED_FALLBACK)
  await win.waitForTimeout(600)
  const hits = await win.locator('.asset-card').count()
  check('按音色名能搜到该产物', hits >= 1, `${hits} 个命中`)
  await search.fill('male-qn-qingseXYZ')
  await win.waitForTimeout(600)
  const negative = await win.locator('.asset-card').count()
  check('反向锚定：不存在的音色名搜不到东西', negative === 0, `${negative} 个命中`)
  await search.fill('')
  await win.waitForTimeout(400)
  await win.screenshot({ path: path.join(SHOT, '13-voice-blank-assets.png') })

  // ---- 5. 整窗重载后仍然成立 ----
  await win.reload()
  await win.waitForLoadState()
  if (await win.locator('[aria-label^="打开项目"]').count()) {
    await win.getByRole('button', { name: new RegExp(`打开项目 ${PROJECT}`) }).click()
  }
  await win.locator('.node-card-wrap:has(.type-speech)').waitFor({ timeout: 30000 })
  const after = await readDisk(win, pid)
  const afterLast = after.results[after.results.length - 1]
  check('重载后该产物的音色仍是兜底值', afterLast && afterLast.voiceId === EXPECTED_FALLBACK, JSON.stringify(afterLast && afterLast.voiceId))
  check('重载后音频产物节点各自渲染播放器', (await win.locator('.node-card-wrap:has(.type-audio) audio').count()) >= 1, after.audioNodes)
  await win.screenshot({ path: path.join(SHOT, '14-voice-blank-reload.png') })
  log('media count', idsBefore, '->', await win.evaluate(async (p) => (await window.api.listMedia(p)).data.length, pid))
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
    console.error('[blank] ABORT:', e.message)
    process.exit(2)
  })
