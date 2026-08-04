# ClawMe Android —— 影核原生影子

手机不是电脑的一块屏幕，是同一条任务流上的另一个原生端。

这个 App 不接收任何画面。它按不透明游标拉取**动作、状态和事件**，把 owner 节点
签发的确认挑战摆到你面前，再把你的确认交回 owner 执行。所有业务动作只在 owner
的动作核心里实现一次；手机是调用方，不是第二份实现。

## 为什么第一端是 Android

iOS 那份 SwiftUI 影子（`../ios/`）先写，但它在 Windows 开发机上编译不了，也没有
`.xcodeproj`。Android 这边今天就能在本机编译、安装、真机跑通 —— 能被观察地跑起来，
才算做完（宪法 #5）。两端读同一份 `action-parity.json`，同一批
`fixtures/shadowcore/` 信封，动作标识逐字相同。

## 模块结构

```
android/
  protocol/     纯 Kotlin/JVM，零 Android 依赖 —— 影核协议层
    ShadowEnvelope.kt    action-parity/sync@0.1 线上契约
    ShadowProjection.kt  信封 → 界面状态的纯函数投影
    ShadowRelayClient.kt relay 调用（只用 java.net）
  app/          Jetpack Compose 界面 + Android 平台能力
    ShadowViewModel.kt   轮询、游标、挑战确认编排
    ShadowAuthenticator.kt  BiometricPrompt 本机认证
    SecureTokenStore.kt  Keystore 加密的配对令牌
    ui/ShadowCoreScreen.kt  带稳定 testTag 的动作界面
```

`protocol` 独立成模块不是为了好看：那个模块里根本没有 `android.jar`，谁不小心
`import android.*` 会当场编译失败。「协议层不碰 Android」因此是构建强制的事实，
而不是一条容易忘的约定。附带好处是这层能在普通 JVM 上毫秒级测完。

## 构建与安装

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$HOME/AppData/Local/Android/Sdk"

cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

模拟器连本机 relay 用 `http://10.0.2.2:31871`（`127.0.0.1` 在模拟器里指模拟器自己）。
真机连公网 relay 必须 HTTPS —— 这条规矩在 `ShadowRelayClient.normalizeBase` 里强制，
与 iOS 端逐字一致，两端不能有一端偷偷放宽。

## 配对

在电脑上签发一个配对码，在手机里输进去：

```bash
cd backend
export CLAWME_RELAY=https://api.clawme.net CLAWME_ROOT_TOKEN=<根令牌>
node scripts/pair.mjs new --name "我的手机"
# → SEYR9-TG4K6，5 分钟内有效，只能用一次
```

手机拿这个码换到的令牌**只属于这台设备**：加密进 Android Keystore，丢了可以在
电脑上 `pair.mjs revoke` 单独作废，不用换掉浏览器插件和其他设备的凭据，也不用
重启 relay。

界面上仍留了「手动填令牌」的入口，给拿不到 relay 管理权限的场景兜底。

## 测试

业务对不对，直接断言协议层，不用模拟器、不用截图：

```bash
cd android
./run-protocol-tests.sh        # 13 个 JVM 测试
```

绑定对不对（哪个按钮绑的是哪个动作），在后端一起验：

```bash
cd backend && npm test         # 含 android 绑定检查与 fixture 防漂移
```

### 为什么测试要走 `run-protocol-tests.sh`

本仓库目录名含中文。Gradle 的 test worker 是另起的 JVM，在 Windows 上从非 ASCII
项目路径加载测试类会抛 `ClassNotFoundException`。已逐个排除：

| 怀疑对象 | 结论 |
| --- | --- |
| Android 插件 | 无关（纯 JVM 的 `:protocol` 模块一样挂） |
| classpath 长度 / pathing jar | 无关（短 classpath 的纯 JVM 模块也挂） |
| `-Dfile.encoding` / `-Dsun.jnu.encoding` | 无效（daemon 和 worker 两侧都试过） |
| 目录 junction | 无效（Gradle 把路径归一化回真实路径） |

编译、打包 APK 在中文路径下**完全正常**，只有 test worker 加载类这一步不行。
脚本的做法是把源码和 fixture 镜像到一个 ASCII 临时目录跑测试，再把报告取回仓库。

`android.overridePathCheck=true` 也是因此而来：AGP 默认拒绝在非 ASCII 路径构建，
但实测这个工程（纯 Kotlin/Compose、不带 NDK）在中文路径下打包正常。

## 手机端看得到的流量

状态卡上直接显示当前传输方式、同步次数和实收字节。10 分钟真实任务会话实测：

| 传输方式 | 流量 | 延迟 |
| --- | --- | --- |
| SSE 长连接 | **20.7 KB** | 即时 |
| 轮询 3 秒 | 153 KB | 最多 3 秒 |

App 默认走 SSE；连接断了自动退回轮询，游标不变，所以两条路径随时可以互换。
状态卡上那个「推送 / 轮询」标签就是当前实际走的那条。

```bash
cd backend && node scripts/bandwidth-benchmark.mjs
```

## 还没做的

- [ ] FCM 推送唤醒。SSE 只在 App 前台时有效；被系统杀掉之后的唤醒需要
      Firebase 凭据（`google-services.json` + service account），拿不到就做不了
- [ ] 二维码扫码配对。配对码已经能用了，摄像头扫码要引 CameraX + ML Kit，
      而且没有真机测不了
- [ ] UiAutomator 用例（`testTagsAsResourceId` 已开，标识对外部自动化可见）
- [ ] 前台服务 / WorkManager，让 App 退到后台也能维持连接
