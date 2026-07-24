# ClawMe 产品路线图

> 本文件是快速索引。v0.3 的产品、架构、安全、数据模型和完整实施方案以
> [《ClawMe｜AI 值班台 v0.3 产品与技术方案》](clawme-ai-duty-desk-v0.3.md) 为唯一真相源。

## 当前定位

ClawMe 不再以“手机执行 Agent 指令”或“加强版通知工具”为核心，而是：

> **跨模型、跨 Agent、以手机为主要交互端的 AI 远程值班台。**

首版解决：

1. 任务完成通知；
2. 等待输入；
3. 手机允许一次/拒绝；
4. 执行失败；
5. 模型限速和额度不足；
6. 选择等待、换模型或暂停；
7. 给原任务补充指令并继续。

## 实施顺序

| 阶段 | 目标 |
|---|---|
| 0 | 统一 Task/Event/Decision 协议与设备安全 |
| 1 | Windows ClawMe Agent、SQLite、可靠事件 |
| 2 | Codex 原生任务与手机授权闭环 |
| 3 | Claude Code、OpenClaw、Hermes Adapter |
| 4 | UURouter 模型异常识别与检查点恢复 |
| 5 | U-Claw 安装、PWA 发布、线上灰度 |

## 当前非目标

- 自研远程桌面和视频流；
- 原生 iOS/Android App；
- 完整 Web IDE、Git 和手机文件编辑器；
- 企业团队协作；
- 自动批准高风险操作。

旧 iOS/Shortcuts 路线保留为未来设备执行能力，但不再作为 MVP 的第一优先级。
