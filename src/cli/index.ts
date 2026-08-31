#!/usr/bin/env node
/**
 * Canvas Studio CLI — 命令行接口
 *
 * CLI 是底层应用服务层的第一个适配器，用于验证无界面执行是否成立。
 * 也是后续回归测试的最佳工具。
 *
 * 用法：
 *   canvas project list
 *   canvas project create <name>
 *   canvas project open <id>
 *   canvas capability list
 *   canvas capability get <id>
 *   canvas node types
 *   canvas node list --project <id>
 *   canvas node create --project <id> --type <type> [--title <title>] [--param key=value]
 *   canvas node connect --project <id> --from <nodeId:portId> --to <nodeId:portId>
 *   canvas workflow validate --project <id>
 *   canvas workflow estimate --project <id>
 *   canvas workflow run --project <id> [--dry-run]
 *
 * 环境变量：
 *   CANVAS_DATA_DIR  数据目录路径（默认使用 Electron userData 目录）
 */

import { createServices, FileProjectStore } from '@application'
import type { Result } from '@application'
import { join } from 'path'
import { homedir } from 'os'

// ── 数据目录 ───────────────────────────────────────────────

function getDataDir(): string {
  const env = process.env.CANVAS_DATA_DIR
  if (env) return env

  // 默认：与 Electron app.getPath('userData') 对齐
  const platform = process.platform
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'canvas-studio', 'data')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'canvas-studio', 'data')
  }
  return join(homedir(), '.config', 'canvas-studio', 'data')
}

// ── 服务初始化 ─────────────────────────────────────────────

function getServices() {
  const store = new FileProjectStore({ dataDir: getDataDir() })
  return createServices(store)
}

// ── 参数解析 ───────────────────────────────────────────────

interface ParsedArgs {
  command: string
  subcommand: string
  options: Record<string, string>
  flags: Set<string>
  positional: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2) // 跳过 node 和脚本路径
  const options: Record<string, string> = {}
  const flags = new Set<string>()
  const positional: string[] = []

  let command = ''
  let subcommand = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        options[key] = next
        i++
      } else {
        flags.add(key)
      }
    } else if (!command) {
      command = arg
    } else if (!subcommand) {
      subcommand = arg
    } else {
      positional.push(arg)
    }
  }

  return { command, subcommand, options, flags, positional }
}

// ── 输出格式化 ─────────────────────────────────────────────

function output<T>(result: Result<T>, flags: Set<string>): void {
  if (result.ok) {
    if (flags.has('json')) {
      console.log(JSON.stringify(result.data, null, 2))
    } else {
      printHumanReadable(result.data)
    }
  } else {
    console.error(`错误 [${result.error.code}]: ${result.error.message}`)
    if (result.error.details && flags.has('verbose')) {
      console.error('详情:', JSON.stringify(result.error.details, null, 2))
    }
    process.exit(1)
  }
}

function printHumanReadable(data: unknown): void {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('(空)')
      return
    }
    if (typeof data[0] === 'object' && data[0] !== null) {
      // 表格格式
      const items = data as Record<string, unknown>[]
      const keys = Object.keys(items[0]).slice(0, 5)
      const widths = keys.map((k) => Math.max(k.length, ...items.map((i) => String(i[k] ?? '').slice(0, 40).length)))
      console.log(keys.map((k, i) => k.padEnd(widths[i])).join('  '))
      console.log(widths.map((w) => '-'.repeat(w)).join('  '))
      for (const item of items) {
        console.log(keys.map((k, i) => String(item[k] ?? '').slice(0, 40).padEnd(widths[i])).join('  '))
      }
      console.log(`\n共 ${items.length} 条`)
    } else {
      data.forEach((item) => console.log(item))
    }
  } else if (typeof data === 'object' && data !== null) {
    printObject(data as Record<string, unknown>, 0)
  } else {
    console.log(data)
  }
}

