# OpenClaw ClawMe Plugin

为 OpenClaw 注册 **clawme_send** Tool：Agent 在对话中可向 ClawMe 下发指令（remind、open_url 等），在用户浏览器或手机端执行。

## 安装

本地目录安装（开发）：

```bash
openclaw plugins install -l /path/to/clawme/openclaw-clawme
```

或在 OpenClaw 配置中通过 `plugins.load.paths` 指向本目录。

## 配置

在 `openclaw.json`（或等效配置）中：

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

也可使用环境变量：`CLAWME_BASE_URL`、`CLAWME_CLIENT_TOKEN`。

## Tool 用法

Agent 调用 `clawme_send` 时传入：

- **target**: `browser` | `phone` | `any`
- **type**: 指令类型，如 `remind`、`open_url`
- **payload**: 对应类型的 payload，如 `remind` 的 `{ title, body }`、`open_url` 的 `{ url, in_new_tab }`

示例（由 Agent 自动生成）：提醒用户在浏览器打开某链接、或发短信等（需 ClawMe 后端与对应端支持）。
