import { startMcpServer } from './server'

// Electron 无窗口主进程会在 ready 后自行退出；保持 stdio 服务生命期。
// server 在 stdin end 后显式退出，定时器不会遗留为后台进程。
setInterval(() => undefined, 60_000)
startMcpServer()
