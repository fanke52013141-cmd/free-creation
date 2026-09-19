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
const sharedBodies = read('src/renderer/src/nodes/specs/bodies/shared.tsx')
const structured = read('src/renderer/src/nodes/specs/bodies/structured.tsx')
const processor = read('src/renderer/src/nodes/specs/bodies/processor.tsx')
const processorExecutor = read('src/shared/engine/executors/processor.ts')
const aiProcess = read('src/renderer/src/nodes/specs/bodies/aiProcess.tsx')
const chat = read('src/renderer/src/nodes/specs/bodies/chat.tsx')
const iterate = read('src/renderer/src/nodes/specs/bodies/iterate.tsx')

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

  it('视频节点后续按钮改名为 抽帧 / 视频截取 / 截人声 且无图标', () => {
    const video = read('src/renderer/src/nodes/specs/bodies/video.tsx')
    const block = video.match(/aria-label="视频后续操作"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(block).not.toBe('')
    for (const label of ['抽帧', '视频截取', '截人声']) {
      expect(block).toContain(label)
    }
    // 截音频已并入「视频截取」，视频节点不再单独提供该入口
    expect(block).not.toContain('截音频')
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
      "label: '视频截取'",
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

describe('v1.2 §16.11 代码/JSON 节点：契约因果可见，教学句清零', () => {
  const code = read('src/renderer/src/nodes/specs/bodies/code.tsx')
  const json = read('src/renderer/src/nodes/specs/bodies/json.tsx')

  it('代码节点不再解释"AI 不在这里生成代码"这类非功能说明', () => {
    const body = stripComments(code)
    expect(body).not.toContain('AI 代码生成')
    expect(body).not.toContain('隐式执行')
    expect(body).not.toContain('每个参数生成一个独立输入端口')
    // 空态也只陈述事实，主操作交给按钮，不再要求用户"双击"
    expect(body).not.toContain('双击编写代码')
    expect(body).toContain('编写代码')
  })

  it('变量行的每一行都写出它改变了什么：入口表达式与真实端口 ID', () => {
    expect(code).toContain('<code className="variable-expr">{inputExpr}</code>')
    expect(code).toContain('outputPortId(data.outputName)')
    // main 风格与表达式风格给出的读法不同，不能再混成一句话
    expect(code).toContain('args.${data.inputName}')
    expect(code).toContain('input.${data.inputName}')
    expect(app).toMatch(/\.variable-expr\s*\{/)
  })

  it('JSON 节点空态不渲染状态徽标，合法时给出结构规模', () => {
    expect(json).toMatch(/\{text && \(\s*<span\s+className=\{`json-status/)
    expect(json).not.toContain('等待输入')
    expect(json).toContain('structSummary')
  })

  it('JSON 报错必须定位到行列，完整原因留给 tooltip 而不是笼统"格式有误"', () => {
    // 定位逻辑抽到 bodies/shared.tsx，结构数据节点共用同一份读法
    expect(sharedBodies).toContain('export function jsonErrorLocation')
    expect(json).toContain("jsonErrorLocation(text, parseError ?? '')")
    expect(json).not.toContain("'JSON 格式有误'")
    expect(structured).toContain('jsonErrorLocation(raw, parseError)')
    expect(structured).not.toContain("'JSON 格式有误'")
  })
})

describe('v1.2 §16.12 处理/结构数据节点：只留真会改变行为的控件', () => {
  it('处理节点删掉了不起作用的变量名输入：端口即变量，改名不改连线', () => {
    const body = stripComments(processor)
    expect(body).not.toContain('输入变量名')
    expect(body).not.toContain('输出变量名')
    expect(body).not.toContain('aria-label="变量类型"')
    expect(body).toContain('aria-label="固定值类型"')
    // 执行器同步删除死字段，界面上不会再长出名字框
    expect(stripComments(processorExecutor)).not.toContain('variableName')
    expect(processorExecutor).not.toContain('inputName')
  })

  it('处理节点写出真实端口 ID，箭头与提示随处理方式变化', () => {
    expect(processor).toContain('<code className="variable-expr">in-value</code>')
    expect(processor).toContain('<code className="variable-expr">out-value</code>')
    // 「原样传递」不能永远是屏幕上的文案：必须由 operation 推导
    expect(processor).toMatch(/data\.operation === 'pass'\s*\?\s*'原样传递'/)
    expect(processor).toContain('MODE_HINTS[data.operation]')
    expect(processor).toContain("tone: 'warn'")
  })

  it('结构数据节点：占位符连同可引用数量呈现，坏 JSON 不再显示成 null', () => {
    expect(structured).toContain('countIncomingConnections')
    expect(structured).toContain('<PlaceholderTokens')
    expect(structured).toContain('{{input[${index}]}}')
    expect(structured).toContain("'暂无结构数据'")
    // 解析失败必须回显用户原文，而不是 JSON.stringify(null)
    expect(structured).toContain('parseError ? raw : JSON.stringify(parsed, null, 2)')
    expect(structured).not.toContain('双击输入 JSON')
    expect(structured).not.toContain('等待映射')
    expect(app).toMatch(/\.structured-token\.ready\s*\{/)
    expect(app).toMatch(/\.json-status\.pending\s*\{/)
  })
})

describe('v1.2 §16.10 端口可发现性：可落点有环、有名称，且校验不放宽', () => {
  it('兼容端口浮出名称标签，两侧都定位在卡片外，且不吃端口命中区', () => {
    expect(foundation).toMatch(/\.port-dot\.in \.port-label\s*\{[^}]*right:/)
    expect(foundation).toMatch(/\.port-dot\.out \.port-label\s*\{[^}]*left:/)
    expect(foundation).toMatch(/\.port-label\s*\{[^}]*pointer-events:\s*none;/)
    expect(nodeCardView).toContain('<span className="port-label">{p.name}</span>')
  })

  it('可落点用类型色外环区分于普通 hover；不兼容端口另给禁止光标', () => {
    expect(foundation).toMatch(
      /\.port-dot\.ok::after\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--bg\),\s*0 0 0 4px var\(--pc/
    )
    expect(foundation).toMatch(/\.port-dot\.dim\s*\{[^}]*cursor:\s*not-allowed;/)
  })

  it('tooltip 走 portHint 单一入口，类型不再输出英文裸串', () => {
    expect(nodeCardView).toContain('function portHint(p: PortDecl): string')
    expect(nodeCardView).toContain('title={portHint(p)}')
    expect(nodeCardView).not.toContain('`${p.name} · ${p.type}`')
  })

  it('可发现性不替换校验：拒绝连线仍然给出原因', () => {
    expect(canvasEditor).toContain('未连线：')
    expect(canvasEditor).toContain('tryConnect(')
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

describe('v1.2 §16.13 AI 处理 / 对话：把执行器分支映射成端口与连线状态', () => {
  it('输出模式各自绑定唯一真实输出端口，页脚不再印英文枚举', () => {
    expect(aiProcess).toContain("portId: 'out-text'")
    expect(aiProcess).toContain("portId: 'out-markdown'")
    expect(aiProcess).toContain("portId: 'out-json'")
    expect(aiProcess).toContain('{mode.hint}')
    expect(aiProcess).toContain('{modelName} → {mode.portId}')
    expect(stripComments(aiProcess)).not.toContain('· {data.mode}')
    // Schema 下拉只影响 out-json，这句话必须印在控件上而不是藏在说明里。
    expect(aiProcess).toContain('title="决定 out-json 声明的结构')
  })

  it('in-text / in-json 连线数直接呈现，空输入说明会跳过', () => {
    expect(aiProcess).toContain("countIncomingConnections(editor, shape.id, 'in-text')")
    expect(aiProcess).toContain("countIncomingConnections(editor, shape.id, 'in-json')")
    expect(aiProcess).toContain("'两个输入端口都没连线，运行会跳过'")
    // 早期版本在早退分支后再判一次 options.length，那条 else 永远不可达。
    expect(aiProcess).not.toContain('{options.length > 0 ?')
    expect(stripComments(aiProcess)).not.toContain('（尚未运行，或等待上游输入）')
    expect(stripComments(aiProcess)).not.toContain('（无系统提示词，点击编辑）')
  })

  it('对话节点说明本轮提问的真实来源顺序（末条提问优先于 in-text）', () => {
    expect(chat).toContain("countIncomingConnections(editor, shape.id, 'in-text')")
    expect(chat).toContain('data.messages.at(-1)?.role')
    expect(chat).toContain('in-text ${textCount} 条拼接成本轮提问')
    expect(chat).toContain('运行会跳过')
    expect(chat).toContain('<code className="variable-expr">out-markdown</code>')
    // 旧的 `T0.7 · 4096 tok` 缩写没人读得懂。
    expect(chat).toContain("' · 温度 '")
    expect(stripComments(chat)).not.toContain(' tok')
  })

  it('循环 / AI 处理 / 对话共用同一套连线状态配色', () => {
    expect(iterate).toContain("'in-list'")
    expect(iterate).toContain('循环体：未从「当前项」连线，运行会跳过')
    for (const selector of [
      '.iterate-wiring.ok',
      '.iterate-wiring.warn',
      '.ai-process-wiring.ok',
      '.ai-process-wiring.warn',
      '.chat-compact-run.ok',
      '.chat-compact-run.warn'
    ]) {
      expect(app).toContain(`${selector} {`)
    }
    expect(app).toMatch(/\.ai-process-wiring\.warn\s*\{\s*color:\s*#fbbf24;/)
    expect(app).toMatch(/\.chat-compact-run\.ok\s*\{\s*color:\s*#34d399;/)
  })
})

describe('v1.2 §16.15 语音节点：控件只在所选后端真会发送该字段时才呈现', () => {
  const tts = read('src/renderer/src/nodes/specs/bodies/tts.tsx')
  const speech = read('src/renderer/src/nodes/specs/bodies/speech.tsx')

  it('语音复刻的语言/语速/情绪只在本地 IndexTTS 后端出现（MiniMax 链路不读取）', () => {
    expect(tts).toMatch(/backend === 'comfyui' && \(\s*<>\s*<label className="opt-label">语言/)
    expect(tts).toMatch(/backend === 'comfyui' && \(\s*<div className="tts-sliders">/)
    // 格式两个后端都会发送，只是取值域不同，必须留在门控之外。
    expect(tts).toContain("config.backend === 'minimax'")
    expect(tts).toContain('TTS_FORMATS_BY_BACKEND[config.backend].map')
    // 结果卡片的语言标记不再印 MiniMax 用不到的 IndexTTS 取值。
    expect(tts).toContain("config.backend === 'minimax' ? config.modelId : config.lang")
  })

  it('格式的取值域只有一份真值，新建节点默认走云端', () => {
    // UI 不再自己写死「排除 wav」，域表就是网关会发出去的那一份。
    expect(tts).not.toContain("TTS_FORMATS.filter((f) => f !== 'wav')")
    const shared = read('src/shared/tts.ts')
    expect(shared).toMatch(
      /TTS_FORMATS_BY_BACKEND: Record<TtsBackend, ReadonlyArray<TtsFormat>> = \{\s*minimax: \['mp3', 'flac'\],\s*comfyui: \['wav', 'mp3', 'flac'\]/
    )
    // 云端优先（用户决定：先做云端合成，本地链路留到后面）：空配置新节点是 MiniMax。
    expect(shared).toMatch(/DEFAULT_TTS_CONFIG: TtsConfig = \{\s*version: 1,\s*backend: 'minimax'/)
    expect(shared).toMatch(/Object\.keys\(raw\)\.length === 0\s*\?\s*'minimax'\s*:\s*'comfyui'/)
  })

  it('配音面板的码率与声道跟随 MiniMax 异步通道（audio_setting 的唯一消费者）', () => {
    const settings = speech.slice(speech.indexOf('export function SpeechSettings'))
    const gate = settings.indexOf("config.backend === 'minimax'")
    expect(gate).toBeGreaterThan(-1)
    expect(settings.indexOf('码率')).toBeGreaterThan(gate)
    expect(settings.indexOf('audioChannel')).toBeGreaterThan(gate)
    // 采样率被 MiniMax 与豆包共用，不能一起收进 MiniMax 门控。
    expect(speech).toContain('SPEECH_SAMPLE_RATES')
  })
})

describe('v1.2 §16.16 媒体 / 剧本节点：判据是真实连线，不是卡片自己的历史结果', () => {
  const videoBody = read('src/renderer/src/nodes/specs/bodies/video-transforms.tsx')
  const vocal = read('src/renderer/src/nodes/specs/bodies/vocal-separate.tsx')
  const tts = read('src/renderer/src/nodes/specs/bodies/tts.tsx')
  const script = read('src/renderer/src/nodes/specs/bodies/script.tsx')
  const imageGen = read('src/renderer/src/nodes/specs/bodies/image-gen.tsx')

  it('抽帧/视频截取/截音频把 in-video 连线数当运行判据，两种视图都印', () => {
    expect(videoBody).toContain("countIncomingConnections(editor, shape.id, 'in-video')")
    expect(videoBody).toContain('源视频（in-video）未连线，运行会跳过')
    // 空态与已有结果态各一次：mediaPath 只是历史结果，不能当成会不会跳过的依据。
    expect(videoBody.split('{sourceWiring}').length - 1).toBe(2)
  })

  it('人声分离空态改成陈述事实，不再命令用户去连线', () => {
    expect(stripComments(vocal)).not.toContain('请将音频连线到')
    expect(vocal).toContain('源音频（in-audio）未连线，运行会跳过')
  })

  it('语音复刻说明参考语音与文本的真实来源，并据此禁用按钮', () => {
    expect(tts).toContain("countIncomingConnections(editor, shape.id, 'in-audio')")
    expect(tts).toContain("countIncomingConnections(editor, shape.id, 'in-text')")
    expect(tts).toContain('参考语音：未上传且 in-audio 未连线，运行会跳过')
    expect(tts).toContain('(!draft.trim() && incomingText === 0)')
    expect(tts).toContain('(incomingRef === 0 && !uploadedRef)')
    expect(stripComments(tts)).not.toContain('可由文本节点提供')
  })

  it('剧本节点说明执行器的两个分支，不再否认自己能做 AI 拆解', () => {
    expect(script).toContain("countIncomingConnections(editor, shape.id, 'in-text')")
    expect(script).toContain('分镜为空：运行会调用对话模型拆解剧本')
    expect(stripComments(script)).not.toContain('AI 拆解请使用')
  })

  it('@图片 引用上限跟随能力表，而不是写死 4 张', () => {
    expect(imageGen).toContain('referenceImages.slice(0, capabilities.maxReferenceImages)')
    expect(stripComments(imageGen)).not.toContain('slice(0, 4)')
  })

  it('导入素材的每种落空都要留下提示，取消选择除外', () => {
    const audio = read('src/renderer/src/nodes/specs/bodies/audio.tsx')
    expect(audio).toContain("if (!audioAsset) return toast('请选择一个音频文件')")
    expect(audio).toContain('catch (error)')
    for (const path of [
      'src/renderer/src/nodes/specs/bodies/image.tsx',
      'src/renderer/src/nodes/specs/bodies/file.tsx'
    ]) {
      expect(read(path)).toContain("if (!project) return toast('项目未就绪')")
    }
    // 卡片里的选择器取消是正常路径，两种文件节点都必须保持静默。
    expect(read('src/renderer/src/nodes/specs/bodies/image.tsx')).toContain(
      'if (res.data.assets.length === 0 && res.data.errors.length === 0) return'
    )
  })

  it('媒体 / 语音连线状态配色是通用类，不再各节点族复制一份', () => {
    expect(app).toMatch(/\.node-wiring\.ok\s*\{\s*color:\s*#34d399;/)
    expect(app).toMatch(/\.node-wiring\.warn\s*\{\s*color:\s*#fbbf24;/)
  })
})

describe('v1.2 §16.17 火山语音合成 1.0：第四后端只暴露它自己会发送的字段', () => {
  const speech = read('src/renderer/src/nodes/specs/bodies/speech.tsx')
  const gateway = read('src/main/gateway/audio.ts')
  const executor = read('src/shared/engine/executors/speech.ts')

  it('采样率跟随能力表而不是写死两个后端', () => {
    expect(speech).toMatch(
      /SPEECH_SAMPLE_RATE_BACKENDS\.includes\(config\.backend\) && \(\s*<>\s*<label className="opt-label">采样率/
    )
  })

  it('AppID / 集群 / 语速整段只在 volc 后端出现，并把必填判据写在按钮上', () => {
    expect(speech).toMatch(/config\.backend === 'volc' && \(\s*<div className="tts-section">/)
    expect(speech).toContain('请求体 app.appid')
    expect(speech).toContain('请求体 app.cluster')
    expect(speech).toContain('请求体 audio.speed_ratio')
    expect(speech).toContain('未填写 AppID，运行会跳过')
    expect(speech).toContain('未填写音色 ID（voice_type），运行会跳过')
    expect(speech).toMatch(/canGenerate =[\s\S]{0,160}!volcMissing/)
  })

  it('1.0 没有 in-voice 端口，音色说明就直说 MiniMax 音色档案不是它的输入', () => {
    expect(speech).toContain('火山 1.0 只认自家的 voice_type')
    expect(speech).toContain("config.backend === 'volc'")
    // 端口集合与占位符同源：volc 复用 openai 的「只有文本」集合。
    expect(specs).toContain("if (backend === 'openai' || backend === 'volc')")
    expect(specs).toMatch(
      /backend === 'openai' \|\| backend === 'volc'\) \{\s*return \{ in: \[inText\], out: \[outAudio\] \}/
    )
  })

  it('执行器不发必然 4xx 的请求，网关只发 1.0 文档化的四个字段', () => {
    expect(executor).toMatch(
      /config\.backend === 'volc' && !config\.volcAppId[\s\S]{0,80}火山语音合成 1\.0 未填写 AppID/
    )
    expect(executor).toMatch(
      /config\.backend === 'volc' && !voiceId[\s\S]{0,90}火山语音合成 1\.0 未填写音色 ID/
    )
    expect(gateway).toContain('Authorization: `Bearer;${p.apiKey}`')
    expect(gateway).toContain('${base}/api/v1/tts')
    const volcBody = gateway.slice(
      gateway.indexOf('export function buildVolcTtsBody'),
      gateway.indexOf('MiniMax 异步语音合成：创建任务')
    )
    expect(volcBody.length).toBeGreaterThan(100)
    // 采样率/码率的字段名未被供应商文档证实，宁可不发也不猜。
    expect(volcBody).not.toContain('sample_rate')
    expect(volcBody).not.toContain('bitrate')
    expect(volcBody).toContain('operation:')
  })
})

describe('v1.2 §16.20 文档解析：PDF 交给 pdf.js，可解析格式只有一份清单', () => {
  const mime = read('src/shared/mime.ts')
  const repo = read('src/main/store/media.repo.ts')
  const extractor = read('src/main/media/document-text.ts')
  const fileBody = read('src/renderer/src/nodes/specs/bodies/file.tsx')

  it('导入判定与节点展示共用 BINARY_DOC_EXTS，不再各写一份扩展名', () => {
    expect(mime).toContain(
      'export const BINARY_DOC_EXTS: readonly string[] = [...OOXML_DOC_EXTS, ...PDF_DOC_EXTS]'
    )
    expect(repo).toContain('BINARY_DOC_EXTS.includes(ext)')
    expect(fileBody).toContain('const PARSABLE_EXTS = [...INLINE_TEXT_EXTS, ...BINARY_DOC_EXTS]')
    // 渲染层一旦重新直接引用 OOXML 清单，PDF 抽出的正文就会被显示成"不解析"。
    expect(fileBody).not.toContain('OOXML_DOC_EXTS')
  })

  it('旧版二进制格式仍不解析，"不解析"分支保持可达', () => {
    expect(mime).toContain(
      "export const OOXML_DOC_EXTS: readonly string[] = ['.docx', '.xlsx', '.pptx']"
    )
    expect(extractor).toContain("if (!OOXML_DOC_EXTS.includes(ext)) return ''")
  })

  it('PDF 抽取不读系统字体，抽完即释放 loadingTask', () => {
    expect(extractor).toMatch(
      /getDocumentProxy\(new Uint8Array\(buf\), \{\s*useSystemFonts: false,\s*verbosity: 0\s*\}\)/
    )
    expect(extractor).toContain('await doc.loadingTask.destroy()')
    expect(extractor).toContain('const MAX_PDF_PAGES = 300')
  })

  it('多页 PDF 与 PPT 同构：页码按原始页序标注，空页不顶错位', () => {
    expect(extractor).toContain('.map((page, index) => ({ index, body:')
    expect(extractor).toContain('第 ${page.index + 1} 页')
  })
})

describe('v1.2 §16.22 隐藏能力要出现在节点上：slash 指令清单与分镜取数来源', () => {
  const textBody = read('src/renderer/src/nodes/specs/bodies/text.tsx')
  const storyboardBody = read('src/renderer/src/nodes/specs/bodies/storyboard.tsx')
  const slashCommands = read('src/renderer/src/nodes/slash-commands.ts')

  it('批量视角指令清单只来自 SLASH_COMMANDS，不在节点里抄第二份', () => {
    expect(slashCommands).toMatch(/export const SLASH_COMMANDS/)
    expect(textBody).toMatch(/SLASH_COMMANDS\.map\(\(cmd\) =>/)
    expect(textBody).toMatch(/<code>\{cmd\.pattern\}<\/code>/)
    // 清单一旦回到硬编码，新增指令就会静默地不出现在节点上。
    expect(stripComments(textBody)).not.toContain('九宫格')
  })

  it('空态与打错前缀都给回执，且已识别指令时不叠加清单', () => {
    expect(textBody).toMatch(/const showSlashHint =\n?\s*!slashCmd &&/)
    expect(textBody).toContain('未识别的指令，可用：')
    expect(app).toContain('.slash-cmd-hint')
    expect(app).toContain('.slash-cmd-option')
  })

  it('分镜板按真实连线给出取数来源（in-json / in-text）', () => {
    expect(storyboardBody).toMatch(/countIncomingConnections\(editor, shape\.id, 'in-json'\)/)
    expect(storyboardBody).toMatch(/countIncomingConnections\(editor, shape\.id, 'in-text'\)/)
    // 必须响应式读取，否则连上上游后事实行会停在旧值。
    expect(storyboardBody).toMatch(/useValue\(\s*\n?\s*'storyboard in-json inputs'/)
    expect(storyboardBody).toContain('node-wiring')
  })

  it('覆盖用户手改镜头这件事写在卡片上，旧的空态指令文案清零', () => {
    expect(storyboardBody).toContain('运行会用它覆盖本卡片的')
    expect(storyboardBody).toContain('运行会跳过')
    expect(stripComments(storyboardBody)).not.toContain('将脚本节点连入此节点')
  })
})

describe('v1.2 §16.23 图片族：遮罩与画幅按网关真实发送字段呈现，缺输入结论按真实连线', () => {
  const caps = read('src/shared/image-capabilities.ts')
  const editShared = read('src/shared/image-edit.ts')
  const editBody = read('src/renderer/src/nodes/specs/bodies/image-edit.tsx')
  const cropBody = read('src/renderer/src/nodes/specs/bodies/image-crop.tsx')
  const splitBody = read('src/renderer/src/nodes/specs/bodies/image-split.tsx')
  const editExecutor = read('src/shared/engine/executors/imageEdit.ts')
  const gateway = read('src/main/gateway/image.ts')
  const sidePanel = read('src/renderer/src/canvas/CanvasSidePanel.tsx')

  it('P 图的两个控件各由一条「网关会不会发」的判定决定', () => {
    expect(caps).toContain(
      'export function imageEditSendsMask(capabilities: ImageCapabilities): boolean'
    )
    expect(caps).toContain("return capabilities.driver !== 'toapis-task'")
    expect(caps).toContain(
      "return capabilities.driver === 'toapis-task' || capabilities.forwardsAspectRatio"
    )
    expect(editBody).toContain(
      'const sendsMask = capabilities ? imageEditSendsMask(capabilities) : false'
    )
    expect(editBody).toContain('const visibleTools = sendsMask ? TOOLS : TOOLS.filter(')
    expect(editBody).toContain('{sendsMask && (')
    expect(editBody).toContain('{sendsRatio && (')
    // 隐藏控件不能把用户已经画好的遮罩变成静默失效。
    expect(editBody).toContain('当前模型通道不接收遮罩字段')
  })

  it('执行器里那句「仅修改遮罩区域」的提示词只在遮罩真的发送时出现', () => {
    expect(editExecutor).toContain('const sendsMask = imageEditSendsMask(')
    expect(editExecutor).toContain("config.mask?.enabled && sendsMask ? '请仅修改遮罩指定区域")
    // 无条件拼接该句会让模型以为收到了一个并不存在的输入。
    expect(stripComments(editExecutor)).not.toMatch(/^\s*config\.mask\?\.enabled \? '请仅修改遮罩/m)
  })

  it('画幅只有一份来源：选项取能力表，比例不再镜像进 size', () => {
    expect(editBody).toContain('const ratioOptions: ImageEditAspectRatio[] = capabilities?.ratios')
    expect(stripComments(editShared)).not.toContain('IMAGE_EDIT_ASPECT_RATIOS')
    expect(editShared).toContain('isImageAspectRatio(typeof raw.size ===')
    // 网关两条通道各自把画幅写进自己的字段：TOAPIS 用 size，兼容网关用 aspectRatio。
    expect(gateway).toContain("if (capabilities.driver === 'toapis-task')")
    expect(gateway).toContain('providerOptions.aspectRatio = input.config.aspectRatio')
    // 同步接口只接受像素尺寸：比例串绝不能当 size 发出去。
    expect(gateway).toContain("/^\\d+x\\d+$/.test(input.size ?? '')")
  })

  it('缺输入结论只有一处实现，并按真实连线区分「未连线」与「无产出」', () => {
    expect(sharedBodies).toContain('export function useSourceWiringNotice(')
    expect(sharedBodies).toContain('countIncomingConnections(editor, shapeId as TLShapeId, portId)')
    expect(sharedBodies).toContain('未连线，运行会跳过')
    expect(sharedBodies).toContain('但上游还没有产出')
    for (const [name, source] of [
      ['image-edit', editBody],
      ['image-crop', cropBody],
      ['image-split', splitBody]
    ] as const) {
      expect(source, name).toContain("useSourceWiringNotice(editor, shape.id, 'in-image', '原图')")
      // 教学式指令文案不能留在任何一处空态里。
      expect(stripComments(source), name).not.toContain('请从图片或生图节点连线')
    }
  })

  it('续跑与模板的下游节点标题统一为「生视频」', () => {
    expect(stripComments(sharedBodies)).not.toContain('图片生成视频')
    expect(stripComments(sidePanel)).not.toContain('图片生成视频')
    expect(sidePanel).toContain("{ type: 'video', title: '生视频'")
    expect(sharedBodies).toContain("{ type: 'video', label: '生视频'")
  })
})
