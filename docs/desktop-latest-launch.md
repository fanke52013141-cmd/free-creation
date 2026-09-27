# 桌面快捷方式始终启动最新本地代码

首次在仓库根目录执行以下命令，或在移动仓库目录后再次执行：

```powershell
pnpm run desktop:install-latest-shortcut
```

该命令会创建或更新桌面上的 `自由画布.lnk`，目标是本仓库的 `scripts/launch-latest-desktop.ps1`。它可以重复执行，并会覆盖同名的旧快捷方式配置。需要使用其他名称时，直接运行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/install-latest-desktop-shortcut.ps1 -Name 'Canvas Studio 最新版'
```

以后点击 `自由画布` 时，会显示一个 PowerShell 构建窗口，并按以下顺序执行：

1. 确认 `canvas-studio.exe` 没有运行，避免占用发布目录。
2. 从 PATH 或 Windows 用户级 pnpm 安装目录定位 `pnpm.cmd`，再从当前仓库中已保存的源码运行 `pnpm run build:desktop-latest`，其中包含 Node/Web 类型检查、Electron Vite 构建和 Windows 目录打包。
3. 只在构建成功后启动 `dist/current-source-release/win-unpacked/canvas-studio.exe`。
4. 构建失败时保留错误窗口，不会启动旧的打包产物。

因此，保存本地代码后再次点击快捷方式即可进入本地最新版本。远端仓库的新提交仍需先同步到本机；启动器不会自动拉取远端代码，也不会覆盖本地改动。
