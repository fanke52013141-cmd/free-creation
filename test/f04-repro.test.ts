import { describe, expect, it } from 'vitest'
import { runCodeHeadless } from '../src/main/headless/run-code'

// F04 回归测试：headless 代码节点经 args.constructor.constructor 逃逸宿主 realm。
// 沙箱三层防御（args 以 JSON 文本传入沙箱内重建、用户源码由宿主 vm.Script 预编译、
// codeGeneration.strings=false 禁止沙箱内动态编译）下，逃逸尝试只能在沙箱内报错，
// 绝不能拿到宿主 process 并返回成功结果。
describe('F04 回归：宿主对象构造器链逃逸已被沙箱封锁', () => {
  it('async function main(args) 形式下构造器链编译宿主代码必须被拒绝', async () => {
    const source = `
      async function main(args) {
        const hostFunction = args.constructor.constructor;
        const proc = hostFunction('return process')();
        return { escaped: typeof proc }
      }
    `
    await expect(runCodeHeadless(source, { n: 1 })).rejects.toThrow(/Code generation from strings/)
  })

  it('逃逸失败不会伪装成成功的 JSON 结果', async () => {
    const source = `
      async function main(args) {
        try {
          const hostFunction = args.constructor.constructor;
          const proc = hostFunction('return process')();
          return { escaped: typeof proc }
        } catch (error) {
          return { escaped: 'blocked', error: String(error) }
        }
      }
    `
    const result = await runCodeHeadless(source, { n: 1 })
    expect(result.kind).toBe('json')
    // 沙箱内捕获到的只能是封锁错误，不可能拿到宿主 process（typeof 为 'object'）
    const data = (result as { data: { escaped?: string } }).data
    expect(data.escaped).toBe('blocked')
  })
})
