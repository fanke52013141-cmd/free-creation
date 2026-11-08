# 2026-11-08 引用候选菜单单行呈现

## 问题

视频/图片节点的提示词里输入 `@` 选择参考素材时，候选条目把上游节点的长标题折成两排
（截图里缩略图 + 两行文字 + `@图1`），节点高度被撑大，也很难读。

## 修改

- `.ref-mention-menu` 由横向换行芯片改为纵向列表：`flex-direction: column`、
  最多 132px 高、内部滚动（滚动条隐藏），不再把菜单撑满节点宽度；
- 每个候选按钮固定一行：
  - `width: 100%; min-width: 0; white-space: nowrap; overflow: hidden`；
  - 标题 `flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`；
  - `@图N` token 固定右侧（`margin-left: auto`），不换行；
- 候选按钮补 `title`（完整标题/名称），长标题省略后鼠标悬浮可看全文；
- 新增 `test/mention-menu-layout.test.ts` 源码断言，防止回退成多行。

## 验证

- 浏览器实机重现：连接带长标题的图片节点 → 视频节点输入 `@`，
  候选按钮高度 24px、一行、`text-overflow: ellipsis`、`title` 为完整标题；
- 单测 3 文件 15 项通过；typecheck/lint 通过。

## 日志影响

- 纯 UI 布局与悬浮提示，不涉及执行/数据路径、不新增日志字段。

## 边界

- 菜单最多显示 132px 高，候选多时内部滚动（滚动条按全局规范隐藏）；
- 提示词正文本身仍是多行文本域，这里只约束「引用候选」的呈现。