function printObject(obj: Record<string, unknown>, indent: number): void {
  const pad = '  '.repeat(indent)
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      console.log(`${pad}${key}:`)
      printObject(value as Record<string, unknown>, indent + 1)
    } else if (Array.isArray(value)) {
      console.log(`${pad}${key}: [${value.length} 项]`)
      if (value.length > 0 && indent < 2) {
        printObject(value[0] as Record<string, unknown>, indent + 1)
      }
    } else {
      console.log(`${pad}${key}: ${value}`)
    }
  }
}

// ── 命令处理 ───────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  if (!args.command) {
    printHelp()
    return
  }

  const services = getServices()

  switch (args.command) {
    case 'project':
      await handleProject(args, services)
      break
    case 'capability':
    case 'node':
      if (args.command === 'capability' || (args.command === 'node' && args.subcommand === 'types')) {
        await handleCapability(args, services)
      } else {
        await handleNode(args, services)
      }
      break
    case 'workflow':
      await handleWorkflow(args, services)
      break
    case 'artifact':
      await handleArtifact(args, services)
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      console.error(`未知命令: ${args.command}`)
      printHelp()
      process.exit(1)
  }
}

// ── project 命令 ──────────────────────────────────────────

async function handleProject(args: ParsedArgs, services: ReturnType<typeof getServices>): Promise<void> {
  switch (args.subcommand) {
    case 'list': {
      const result = await services.projectService.listProjects()
      output(result, args.flags)
      break
    }
    case 'create': {
      const name = args.positional[0] || args.options.name
      if (!name) {
        console.error('用法: canvas project create <name>')
        process.exit(1)
      }
      const result = await services.projectService.createProject(name)
      output(result, args.flags)
      break
    }
    case 'open': {
      const id = args.positional[0] || args.options.id
      if (!id) {
        console.error('用法: canvas project open <id>')
        process.exit(1)
      }
      const result = await services.projectService.getProject(id)
      output(result, args.flags)
      break
    }
    case 'delete': {
      const id = args.positional[0] || args.options.id
      if (!id) {
        console.error('用法: canvas project delete <id>')
        process.exit(1)
      }
      const result = await services.projectService.deleteProject(id)
      output(result, args.flags)
      break
    }
    default:
      console.error(`未知子命令: project ${args.subcommand}`)
      process.exit(1)
  }
}

// ── capability 命令 ───────────────────────────────────────

async function handleCapability(args: ParsedArgs, services: ReturnType<typeof getServices>): Promise<void> {
  switch (args.subcommand) {
    case 'list':
    case 'types': {
      const result = await services.capabilityService.listCapabilities()
      output(result, args.flags)
      break
    }
    case 'get': {
      const id = args.positional[0] || args.options.id
      if (!id) {
        console.error('用法: canvas capability get <id>')
        process.exit(1)
      }
      const result = await services.capabilityService.getCapability(id)
      output(result, args.flags)
      break
    }
    default:
      console.error(`未知子命令: capability ${args.subcommand}`)
      process.exit(1)
  }
}

// ── node 命令 ─────────────────────────────────────────────

