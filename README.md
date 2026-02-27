# ClawMe / 虾me

**AI Agent 与「人」之间的桥梁：宰相（即管家/执行者）/ 管家角色。**

- **英文名**：ClawMe（Claw + Me，为你出手 / 替你执行）
- **中文名**：虾me（谐音、好记，带「爪」的联想）

与 OpenClaw、SideAI 等**项目独立**，单独成产品线。

本项目采用 [MIT](LICENSE) 开源协议。

---

## 1. 产品定位

- **问题**：OpenClaw 等 AI Agent 能「想、决策、给指令」，但**不能**直接在你的手机、浏览器上点按、填表、发消息。
- **Telegram / Discord / WhatsApp**：只能**传消息和 URL**，不能传「可执行的操作指令」。
- **ClawMe**：用户登录、授权 token，Agent 发**结构化操作指令** → 在**主人设备**上执行（半自动：用户点「执行」或确认后执行）。

即：**人和 Agent 之间缺一个「管家」——不替你做主，但替你动手。**

---

## 2. 长期生存空间

- **Agent 会换**（OpenClaw 或未来的 A/B/C），但「需要有一层在用户设备上执行」不会变。
- **「宰相/管家」角色**会长期存在：接收指令、在手机/浏览器上执行、处理授权。
- 手机端**专门和 AI 交互、能执行指令**的 App，有持续空间；目前用 Telegram 等是**权宜之计**，不是终态。

---

## 3. 两端形态（与 Telegram 的差异）

| 端 | 能做的事 | 超越「Telegram 发消息」的地方 |
|----|----------|-------------------------------|
| **浏览器插件** | 收指令 → 在当前页/指定页**填表、点按钮、抓取内容**（例：`fill_form`、`click`） | 一条指令一次执行，无需复制粘贴；可结合当前页面上下文；token 授权，只认你的 Agent |
| **手机 App** | 收指令 → **打开微信/短信、运行快捷方式、提醒+建议动作**（例：`run_shortcut`、`send_sms`） | 半自动执行（点一下即发短信/打开某聊天）；与苹果快捷方式联动；提醒 + 指令一体化 |

Telegram：只能传 URL/文字，剩下全手动。  
ClawMe：传的是**可执行指令**，在设备上真实执行。

---

## 4. 技术要点（概要）

- **通道**：Agent → 自建/第三方推送或后端 → ClawMe 客户端（浏览器插件 / 手机 App）；用 **token** 校验「只接受该主人的 Agent」。
- **指令格式**：结构化（如 `navigate` / `fill_form` / `click` / `run_shortcut` / `send_sms` 等），便于扩展。
- **授权**：半自动——用户可「一键执行」或「确认后再执行」，避免完全无人值守带来的安全与平台限制。
- **安全与隐私**：指令仅经用户授权通道下发，不在第三方持久化；执行仅在用户设备上完成，强化「管家」可信度。

---

## 5. 与 SideAI（项目名 side-ai）的关系

- **SideAI（side-ai）**：浏览器侧边栏，侧重标签管理、会话洞察、与 AI 的浏览场景。
- **ClawMe**：独立产品，侧重「接收任意 Agent（如 OpenClaw）的指令 → 在多端执行」，与 side-ai 无代码耦合；可共用账号体系或完全独立。

---

## 6. 读者导航

- **本文**：产品愿景、定位、长期空间。
- **协议与端设计**：[docs/architecture.md](docs/architecture.md) — 指令协议、端与通道设计。
- **排期与 MVP**：[docs/roadmap.md](docs/roadmap.md) — 浏览器先行 vs 手机先行、MVP 范围。
- **OpenClaw 接入**：[docs/openclaw-setup.md](docs/openclaw-setup.md) — 安装插件、配置、回传与排查。
- **浏览器工具说明**：[docs/browser-tool-guide.md](docs/browser-tool-guide.md) — 是什么、OpenClaw 里做啥、浏览器里做啥；发推、写邮件、填表单。

文档维护顺序：先完善 architecture（指令协议与端设计），再更新 roadmap（浏览器/手机优先级与 MVP）。

---

## 7. 仓库与快速开始

| 目录 | 说明 |
|------|------|
| [backend/](backend/) | ClawMe 最小后端：接收指令、轮询下发、结果上报、可选回传 OpenClaw |
| [extension/](extension/) | 浏览器插件（Chrome）：remind、open_url，轮询执行并上报 |
| [openclaw-clawme/](openclaw-clawme/) | OpenClaw 插件：注册 `clawme_send` Tool，Agent 可向 ClawMe 发指令 |

**快速跑通**：启动 [backend](backend/README.md) → 加载 [extension](extension/README.md) → 配置并安装 [OpenClaw 插件](docs/openclaw-setup.md)；详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

*此文件夹仅用于 ClawMe/虾me 产品规划与文档，与 side-ai 项目分开维护。*

命名与品牌考量见 [docs/naming-rationale.md](docs/naming-rationale.md)。
