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
