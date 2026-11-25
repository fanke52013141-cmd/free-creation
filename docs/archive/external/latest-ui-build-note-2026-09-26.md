# Canvas Studio 最新 UI 启动机制备注

- 日期：2026-09-26（本地时间）
- 机制提交：`e03aec2`（`feat: rebuild latest desktop app when launching shortcut`），已推送到 `origin/main`。
- 桌面快捷方式：`C:\Users\Administrator\Desktop\启动 Canvas Studio.lnk`
- 快捷方式启动脚本：`D:\Program Files (x86)\canvas-studio\source\scripts\launch-latest-desktop.ps1`
- 启动行为：每次从本机当前源码执行类型检查、Electron Vite 构建和 Windows 目录打包，然后启动最新发布包；构建失败不回退到旧包。
- 运行包：`D:\Program Files (x86)\canvas-studio\source\dist\current-source-release\win-unpacked\canvas-studio.exe`
- 验证：实际运行桌面快捷方式后，构建退出码为 0，窗口标题为“无限画布创作平台”，进程路径指向上述运行包。
- 注意：若远端有本机尚未拉取的代码，先 `git pull`；启动器只构建本机当前工作树。
