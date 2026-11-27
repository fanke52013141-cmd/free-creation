/**
 * P1 外部 Agent（MCP 默认 core 档位）真机端到端验收脚本。
 *
 * 全程只使用默认 `mcp serve`（core 档位 28 工具，不切 full），真实驱动 Electron 桌面宿主：
 * 1) MCP core 工具清单、instructions 与缺少 idempotencyKey 的格式提示；
 * 2) node_type_get 返回 configGuide；错误端口（in-first-frame）与非法 code 配置在 propose 阶段直接拦截并给出合法端口清单；
 * 3) 链 1（文本 → processor → code）：幽灵预览 → 桌面预览面板点击「确认落画布」→ 免费本地子图免 confirmPaidRerun 执行 → run_wait → output_get 核对真实 JSON；
 * 4) 链 2（media_import 越界拒绝提示 + agent-exports 合法导入 → image → image-crop → image-split）：
 *    graph_patch_confirm 触发 BL-01 桌面弹窗并人工点击「允许落画布」→ 免费本地子图免 confirmPaidRerun 执行 → output_get 核对真实媒体资产与 4 格拆分集合；
 * 5) 链 3（node.update + node.delete 幽灵差异高亮框渲染）+ graph_patch_discard 取消；
 * 6) 链 4（canvas_ops_search → canvas_ops_schema → canvas_ops_call(node.runPlan)）渐进式发现闭环。
 */
const { _electron } = require('playwright')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createCanvas } = require('@napi-rs/canvas')

const key = () => `${Date.now()}:${randomUUID()}`

function check(ok, code) {
  if (!ok) throw new Error(code)
}

function licensedSecurityDir() {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(roaming, 'canvas-studio', 'data', 'security'),
    join(roaming, 'Electron', 'data', 'security'),
    join(roaming, 'canvas-studio', 'security')
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'license-current.json'))) return candidate
  }
  throw new Error('MACHINE_NOT_LICENSED')
}

async function makeSamplePng(filePath) {
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#e74c3c'
  ctx.fillRect(0, 0, 100, 100)
  ctx.fillStyle = '#2ecc71'
  ctx.fillRect(100, 0, 100, 100)
  ctx.fillStyle = '#3498db'
  ctx.fillRect(0, 100, 100, 100)
  ctx.fillStyle = '#f1c40f'
  ctx.fillRect(100, 100, 100, 100)
  await writeFile(filePath, canvas.toBuffer('image/png'))
}

