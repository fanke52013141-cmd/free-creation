/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 自用版构建：CANVAS_OWNER=1 构建三端产物，再出 Windows NSIS 安装包。
 * 与发行版的区别：自用版跳过授权门禁/设备绑定密钥库，但**不裁剪节点**（全功能）。
 * 不要把自用版安装包对外分发。
 */
const { spawnSync } = require('node:child_process')

const env = { ...process.env, CANVAS_OWNER: '1' }

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true })
  if (result.status !== 0) {
    console.error(`构建失败（exit=${result.status}）：${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

run('npm', ['run', 'build'])
run('npx', [
  'electron-builder',
  '--win',
  '--config.directories.output=dist/personal'
])
console.log('\n自用版构建完成：dist/personal/canvas-studio-1.0.0-setup.exe（含 win-unpacked/）')
