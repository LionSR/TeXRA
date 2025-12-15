---
layout: page
title: TeXRA：为学术写作设计的 AI 工具平台
description: TeXRA 是一个运行在 VS Code 中的 AI 工具平台，专门为学术 LaTeX 写作设计，整合多个大模型并提供专业的 Workflow Agent 系统
date: 2024-12-14
---

# TeXRA：为学术写作设计的 AI 工具平台

## 当前工具的局限

AI 工具越来越多，学术写作却没有变得明显更轻松。

Claude 擅长润色英文，GPT/DeepSeek 推理能力强，Gemini 能处理超长文档。每个模型都有长处，但它们分散在不同的平台上。写一篇论文的过程中，你可能需要在多个网页之间切换，反复粘贴同一段文字，手动整合不同工具的输出。这种碎片化的工作方式消耗了大量时间。

更根本的问题是，这些通用工具并非为学术场景设计。它们不理解 LaTeX 的语法结构，不知道交叉引用需要保持一致，生成的 BibTeX 条目经常有格式错误。当你请求修改一段文字时，它们会返回一个"改进版本"，但不会告诉你具体修改了哪些地方。你无法确认它是优化了表达，还是无意中改变了原意。

数学推导的问题更为严重。当你请求验证一个证明时，它可能会说"推导正确"，但你不知道这是不是只是基于文本模式的模式匹配，还是真正的数学验证。同样，当你请求查找参考文献时，它可能会生成看似合理但实际上并不存在的论文信息。这类错误在日常对话中可以容忍，在学术写作中则可能导致严重后果。

## TeXRA 的设计理念

TeXRA 试图解决这些问题。它是一个运行在 VS Code 中的工具平台，将多个大模型整合到统一的界面中，并针对学术写作的具体需求设计了专门的功能模块。

在模型层面，TeXRA 支持主流的 AI 服务：Anthropic Claude、OpenAI GPT 系列及其推理模型、Google Gemini、DeepSeek、Moonshot、通义千问，以及通过 OpenRouter 接入的各类开源模型。用户使用自己的 API 密钥，数据直接发送到对应的服务商，不经过中间服务器。对于国内用户，DeepSeek 是一个值得考虑的选择：价格较低，无需特殊网络配置，V3.2 模型在各自的任务上都有不错的表现。

在功能层面，TeXRA 提供两类工具。第一类是 Workflow Agent，用于处理结构化的批量任务。校对 Agent 专注于发现和修复错误，包括拼写、语法、LaTeX 语法、交叉引用一致性等，设计原则是只纠正明确的错误，不改变作者的写作风格。润色 Agent 采用多轮处理机制：首先分析文本并制定修改方案，然后执行修改，最后检查是否引入了新的问题。此外还有生成 TikZ 图表的绘图 Agent，将论文转换为 Beamer 演示文稿的转换 Agent，以及处理手写公式图片和音频转录的输入 Agent。

第二类是 Tool-Use Agent，支持交互式的多轮对话，并能调用外部工具完成复杂任务。Research Agent 集成了调用本地 Wolfram Language 的工具，可以执行符号运算、求解方程、进行数值验证。Chat Agent 可以审阅草稿并提供具体的修改建议，也可以搜索 arXiv 和 Crossref 数据库查找文献，返回的每一条引用都包含可验证的 DOI 和完整的 BibTeX 信息。Search Agent 则专门用于文献检索，支持学术数据库和网页搜索。

## 设计原则

设计 TeXRA 时，有坚持几个原则。

**修改必须透明。** 每次 AI 对文档的修改都会生成精确的差异对比，通过集成的 latexdiff 工具，用户可以看到每一处增删改动，包括数学公式中单个符号的变化。所有修改都需要用户确认后才会生效。

**过程必须可追溯。** 每次运行都会记录使用的模型、消耗的 token 数量、完整的输入输出内容。用户可以查看 AI 在每一步是如何推理的。

**数据必须安全。** TeXRA 作为本地插件运行，论文内容只会发送到用户自己配置的 API 服务商，我们不收集、不存储任何用户的输入数据。

## Overleaf 集成

对于使用 Overleaf 的用户，TeXRA 提供了便捷的集成方案：通过 Git 将项目克隆到本地，使用 TeXRA 进行处理，然后推送回 Overleaf。插件内置了专门的克隆命令，只需输入项目地址和访问令牌即可完成配置。

## 开始使用

TeXRA 目前需要本地安装 TeX Live 或 MiKTeX 环境。

- **GitHub**: [github.com/texra-ai/texra](https://github.com/texra-ai/texra)
- **VS Code Marketplace**: [marketplace.visualstudio.com/items?itemName=texra-ai.texra](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)
- **文档**: [texra.dev](https://texra.dev)

学术研究本身已经足够困难，我们希望工具能够真正提供帮助，而不是制造新的障碍。
