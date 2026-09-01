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

import {
  agentExecutionEnabledFromEnv,
  agentWriteEnabledFromEnv,
  createServices,
  DesktopProjectStore
} from '@application'
import type { Result, ServiceContainer } from '@application'
import type { NodeTypeId } from '@shared/types'
import { createHeadlessGateway } from '../main/headless/gateway-client'
import { HeadlessRunExecutor } from '../main/headless/run-executor'

// ── 服务初始化 ─────────────────────────────────────────────

function getServices(): ServiceContainer {
  // 外部 CLI 默认只读；仅在 CANVAS_AGENT_WRITE=draft 时开放草稿写入——写入走
  // 图写入事务（快照同步 + 乐观锁），Agent 建的节点/连线在画布上可见。
  const writeEnabled = agentWriteEnabledFromEnv()
  const executionEnabled = agentExecutionEnabledFromEnv()
  const store = new DesktopProjectStore()
  const runner = executionEnabled
    ? new HeadlessRunExecutor({ store, gateway: createHeadlessGateway() })
    : undefined
  return createServices(store, {
    permission: { level: executionEnabled ? 'execute' : writeEnabled ? 'edit' : 'read' },
    writeEnabled,
    executionEnabled,
    actor: 'agent',
    requireExpectedGraphVersion: writeEnabled,
    requireIdempotencyKey: writeEnabled,
    executeRun: runner ? (run) => runner.execute(run) : undefined
  })
}

// ── 参数解析 ───────────────────────────────────────────────

interface ParsedArgs {
  command: string
  subcommand: string
  options: Record<string, string>
  flags: Set<string>
  positional: string[]
}

function writeSafety(args: ParsedArgs): { expectedGraphVersion?: number; idempotencyKey?: string } {
  const revision = args.options.revision
  if (
    revision !== undefined &&
    (!/^\d+$/.test(revision) || Number(revision) > Number.MAX_SAFE_INTEGER)
  ) {
    console.error('--revision 必须是非负整数')
    process.exit(1)
  }
  const idempotencyKey = args.options['idempotency-key']
  if (idempotencyKey !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
    console.error('--idempotency-key 长度必须为 8–128')
    process.exit(1)
  }
  return {
    expectedGraphVersion: revision === undefined ? undefined : Number(revision),
    idempotencyKey
  }
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
      const widths = keys.map((k) =>
        Math.max(k.length, ...items.map((i) => String(i[k] ?? '').slice(0, 40).length))
      )
      console.log(keys.map((k, i) => k.padEnd(widths[i])).join('  '))
      console.log(widths.map((w) => '-'.repeat(w)).join('  '))
      for (const item of items) {
        console.log(
          keys
            .map((k, i) =>
              String(item[k] ?? '')
                .slice(0, 40)
                .padEnd(widths[i])
            )
            .join('  ')
        )
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

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

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
      if (
        args.command === 'capability' ||
        (args.command === 'node' && args.subcommand === 'types')
      ) {
        await handleCapability(args, services)
      } else {
        await handleNode(args, services)
      }
      break
    case 'workflow':
      await handleWorkflow(args, services)
      break
    case 'artifact':
      await handleArtifact(args)
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

async function handleProject(
  args: ParsedArgs,
  services: ReturnType<typeof getServices>
): Promise<void> {
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

async function handleCapability(
  args: ParsedArgs,
  services: ReturnType<typeof getServices>
): Promise<void> {
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

async function handleNode(
  args: ParsedArgs,
  services: ReturnType<typeof getServices>
): Promise<void> {
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
        type: type as NodeTypeId,
        title: args.options.title,
        params,
        ...writeSafety(args)
      })
      output(result, args.flags)
      break
    }
    case 'connect': {
      const projectId = args.options.project
      const from = args.options.from
      const to = args.options.to
      if (!projectId || !from || !to) {
        console.error(
          '用法: canvas node connect --project <id> --from <nodeId:portId> --to <nodeId:portId>'
        )
        process.exit(1)
      }

      // 节点 id 为 tldraw shape id（形如 shape:xxx），端口引用按最后一个冒号切分
      const parseRef = (ref: string): { nodeId: string; portId: string } => {
        const idx = ref.lastIndexOf(':')
        if (idx <= 0 || idx === ref.length - 1) {
          console.error(`非法端口引用: ${ref}（应为 <nodeId>:<portId>）`)
          process.exit(1)
        }
        return { nodeId: ref.slice(0, idx), portId: ref.slice(idx + 1) }
      }

      const result = await services.nodeService.connectNodes({
        projectId,
        from: parseRef(from),
        to: parseRef(to),
        ...writeSafety(args)
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
      const result = await services.nodeService.deleteNode(projectId, nodeId, writeSafety(args))
      output(result, args.flags)
      break
    }
    default:
      console.error(`未知子命令: node ${args.subcommand}`)
      process.exit(1)
  }
}

// ── workflow 命令 ─────────────────────────────────────────

async function handleWorkflow(
  args: ParsedArgs,
  services: ReturnType<typeof getServices>
): Promise<void> {
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

async function handleArtifact(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case 'list': {
      const projectId = args.options.project
      if (!projectId) {
        console.error('用法: canvas artifact list --project <id>')
        process.exit(1)
      }
      const artifacts = await new DesktopProjectStore().listArtifacts(projectId)
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
  CANVAS_DATA_DIR      数据目录路径
  CANVAS_AGENT_WRITE   设为 draft 时开放草稿写入（默认只读）
`)
}

// ── 启动 ──────────────────────────────────────────────────
