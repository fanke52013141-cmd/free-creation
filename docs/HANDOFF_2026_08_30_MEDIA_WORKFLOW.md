# 媒体工作流模板交接单（2026-08-30）

> 分支：`main`
> 远程仓库：https://github.com/fanke52013141-cmd/free-creation

## 本轮交付

1. 新增内置模板“图片修改→后续创作”。它创建以下可见节点和真实数据依赖：

   ```text
   图片资产.out-image → 图片修改.in-image
   图片修改.out-image → 图片裁剪.in-image
   图片修改.out-image → 继续生图.in-image
   图片修改.out-image → 图片生成视频.in-image
   ```

   模板不会复制或伪造媒体。第一个“图片资产”节点是空入口；只有用户导入原图并运行图片修改节点后，三个下游节点才会取得同一份新的 `MediaAsset` 输出。

2. 修复 Electron 打包范围：`electron-builder.yml` 显式排除 `dist/**`。此前根目录保留的历史安装包会被下一次打包再次写进 `app.asar`，最终触发 4.2GB 上限；现在构建产物不会递归包含自身或旧产物。

3. 图片修改遵循模型中立规则：遮罩以标准 `prompt.mask` 发送；不按模型名称白名单或黑名单拦截。供应商是否接受图生图/遮罩，由该次真实响应确定。

## 修改位置

| 文件 | 作用 |
| --- | --- |
| `src/renderer/src/canvas/CanvasSidePanel.tsx` | 注册“图片修改→后续创作”模板和四条端口边。 |
| `test/workflow-templates.test.ts` | 回归模板的节点顺序、真实端口与三路分支。 |
| `electron-builder.yml` | 排除 `dist/**`，避免 ASAR 递归打包。 |
| `docs/HANDOFF_2026_08_29_IMAGE_EDIT.md` | 同步 D1/D2 状态与模型中立原则。 |

## 本轮验证记录

| 验证 | 结果 |
| --- | --- |
| 定向模板、连线、图片修改测试 | 4 文件、95 项通过。 |
| `npm run verify` | 通过：lint、双端类型检查、42 个测试文件、531 项测试、生产构建。 |
| `npm run test:contract` | 通过：199 项节点契约/连接矩阵/快照测试。 |
| `npm run benchmark:canvas` | 通过：100 / 500 / 1000 节点快照构造、序列化、反序列化和 bundle 基准。 |
| `npm run build:demo` | 通过。 |
| Electron 目录包 | 通过：`dist/win-unpacked-next-phase-verify2/win-unpacked/canvas-studio.exe` 已生成。 |
| 开发版桌面人工验收 | 通过：套用模板后出现 5 个节点、4 条可见边；图片导入为独立图片资产节点，并保留到图片修改节点的真实连线。 |

本轮未调用外部图片供应商，也没有读取或记录任何 API Key；因此没有把供应商余额、网络可用性或单一模型行为误当作本地功能正确性的证据。真实供应商验收应使用操作者自己的已配置模型完成，并记录成功或原始可读错误。

## 接手步骤

```powershell
git fetch origin
git status -sb
npm run verify
npm run test:contract
npm run benchmark:canvas
npx electron-builder --dir --config.directories.output=dist\win-unpacked-check
```

桌面检查：新建测试项目，套用“图片修改→后续创作”；导入一张图片，确认原图到图片修改的边存在。配置任意图片模型和修改说明后运行，确认生成的新图片成为图片修改的 `out-image`，并可分别供裁剪、生图和首帧视频节点使用。

## 下一步建议

优先做 D1 的实际供应商验收和能力记录：分别覆盖普通图生图、带标注、带透明遮罩，以及供应商不支持遮罩时的失败信息。不要新增按模型名限制的逻辑；若未来发现某供应商的参数格式有差异，应放在主进程网关的供应商适配层，并以能力描述提示用户。
