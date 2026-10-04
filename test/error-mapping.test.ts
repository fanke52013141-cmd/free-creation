// T08（F10/F07 关联）：面向创作者的错误映射测试。固化 A05 判据：
// 每类失败给出中文阶段+原因+可执行动作；能重下不重生成；提交前失败重试零计费。
import { describe, expect, it } from 'vitest'
import { mapRunError, statusText } from '@renderer/engine/error-mapping'

describe('mapRunError', () => {
  it('非失败状态返回 null（成功/运行中不需要错误指引）', () => {
    expect(mapRunError('success', undefined)).toBeNull()
    expect(mapRunError('running', undefined)).toBeNull()
  })

  it('配置缺失类：提示补齐后重试，且重试零计费', () => {
    const r = mapRunError('failed', { phase: 'input', reason: '无提示词' })
    expect(r?.stage).toContain('输入')
    expect(r?.action).toContain('不会产生新的生成请求')
  })

  it('执行阶段异常：引导检查模型供应商配置或网络', () => {
    const r = mapRunError('failed', { phase: 'execution', reason: 'fetch failed' })
    expect(r?.reason).toContain('fetch failed')
    expect(r?.action).toContain('重试节点')
  })

  it('网络类文案命中提交前提示词时归为安全重试', () => {
    const r = mapRunError('failed', { phase: 'execution', reason: '请求缺少必要参数' })
    expect(r?.action).toContain('不会产生新的生成请求')
  })

  it('状态词中文化：成功/失败/已停止', () => {
    expect(statusText('success')).toBe('成功')
    expect(statusText('failed')).toBe('失败')
    expect(statusText('cancelled')).toBe('已停止')
  })
})
