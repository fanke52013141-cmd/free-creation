/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 一次性真机验收（scratch，不入库、不提交）：复用上一轮已经真实合成的产物，
// 零计费地核对「配音」运行后的三件事：产物节点渲染播放器、meta 写进文档真值、重载后仍在。
//
// 只 mock 数据目录（CANVAS_DATA_DIR 指向上一轮的临时目录），绝不碰用户真实库、绝不发起请求。
const { _electron } = require('playwright')
const fs = require('fs')
const path = require('path')

const ROOT = 'D:/Program Files (x86)/free-creation'
const DATA_DIR = process.env.E2E_DATA_DIR
const PROJECT_NAME = 'E2E 配音验收'

const results = []
const log = (...a) => console.log('[recheck]', ...a)
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
    if (m.type() === 'error') log('renderer>', m.text().slice(0, 200))
  })
  await win.waitForLoadState()

  // 应用会自动恢复上次打开的项目；只有落在项目列表页时才需要点开。
  if (!(await win.locator('.node-palette').count())) {
    await win.getByRole('button', { name: new RegExp(`打开项目 ${PROJECT_NAME}`) }).click()
  }
  await win.locator('.node-card-wrap:has(.type-speech)').waitFor({ timeout: 30000 })

  // ---- 1. 产物节点：配音的 out-audio 落成独立 audio 资产节点，并真的渲染播放器 ----
  await win.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  await win.waitForTimeout(1200)
  const speechCard = win.locator('.node-card-wrap:has(.type-speech)').first()
  const speechText = (await speechCard.innerText()).replace(/\n+/g, ' / ')
  const audioNodes = await win.locator('.node-card-wrap:has(.type-audio)').count()
  check('配音产物落成独立资产节点', audioNodes > 0, `${audioNodes} 个 type-audio 节点`)
  const audioCard = win.locator('.node-card-wrap:has(.type-audio)').first()
  const audioEl = await audioCard.locator('audio').count()
  check('资产节点渲染音频播放器', audioEl > 0, `${audioEl} 个 <audio>`)
  const src = await audioCard.locator('audio').first().getAttribute('src')
  const srcPath = decodeURIComponent((src || '').replace(/^media:\/\/\/?/, ''))
  const abs = path.join(DATA_DIR, srcPath)
  check('播放器指向已落盘文件', fs.existsSync(abs), `${src} -> ${abs}`)
  const duration = await audioCard
    .locator('audio')
    .first()
    .evaluate((el) => new Promise((r) => setTimeout(() => r(el.duration), 1500)))
  check('播放器解出时长', Number.isFinite(duration) && duration > 0.4, `${duration}s`)
  const title = await audioCard.locator('.node-title, h3, .card-title').first().innerText()
  log('artifact node title', title)
  check(
    '产物节点记住生产关系',
    /配音|产物|今天天气/.test(speechText + title),
    `${title} / ${speechText.slice(0, 80)}`
  )
  await win.screenshot({ path: path.join(ROOT, 'artifacts/e2e-2026-09-19/06-artifact-player.png') })

  // ---- 2. 文档真值：nodeResult 写进快照，且 meta 里没有任何 undefined 键 ----
  const persisted = await win.evaluate(async () => {
    const pid = (await window.api.listProjects()).data.find((p) => p.name === 'E2E 配音验收').id
    const r = await window.api.openProject(pid)
    // tldrawSnapshot 是 unknown：真实主进程存的是结构化对象，浏览器 mock 才存字符串。
    const snap = r.data.tldrawSnapshot
    const doc = typeof snap === 'string' ? JSON.parse(snap) : snap
    const buckets = [doc.store, doc.records, doc].filter(Boolean)
    const shapes = []
    for (const b of buckets) {
      const list = Array.isArray(b) ? b : Object.values(b)
      // 序列化的 tldraw 记录是 { typeName:'shape', type:'node-card', props, meta }；
      // 节点身份在 props.nodeType 上，不能用 type 去比形状名。
      for (const v of list) {
        if (v && typeof v === 'object' && v.props && typeof v.props === 'object' && 'nodeType' in v.props) {
          shapes.push(v)
        }
      }
      if (shapes.length) break
    }
    const speech = shapes.find((s) => s.props.nodeType === 'speech')
    const audio = shapes.find((s) => s.props.nodeType === 'audio')
    const undefinedKeys = speech && speech.meta ? Object.keys(speech.meta).filter((k) => speech.meta[k] === undefined) : []
    return {
      speechResult: speech && speech.meta ? speech.meta.nodeResult : null,
      speechRunStatus: speech && speech.meta ? (speech.meta.nodeRun || {}).status : null,
      hasNodeExtra: Boolean(speech && speech.meta && 'nodeExtra' in speech.meta),
      speechMetaKeys: speech && speech.meta ? Object.keys(speech.meta) : [],
      undefinedKeys,
      audioMediaId: audio && audio.props ? audio.props.mediaId : null,
      audioProducer: audio && audio.meta ? audio.meta.artifactProducerId : null,
      speechShapeId: speech ? speech.id : null
    }
  })
  log('persisted', JSON.stringify(persisted).slice(0, 700))
  check('快照里配音节点有 nodeResult', Boolean(persisted.speechResult), String(persisted.speechResult).slice(0, 160))
  check('运行记录状态为成功', persisted.speechRunStatus === 'success', persisted.speechRunStatus)
  check('本次无字幕 ⇒ nodeExtra 键被删除而非留 undefined', !persisted.hasNodeExtra && persisted.undefinedKeys.length === 0, JSON.stringify(persisted.undefinedKeys))
  check(
    '产物节点写回同一份 mediaId 且溯源到配音节点',
    Boolean(persisted.audioMediaId && persisted.audioProducer === persisted.speechShapeId),
    `${persisted.audioMediaId} <- ${persisted.audioProducer}`
  )

  // ---- 3. 持久化：整窗重载后播放器与结果仍在 ----
  await win.reload()
  await win.waitForLoadState()
  if (await win.locator('[aria-label^="打开项目"]').count()) {
    await win.getByRole('button', { name: new RegExp(`打开项目 ${PROJECT_NAME}`) }).click()
  }
  await win.locator('.node-card-wrap:has(.type-audio)').waitFor({ timeout: 30000 })
  await win.getByRole('button', { name: '适配画布（缩放到所有节点）', exact: true }).click()
  await win.waitForTimeout(1500)
  const afterAudio = await win.locator('.node-card-wrap:has(.type-audio) audio').count()
  check('重载后播放器仍在', afterAudio > 0, `${afterAudio} 个 <audio>`)
  const afterText = (await win.locator('.node-card-wrap:has(.type-speech)').first().innerText()).replace(/\n+/g, ' / ')
  check('重载后配音卡片未回到空态', !/选择语音模型…\s*$/.test(afterText) && !/失败/.test(afterText), afterText.slice(-160))
  await win.screenshot({ path: path.join(ROOT, 'artifacts/e2e-2026-09-19/07-after-reload.png') })

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
    console.error('[recheck] ABORT:', e.message)
    process.exit(2)
  })
