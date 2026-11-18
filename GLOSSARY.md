# Open Science 接入适配

本项目为外部宿主提供使用 Open Science 的入口。Open Science SDK 的功能补齐由独立工作线负责。

## 术语

**外部宿主**

用户提出操作请求的应用，例如 Codex、Claude Code 或 WorkBuddy。

**Open Science 智能体**

Open Science 内部接受并执行科研任务的智能体。

**目标实例**

外部宿主此次操作的 Open Science 环境，例如正常安装版或隔离开发版。它使用自己的配置与数据。

**宿主适配**

让一种外部宿主发现并使用 Open Science 能力的接入包。

**任务回执**

标识一次 Open Science 任务提交的本地记录。它包含目标实例、请求 ID、已知的 Run ID 和时间，用于从另一个聊天或外部宿主找回任务。
