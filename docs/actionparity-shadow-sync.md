# ClawMe：One Core, Many Shadows

ClawMe v3 不再把“远程”理解成远程桌面。电脑上的 ClawMe Agent 是 owner
node，负责本地 AI、文件与工具执行；relay 只保存可路由、可恢复的任务状态；
iOS、macOS、Windows、Android、鸿蒙和 Web 都是同一任务流的原生影子。

## 已落地的第一片

```text
GET /v3/sync/tasks/:taskId
GET /v3/sync/tasks/:taskId?after=<opaque-cursor>&limit=100
```

首次请求返回 `sync.snapshot`：

- 当前任务；
- 当前待处理 attention；
- 状态版本；
- 不透明游标。

后续请求回传游标，返回 `sync.delta`：

- 只包含游标之后的事件；
- 每个任务有独立、持久、递增的 sequence；
- 无变化时返回空事件和同一游标；
- `has_more=true` 时继续翻页；
- 游标过旧且历史已压缩时自动返回新快照。

relay 使用 `action-parity/sync@0.1` envelope。传输仍是现有 HTTPS；标准化的
是语义和恢复规则，不是再发明一套网络协议。

## 同一条任务流

现在下列变化都写入任务事件流：

- `task.created`
- `task.updated`
- Agent 上报的 `task.started/progress/completed/failed`
- `attention.input_required`
- `attention.decided`
- `command.queued`
- `command.acknowledged`

手机不必轮询“任务、审批、命令”三份相互漂移的数据；一个游标就能恢复到
同一状态版本。

## iOS 原生影子

`ios/ClawMe/Models/SyncEnvelope.swift` 是原生 Codable 契约；
`ConnectionManager.syncTask`：

1. 首次拿 snapshot；
2. 本地保存每个任务的 cursor；
3. 以后只拉 delta；
4. 按 event sequence 去重、排序；
5. 把任务状态投影到 `@Published remoteTasks`；
6. 连续拉取 `has_more` 分页。

iOS 界面可以完全按手机习惯设计，不需要复制 Windows 布局。

## UURescue 的位置

UURescue 是任务连续性内核时，推荐路径是：

```text
UURescue events --after cursor --json
          │
          ▼
ClawMe Agent adapter
          │
          ▼
ClawMe relay /v3/sync/tasks/:id
          │
          ├── iOS shadow
          ├── Windows shadow
          └── HarmonyOS shadow
```

relay 不能成为第二个状态机。Agent adapter 将 UURescue event 映射为 ClawMe
task event；接班、恢复、完成的合法性仍由 UURescue 状态机判定。

## 下一步

1. 给 `sync.command` 加 execution ID、idempotency key 和预期状态版本。
2. 把 `attention.decision` 作为第一个有确认的跨端写 Action。
3. 为 cursor 和 device token 增加可撤销设备绑定。
4. 增加 SSE/WebSocket 推送；HTTP cursor pull 保留作断线恢复。
5. 生成 Android/Kotlin 与 HarmonyOS/ArkTS 模型。
6. 用同一份 fixture 做 relay、Swift、ArkTS 三端契约测试。