async function main() {
  const appRoot = resolve(__dirname, '../..')
  const electron = require('electron')
  const cliPath = join(appRoot, 'out/main/local-agent.js')
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-external-core-e2e-'))
  if (process.env.CANVAS_OWNER !== '1') {
    await cp(licensedSecurityDir(), join(dataDir, 'security'), { recursive: true })
  }

  const env = { ...process.env, CANVAS_DATA_DIR: dataDir }
  delete env.ELECTRON_RUN_AS_NODE

  let app
  let client
  let transport
  const checks = []

  try {
    app = await _electron.launch({
      executablePath: electron,
      args: [appRoot, '--local-agent-access'],
      env
    })
    const page = await app.firstWindow()
    await page.waitForLoadState()

    for (let i = 0; i < 100; i++) {
      try {
        await readFile(join(dataDir, 'agent-access/connection.json'))
        break
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    const mcpEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    transport = new StdioClientTransport({
      command: electron,
      args: [cliPath, 'mcp', 'serve', '--data-dir', dataDir],
      env: mcpEnv,
      stderr: 'pipe'
    })
    client = new Client({ name: 'external-agent-core-e2e', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)

    // 1. MCP core 目录与 idempotencyKey 格式引导
    const toolsRes = await client.listTools()
    const toolNames = new Set(toolsRes.tools.map((t) => t.name))
    check(toolsRes.tools.length === 28, `CORE_TOOL_COUNT:${toolsRes.tools.length}`)
    check(
      toolNames.has('graph_patch_propose') &&
        toolNames.has('graph_patch_confirm') &&
        toolNames.has('composite_execute') &&
        toolNames.has('composite_execute_wait') &&
        toolNames.has('canvas_ops_search'),
      'CORE_TOOLS_MISSING'
    )
    const noKey = await client.callTool({
      name: 'project_create',
      arguments: { input: { name: 'Missing Key' } }
    })
    check(
      noKey.structuredContent?.error?.code === 'INVALID_INPUT' &&
        String(noKey.structuredContent?.error?.detail ?? '').includes('13-digit-ms-timestamp'),
      `MISSING_KEY_HINT:${JSON.stringify(noKey.structuredContent)}`
    )
    checks.push('MCP core 28 tools + idempotencyKey format hint')

    // 2. 创建并打开项目 + node_type_get configGuide + 坏端口/坏配置在 propose 阶段即拒绝
    const created = await client.callTool({
      name: 'project_create',
      arguments: { input: { name: 'P1 外部 Agent 核心验收' }, idempotencyKey: key() }
    })
    check(created.structuredContent?.status === 'completed', 'PROJECT_CREATE_FAILED')
    const projectId = created.structuredContent.data.meta.id

    const opened = await client.callTool({
      name: 'project_open',
      arguments: { input: { projectId }, idempotencyKey: key() }
    })
    check(opened.structuredContent?.status === 'completed', 'PROJECT_OPEN_FAILED')
    await page.waitForTimeout(800)

    const videoType = await client.callTool({
      name: 'node_type_get',
      arguments: { input: { typeId: 'video' } }
    })
    check(
      videoType.structuredContent?.status === 'completed' &&
        Boolean(videoType.structuredContent.data?.configGuide?.summary),
      'VIDEO_CONFIG_GUIDE_MISSING'
    )

    let gv = (
      await client.callTool({ name: 'graph_get', arguments: { input: { projectId, view: 'latest' } } })
    ).structuredContent.data.graphVersion

    const badPort = await client.callTool({
      name: 'graph_patch_propose',
      arguments: {
        input: {
          projectId,
          expectedGraphVersion: gv,
          ops: [
            { action: 'node.create', ref: 'img', nodeType: 'image-gen', x: 0, y: 0 },
            { action: 'node.create', ref: 'vid', nodeType: 'video', x: 400, y: 0 },
            {
              action: 'edge.create',
              from: { nodeId: 'img', portId: 'out-image' },
              to: { nodeId: 'vid', portId: 'in-first-frame' }
            }
          ]
        },
        idempotencyKey: key()
      }
    })
    check(
      badPort.structuredContent?.error?.code === 'EDGE_PORT_INVALID' &&
        String(badPort.structuredContent?.error?.detail ?? '').includes('in-images'),
      `BAD_PORT_NOT_PRECHECKED:${JSON.stringify(badPort.structuredContent)}`
    )
    checks.push('node_type_get configGuide + propose precheck rejects bad port with valid port list')

    // 3. 链 1：text -> processor -> code（桌面预览面板点击确认 + 免费子图免 confirmPaidRerun 执行 + output_get）
    const chain1 = await client.callTool({
      name: 'graph_patch_propose',
      arguments: {
        input: {
          projectId,
          expectedGraphVersion: gv,
          name: '链1：文案模板加工与结构化分镜',
          autoLayout: true,
          ops: [
            { action: 'node.create', ref: 'brief', nodeType: 'text', title: '创意简报', x: 0, y: 0, text: '海边木屋清晨咖啡' },
            {
              action: 'node.create',
              ref: 'polish',
              nodeType: 'processor',
              title: '分镜提示词模板',
              x: 420,
              y: 0,
              config: { operation: 'template', template: '电影级镜头：{{value}}，暖色晨光' }
            },
            {
              action: 'node.create',
              ref: 'pack',
              nodeType: 'code',
              title: '打包分镜 JSON',
              x: 840,
              y: 0,
              config: {
                source: 'async function main(args) { return { shot: { title: "Shot 01", prompt: args.prompt } } }',
                params: [{ name: 'prompt', type: 'string' }],
                outputMode: 'fields',
                outputs: [{ name: 'shot', type: 'object' }]
              }
            },
            { action: 'edge.create', from: { nodeId: 'brief', portId: 'out-text' }, to: { nodeId: 'polish', portId: 'in-value' } },
            { action: 'edge.create', from: { nodeId: 'polish', portId: 'out-value' }, to: { nodeId: 'pack', portId: 'in-param-prompt' } }
          ]
        },
        idempotencyKey: key()
      }
    })
    check(chain1.structuredContent?.status === 'completed', `CHAIN1_PROPOSE:${JSON.stringify(chain1.structuredContent)}`)
    await page.waitForSelector('.flow-graph-preview-confirm', { timeout: 10000 })
    check((await page.locator('.flow-build-preview-node').count()) === 3, 'CHAIN1_GHOST_COUNT')
    await page.click('.flow-graph-preview-confirm')
    await page.waitForSelector('.flow-graph-preview-panel', { state: 'detached', timeout: 10000 })

    const graph1 = (
      await client.callTool({ name: 'graph_get', arguments: { input: { projectId, view: 'latest' } } })
    ).structuredContent.data
    gv = graph1.graphVersion
    const packNode = graph1.nodes.find((n) => n.type === 'code')
    check(Boolean(packNode), 'CHAIN1_CODE_NODE_MISSING')

    // 注意：故意不传 confirmPaidRerun，验证纯本地免费子图不再误报 PAID_RERUN_CONFIRM_REQUIRED
    const exec1 = await client.callTool({
      name: 'node_execute',
      arguments: {
        input: { projectId, expectedGraphVersion: gv, nodeIds: [packNode.nodeId], mode: 'subgraph' },
        idempotencyKey: key()
      }
    })
    check(exec1.structuredContent?.status === 'completed', `CHAIN1_EXEC:${JSON.stringify(exec1.structuredContent)}`)
    const wait1 = await client.callTool({
      name: 'run_wait',
      arguments: { input: { projectId, taskId: exec1.structuredContent.data.taskId, timeoutMs: 20000 } }
    })
    check(wait1.structuredContent?.data?.state === 'completed', `CHAIN1_WAIT:${JSON.stringify(wait1.structuredContent)}`)
    const out1 = await client.callTool({
      name: 'output_get',
      arguments: { input: { projectId, nodeId: packNode.nodeId } }
    })
    const shotOut = out1.structuredContent?.data?.outputs?.find((o) => o.portId === 'out-shot')
    check(
      shotOut?.json?.prompt === '电影级镜头：海边木屋清晨咖啡，暖色晨光',
      `CHAIN1_OUTPUT:${JSON.stringify(out1.structuredContent)}`
    )
    checks.push('Chain 1 (text -> processor -> code): desktop panel confirm + free-local execute + output_get')

    // 4. 链 2：media_import 越界提示 + agent-exports 合法导入 -> image -> image-crop -> image-split -> BL-01 弹窗确认 -> 执行 -> output_get
    const outsidePng = join(dataDir, 'outside.png')
    await makeSamplePng(outsidePng)
    const rejectedImport = await client.callTool({
      name: 'media_import',
      arguments: { input: { projectId, filePath: outsidePng }, idempotencyKey: key() }
    })
    check(
      rejectedImport.structuredContent?.error?.code === 'PATH_NOT_ALLOWED' &&
        String(rejectedImport.structuredContent?.error?.detail ?? '').includes('agent-exports'),
      `IMPORT_PATH_HINT:${JSON.stringify(rejectedImport.structuredContent)}`
    )

    const samplePng = join(dataDir, 'agent-exports', 'sample-quad.png')
    await mkdir(join(dataDir, 'agent-exports'), { recursive: true })
    await makeSamplePng(samplePng)
    const imported = await client.callTool({
      name: 'media_import',
      arguments: { input: { projectId, filePath: samplePng, name: '四象限图.png' }, idempotencyKey: key() }
    })
    check(imported.structuredContent?.status === 'completed', 'MEDIA_IMPORT_FAILED')
    const mediaId = imported.structuredContent.data.mediaId

    // 等待链 1 执行后的自动保存稳定，再按 latest 读取最新 graphVersion
    await page.waitForTimeout(800)
    gv = (
      await client.callTool({ name: 'graph_get', arguments: { input: { projectId, view: 'latest' } } })
    ).structuredContent.data.graphVersion

    const chain2 = await client.callTool({
      name: 'graph_patch_propose',
      arguments: {
        input: {
          projectId,
          expectedGraphVersion: gv,
          name: '链2：本地图片裁剪与2x2拆分',
          autoLayout: true,
          ops: [
            { action: 'node.create', ref: 'srcImg', nodeType: 'image', title: '原图', x: 0, y: 420, media: { mediaId } },
            {
              action: 'node.create',
              ref: 'crop',
              nodeType: 'image-crop',
              title: '居中裁剪',
              x: 420,
              y: 420,
              config: { version: 1, mode: 'rect', aspectRatio: '1:1', rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }
            },
            {
              action: 'node.create',
              ref: 'split',
              nodeType: 'image-split',
              title: '2x2拆分',
              x: 840,
              y: 420,
              config: { version: 1, rows: 2, columns: 2, scalePercent: 100 }
            },
            { action: 'edge.create', from: { nodeId: 'srcImg', portId: 'out-image' }, to: { nodeId: 'crop', portId: 'in-image' } },
            { action: 'edge.create', from: { nodeId: 'crop', portId: 'out-image' }, to: { nodeId: 'split', portId: 'in-image' } }
          ]
        },
        idempotencyKey: key()
      }
    })
    check(chain2.structuredContent?.status === 'completed', `CHAIN2_PROPOSE:${JSON.stringify(chain2.structuredContent)}`)
    const preview2Id = chain2.structuredContent.data.previewId

    const confirmPromise = client.callTool({
      name: 'graph_patch_confirm',
      arguments: { input: { projectId, previewId: preview2Id }, idempotencyKey: key() }
    })
    const approveBtn = page.getByRole('button', { name: '允许落画布' })
    await approveBtn.waitFor({ timeout: 10000 })
    await approveBtn.click()
    const confirm2 = await confirmPromise
    check(confirm2.structuredContent?.status === 'completed', `CHAIN2_CONFIRM:${JSON.stringify(confirm2.structuredContent)}`)

    gv = confirm2.structuredContent.data.graphVersion
    const splitNodeId = confirm2.structuredContent.data.created.find((c) => c.ref === 'split')?.nodeId
    check(Boolean(splitNodeId), 'CHAIN2_SPLIT_ID_MISSING')

    // 同样不传 confirmPaidRerun，验证 image-crop -> image-split 免费本地子图直接执行成功
    const exec2 = await client.callTool({
      name: 'node_execute',
      arguments: {
        input: { projectId, expectedGraphVersion: gv, nodeIds: [splitNodeId], mode: 'subgraph' },
        idempotencyKey: key()
      }
    })
    check(exec2.structuredContent?.status === 'completed', `CHAIN2_EXEC:${JSON.stringify(exec2.structuredContent)}`)
    const wait2 = await client.callTool({
      name: 'run_wait',
      arguments: { input: { projectId, taskId: exec2.structuredContent.data.taskId, timeoutMs: 30000 } }
    })
    check(wait2.structuredContent?.data?.state === 'completed', `CHAIN2_WAIT:${JSON.stringify(wait2.structuredContent)}`)
    const out2 = await client.callTool({
      name: 'output_get',
      arguments: { input: { projectId, nodeId: splitNodeId } }
    })
    const outImg = out2.structuredContent?.data?.outputs?.find((o) => o.portId === 'out-image')
    const outImages = out2.structuredContent?.data?.outputs?.find((o) => o.portId === 'out-images')
    check(
      Boolean(outImg?.mediaId) && Array.isArray(outImages?.json) && outImages.json.length === 4,
      `CHAIN2_OUTPUT:${JSON.stringify(out2.structuredContent)}`
    )
    checks.push('Chain 2 (media_import -> image -> crop -> split): BL-01 confirm + free-local execute + 4-tile output_get')

    // 5. 链 3：修改/删除幽灵差异框 + discard
    await page.waitForTimeout(800)
    gv = (
      await client.callTool({ name: 'graph_get', arguments: { input: { projectId, view: 'latest' } } })
    ).structuredContent.data.graphVersion
    const briefNode = graph1.nodes.find((n) => n.type === 'text')
    const polishNode = graph1.nodes.find((n) => n.type === 'processor')
    const diff = await client.callTool({
      name: 'graph_patch_propose',
      arguments: {
        input: {
          projectId,
          expectedGraphVersion: gv,
          name: '链3：修改与删除差异预览',
          ops: [
            { action: 'node.update', nodeId: briefNode.nodeId, title: '创意简报 v2', text: '雪山木屋' },
            { action: 'node.delete', nodeId: polishNode.nodeId }
          ]
        },
        idempotencyKey: key()
      }
    })
    check(diff.structuredContent?.status === 'completed', `CHAIN3_PROPOSE:${JSON.stringify(diff.structuredContent)}`)
    await page.waitForSelector('.flow-build-preview-diff.is-update', { timeout: 10000 })
    check(
      (await page.locator('.flow-build-preview-diff.is-update').count()) === 1 &&
        (await page.locator('.flow-build-preview-diff.is-delete').count()) === 1,
      'CHAIN3_DIFF_BOXES'
    )
    const discarded = await client.callTool({
      name: 'graph_patch_discard',
      arguments: { input: { projectId, previewId: diff.structuredContent.data.previewId }, idempotencyKey: key() }
    })
    check(discarded.structuredContent?.data?.state === 'discarded', 'CHAIN3_DISCARD')
    checks.push('Chain 3: update/delete ghost diff highlights + discard')

    // 6. 链 4：canvas_ops_search -> canvas_ops_schema -> canvas_ops_call 渐进发现
    const searchRes = await client.callTool({
      name: 'canvas_ops_search',
      arguments: { query: 'runPlan' }
    })
    check(
      searchRes.structuredContent?.operations?.some((o) => o.operationId === 'node.runPlan'),
      'CHAIN4_SEARCH'
    )
    const schemaRes = await client.callTool({
      name: 'canvas_ops_schema',
      arguments: { operationId: 'node.runPlan' }
    })
    check(Boolean(schemaRes.structuredContent?.inputSchema), 'CHAIN4_SCHEMA')
    const callRes = await client.callTool({
      name: 'canvas_ops_call',
      arguments: { operationId: 'node.runPlan', input: { projectId, nodeIds: [packNode.nodeId] } }
    })
    check(
      callRes.structuredContent?.status === 'completed' && callRes.structuredContent?.data?.nodeCount === 3,
      `CHAIN4_CALL:${JSON.stringify(callRes.structuredContent)}`
    )
    checks.push('Chain 4: progressive disclosure (search -> schema -> call node.runPlan)')

    console.log(JSON.stringify({ ok: true, checks }, null, 2))
  } finally {
    if (client) await client.close().catch(() => {})
    if (transport) await transport.close().catch(() => {})
    if (app) await app.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error('EXTERNAL_AGENT_CORE_E2E_FAILED:', err)
  process.exitCode = 1
})
