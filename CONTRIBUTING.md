# 参与贡献 ClawMe

欢迎参与 ClawMe（OpenClaw 的「手」：在用户设备上执行指令）。以下说明如何跑起项目、扩展协议与端。

## 仓库结构

- **backend/** — ClawMe 最小后端（Node.js + Express）：接收指令、按 token 下发、客户端轮询与结果上报、可选回传 OpenClaw。
- **extension/** — 浏览器插件（Chrome Manifest V3）：轮询待执行指令，支持 `remind`、`open_url`，执行后上报。
- **openclaw-clawme/** — OpenClaw 插件：注册 `clawme_send` Tool，供 Agent 向 ClawMe 下发指令。
- **docs/** — 产品与协议文档（architecture、instruction-protocol、roadmap、决策记录等）。

## 如何跑通本地

1. **启动后端**
   ```bash
   cd backend && npm install && npm run build && npm start
   ```
   默认 `http://127.0.0.1:31871`。可选环境变量：`PORT`、`CLAWME_TOKENS`、`OPENCLAW_HOOK_URL`、`OPENCLAW_HOOK_TOKEN`（见 backend/README.md）。

2. **加载浏览器插件**
   - Chrome 打开 `chrome://extensions`，开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension` 目录。
   - 在弹窗中填写 Backend URL（同上）和 Token（任意字符串即可，若未设 `CLAWME_TOKENS`）。

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
