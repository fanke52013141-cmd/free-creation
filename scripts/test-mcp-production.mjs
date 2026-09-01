import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const launcher = resolve(root, 'scripts', 'canvas-mcp.cjs')
const child = spawn(process.execPath, [launcher], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

let stdout = ''
let stderr = ''
let settled = false

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- .mjs 不支持 TypeScript 返回类型标注。
const finish = (code, message) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  child.kill()
  if (code !== 0) {
    process.stderr.write(`${message}${stderr ? `\n${stderr}` : ''}\n`)
    process.exitCode = code
  }
}

const timeout = setTimeout(() => {
  finish(1, 'MCP Electron 生产入口在 10 秒内未返回 initialize 响应')
}, 10_000)

child.once('error', (error) => finish(1, `无法启动 MCP Electron 入口: ${error.message}`))
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
  const lines = stdout.split(/\r?\n/)
  stdout = lines.pop() ?? ''
  const line = lines.find((item) => item.trim().length > 0)
  if (!line) return
  try {
    const response = JSON.parse(line)
    if (
      response?.id !== 'production-smoke' ||
      response?.result?.serverInfo?.name !== 'canvas-studio'
    ) {
      finish(1, `MCP Electron 生产入口返回了无效响应: ${line}`)
      return
    }
    finish(0, '')
  } catch (error) {
    finish(1, `MCP Electron 生产入口返回了无效 JSON: ${error.message}`)
  }
})

child.stdin.end(
  `${JSON.stringify({ jsonrpc: '2.0', id: 'production-smoke', method: 'initialize', params: {} })}\n`
)
