// @vitest-environment jsdom
import { describe, expect, it, beforeAll } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { getNodeType } from '@renderer/nodes/registry'
import { projectNodeOutputs } from '@renderer/nodes/nodeValues'
import type { NodeCardShape } from '@renderer/canvas/NodeCardShape'
import type { NodeExecutionContext } from '@renderer/engine/executor-types'
import { normalizeWebsiteUrl, readWebsiteLink } from '@shared/website-link'
import { WebsiteBody } from '@renderer/nodes/specs/bodies/website'

beforeAll(registerAllNodeTypes)

function websiteShape(config: string): NodeCardShape {
  return {
    id: 'shape:website' as never,
    type: 'node-card',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1' as never,
    isLocked: false,
    props: {
      w: 340,
      h: 260,
      nodeType: 'website',
      title: '网址节点',
      config,
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

describe('网址节点配置和执行', () => {
  it('允许补全 https 并规范化 HTTP(S) 网址', () => {
    expect(normalizeWebsiteUrl('example.com/a')).toBe('https://example.com/a')
    expect(normalizeWebsiteUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  })

  it('拒绝脚本协议、凭据和无法解析的网址', () => {
    expect(normalizeWebsiteUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeWebsiteUrl('https://name:secret@example.com')).toBeNull()
    expect(normalizeWebsiteUrl('not a url')).toBeNull()
  })

  it('有效配置运行成功；缺少配置走明确的跳过失败路径', () => {
    const executor = getNodeType('website')!.executor!
    const context = (config: string) => ({ shape: websiteShape(config) }) as NodeExecutionContext
    expect(executor(context(JSON.stringify({ name: '主页', url: 'example.com' })))).toEqual({
      status: 'done'
    })
    expect(executor(context('{}'))).toEqual({
      status: 'skipped',
      reason: '请先在右侧设置网址名称和有效链接'
    })
  })

  it('输出可在节点配置更改后立即读取，旧失败状态也不会屏蔽固定配置', () => {
    const config = JSON.stringify({ name: '主页', url: 'example.com' })
    const result = projectNodeOutputs({
      ...websiteShape(config),
      meta: {
        nodeRun: { runId: 'run-1', status: 'failed', startedAt: 1, inputs: {} }
      }
    } as NodeCardShape)
    expect(result['out-website']).toEqual({
      kind: 'json',
      data: { name: '主页', url: 'https://example.com/' }
    })
    expect(readWebsiteLink('{')).toBeNull()
  })

  it('卡片展示网址名称和链接；单击选中、双击打开（不再渲染可点击跳转的 <a>）', () => {
    const shape = websiteShape(JSON.stringify({ name: '主页', url: 'example.com' }))
    const html = renderToStaticMarkup(createElement(WebsiteBody, { shape, openPreview: () => {} }))
    expect(html).toContain('主页')
    // 交互统一：卡片体不拦截 pointerdown（单击=选中），打开动作只在双击触发。
    expect(html).toContain('双击打开')
    expect(html).not.toContain('href=')
    // renderToStaticMarkup 不序列化事件处理器；对源码断言双击入口存在。
    const source = readFileSync('src/renderer/src/nodes/specs/bodies/website.tsx', 'utf8')
    expect(source).toContain('onDoubleClick')
  })
})
