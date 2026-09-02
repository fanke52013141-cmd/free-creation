// P3 Renderer Adapter：re-export shim → 共享层执行器
//
// 执行器实现已迁移至 @shared/engine/executors/text；renderer 通过此 shim
// 保持旧导入路径 `../../engine/executors/text` 向后兼容。
// 共享层执行器通过 ctx.gateway 调用模型网关，由 renderer 运行器注入 rendererGateway。
export * from '@shared/engine/executors/text'
