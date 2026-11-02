# 桌面快捷方式同步并启动最新代码

首次在仓库根目录执行以下命令，或在移动仓库目录后再次执行：

```powershell
pnpm run desktop:install-latest-shortcut
```

该命令会创建或更新桌面上的 `启动 Canvas Studio.lnk`，目标是本仓库的 `scripts/launch-latest-desktop.ps1`。它可以重复执行，并会覆盖同名的旧快捷方式配置。需要使用其他名称时，直接运行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/install-latest-desktop-shortcut.ps1 -Name 'Canvas Studio 最新版'
```

以后点击 `启动 Canvas Studio` 时，会显示一个 PowerShell 更新窗口，并按以下顺序执行：

1. 仅在 `main` 分支执行 `git pull --ff-only origin main` 快进同步；离线、历史分叉或非 main 分支时自动改用本地现有代码照常启动。本地未提交的修改始终包含在本次构建中，无需提交即可生效。
2. `pnpm-lock.yaml` 比上次安装新时才执行 `pnpm install --frozen-lockfile`，否则跳过（平时秒过）。
3. `src/` 或 `packages/` 源码（排除 `node_modules`）比上次构建新时才运行 `electron-vite build` 增量构建（约 10–40 秒），否则跳过。
4. 若应用正在运行，像点击窗口 × 一样优雅关闭旧实例（正常保存退出）；无法退出时提示手动关闭。然后直接从源码启动 `node_modules\electron\dist\electron.exe`。

成功启动后更新窗口自动关闭；依赖安装、构建或启动失败时窗口保留并显示原因，不会启动半成品。启动状态标记保存在 `%LOCALAPPDATA%\canvas-studio-launcher`。需要启动「严格校验的打包版本」（`dist/current-source-release` 的 electron-builder 产物）时，使用 `scripts/launch-verified-desktop.ps1`。Windows PowerShell 使用带 BOM 的 UTF-8 读取含中文的 `.ps1` 文件；仓库的 `.editorconfig` 已固定这一编码。