async function handleNode(args: ParsedArgs, services: ReturnType<typeof getServices>): Promise<void> {
  switch (args.subcommand) {
    case 'list': {
      const projectId = args.options.project
      if (!projectId) {
        console.error('用法: canvas node list --project <id>')
        process.exit(1)
      }
      const result = await services.nodeService.listNodes(projectId)
      output(result, args.flags)
      break
    }
    case 'create': {
      const projectId = args.options.project
      const type = args.options.type
      if (!projectId || !type) {
        console.error('用法: canvas node create --project <id> --type <type> [--title <title>]')
        process.exit(1)
      }

      // 解析 --param key=value 参数
      const params: Record<string, unknown> = {}
      if (args.options.param) {
        for (const pair of args.options.param.split(',')) {
          const [k, v] = pair.split('=')
          if (k && v) params[k.trim()] = v.trim()
        }
      }

      const result = await services.nodeService.createNode({
        projectId,
        type: type as any,
        title: args.options.title,
        params
      })
      output(result, args.flags)
      break
    }
    case 'connect': {
      const projectId = args.options.project
      const from = args.options.from
      const to = args.options.to
      if (!projectId || !from || !to) {
        console.error('用法: canvas node connect --project <id> --from <nodeId:portId> --to <nodeId:portId>')
        process.exit(1)
      }

      const [fromNodeId, fromPortId] = from.split(':')
      const [toNodeId, toPortId] = to.split(':')

      const result = await services.nodeService.connectNodes({
        projectId,
        from: { nodeId: fromNodeId, portId: fromPortId },
        to: { nodeId: toNodeId, portId: toPortId }
      })
      output(result, args.flags)
      break
    }
    case 'delete': {
      const projectId = args.options.project
      const nodeId = args.positional[0] || args.options.id
      if (!projectId || !nodeId) {
        console.error('用法: canvas node delete --project <id> <nodeId>')
        process.exit(1)
      }
      const result = await services.nodeService.deleteNode(projectId, nodeId)
      output(result, args.flags)
      break
    }
    default:
      console.error(`未知子命令: node ${args.subcommand}`)
      process.exit(1)
  }
}

// ── workflow 命令 ─────────────────────────────────────────

async function handleWorkflow(args: ParsedArgs, services: ReturnType<typeof getServices>): Promise<void> {
  const projectId = args.options.project
  if (!projectId) {
    console.error('用法: canvas workflow <subcommand> --project <id>')
    process.exit(1)
  }

  switch (args.subcommand) {
    case 'validate': {
      const result = await services.workflowService.validateWorkflow({ projectId })
      output(result, args.flags)
      break
    }
    case 'estimate': {
      const result = await services.workflowService.estimateRun({ projectId })
      output(result, args.flags)
      break
    }
    case 'run': {
      const dryRun = args.flags.has('dry-run')
      const result = await services.workflowService.runWorkflow({ projectId, dryRun })
      output(result, args.flags)
      break
    }
    default:
      console.error(`未知子命令: workflow ${args.subcommand}`)
      process.exit(1)
  }
}

// ── artifact 命令 ─────────────────────────────────────────

async function handleArtifact(args: ParsedArgs, _services: ReturnType<typeof getServices>): Promise<void> {
  switch (args.subcommand) {
    case 'list': {
      const projectId = args.options.project
      if (!projectId) {
        console.error('用法: canvas artifact list --project <id>')
        process.exit(1)
      }
      // FileProjectStore 的 listArtifacts 当前返回空
      const store = new FileProjectStore({ dataDir: getDataDir() })
      const artifacts = await store.listArtifacts(projectId)
      output({ ok: true, data: artifacts }, args.flags)
      break
    }
    default:
      console.error(`未知子命令: artifact ${args.subcommand}`)
      process.exit(1)
  }
}

// ── 帮助 ──────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Canvas Studio CLI — 无限画布命令行工具

命令：
  project    项目管理
  capability 能力查询
  node       节点管理
  workflow   工作流操作
  artifact   产物查询

用法示例：
  canvas project list
  canvas project create "我的项目"
  canvas capability list
  canvas node types
  canvas node list --project <projectId>
  canvas node create --project <projectId> --type text --title "提示词"
  canvas node connect --project <projectId> --from <nodeId:out-text> --to <nodeId:in-text>
  canvas workflow validate --project <projectId>
  canvas workflow estimate --project <projectId>
  canvas workflow run --project <projectId> --dry-run

选项：
  --json       输出 JSON 格式
  --verbose    显示详细错误信息
  --dry-run    预演模式（不实际执行）

环境变量：
  CANVAS_DATA_DIR  数据目录路径
`)
}

// ── 启动 ──────────────────────────────────────────────────

main().catch((err) => {
  console.error('致命错误:', err.message)
  process.exit(1)
})
