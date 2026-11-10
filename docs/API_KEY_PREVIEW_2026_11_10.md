# 2026-11-10 供应商 API Key 脱敏预览

## 需求

设置面板里 API Key 保存后输入框为空，只在 placeholder 写“已保存；留空则保持不变”，
用户无法确认保存的是哪一把 key。希望显示「首 5 位 + 后 5 位」，中间隐藏。

## 实现

- 新增 `src/shared/security/api-key-preview.ts`：
  - 长度 > 10：`前5位…后5位`，例如 `sk-ab…vwxyz`；
  - 长度 ≤ 10：降级为 `前2位…后2位`（若按 5+5 就等于完整泄露）；
  - 空值返回 `undefined`，忽略首尾空白。
- `ProviderSummary` 新增可选 `apiKeyPreview`（仅用于展示，注释明确禁止用于请求/日志/导出）。
- main `providers.repo`：
  - 目录连接（vault）在 `listProviders` / `listVerifiedProviders` / `saveProvider` 的异步路径里
    解出明文后立即脱敏，只把预览送渲染层；
  - 旧明文行在 `toSummary` 同步路径能解密时也补预览；vault 指针同步解不开则不显示预览。
- 设置面板：输入框仍为空（不放回填真实 key），下方新增一行「已保存：`sk-de…m0ckY`
  （首尾各 5 位，中间已隐藏；留空保持不变）」；`input[type=password]` 的 value 保持空。
- 浏览器 mock 同步补 `apiKeyPreview`，便于 UI 验收。

## 安全边界

- 预览只是**首尾各 5 个字符**，中间不可还原；真实 key 仍只存在主进程/设备 vault；
- 输入框 value 不写入预览，保存时不会把 `…` 当成新 key；
- 预览不进入日志、诊断、导出文件或供应商配置文件；
- 短 key 不做 5+5，避免预览等于完整密钥。

## 验证

- `test/api-key-preview.test.ts`：长 key、11 位、短 key、空值/空白；
- 浏览器端到端：打开模型供应商 → 选 ToAPIS → 显示
  `已保存：sk-de…m0ckY（首尾各 5 位，中间已隐藏；留空保持不变）`，密码输入框 value 为空；
- typecheck（node/web）、lint、生产构建通过。

## 日志影响

纯 UI 展示与只读摘要字段，不新增执行/请求/文件/数据库路径；不涉及日志事件变更。
预览值本身不得写入日志（已注明仅展示用）。
