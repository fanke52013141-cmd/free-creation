/* eslint-disable @typescript-eslint/explicit-function-return-type -- repository documentation check */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const specification = /^(?:[A-Z_]+_SPEC|[A-Z_]+_STANDARD)\.md$/
const today = new Date().toISOString().slice(0, 10)
const dayMs = 24 * 60 * 60 * 1000
let failed = false

for (const directory of ['.', 'docs']) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !specification.test(entry.name)) continue
    const path = directory === '.' ? entry.name : `${directory}/${entry.name}`
    const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/)
    const header = lines.slice(0, 12)
    const report = (message) => {
      process.stderr.write(`${path} ${message}\n`)
      failed = true
    }
    const status = header
      .map((line) => /^(?:> )?status: (active|historical|draft|review|frozen)(?:\s+#.*)?$/.exec(line))
      .find(Boolean)?.[1]
    if (!status) report('缺少合法的 status')
    const verified = header.find((line) => /^(?:> )?last-verified: /.test(line))
      ?.replace(/^(?:> )?last-verified: /, '')
    const timestamp = Date.parse(verified ?? '')
    const invalidTimestamp =
      !verified ||
      !/^\d{4}-\d{2}-\d{2}$/.test(verified) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== verified ||
      verified > today
    if (status === 'active') {
      if (verified === 'unverified') report('active 规范必须登记 last-verified 日期')
      else if (invalidTimestamp) report('缺少合法的 last-verified')
      else if (Date.parse(today) - timestamp > 14 * dayMs) {
        report(`距上次验证超过 14 天（${verified}）`)
      }
    } else if (verified === 'unverified') {
      process.stderr.write(`${path} 尚未登记验证日期（${status ?? 'unknown'} 仅警告）\n`)
    } else if (invalidTimestamp) {
      process.stderr.write(`${path} last-verified 无效（${status ?? 'unknown'} 仅警告）\n`)
    } else if (Date.parse(today) - timestamp > 14 * dayMs) {
      process.stderr.write(`${path} 距上次验证超过 14 天（${verified}，${status ?? 'unknown'} 仅警告）\n`)
    }
    if (lines.join('\n').split('当前权威').length > 2) {
      report('只能有一处当前权威声明')
    }
    for (const [index, line] of lines.entries()) {
      if (/当前共\s*\d+\s*(项|种|个|类)/.test(line)) {
        report(`第 ${index + 1} 行使用了手写当前计数，请引用机器清单`)
      }
    }
  }
}

if (failed) process.exitCode = 1
else process.stdout.write('规范检查通过\n')
