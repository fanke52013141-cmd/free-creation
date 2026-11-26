import { ACTIVE_NODE_TYPE_IDS } from '../types'

/**
 * 逐节点动作矩阵（16 号计划 N1–N8）。
 *
 * 为什么需要它：`node.type.list` 此前对全部 32 类节点一律返回 `planned`，
 * 于是"哪些节点真的接通了、哪些还没有证据"只能靠人翻台账——发布报告里
 * 「按节点×动作算覆盖率」给不出可信数字。本模块把这件事变成机器可读数据。
 *
 * 三条规矩，任何一条破了 `validateNodeActionMatrix()` 就报错、门禁失败：
 * 1) 32 类 Active 节点都必须有条目，且 N1–N8 八项都在；
 * 2) 状态只能取下面五种枚举之一；
 * 3) 除 `planned` 外，每一项都必须写出可复核的证据来源（台账/测试/里程碑段落），
 *    不允许"口头已验证"。
 *
 * 状态含义（与 AGENT_PARITY_SPEC §4 的开发状态对齐）：
 * - `desktop-tested`：真实 Electron 桌面验收通过（里程碑 report.json 里有对应检查）；
 * - `contract-tested`：契约/服务级测试通过（同一实现，但没有桌面逐动作证据）；
 * - `implemented`：有实现但缺可复核测试证据（不应长期停留）；
 * - `planned`：外部尚未接通；
 * - `not-applicable`：该节点不适用此动作，必须给理由。
 */
export const NODE_ACTION_IDS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'] as const
export type NodeActionId = (typeof NODE_ACTION_IDS)[number]

export const NODE_ACTION_LABELS: Record<NodeActionId, string> = {
  N1: '查询类型、默认值、字段、端口与依赖',
  N2: '创建/读写标题位置尺寸、克隆、删除、组合与排列',
  N3: '配置、正文、素材、模型与节点专有字段读写',
  N4: '创建/修改/删除连线与动态端口',
  N5: '执行、显式发布或作为素材输出',
  N6: '结果、版本选择、输出投影与物化',
  N7: '状态、任务、取消、暂停与恢复',
  N8: '节点库保存/实例化、资源捕获与跨画布复用'
}

export const NODE_ACTION_STATUSES = [
  'desktop-tested',
  'contract-tested',
  'implemented',
  'planned',
  'not-applicable'
] as const
export type NodeActionStatus = (typeof NODE_ACTION_STATUSES)[number]

export interface NodeActionState {
  status: NodeActionStatus
  /** 可复核证据（台账/测试/里程碑段落）。planned 与 not-applicable 也写原因或证据位置。 */
  evidence: string
}

export interface NodeActionMatrixEntry {
  typeId: string
  contractVersion?: number
  actions: Record<NodeActionId, NodeActionState>
}

/** 里程碑证据的统一引用（真实桌面 report.json 的段落名）。 */
const M = 'qa/local-agent-access/milestone-a-b-c/report.json'
const EXECS = 'test/ 执行器/输出投影服务级测试（同一实现，无桌面逐动作证据）'

/** 外部画布动作的通用证据：graph.patch/node.get 的服务级与桌面级覆盖。 */
const GRAPH_CONTRACT = 'test/local-agent-graph-access.test.ts（创建/读写/连线/删除）'

const NA = (reason: string): NodeActionState => ({ status: 'not-applicable', evidence: reason })
const P = (reason: string): NodeActionState => ({ status: 'planned', evidence: reason })
const C = (evidence: string): NodeActionState => ({ status: 'contract-tested', evidence })
const D = (evidence: string): NodeActionState => ({ status: 'desktop-tested', evidence })

const N1_CONTRACT = (): NodeActionState =>
  C(
    'node.type.get 读取生成快照（test/node-contracts-export.test.ts 漂移门禁）；含端口/初始配置/执行方式/输出真值来源；动态端口节点导出默认配置结果'
  )

