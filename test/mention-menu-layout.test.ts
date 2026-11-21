import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

// 2026-11-21 用户裁决：引用候选菜单从单行列表改为两列 16:9 卡片网格——
// 缩略图卡片 + 文件名放卡片下方 + 类型徽标（图片绿/视频蓝）+ 视频居中暗淡播放键
// + 悬浮右上角放大镜进灯箱预览。生图与生视频共用 ImageMentionPrompt，同步生效。
describe('引用候选菜单卡片化呈现', () => {
  it('菜单为两列卡片网格，纵向滚动兜底', () => {
    const css = read('src/renderer/src/assets/app.css')
    expect(css).toMatch(/\.ref-mention-menu\s*\{[^}]*display:\s*grid;/)
    expect(css).toMatch(/\.ref-mention-menu\s*\{[^}]*grid-template-columns:\s*1fr 1fr;/)
    expect(css).toMatch(/\.ref-mention-menu\s*\{[^}]*overflow-y:\s*auto;/)
  })

  it('候选卡：16:9 缩略图区 + 下方实底名称条，名称省略有 title 兜底', () => {
    const css = read('src/renderer/src/assets/app.css')
    const prompt = read('src/renderer/src/nodes/specs/bodies/ImageMentionPrompt.tsx')
    expect(css).toMatch(/\.ref-card-media\s*\{[^}]*aspect-ratio:\s*16 \/ 9;/)
    expect(css).toMatch(/\.ref-card-name\s*\{[^}]*background:\s*rgba\(13, 17, 24, 0\.92\);/)
    expect(css).toMatch(/\.ref-card-title\s*\{[^}]*text-overflow:\s*ellipsis;/)
    expect(css).toMatch(/\.ref-card-name small\s*\{[^}]*white-space:\s*nowrap;/)
    expect(prompt).toContain('title={item.title || item.name || item.token}')
  })

  it('文件名回退：无标题/素材名的资产显示「图片 1」编号名，绝不显示 UUID', () => {
    const prompt = read('src/renderer/src/nodes/specs/bodies/ImageMentionPrompt.tsx')
    expect(prompt).toContain('item.title || item.name || item.token.replace(/^@/, \'\')')
    expect(prompt).toContain('candidateName(item)')
  })

  it('视频卡居中暗淡播放键；类型徽标按引用类型着色', () => {
    const css = read('src/renderer/src/assets/app.css')
    expect(css).toMatch(/\.ref-card-play\s*\{[^}]*place-items:\s*center;/)
    expect(css).toMatch(/\.ref-card\.is-video \.ref-card-kind\s*\{/)
    expect(css).toMatch(/\.ref-card-kind\s*\{[^}]*rgba\(74, 222, 128, 0\.2\)/)
  })

  it('悬浮右上角放大镜预览，灯箱点击关闭', () => {
    const css = read('src/renderer/src/assets/app.css')
    const prompt = read('src/renderer/src/nodes/specs/bodies/ImageMentionPrompt.tsx')
    expect(css).toMatch(/\.ref-card-preview\s*\{[^}]*display:\s*none;/)
    expect(css).toMatch(/\.ref-card:hover \.ref-card-preview/)
    expect(css).toContain('.ref-preview-lightbox')
    expect(prompt).toContain('setPreviewItem(item)')
    expect(prompt).toContain('onClick={() => setPreviewItem(null)}')
  })
})
