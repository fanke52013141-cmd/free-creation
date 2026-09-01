#!/usr/bin/env node
/* MCP 也必须运行在 Electron ABI，才能安全读取与桌面端一致的 SQLite 数据。 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process')
const { resolve } = require('node:path')
const electron = require('electron')

const child = spawn(electron, [resolve(__dirname, '../out/agent/canvas-mcp.cjs')], {
  stdio: 'inherit',
  windowsHide: true
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