/**
 * 按族给出默认动作状态，再对里程碑真实覆盖过的类型逐项覆盖。
 *
 * 注意：这里刻意**不**把"服务级测试通过"写成 desktop-tested；也不把
 * "有执行器"当成"外部可执行已验收"。
 */
function familyDefaults(family: 'document' | 'media' | 'paid' | 'conversation' | 'agent' | 'director'): Record<NodeActionId, NodeActionState> {
  const common: Record<NodeActionId, NodeActionState> = {
    N1: N1_CONTRACT(),
    N2: C(GRAPH_CONTRACT),
    N3: C(GRAPH_CONTRACT),
    N4: C(GRAPH_CONTRACT),
    N5: C(EXECS),
    N6: C('output.get 服务级投影测试（确定性族）'),
    N7: C('run.get/run.wait/run.cancel 服务级测试（external_runs）'),
    N8: C('node.library.compose/insert 服务级测试（全类型通用保存）')
  }
  if (family === 'document') return common
  if (family === 'media')
    return {
      ...common,
      N5: C('本地媒体执行器服务级测试（ffmpeg 路径见里程碑 §frame/clip/adjust）'),
      N6: C('output.get 媒体投影服务级测试')
    }
  if (family === 'paid')
    return {
      ...common,
      N5: P('付费供应商执行从未实测（无预算授权）；仅验证了缺模型/凭据时在付费调用前如实拒绝'),
      N6: P('无真实产物可投影；output.get 对未运行的付费节点不伪造输出'),
      N7: P('长任务取消/恢复未验收（需真实付费任务）')
    }
  if (family === 'conversation')
    return {
      ...common,
      N5: C('chat 执行器服务级测试；助手回复需已验证模型（桌面实测为如实失败）'),
      N7: C('node.execute/run.cancel 服务级测试（external_runs）；对话流式取消与 GUI 共用引擎，真实供应商长任务未验收')
    }
  if (family === 'agent')
    return {
      ...common,
      N2: P('内部 Agent 运行由桌面宿主实例独占，外部创建/运行未开放（F8 剩余）'),
      N5: P('run/pause/stop/review 需要共享宿主句柄与外部主体协议，尚未开放'),
      N7: P('Agent 任务状态/暂停/停止需共享宿主句柄，外部只能读账本事实（F8 剩余）'),
      N8: NA('Agent/状态机/审核节点的运行身份不可由外部伪造，节点库组合只保存结构与配置')
    }
  return {
    ...common,
    N5: D(`${M} §publish（人工授权后经宿主渲染并写正式发布记录）`),
    N6: D(`${M} §publish（output.get 以 manual-publish 投影已发布帧）`),
    N7: P('发布授权有等待/继续协议，但发布任务的取消/恢复未实现')
  }
}

interface Overrides {
  contractVersion: number
  family: 'document' | 'media' | 'paid' | 'conversation' | 'agent' | 'director'
  /** 里程碑真实覆盖到的动作。 */
  desktop?: Partial<Record<NodeActionId, string>>
  extra?: Partial<Record<NodeActionId, NodeActionState>>
}

