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

const N1_PLANNED = () =>
  P('缺少"节点类型目录"外部操作：main 无法导入 renderer 的 TSX 规格，需先做共享节点契约抽取（F1 遗留项）')

/**
 * 按族给出默认动作状态，再对里程碑真实覆盖过的类型逐项覆盖。
 *
 * 注意：这里刻意**不**把"服务级测试通过"写成 desktop-tested；也不把
 * "有执行器"当成"外部可执行已验收"。
 */
function familyDefaults(family: 'document' | 'media' | 'paid' | 'conversation' | 'agent' | 'director'): Record<NodeActionId, NodeActionState> {
  const common: Record<NodeActionId, NodeActionState> = {
    N1: N1_PLANNED(),
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
      N7: P('对话流式取消仅 GUI 侧验证（chatCancel 仍 F6），外部未接通')
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
  code: { contractVersion: 3, family: 'document' },
  website: { contractVersion: 1, family: 'document' },
  iterate: { contractVersion: 2, family: 'document' },
  'ai-process': { contractVersion: 1, family: 'document' },
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
  video: { contractVersion: 7, family: 'paid' },
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
  'state-machine': { contractVersion: 1, family: 'agent' },
  'ai-review': { contractVersion: 1, family: 'agent' },
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
