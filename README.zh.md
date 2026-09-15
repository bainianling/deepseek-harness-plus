# DeepSeek Harness Plus（二改增强版）

中文说明已完整收录在 [README.md](README.md)（中文优先，文末附 English summary）。

要点速览：

- **来源**：本仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的个人二次修改版，
  初始基线提交 `cd5ef8148158c3a752a658978873241fdf8e2bbc`（release `0.1.2-alpha.1`），当前同步至 `dsh-v0.1.5-rc.2` 并包含最新本地改动，沿用 MIT License（Copyright (c) 2026 DeepSeek）。
- **修改内容**：在 Web GUI 上新增 AI 实时新闻、技能市场、知识库、模型测试台、LoRA 训练工作室、虚拟软件公司、声线克隆等
  应用级分区，以及内置浏览器面板、内置终端、自动化任务、壁纸、停止服务、局域网共享、会话内切换 preset、跨工作区移动对话、
  会话导入/删除、破甲红队模式等增强。完整清单见 [MODIFICATIONS.md](MODIFICATIONS.md)。
- **免责声明**：本项目与 DeepSeek 无隶属或背书关系，按「现状」提供、不含任何保证。详见 [DISCLAIMER.md](DISCLAIMER.md)。

```sh
pnpm install
pnpm run build
pnpm dsh web        # http://127.0.0.1:3080
```
