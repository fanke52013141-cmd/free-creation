// 用户 2026-09-18 第二轮截图反馈的落地门禁（docs/NODE_UI_SPEC.md §16 v1.2）。
//
// 这一轮的决定大多是「删掉某个覆盖」「去掉某个材质」「某个按钮不许再消失」——
// 都是**容易在后续改动里被悄悄改回去**的那类规则。这里把它们固化成源码断言：
// 不依赖浏览器、不依赖快照，改坏了立刻失败。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEXT_MERGE_SEPARATOR, mergedPrompt } from '@shared/engine/helpers'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
/** 断言「文案不再出现」时必须先剥掉注释：注释里说明历史文案是正常的。 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const foundation = read('src/renderer/src/assets/ui-foundation.css')
const surfaces = read('src/renderer/src/assets/ui-surfaces.css')
const app = read('src/renderer/src/assets/app.css')
const nodeCardView = read('src/renderer/src/canvas/NodeCardView.tsx')
const inputPreview = read('src/renderer/src/canvas/ConnectedInputPreview.tsx')
const dataEdgeLayer = read('src/renderer/src/canvas/DataEdgeLayer.tsx')
const specs = read('src/renderer/src/nodes/specs/index.tsx')
const canvasEditor = read('src/renderer/src/canvas/CanvasEditor.tsx')

describe('v1.2 §16.1 端口圆点是实色（覆盖 v1.1 磨砂玻璃珠）', () => {
  it('类型色即视觉：无 backdrop-filter、无内阴影、无 color-mix 半透明底', () => {
    expect(foundation).toMatch(/\.port-dot::after\s*\{[^}]*background:\s*var\(--pc/)
    expect(foundation).not.toMatch(/\.port-dot::after\s*\{[^}]*backdrop-filter/)
    expect(foundation).toMatch(/\.port-dot::after\s*\{[^}]*box-shadow:\s*none;/)
    expect(foundation).not.toMatch(/\.port-dot::after\s*\{[^}]*color-mix/)
    // 5px 色芯与拖线玻璃珠整体删除，避免出现第二种圆点材质。
    expect(foundation).not.toContain('.port-dot-inner')
    expect(foundation).not.toContain('.conn-cursor-glass')
  })
})

describe('v1.2 §16.2 媒体预览一律白底 + 可见边框', () => {
  it('.node-media 材质只在 ui-foundation.css 权威声明为白底 + 边框', () => {
    expect(foundation).toMatch(/\.node-media\s*\{[^}]*background:\s*#ffffff;/)
    expect(foundation).toMatch(/\.node-media\s*\{[^}]*border:\s*1px solid var\(--line\);/)
    // 旧的深色渐变面必须彻底消失，否则会再次压过白底。
    expect(foundation).not.toMatch(/\.node-media\s*\{[^}]*#15191f/)
    expect(foundation).not.toMatch(/\.node-media\s*\{[^}]*radial-gradient/)
  })

  it('app.css 只保留 .node-media 布局，不再重复声明背景（防止层叠打架）', () => {
    const block = app.match(/\.node-media\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block).not.toBe('')
    expect(block).not.toContain('background')
    expect(block).not.toContain('border:')
  })

  it('结果缩略图、拆图预览、全屏图片预览都是白底', () => {
    expect(surfaces).toMatch(/\.media-result-tile[\s\S]{0,200}?background:\s*#ffffff;/)
    expect(surfaces).toMatch(
      /\.media-preview-image \.media-preview-stage\s*\{[^}]*background:\s*#ffffff;/
    )
    expect(app).toMatch(/\.media-result-tile\s*\{[^}]*background:\s*#ffffff;/)
    expect(app).toMatch(/\.image-split-quick-grid\s*\{[^}]*background:\s*#ffffff;/)
    expect(app).toMatch(/\.image-split-preview\s*\{[^}]*background:\s*#ffffff;/)
    expect(app).toMatch(/\.reference-thumb\s*\{[^}]*background:\s*#ffffff;/)
    expect(app).toMatch(/\.reference-fullview\s*\{[^}]*background:\s*#ffffff;/)
  })
})

describe('v1.2 §16.3 运行按钮常驻，不可用时置灰', () => {
  it('运行按钮不再被 selected 门控', () => {
    expect(nodeCardView).toContain('runBlockedReason')
    expect(nodeCardView).not.toContain('{selected && spec?.executor &&')
    expect(nodeCardView).toContain('disabled={Boolean(runBlockedReason)}')
  })

  it('置灰有明确的视觉态，且原因来自契约 readiness', () => {
    expect(surfaces).toMatch(/\.node-run-btn:disabled[\s\S]{0,160}?color:/)
    expect(nodeCardView).toContain("readiness.kind === 'blocked'")
  })
})

describe('v1.2 §16.4 无必要提示语', () => {
  it('已连线但无值的输入整条不渲染，画布上不再有「等待上游输出」', () => {
    expect(inputPreview).toContain('input.value !== null')
    expect(stripComments(inputPreview)).not.toContain('等待上游输出')
    expect(stripComments(inputPreview)).not.toContain('connected-input-empty')
    expect(stripComments(app)).not.toContain('.connected-input-empty')
  })

  it('音频资产节点的说明段与视频节点的「AI 生成」小字已删除', () => {
    expect(read('src/renderer/src/nodes/specs/bodies/audio.tsx')).not.toContain('这是音频资产节点')
    expect(read('src/renderer/src/nodes/specs/bodies/video.tsx')).not.toContain(
      'MediaSourceSummary'
    )
  })
})

describe('v1.2 §16.5 媒体后续动作按钮只放文字', () => {
  it('图片节点后续按钮无图标且包含 P图', () => {
    const actions = read('src/renderer/src/nodes/specs/bodies/shared.tsx')
    const block = actions.match(/const actions: Array<\{[\s\S]*?\n {2}\]/)?.[0] ?? ''
    expect(block).not.toBe('')
    expect(block).not.toContain('icon:')
    expect(block).toContain("label: 'P图'")
  })

  it('视频节点后续按钮改名为 抽帧 / 截视频 / 截音频 / 截人声 且无图标', () => {
    const video = read('src/renderer/src/nodes/specs/bodies/video.tsx')
    const block = video.match(/aria-label="视频后续操作"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(block).not.toBe('')
    for (const label of ['抽帧', '截视频', '截音频', '截人声']) {
      expect(block).toContain(label)
    }
    expect(block).not.toContain('<Icon')
    expect(video).not.toContain('一键提取人声')
  })
})

describe('v1.2 §16.6 悬浮全貌统一在上方', () => {
  it('浮层优先落在缩略图上方，且不再显示来源名称', () => {
    expect(inputPreview).toContain('placeBelow')
    expect(inputPreview).toContain('window.innerHeight - fullRect.top + 8')
    expect(inputPreview).not.toContain('reference-fullview-caption')
    expect(app).not.toContain('.reference-fullview-caption')
  })
})

describe('v1.2 §16.7 命名统一', () => {
  it('左侧面板与节点同名：不再维护第二份名字表', () => {
    // 用户规则「节点叫什么，左侧就得叫什么」。曾经 paletteLabels 与 spec.label 各写一份，
    // 于是同一节点在左侧叫「克隆」、卡片默认标题却叫「语音克隆」。删除覆盖表后二者同源。
    expect(stripComments(canvasEditor)).not.toContain('paletteLabels')
    expect(canvasEditor).toContain('label={`添加${t.label}节点`}')
    expect(canvasEditor).toContain('aria-label={`添加${t.label}节点`}')
    expect(canvasEditor).toContain('<span className="palette-label">{t.label}</span>')
  })

  it('spec label 使用新名字', () => {
    for (const label of [
      "label: 'P图'",
      "label: '生视频'",
      "label: '视频'",
      "label: '抽帧'",
      "label: '截视频'",
      "label: '截音频'",
      "label: '拆分'",
      "label: '文件'"
    ]) {
      expect(specs).toContain(label)
    }
    expect(specs).not.toContain("label: '修改'")
    expect(specs).not.toContain("label: '图片生成视频'")
    expect(specs).not.toContain("label: '拆图'")
  })

  it('图片资产节点不再显示格式/来源徽标', () => {
    expect(read('src/renderer/src/nodes/specs/bodies/image.tsx')).not.toContain(
      'node-media-badge-overlay'
    )
  })
})

describe('v1.2 §16.8 拆图节点布局与追溯线颜色', () => {
  it('行/列/面积是一行 flex，序号圆点行高归零', () => {
    expect(app).toMatch(/\.image-split-quick-controls\s*\{[^}]*display:\s*flex;/)
    expect(app).toMatch(/\.image-split-preview-tile em\s*\{[^}]*line-height:\s*1;/)
  })

  it('追溯线颜色跟随被产出资产类型，而不是集合端口的 json 紫', () => {
    expect(dataEdgeLayer).toContain('assetPorts.out[0]?.type')
  })
})

describe('v1.2 文本拼接分隔符是 $$$ 且不插入空行', () => {
  it('共享层是唯一真值，渲染层不再自带第二份实现', () => {
    expect(TEXT_MERGE_SEPARATOR).toBe('\n$$$\n')
    expect(mergedPrompt('节点', '上游')).toBe('上游\n$$$\n节点')
    const contracts = read('src/renderer/src/engine/contracts.ts')
    expect(contracts).toContain('sharedInputText')
    expect(contracts).not.toContain('---')
    expect(read('src/shared/engine/inputs.ts')).not.toContain('---')
    expect(read('src/renderer/src/canvas/graph.ts')).not.toContain("join('\\n\\n---\\n\\n')")
  })
})
