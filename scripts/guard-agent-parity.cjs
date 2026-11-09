/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * 铁律守卫：一次跑完 Agent 对接的三道门。
 *
 * 对应 docs/local-agent-access/65-AGENT-PARITY-IRON-RULE.md §3：
 *   1) 契约快照 + 受保护源码影响声明（check-agent-access）
 *   2) 业务动作分母（audit-business-actions）：新增 IPC 通道/画布动作没登记就红
 *   3) 日志门禁（check-logging-bypass）：新增网络/文件/数据库路径没接诊断就红
 *
 * 用法：node scripts/guard-agent-parity.cjs [--quiet]
 * 任一失败即非 0 退出，并在最后打印铁律摘要，提醒提交前必须补齐的动作。
 */
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const root = process.cwd()
const quiet = process.argv.includes('--quiet')

const GATES = [
  {
    name: '契约与受保护源码',
    script: 'scripts/check-agent-access.cjs',
    hint: '受保护源码变了就必须带 --reason 刷新快照并写明兼容结论（不能只刷 hash）。'
  },
  {
    name: '业务动作分母',
    script: 'scripts/audit-business-actions.cjs',
    hint: '新增 IPC 通道/画布动作必须在 action-coverage.json 登记状态与理由；新增节点要更新节点矩阵。'
  },
  {
    name: '日志门禁',
    script: 'scripts/check-logging-bypass.mjs',
    hint: '新增网络/文件/数据库/异步任务路径必须接诊断事件并更新 LOGGING_COVERAGE.md。'
  }
]

let failed = 0
for (const gate of GATES) {
  const result = spawnSync(process.execPath, [join(root, gate.script)], {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    windowsHide: true
  })
  const ok = result.status === 0
  if (!ok) {
    failed += 1
    console.log(`\n✗ ${gate.name} 未通过`)
    if (quiet) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      if (output) console.log(output.split('\n').slice(-15).join('\n'))
    }
    console.log(`  提示：${gate.hint}`)
  } else if (!quiet) {
    console.log(`✓ ${gate.name}`)
  }
}

if (failed === 0) {
  console.log('\n✓ 铁律守卫通过：契约、动作分母、日志三关全绿。')
  console.log('  提醒：真实能力是否可用仍要跑验收（node scripts/verify-acceptance.cjs --fast）。')
  process.exit(0)
}

console.log(`
────────────────────────────────────────────────────────
铁律（AGENT-PARITY-IRON-RULE §0）：
  凡改动"用户能做的业务动作"，必须在**同一次提交**里把 CLI / MCP 对接一起改完并验证。
本次有 ${failed} 道门未通过，按下面顺序补齐（详见 docs/local-agent-access/65-AGENT-PARITY-IRON-RULE.md §2）：
  1. src/shared/agent-access/ops/*.ts 登记/修改契约（输入+输出 Schema）
  2. src/main/agent-access/*-ops.ts 实现（复用 GUI 同一业务函数，不另写执行器）
  3. docs/local-agent-access/action-coverage.json 更新状态/映射/理由
  4. 涉及节点：node-actions.ts 矩阵 + node-contracts 快照同步
  5. 补测试：外部入口可达 + 未满足前置必须拒绝
  6. 台账写清证据等级（真实桌面实测 / 仅接线 / 未实测）与未覆盖边界
做不到就先别提交，或按 §4 走例外流程（需用户明确接受范围与期限）。
────────────────────────────────────────────────────────`)
process.exit(1)
