/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 发行版构建：CANVAS_DISTRIBUTION=1 构建三端产物，再出 Windows NSIS 安装包。
 * 用 node 包装设置环境变量，规避 Windows cmd 不支持 `VAR=1 cmd` 前缀语法的问题。
 */
const { spawnSync } = require('node:child_process')

const env = { ...process.env, CANVAS_DISTRIBUTION: '1' }

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true })
  if (result.status !== 0) {
    console.error(`构建失败（exit=${result.status}）: ${cmd} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win'])
console.log('\n发行包构建完成：dist/canvas-studio-setup-*.exe（含 win-unpacked/）')
