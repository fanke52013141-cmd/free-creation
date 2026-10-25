# canvas-studio

An Electron application with React and TypeScript

## Architecture Rules

- [Skill Agent 上线与独立验证备注](./docs/RELEASE_SKILL_AGENT_2026_10_25.md) — 安装/绑定、自动输入输出、独立验证结果和支持边界。

- [本地开发最新交接](./docs/HANDOFF_2026_10_24_LOCAL_DEVELOPMENT.md) — 已完成、待验收、待开发、最新验证与下一包入口；当前接续优先阅读。
- [本地功能开发优先级](./docs/LOCAL_FUNCTION_DEVELOPMENT_2026_10_24.md) — 节点编辑、执行、停止、异常恢复与诊断排障；本地使用不以前置安装第三方客户端为条件。
- [画布原生 Agent Flow 方案](./docs/canvas-agent-flow/README.md) — 当前唯一 Agent Flow 设计：上帝 Agent 构建，主 Agent 协调，专业 Agent 执行；状态机和成果均由画布节点承载。包含节点协同规范，尚未实现。
- [本地外部 Agent 接入方案](./docs/local-agent-access/README.md) — 整体规范、31 节点目标清单、同步门禁和实施计划；实际支持以交付台账为准。
- [本地 Agent 项目操作台账](./docs/local-agent-access/06-a1-1-desktop-projects.md) — 本机 CLI/MCP、项目打开、活动画布保存/导出和名称更新；实际验证与限制以台账为准。
- [本地 Agent 查询与后续路线](./docs/local-agent-access/08-a1-4-read-only-queries.md) — A1.4首包的模型/资源库/任务/诊断查询及后续分期；以台账验证记录为准。
- [Logging and diagnostics specification](./LOGGING_SPEC.md) — required impact assessment for every feature change, with implementation plan and coverage checklist.
- [Node input/output contract specification](./NODE_CONTRACT_SPEC.md) — required reading before adding or changing a node.
- [Development roadmap](./ROADMAP.md) — recommended implementation order and acceptance criteria.
- [Engineering handoff](./HANDOFF.md) — current architecture, known risks, and release checklist.
- Node contracts are validated when registered; incomplete port definitions fail fast instead of entering the canvas.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

## 即梦（Dreamina）本机 CLI 通道

即梦是**可选**的本机 CLI 供应商：不需要 Base URL 或 API Key，凭据是本机的 OAuth 登录态，按即梦会员额度计费。
它提供文生图、图生图、提示词生视频、首帧视频、首尾帧视频、参考生视频六项能力，全部落在既有的「生图」与「视频生成」节点上（不新增节点、不改变端口契约）。

### 1. 安装 CLI（每台机器一次）

Windows 请用 **Git Bash** 执行，不要用 WSL——WSL 里装出来的是 Linux 二进制，桌面端调不到：

```bash
curl -s https://jimeng.jianying.com/cli | bash
```

默认安装到 `~/bin/dreamina`（Windows 为 `%USERPROFILE%\bin\dreamina.exe`），并写入用户 PATH。
若安装在别的路径，用环境变量指定，避免依赖 PATH：

```bash
CANVAS_STUDIO_DREAMINA_PATH=D:\tools\dreamina.exe
```

### 2. 登录（每台机器一次，可在应用内完成）

推荐在应用里完成：设置 → 模型供应商 → 新建「即梦（本机 CLI）」→ 点 **「登录即梦」**。

应用会执行 `dreamina login --headless` 并**自动打开浏览器**，你只需在页面上确认授权；面板每 2.5 秒检查一次结果，成功后自动刷新登录状态。应用不接触任何 token，登录态由 CLI 自己持久化在本机。

如果浏览器没有自动打开（或被系统拦截），面板会显示授权链接与设备码，可点「复制链接」手动打开。也可以在终端完成同样的流程：

```bash
dreamina login
```

登录态会持久化在本机，之后无需重复登录；只有过期或换机器时才需要再做一次。

检查登录是否有效：

```bash
dreamina user_credit
```

返回包含 `total_credit`、`vip_level` 的 JSON 即为已登录；若提示「未检测到有效登录态」，重新点「登录即梦」或执行 `dreamina login` 即可。

### 3. 在应用里启用

设置 → 模型供应商 → 新建 → 选择「即梦（本机 CLI）」→ 点「登录即梦」完成授权 → 点「检测本机 CLI」。
面板会显示 CLI 版本、登录状态与剩余额度，无需填写 Base URL / API Key。

### 4. 支持范围与使用注意

**可用模型（白名单，其余型号已彻底禁用）**

| 类别 | 允许                                                                       | 已禁用                                                                |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 图片 | `5.0`、`5.0Pro`                                                            | `3.0`、`3.1`、`4.0`、`4.1`、`4.5`、`4.6`、`4.7`                       |
| 视频 | `seedance2.5`、`seedance2.0_vip`、`seedance2.0fast_vip`、`seedance2.0mini` | `seedance2.0`、`seedance2.0fast`、`seedance1.5pro`、`seedance1.0fast` |

"禁用"的意思是**三层同时生效**：新建实例不预置、保存时自动移除、历史项目执行前直接拒绝并提示可用清单。
禁用原因是实测：`seedance2.0fast` / `seedance2.0` 提交后排队数十万、数小时不前进，表现就是"一直卡住"；其余型号随产品收敛一并下线。

**其他注意**

- 每次生成消耗**即梦会员额度**（不是 API 计费），提交即扣费，失败重试前请先核对任务。
- 部分模型首次使用需要在即梦 Web 端先用它生成一次，否则会返回「合规确认」提示。
- 分辨率与时长在节点上可选，默认停在最省成本的档位；部分模型有硬下限（图片最低 2k；`seedance2.0_vip` 才有 4k，其余视频仅 720p）。
- 完整协议、能力表与限制见 [即梦 CLI 接入方案](./docs/DREAMINA_CLI_ADAPTER_PLAN.md)。
