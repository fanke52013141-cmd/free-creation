# canvas-studio

An Electron application with React and TypeScript

## Architecture Rules

- [画布原生 Agent Flow 方案](./docs/canvas-agent-flow/README.md) — 当前唯一 Agent Flow 设计：主 Agent 是画布节点，节点完成执行、状态交互和成果承载；尚未实现。
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
