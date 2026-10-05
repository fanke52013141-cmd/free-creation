/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas')
const fs = require('node:fs')
const path = require('node:path')
const dir = path.resolve(__dirname, '../artifacts/node-review-2026-10-06')
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const fontPath = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts/msyh.ttc')
if (fs.existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, 'ReviewFont')
const labels = ['initial', 'contentState', 'ioInput', 'ioOutput']
const titles = ['01 · 初始空态', '02 · 内容样例态（非实际运行）', '03 · 输入输出说明（输入区）', '04 · 输入输出说明（输出区）']
const runtimePrefixes = {
  text: ['text-'], json: ['json-'], processor: ['processor-'], structured: ['structured-'],
  storyboard: ['storyboard-'], code: ['code-'], iterate: ['iterate-', 'p3-'], image: ['image-'],
  'image-crop': ['image-reload', 'director-reload'], 'image-split': ['split-'], file: ['file-', 'document-'],
  'video-asset': ['video-asset-'], 'video-frame': ['video-frame-'], 'video-clip': ['video-clip-'],
  'video-depth': ['video-ai-depth-', 'video-ai-reload'], 'video-clay': ['video-ai-clay-', 'video-ai-reload'],
  audio: ['vocal-separate-retired'], 'sound-adjust': ['sound-adjust-'], website: ['website-'], director: ['director-']
}
function runtimeEvidence(type) {
  const prefixes = runtimePrefixes[type] || []
  const runs = ['full', 'targeted-pass3', 'documents2', 'audio-final', 'sound-final2']
  const links = runs.flatMap(run => {
    const relative = `../node-remediation-2026-10-06/${run}`
    const folder = path.resolve(dir, relative)
    if (!fs.existsSync(folder)) return []
    return fs.readdirSync(folder).filter(file => /\.png$/.test(file) && prefixes.some(prefix => file.replace(/^\d+-/, '').startsWith(prefix)))
      .map(file => `<a href="${relative}/${file}">${run}/${file}</a>`)
  })
  const paid = {
    chat: 'paid-text-nodes.png', 'ai-process': 'paid-text-nodes.png',
    speech: 'paid-voice-nodes.png', 'voice-design': 'paid-voice-nodes.png',
    'image-edit': 'paid-image-node.png', 'image-gen': 'paid-image-generation-retry.png',
    tts: 'paid-clone-retry.png'
  }[type]
  if (paid && fs.existsSync(path.resolve(dir, '../node-remediation-2026-10-06', paid))) {
    links.push(`<a href="../node-remediation-2026-10-06/${paid}">真实供应商节点链路：${paid}</a>`)
  }
  return links.join('<br>') || '没有实际运行截图；样例态不能证明模型服务成功'
}
;(async () => {
  for (let index = 0; index < labels.length; index++) {
    const canvas = createCanvas(1280, 1780)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#f3f4f6'
    ctx.font = 'bold 30px ReviewFont, sans-serif'
    ctx.fillText(titles[index], 24, 42)
    for (let item = 0; item < manifest.nodes.length; item++) {
      const node = manifest.nodes[item]
      const image = await loadImage(path.join(dir, node.screenshots[labels[index]]))
      const x = 20 + (item % 4) * 315
      const y = 64 + Math.floor(item / 4) * 240
      const maxW = 300
      const maxH = 202
      const scale = Math.min(maxW / image.width, maxH / image.height)
      const width = image.width * scale
      const height = image.height * scale
      ctx.fillStyle = '#20252d'
      ctx.fillRect(x, y, 300, 232)
      ctx.drawImage(image, x + (maxW - width) / 2, y + 4, width, height)
      ctx.fillStyle = '#e5e7eb'
      ctx.font = '16px ReviewFont, sans-serif'
      ctx.fillText(`${String(item + 1).padStart(2, '0')} ${node.label} · ${node.type}`, x + 9, y + 222)
    }
    fs.writeFileSync(path.join(dir, `contact-${labels[index]}.png`), canvas.toBuffer('image/png'))
  }
  const rows = manifest.nodes.map(node => `<tr><td>${node.label}</td><td>${node.type}<br>${node.mediaFixtureImported ? `已导入媒体${node.mediaDecoded === true ? '，已解码' : ''}` : node.representativeContentProvided ? '配置/内容 fixture' : '仅空态，无内容 fixture'}</td>${labels.map(key => `<td><a href="${node.screenshots[key]}"><img src="${node.screenshots[key]}" loading="lazy"></a></td>`).join('')}<td>${runtimeEvidence(node.type)}</td></tr>`).join('\n')
  const html = `<!doctype html><meta charset="utf-8"><title>28 节点截图审查</title><style>body{background:#11151b;color:#e5e7eb;font:14px system-ui;margin:24px}table{border-collapse:collapse}th,td{border:1px solid #3a414b;padding:8px;vertical-align:top}th{position:sticky;top:0;background:#222831}img{max-width:340px;max-height:280px;object-fit:contain;background:#20252d}td:first-child{white-space:nowrap}</style><h1>28 个节点状态与 I/O 截图</h1><p>内容样例态仅用于界面审查；真实运行结论见 runtime-matrix.json 和报告。</p><table><thead><tr><th>节点</th><th>ID</th><th>初始态</th><th>内容样例态</th><th>输入说明</th><th>输出说明</th></tr></thead><tbody>${rows}</tbody></table>`
  fs.writeFileSync(path.join(dir, 'index.html'), html.replace('<th>输出说明</th>', '<th>输出说明</th><th>实际桌面阶段截图（结果以日志为准）</th>'))
  console.log(`Created 4 contact sheets and gallery for ${manifest.total} nodes`)
})().catch(error => { console.error(error); process.exitCode = 1 })