const NODE_TABLE: Record<string, Overrides> = {
  // 文档/确定性族
  text: {
    contractVersion: 3,
    family: 'document',
    desktop: {
      N2: `${M} §execute（批量建图含文本节点）`,
      N3: `${M} §execute（正文/配置与 GUI 同源）`,
      N4: `${M} §execute（文本→处理→JSON 连线）`,
      N5: `${M} §execute（确定性文本流程执行）`,
      N6: `${M} §execute（正式输出读取）`,
      N7: `${M} §cancel（终态/未知任务拒绝与取消契约）`
    }
  },
  json: { contractVersion: 1, family: 'document' },
  processor: { contractVersion: 1, family: 'document' },
  structured: { contractVersion: 1, family: 'document' },
  storyboard: { contractVersion: 1, family: 'document' },
  code: {
    contractVersion: 3,
    family: 'document',
    extra: {
      N5: C('code 执行器/输出投影服务级测试；sandbox boundary pending，未完成隔离专项审计，不宣称可发布')
    }
  },
  website: { contractVersion: 1, family: 'document' },
  iterate: { contractVersion: 2, family: 'document' },
  'ai-process': {
    contractVersion: 1,
    family: 'document',
    extra: {
      N5: C('ai-process 执行器与模拟网关服务级测试；真实文本模型调用按已验证连接运行，不归为纯本地确定性计算'),
      N6: C('output.get 模型输出投影与运行时 JSON Schema 严格校验服务级测试'),
      N7: C('node.execute/run.cancel 服务级测试与 W1 退避重试单测')
    }
  },
  // 媒体/本地处理族
  image: {
    contractVersion: 3,
    family: 'media',
    desktop: {
      N2: `${M} §crop（媒体登记→素材节点引用）`,
      N3: `${M} §crop（mediaId 引用与媒体归属）`,
      N4: `${M} §crop（素材→裁剪连线）`,
      N6: `${M} §crop（正式产物读取）`,
      N8: `${M} §nodeLibrary（图片节点参与组合保存与实例化）`
    }
  },
  'image-crop': {
    contractVersion: 2,
    family: 'media',
    desktop: {
      N2: `${M} §crop/§quad（裁剪节点创建与 quad 参数）`,
      N3: `${M} §clamp（越界坐标由同一解析钳制）`,
      N5: `${M} §crop/§quad（本地裁剪执行）`,
      N6: `${M} §crop（产物落盘与索引）`,
      N8: `${M} §nodeLibrary（裁剪节点组合实例化）`
    }
  },
  'image-split': {
    contractVersion: 3,
    family: 'media',
    desktop: {
      N2: `${M} §split（拆分节点创建）`,
      N5: `${M} §split（4 资产拆分与失败回滚）`,
      N6: `${M} §split（选中格投影）`
    }
  },
  'video-asset': { contractVersion: 2, family: 'media' },
  'video-frame': {
    contractVersion: 4,
    family: 'media',
    desktop: { N5: `${M} §frame（2000ms 抽帧真实执行）`, N6: `${M} §frame（PNG 产物读取）` }
  },
  'video-clip': {
    contractVersion: 5,
    family: 'media',
    desktop: {
      N5: `${M} §clip（3–6s 截取双产物，ffprobe 独立核验）`,
      N6: `${M} §clip（画面+音频双产物投影）`
    }
  },
  audio: { contractVersion: 3, family: 'media' },
  'sound-adjust': {
    contractVersion: 1,
    family: 'media',
    desktop: { N5: `${M} §adjust（2× 倍速，产物时长实测）`, N6: `${M} §adjust（MIME 路由端口投影）` }
  },
  'silence-trim': {
    contractVersion: 1,
    family: 'media',
    extra: {
      N5: C(
        'test/silence-trim-node.test.ts（executor/投影）+ test/silence-trim-media.test.ts（真实 ffmpeg 气口裁剪、ffprobe 独立核验）；桌面实测待办'
      ),
      N6: C('test/silence-trim-node.test.ts（out-audio 单端口投影与失败不泄漏）')
    }
  },
  timeline: {
    contractVersion: 1,
    family: 'media',
    desktop: {
      N2: `${M} §timeline（轨道/片段结构编辑经 text 通道）`,
      N3: `${M} §timeline（同一 normalizeTimeline 解析）`,
      N5: `${M} §timeline（合成成片独立资产）`,
      N6: `${M} §timeline（成片 out-video 投影）`
    }
  },
  file: { contractVersion: 2, family: 'media' },
  // 付费生成族：执行/产物未实测（用户要求不做真实克隆/设计/视频生成测试）
  'image-gen': {
    contractVersion: 3,
    family: 'paid',
    extra: { N5: P('付费生图从未实测（无预算）；用户允许最小图片生成测试，尚未执行'), N6: P('无真实产物') }
  },
  'image-edit': { contractVersion: 2, family: 'paid' },
  video: {
    contractVersion: 7,
    family: 'paid',
    desktop: {
      N5: 'BL-52 真实桌面宿主 + CLI 组合 8 路径验证 Vidu Q3 首尾帧出片（qa/bl52-vidu-combo8/receipt.json）；仅覆盖已验证 Vidu Q3 路径，不外推全部视频供应商',
      N6: 'BL-52 真实桌面宿主 output.get 返回 out-video 引用，ffprobe 实测 1920x1080 h264 成片（qa/bl52-vidu-combo8/ffprobe.json）'
    }
  },
  'video-depth': { contractVersion: 1, family: 'paid' },
  'video-clay': { contractVersion: 1, family: 'paid' },
  speech: {
    contractVersion: 4,
    family: 'paid',
    desktop: {
      N2: `${M} §audioFamily（外部创建 + GUI 可见）`,
      N3: `${M} §audioFamily（配置 JSON 读回）`,
      N5: `${M} §audioFamily（缺绑定模型时在付费调用前如实 skipped，文案与 GUI 一致）`
    }
  },
  tts: {
    contractVersion: 4,
    family: 'paid',
    desktop: {
      N2: `${M} §audioFamily（外部创建 + GUI 可见）`,
      N5: `${M} §audioFamily（缺参考语音/模型时如实 skipped，零付费调用）`
    }
  },
  'voice-design': {
    contractVersion: 1,
    family: 'paid',
    desktop: {
      N2: `${M} §audioFamily（外部创建 + GUI 可见）`,
      N5: `${M} §audioFamily（voice.design 未绑定时如实 skipped）`
    }
  },
  // 对话
  chat: {
    contractVersion: 1,
    family: 'conversation',
    desktop: {
      N2: `${M} §chat（真实画布创建对话节点）`,
      N3: `${M} §chat（会话/消息结构经 chat.patch 编辑）`,
      N5: `${M} §chat（无已验证模型时与 GUI 同因失败，不伪造回复）`,
      N6: `${M} §chat（chat.messages 读回，附件路径/MIME 由宿主注入）`
    }
  },
  // 内部 Agent / 状态机 / 审核
  agent: {
    contractVersion: 1,
    family: 'agent',
    // C 组（2026-11-24）：真窗口验收只证明"节点创建/排列/连线呈现"，
    // 不据此宣称 Agent 自主运行已验收（运行仍需已验证工具调用模型）。
    desktop: {
      N2: '真窗口：scripts/acceptance/agent-flow-layout.cjs（12 节点泳道布局、角色徽标、单步撤销）与 agent-flow-edges-walkthrough.cjs（控制线四色/淡化）均通过，agent 节点在真实画布创建与排列；qa/agent-flow-layout/receipt.json',
      N4: '真窗口：scripts/acceptance/agent-flow-edges-walkthrough.cjs 通过（controls/observes/review-gate/rework 四色关系线、无关边淡化、取消选中恢复），agent 节点连线在真实画布成立；qa/agent-flow-edges/receipt.json'
    },
    extra: {
      // F8 第二批：运行控制已开放，但真实 Agent 运行需要已验证的工具调用模型，
      // 目前只有"预检失败时零模型请求"的服务级证据，因此不写 desktop-tested。
      N5: C(
        'flowAgent.run 经共享宿主端口启动/继续（与 GUI 同一实例）；start/continue 先做工具调用预检，预检失败时零模型请求（test/local-agent-flow-agent-run-access.test.ts）'
      ),
      N7: C(
        'flowAgent.inspect/pause/stop 与 GUI 同一宿主方法（服务级测试）；真实长任务暂停/停止/恢复未在桌面实测'
      )
    }
  },
  'state-machine': {
    contractVersion: 1,
    family: 'agent',
    // C 组（2026-11-24）：真窗口创建→提交事件→推进→读投影→过期修订拒绝，全链路通过。
    desktop: {
      N2: '真窗口：scripts/acceptance/agent-flow-state-machine.cjs 通过（创建状态机节点并打开画布）；qa/agent-flow-state-machine/receipt.json',
      N5: '真窗口：同一脚本外部提交 flow.started/flow.completed 推动运行推进（真实渲染器+执行器），7 项检查全过；qa/agent-flow-state-machine/receipt.json',
      N6: '真窗口：同一脚本 output.get 投影 out-state（flow.state@1，working/修订2）；qa/agent-flow-state-machine/receipt.json',
      N7: '真窗口：同一脚本 flowStateMachine.get 读取当前阶段/修订/合法事件，过期修订被 STATE_MACHINE_REVISION_CONFLICT 拒绝；qa/agent-flow-state-machine/receipt.json'
    }
  },
  'ai-review': {
    contractVersion: 1,
    family: 'agent',
    // C 组（2026-11-24）：审核节点在真窗口参与布局与 review-gate 控制线；
    // 真实模型判断未为本轮桌面证据，不写 desktop-tested。
    desktop: {
      N2: '真窗口：scripts/acceptance/agent-flow-layout.cjs 与 agent-flow-edges-walkthrough.cjs 通过，审核节点在真实画布创建并参与泳道布局；qa/agent-flow-layout/receipt.json',
      N4: '真窗口：agent-flow-edges-walkthrough.cjs 中 review-gate 控制线着色与淡化通过，审核门禁连线在真实画布成立；qa/agent-flow-edges/receipt.json'
    },
    extra: {
      N5: C('flowAgent.review 经同一 FlowReviewHost 提交模型审核（test/local-agent-flow-agent-build-access.test.ts）；真实模型桌面验收未做'),
      N7: C('flowAgent.inspect 服务级测试（test/local-agent-flow-agents-access.test.ts）；审核长任务取消/恢复未单独验收')
    }
  },
  // C4：纯人工任务节点——人工提交结果、执行器权威交付；停等语义，composite 内 fail-closed。
  'human-task': {
    contractVersion: 1,
    family: 'agent',
    // C 组（2026-11-24）：图模式真窗口验收（fixture 模型）证明"等人工→人工提交→执行器交付→路由采用"。
    desktop: {
      N2: '真窗口：node scripts/test-agent-flow-human-task-graph.cjs 通过，human-task 节点在真实画布创建并参与图路由；qa/agent-human-task-graph/desktop/execute-report.json',
      N5: '真窗口：同一脚本通过——人工提交后经 C4 执行器在 continue 上交付，图路由采用人工交付为最终输出（无伪造成功）；qa/agent-human-task-graph/desktop/execute-report.json',
      N6: '真窗口：同一脚本通过——human delivery 作为最终输出被图路由采用并投影；qa/agent-human-task-graph/desktop/execute-report.json',
      N7: '真窗口：同一脚本通过——human-task 图节点等待人工提交（不伪造成功）、协调器在人工恢复后完成；qa/agent-human-task-graph/desktop/execute-report.json'
    }
  },
  // 导演台
  director: { contractVersion: 3, family: 'director' }
}

