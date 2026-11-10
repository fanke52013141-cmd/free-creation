# 本机自用版：为什么要授权，怎么永久免授权

日期：2026-11-10
适用：**自己电脑自用**；对外分发请用发行版 `npm run build:distribution`。

---

## 一、为什么桌面项目还要授权

授权不是桌面功能本身的要求，而是**分发包的授权/发码层**（设备绑定 + 信任根 + 密钥包）：

- 用于把客户端发给别人时控制「哪台设备能用、能用到什么时候、能不能导入 API Key」；
- 代码里 `DISTRIBUTION_EDITION` / 普通构建会走 `bootLicenseGate()`，未激活只显示授权窗；
- 你安装的 `canvas-studio-1.0.0-setup.exe` 是**普通构建**，所以被授权门禁拦住；
- 自用且源码在手时，这层完全没有必要。

另外，反复被要求授权通常还有一个原因：**信任根被换过**（另一台机器重新 `init-root`
并提交了新的 `trusted-root.generated.ts`）。打包版不读取本机开发根覆盖，旧授权
对新根失效，就会再次弹授权。详见 `docs/security/03-dev-license-operations.md`。

## 二、三种选择

| 方案 | 授权 | 节点功能 | 适用 |
| --- | --- | --- | --- |
| 普通构建（当前安装包） | 需要激活 | 全部节点 | 开发/内部测试 |
| 发行版 `build:distribution` | **免授权** | 精简节点（隐藏数据/Agent 等分类） | 对外分发客户 |
| **自用版 `build:personal`（推荐）** | **免授权** | **全部节点** | 自己电脑 |

## 三、构建自用版

```powershell
cd source
npm run build:personal
```

脚本会：

1. 设置 `CANVAS_OWNER=1`，由 `electron.vite.config.ts` 注入 `__CANVAS_OWNER__=true`；
2. 执行 `npm run build`（typecheck + 三端产物）；
3. 输出 NSIS 安装包到 `dist/personal/canvas-studio-setup-*.exe`，同时保留
   `dist/personal/win-unpacked/` 可直接运行验证。

实现点：

- `src/shared/edition.ts` 新增 `OWNER_EDITION` 与 `LICENSE_GATE_DISABLED`；
- `src/main/index.ts` 在 `LICENSE_GATE_DISABLED` 时跳过 `bootLicenseGate()`，
  不注入设备绑定密钥库（API Key 走系统安全存储 DPAPI，导入即用）；
- `OWNER_EDITION` 不参与调色板/节点裁剪（`DISTRIBUTION_EDITION` 才裁剪），因此全功能；
- 自用版会像发行版一样预置「即梦（本机 CLI）」供应商，登录即可用。

## 四、安装与迁移

- 直接运行 `dist/personal/canvas-studio-setup-*.exe` 覆盖安装即可；用户数据目录不变，
  已有项目、供应商、模型配置都还在。
- 安装后启动**不应再出现授权窗**，日志里也不会有 `license: 未激活…进入授权窗`；
  应直接进入「无限画布创作平台」。
- 如果之前授权窗卡住，装自用版后不需要再导出申请/导入授权。

## 五、安全与边界

- 自用版**跳过授权门禁**，不要把它发给别人；对外仍用 `build:distribution`。
- 自用版没有设备绑定密钥库（与发行版相同）：API Key 由系统安全存储保护，
  不再有 `.cskeys` 设备专属密钥包的发放能力（相关按钮会隐藏）。
- 该构建不改变项目数据、API Key 存储格式或业务逻辑，可随时换回普通构建/发行版。
- 自用版与发行版共用同一应用 ID 和用户数据目录，安装会覆盖当前客户端。
