# ClawMe Backend

最小后端：接收 Agent 指令、按 token 下发给客户端轮询、接收执行结果并可选回传 OpenClaw。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 端口，默认 31871 |
| `CLAWME_TOKENS` | 逗号分隔的合法 client_token；不设则开发时允许任意 token |
| `OPENCLAW_HOOK_URL` | 回传用，如 `http://127.0.0.1:18789` |
| `OPENCLAW_HOOK_TOKEN` | 回传用，Gateway hooks.token |

## API

- `POST /v1/instructions` — 下发指令（Header: `Authorization: Bearer <token>` 或 `X-ClawMe-Token`）
- `GET /v1/instructions/pending?target=browser` — 客户端轮询待执行指令
- `POST /v1/instructions/:id/result` — 客户端上报结果（body: `instruction_id`, `status`, `result?`）

协议详见仓库根目录 `docs/instruction-protocol.md`。

## 运行

```bash
npm install
npm run build
npm start
```

开发时：`npm run dev`（需先 `npm run build` 一次）。