function buildEntry(typeId: string, overrides: Overrides): NodeActionMatrixEntry {
  const actions = familyDefaults(overrides.family)
  for (const [actionId, evidence] of Object.entries(overrides.desktop ?? {}))
    actions[actionId as NodeActionId] = D(evidence)
  for (const [actionId, state] of Object.entries(overrides.extra ?? {}))
    actions[actionId as NodeActionId] = state
  return { typeId, contractVersion: overrides.contractVersion, actions }
}

/** 供 `node.type.list` 与发布报告使用的机器目录。 */
export function nodeActionMatrix(): NodeActionMatrixEntry[] {
  return ACTIVE_NODE_TYPE_IDS.map((typeId) => {
    const overrides = NODE_TABLE[typeId]
    if (!overrides) throw new Error(`NODE_ACTION_MATRIX_MISSING:${typeId}`)
    return buildEntry(typeId, overrides)
  })
}

/** 汇总计数：发布报告不得用"类型数量"代替"动作数量"。 */
export function nodeActionSummary(): {
  nodes: number
  actions: number
  byStatus: Record<NodeActionStatus, number>
} {
  const byStatus: Record<NodeActionStatus, number> = {
    'desktop-tested': 0,
    'contract-tested': 0,
    implemented: 0,
    planned: 0,
    'not-applicable': 0
  }
  let actions = 0
  for (const entry of nodeActionMatrix())
    for (const actionId of NODE_ACTION_IDS) {
      byStatus[entry.actions[actionId].status] += 1
      actions += 1
    }
  return { nodes: ACTIVE_NODE_TYPE_IDS.length, actions, byStatus }
}

