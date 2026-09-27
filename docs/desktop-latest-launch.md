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

1. 如果应用仍在运行，等待你保存工作并完全退出，然后继续。
2. 非交互地从 `origin` 获取最新的 `main`，并使用 Git 的快进合并。未提交的本地修改会保留；若远端更新与这些修改冲突，Git 会阻止合并。本地未跟踪文件保持原样。
3. 用 `pnpm install --frozen-lockfile` 同步依赖，清理旧打包目录，然后运行 `pnpm run build:desktop-latest`，其中包含 Node/Web 类型检查、Electron Vite 构建和 Windows 目录打包。
4. 检查新应用及渲染页面存在，记录源码提交和构建时间，再启动 `dist/current-source-release/win-unpacked/canvas-studio.exe`。

网络、Git 合并、依赖或构建失败时，窗口会保留并显示原因，不会启动旧版本；成功启动后窗口会自动关闭。若本地修改与远端更新冲突，请先处理冲突再点击快捷方式。当前本地保存的修改会进入新构建。Windows PowerShell 使用带 BOM 的 UTF-8 读取含中文的 `.ps1` 文件；仓库的 `.editorconfig` 已固定这一编码。
