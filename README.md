<p align="center">
  <img src="web/icons/logo.svg" width="120" alt="ClawMe Logo">
</p>

<h1 align="center">ClawMe / 虾me</h1>

<p align="center">
  <b>AI Agent 与「人」之间的桥梁 — 管家角色</b><br>
  <i>The butler between AI Agents and you — executes for you, doesn't decide for you</i>
</p>

<p align="center">
  <a href="https://clawme.net">Website</a> ·
  <a href="https://clawme.net/app.html">PWA App</a> ·
  <a href="docs/instruction-protocol.md">Protocol</a> ·
  <a href="#english">English</a>
</p>

---

- **英文名**：ClawMe（Claw + Me，为你出手 / 替你执行）
- **中文名**：虾me（谐音、好记，带「爪」的联想）

与 OpenClaw、SideAI 等**项目独立**，单独成产品线。

本项目采用 [AGPL-3.0](LICENSE) 开源协议。

---

## 1. 产品定位

- **问题**：OpenClaw 等 AI Agent 能「想、决策、给指令」，但**不能**直接在你的手机、浏览器上点按、填表、发消息。
- **Telegram / Discord / WhatsApp**：只能**传消息和 URL**，不能传「可执行的操作指令」。
- **ClawMe**：用户登录、授权 token，Agent 发**结构化操作指令** → 在**主人设备**上执行（半自动：用户点「执行」或确认后执行）。

即：**人和 Agent 之间缺一个「管家」——不替你做主，但替你动手。**

---

## 2. 长期生存空间

- **Agent 会换**（OpenClaw 或未来的 A/B/C），但「需要有一层在用户设备上执行」不会变。
- **「管家」角色**会长期存在：接收指令、在手机/浏览器上执行、处理授权。
- 手机端**专门和 AI 交互、能执行指令**的 App，有持续空间；目前用 Telegram 等是**权宜之计**，不是终态。

---

## 3. 两端形态

| 端 | 能做的事 | 超越「Telegram 发消息」的地方 |
|----|----------|-------------------------------|
| **浏览器插件** | 收指令 → 填表、点按钮、抓取内容、发推、写邮件 | 一条指令一次执行；可结合当前页面上下文；token 授权 |
| **手机 PWA** | 收指令 → 提醒、打开链接、和 Agent 对话、快捷操作 | 半自动执行；添加到主屏幕即 App；扫码连接 |

Telegram：只能传 URL/文字，剩下全手动。
ClawMe：传的是**可执行指令**，在设备上真实执行。

---

## 4. 支持的指令（v0.2.0）

| 指令 | 说明 | 平台 |
|------|------|------|
| `remind` | 提醒（标题 + 正文） | 浏览器 / 手机 |
| `open_url` | 打开链接 | 浏览器 / 手机 |
| `compose_tweet` | 打开 Twitter 发推页 | 浏览器 / 手机 |
| `compose_email` | 打开 Gmail / mailto 写邮件 | 浏览器 / 手机 |
| `fill_form` | 自动填写表单字段（CSS 选择器 → 值） | 浏览器 |
| `click` | 点击页面元素（CSS 选择器） | 浏览器 |
| `extract` | 抓取页面内容（文本或属性） | 浏览器 |

---

## 5. 技术架构

```
┌─────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│  AI Agent   │──────→│  ClawMe Backend     │←──────│  Chrome 插件     │
│  (OpenClaw) │ POST  │  (VPS / 本地)       │ poll  │  手机 PWA        │
│             │       │                     │←──────│  (clawme.net)    │
└─────────────┘       └─────────────────────┘  chat └──────────────────┘
```

- **通道**：Agent → Backend → 客户端（浏览器插件 / PWA）；token 校验
- **指令格式**：结构化 JSON，便于扩展
- **授权**：半自动 — 用户可「一键执行」或「确认后再执行」
- **安全**：指令仅经用户授权通道下发；执行仅在用户设备上完成

---

## 6. 仓库结构

| 目录 | 说明 |
|------|------|
| [backend/](backend/) | Node.js 后端：接收指令、轮询下发、结果上报、回传 OpenClaw |
| [extension/](extension/) | Chrome 浏览器插件（v0.2.0）：侧边栏、自动轮询、7 种指令、Workflow |
| [web/](web/) | clawme.net 官网 + PWA 手机 App（双语、对话、扫码连接） |
| [openclaw-clawme/](openclaw-clawme/) | OpenClaw 插件：注册 `clawme_send` Tool |
| [deploy/](deploy/) | VPS 部署脚本（Nginx + SSL + PM2） |
| [docs/](docs/) | 指令协议、架构、指南 |

