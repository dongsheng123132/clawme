# 参与贡献 ClawMe

欢迎参与 ClawMe（OpenClaw 的「手」：在用户设备上执行指令）。以下说明如何跑起项目、扩展协议与端。

## 提交前：签署 CLA

提交 PR 前请读一遍 [CLA.md](CLA.md)，并用 `git commit -s` 提交（会自动加一行
`Signed-off-by`，表示你同意该协议）。

你**保留自己代码的著作权**，CLA 不要求转让。它只是授予一份可再许可的使用权，
让项目在保持 AGPL-3.0 开源的同时，将来仍有可能为无法接受 AGPL 的用户提供其他
许可方式。没有这一步，日后任何许可证调整都得逐一联系每位历史贡献者——实践中
等于做不到。

## 仓库结构

- **backend/** — ClawMe relay（Node.js + Express）：v1 指令收发，以及 v3 影核（ShadowCore）任务同步、挑战确认与命令路由。relay 只做路由和事件存储，**不是第二个状态机**。
- **agent/** — owner 端代理：把本机动作核心（如 UURescue）的事件投影成 relay 任务事件，并执行确认过的命令。
- **extension/** — 浏览器插件（Chrome Manifest V3）：轮询待执行指令并上报结果。
- **android/** — Android 原生影子。`protocol/` 是零 Android 依赖的纯 JVM 协议层，`app/` 是 Compose 界面与平台能力。见 [android/README.md](android/README.md)。
- **ios/** — iOS 原生影子（SwiftUI，需 Xcode 建工程）。
- **fixtures/shadowcore/** — 由 relay 亲自生成的真实信封，iOS、Android 和后端共读同一份，避免各端对线上格式的理解漂移。
- **openclaw-clawme/** — OpenClaw 插件：注册 `clawme_send` Tool，供 Agent 向 ClawMe 下发指令。
- **action-parity.json** — 公开的 ActionParity 清单：声明每个动作在各界面上的绑定，由 `backend/test/action-parity.test.mjs` 无头校验。
- **docs/** — 产品与协议文档（architecture、instruction-protocol、actionparity-shadow-sync、roadmap、决策记录等）。

## 如何跑通本地

1. **启动后端**
   ```bash
   cd backend && npm install && npm run build && npm start
   ```
   默认监听 `http://127.0.0.1:31871`。

   **relay 没有配置凭据就会拒绝启动**（退出码 78），这是有意为之：以前"没配置"
   等于"放行所有人"，配上公网隧道就是一个开放中继。本地开发这样起：

   ```bash
   CLAWME_TOKENS=dev-token npm start
   # 或者明确要一个谁都能进的本地 relay（只允许绑回环地址）：
   CLAWME_ALLOW_ANY_TOKEN=1 npm start
   ```

   其他可选环境变量：`PORT`、`CLAWME_BIND`、`CLAWME_IDENTITIES`、`OPENCLAW_HOOK_URL`、`OPENCLAW_HOOK_TOKEN`（见 backend/README.md）。

2. **加载浏览器插件**
   - Chrome 打开 `chrome://extensions`，开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension` 目录。
   - 在弹窗中填写 Backend URL（同上）和 Token（与你启动 relay 时用的 `CLAWME_TOKENS` 一致）。

3. **（可选）接 OpenClaw**
   - 安装插件：`openclaw plugins install -l ./openclaw-clawme`（或配置 `plugins.load.paths` 指向该目录）。
   - 在配置中启用并填写 `plugins.entries.clawme.config.baseUrl`、`clientToken`，并在 `tools.allow` 中加入 `clawme_send`。
   - 详见 [docs/openclaw-setup.md](docs/openclaw-setup.md)。

4. **验证**
   - 用 curl 发一条指令：`curl -X POST http://127.0.0.1:31871/v1/instructions -H "Content-Type: application/json" -H "X-ClawMe-Token: your-token" -d '{"target":"browser","instruction":{"type":"remind","payload":{"title":"测试","body":"你好"}}}'`
   - 打开插件弹窗，应看到该条提醒，点「执行」后会上报结果。

## 如何扩展

- **新增指令类型**：在 [docs/instruction-protocol.md](docs/instruction-protocol.md) 中补充 `type` 与 `payload` 约定；后端仅做透传；浏览器插件或手机端按类型实现执行与上报。
- **新增一端（如手机）**：复用同一套协议与后端；新客户端轮询 `GET /v1/instructions/pending?target=phone` 并 `POST /v1/instructions/:id/result`。
- **为 OpenClaw 写 Skill**：可在 openclaw-clawme 或独立 skill 中写 SKILL.md，引导 Agent 何时、如何调用 `clawme_send`。

## Good First Issue 方向

- 为某指令类型补充 payload 示例或校验说明。
- 浏览器插件：支持更多指令类型（如 `fill_form`、`click` 的简单实现）。
- 文档：补充「从零到一」的录屏或步骤说明。

如有问题可提 Issue 或按仓库说明参与讨论。
