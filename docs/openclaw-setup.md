# OpenClaw 接入 ClawMe 指南

让 OpenClaw 在对话中通过 **clawme_send** Tool 向 ClawMe 下发指令，在用户浏览器或手机端执行，并可把执行结果回传到当前聊天。

## 前置条件

- 已部署 ClawMe 后端（见 [backend/README.md](../backend/README.md)）。
- 至少一端 ClawMe 客户端已配置并可用（如浏览器插件，见 [extension/README.md](../extension/README.md)）。
- 已安装并运行 OpenClaw（Gateway 默认端口 18789）。

## 1. 安装 ClawMe 插件

在 ClawMe 仓库根目录下执行（路径按实际调整）：

```bash
openclaw plugins install -l ./openclaw-clawme
```

或把本仓库中的 `openclaw-clawme` 目录复制到 `~/.openclaw/extensions/clawme`，并在配置中通过 `plugins.load.paths` 指向该目录。

## 2. 配置 OpenClaw

在 `openclaw.json`（或你使用的配置文件）中增加：

```json
{
  "plugins": {
    "entries": {
      "clawme": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:31871",
          "clientToken": "你的 ClawMe client_token"
        }
      }
    }
  },
  "tools": {
    "allow": ["clawme_send"]
  }
}
```

- **baseUrl**：ClawMe 后端地址（若 Gateway 与后端不在同一台机，请填可访问的 URL）。
- **clientToken**：与 ClawMe 后端、浏览器插件中使用的 token 一致；若后端未设 `CLAWME_TOKENS`，可自拟任意字符串。

也可用环境变量替代 config：`CLAWME_BASE_URL`、`CLAWME_CLIENT_TOKEN`。

重启 Gateway 使配置生效。

## 3. 使用方式

在任意已连接的 Channel（如 Telegram、WebChat）中对 OpenClaw 说：

- 「提醒我 5 分钟后在浏览器打开 https://example.com」
- 「帮我在 ClawMe 上发一个提醒：标题「开会」，正文「下午 3 点」」
- 「给浏览器发一条指令：打开 https://docs.openclaw.ai」

Agent 会调用 `clawme_send`，把对应指令发到 ClawMe；用户在浏览器插件（或后续手机端）中看到待执行指令，点「执行」后，结果会经 ClawMe 后端回传到 OpenClaw（需配置回传，见下）。

## 4. 执行结果回传到 OpenClaw

若希望「用户点执行」后，OpenClaw 在当前聊天里回复「已执行」等结果：

1. 在 ClawMe 后端环境变量中配置：
   - `OPENCLAW_HOOK_URL`：Gateway 地址，如 `http://127.0.0.1:18789`
   - `OPENCLAW_HOOK_TOKEN`：Gateway 的 `hooks.token`（与 `openclaw.json` 中 `hooks.token` 一致）

2. 客户端上报结果后，后端会向 `OPENCLAW_HOOK_URL/hooks/agent` 发送一条消息，OpenClaw 会将其投递到当前 channel（如 `channel: "last"`）。

## 5. 故障排查

- **Agent 不调用 clawme_send**：确认 `tools.allow` 包含 `clawme_send`，且插件已启用（`openclaw plugins list`）。
- **ClawMe 返回 401**：检查后端 `CLAWME_TOKENS` 与插件、OpenClaw 中的 `clientToken` 是否一致。
- **插件收不到指令**：确认插件里填的 Backend URL 和 Token 正确，且指令的 `target` 为 `browser` 或 `any`。
- **回传无反应**：确认 `OPENCLAW_HOOK_URL`、`OPENCLAW_HOOK_TOKEN` 正确，且 Gateway 已开启 `hooks.enabled`。

协议细节见 [instruction-protocol.md](instruction-protocol.md)。
