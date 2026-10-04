// T08（F10/F07 关联）：面向创作者的错误映射测试。固化 A05 判据：
// 每类失败给出中文阶段+原因+可执行动作；能重下不重生成；提交前失败重试零计费。
import { describe, expect, it } from 'vitest'
import { mapRunError, statusText } from '@renderer/engine/error-mapping'

describe('mapRunError', () => {
  it('非失败状态返回 null（成功/运行中不需要错误指引）', () => {
    expect(mapRunError('success', undefined)).toBeNull()
    expect(mapRunError('running', undefined)).toBeNull()
  })

  it('配置缺失类：提示补齐后重试，说明下一次可能产生费用', () => {
    const r = mapRunError('failed', { phase: 'input', reason: '无提示词' })
    expect(r?.stage).toContain('输入')
    expect(r?.action).toContain('下一次运行')
  })

  it('执行阶段异常：引导检查模型供应商配置或网络', () => {
    const r = mapRunError('failed', { phase: 'execution', reason: 'fetch failed' })
    expect(r?.reason).toContain('fetch failed')
    expect(r?.action).toContain('重试节点')
  })

  it('参数字样不能被当作供应商从未提交的证明', () => {
    const r = mapRunError('failed', { phase: 'execution', reason: '请求缺少必要参数' })
    expect(r?.action).not.toContain('不会产生新的生成请求')
  })

  it('状态词中文化：成功/失败/已停止', () => {
    expect(statusText('success')).toBe('成功')
    expect(statusText('failed')).toBe('失败')
    expect(statusText('cancelled')).toBe('已停止')
  })
})

it.each([
  ['HTTP 401 unauthorized', '密钥'],
  ['HTTP 429 rate limit', '限流'],
  ['提交后超时', '任务可能已提交'],
  ['下载失败', '优先恢复'],
  ['生成来源保存失败；素材已保留', '不要直接重新生成'],
  ['Schema 不符合', '结构要求']
])('为 %s 提供明确恢复动作', (reason, action) => {
  expect(mapRunError('failed', { phase: 'execution', reason })?.action).toContain(action)
})
