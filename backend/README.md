# ClawMe Backend

ClawMe Relay：连接客户电脑上的本地 Agent 与手机值班台。任务仍在客户电脑执行，
Relay 负责设备心跳、任务事件、待处理授权、手机决定和离线队列。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 端口，默认 31871 |
| `CLAWME_TOKENS` | 逗号分隔的合法 client_token；不设则开发时允许任意 token |
| `CLAWME_DATA_FILE` | v0.3 持久化文件，默认 `data/clawme-v3.json` |
| `OPENCLAW_HOOK_URL` | 回传用，如 `http://127.0.0.1:18789` |
| `OPENCLAW_HOOK_TOKEN` | 回传用，Gateway hooks.token |

## API

### v0.3 AI 值班台

- `POST /v3/machines/heartbeat` — 电脑端上线与心跳
- `POST /v3/tasks` / `GET /v3/tasks` — 创建、更新和查看任务
- `POST /v3/tasks/:id/events` — 上报原生 Agent 事件
- `GET /v3/sync/tasks/:id` — 首次快照；带 `after` 游标时只返回新增事件
- `POST /v3/attention` / `GET /v3/attention` — 创建、查看待处理事项
- `POST /v3/attention/:id/decision` — 手机允许、拒绝或选择操作
- `GET /v3/agent/commands` — 本地 Agent 领取手机决定和补充指令

所有 v0.3 数据都会原子写入持久化文件，服务重启后仍可恢复。

### v0.1/v0.2 兼容接口

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

开发时：`npm run dev`（需先 `npm run build` 一次）。验证：`npm test`。
# ActionParity task sync

Native clients can resume a task stream without downloading the complete relay
store:

```http
GET /v3/sync/tasks/:taskId
GET /v3/sync/tasks/:taskId?after=<opaque-cursor>&limit=100
X-ClawMe-Token: <token>
```

The first request returns `sync.snapshot`; subsequent requests return
`sync.delta` under `action-parity/sync@0.1`. See
[`docs/actionparity-shadow-sync.md`](../docs/actionparity-shadow-sync.md).
