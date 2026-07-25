# ClawMe Agent v0.4

电脑端本地执行器。第一版通过 Codex 官方 `app-server` 原生协议接入，不模拟键盘或点击。

```powershell
$env:CLAWME_BASE_URL="http://127.0.0.1:31871"
$env:CLAWME_TOKEN="dev-token"
$env:CLAWME_CWD="C:\path\to\project"
npm start -- run "检查项目并运行测试"
```

Windows 会自动定位真正的 `codex.exe`。如果 Codex 安装在非标准位置，可设置
`CLAWME_CODEX_PATH`。

执行时：

1. Codex 在本机运行，项目文件不上传到 Relay。
2. 任务状态和必要摘要发送到 Relay。
3. Codex 请求命令或文件授权时，本地会话保持等待。
4. 手机选择允许或拒绝后，ClawMe Agent 把决定返回原生 Codex 会话。

当前支持 Codex 命令执行、文件修改授权、任务状态和补充指令。Claude Code、Hermes、OpenClaw 适配器将在同一协议上增加。

## UURescue 影核模式

这个模式不启动 Codex，也不传屏幕。它把本机 UURescue 任务作为动作核心：

```powershell
$env:CLAWME_BASE_URL="http://127.0.0.1:31871"
$env:CLAWME_TOKEN="<owner-token>"
$env:CLAWME_CWD="C:\path\to\project"
$env:CLAWME_UU_RESCUE_BIN="C:\path\to\uu-rescue\bin\uu-rescue.js"
npm start -- shadow
```

如果项目内有多个任务，可设置 `CLAWME_UU_RESCUE_TASK_ID`；默认读取
UURescue 当前任务。Agent 会：

1. 注册 `uu-rescue` 类型任务与 `owner_task_id`；
2. 从 Relay 保存的 owner 游标继续拉取 `events --json`；
3. 导入原始 ActionParity 事件，Relay 不重写 UURescue 状态机；
4. 领取 `shadow_challenge`，由 owner 签发一次性挑战；
5. 领取 `shadow_execute`，通过私有临时 JSON 文件调用 `sync-command`；
6. 进程或网络失败时不确认队列；重投由 UURescue 幂等账本安全处理。

`CLAWME_UU_RESCUE_BIN` 应指向 JS 入口。调用不经过 shell，动作内容不会拼进
命令行，临时文件用后删除。
