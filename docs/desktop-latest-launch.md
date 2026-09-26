# 桌面快捷方式始终启动最新本地代码

桌面上的“启动 Canvas Studio”快捷方式会运行 `scripts/launch-latest-desktop.ps1`。每次点击时，它会：

1. 从当前源码运行 `pnpm run build:desktop-latest`，其中包含 Node/Web 类型检查、Electron Vite 构建和 Windows 目录打包。
2. 成功后启动 `dist/current-source-release/win-unpacked/canvas-studio.exe`。
3. 如果 Canvas Studio 尚未完全退出，先停下来提示关闭旧窗口，避免旧进程占用发布目录。
4. 如果构建失败，停在错误提示，不会回退启动旧包。

因此，本地工作树中已保存的源码改动会在下次点快捷方式时进入应用；重复改代码后无需手动打包或改快捷方式。远端仓库中新提交若尚未同步到本机，仍需先执行 `git pull`；启动器不会自动拉取远端代码，也不会覆盖本地改动。

桌面快捷方式调用脚本时使用 `-NoProfile`，脚本只依赖系统 PATH 中的 `pnpm.cmd` 和项目现有依赖。构建窗口会显示进度；成功启动应用后窗口关闭。失败时窗口会停留，便于查看错误。
