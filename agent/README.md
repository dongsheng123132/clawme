# ClawMe Agent v0.3

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
