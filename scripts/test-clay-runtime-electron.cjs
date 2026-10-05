/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { _electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, process.env.CLAY_RUNTIME_OUTPUT || 'artifacts/clay-optimization-2026-10-06')
const data = path.join(process.env.LOCALAPPDATA || os.tmpdir(), `canvas-clay-cancel-${Date.now()}`)
const installed = path.join(process.env.APPDATA, 'canvas-studio/data/video-conversion')

function workerIds() {
  const prefix = data.replaceAll("'", "''")
  const script = `@(Get-CimInstance Win32_Process -Filter "name='python.exe'" | Where-Object {$_.CommandLine -like '*${prefix}*' -and $_.CommandLine -like '*runner.py*'} | ForEach-Object {$_.ProcessId}) | ConvertTo-Json -Compress`
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }).toString().trim()
  if (!raw) return []
  const result = JSON.parse(raw)
  return Array.isArray(result) ? result : [result]
}

;(async () => {
  fs.mkdirSync(output, { recursive: true })
  fs.mkdirSync(path.join(data, 'video-conversion'), { recursive: true })
  for (const name of ['models', 'python-env']) fs.symlinkSync(path.join(installed, name), path.join(data, 'video-conversion', name), 'junction')
  fs.copyFileSync(path.join(installed, 'ready.json'), path.join(data, 'video-conversion/ready.json'))
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env: { ...process.env, CANVAS_DATA_DIR: data, NODE_ENV: 'production' } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '新建项目' }).click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill('白模取消与兼容验收')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.node-palette').waitFor()
    const source = path.join(output, 'runtime-av.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(output, 'source-sample.mp4'), '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', source], { windowsHide: true })
    const imported = await page.evaluate(async source => {
      const projectId = (await window.api.listProjects()).data.find(project => project.name === '白模取消与兼容验收').id
      const response = await window.api.importMedia({ projectId, paths: [source] })
      if (!response.ok) throw new Error(response.error.message)
      return { projectId, sourceMediaId: response.data.assets[0].id }
    }, source)
    await page.evaluate(input => {
      window.__clayCancel = window.api.convertVideoClay({ ...input, jobId: 'clay-cancel-active', config: { version: 2, quality: 'fine', maxResolution: 1024 } })
      window.__clayQueued = window.api.convertVideoClay({ ...input, jobId: 'clay-cancel-queued', config: { version: 2, quality: 'fast', maxResolution: 512 } })
    }, imported)
    let before = []
    for (let attempt = 0; attempt < 20; attempt++) {
      before = workerIds()
      if (before.length >= 2) break
      await page.waitForTimeout(250)
    }
    assert.ok(before.length >= 2, 'must observe the launcher and actual worker before cancellation')
    await page.evaluate(async () => {
      await window.api.cancelVideoConversion('clay-cancel-queued')
      await window.api.cancelVideoConversion('clay-cancel-active')
    })
    const cancelled = await page.evaluate(async () => Promise.all([window.__clayCancel, window.__clayQueued]))
    assert.ok(cancelled.every(response => !response.ok && response.error.message === '已取消'))
    assert.deepEqual(workerIds(), [], 'CUDA worker must not survive launcher cancellation')
    const legacy = await page.evaluate(async input => window.api.convertVideoClay({ ...input, jobId: 'clay-legacy-after-cancel', config: { version: 1, maxResolution: 512, reliefStrength: 1.5, preserveAudio: true } }), imported)
    assert.ok(legacy.ok, 'queue must continue and the original renderer must still work')
    const file = path.join(data, legacy.data.path)
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true })
    fs.copyFileSync(file, path.join(output, 'clay-legacy-worker.mp4'))
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,nb_frames:format=duration', '-of', 'json', file], { windowsHide: true }).toString())
    assert.ok(streams.streams.some(stream => stream.codec_type === 'audio'), 'legacy path must preserve source audio')
    assert.ok(streams.streams.some(stream => stream.codec_type === 'video' && Number(stream.nb_frames) === 24))
    const modernStreams = []
    for (const preserveAudio of [true, false]) {
      const modern = await page.evaluate(async ({ input, preserveAudio }) => window.api.convertVideoClay({ ...input,
        jobId: `clay-modern-${preserveAudio}`, config: { version: 2, quality: 'fast', maxResolution: 512, preserveAudio } }), { input: imported, preserveAudio })
      assert.ok(modern.ok)
      assert.notEqual(modern.data.id, legacy.data.id)
      const modernFile = path.join(data, modern.data.path)
      execFileSync('ffmpeg', ['-v', 'error', '-i', modernFile, '-f', 'null', '-'], { windowsHide: true })
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,nb_frames:format=duration', '-of', 'json', modernFile], { windowsHide: true }).toString())
      assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), preserveAudio)
      assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && Number(stream.nb_frames) === 24))
      modernStreams.push({ preserveAudio, decoded: true, probe })
      fs.copyFileSync(modernFile, path.join(output, `clay-modern-audio-${preserveAudio}.mp4`))
    }
    assert.deepEqual(workerIds(), [])
    assert.equal(fs.readdirSync(path.join(data, 'video-conversion')).filter(name => name.startsWith('job-')).length, 0)
    fs.writeFileSync(path.join(output, 'cancel-legacy-results.json'), JSON.stringify({ activeCancelled: true, queuedCancelled: true, workerPidsBefore: before, orphanWorkers: 0, tempJobs: 0, legacyDecoded: true, streams, modernStreams }, null, 2))
    console.log('PASS cancellation, no orphan worker, queue release, v1/v2 full decode, audio on/off and temp cleanup')
  } finally { await app.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
