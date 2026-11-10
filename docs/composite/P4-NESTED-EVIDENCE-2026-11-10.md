# 嵌套组合执行证据（2026-11-10）

基线：`5e21589`（开发 bypass 修复）
场景：外层组合内部只含一个 `composite` 节点；内层组合用固定媒体节点产出图片。

## 构造

- 内层 manifest：单节点 `image`（mediaRefs = qa 固定 PNG），公开输出 `out-image`。
- 外层 manifest：内部节点 `nodeType:'composite'`，`config` 存内层 manifest 快照；
  外层公开输出取该节点 `out-image`。
- 外层作为画布 composite 实例运行（`runNodeManually`）。

## 结果（浏览器确定性）

```json
{"runResult":{"status":"done"},"pages":1,"nodeResult":true}
```

- 外层运行成功；
- 外层组合节点 `meta.nodeResult` 含 `nested-media`（来自内层公开输出）；
- 用户页面数始终为 1（内层/外层均使用独立 store，不切页）。

## 结论

- 组合内部可以再次包含 composite 节点并完成执行，公开输出可向上投影；
- 每个嵌套层使用独立 store，页面不切换；
- 尚未验证：嵌套依赖锁定、深度/展开预算拒绝、版本升级、旧模板转换、跨项目导入导出。
  本证据只说明“两层执行可用”，不代表 P4 完整验收。
