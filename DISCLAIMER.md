# 免责声明（DISCLAIMER）

## 中文

1. **非官方项目**。本仓库是个人对 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
   的二次修改版（modified fork），仅供学习与交流。本项目与 DeepSeek（杭州深度求索人工智能基础技术研究有限公司及其关联方）
   **无任何隶属、合作或背书关系**。「DeepSeek」及相关标识的版权归原权利人所有。

2. **按「现状」提供**。本项目沿用原版的 MIT License 发布：软件按「AS IS」提供，不含任何明示或暗示的保证
   （包括但不限于适销性、特定用途适用性与不侵权）。在任何情况下，作者或版权持有人不对因使用本软件引起的
   任何索赔、损害或其他责任承担责任。详见 [LICENSE](LICENSE)。

3. **快速迭代的上游**。上游项目处于 developer preview 阶段，存在兼容性破坏性变更；本二改版基于
   `0.1.2-alpha.1` 基线、当前同步至 `dsh-v0.1.5-rc.2`，可能滞后于上游修复，也可能引入自身缺陷。生产环境使用前请自行充分评估与测试。

4. **实验性功能责任自负**。本仓库包含实验性增强（如「破甲 / jailbreak」红队模式、多智能体编排、自动化调度、
   内置终端等）。其中涉及模型安全测试的功能**仅限在获得明确授权的红队安全评估场景使用**；使用者须确保其行为
   符合所在司法辖区的法律法规、相关平台的服务条款以及模型提供方的使用政策。因使用上述功能产生的一切后果由使用者自行承担。

5. **第三方平台与服务**。AI 实时新闻等功能会访问 B 站、抖音、小红书、X（Twitter）等第三方平台公开页面及若干公开
   RSS 源，仅供个人学习研究；请遵守各平台的服务条款与 robots 约定，控制访问频率，勿用于任何商业或侵权用途。
   LoRA 训练、声线克隆（IndexTTS）、知识库（Hindsight）等分区依赖**使用者自行部署的本机服务**，这些服务不在本仓库内，
   其来源、许可与安全性由使用者自行甄别。

6. **网络与数据安全**。dsh web 默认仅监听本机回环地址；若你启用局域网共享或修改绑定与信任配置，请自行评估暴露面，
   并采取必要的认证与防火墙措施。请妥善保管你自己的 API 密钥与凭据：**不要将任何密钥提交进仓库或分享日志**。
   本仓库在发布前已做敏感信息扫描，不含任何 API key、令牌或凭据；上游测试代码中的 `sk-...` 等字样均为测试占位假值。

7. **内容风险**。使用本项目生成的任何内容（文本、语音、图像、训练权重等）由使用者自行负责，须遵守相关法律法规，
   不得用于生成违法、侵权或欺诈内容；使用 AI 合成语音/形象时须遵守相应的肖像权、声音权益与标识义务。

## English

1. **Unofficial.** This is a personal modified fork of
   [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), published for learning and
   exchange purposes. It has **no affiliation with, partnership with, or endorsement by DeepSeek**.
   "DeepSeek" and related marks belong to their respective owners.

2. **Provided "as is".** Distributed under the same MIT License as upstream: the software is provided without
   warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any
   claim, damages, or other liability arising from the use of the software. See [LICENSE](LICENSE).

3. **Fast-moving upstream.** The upstream project is in developer preview with breaking changes; this fork is based
   the `0.1.2-alpha.1` baseline, currently synchronized through `dsh-v0.1.5-rc.2`, and may lag behind upstream fixes or carry its own defects. Evaluate and test
   thoroughly before any production use.

4. **Experimental features at your own risk.** This fork includes experimental enhancements (e.g., the jailbreak
   red-team mode, multi-agent orchestration, automation scheduling, a built-in terminal). Security-testing features
   are intended **only for authorized red-team evaluation**; you are responsible for complying with applicable laws,
   platform terms, and model-provider policies.

5. **Third-party platforms and services.** The AI news feature accesses public pages of third-party platforms
   (Bilibili, Douyin, Xiaohongshu, X, and public RSS feeds) strictly for personal study; respect each platform's
   terms and robots directives. LoRA training, voice cloning (IndexTTS), and the knowledge center depend on
   locally self-deployed services that are **not part of this repository**; vet their provenance and licenses yourself.

6. **Network and data safety.** The web server listens on loopback by default; if you enable LAN sharing or change
   bind/trust settings, assess the exposure yourself and apply authentication/firewall controls. Safeguard your own
   API keys and **never commit credentials**. This repository was scanned for secrets before publication and contains
   none; `sk-...` strings in upstream tests are fixture placeholders.

7. **Content responsibility.** You are solely responsible for anything generated with this project and must comply
   with applicable laws; do not use it to produce unlawful, infringing, or fraudulent content.
