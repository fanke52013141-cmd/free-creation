#!/usr/bin/env node
/* 以 Electron ABI 启动 CLI，确保 better-sqlite3 与桌面端使用同一原生模块。 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const electron = require('electron')

const result = spawnSync(
  electron,
  [resolve(__dirname, '../out/agent/canvas.cjs'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    windowsHide: true
  }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
