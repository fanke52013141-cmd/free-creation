# canvas-studio

An Electron application with React and TypeScript

## Architecture Rules

- [画布原生 Agent Flow 方案](./docs/canvas-agent-flow/README.md) — 当前唯一 Agent Flow 设计：上帝 Agent 构建，主 Agent 协调，专业 Agent 执行；状态机和成果均由画布节点承载。包含节点协同规范，尚未实现。
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

### 4. 使用注意

- 每次生成消耗**即梦会员额度**（不是 API 计费），提交即扣费，失败重试前请先核对任务。
- 部分模型首次使用需要在即梦 Web 端先用它生成一次，否则会返回「合规确认」提示。
- 视频排队时间随模型差异很大；长时间排队时可改用 `seedance2.5`（480p 起，队列通常更短）。
- 分辨率与时长在节点上可选，默认停在最省成本的档位；部分模型有硬下限（4.x/5.0 图片最低 2k；seedance2.0 系列视频仅 720p）。
- 完整协议、能力表与限制见 [即梦 CLI 接入方案](./docs/DREAMINA_CLI_ADAPTER_PLAN.md)。