/** 门禁：矩阵自身必须自洽（缺类型/缺动作/非法状态/空证据都报错）。 */
export function validateNodeActionMatrix(): string[] {  const errors: string[] = []
  const active = new Set<string>(ACTIVE_NODE_TYPE_IDS)
  let matrix: NodeActionMatrixEntry[]
  try {
    matrix = nodeActionMatrix()
  } catch (error) {
    return [error instanceof Error ? error.message : 'NODE_ACTION_MATRIX_INVALID']
  }
  const seen = new Set<string>()
  for (const entry of matrix) {
    if (!active.has(entry.typeId)) errors.push(`MATRIX_UNKNOWN_TYPE:${entry.typeId}`)
    if (seen.has(entry.typeId)) errors.push(`MATRIX_DUPLICATE_TYPE:${entry.typeId}`)
    seen.add(entry.typeId)
    for (const actionId of NODE_ACTION_IDS) {
      const state = entry.actions[actionId]
      if (!state) {
        errors.push(`MATRIX_MISSING_ACTION:${entry.typeId}:${actionId}`)
        continue
      }
      if (!NODE_ACTION_STATUSES.includes(state.status))
        errors.push(`MATRIX_BAD_STATUS:${entry.typeId}:${actionId}:${state.status}`)
      if (!state.evidence || state.evidence.trim().length < 4)
        errors.push(`MATRIX_MISSING_EVIDENCE:${entry.typeId}:${actionId}`)
      if (state.status === 'implemented')
        errors.push(`MATRIX_UNEVIDENCED_IMPLEMENTED:${entry.typeId}:${actionId}`)
    }
  }
  for (const typeId of active) if (!seen.has(typeId)) errors.push(`MATRIX_MISSING_TYPE:${typeId}`)
  return errors
}

