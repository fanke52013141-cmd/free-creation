/**
 * 发行版构建开关。
 *
 * `CANVAS_DISTRIBUTION=1 npm run build` 时 electron-vite 注入 `__CANVAS_DISTRIBUTION__=true`：
 * - 主进程跳过授权门禁与设备密钥库（API Key 走系统安全存储，导入即用）；
 * - 渲染层隐藏发行版裁剪的节点类型（见 DISTRIBUTION_HIDDEN_NODE_TYPES）。
 * 常规开发/测试构建该值为 false，行为与主线完全一致。
 */
declare const __CANVAS_DISTRIBUTION__: boolean

export const DISTRIBUTION_EDITION: boolean =
  typeof __CANVAS_DISTRIBUTION__ === 'boolean' ? __CANVAS_DISTRIBUTION__ : false

/**
 * 发行版裁剪的节点类型。
 *
 * **2026-11-08 用户决定：不做发行版节点裁剪。**
 * 产品要求是"所有节点都能被人操作，也都能被 Agent 操作"；任何被裁掉的类型都会造成
 * 人能做/Agent 不能做（或反之）的能力缺口，与 GUI/CLI/MCP 三入口一致性的目标冲突。
 *
 * 因此这里保持为空集合：注册、Dock、拖线菜单、新建项目选择器与外部接入
 * （ACTIVE_NODE_TYPE_IDS）看到的是**同一套 32 类节点**。
 * 机制保留（而不是删掉判断）是为了将来若确实需要裁剪时，只需填这张表，且
 * 三入口会**同时**收敛，不会出现单边缺口。
 */
export const DISTRIBUTION_HIDDEN_NODE_TYPES: ReadonlySet<string> = new Set([])

