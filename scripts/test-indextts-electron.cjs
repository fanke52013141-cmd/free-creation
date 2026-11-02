/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 本地 IndexTTS 2.5 真机验收（Electron + 真实 Python/权重/显卡）
//
// 覆盖用户需求：语音合成里能选到「本地 · IndexTTS 2.5」，上传参考音频，点生成得到 wav。
// 运行：node scripts/test-indextts-electron.cjs（本机需已装 indextts 与 2.5 权重，约 1 分钟）
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-indextts-data-'))
  const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-indextts-ref-'))
  const shotDir = path.join(ROOT, 'qa', `indextts-electron-${Date.now()}`)
  fs.mkdirSync(shotDir, { recursive: true })
  const reference = path.join(refDir, '参考音色.wav')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-ar', '22050', reference
  ])

  const env = { ...process.env, CANVAS_DATA_DIR: dataDir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', ROOT],
    cwd: ROOT,
    env,
    timeout: 120_000
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForLoadState('domcontentloaded')
  const shot = (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) })

  try {
    await app.evaluate(({ dialog }) => {
      global.__files = []
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: global.__files })
    })
    await app.evaluate((_e, files) => {
      global.__files = files
    }, [reference])

    await page.getByRole('button', { name: '新建项目' }).first().click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill('IndexTTS 真机验收')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.node-palette').waitFor({ timeout: 60_000 })
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })

    await page.getByRole('button', { name: '展开声音创作节点', exact: true }).click()
    await page.getByRole('button', { name: '添加语音合成节点', exact: true }).click()
    const card = page.locator('.node-card-wrap:has(.type-speech)').first()
    await card.waitFor()
    await page.keyboard.press('Escape')
    check('语音合成节点可创建', true)

    // 切到本地 IndexTTS 通道
    const select = card.locator('[aria-label="语音合成供应商"]')
    await select.click()
    await page.getByRole('option', { name: /本地 · IndexTTS 2\.5/ }).click()
    await page.waitForTimeout(500)
    const runtimeRow = card.locator('[data-testid="indextts-runtime"]')
    await runtimeRow.waitFor()
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="indextts-runtime"]')
        return Boolean(el && el.textContent && el.textContent.includes('已就绪'))
      },
      undefined,
      { timeout: 60_000 }
    )
    check('切换到本地 IndexTTS 后运行时探测为已就绪', true, (await runtimeRow.innerText()).replace(/\s+/g, ' ').trim())
    await shot('01-indextts-backend')

    // 参考音频上传
    await card.getByRole('button', { name: '上传参考音频', exact: true }).click()
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.node-card.type-speech .speech-reference-section')
        return Boolean(el && el.textContent && el.textContent.includes('参考音色'))
      },
      undefined,
      { timeout: 60_000 }
    )
    check('参考音频上传后显示文件名', true)
    await shot('02-reference-uploaded')

    // 朗读文本 + 生成
    await card.locator('textarea[aria-label="朗读文本"]').fill('你好，这是本地语音合成的真机验收。')
    const mediaRootForCount = path.join(dataDir, 'projects')
    const listWavs = () => {
      const found = []
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/\.wav$/i.test(entry.name)) found.push(full)
        }
      }
      if (fs.existsSync(mediaRootForCount)) walk(mediaRootForCount)
      return found
    }
    const wavsBefore = new Set(listWavs())
    const startedAt = Date.now()
    await card.getByRole('button', { name: /合成语音|合成中/ }).first().click()
    await page.waitForFunction(
      // 合成结果按节点契约落成独立音频资产节点（emitArtifact），不在语音节点内部。
      () => document.querySelectorAll('.node-card-wrap .type-audio').length > 0,
      undefined,
      { timeout: 300_000 }
    )
    const elapsed = Date.now() - startedAt
    const artifact = page.locator('.node-card-wrap:has(.type-audio)').first()
    await artifact.waitFor({ timeout: 10_000 })
    check('本地合成产出音频并生成独立音频资产节点', true, `耗时 ${Math.round(elapsed / 1000)}s`)
    await shot('03-synthesized')

    // 磁盘侧核对：本次新增的那条 wav 必须是 22.05kHz 单声道
    const producedFiles = listWavs().filter((file) => !wavsBefore.has(file))
    const probe = (file) => {
      const out = execFileSync(
        'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
        { encoding: 'utf8' }
      )
      return JSON.parse(out)
    }
    const produced = producedFiles.map((file) => ({ file, info: probe(file) }))[0]
    const stream = produced?.info.streams?.find((s) => s.codec_type === 'audio')
    check(
      '成片是 22050Hz 单声道 wav',
      Boolean(produced) && Number(stream?.sample_rate) === 22050 && Number(stream?.channels) === 1,
      JSON.stringify({
        file: produced && path.basename(produced.file),
        sampleRate: stream?.sample_rate,
        channels: stream?.channels,
        duration: produced?.info.format?.duration
      })
    )
  } catch (error) {
    check('验收脚本执行未中断', false, error instanceof Error ? error.message : String(error))
    await page.screenshot({ path: path.join(shotDir, 'error.png') }).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\n截图目录：${shotDir}`)
  console.log(`结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    for (const item of failed) console.log(` - ${item.name}${item.detail ? `：${item.detail}` : ''}`)
    process.exitCode = 1
  }
}

void main()
