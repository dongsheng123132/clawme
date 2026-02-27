# ClawMe 产品路线图

## 阶段一：协议与 iOS 核心（MVP）

**目标**：跑通「Agent 发指令 → iOS 原生执行」，验证协议与授权。

- **定稿指令协议**：见 `instruction-protocol.md`。
- **iOS 原生 App (Swift)**：
  - **核心能力**：集成 OpenClaw Agent，支持 WebSocket/Push 接收指令。
  - **Shortcuts 集成**：通过 App Intents 暴露核心能力给快捷指令。
  - **基础 UI**：SwiftUI 仪表盘。
- **通道**：自建最小后端（或 Serverless） + APNs（苹果推送）。
- **产出**：可安装的 TestFlight 包，支持 `open_url` 和 `trigger_shortcut` 指令。

## 阶段二：语音与高级体验

- **语音唤醒 (Siri)**：支持 "Hey Siri, Ask ClawMe to..." 交互。
- **浏览器端**：补齐浏览器插件，形成「手机 + 浏览器」双端闭环。
- **执行结果回传**：指令执行结果（成功/失败/返回值）实时回传 Agent。
- **Widget**: 桌面小组件展示系统状态。

## 阶段三：开放与扩展

- **多 Agent 绑定**：同一用户可选多个 Agent。
- **指令模板与条件触发**。
- **文档与示例**：面向 OpenClaw / 自建 Agent 的接入指南。

---

## 优先级建议

| 优先级 | 内容 | 说明 |
|--------|------|------|
| P0 | iOS 原生 App 框架 | Swift + SwiftUI 搭建 |
| P0 | 指令协议 + APNs | 解决后台唤醒问题 |
| P1 | Siri Intents | 实现语音控制 |
| P1 | 浏览器插件 | 桌面端覆盖 |

---

## 依赖与风险

- **iOS 限制**：后台保活难，需重度依赖 **APNs (Push Notifications)** 和 **Shortcuts**。
- **Voice Wake**：纯后台监听不可行，必须走 **Siri Integration** 或 **Foreground Mode**。
- **审核**：App Store 对“远程执行代码”敏感，需确保指令集在本地解析，不直接 `eval`。
