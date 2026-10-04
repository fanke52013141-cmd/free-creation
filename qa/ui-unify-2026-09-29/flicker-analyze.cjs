/* eslint-disable @typescript-eslint/no-require-imports */
// 逐帧差分分析（高分辨率）：闪烁 = 某帧与前帧、后帧差异都大，而前后帧彼此接近。
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const DIR = __dirname
const W = 512
const H = 288

async function launch() {
  for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try {
      return await chromium.launch({ ...options, headless: true })
    } catch (e) {
      /* try next */
    }
  }
  throw new Error('no browser')
}

async function main() {
  const browser = await launch()
  const page = await browser.newPage()
  const passes = { old: 'flick-a-old-', dots: 'flick-b-dots-', dots_noblur: 'flick-c-noblur-' }
  const lum = async (file) => {
    const b64 = fs.readFileSync(path.join(DIR, file)).toString('base64')
    return page.evaluate(
      ({ b64, w, h }) =>
        new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            const c = document.createElement('canvas')
            c.width = w
            c.height = h
            const ctx = c.getContext('2d')
            ctx.drawImage(img, 0, 0, w, h)
            const d = ctx.getImageData(0, 0, w, h).data
            const out = new Array(w * h)
            for (let i = 0; i < w * h; i += 1) {
              out[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 2550
            }
            resolve(out)
          }
          img.src = `data:image/jpeg;base64,${b64}`
        }),
      { b64, w: W, h: H }
    )
  }
  const dist = (a, b) => {
    let s = 0
    for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i])
    return s / a.length
  }
  const report = {}
  for (const [pass, prefix] of Object.entries(passes)) {
    const files = fs
      .readdirSync(DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.jpg'))
      .sort()
    if (files.length < 3) continue
    const subset = files.filter((f, i) => i % 2 === 0)
    const lums = []
    for (const f of subset) lums.push(await lum(f))
    const consec = []
    for (let i = 1; i < lums.length; i += 1) consec.push(dist(lums[i - 1], lums[i]))
    const sorted = [...consec].sort((a, b) => a - b)
    const flashes = []
    for (let i = 1; i < lums.length - 1; i += 1) {
      const a = dist(lums[i - 1], lums[i])
      const b = dist(lums[i], lums[i + 1])
      const skip = dist(lums[i - 1], lums[i + 1])
      const score = Math.min(a, b) - skip
      if (score > 1.5 && a > 2 && b > 2) {
        flashes.push({ frame: i, a: +a.toFixed(2), b: +b.toFixed(2), skip: +skip.toFixed(2) })
      }
    }
    report[pass] = {
      frames: lums.length,
      consec_p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
      consec_p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      consec_max: +sorted[sorted.length - 1].toFixed(2),
      spikes_gt3: consec.filter((c) => c > 3).length,
      flash_frames: flashes.slice(0, 8)
    }
    console.log(pass, JSON.stringify(report[pass]))
  }
  fs.writeFileSync(path.join(DIR, 'flicker-analysis.json'), JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
