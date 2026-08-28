# 节点合规矩阵

本表以注册表和自动测试为准。新增节点必须先补充本表，再进入创建菜单。

| 节点        | 创建 | 契约 / Schema                  | Executor | 输出投影 | 配置字段         |
| ----------- | ---- | ------------------------------ | -------- | -------- | ---------------- |
| 文本        | 是   | text                           | 是       | 是       | text             |
| 图片资产    | 是   | image                          | 是       | 是       | media props      |
| 生图        | 是   | text + image                   | 是       | 是       | config           |
| 视频        | 是   | text + image                   | 是       | 是       | config           |
| 音频        | 是   | text + audio                   | 是       | 是       | config           |
| 对话        | 是   | text → markdown                | 是       | 是       | text（对话内容） |
| 处理        | 是   | any                            | 是       | 是       | config           |
| JSON        | 是   | json.any                       | 是       | 是       | text             |
| 结构数据    | 是   | 动态 Schema + json.any 上下文  | 是       | 是       | config + text    |
| 代码        | 是   | 动态端口 + json.any            | 是       | 是       | config           |
| 分镜板      | 是   | storyboard.shots               | 是       | 是       | text             |
| AI 处理     | 是   | text/json → text/markdown/json | 是       | 是       | config           |
| 循环        | 是   | list.items                     | 是       | 是       | config           |
| 导演台      | 是   | previs / storyboard            | 是       | 是       | config           |
| 脚本        | 否   | 已退役，不进入新建流程         | 是       | 是       | legacy           |
| 分组 / 合成 | 否   | 已退役，不注册                 | 不适用   | 不适用   | legacy           |

自动门禁：`npm run test:contract`、`test/node-compliance.test.ts`、契约快照和连线矩阵。