---

## 7. 快速开始

### 启动后端

```bash
cd backend && npm install && npm run build && npm start
```

### 加载浏览器插件

1. `chrome://extensions` → 开启开发者模式
2. 「加载已解压的扩展程序」→ 选择 `extension/` 目录
3. 点图标 → 侧边栏打开 → 填 URL + Token → 保存

### 发送测试指令

```bash
curl -X POST http://127.0.0.1:31871/v1/instructions \
  -H "Content-Type: application/json" -H "X-ClawMe-Token: test" \
  -d '{"target":"browser","instruction":{"type":"remind","payload":{"title":"测试","body":"ClawMe 工作了！"}}}'
```

### 部署到生产环境

```bash
# 网站部署到 Vercel（导入 GitHub 仓库，Root Directory = web）
# 后端部署到 VPS：
ssh root@your-server 'bash -s' < deploy/setup.sh
```

### 连接 OpenClaw

安装 [OpenClaw 插件](openclaw-clawme/)，配置 `baseUrl` 和 `clientToken`。详见 [docs/openclaw-setup.md](docs/openclaw-setup.md)。

---

## 8. 文档导航

- **指令协议**：[docs/instruction-protocol.md](docs/instruction-protocol.md) — 完整指令格式与 payload
- **系统架构**：[docs/architecture.md](docs/architecture.md) — 数据流、端与通道设计
- **浏览器工具**：[docs/browser-tool-guide.md](docs/browser-tool-guide.md) — 使用场景与示例
- **OpenClaw 接入**：[docs/openclaw-setup.md](docs/openclaw-setup.md) — 安装、配置、排查
- **路线图**：[docs/roadmap.md](docs/roadmap.md) — 浏览器/手机优先级与未来规划
- **命名**：[docs/naming-rationale.md](docs/naming-rationale.md) — ClawMe / 虾me 品牌考量

---

<a name="english"></a>

## English

### What is ClawMe?

AI Agents can think and decide, but **can't** directly tap buttons, fill forms, or send messages on your devices. ClawMe bridges that gap.

**Agent sends structured instructions → ClawMe delivers to your browser/phone → You confirm and execute (or auto-execute).**

A butler, not a boss. Not replacing you, but executing for you.

### Key Features (v0.2.0)

- **7 instruction types**: remind, open_url, compose_tweet, compose_email, fill_form, click, extract
- **Chrome extension**: Side panel with auto-polling, desktop notifications, badge count
- **Mobile PWA**: Add to home screen, scan QR to connect, chat with your Agent
- **Multi-step Workflows**: Chain instructions with progress visualization and abort
- **Semi-automatic**: You confirm before executing, or enable auto-execute
- **Agent-agnostic**: Works with OpenClaw or any HTTP-capable AI agent
- **Dark mode**: Follows system preference
- **Open source**: AGPL-3.0

### Quick Start

```bash
# 1. Start backend
cd backend && npm install && npm run build && npm start

# 2. Load Chrome extension from extension/ directory

# 3. Test
curl -X POST http://127.0.0.1:31871/v1/instructions \
  -H "Content-Type: application/json" -H "X-ClawMe-Token: test" \
  -d '{"target":"browser","instruction":{"type":"remind","payload":{"title":"Hello","body":"ClawMe works!"}}}'
```

### API for Agents

```
POST /v1/instructions
Header: X-ClawMe-Token: <token>

{
  "target": "browser",
  "instruction": {
    "type": "compose_tweet",
    "payload": { "text": "Hello from my AI agent!" }
  }
}
```

Full protocol: [docs/instruction-protocol.md](docs/instruction-protocol.md)

### Deploy

- **Website**: Import to [Vercel](https://vercel.com), root directory = `web/`
- **Backend**: `ssh root@server 'bash -s' < deploy/setup.sh`
- **Connect OpenClaw**: Install [plugin](openclaw-clawme/), set `baseUrl` and `clientToken`

### License

[AGPL-3.0](LICENSE) — Free for everyone. If you run a modified version as a service, you must open-source your changes.
