# ClawMe 浏览器插件 v0.2.0

接收 ClawMe 后端的指令，在侧边栏中展示，点击「执行」后在浏览器里替你完成操作，并上报结果。支持自动轮询、桌面通知、多步骤 Workflow 和暗色模式。

## 支持的指令

| 类型 | 说明 |
|------|------|
| `remind` | 提醒 |
| `open_url` | 打开链接（新标签页或当前页） |
| `compose_tweet` | 打开 Twitter 发推页 |
| `compose_email` | 打开 Gmail / mailto 写邮件 |
| `fill_form` | 自动填写表单字段 |
| `click` | 点击页面元素（CSS 选择器） |
| `extract` | 抓取页面内容（文本或属性） |

## 架构

```
extension/
  manifest.json
  background/
    service-worker.js      # alarm 轮询 + 通知 + 消息路由
    poller.js              # 轮询逻辑、badge 更新
    notifications.js       # 桌面通知
  sidepanel/
    sidepanel.html/css/js  # 侧边栏 UI（设置、指令列表、执行日志）
  lib/
    api.js                 # 后端 API 调用
    executor.js            # 指令分发器
    workflow.js            # 多步骤 WorkflowRunner
    constants.js           # 默认值、标签、颜色
    utils.js               # waitForTabLoad 等工具
    instructions/          # 每种指令独立处理器
```

## 安装

1. 打开 Chrome → `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择 `extension` 目录

## 配置

点击插件图标打开侧边栏，在「设置」区填写：

- **Backend URL**：默认 `http://127.0.0.1:31871`
- **Token**：后端分配的客户端令牌
- **自动轮询**：开启后每 30 秒自动拉取新指令
- **自动执行**：开启后收到指令自动执行（跳过手动确认）

## 功能特性

### 侧边栏 UI
点击插件图标打开常驻侧边栏，无需反复点击弹窗。三段式布局：设置区（可折叠）、指令列表、执行日志。

### 自动轮询 & 通知
后台 Service Worker 通过 `chrome.alarms` 定时轮询。新指令到达时弹桌面通知，图标 badge 显示待执行数量。

### 多步骤 Workflow
Agent 发送指令时带上 `meta.workflow_id` 和 `meta.step`，插件自动分组显示并按顺序执行。某步失败则中止后续步骤。

### 暗色模式
跟随系统 `prefers-color-scheme` 自动切换。

## 协议

- 轮询：`GET /v1/instructions/pending?target=browser`，Header `X-ClawMe-Token`
- 上报：`POST /v1/instructions/:id/result`，Body `{ instruction_id, status, result }`

详见 [`docs/instruction-protocol.md`](../docs/instruction-protocol.md)。
