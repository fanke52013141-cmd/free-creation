// T1 · sanitizeRunError 脱敏真值表（R0/WP1）
//
// 验收对应 R0_PLAN §3 WP1：制造含 Key 的错误后，日志内容全文检索不到 API Key。
import { describe, it, expect } from 'vitest'
import { sanitizeText, sanitizeRunError } from '@shared/sanitize'

describe('sanitizeText · token 剔除', () => {
  it('剔除带 Authorization 头的 Bearer token（整体脱敏）', () => {
    const out = sanitizeText('请求失败 Authorization: Bearer abc123XYZ_-~+/== 401')
    expect(out).not.toContain('abc123XYZ')
    expect(out).toContain('Authorization [REDACTED]')
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(1)
  })

  it('剔除裸 Bearer token（无 Authorization 前缀）', () => {
    const out = sanitizeText('header Bearer sk-abcdef12345678 rejected')
    expect(out).not.toContain('sk-abcdef12345678')
    expect(out).toContain('Bearer')
  })

  it('剔除 sk- 形态密钥', () => {
    const out = sanitizeText('invalid key sk-proj1234567890abcdef')
    expect(out).not.toContain('sk-proj1234567890abcdef')
    expect(out).toContain('sk-[REDACTED]')
  })

  it('剔除 api_key / api-key / apikey 形态', () => {
    expect(sanitizeText('api_key=secretValue123')).not.toContain('secretValue123')
    expect(sanitizeText('api-key: secretValue123')).not.toContain('secretValue123')
    expect(sanitizeText('apikey=secretValue123')).not.toContain('secretValue123')
  })

  it('剔除 Authorization 头（等号与冒号两种形态，含 Basic scheme）', () => {
    expect(sanitizeText('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
    expect(sanitizeText('authorization=token987654')).not.toContain('token987654')
  })
})

describe('sanitizeText · URL 只保留协议+域名', () => {
  it('去除 path 与 query', () => {
    const out = sanitizeText('GET https://api.example.com/v1/chat?api_key=leak&x=1 失败')
    expect(out).toContain('https://api.example.com')
    expect(out).not.toContain('/v1/chat')
    expect(out).not.toContain('api_key=leak')
    expect(out).not.toContain('leak')
  })

  it('保留端口号', () => {
    expect(sanitizeText('http://localhost:11434/v1/models 超时')).toBe(
      'http://localhost:11434/v1/models 超时'.replace(
        'http://localhost:11434/v1/models',
        'http://localhost:11434'
      )
    )
  })

  it('无法解析的 URL 片段保持原样', () => {
    // URL_RE 要求协议开头，裸域名不匹配、不误伤
    expect(sanitizeText('连接 example.com 失败')).toBe('连接 example.com 失败')
  })
})

describe('sanitizeText · 截断与保留', () => {
  it('超长文本截断到指定长度并加省略号', () => {
    const out = sanitizeText('x'.repeat(600), 500)
    expect(out.length).toBe(501)
    expect(out.endsWith('…')).toBe(true)
  })

  it('中文与多行错误内容保留', () => {
    const msg = '节点执行失败：\n第二行原因\n第三行：模型返回 500'
    expect(sanitizeText(msg)).toBe(msg)
  })

  it('普通文本原样返回', () => {
    expect(sanitizeText('生成完成')).toBe('生成完成')
  })
})

describe('sanitizeRunError · 错误对象脱敏（不修改原对象）', () => {
  it('清洗 label 与 reason，其余字段透传', () => {
    const err = {
      label: '生图 sk-abcdefgh12345678',
      reason: 'POST https://api.example.com/v1/images?key=k123 失败',
      nodeId: 'shape:1',
      portId: 'in-text',
      phase: 'execution' as const,
      timestamp: 123
    }
    const safe = sanitizeRunError(err)
    expect(safe.label).not.toContain('sk-abcdefgh12345678')
    expect(safe.reason).not.toContain('key=k123')
    expect(safe.nodeId).toBe('shape:1')
    expect(safe.portId).toBe('in-text')
    expect(safe.phase).toBe('execution')
    expect(safe.timestamp).toBe(123)
    // 原对象未被修改
    expect(err.reason).toContain('key=k123')
  })

  it('空字段保持 undefined', () => {
    const safe = sanitizeRunError({ label: 'x' })
    expect(safe.reason).toBeUndefined()
  })
})
