import { startMcpServer } from './server'

// 必须立即注册 stdin：MCP 客户端会在子进程刚启动时发送 initialize。
// 包装器以 ELECTRON_RUN_AS_NODE=1 启动，保留 Electron ABI、避免无窗口 app
// 生命周期提前退出；server 在 stdin end 后退出。
startMcpServer()