/** 对外的节点目录（`node.type.list` 的数据源）：逐节点逐动作状态 + 依赖说明。 */
export function nodeAccessDirectory(): Array<{
  typeId: string
  contractVersion?: number
  actions: Array<{ actionId: NodeActionId; label: string; status: NodeActionStatus; evidence: string }>
  summary: { desktopTested: number; contractTested: number; planned: number; notApplicable: number }
}> {
  return nodeActionMatrix().map((entry) => {
    const summary = { desktopTested: 0, contractTested: 0, planned: 0, notApplicable: 0 }
    for (const actionId of NODE_ACTION_IDS) {
      const state = entry.actions[actionId]
      if (state.status === 'desktop-tested') summary.desktopTested += 1
      else if (state.status === 'contract-tested') summary.contractTested += 1
      else if (state.status === 'planned') summary.planned += 1
      else if (state.status === 'not-applicable') summary.notApplicable += 1
    }
    return {
      typeId: entry.typeId,
      ...(entry.contractVersion !== undefined ? { contractVersion: entry.contractVersion } : {}),
      actions: NODE_ACTION_IDS.map((actionId) => ({
        actionId,
        label: NODE_ACTION_LABELS[actionId],
        status: entry.actions[actionId].status,
        evidence: entry.actions[actionId].evidence.slice(0, 300)
      })),
      summary
    }
  })
}
