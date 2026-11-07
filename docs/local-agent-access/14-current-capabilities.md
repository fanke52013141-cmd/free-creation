# 外部 Agent 当前能力清单

2026-11-07，按 Registry 实际25项操作整理。CLI 与 MCP stdio 共用本机正在运行的应用；源码能力不等于已发布安装包具有同样版本。外部客户端与画布内部 Agent Flow 是两个入口，内部支持不能推导成外部可调用。

| 能力 | 已开放操作 | 边界 |
| --- | --- | --- |
| 应用与能力发现 | app.status、capability.list、node.type.list | 实例身份、输入输出契约、节点类型状态；类型目录不代表节点操作已开放 |
| 项目查询 | project.list、project.get | 摘要与数量，不返回整份原始画布 |
| 新建和打开 | project.create、project.open | 新建空项目；打开前保存当前画布 |
| 修改项目名称 | project.update、project.rename | 按版本修改名称，不是任意项目字段编辑 |
| 保存和复制 | project.save、project.clone | 保存等待桌面确认；复制重映射媒体引用 |
| 删除项目 | project.delete.precheck、project.delete | 先查影响再凭确认令牌删除，拒绝当前打开或任务占用项目 |
| 导出项目 | project.export | 完整项目包，受控目录，不覆盖现有文件 |
| 查询模型 | model.list | 本地模型ID、能力验证状态，不读取密钥或联网测试 |
| 资源库 | library.search、library.create_resource | 查询摘要；本机图片文件创建单图资源，不是任意资源CRUD |
| 任务及诊断查询 | run.get、diagnostics.summary | 内部Agent任务基础状态、诊断健康计数，不含控制操作或正文 |
| Skill管理 | skill.list、skill.install | 名称作为参数；指令和文本参考，不执行脚本 |
| 对话技能 | chat.skill.list、chat.skill.bind | 查询已保存对话节点；当前打开的对话节点绑定/替换/清空技能，不发送消息 |
| 节点库 | node.library.list、node.library.save | 名称作为独立参数；保存AI对话技能预设，不带聊天记录和附件 |

目前未开放：通用画布节点创建/修改/删除/连线、节点执行、AI对话发送、从节点库自动插入画布、启动/暂停/停止Agent任务、项目包导入、资源库批量删除/导出/分类维护、Skill脚本执行、HTTP服务。

写入需要独立幂等键，涉及项目内容的操作需要预期图版本；冲突和占用必须处理。Skill两级名称与参数见[说明13](13-chat-skills-node-library.md)。安装、查询与外部协议有自动测试；本轮新增绑定的真实画布/安装包验收仍未完成。全仓检查的阻断及日志证据见同文档。
