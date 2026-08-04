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

## Android 原生影子

`android/protocol/` 是同一份契约的 Kotlin 实现，与 iOS 逐字对齐：同样的
`action-parity/sync@0.1` 信封、同样的字段名、同样的动作标识。

它被刻意做成一个**零 Android 依赖的纯 JVM 模块**。那个模块里没有 `android.jar`，
谁 `import android.*` 会当场编译失败 —— 于是「协议层不碰平台」从一条口头约定变成
构建强制的事实，顺带让整层能在普通 JVM 上毫秒级测完。

`app/` 才是平台部分：Compose 界面、BiometricPrompt 本机认证、Keystore 加密的配对
令牌。手机上行只带确认时间与模式，生物特征和可复用凭据一个字节都不出设备。

界面控件挂的是稳定 `testTag`，并在 Compose 根节点开了 `testTagsAsResourceId`。
少了后面这一行，标识只在 Compose 测试里可见，UiAutomator 查不到「这个按钮绑的是
哪个动作」—— Android 的绑定就退化成自说自话。这条现在由测试守着。

## 三端读同一批信封

`fixtures/shadowcore/` 是由后端**亲自吐出来**的四份真实信封（快照、普通增量、
挑战、结果），生成器是 `backend/scripts/emit-shadow-fixtures.mjs`。

iOS、Android 和后端各存一份「我以为的线上格式」，就会漂三份。现在：

- Kotlin 测试直接读这批 fixture 做投影断言；
- `backend/test/shadow-fixtures.test.mjs` 重跑生成器并逐字比对，后端改了信封
  而没重新生成，测试当场红；
- fixture 是人能读的 JSON，脱敏做没做一眼就看得出来。

```bash
cd backend
node scripts/emit-shadow-fixtures.mjs          # 重新生成
node scripts/emit-shadow-fixtures.mjs --check  # 有漂移退出码 1
```

## 省流量：实测，不是口号

10 分钟真实任务会话（每 20 秒一条进度、一次追问、一次完整的挑战—确认—回执），
手机按 3 秒轮询：

| 方案 | 10 分钟总流量 | 相对影核 | 数据来源 |
| --- | --- | --- | --- |
| **影核动作同步**（轮询 3s） | **153.0 KB** | 1× | 实测 |
| 屏幕流 · 静止画面 0.3 Mbps | 21.46 MB | 143.6× | 按码率估算 |
| 屏幕流 · 轻度操作 1.5 Mbps | 107.29 MB | 717.8× | 按码率估算 |
| 屏幕流 · 持续操作 4 Mbps | 286.10 MB | 1914.3× | 按码率估算 |

两列数字来源不同，别混为一谈：影核那一列是真建 relay、真跑事件、真按轮询节奏
累加手机收到的信封字节；屏幕流那一列是码率乘时长的估算，**不是对 UU 远程或任何
第三方产品的实测**，码率档位是可调参数。

复现：`cd backend && node scripts/bandwidth-benchmark.mjs`

有意思的是结论里那 45%：影核这边的流量已经小到**轮询的 HTTP 头比内容还大**。
真正的下一步优化不是再压缩信封，是把轮询换成 SSE 或推送唤醒。

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
- 每个 Android 绑定的 `testTag` 常量既定义了、也真挂到了控件上
  （只查字面量会漏掉「标识还在、按钮上却忘了挂」这种最容易发生的漂移）；
- Android 开了 `testTagsAsResourceId`，标识对外部自动化可见；
- iOS 与 Android 声明的动作标识逐字相同，两个原生端不会各叫各的；
- 每条 owner agent 绑定指向真实的命令类型；
- 线上协议标识（`action-parity/sync@0.1`）与 owner 写动作 ID 三处一致；
- 两端确认界面在提交前都确实展示了动作、状态版本和有效期。

路由改名、按钮标识丢失、协议标识漂移，都会当场变成红色测试，而不是等到某天
手机上点不动才发现。真机 UI 测试仍然要做，但只剩"人能不能看到、够得着、
看得懂"这一层。

```bash
cd backend && npm test          # 含清单一致性检查与 fixture 防漂移
cd android && ./run-protocol-tests.sh   # Android 协议层 13 个 JVM 测试
node ../shadowcore影核-cli+gui兼容的ai时代的软件开放框架/bin/action-parity.mjs validate action-parity.json
```

官方验证器当前结果：动作 4 个，界面 5 个（ios / android / relay-api /
owner-agent / test），声明一致性 100%，测试覆盖 12/12，violations 0。

**已知待办（早于 Android 这一版就存在）**：ActionParity 规范已升到 `0.5.0`，
本清单还写着 `0.1.0`，验证器因此报一条 `schema_validation` 错误，并要求四个动作
补 `evidence` 声明。改动前的 HEAD 版本报的是同样两条，跟 Android 无关，需要一次
单独的清单迁移。

下一阶段：FCM / APNs 推送唤醒（实测轮询头部已占流量的 45%，这是最大的一块），
可撤销配对管理，以及从同一批 fixture 生成 HarmonyOS/ArkTS 模型；HTTP cursor pull
继续作为断线恢复底座。owner agent 目前仍通过 UURescue 的兼容命令
（`events` / `sync-challenge` / `sync-command`）对接，下一步换成通用动作 CLI
（`action run checkpoint.create`），让两边共用同一份动作身份。
