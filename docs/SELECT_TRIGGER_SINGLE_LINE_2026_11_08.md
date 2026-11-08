# 2026-11-08 下拉框关闭态单行省略与悬浮全文

## 问题

节点模型下拉在 28px 高度里把长模型名（如 `gpt-image-2.6-sunburst-official`）换行成两排，
既撑高触发器和节点，又读不全；悬浮也没有完整文案。

根因：Radix Select 当前版本把选中值渲染成一个**没有 `data-radix-select-value` 属性**的普通
`<span>`，而 ui-foundation 里只有 `[data-radix-select-value]` 的省略规则，于是这条规则从未命中；
触发器又是 `inline-flex`，文本默认可换行。

## 排查范围

- 全仓自定义下拉只有 `components/AppSelect.tsx` 一处使用 Radix `Select.Trigger`（`aria-haspopup="listbox"`）；
  其余 `aria-haspopup` 均为 dialog，不是下拉；
- 原生 `<select>` 仅 3 处（资源表单内容类型/槽位映射、时间轴 fps），浏览器原生单选本身不会换行，
  下拉展开时也显示完整 option，无需改；
- 因此统一在 AppSelect 层处理即可覆盖所有下拉框。

## 修改

1. `AppSelect.tsx`
   - 关闭态触发器 `title` 始终提供完整文案：优先选中项完整 label，若调用方另有 title（如供应商名）
     且与 label 不同，合并为「完整 label（补充 title）」；
   - 选项 label 是 ReactNode 时回退到 `triggerLabel`。
2. `ui-foundation.css`
   - `.app-select-trigger` 增加 `overflow: hidden; white-space: nowrap;`；
   - 兜底选择 `.app-select-trigger > span:first-child`（Radix 当前 DOM）与
     `[data-radix-select-value]`（旧版本/未来版本），统一
     `flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`；
   - 嵌套 `.app-select-value` 同样单行省略；
   - 删除重复的旧 `[data-radix-select-value]` 规则。
3. 测试
   - `test/app-select.test.ts` 新增长模型名用例：title 为完整文案、触发器只渲染一行；
   - `test/ui-foundation.test.ts` 增加 CSS/组件源码断言，防止规则回退。

## 验证

- 浏览器实测 `.app-select-trigger` 高度保持 28px，第一子元素计算样式
  `white-space: nowrap / overflow: hidden / text-overflow: ellipsis`，title 为完整模型 label；
- 长选项选中（ToAPIS · gpt-image-2）title 正确；jsdom 用例 4 项通过；
- typecheck / lint / build 待随提交执行。

## 日志影响

- 纯 UI 呈现与悬浮提示调整，不涉及执行/数据路径、无 Schema 变化、不新增日志字段。

## 边界

- 原生 `<select>` 的悬浮全文仍由浏览器行为决定（当前三处选项都短，不受影响）；
- 长文案在极窄触发器里以省略号呈现，完整内容通过原生 title 悬浮查看。
