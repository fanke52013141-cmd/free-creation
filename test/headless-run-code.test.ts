import { describe, expect, it } from 'vitest'
import { runCodeHeadless } from '../src/main/headless/run-code'

describe('runCodeHeadless (Node.js vm sandbox)', () => {
  it('执行纯代码片段并返回 JSON 结果', async () => {
    const result = await runCodeHeadless('return { doubled: input.n * 2 }', { n: 21 })
    expect(result).toEqual({ kind: 'json', data: { doubled: 42 } })
  })

  it('支持 async function main(args) 写法', async () => {
    const source = 'async function main(args) { return args.value.toUpperCase() }'
    const result = await runCodeHeadless(source, { value: 'hello' })
    expect(result).toEqual({ kind: 'text', text: 'HELLO' })
  })

  it('注入 lodash 子集 _', async () => {
    const source = 'return _.get({ a: { b: 42 } }, "a.b")'
    const result = await runCodeHeadless(source, {})
    expect(result).toEqual({ kind: 'json', data: 42 })
  })

  it('注入 dayjs 子集', async () => {
    const source = 'return dayjs("2024-06-15T10:30:00Z").format("YYYY-MM-DD")'
    const result = await runCodeHeadless(source, {})
    expect(result).toEqual({ kind: 'text', text: '2024-06-15' })
  })

  it('确定性时钟：Date.now() 返回 0', async () => {
    const source = 'return Date.now()'
    const result = await runCodeHeadless(source, {})
    expect(result).toEqual({ kind: 'json', data: 0 })
  })

  it('确定性随机：相同源码和输入产生相同序列', async () => {
    const source = 'return Math.random()'
    const a = await runCodeHeadless(source, { seed: 1 })
    const b = await runCodeHeadless(source, { seed: 1 })
    expect(a).toEqual(b)
  })

  it('封锁 fetch', async () => {
    const source = 'return fetch("https://evil.example.com")'
    await expect(runCodeHeadless(source, {})).rejects.toThrow()
  })

  it('封锁 require', async () => {
    const source = 'return require("fs")'
    await expect(runCodeHeadless(source, {})).rejects.toThrow()
  })

  it('封锁动态 Function 构造', async () => {
    const source = 'const f = new Function("return 1"); return f()'
    await expect(runCodeHeadless(source, {})).rejects.toThrow()
  })

  it('空代码抛出错误', async () => {
    await expect(runCodeHeadless('   ', {})).rejects.toThrow('请输入要执行的代码')
  })

  it('undefined 返回值抛出错误', async () => {
    await expect(runCodeHeadless('return undefined', {})).rejects.toThrow('必须 return')
  })

  it('不可序列化的返回值抛出错误', async () => {
    const source = 'const obj = {}; obj.self = obj; return obj'
    await expect(runCodeHeadless(source, {})).rejects.toThrow()
  })
})
