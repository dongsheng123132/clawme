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
- `sync.challenge`
- `sync.command.confirmed`
- `sync.result` / `sync.conflict`
- UURescue 原始 `task.*`、`checkpoint.created`、`takeover.*`

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

`ShadowCoreSection` 已提供第一套原生动作界面：

1. 用户填写保存原因和确认方式；
2. Relay 用配对 token 绑定的 actor 排队，拒绝客户端伪造身份；
3. owner 返回与动作、输入摘要、actor、状态版本绑定的一次性挑战；
4. iOS 显示精确动作；按挑战要求使用 Face ID/Touch ID 或系统认证；
5. 手机只回传确认时间，不上传生物特征或可复用认证秘密；
6. `sync.result` 或 `sync.conflict` 经同一任务游标回到原生结果卡。

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

relay 不能成为第二个状态机。Agent adapter 将 UURescue event 投影为 ClawMe
task event；接班、恢复、完成的合法性仍由 UURescue 状态机判定。Relay 保存
owner 的不透明游标，Agent 重启后从确认位置续传；游标不一致时以 Relay
已提交位置重新拉取。

## 已完成的可靠写闭环

- `checkpoint.create` 带 execution ID、幂等键、过期时间和预期状态版本；
- 挑战由 owner 签发，Relay 不能自批；
- controller 与 owner 分角色、owner 再绑定机器；
- 传输失败不确认，命令至少一次投递、动作幂等执行；
- 状态陈旧返回 `sync.conflict`，手机刷新后重新请求挑战；
- owner 结果与底层事件都进入同一手机差量流。

## 公开清单与无头验证

根目录 `action-parity.json` 是 ClawMe 的公开 ActionParity 清单，声明四个动作
（`task.status`、`task.events`、`checkpoint.challenge`、`checkpoint.create`）
在 iOS 原生影子、relay API 和 owner agent 三个界面上的绑定。

它解决的是一个很具体的工程问题：**手机 GUI 没法稳定自动化测试。**
`backend/test/action-parity.test.mjs` 不用手机、不用模拟器、不用截图，就能验证：

- 清单里每个动作都可无界面执行、都有输入输出契约；
- 每条 relay 绑定声明的路由在 `v3-routes.ts` 里逐字存在；
- 每个 iOS 绑定的 `accessibilityIdentifier` 在 Swift 源码里真实存在；
- 每条 owner agent 绑定指向真实的命令类型；
- 线上协议标识（`action-parity/sync@0.1`）与 owner 写动作 ID 三处一致；
- iOS 确认界面在提交前确实展示了动作、状态版本和有效期。

路由改名、按钮标识丢失、协议标识漂移，都会当场变成红色测试，而不是等到某天
手机上点不动才发现。真机 UI 测试仍然要做，但只剩"人能不能看到、够得着、
看得懂"这一层。

```bash
cd backend && npm test          # 含清单一致性检查
node ../../cli+gui兼容的ai时代的软件开放框架/bin/action-parity.mjs validate ../action-parity.json
```

官方验证器当前结果：动作 4 个，无头 4/4，必需绑定 8/8，一致性 100%，
错误 0，警告 0。

下一阶段是可撤销配对管理、SSE/APNs 唤醒，以及从同一契约 fixture 生成
Android/Kotlin 与 HarmonyOS/ArkTS 模型；HTTP cursor pull 继续作为断线恢复
底座。owner agent 目前仍通过 UURescue 的兼容命令（`events` / `sync-challenge`
/ `sync-command`）对接，下一步换成 UURescue 的通用动作 CLI
（`action run checkpoint.create`），让两边共用同一份动作身份。
