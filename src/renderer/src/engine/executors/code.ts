// P3 Renderer Adapter：re-export shim → 共享层执行器
//
// 代码节点执行器通过 ctx.runCode 执行用户代码（renderer 注入 Web Worker 实现），
// 不再直接导入 renderer 的 codeRuntime 模块。
export * from '@shared/engine/executors/code'
