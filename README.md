# canvas-studio

An Electron application with React and TypeScript

## Architecture Rules

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
