# 让 remote-agent 在这台机器上常驻（启动文件夹方式）。
#
# 解决的问题：agent.exe 原本躺在 %TEMP%\uclaw\ 里，由 `irm | iex` 拉起，是那个
# PowerShell 窗口的子进程。窗口一关就没，系统清理临时文件也会把它删掉。
# agent 本身没有自杀定时器（源码里只有 5 秒重连和心跳），所以"活不过两小时"
# 从来不是超时，是宿主进程和文件位置的问题。
#
# 做法：可执行文件挪到 C:\ra\，启动文件夹里放一个 .vbs 静默拉起它。
# 普通用户权限，没有计划任务，没有服务。
#
# 撤销（两步，都在资源管理器里点得到）：
#   del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\clawme-remote-agent.vbs"
#   然后结束 agent.exe 进程，删掉 C:\ra

$ErrorActionPreference = "Stop"
$root    = "C:\ra"
$exe     = Join-Path $root "agent.exe"
$vbs     = Join-Path $root "start-agent.vbs"
$startup = Join-Path ([Environment]::GetFolderPath("Startup")) "clawme-remote-agent.vbs"
$log     = Join-Path $root "install.log"

function Log($message) {
    "$(Get-Date -Format s)  $message" | Tee-Object -FilePath $log -Append
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
Log "install start"

# 1. 从正在跑的进程拿可执行文件和启动参数，别把连接参数写死在脚本里。
$running = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "agent.exe" } | Select-Object -First 1
if (-not $running) { throw "没有正在运行的 agent.exe，无法推断启动参数" }

$sourceExe = $running.ExecutablePath
$arguments = $running.CommandLine
if ($arguments.StartsWith('"')) {
    $arguments = $arguments.Substring($arguments.IndexOf('"', 1) + 1).Trim()
} else {
    $arguments = ($arguments -split '\s+', 2)[1]
}
Log "running pid=$($running.ProcessId) path=$sourceExe"
Log "arguments: $arguments"

# 2. 复制到稳定位置。源文件正被占用，但读取是允许的。
Copy-Item -LiteralPath $sourceExe -Destination $exe -Force
Log "copied to $exe"

# 3. 静默启动器。agent.exe 是控制台程序，直接放启动文件夹会弹一个黑框，
#    用 VBS 的 window style 0 把它藏掉。
@"
' ClawMe remote-agent 静默启动器。删掉启动文件夹里的同名文件即可停用。
Set shell = CreateObject("WScript.Shell")
shell.Run """$exe"" $arguments", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII
Log "wrote $vbs"

# 4. 放进当前用户的启动文件夹 —— 一个文件，删掉就撤销干净。
Copy-Item -LiteralPath $vbs -Destination $startup -Force
Log "installed startup entry $startup"

# 5. 先起新的、确认连上，再收掉旧的。顺序反了会把远程连接自己掐断。
& wscript.exe $vbs
Start-Sleep -Seconds 8

$new = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "agent.exe" -and $_.ProcessId -ne $running.ProcessId } |
    Select-Object -First 1
if ($new) {
    Log "new agent pid=$($new.ProcessId) up, stopping old pid=$($running.ProcessId)"
    Stop-Process -Id $running.ProcessId -Force -ErrorAction SilentlyContinue
} else {
    Log "WARNING: new agent did not appear; leaving the old one running"
}

Log "install done"
